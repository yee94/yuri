import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { useGuiPlugins } from '@/lib/gui-plugins/react';
import type { RegistryResult } from '@/stores/usePluginsStore';
import { GuiPluginMount } from './GuiPluginMount';
import { GuiPluginSurface } from './GuiPluginSurface';
import { GuiPluginsManager } from './GuiPluginsManager';
import { GuiFileLinkBridge } from './GuiFileLinkBridge';
import { GuiPluginCommands } from './GuiPluginCommands';
import { GuiPluginTitlebarItems } from './GuiPluginTitlebarItems';
import { GuiPluginPage } from './GuiPluginPage';
import { useUIStore } from '@/stores/useUIStore';

type Context = ReturnType<typeof useGuiPlugins>;
const state = vi.hoisted(() => ({
  context: null as Context | null,
  registry: {} as Record<string, RegistryResult>,
  registryQuery: vi.fn(),
  toast: vi.fn(),
  t: (key: string, values?: Record<string, string | number>) => `${key}${values ? `:${Object.values(values).join(',')}` : ''}`,
}));
vi.mock('@/lib/gui-plugins/react', () => ({ useGuiPlugins: () => state.context }));
vi.mock('@/queries/pluginQueries', () => ({ usePluginRegistryQuery: (specs: string[]) => {
  state.registryQuery(specs);
  return { data: state.registry };
} }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: state.t }) }));
vi.mock('@/components/ui', () => ({ toast: { error: state.toast } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} /> }));
vi.mock('./GuiPluginWindow', () => ({
  GuiPluginWindow: ({ open, onClose, children }: { open: boolean; onClose: () => void; children: React.ReactNode }) => open
    ? <section data-window><button onClick={onClose}>dismiss-window</button>{children}</section> : null,
}));
vi.mock('@/components/ui/command', () => ({
  CommandGroup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  CommandItem: ({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) => <button onClick={onSelect}>{children}</button>,
}));

function makeHost() {
  const log: string[] = [];
  const mount = (kind: string) => vi.fn((key: string, node: HTMLElement, _actions?: HTMLElement) => {
    log.push(`mount:${kind}:${key}`);
    const child = document.createElement('span');
    child.textContent = `external:${key}`;
    node.append(child);
    return () => { log.push(`dispose:${kind}:${key}`); child.remove(); };
  });
  const methods = {
    mountPanel: mount('panel'), mountSettings: mount('settings'), mountPage: mount('page'),
    openLink: vi.fn(() => true), runCommand: vi.fn(), runTitlebarItem: vi.fn(),
    registerFileView: vi.fn(() => vi.fn()),
    filePanel: vi.fn(() => state.context?.snapshot.panels.find((panel) => panel.inline)),
    selectPanel: vi.fn(), closePanel: vi.fn(), hidePanel: vi.fn(),
  };
  return { methods, log, host: methods as unknown as NonNullable<Context['host']> };
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let fixture: ReturnType<typeof makeHost>;
let frames: Map<number, FrameRequestCallback>;
const frame = async () => {
  const callbacks = [...frames.values()];
  frames.clear();
  await act(async () => { callbacks.forEach((callback) => callback(performance.now())); });
};
const settleMount = async () => { await frame(); await frame(); };
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); await settleMount(); };
const click = async (text: string) => {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === text || node.getAttribute('aria-label') === text);
  expect(button, text).toBeDefined();
  await act(async () => button!.click());
  await settleMount();
};
const context = () => state.context!;
const updateSnapshot = (patch: Partial<Context['snapshot']>) => {
  state.context = { ...context(), snapshot: { ...context().snapshot, ...patch } };
};

beforeEach(() => {
  frames = new Map();
  let frameId = 0;
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frames.set(++frameId, callback); return frameId; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => { frames.delete(id); });
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture = makeHost();
  state.toast.mockClear();
  state.registry = {};
  state.registryQuery.mockClear();
  state.context = {
    host: fixture.host,
    snapshot: { plugins: [{ id: 'demo', revision: 'one', status: 'active' }], panels: [], pages: [], commands: [], titlebarItems: [], settings: [], menuItems: [], activePanel: null },
    inventory: [{ id: 'demo', enabled: true }], loading: false, error: null,
    setEnabled: vi.fn(), refresh: vi.fn(), requested: true, requestLoad: vi.fn(),
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('foreign DOM ownership', () => {
  test('global page host failures use the shared centered SVG state without header or navigation chrome', async () => {
    const previous = useUIStore.getState();
    useUIStore.setState({ activeGuiPage: JSON.stringify(['demo', 'main']), isMobile: false });
    try {
      updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'failed', error: 'private diagnostic' }] });
      await render(<GuiPluginPage />);
      const surface = container.querySelector('[data-gui-plugin-page-surface]')!;
      for (const name of ['rounded-xl', 'overflow-hidden', 'isolate']) expect(surface.classList.contains(name)).toBe(true);
      expect(surface.hasAttribute('data-workspace-surface')).toBe(true);
      const ring = surface.querySelector('[data-workspace-surface-ring]')!;
      for (const name of ['ring-inset', 'pointer-events-none', 'z-50']) expect(ring.classList.contains(name)).toBe(true);
      expect(container.querySelector('[data-file-preview-state]')).not.toBeNull();
      expect(container.querySelector('[data-file-preview-illustration] svg')).not.toBeNull();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('guiPlugins.error');
      expect(container.textContent).not.toContain('private diagnostic');
      expect(container.querySelector('header,button')).toBeNull();
      updateSnapshot({ plugins: [{ id: 'demo', revision: 'two', status: 'active' }], pages: [{ key: JSON.stringify(['demo', 'main']), pluginId: 'demo', title: 'Demo' }] });
      await render(<GuiPluginPage />);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(fixture.methods.mountPage).toHaveBeenCalledTimes(1);
    } finally { await act(async () => { useUIStore.setState({ activeGuiPage: previous.activeGuiPage, isMobile: previous.isMobile }); }); }
  });
  test('global placement retains its foreign DOM across 50 unrelated renders and cleans up on owner revision', async () => {
    const view = (revision = 'one') => <GuiPluginMount host={fixture.host} kind="page" contributionKey="global" revision={revision} />;
    await render(view());
    const node = container.querySelector('[data-gui-plugin-mount]')!.firstChild;
    for (let i = 0; i < 50; i++) { updateSnapshot({ sessionKey: String(i) }); await render(view()); }
    expect(fixture.methods.mountPage).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-gui-plugin-mount]')!.firstChild).toBe(node);
    await render(view('two'));
    expect(fixture.log).toEqual(['mount:page:global', 'dispose:page:global', 'mount:page:global']);
  });
  test.each([false, true])('global sidebar rows keep official icons despite available Settings package artwork (mobile=%s)', async (mobile) => {
    state.context = { ...context(), inventory: [
      { id: 'demo', enabled: true, source: { type: 'local', path: '/plugin' } },
      { id: 'unused', enabled: true, source: { type: 'package', target: 'not-needed' } },
    ] };
    state.registry = { '/plugin': { kind: 'path-ok', spec: '/plugin', absolutePath: '/plugin', icon: 'https://example.test/custom.svg' } };
    updateSnapshot({ titlebarItems: [{ key: 'entry', pluginId: 'demo', label: 'Runmark', icon: 'globe', actionable: true }] });
    await render(<GuiPluginTitlebarItems sidebar mobile={mobile} />);
    const row = container.querySelector('button')!;
    expect(row.textContent).toBe('Runmark');
    expect(row.className).toContain('w-full');
    expect(row.className).toContain('justify-start');
    expect(container.querySelector('[data-gui-sidebar-items]')).not.toBeNull();
    expect(container.querySelector('[data-icon="global"]')).not.toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(state.registryQuery).not.toHaveBeenCalled();
    await click('Runmark');
    expect(fixture.methods.runTitlebarItem).toHaveBeenCalledWith('entry');
    for (let index = 0; index < 50; index++) {
      updateSnapshot({ sessionKey: `session-${index}` });
      await render(<GuiPluginTitlebarItems sidebar mobile={mobile} />);
      expect(container.querySelector('button')).toBe(row);
      expect(container.querySelector('img')).toBeNull();
    }
    expect(context().requestLoad).not.toHaveBeenCalled();
    expect(state.registryQuery).not.toHaveBeenCalled();
  });


  test.each([false, true])('titlebar contributions render accessible actions, busy and passive states (mobile=%s)', async (mobile) => {
    updateSnapshot({titlebarItems:[
      {key:'first',pluginId:'demo',label:'Dashboard',title:'Open dashboard',icon:'globe',pressed:true,actionable:true},
      {key:'busy',pluginId:'demo',label:'Syncing',busy:true,actionable:true},
      {key:'status',pluginId:'demo',label:'Online',actionable:false},
    ]});
    await render(<GuiPluginTitlebarItems mobile={mobile} />);
    const button = container.querySelector<HTMLButtonElement>('[aria-label="Open dashboard"]')!;
    expect(button.title).toBe('Dashboard');
    expect(button.getAttribute('aria-pressed')).toBe('true');
    await click('Open dashboard');
    expect(fixture.methods.runTitlebarItem).toHaveBeenCalledExactlyOnceWith('first');
    const busy = container.querySelector<HTMLButtonElement>('[aria-label="Syncing"]')!;
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await act(async()=>busy.click());
    expect(fixture.methods.runTitlebarItem).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Online');
    for (let i=0;i<50;i++) {
      updateSnapshot({sessionKey:`runtime\ns${i}`});
      await render(<GuiPluginTitlebarItems mobile={mobile} />);
      expect(container.querySelector('[aria-label="Open dashboard"]')).toBe(button);
    }
    expect(context().requestLoad).not.toHaveBeenCalled();
    updateSnapshot({titlebarItems:[]});
    await render(<GuiPluginTitlebarItems mobile={mobile} />);
    expect(container.children).toHaveLength(0);
  });

  test.each([
    { sidebar: true, mobile: false }, { sidebar: true, mobile: true },
    { sidebar: false, mobile: false }, { sidebar: false, mobile: true },
  ])('entry images preserve labels, busy state, failure fallback and lifecycle (%j)', async ({ sidebar, mobile }) => {
    const svg = 'data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E';
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    const entry = { key: 'image', pluginId: 'demo', label: 'Artwork', title: 'Open artwork', icon: svg, actionable: true };
    const view = () => <GuiPluginTitlebarItems sidebar={sidebar} mobile={mobile} />;
    updateSnapshot({ titlebarItems: [entry] });
    await render(view());
    const button = container.querySelector('button')!;
    const image = container.querySelector('img')!;
    expect(image.getAttribute('src')).toBe(svg);
    expect(image.alt).toBe('');
    expect(image.className).toContain('object-contain');
    expect(image.className).toContain(sidebar ? 'size-4' : 'size-3.5');
    expect(button.textContent).toBe(sidebar ? 'Artwork' : '');
    expect(container.querySelector('svg')).toBeNull();
    await click('Open artwork');
    expect(fixture.methods.runTitlebarItem).toHaveBeenCalledWith('image');
    for (let i = 0; i < 50; i++) {
      updateSnapshot({ sessionKey: `s${i}` });
      await render(view());
      expect(container.querySelector('img')).toBe(image);
    }
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(container.querySelector('img')).toBeNull();
    expect(button.textContent).toBe('Artwork');
    updateSnapshot({ titlebarItems: [{ ...entry, icon: png }] });
    await render(view());
    expect(container.querySelector('img')?.getAttribute('src')).toBe(png);
    updateSnapshot({ titlebarItems: [{ ...entry, icon: png, busy: true }] });
    await render(view());
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-icon="loader-4"]')).not.toBeNull();
    expect(button.disabled).toBe(true);
    updateSnapshot({ titlebarItems: [{ ...entry, icon: png, actionable: false }] });
    await render(view());
    expect(container.querySelector('[role="status"] img')).not.toBeNull();
    updateSnapshot({ titlebarItems: [] });
    await render(view());
    expect(container.children).toHaveLength(0);
    expect(state.registryQuery).not.toHaveBeenCalled();
    expect(context().requestLoad).not.toHaveBeenCalled();
  });

  test.each(['unknown-icon', '__proto__', 'https://example.test/icon.svg', '/icon.svg', 'javascript:alert(1)'])('unsupported entry icon %s keeps its label without loading an image', async (icon) => {
    updateSnapshot({ titlebarItems: [{ key: 'entry', pluginId: 'demo', label: 'Fallback', icon, actionable: true }] });
    await render(<GuiPluginTitlebarItems />);
    expect(container.querySelector('img,svg')).toBeNull();
    expect(container.querySelector('button')?.textContent).toBe('Fallback');
  });

  test('scoped manager shows the inline GUI status and working switch without a separate inventory', async () => {
    await render(<GuiPluginsManager pluginIds={['demo']} />);
    expect(container.querySelector('details')).toBeNull();
    expect(container.querySelector('.yuri-settings-group-label')).toBeNull();
    expect(container.textContent).toContain('guiPlugins.interface');
    expect(container.textContent).toContain('guiPlugins.active');
    const toggle = container.querySelector<HTMLButtonElement>('[role="switch"]')!;
    await act(async () => toggle.click());
    expect(context().setEnabled).toHaveBeenCalledWith('demo', false);
    state.context = { ...context(), inventory: [{ id: 'demo', enabled: false }] };
    await render(<GuiPluginsManager pluginIds={['demo']} />);
    expect(container.textContent).toContain('guiPlugins.off');
    expect(container.querySelector('[role="switch"]')?.getAttribute('aria-checked')).toBe('false');
  });

  test('scoped contributions use explicit ownership and retain their actions', async () => {
    const ownCommand = vi.fn();
    const ownMenu = vi.fn();
    fixture.methods.runCommand = ownCommand;
    updateSnapshot({
      commands: [
        { key: 'demo.run', pluginId: 'demo', title: 'Own command', run: vi.fn() },
        { key: 'demo:other.run', pluginId: 'demo:other', title: 'Other command', run: vi.fn() },
      ],
      menuItems: [
        { key: 'demo:open', pluginId: 'demo', title: 'Own launcher', run: ownMenu },
        { key: 'demo:other:open', pluginId: 'demo:other', title: 'Other launcher', run: vi.fn() },
      ],
      settings: [
        { key: 'demo:settings', pluginId: 'demo', title: 'Own preferences' },
        { key: 'demo:other:settings', pluginId: 'demo:other', title: 'Other preferences' },
      ],
    });
    await render(<GuiPluginsManager pluginIds={['demo']} />);
    expect(container.textContent).toContain('Own command');
    expect(container.textContent).toContain('Own preferences');
    expect(container.textContent).not.toContain('Other');
    await click('guiPlugins.run');
    expect(ownCommand).toHaveBeenCalledWith('demo.run');
    const launcher = [...container.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'guiPlugins.open')!;
    await act(async () => launcher.click());
    expect(ownMenu).toHaveBeenCalledTimes(1);
  });

  test('scoped GUI errors remain visible and busy forms cannot toggle the interface', async () => {
    state.context = { ...context(), inventory: [{ id: 'demo', enabled: true, error: 'GUI bundle failed' }] };
    await render(<GuiPluginsManager pluginIds={['demo']} disabled />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('GUI bundle failed');
    const toggle = container.querySelector<HTMLElement>('[role="switch"]')!;
    expect(toggle.hasAttribute('data-disabled')).toBe(true);
    await act(async () => toggle.click());
    expect(context().setEnabled).not.toHaveBeenCalled();
  });

  test('places plugin actions with the source toggle outside the capture body and removes them in source mode', async () => {
    fixture.methods.mountPanel.mockImplementation((key, node, actions) => {
      const content = document.createElement('span'); content.textContent = `preview:${key}`; node.append(content);
      const action = document.createElement('button'); action.textContent = 'export'; actions!.append(action);
      return () => { action.remove(); content.remove(); };
    });
    updateSnapshot({ panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', inline: true, active: true, file: '/workspace/a.preview' }] });
    const view = <GuiFileLinkBridge path="/workspace/a.preview">{({ preview, controls }) => <>
      <header data-file-toolbar>{controls}</header><main>{preview ?? <pre>source</pre>}</main>
    </>}</GuiFileLinkBridge>;
    await render(view);
    expect(container.querySelectorAll('header button')).toHaveLength(2);
    expect(container.querySelector('main button')).toBeNull();
    await click('filesView.editor.switchToEditMode');
    expect(container.querySelectorAll('header button')).toHaveLength(1);
    expect(container.textContent).not.toContain('export');
    await click('filesView.editor.switchToPreviewMode');
    expect(container.querySelectorAll('header button')).toHaveLength(2);
    expect(container.querySelectorAll('[data-gui-preview-actions] button')).toHaveLength(1);
    updateSnapshot({ panels: [] });
    await render(<GuiFileLinkBridge path="/workspace/next.txt"><pre>next</pre></GuiFileLinkBridge>);
    expect(container.querySelector('button')).toBeNull();
  });

  test.skip('floating preview controls leave a content inset before the native scrollbar', async ({ skip }) => {
    const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const { compileProductionCssAsync, evidenceRoot, openChromeSession, openPageSession, resolveChrome } = await import('@/components/ui/chromeCdpHarness');
    if (!resolveChrome()) { skip(); return; }
    fixture.methods.mountPanel.mockImplementation((_key, node, actions) => {
      const content = document.createElement('div');
      content.style.height = '2000px';
      node.append(content);
      const action = document.createElement('button');
      action.textContent = 'export';
      actions!.append(action);
      return () => { content.remove(); action.remove(); };
    });
    updateSnapshot({ panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', inline: true, active: true, file: '/workspace/a.preview' }] });
    await render(<GuiFileLinkBridge path="/workspace/a.preview"><pre>source</pre></GuiFileLinkBridge>);
    const css = await compileProductionCssAsync(join(dirname(fileURLToPath(import.meta.url)), '../..'));
    const work = mkdtempSync(join(evidenceRoot(), 'preview-controls-'));
    const browser = await openChromeSession({ width: 800, height: 600, hideScrollbars: false });
    try {
      const file = join(work, 'index.html');
      writeFileSync(file, `<!doctype html><html class="desktop-runtime"><head><style>${css}</style></head><body><div id="root"><section style="width:360px;height:480px;display:flex">${container.innerHTML}</section></div></body></html>`);
      const page = await openPageSession(browser, { width: 800, height: 600, standalone: false });
      await page.send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
      await page.navigateFile(file);
      for (const width of [300, 360, 720]) {
        const geometry = await page.evaluate<{ gap: number; top: number; scrollbar: number }>(`(() => {
          document.querySelector('section').style.width = '${width}px';
          const scroller = document.querySelector('[data-gui-plugin-mount]');
          const controls = document.querySelector('[data-gui-preview-controls]');
          const rect = controls.getBoundingClientRect();
          const scrollRect = scroller.getBoundingClientRect();
          return { gap: scrollRect.left + scroller.clientWidth - rect.right,
            top: rect.top - scrollRect.top, scrollbar: scroller.offsetWidth - scroller.clientWidth };
        })()`);
        expect(geometry.scrollbar, `native scrollbar at ${width}px`).toBeGreaterThan(0);
        expect(geometry.gap, `controls inset before scrollbar at ${width}px`).toBeGreaterThanOrEqual(12);
        expect(geometry.top).toBeGreaterThanOrEqual(12);
      }
    } finally {
      await browser.close();
      rmSync(work, { recursive: true, force: true });
    }
  }, 120_000);

  test('deferred mounting cancels stale owners and unmounted work, including strict effect replay', async () => {
    const view = (revision: string) => <React.StrictMode><GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" revision={revision} fallback={<div role="status">Preparing</div>} /></React.StrictMode>;
    await act(async () => root.render(view('one')));
    await frame();
    const stale = [...frames.values()];
    await act(async () => root.render(view('two')));
    await act(async () => stale.forEach((callback) => callback(performance.now())));
    expect(fixture.methods.mountPanel).not.toHaveBeenCalled();
    await settleMount();
    expect(fixture.methods.mountPanel).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')).toBeNull();
    await act(async () => root.render(view('three')));
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Preparing');
    await act(async () => root.render(null));
    await settleMount();
    expect(frames.size).toBe(0);
    expect(fixture.log).toEqual(['mount:panel:a', 'dispose:panel:a']);
  });

  test('deferred render failure removes loading and partial DOM, then a new revision can retry', async () => {
    fixture.methods.mountPanel.mockImplementationOnce((_key, node) => {
      node.textContent = 'partial';
      throw new Error('render failed');
    });
    const view = (revision: string) => <GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" revision={revision} fallback={<div role="status">Preparing</div>} />;
    await render(view('one'));
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('render failed');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).not.toContain('partial');
    await render(view('two'));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toBe('external:a');
  });

  test.each(['inline', 'standalone'] as const)('%s panel keeps its DOM across 50 unrelated plugin reloads and remounts only its owner', async (surface) => {
    const plugin = { id: 'demo', revision: 'one', status: 'active' as const };
    updateSnapshot({
      plugins: [plugin, { id: 'other', revision: 'one', status: 'active' }],
      panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', active: true, inline: surface === 'inline', file: '/workspace/a.ydsl' }],
      activePanel: 'demo:a',
    });
    const view = () => surface === 'inline' ? <GuiFileLinkBridge path="/workspace/a.ydsl" /> : <GuiPluginSurface />;
    await render(view());
    const child = container.querySelector('[data-gui-plugin-mount]')!.firstChild;
    for (let index = 0; index < 50; index++) {
      updateSnapshot({ plugins: [plugin, { id: 'other', revision: String(index), status: 'active' }] });
      await render(view());
      expect(container.querySelector('[data-gui-plugin-mount]')!.firstChild).toBe(child);
    }
    expect(fixture.log).toEqual(['mount:panel:demo:a']);
    updateSnapshot({ plugins: [{ ...plugin, revision: 'two' }, context().snapshot.plugins[1]] });
    await render(view());
    expect(fixture.log).toEqual(['mount:panel:demo:a', 'dispose:panel:demo:a', 'mount:panel:demo:a']);
    expect(container.querySelector('[data-gui-plugin-mount]')!.firstChild).not.toBe(child);
    for (let index = 0; index < 50; index++) {
      updateSnapshot({ plugins: context().snapshot.plugins.map((item) => ({ ...item })) });
      await render(view());
    }
    expect(fixture.methods.mountPanel).toHaveBeenCalledTimes(2);
  });

  test('manager exposes session.panel launchers before any panel exists and reports launcher failures', async () => {
    const run = vi.fn();
    updateSnapshot({ menuItems: [{ key: 'launch', title: 'Open diagram', description: 'Create a diagram panel', run }] });
    await render(<GuiPluginsManager />);
    expect(container.textContent).toContain('guiPlugins.panels');
    expect(container.textContent).toContain('Open diagram');
    expect(container.textContent).toContain('Create a diagram panel');
    await click('guiPlugins.open');
    expect(run).toHaveBeenCalledTimes(1);
    run.mockImplementationOnce(() => { throw new Error('launcher failed'); });
    await click('guiPlugins.open');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('launcher failed');
    await click('guiPlugins.open');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    updateSnapshot({ menuItems: [] });
    await render(<GuiPluginsManager />);
    expect(container.textContent).not.toContain('Open diagram');
  });

  test('keeps a mount through unrelated renders and disposes before changing key, kind or host', async () => {
    await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
    for (let i = 0; i < 50; i++) await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
    expect(fixture.methods.mountPanel).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe('external:a');
    await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="b" />);
    await render(<GuiPluginMount host={fixture.host} kind="settings" contributionKey="b" />);
    expect(fixture.log).toEqual(['mount:panel:a', 'dispose:panel:a', 'mount:panel:b', 'dispose:panel:b', 'mount:settings:b']);
    const next = makeHost();
    await render(<GuiPluginMount host={next.host} kind="settings" contributionKey="b" />);
    expect(fixture.log.at(-1)).toBe('dispose:settings:b');
    expect(next.log).toEqual(['mount:settings:b']);
    await render(null);
    expect(next.log.at(-1)).toBe('dispose:settings:b');
  });

  test.each(['panel', 'settings', 'page'] as const)('exposes %s mount errors without leaving partial foreign DOM', async (kind) => {
    const method = kind === 'panel' ? fixture.methods.mountPanel : kind === 'settings' ? fixture.methods.mountSettings : fixture.methods.mountPage;
    method.mockImplementation((_key, node) => {
      node.textContent = 'partial';
      throw new Error('render failed');
    });
    await render(<GuiPluginMount host={fixture.host} kind={kind} contributionKey="a" />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('render failed');
    expect(container.querySelector('[data-file-preview-illustration] svg')).not.toBeNull();
    expect(container.textContent).not.toContain('partial');
  });

  test('locale changes do not recreate foreign content', async () => {
    const previous = state.t;
    try {
      await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
      state.t = (key: string) => `translated:${key}`;
      await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
      expect(fixture.log).toEqual(['mount:panel:a']);
      expect(container.textContent).toBe('external:a');
    } finally { state.t = previous; }
  });

  test('clears the container even when disposal fails', async () => {
    fixture.methods.mountPanel.mockImplementation((_key, node) => {
      node.textContent = 'foreign';
      return () => { throw new Error('dispose failed'); };
    });
    await render(<GuiPluginMount host={fixture.host} kind="panel" contributionKey="a" />);
    const node = container.querySelector('[data-gui-plugin-mount]')!;
    await render(null);
    expect(node.childNodes.length).toBe(0);
    expect(state.toast).toHaveBeenCalledWith('dispose failed');
  });

  test('surface selects and closes tabs; hiding disposes and reopening mounts again', async () => {
    updateSnapshot({ panels: [{ key: 'a', pluginId: 'demo', title: 'Alpha', active: true }, { key: 'b', pluginId: 'demo', title: 'Beta', active: false }], activePanel: 'a' });
    await render(<GuiPluginSurface />);
    await click('Beta');
    expect(fixture.methods.selectPanel).toHaveBeenCalledWith('b');
    updateSnapshot({ activePanel: 'b' });
    await render(<GuiPluginSurface />);
    expect(fixture.log).toEqual(['mount:panel:a', 'dispose:panel:a', 'mount:panel:b']);
    await click('guiPlugins.closePanel:Beta');
    expect(fixture.methods.closePanel).toHaveBeenCalledWith('b');
    await click('dismiss-window');
    expect(fixture.methods.hidePanel).toHaveBeenCalledTimes(1);
    updateSnapshot({ activePanel: null });
    await render(<GuiPluginSurface />);
    expect(fixture.log.at(-1)).toBe('dispose:panel:b');
    updateSnapshot({ activePanel: 'b' });
    await render(<GuiPluginSurface />);
    expect(fixture.log.at(-1)).toBe('mount:panel:b');
  });

  test('settings contributions are disposed when removed or the host changes', async () => {
    updateSnapshot({ settings: [{ key: 'settings', pluginId: 'demo', title: 'Preferences' }] });
    await render(<GuiPluginsManager />);
    await click('guiPlugins.open');
    expect(fixture.log).toEqual(['mount:settings:settings']);
    const next = makeHost();
    state.context = { ...context(), host: next.host };
    await render(<GuiPluginsManager />);
    expect(fixture.log.at(-1)).toBe('dispose:settings:settings');
    expect(next.log).toEqual([]);
    await click('guiPlugins.open');
    updateSnapshot({ settings: [] });
    await render(<GuiPluginsManager />);
    expect(next.log).toEqual(['mount:settings:settings', 'dispose:settings:settings']);
    updateSnapshot({ settings: [{ key: 'settings', pluginId: 'demo', title: 'Preferences' }] });
    await render(<GuiPluginsManager />);
    expect(next.methods.mountSettings).toHaveBeenCalledTimes(1);
  });

  test('batched same-key plugin replacement remounts settings when its bundle revision changes', async () => {
    const plugin = { id: 'demo', status: 'active' as const, revision: 'one' };
    updateSnapshot({ plugins: [plugin], settings: [{ key: 'settings', pluginId: 'demo', title: 'Preferences' }] });
    await render(<GuiPluginsManager />);
    await click('guiPlugins.open');
    updateSnapshot({ plugins: [{ ...plugin, revision: 'two' }] as typeof plugin[] });
    await render(<GuiPluginsManager />);
    expect(fixture.log).toEqual(['mount:settings:settings', 'dispose:settings:settings', 'mount:settings:settings']);
  });

  test.each(['demo', 'demo:tools'])('settings uses exact owner %s even when contribution keys have ambiguous prefixes', async (pluginId) => {
    const plugin = { id: pluginId, revision: 'one', status: 'active' as const };
    const otherId = pluginId === 'demo' ? 'demo:tools' : 'demo';
    const key = 'demo:tools:settings';
    updateSnapshot({
      plugins: [plugin, { id: otherId, revision: 'one', status: 'active' }],
      settings: [{ key, pluginId, title: 'Preferences' }],
    });
    await render(<GuiPluginsManager />);
    await click('guiPlugins.open');
    const child = container.querySelector('[data-gui-plugin-mount]')!.firstChild;
    for (let index = 0; index < 50; index++) {
      updateSnapshot({ plugins: [plugin, { id: otherId, revision: String(index), status: 'active' }] });
      await render(<GuiPluginsManager />);
      expect(container.querySelector('[data-gui-plugin-mount]')!.firstChild).toBe(child);
    }
    expect(fixture.log).toEqual([`mount:settings:${key}`]);
    updateSnapshot({ plugins: [{ ...plugin, revision: 'two' }, context().snapshot.plugins[1]] });
    await render(<GuiPluginsManager />);
    expect(fixture.log).toEqual([`mount:settings:${key}`, `dispose:settings:${key}`, `mount:settings:${key}`]);
    expect(container.querySelector('[data-gui-plugin-mount]')!.firstChild).not.toBe(child);
    for (let index = 0; index < 50; index++) {
      updateSnapshot({ plugins: context().snapshot.plugins.map((item) => ({ ...item })) });
      await render(<GuiPluginsManager />);
    }
    expect(fixture.methods.mountSettings).toHaveBeenCalledTimes(2);
  });

  test('failed plugins stay silent after their panel disappears', async () => {
    updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'failed', error: 'plugin crashed' }] });
    await render(<GuiPluginSurface />);
    for (let i = 0; i < 50; i++) {
      updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'failed', error: 'plugin crashed' }] });
      await render(<GuiPluginSurface />);
    }
    expect(state.toast).not.toHaveBeenCalled();
    expect(container.childElementCount).toBe(0);
  });

  test('discovery failure does not interrupt a healthy standalone panel', async () => {
    state.context = { ...context(), error: 'discovery failed' };
    updateSnapshot({ panels: [{ key: 'a', pluginId: 'demo', title: 'Alpha', active: true }], activePanel: 'a' });
    await render(<GuiPluginSurface />);
    expect(container.textContent).toContain('external:a');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(state.toast).not.toHaveBeenCalled();
  });
});

describe('file link routing', () => {
  test('a preloaded file preview paints its default SVG before mounting and cancels on source selection', async () => {
    updateSnapshot({ panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', inline: true, active: true, file: '/workspace/a.eficy' }] });
    const view = <GuiFileLinkBridge path="/workspace/a.eficy"><pre>source</pre></GuiFileLinkBridge>;
    await act(async () => root.render(view));
    expect(container.querySelector('[data-gui-preview-loading] svg')).not.toBeNull();
    expect(container.querySelector('[data-mobile-edge-to-edge-preview="true"]')).not.toBeNull();
    expect(fixture.methods.mountPanel).not.toHaveBeenCalled();
    await frame();
    expect(container.querySelector('[data-gui-preview-loading] svg')).not.toBeNull();
    expect(fixture.methods.mountPanel).not.toHaveBeenCalled();
    await click('guiPlugins.preview.viewSource');
    expect(container.querySelector('pre')?.textContent).toBe('source');
    expect(container.querySelector('[data-mobile-edge-to-edge-preview="true"]')).toBeNull();
    expect(fixture.methods.mountPanel).not.toHaveBeenCalled();
    await click('filesView.editor.switchToPreviewMode');
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    expect(container.textContent).toContain('external:demo:a');
    expect(fixture.methods.mountPanel).toHaveBeenCalledOnce();
  });

  test('requests GUI code only for a visible active file and offers source during loading', async () => {
    state.context = { ...context(), host: null, requested: false, loading: true };
    updateSnapshot({ plugins: [] });
    const view = (active: boolean) => <GuiFileLinkBridge path="/remote/中文 页面.eficy" active={active}><pre>source</pre></GuiFileLinkBridge>;
    await render(view(false));
    expect(context().requestLoad).not.toHaveBeenCalled();
    await render(<div hidden>{view(true)}</div>);
    expect(context().requestLoad).not.toHaveBeenCalled();
    await render(view(true));
    expect(context().requestLoad).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('guiPlugins.preview.loadingTitleguiPlugins.preview.loadingDescription');
    expect(container.querySelector('[data-gui-preview-loading] svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('[data-gui-preview-loading]')?.className).toContain('min-h-[240px]');
    expect(container.querySelector('pre')).toBeNull();
    state.context = { ...context(), requested: true };
    for (let index = 0; index < 50; index++) await render(view(true));
    expect(context().requestLoad).toHaveBeenCalledOnce();
    await click('guiPlugins.preview.viewSource');
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('source');
  });

  test('loading occupies the existing preview slot and source choice survives a ready panel', async () => {
    state.context = { ...context(), host: null, loading: true };
    updateSnapshot({ plugins: [] });
    const view = (path = '/workspace/a.preview') => <GuiFileLinkBridge path={path}>{({ preview, toggle }) => <>
      <header data-file-toolbar>{toggle}</header><main>{preview ?? <pre>source</pre>}</main>
    </>}</GuiFileLinkBridge>;
    await render(view());
    expect(container.querySelector('main [data-gui-preview-loading]')).not.toBeNull();
    expect(container.querySelector('header [data-gui-preview-loading]')).toBeNull();
    await click('filesView.editor.switchToEditMode');
    expect(container.querySelector('main pre')?.textContent).toBe('source');
    state.context = { ...context(), host: fixture.host };
    updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'active' }], panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', inline: true, active: true, file: '/workspace/a.preview' }] });
    await render(view());
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    expect(container.querySelector('[data-gui-plugin-mount]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('source');
    await click('filesView.editor.switchToPreviewMode');
    expect(container.textContent).toContain('external:demo:a');
    updateSnapshot({ panels: [] });
    await render(view('/workspace/b.preview'));
    expect(container.querySelector('[data-gui-preview-loading]')).not.toBeNull();
  });

  test('unmatched files leave loading when discovery finishes and expose ordinary source without controls', async () => {
    fixture.methods.openLink.mockReturnValue(false);
    state.context = { ...context(), loading: true };
    const view = () => <GuiFileLinkBridge path="a.txt"><pre>source</pre></GuiFileLinkBridge>;
    await render(view());
    expect(container.querySelector('[data-gui-preview-loading]')).not.toBeNull();
    state.context = { ...context(), loading: false };
    await render(view());
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('source');
    expect(container.querySelector('button')).toBeNull();
  });

  test('a failed bundle silently exposes source instead of covering it with another pending bundle', async () => {
    state.context = { ...context(), loading: true, inventory: [{ id: 'demo', enabled: true, error: 'Download failed' }] };
    await render(<GuiFileLinkBridge path="a.txt"><pre>source</pre></GuiFileLinkBridge>);
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    expect(container.querySelector('pre')?.textContent).toBe('source');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toBe('source');
  });

  test.each(['discovery', 'bundle', 'activation'])('%s failure silently preserves source and a recovered plugin restores inline preview', async (failure) => {
    state.context = {
      ...context(), host: null,
      error: failure === 'discovery' ? 'Relay unavailable' : null,
      inventory: [{ id: 'demo', enabled: true, ...(failure === 'bundle' ? { error: 'Relay unavailable' } : {}) }],
    };
    updateSnapshot({ plugins: failure === 'activation' ? [{ id: 'demo', revision: 'one', status: 'failed', error: 'Relay unavailable' }] : [] });
    const view = () => <GuiFileLinkBridge path="/remote/a.eficy"><pre>source</pre></GuiFileLinkBridge>;
    await render(view());
    expect(container.textContent).toBe('source');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(context().refresh).not.toHaveBeenCalled();
    expect(state.toast).not.toHaveBeenCalled();
    state.context = { ...context(), host: fixture.host, error: null, inventory: [{ id: 'demo', enabled: true }] };
    updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'active' }], panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', inline: true, active: true, file: '/remote/a.eficy' }] });
    await render(view());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).toContain('external:demo:a');
    expect(container.querySelector('[data-window]')).toBeNull();
  });

  test('a ready file plugin renders while an unrelated bundle is still loading', async () => {
    state.context = { ...context(), loading: true };
    await render(<GuiFileLinkBridge path="/remote/a.eficy" />);
    expect(fixture.methods.openLink).toHaveBeenCalledOnce();
    updateSnapshot({ panels: [{ key: 'demo:a', pluginId: 'demo', title: 'Preview', inline: true, active: true, file: '/remote/a.eficy' }] });
    await render(<GuiFileLinkBridge path="/remote/a.eficy" />);
    expect(container.textContent).toContain('external:demo:a');
    expect(container.querySelector('[aria-busy]')).toBeNull();
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    await click('filesView.editor.switchToEditMode');
    expect(container.querySelector('[data-gui-plugin-mount]')).toBeNull();
    expect(container.querySelector('[data-gui-preview-loading]')).toBeNull();
    await click('filesView.editor.switchToPreviewMode');
    expect(container.textContent).toContain('external:demo:a');
  });

  test('renders a file panel inline, switches to source and back, and never opens a window', async () => {
    updateSnapshot({ panels: [{ key: 'demo:a', pluginId: 'demo', title: 'a.ydsl', active: true, file: '/workspace/a.ydsl', inline: true }], activePanel: 'demo:a' });
    const view = <><GuiFileLinkBridge path="/workspace/a.ydsl" base="/workspace">{({ preview, toggle }) => <><header data-file-toolbar>{toggle}</header><main>{preview ?? <pre>editable source</pre>}</main></>}</GuiFileLinkBridge><GuiPluginSurface /></>;
    await render(view);
    expect(fixture.methods.registerFileView).toHaveBeenCalledWith('/workspace/a.ydsl', '/workspace');
    expect(container.querySelector('[data-window]')).toBeNull();
    expect(container.querySelector('[data-gui-file-view]')?.textContent).toContain('external:demo:a');
    expect(container.textContent).not.toContain('editable source');
    expect(container.querySelectorAll('[data-file-toolbar] button')).toHaveLength(1);
    expect(container.querySelector('[data-file-toolbar] button')?.textContent).toBe('');
    expect(container.textContent).not.toContain('guiPlugins.preview');
    await click('filesView.editor.switchToEditMode');
    expect(container.textContent).toContain('editable source');
    expect(fixture.log.at(-1)).toBe('dispose:panel:demo:a');
    for (let index = 0; index < 50; index++) await render(view);
    expect(fixture.methods.mountPanel).toHaveBeenCalledTimes(1);
    expect(fixture.methods.registerFileView).toHaveBeenCalledTimes(1);
    await click('filesView.editor.switchToPreviewMode');
    expect(fixture.methods.mountPanel).toHaveBeenCalledTimes(2);
    updateSnapshot({ panels: [], activePanel: null, plugins: [] });
    await render(<GuiFileLinkBridge path="/workspace/a.ydsl"><pre>editable source</pre></GuiFileLinkBridge>);
    expect(container.textContent).toBe('editable source');
  });

  test('takes over after initial loading but ignores 50 unrelated panel snapshots', async () => {
    state.context = { ...context(), loading: true, host: null };
    await render(<GuiFileLinkBridge path="/workspace/a.md" base="/workspace" />);
    expect(fixture.methods.openLink).not.toHaveBeenCalled();
    state.context = { ...context(), loading: false, host: fixture.host };
    await render(<GuiFileLinkBridge path="/workspace/a.md" base="/workspace" />);
    expect(fixture.methods.openLink).toHaveBeenCalledWith({ href: '/workspace/a.md', base: '/workspace', exact: true });
    for (let i = 0; i < 50; i++) {
      updateSnapshot({ activePanel: i % 2 ? 'panel' : null });
      await render(<GuiFileLinkBridge path="/workspace/a.md" base="/workspace" />);
    }
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(1);
    expect(container.querySelector('button')).toBeNull();
  });

  test('reacts to first plugin registration, path, base, and host identity', async () => {
    updateSnapshot({ plugins: [] });
    await render(<GuiFileLinkBridge path="a.md" base="/one" />);
    expect(fixture.methods.openLink).not.toHaveBeenCalled();
    updateSnapshot({ plugins: [{ id: 'demo', revision: 'one', status: 'active' }] });
    await render(<GuiFileLinkBridge path="a.md" base="/one" />);
    await render(<GuiFileLinkBridge path="b.md" base="/one" />);
    await render(<GuiFileLinkBridge path="b.md" base="/two" />);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(3);
    const next = makeHost();
    state.context = { ...context(), host: next.host };
    await render(<GuiFileLinkBridge path="b.md" base="/two" />);
    expect(next.methods.openLink).toHaveBeenCalledTimes(1);
  });

  test('same-host bundle revision changes retry matching without a transient loading render', async () => {
    const plugin = { id: 'demo', status: 'active' as const, revision: 'one' };
    updateSnapshot({ plugins: [plugin] });
    await render(<GuiFileLinkBridge path="a.md" />);
    updateSnapshot({ plugins: [{ ...plugin, revision: 'two' }] as typeof plugin[] });
    await render(<GuiFileLinkBridge path="a.md" />);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(2);
  });

  test('inactive and inert file views never take focus; reactivation opens the file', async () => {
    await render(<GuiFileLinkBridge path="a.md" active={false} />);
    expect(fixture.methods.openLink).not.toHaveBeenCalled();
    await render(<div inert><GuiFileLinkBridge path="a.md" /></div>);
    expect(fixture.methods.openLink).not.toHaveBeenCalled();
    await render(<GuiFileLinkBridge path="a.md" />);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(1);
    await render(<GuiFileLinkBridge path="a.md" active={false} />);
    await render(<GuiFileLinkBridge path="a.md" />);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(2);
  });

  test('strict effects do not open the same file twice, while close/reopen does', async () => {
    await render(<React.StrictMode><GuiFileLinkBridge path="a.md" /></React.StrictMode>);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(1);
    await render(null);
    await render(<GuiFileLinkBridge path="a.md" />);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(2);
  });

  test('a loading cycle retries once and failed matching preserves source fallback', async () => {
    fixture.methods.openLink.mockReturnValue(false);
    const view = <><GuiFileLinkBridge path="a.txt" /><pre>source fallback</pre></>;
    await render(view);
    expect(container.textContent).toContain('source fallback');
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('source fallback');
    state.context = { ...context(), loading: true };
    await render(<><GuiFileLinkBridge path="a.txt" /><pre>source fallback</pre></>);
    state.context = { ...context(), loading: false };
    await render(<><GuiFileLinkBridge path="a.txt" /><pre>source fallback</pre></>);
    expect(fixture.methods.openLink).toHaveBeenCalledTimes(2);
  });

  test('handler errors are visible and manual retry remains available', async () => {
    fixture.methods.openLink.mockImplementation(() => { throw new Error('link failed'); });
    await render(<GuiFileLinkBridge path="a.md" />);
    expect(container.querySelector('[role="status"]')?.textContent).toBe('link failed');
    fixture.methods.openLink.mockReturnValue(true);
    await click('filesView.editor.switchToPreviewMode');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });
});

test('palette filters commands, closes before running, and exposes rejected actions', async () => {
  updateSnapshot({ commands: [{ key: 'diagram', title: 'Diagram', run: () => {} }, { key: 'chart', title: 'Chart', run: () => {} }] });
  const close = vi.fn();
  fixture.methods.runCommand.mockImplementation(() => {
    expect(close).toHaveBeenCalledTimes(1);
    return Promise.reject(new Error('command failed'));
  });
  await render(<GuiPluginCommands query="Diagram" onSelect={close} />);
  expect(container.textContent).not.toContain('Chart');
  await click('Diagram');
  expect(fixture.methods.runCommand).toHaveBeenCalledWith('diagram');
  expect(state.toast).toHaveBeenCalledWith('command failed');
});

test('palette discovery is silent until commands arrive, including while discovery continues', async () => {
  state.context = { ...context(), host: null, requested: false, loading: true };
  updateSnapshot({ plugins: [], commands: [] });
  await render(<GuiPluginCommands query="" onSelect={() => {}} />);
  expect(context().requestLoad).not.toHaveBeenCalled();
  expect(container.childElementCount).toBe(0);
  updateSnapshot({ commands: [{ key: 'ready', title: 'Ready command', run: () => {} }] });
  await render(<GuiPluginCommands query="" onSelect={() => {}} />);
  expect(container.textContent).toContain('Ready command');
  expect(container.textContent).not.toContain('guiPlugins.loading');
  expect(container.querySelector('[role="status"]')).toBeNull();
});

test.each(['discovery', 'bundle', 'activation'])('palette stays silent on %s failure and retains healthy commands', async (failure) => {
  state.context = {
    ...context(), loading: false,
    error: failure === 'discovery' ? 'plugin unavailable' : null,
    inventory: [{ id: 'broken', enabled: true, ...(failure === 'bundle' ? { error: 'plugin unavailable' } : {}) }],
  };
  updateSnapshot({ commands: [], plugins: failure === 'activation' ? [{ id: 'broken', revision: 'one', status: 'failed', error: 'plugin unavailable' }] : [] });
  await render(<GuiPluginCommands query="" onSelect={() => {}} />);
  expect(container.childElementCount).toBe(0);
  updateSnapshot({ commands: [{ key: 'ready', title: 'Ready command', run: () => {} }] });
  await render(<GuiPluginCommands query="" onSelect={() => {}} />);
  expect(container.textContent).toBe('Ready command');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(context().refresh).not.toHaveBeenCalled();
  expect(state.toast).not.toHaveBeenCalled();
});

test('manager requests deferred plugins on entry and retries after runtime scope resets', async () => {
  state.context = { ...context(), host: null, requested: false, loading: true };
  updateSnapshot({ plugins: [] });
  const view = () => <GuiPluginsManager />;
  await render(view());
  expect(context().requestLoad).toHaveBeenCalledOnce();
  state.context = { ...context(), requested: true };
  for (let index = 0; index < 50; index++) await render(view());
  expect(context().requestLoad).toHaveBeenCalledOnce();
  state.context = { ...context(), requested: false };
  await render(view());
  expect(context().requestLoad).toHaveBeenCalledTimes(2);
});

test('commands consume live snapshots without requesting plugins across query and runtime changes', async () => {
  state.context = { ...context(), host: null, requested: false, loading: true };
  updateSnapshot({ plugins: [], commands: [] });
  for (let index = 0; index < 50; index++) {
    await render(<GuiPluginCommands query={`query-${index}`} onSelect={() => {}} />);
  }
  state.context = { ...context(), requested: false };
  await render(<GuiPluginCommands query="" onSelect={() => {}} />);
  expect(context().requestLoad).not.toHaveBeenCalled();
});
