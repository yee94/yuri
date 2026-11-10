import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GuiPluginsContextValue } from '@/lib/gui-plugins/react';
import { MobileGuiApps } from './MobileGuiApps';
import { GuiPluginSurface } from './GuiPluginSurface';
import { useUIStore } from '@/stores/useUIStore';

const fixture = vi.hoisted(() => ({ context: null as GuiPluginsContextValue | null, sheetUnmount: vi.fn() }));
vi.mock('@/lib/gui-plugins/react', () => ({ useGuiPlugins: () => fixture.context }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: true }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: ({ name }: { name: string }) => <svg data-icon={name} /> }));
vi.mock('@/components/ui/FilePreviewError', () => ({ FilePreviewError: ({ message }: { message: string }) => <p>{message}</p> }));
vi.mock('@/components/ui/MobileResizableSheet', () => ({ MobileResizableSheet: ({ open, title, compactHeader = false, showCloseButton = true, children }: { open: boolean; title: React.ReactNode; compactHeader?: boolean; showCloseButton?: boolean; children: React.ReactNode }) => {
  React.useEffect(() => () => fixture.sheetUnmount(), []);
  return open ? <section data-sheet data-compact-header={String(compactHeader)}><h2>{title}</h2>{showCloseButton ? <button aria-label="sheet-close" /> : null}{children}</section> : null;
} }));
vi.mock('./GuiPluginWindow', () => ({ GuiPluginWindow: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <section>{children}</section> : null }));
vi.mock('./GuiPluginPage', () => ({ GuiPluginPage: () => <div data-page /> }));
vi.mock('./GuiPluginMount', () => ({ GuiPluginMount: () => null }));
vi.mock('./GuiPreviewActions', () => ({ GuiPreviewActions: () => null }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeKey: () => 'fixture' }));

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let previous: ReturnType<typeof useUIStore.getState>;
const draw = async () => { await act(async () => root.render(<><MobileGuiApps /><GuiPluginSurface /></>)); };
const snapshot = (patch: Partial<GuiPluginsContextValue['snapshot']>) => {
  fixture.context = { ...fixture.context!, snapshot: { ...fixture.context!.snapshot, ...patch } };
};
const click = async (label: string) => {
  const button = [...container.querySelectorAll('button')].find(node => node.textContent === label || node.getAttribute('aria-label') === label);
  expect(button).toBeDefined();
  await act(async () => button!.click());
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  previous = useUIStore.getState();
  fixture.sheetUnmount.mockClear();
  useUIStore.setState({ activeMainTab: 'chat', activeGuiPage: null, mainTabGuard: null, isMobile: true });
  fixture.context = {
    host: {} as GuiPluginsContextValue['host'], snapshot: { plugins: [], pages: [], commands: [], titlebarItems: [], panels: [], settings: [], menuItems: [], activePanel: null },
    inventory: [], loading: false, requested: true, error: null, requestLoad: vi.fn(), refresh: vi.fn(), setEnabled: vi.fn(),
  };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); useUIStore.setState(previous); });

const enabledInventory = [{ id: 'one', enabled: true }];

it('shows the entry from inventory before plugins load, with loading then failure and retry in the sheet', async () => {
  fixture.context = { ...fixture.context!, host: null, requested: false, inventory: enabledInventory };
  await draw();
  await click('guiPlugins.apps');
  expect(fixture.context!.requestLoad).toHaveBeenCalledOnce();
  expect(container.querySelector('[data-gui-apps-loading]')).not.toBeNull();
  expect(container.querySelector('[data-sheet] h2')?.textContent).toBe('settings.page.plugins.title');
  expect(container.querySelector('[aria-label="sheet-close"]')).toBeNull();
  expect(container.querySelector('[data-sheet]')?.getAttribute('data-compact-header')).toBe('false');
  fixture.context = { ...fixture.context!, requested: true, loading: false, error: 'offline' };
  await draw();
  expect(container.querySelector('[data-gui-apps-loading]')).toBeNull();
  await click('guiPlugins.mobile.retry');
  expect(fixture.context!.refresh).toHaveBeenCalledOnce();
});

it('hides the entry without an enabled GUI plugin, and reports an empty catalog after loading', async () => {
  fixture.context = { ...fixture.context!, inventory: [{ id: 'one', enabled: false }] };
  await draw();
  expect(container.querySelector('button')).toBeNull();
  fixture.context = { ...fixture.context!, inventory: enabledInventory };
  await draw(); await click('guiPlugins.apps');
  expect(container.querySelector('[data-gui-apps-empty]')?.textContent).toContain('guiPlugins.mobile.noApps');
});

it('only exposes registered pages and opens their exact identity from icon cards', async () => {
  snapshot({ titlebarItems: [{ key: 'action', pluginId: 'demo', label: 'Action', title: 'Action', actionable: true }] });
  await draw();
  expect(container.querySelector('button')).toBeNull();
  snapshot({ pages: [
    { key: '["one","main"]', pluginId: 'one', title: 'First', icon: 'globe' },
    { key: '["two","main"]', pluginId: 'two', title: 'Second' },
  ] });
  await draw(); await click('guiPlugins.apps');
  expect(container.querySelectorAll('[data-icon="loader-4"]')).toHaveLength(0);
  expect([...container.querySelectorAll('[data-gui-apps] [data-icon]')].map(node => node.getAttribute('data-icon'))).toEqual(['global', 'window']);
  await click('Second');
  expect(useUIStore.getState().activeGuiPage).toBe('["two","main"]');
  expect(useUIStore.getState().activeMainTab).toBe('plugin');
  expect(container.querySelector('[data-sheet]')).toBeNull();
  expect(fixture.sheetUnmount).toHaveBeenCalledOnce();
  await act(async () => useUIStore.getState().closeGuiPage());
  expect(container.querySelector('[data-sheet]')).toBeNull();
  await click('guiPlugins.apps');
  expect(container.querySelector('[data-sheet]')).not.toBeNull();
});

it('retains the catalog when navigation into a plugin is blocked', async () => {
  snapshot({ pages: [{ key: '["one","main"]', pluginId: 'one', title: 'First' }] });
  useUIStore.setState({ mainTabGuard: () => false });
  await draw(); await click('guiPlugins.apps'); await click('First');
  expect(useUIStore.getState().activeMainTab).toBe('chat');
  expect(container.querySelector('[data-sheet]')).not.toBeNull();
  expect(fixture.sheetUnmount).not.toHaveBeenCalled();
});

it('does not keep another runtime’s app sheet open', async () => {
  snapshot({ pages: [{ key: '["one","main"]', pluginId: 'one', title: 'First' }] });
  await draw(); await click('guiPlugins.apps');
  expect(container.querySelector('[data-sheet]')).not.toBeNull();
  fixture.context = { ...fixture.context!, host: {} as GuiPluginsContextValue['host'] };
  await draw();
  expect(container.querySelector('[data-sheet]')).toBeNull();
});

it('closes a removed page even when an unrelated plugin failed, but retains its own failure', async () => {
  useUIStore.setState({ activeMainTab: 'plugin', activeGuiPage: '["removed","main"]', guiPageReturnTab: 'chat' });
  snapshot({ plugins: [{ id: 'unrelated', revision: '1', status: 'failed' }] });
  await draw();
  expect(useUIStore.getState().activeMainTab).toBe('chat');
  await act(async () => useUIStore.setState({ activeMainTab: 'plugin', activeGuiPage: '["unrelated","main"]' }));
  await draw();
  expect(useUIStore.getState().activeMainTab).toBe('plugin');
});
