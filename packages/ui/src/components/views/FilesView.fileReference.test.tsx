import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { TransactionSpec } from '@codemirror/state';
import { useFilesViewTabsStore } from '@/stores/useFilesViewTabsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useFileSearchStore } from '@/stores/useFileSearchStore';

const harness = vi.hoisted(() => ({
  files: { readFile: vi.fn(), listDirectory: vi.fn(), statFile: vi.fn(), writeFile: vi.fn(), downloadFile: vi.fn() },
  runtime: { isDesktop: false, isVSCode: false },
  local: false,
  pluginPreview: false,
  themeDark: false,
  openDesktopPath: vi.fn(),
  noop: () => {},
  empty: [],
  t: (key: string) => key,
  resizeObservers: new Map<Element, ResizeObserverCallback>(),
  explorerRenders: 0,
}));

vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: harness.t }) }));
vi.mock('@/lib/desktop', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/desktop')>(),
  isDesktopLocalOriginActive: () => harness.local,
  openDesktopPath: harness.openDesktopPath,
}));
vi.mock('@/components/gui-plugins/GuiFileLinkBridge', () => ({
  GuiFileLinkBridge: ({ children }: { children: (view: { preview: React.ReactNode; toggle: React.ReactNode; controls: React.ReactNode }) => React.ReactNode }) => children({
    preview: harness.pluginPreview ? <div data-testid="plugin-preview">Plugin preview<input defaultValue="initial" /><iframe title="plugin-document" /></div> : null,
    toggle: null,
    controls: harness.pluginPreview ? <button aria-label="plugin-source">Source</button> : null,
  }),
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: vi.fn(async () => new Response('{}')) }));
vi.mock('@/lib/runtime-file-resource', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime-file-resource')>(),
  directFileResource: () => ({ url: 'about:blank' }),
}));
vi.mock('@/lib/runtime-auth', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/runtime-auth')>(),
  acquireRuntimeUrlAuthToken: () => harness.noop,
  refreshRuntimeUrlAuthToken: async () => 'fixture-url-token',
  subscribeRuntimeUrlAuthToken: () => harness.noop,
}));
vi.mock('@/stores/useOpenInAppsStore', () => ({
  useOpenInAppsStore: (selector: (state: unknown) => unknown) => selector({ availableApps: harness.empty, initialize: harness.noop }),
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => harness }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo' }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false, isTablet: false, screenWidth: 1400 }) }));
vi.mock('@/contexts/useThemeSystem', async () => {
  const { getDefaultTheme } = await import('@/lib/theme/themes');
  const theme = getDefaultTheme(false);
  const value = { currentTheme: theme, availableThemes: [theme], lightThemeId: theme.metadata.id, darkThemeId: theme.metadata.id };
  const darkValue = { ...value, currentTheme: getDefaultTheme(true) };
  return { useThemeSystem: () => harness.themeDark ? darkValue : value, useOptionalThemeSystem: () => harness.themeDark ? darkValue : value };
});
vi.mock('@/lib/shiki/appThemeRegistry', () => ({ ensurePierreThemeRegistered: harness.noop, getResolvedShikiTheme: () => 'light' }));
vi.mock('@/lib/codemirror/shikiHighlight', () => ({ shikiHighlightExtension: () => [] }));
vi.mock('@/lib/codemirror/languageByExtension', () => ({ languageByExtension: () => [], loadLanguageByExtension: async () => [] }));
vi.mock('@/stores/useGitStore', () => ({ useGitStatus: () => null, useGitStore: (selector: (state: unknown) => unknown) => selector({ ensureStatus: harness.noop }) }));
vi.mock('@/components/views/GitView', () => ({ GitView: ({ isActive }: { isActive: boolean }) => <div data-testid="git-view" data-active={isActive} /> }));
vi.mock('@/hooks/useMessageTTS', () => ({ useMessageTTS: () => ({ isPlaying: false, play: harness.noop, stop: harness.noop }) }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  SimpleMarkdownRenderer: ({ content }: { content: string }) => <article data-testid="markdown-preview">{content}</article>,
}));
vi.mock('@/components/diagram', () => ({ DiagramEditor: () => null }));
vi.mock('@/components/views/DiffView', () => ({ DiffView: () => null }));
vi.mock('@/components/layout/ContextSidebarTab', () => ({ ContextPanelContent: () => null }));
vi.mock('@/components/layout/ContextPanelSessionTranscript', () => ({ ContextPanelSessionTranscript: () => null }));
vi.mock('@/components/layout/RightSidebarTabs', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/components/layout/RightSidebarTabs')>(),
  RightSidebarTabs: () => { harness.explorerRenders++; return <div data-testid="sidebar-explorer" />; },
}));
vi.mock('@/queries/browserProviderQueries', () => ({ useBrowserProviderCatalogQuery: () => ({ data: undefined }) }));
vi.mock('@/sync/sync-context', () => ({
  useDirectoryStore: () => ({ subscribe: () => harness.noop, getState: () => ({ session: harness.empty }) }),
  setContextPanelViewedSession: harness.noop,
  setExternallyViewedSession: harness.noop,
}));
vi.mock('@/components/comments', () => ({
  useInlineCommentController: () => ({ drafts: harness.empty, reset: harness.noop, setSelection: harness.noop }),
  buildCodeMirrorCommentWidgets: () => [],
  CodeSelectionActionBubble: () => null,
  normalizeLineRange: (value: unknown) => value,
}));
vi.mock('@/components/ui/CodeMirrorEditor', async () => {
  const { EditorState } = await import('@codemirror/state');
  return {
    CodeMirrorEditor: ({ value, onChange, readOnly, onViewReady }: {
      value: string; onChange: (value: string) => void; readOnly: boolean;
      onViewReady: (view: unknown) => void;
    }) => {
      const ready = React.useRef(onViewReady);
      const [view] = React.useState(() => ({
        state: EditorState.create({ doc: value }),
        focus: harness.noop,
        dispatch(spec: TransactionSpec) { this.state = this.state.update(spec).state; },
      }));
      React.useLayoutEffect(() => { view.state = EditorState.create({ doc: value }); }, [value, view]);
      React.useEffect(() => { ready.current(view); }, [view]);
      return <>
        <pre data-testid="editor">{value}</pre>
        <textarea data-testid="draft" value={value} readOnly={readOnly} onInput={(event) => onChange(event.currentTarget.value)} />
      </>;
    },
  };
});
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: () => null,
}));

import { FilesView } from './FilesView';
import { ContextPanel } from '@/components/layout/ContextPanel';
import { ChatWorkspace } from '@/components/layout/ChatWorkspace';
import { SidebarFilesTree } from '@/components/layout/SidebarFilesTree';
import { openFileReference } from '@/components/chat/fileReferenceActions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

let host: HTMLDivElement;
let reactRoot: Root;

// The panel owns the label and passes its target to the real file view.
function FilePanel() {
  const panel = useUIStore((state) => state.contextPanelByDirectory['/repo']);
  const tab = panel?.tabs.find((entry) => entry.id === panel.activeTabId);
  const targetPath = tab?.targetPath ?? null;
  return <><h1>{targetPath}</h1><FilesView key={targetPath} mode="editor-only" targetPath={targetPath} /></>;
}

async function open(path: string, atLine = false) {
  await act(async () => {
    if (atLine) useUIStore.getState().openContextFileAtLine('/repo', path, 3);
    else useUIStore.getState().openContextFile('/repo', path);
    useFilesViewTabsStore.getState().setSelectedPath('/repo', path, { allowOutsideRoot: true });
  });
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  harness.resizeObservers.clear();
  harness.explorerRenders = 0;
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { harness.resizeObservers.set(target, this.callback); }
    unobserve(target: Element) { harness.resizeObservers.delete(target); }
    disconnect() {
      for (const [target, callback] of harness.resizeObservers) {
        if (callback === this.callback) harness.resizeObservers.delete(target);
      }
    }
  });
  harness.files.readFile.mockReset();
  harness.runtime.isDesktop = false;
  harness.runtime.isVSCode = false;
  harness.local = false;
  harness.pluginPreview = false;
  harness.themeDark = false;
  harness.openDesktopPath.mockReset().mockResolvedValue(true);
  harness.files.downloadFile.mockReset().mockResolvedValue(undefined);
  harness.files.writeFile.mockReset().mockResolvedValue({ success: true });
  harness.files.statFile.mockReset().mockImplementation(async (path: string) => ({ path, size: 9, isFile: true }));
  harness.files.listDirectory.mockClear();
  harness.files.listDirectory.mockResolvedValue({ entries: [] });
  useFilesViewTabsStore.setState({ byRoot: {} });
  useUIStore.setState({ contextPanelByDirectory: {}, isRightSidebarOpen: false, activeMainTab: 'chat', rightSidebarTab: 'git', pendingFileFocusPath: null, pendingFileNavigation: null, pendingFileViewerMode: null, mainTabGuard: null });
  window.localStorage.setItem('yuri:files:auto-save-enabled', 'false');
  window.localStorage.removeItem('yuri:files:md-viewer-mode');
  window.localStorage.removeItem('yuri:files:html-viewer-mode');
  host = document.createElement('div');
  document.body.append(host);
  reactRoot = createRoot(host);
});

afterEach(async () => {
  await act(async () => reactRoot.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test.each([false, true])('plugin controls stay floating even with a legacy toolbar preference (%s)', async (expandedEditorToolbar) => {
  harness.pluginPreview = true;
  harness.files.readFile.mockResolvedValue({ content: 'preview content' });
  const initialState = useUIStore.getState();
  const legacyState = { ...initialState, expandedEditorToolbar };
  useUIStore.setState(legacyState);
  await open('/repo/report.preview');
  await act(async () => reactRoot.render(<FilePanel />));
  const controls = host.querySelector('[aria-label="plugin-source"]')!;
  expect(controls).not.toBeNull();
  expect(controls.closest('[data-testid="plugin-preview"]')).toBeNull();
  const floating = controls.closest('[data-gui-preview-controls]');
  expect(floating?.classList.contains('right-6')).toBe(true);
  expect(floating?.classList.contains('top-3')).toBe(true);
  expect(useUIStore.persist.getOptions().partialize!(useUIStore.getState())).not.toHaveProperty('expandedEditorToolbar');
  await act(async () => useUIStore.setState(initialState, true));
});

test.each(['click', 'hover'] as const)('editor controls start collapsed, expand on %s and collapse on leaving', async (action) => {
  harness.files.readFile.mockResolvedValue({ content: 'file content' });
  await open('/repo/A.ts');
  await act(async () => reactRoot.render(<FilePanel />));
  const trigger = host.querySelector<HTMLButtonElement>('[aria-label="filesView.editor.showControlsAria"]')!;
  expect(trigger).not.toBeNull();
  expect(host.querySelector('[title="filesView.editor.findInFile"]')).toBeNull();
  const floating = trigger.closest('.absolute')!;
  expect(floating.classList.contains('right-3')).toBe(true);
  if (action === 'click') await act(async () => trigger.click());
  else await act(async () => trigger.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
  expect(host.querySelector('[title="filesView.editor.findInFile"]')).not.toBeNull();
  await act(async () => floating.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })));
  expect(host.querySelector('[aria-label="filesView.editor.showControlsAria"]')).not.toBeNull();
  expect(host.querySelector('[title="filesView.editor.findInFile"]')).toBeNull();
});

test.each(['collapsed', 'expanded'] as const)('Markdown %s preview controls use global selection tokens without local overrides', async (toolbar) => {
  window.localStorage.setItem('yuri:files:md-viewer-mode', 'preview');
  harness.files.readFile.mockResolvedValue({ content: '# Report' });
  await open('/repo/report.md');
  await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
  if (toolbar === 'expanded') await clickButton('filesView.editor.showControlsAria');

  const header = host.querySelector('[data-context-panel] header')!;
  const toggle = host.querySelector<HTMLButtonElement>('[aria-label="filesView.editor.switchToEditMode"]')!;
  expect(header.className).not.toContain('--interactive-selection');
  expect(toggle.className).not.toContain('--interactive-selection:');
  expect(toggle.classList.contains('bg-[var(--interactive-selection)]')).toBe(true);
  await act(async () => toggle.click());
  expect(toggle.classList.contains('bg-[var(--interactive-selection)]')).toBe(false);
  expect(toggle.getAttribute('aria-label')).toBe('filesView.editor.switchToPreviewMode');
});

describe('binary file fallback', () => {
  test.each(['/repo/installer.dmg', '/repo/data.unknown', '/repo/binary.md'])('does not read or edit authoritative binary %s', async (path) => {
    harness.files.statFile.mockImplementation(async (requested: string) => ({ path: requested, isFile: true, size: 9_000_000, isBinary: true }));
    await open(path);
    await act(async () => reactRoot.render(<FilePanel />));
    expect(harness.files.readFile).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="editor"]')).toBeNull();
    expect(host.textContent).toContain('filesView.binary.description');
    await act(async () => host.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, metaKey: true, bubbles: true })));
    expect(harness.files.writeFile).not.toHaveBeenCalled();
    expect(harness.openDesktopPath).not.toHaveBeenCalled();
    await clickButton('sidebarFilesTree.menu.save');
    expect(harness.files.downloadFile).toHaveBeenCalledWith(path);
  });

  test.each([true, false])('system open requires explicit action on a local desktop (%s)', async (local) => {
    harness.runtime.isDesktop = true;
    harness.local = local;
    harness.files.statFile.mockResolvedValue({ path: '/repo/installer.dmg', isFile: true, size: 50, isBinary: true });
    await open('/repo/installer.dmg');
    await act(async () => reactRoot.render(<FilePanel />));
    expect(harness.openDesktopPath).not.toHaveBeenCalled();
    expect(host.textContent?.includes('filesView.binary.openSystemApp')).toBe(local);
    if (local) {
      await clickButton('filesView.binary.openSystemApp');
      expect(harness.openDesktopPath).toHaveBeenCalledWith('/repo/installer.dmg');
    }
  });

  test('a plugin preview wins over binary fallback without a text read', async () => {
    harness.pluginPreview = true;
    harness.files.statFile.mockResolvedValue({ path: '/repo/asset.custom', isFile: true, size: 50, isBinary: true });
    await open('/repo/asset.custom');
    await act(async () => reactRoot.render(<FilePanel />));
    expect(host.querySelector('[data-testid="plugin-preview"]')).not.toBeNull();
    expect(host.textContent).not.toContain('filesView.binary.description');
    expect(harness.files.readFile).not.toHaveBeenCalled();
  });

  test('stat failure is an inline failure, not permission to read text', async () => {
    harness.files.statFile.mockRejectedValue(new Error('stat offline'));
    await open('/outside/file.unknown');
    await act(async () => reactRoot.render(<FilePanel />));
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('stat offline');
    expect(harness.files.readFile).not.toHaveBeenCalled();
    expect(harness.files.statFile).toHaveBeenCalledWith('/outside/file.unknown', expect.objectContaining({ allowOutsideWorkspace: true, directory: '/repo' }));
  });

  test('a stale stat completion cannot start reading the old file or replace a newer binary', async () => {
    const stale = deferred<{ path: string; isFile: boolean; size: number; isBinary: boolean }>();
    harness.files.statFile.mockImplementation((path: string) => path === '/repo/old.unknown' ? stale.promise : Promise.resolve({ path, isFile: true, size: 50, isBinary: true }));
    await open('/repo/old.unknown');
    await act(async () => reactRoot.render(<FilePanel />));
    await open('/repo/new.dmg');
    await act(async () => stale.resolve({ path: '/repo/old.unknown', isFile: true, size: 50, isBinary: false }));
    expect(harness.files.readFile).not.toHaveBeenCalled();
    expect(host.textContent).toContain('filesView.binary.description');
    expect(host.querySelector('h1')?.textContent).toBe('/repo/new.dmg');
  });

  test('unknown suffix text remains readable after successful stat', async () => {
    harness.files.statFile.mockResolvedValue({ path: '/repo/data.unusual', isFile: true, size: 12, isBinary: false });
    harness.files.readFile.mockResolvedValue({ content: 'readable text' });
    await open('/repo/data.unusual');
    await act(async () => reactRoot.render(<FilePanel />));
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('readable text');
    expect(harness.files.statFile).toHaveBeenCalledTimes(1);
  });

  test('repeated metadata polls never read a large binary as text', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    harness.files.statFile.mockResolvedValue({ path: '/repo/installer.dmg', isFile: true, size: 4_000_000_000, mtimeMs: 1, isBinary: true });
    await open('/repo/installer.dmg');
    await act(async () => reactRoot.render(<FilePanel />));
    await act(async () => { await vi.advanceTimersByTimeAsync(100_000); });
    expect(harness.files.statFile.mock.calls.length).toBeGreaterThanOrEqual(50);
    expect(harness.files.readFile).not.toHaveBeenCalled();
    expect(harness.files.writeFile).not.toHaveBeenCalled();
  });
});

describe('background file preview refresh', () => {
  const startPreview = async (path: string, mode: 'full' | 'editor-only' = 'editor-only') => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    window.localStorage.setItem('yuri:files:md-viewer-mode', 'preview');
    window.localStorage.setItem('yuri:files:html-viewer-mode', 'preview');
    harness.files.statFile.mockImplementation(async (path: string) => ({ path, isFile: true, size: 2000, mtimeMs: 1, isBinary: false }));
    await open(path);
    useUIStore.setState({ pendingFileFocusPath: null });
    await act(async () => reactRoot.render(<FilesView mode={mode} targetPath={path} />));
  };

  const detectChange = async (path: string, revision = 2) => {
    const read = deferred<{ content: string }>();
    harness.files.readFile.mockReturnValueOnce(read.promise);
    harness.files.statFile.mockResolvedValue({ path, isFile: true, size: 2000, mtimeMs: revision, isBinary: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    return read;
  };

  test.each(['panel', 'full', 'fullscreen'] as const)('%s Markdown preview retains its reading position during repeated external updates', async (surface) => {
    const path = '/repo/report.md';
    const initial = '# Report\n\n' + 'Paragraph.\n\n'.repeat(200);
    harness.files.readFile.mockResolvedValue({ content: initial });
    await startPreview(path, surface === 'panel' ? 'editor-only' : 'full');
    if (surface === 'fullscreen') {
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="filesView.editor.showControlsAria"]')!.click());
      await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="filesView.editor.fullscreen"]')!.click());
    }
    const article = [...host.querySelectorAll<HTMLElement>('[data-testid="markdown-preview"]')].at(-1)!;
    expect(article.textContent).toBe(initial);
    const scroller = article.closest<HTMLElement>('.overflow-auto')!;
    scroller.scrollTop = 800;
    for (let revision = 2; revision <= 4; revision += 1) {
      const read = await detectChange(path, revision);
      expect(article.isConnected).toBe(true);
      expect(scroller.scrollTop).toBe(800);
      const updated = `${initial}\nRevision ${revision}`;
      await act(async () => read.resolve({ content: updated }));
      expect(article.isConnected).toBe(true);
      expect(article.textContent).toBe(updated);
      expect(scroller.scrollTop).toBe(800);
    }
    expect(harness.files.readFile).toHaveBeenCalledTimes(4);
  });

  test.each([false, true])('HTML preview keeps its iframe for metadata-only updates (inline %s)', async (inline) => {
    const path = '/repo/report.html';
    const content = '<!doctype html><html><body>Document</body></html>';
    harness.runtime.isVSCode = inline;
    harness.files.readFile.mockResolvedValue({ content });
    await startPreview(path);
    const iframe = host.querySelector<HTMLIFrameElement>('iframe[title="filesView.editor.htmlPreviewTitle"]')!;
    expect(iframe).not.toBeNull();
    const src = iframe.getAttribute('src');
    const srcDoc = iframe.getAttribute('srcdoc');
    const read = await detectChange(path);
    expect(iframe.isConnected).toBe(true);
    await act(async () => read.resolve({ content }));
    expect(host.querySelector('iframe[title="filesView.editor.htmlPreviewTitle"]')).toBe(iframe);
    expect(iframe.getAttribute('src')).toBe(src);
    expect(iframe.getAttribute('srcdoc')).toBe(srcDoc);
  });

  test('Eficy plugin preview retains its iframe and local controls while source refreshes', async () => {
    const path = '/repo/report.eficy';
    harness.pluginPreview = true;
    harness.files.readFile.mockResolvedValue({ content: 'source-v1' });
    await startPreview(path);
    const preview = host.querySelector('[data-testid="plugin-preview"]')!;
    const input = preview.querySelector('input')!;
    const iframe = preview.querySelector('iframe')!;
    input.value = 'reader choice';
    const read = await detectChange(path);
    expect(preview.isConnected).toBe(true);
    await act(async () => read.resolve({ content: 'source-v2' }));
    expect(host.querySelector('[data-testid="plugin-preview"]')).toBe(preview);
    expect(preview.querySelector('iframe')).toBe(iframe);
    expect(input.value).toBe('reader choice');
  });

  test.each([false, true])('HTML still loads genuinely changed source after the background read (inline %s)', async (inline) => {
    const path = '/repo/report.html';
    harness.runtime.isVSCode = inline;
    harness.files.readFile.mockResolvedValue({ content: '<html><body>Original</body></html>' });
    await startPreview(path);
    const iframe = host.querySelector<HTMLIFrameElement>('iframe[title="filesView.editor.htmlPreviewTitle"]')!;
    const read = await detectChange(path);
    expect(iframe.isConnected).toBe(true);
    const updated = '<html><body>Changed document</body></html>';
    await act(async () => read.resolve({ content: updated }));
    const refreshed = host.querySelector<HTMLIFrameElement>('iframe[title="filesView.editor.htmlPreviewTitle"]')!;
    if (inline) {
      expect(refreshed).toBe(iframe);
      expect(refreshed.getAttribute('srcdoc')).toContain('Changed document');
    } else {
      expect(refreshed).not.toBe(iframe);
      expect(refreshed.getAttribute('src')).toBe(iframe.getAttribute('src'));
    }
  });

  test('a failed background read keeps the last successful preview instead of clearing it', async () => {
    const path = '/repo/report.md';
    harness.files.readFile.mockResolvedValue({ content: '# Existing report' });
    await startPreview(path);
    const article = host.querySelector('[data-testid="markdown-preview"]')!;
    const read = await detectChange(path);
    await act(async () => read.reject(new Error('temporarily offline')));
    expect(host.querySelector('[data-testid="markdown-preview"]')).toBe(article);
    expect(article.textContent).toBe('# Existing report');
    expect(host.querySelector('[role="alert"]')).toBeNull();
    const recovery = await detectChange(path, 3);
    await act(async () => recovery.resolve({ content: '# Recovered report' }));
    expect(article.textContent).toBe('# Recovered report');
  });

  test('a slow background read is not duplicated and newer metadata is read after it settles', async () => {
    const path = '/repo/report.md';
    harness.files.readFile.mockResolvedValue({ content: '# Existing report' });
    await startPreview(path);
    const article = host.querySelector('[data-testid="markdown-preview"]')!;
    const read = await detectChange(path);
    harness.files.statFile.mockResolvedValue({ path, isFile: true, size: 2000, mtimeMs: 3, isBinary: false });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(harness.files.readFile).toHaveBeenCalledTimes(2);
    expect(article.isConnected).toBe(true);
    await act(async () => read.resolve({ content: '# Intermediate report' }));
    const recovery = deferred<{ content: string }>();
    harness.files.readFile.mockReturnValueOnce(recovery.promise);
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(harness.files.readFile).toHaveBeenCalledTimes(3);
    await act(async () => recovery.resolve({ content: '# Latest report' }));
    expect(article.textContent).toBe('# Latest report');
  });

  test('a late refresh cannot replace a newly selected file', async () => {
    const path = '/repo/report.md';
    harness.files.readFile.mockResolvedValue({ content: '# Existing report' });
    await startPreview(path);
    const read = await detectChange(path);
    harness.files.readFile.mockResolvedValue({ content: '# New file' });
    await open('/repo/new.md');
    await act(async () => reactRoot.render(<FilesView mode="editor-only" targetPath="/repo/new.md" />));
    await act(async () => read.resolve({ content: '# Stale refresh' }));
    expect(host.querySelector('[data-testid="markdown-preview"]')?.textContent).toBe('# New file');
  });
});

describe('file reference failure lifecycle', () => {
  test('keeps file search controls without exposing go-to-line inputs or buttons', async () => {
    harness.files.readFile.mockResolvedValue({ content: 'first\nsecond\nthird' });
    await open('/repo/A.ts');
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    await clickButton('filesView.editor.showControlsAria');
    expect(host.querySelector('[title="filesView.editor.findInFile"]')).not.toBeNull();
    expect(host.querySelector('[title="filesView.editor.goToLine"]')).toBeNull();
    expect(host.querySelector('input[type="number"]')).toBeNull();
    expect(host.textContent).not.toContain('goToLineDialog.actions.go');
  });

  test('autosave uses a legible outline icon in both states without changing file contents', async () => {
    window.localStorage.setItem('yuri:files:auto-save-enabled', 'true');
    harness.files.readFile.mockResolvedValue({ content: 'unchanged file' });
    await open('/repo/A.ts');
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    await clickButton('filesView.editor.showControlsAria');
    const enabled = host.querySelector<HTMLButtonElement>('[aria-label="filesView.editor.autoSaveOn"]')!;
    expect(enabled.querySelector('use')?.getAttribute('href')).toBe('#yuri-file-check');
    expect(enabled.getAttribute('aria-pressed')).toBe('true');
    await act(async () => enabled.click());
    const disabled = host.querySelector<HTMLButtonElement>('[aria-label="filesView.editor.manualSave"]')!;
    expect(disabled.querySelector('use')?.getAttribute('href')).toBe('#yuri-file-check');
    expect(disabled.getAttribute('aria-pressed')).toBe('false');
    expect(harness.files.writeFile).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('unchanged file');
  });

  test('the real expand button fills the workspace and restores its split without remounting drafts', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1200);
    harness.files.readFile.mockResolvedValue({ content: 'file content' });
    await open('/repo/A.ts');
    await act(async () => reactRoot.render(<ChatWorkspace header={<header>Session</header>} footer={<div data-terminal />}> <textarea data-composer defaultValue="unsent draft" /> </ChatWorkspace>));
    const panel = host.querySelector<HTMLElement>('[data-context-panel]')!;
    const main = host.querySelector<HTMLElement>('[data-primary-chat]')!;
    const composer = host.querySelector<HTMLTextAreaElement>('[data-composer]')!;
    const editor = host.querySelector('[data-testid="draft"]');
    const savedWidth = useUIStore.getState().contextPanelByDirectory['/repo'].width;
    expect(main.inert).toBe(false);
    expect(panel.classList.contains('pl-1')).toBe(true);
    await clickButton('contextPanel.actions.expandPanel');
    expect(main.inert).toBe(true);
    expect(panel.style.width).toBe('100%');
    expect(panel.classList.contains('relative')).toBe(true);
    expect(panel.classList.contains('absolute')).toBe(false);
    expect(panel.classList.contains('py-1.5')).toBe(true);
    expect(panel.classList.contains('pl-1')).toBe(true);
    expect(panel.querySelector('[aria-label="contextPanel.actions.collapsePanel"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(panel.querySelector('[aria-label="contextPanel.actions.collapsePanel"] use')?.getAttribute('href')).toBe('#yuri-collapse-diagonal');
    await clickButton('contextPanel.actions.collapsePanel');
    expect(main.inert).toBe(false);
    expect(panel.classList.contains('absolute')).toBe(false);
    expect(panel.classList.contains('pl-1')).toBe(true);
    expect(panel.classList.contains('px-1.5')).toBe(false);
    expect(panel.classList.contains('py-1.5')).toBe(true);
    expect(panel.style.getPropertyValue('--yuri-context-panel-width')).toBe(`${savedWidth}px`);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].width).toBe(savedWidth);
    expect(host.querySelector('[data-composer]')).toBe(composer);
    expect(composer.value).toBe('unsent draft');
    expect(host.querySelector('[data-testid="draft"]')).toBe(editor);
    expect(activeFilePath()).toBe('/repo/A.ts');
  });

  test('drag fullscreen and button fullscreen share layout, restore controls and preserve drafts without per-move store writes', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
      if (!this.hasAttribute('data-context-panel')) return 1200;
      return this.style.width === '100%' ? 1200 : Number.parseFloat(this.style.getPropertyValue('--yuri-context-panel-width')) || 600;
    });
    harness.files.readFile.mockResolvedValue({ content: 'file content' });
    await open('/repo/A.ts');
    await act(async () => reactRoot.render(<ChatWorkspace><textarea data-composer defaultValue="unsent draft" /></ChatWorkspace>));
    const panel = host.querySelector<HTMLElement>('[data-context-panel]')!;
    const main = host.querySelector<HTMLElement>('[data-primary-chat]')!;
    const input = host.querySelector('[data-composer]');
    const editor = host.querySelector('[data-testid="draft"]');
    const separator = panel.querySelector('[data-context-resize-handle]')!;
    const pointer = async (type: string, clientX: number) => {
      await act(async () => separator.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerId: 1, clientX })));
    };
    const initial = useUIStore.getState().contextPanelByDirectory['/repo'];
    await pointer('pointerdown', 600);
    for (let index = 0; index < 50; index++) await pointer('pointermove', 600 - index * 6);
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toBe(initial);
    expect(main.inert).toBe(true);
    expect(panel.querySelector('[aria-label="contextPanel.actions.collapsePanel"]')?.getAttribute('aria-pressed')).toBe('true');
    const fullscreenClass = panel.className;
    expect(panel.style.width).toBe('100%');
    await pointer('pointerup', 306);
    await clickButton('contextPanel.actions.collapsePanel');
    expect(main.inert).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].width).toBe(600);
    await clickButton('contextPanel.actions.expandPanel');
    expect(panel.className).toBe(fullscreenClass);
    expect(panel.style.width).toBe('100%');
    expect(main.inert).toBe(true);
    await pointer('pointerdown', 0);
    await pointer('pointermove', 600);
    expect(main.inert).toBe(false);
    expect(panel.querySelector('[aria-label="contextPanel.actions.expandPanel"]')?.getAttribute('aria-pressed')).toBe('false');
    await pointer('pointerup', 600);
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ width: 600, expanded: false });
    expect(host.querySelector('[data-composer]')).toBe(input);
    expect(host.querySelector('[data-testid="draft"]')).toBe(editor);
  });

  test('restoring automatic fullscreen after a viewport shrink leaves 350px for the conversation', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1000);
    harness.files.readFile.mockResolvedValue({ content: 'file content' });
    await open('/repo/A.ts');
    await act(async () => reactRoot.render(<ChatWorkspace>Chat</ChatWorkspace>));
    const workspace = host.querySelector<HTMLElement>('[data-chat-area]')!;
    const main = host.querySelector<HTMLElement>('[data-primary-chat]')!;
    expect(main.inert).toBe(false);
    await act(async () => harness.resizeObservers.get(workspace)?.([
      { contentRect: { width: 900 } } as ResizeObserverEntry,
    ], {} as ResizeObserver));
    expect(main.inert).toBe(true);
    await clickButton('contextPanel.actions.collapsePanel');
    expect(main.inert).toBe(false);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].width).toBe(550);
  });

  test('the compact file search still debounces filtering and clears back to the same focused field', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const search = vi.spyOn(useFileSearchStore.getState(), 'searchFiles').mockResolvedValue([
      { name: 'notes.ts', path: '/repo/notes.ts', relativePath: 'notes.ts', extension: 'ts' },
    ]);
    await act(async () => reactRoot.render(<SidebarFilesTree />));
    const input = host.querySelector<HTMLInputElement>('[data-sidebar-file-search] input')!;
    expect(input.classList.contains('h-7')).toBe(true);
    expect(input.classList.contains('focus:ring-1')).toBe(true);
    expect(input.classList.contains('bg-[color-mix(in_srgb,var(--surface-foreground)_2%,var(--background))]')).toBe(true);
    expect(input.classList.contains('bg-[var(--surface-elevated)]')).toBe(false);
    expect(input.getAttribute('aria-label')).toBe('sidebarFilesTree.search.placeholder');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'notes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(search).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(search).toHaveBeenCalledWith('/repo', 'notes', 150, expect.objectContaining({ type: 'file' }));
    expect(host.textContent).toContain('notes.ts');
    await clickButton('sidebarFilesTree.search.clearAria');
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
    expect(host.querySelector('[data-sidebar-file-search] input')).toBe(input);
  });

  const resizePreview = async (width: number) => {
    const body = host.querySelector<HTMLElement>('[data-context-layout]')!;
    const callback = harness.resizeObservers.get(body);
    expect(callback).toBeTruthy();
    await act(async () => callback!([{
      target: body,
      contentRect: new DOMRect(0, 0, width, 800),
      borderBoxSize: [], contentBoxSize: [], devicePixelContentBoxSize: [],
    }], {} as ResizeObserver));
  };

  test('switches a narrow rail to preview only after confirmed navigation and restores both panes at 400px', async () => {
    harness.files.readFile.mockResolvedValue({ content: 'file content' });
    await act(async () => {
      useUIStore.getState().openContextPanel('/repo');
      reactRoot.render(<ContextPanel directory="/repo" />);
    });
    await resizePreview(399);
    const preview = host.querySelector<HTMLElement>('[data-context-preview-content]')!;
    expect(preview.inert).toBe(true);
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).not.toBeNull();
    await clickButton('contextPanel.actions.toggleFileTree');
    await open('/repo/A.ts');
    expect(preview.inert).toBe(false);
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).toBeNull();
    expect(useUIStore.getState().isRightSidebarOpen).toBe(true);
    const editor = host.querySelector('[data-testid="draft"]');
    await clickButton('contextPanel.actions.toggleFileTree');
    expect(preview.inert).toBe(true);
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).not.toBeNull();
    await open('/repo/A.ts');
    expect(preview.inert).toBe(false);
    expect(host.querySelector('[data-testid="draft"]')).toBe(editor);
    await resizePreview(400);
    expect(host.querySelector('[data-context-layout]')?.getAttribute('data-context-layout')).toBe('split');
    expect(preview.inert).toBe(false);
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).not.toBeNull();
    await resizePreview(399);
    expect(preview.inert).toBe(false);
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).toBeNull();
    await clickButton('contextPanel.actions.toggleFileTree');
    const tab = host.querySelector<HTMLButtonElement>('[role="tab"]')!;
    await act(async () => tab.click());
    expect(preview.inert).toBe(false);
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).toBeNull();
  });

  test('keeps the narrow file tree visible through a cancelled unsaved guard, then reveals the confirmed target', async () => {
    harness.files.readFile.mockResolvedValue({ content: 'file content' });
    await open('/repo/A.ts');
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    const editor = host.querySelector<HTMLTextAreaElement>('[data-testid="draft"]')!;
    await act(async () => {
      editor.value = 'unsaved';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickButton('contextPanel.actions.toggleFileTree');
    const preview = host.querySelector<HTMLElement>('[data-context-preview-content]')!;
    await open('/repo/B.ts');
    expect(activeFilePath()).toBe('/repo/A.ts');
    expect(preview.inert).toBe(true);
    await clickButton('filesView.dialog.cancel');
    expect(preview.inert).toBe(true);
    await open('/repo/B.ts');
    await clickButton('filesView.unsaved.discard');
    expect(activeFilePath()).toBe('/repo/B.ts');
    expect(preview.inert).toBe(false);
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).toBeNull();
  });

  test('does not rerender the explorer for 50 same-side content resize events', async () => {
    await act(async () => {
      useUIStore.getState().openContextPanel('/repo');
      reactRoot.render(<ContextPanel directory="/repo" />);
    });
    await resizePreview(400);
    const renders = harness.explorerRenders;
    for (let index = 0; index < 50; index++) await resizePreview(400 + index);
    expect(harness.explorerRenders).toBe(renders);
    await resizePreview(399);
    const compactRenders = harness.explorerRenders;
    for (let index = 0; index < 50; index++) await resizePreview(300 + index);
    expect(harness.explorerRenders).toBe(compactRenders);
  });

  test('the zero-settings workspace shows Git Changes and keeps a manually closed preview closed after remount', async () => {
    const initial = useUIStore.getInitialState();
    useUIStore.setState({
      isRightSidebarOpen: initial.isRightSidebarOpen,
      rightSidebarTab: initial.rightSidebarTab,
      sessionWorkspacePanelById: {},
    });
    const commits: boolean[] = [];
    const recordCommit = () => commits.push(host.querySelector<HTMLElement>('[data-context-panel]')?.inert === false
      && host.querySelector('[data-testid="sidebar-explorer"]') !== null);
    await act(async () => reactRoot.render(<React.Profiler id="workspace" onRender={recordCommit}><ChatWorkspace>Chat</ChatWorkspace></React.Profiler>));
    expect(commits[0]).toBe(true);
    const panel = host.querySelector<HTMLElement>('[data-context-panel]')!;
    expect(panel.inert).toBe(false);
    expect(panel.classList.contains('py-1.5')).toBe(true);
    await act(async () => useUIStore.getState().toggleContextPanelExpanded('/repo'));
    expect(panel.classList.contains('py-1.5')).toBe(true);
    await act(async () => useUIStore.getState().toggleContextPanelExpanded('/repo'));
    expect(panel.querySelector('[data-testid="sidebar-explorer"]')).not.toBeNull();
    expect(panel.querySelector('[aria-label="layout.rightSidebar.git"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(useUIStore.getState().contextPanelByDirectory['/repo']).toMatchObject({ isOpen: true, tabs: [] });
    expect(harness.files.readFile).not.toHaveBeenCalled();
    await clickButton('contextPanel.actions.closePanel');
    expect(panel.inert).toBe(true);
    await act(async () => reactRoot.render(null));
    await act(async () => reactRoot.render(<ChatWorkspace>Chat</ChatWorkspace>));
    expect(host.querySelector<HTMLElement>('[data-context-panel]')?.inert).toBe(true);
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).toBeNull();
  });

  test.each(['git', 'files'] as const)('empty previews always reveal the remembered %s rail, including restored closed-rail state', async (tab) => {
    await act(async () => {
      useUIStore.getState().setRightSidebarTab(tab);
      useUIStore.getState().openContextPanel('/repo');
      reactRoot.render(<ContextPanel directory="/repo" />);
    });
    const label = tab === 'git' ? 'layout.rightSidebar.git' : 'contextPanel.actions.toggleFileTree';
    expect(useUIStore.getState().rightSidebarTab).toBe(tab);
    await act(async () => useUIStore.getState().setRightSidebarOpen(false));
    for (const width of [720, 360]) {
      await resizePreview(width);
      expect(host.querySelector('[data-testid="sidebar-explorer"]')).not.toBeNull();
      expect(host.querySelector(`[aria-label="${label}"]`)?.getAttribute('aria-pressed')).toBe('true');
    }
    expect(harness.files.readFile).not.toHaveBeenCalled();
  });

  test.each([
    { preferred: 'git', main: 'git', selected: 'contextPanel.actions.toggleFileTree', gitActive: false },
    { preferred: 'browser', main: 'chat', selected: 'layout.rightSidebar.git', gitActive: true },
  ] as const)('resolves unavailable $preferred rail on the first commit without mutating the saved choice', async ({ preferred, main, selected, gitActive }) => {
    const { RightSidebarTabs, RightSidebarToolbar } = await vi.importActual<typeof import('@/components/layout/RightSidebarTabs')>('@/components/layout/RightSidebarTabs');
    useUIStore.setState({ rightSidebarTab: preferred, activeMainTab: main });
    const initial = useUIStore.getState();
    const commits: boolean[] = [];
    const recordCommit = () => commits.push(host.querySelector(`[aria-label="${selected}"]`)?.getAttribute('aria-pressed') === 'true'
      && host.querySelector('[data-testid="git-view"]')?.getAttribute('data-active') === String(gitActive));
    await act(async () => reactRoot.render(<React.Profiler id="rail" onRender={recordCommit}>
      <RightSidebarToolbar railVisible />
      <RightSidebarTabs isActive />
    </React.Profiler>));
    expect(commits[0]).toBe(true);
    expect(useUIStore.getState()).toBe(initial);
  });

  test('opens an empty preview without file reads, nests the file tree and closes both together', async () => {
    await act(async () => {
      useUIStore.getState().openContextPanel('/repo');
      reactRoot.render(<ContextPanel directory="/repo" />);
    });
    const panel = host.querySelector<HTMLElement>('[data-context-panel]')!;
    expect(panel.style.minWidth).toBe('min(300px, 100%)');
    expect(panel.inert).toBe(false);
    expect(panel.querySelector('[data-context-panel-surface]')?.classList.contains('rounded-xl')).toBe(true);
    const surface = panel.querySelector('[data-context-panel-surface]')!;
    expect(surface.hasAttribute('data-workspace-surface')).toBe(true);
    expect(surface.querySelector('[data-workspace-surface-ring]')?.classList.contains('ring-inset')).toBe(true);
    expect(surface.classList.contains('border')).toBe(false);
    expect(surface.classList.contains('[--background:oklch(from_var(--surface-background)_min(1,calc(l_+_0.015))_c_h)]')).toBe(true);
    expect(surface.classList.contains('dark:[--background:color-mix(in_srgb,var(--surface-foreground)_4%,var(--surface-background))]')).toBe(true);
    expect(panel.textContent).toContain('contextPanel.empty.selectFile');
    expect(panel.querySelector('[data-context-preview-content] [aria-hidden="true"] svg')).not.toBeNull();
    expect(harness.files.readFile).not.toHaveBeenCalled();
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).not.toBeNull();
    expect(useUIStore.getState().rightSidebarTab).toBe('git');
    expect(panel.querySelector('aside')?.classList.contains('bg-transparent')).toBe(true);
    expect(panel.querySelector('aside')?.className).not.toContain('[--background:');
    expect(panel.querySelector('aside')?.classList.contains('[--layout-chrome-divider-width:1px]')).toBe(true);
    expect(panel.querySelector('aside')?.classList.contains('[--layout-chrome-divider:color-mix(in_srgb,var(--surface-foreground)_8%,var(--background))]')).toBe(true);
    expect(panel.querySelector('[aria-label="layout.rightSidebar.git"]')?.getAttribute('aria-pressed')).toBe('true');
    const buttonGroup = panel.querySelector('[role="group"]')!;
    for (const token of ['h-7', 'rounded-md', 'border', 'border-border/40', 'divide-x', 'divide-border/40', 'overflow-hidden']) {
      expect(buttonGroup.classList.contains(token)).toBe(true);
    }
    expect(buttonGroup.classList.contains('gap-1')).toBe(false);
    expect(buttonGroup.className).not.toContain('bg-');
    for (const button of buttonGroup.querySelectorAll('button')) {
      for (const token of ['h-full', 'w-7', '!rounded-none', 'hover:bg-interactive-hover', 'focus-visible:ring-inset']) {
        expect(button.classList.contains(token)).toBe(true);
      }
      expect(button.classList.contains('border')).toBe(false);
    }
    await clickButton('contextPanel.actions.toggleFileTree');
    expect(panel.querySelector('[data-testid="sidebar-explorer"]')).not.toBeNull();
    expect(useUIStore.getState().rightSidebarTab).toBe('files');
    expect(panel.querySelector('[aria-label="contextPanel.actions.toggleFileTree"]')?.getAttribute('aria-pressed')).toBe('true');
    await clickButton('contextPanel.actions.closePanel');
    expect(panel.inert).toBe(true);
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).toBeNull();
    await act(async () => useUIStore.getState().toggleContextPanel('/repo'));
    expect(panel.inert).toBe(false);
    expect(panel.textContent).toContain('contextPanel.empty.selectFile');
    await clickButton('contextPanel.actions.toggleFileTree');
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).not.toBeNull();
    expect(panel.inert).toBe(false);
  });

  test('dark preview headers keep the original theme selection tokens', async () => {
    harness.themeDark = true;
    await act(async () => {
      useUIStore.getState().openContextPanel('/repo');
      reactRoot.render(<ContextPanel directory="/repo" />);
    });
    expect(host.querySelector('[data-context-panel] header')?.className).not.toContain('--interactive-selection');
  });

  test('preview tabs use compact selection with separate close controls and preserve tab navigation', async () => {
    harness.files.readFile.mockResolvedValue({ content: 'file content' });
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    await open('/repo/first.ts');
    await open('/repo/second.md');

    const tablist = host.querySelector('[role="tablist"]')!;
    const tabs = [...tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs).toHaveLength(2);
    expect(tablist.closest('header')?.classList.contains('app-region-drag')).toBe(true);
    expect(tablist.closest('header')?.className).not.toContain('--interactive-selection');
    expect(host.querySelector('[data-context-preview-content]')?.className).not.toContain('--interactive-selection');
    expect(host.querySelector('[data-context-file-path]')).toBeNull();
    expect(tabs[1].getAttribute('title')).toContain('second.md');
    expect(tabs[1].parentElement?.classList.contains('bg-interactive-selection')).toBe(true);
    expect(tablist.querySelector('[aria-hidden].bg-\\[var\\(--primary-base\\)\\]')).toBeNull();
    for (const tab of tabs) {
      expect(tab.classList.contains('text-xs')).toBe(true);
      expect(tab.querySelector('[role="button"]')).toBeNull();
      const close = tab.parentElement?.querySelector<HTMLButtonElement>('button:not([role="tab"])');
      expect(close).not.toBeNull();
      expect(close?.classList.contains('opacity-0')).toBe(false);
    }

    await act(async () => tabs[0].click());
    expect(activeFilePath()).toBe('/repo/first.ts');
    const close = tabs[1].parentElement!.querySelector<HTMLButtonElement>('button:not([role="tab"])')!;
    await act(async () => close.click());
    expect(activeFilePath()).toBe('/repo/first.ts');
    expect(tablist.querySelectorAll('[role="tab"]')).toHaveLength(1);
    await act(async () => tabs[0].parentElement!.dispatchEvent(new MouseEvent('auxclick', { bubbles: true, button: 1 })));
    expect(tablist.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].isOpen).toBe(false);
    expect(host.querySelector<HTMLElement>('[data-context-panel]')?.inert).toBe(true);
    expect(host.querySelector('[data-testid="sidebar-explorer"]')).toBeNull();
  });

  test('panel publishes its requested width while filling the collapsed primary pane, then restores on close', async () => {
    const onReservedWidthChange = vi.fn();
    harness.files.readFile.mockResolvedValue({ content: 'file content' });
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" onReservedWidthChange={onReservedWidthChange} />));
    expect(onReservedWidthChange).toHaveBeenLastCalledWith(0);
    await open('/repo/file.ts');
    await act(async () => useUIStore.getState().setContextPanelWidth('/repo', 700));
    expect(onReservedWidthChange).toHaveBeenLastCalledWith(700);
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" onReservedWidthChange={onReservedWidthChange} fillAvailableSpace />));
    const panel = host.querySelector<HTMLElement>('[data-context-panel]')!;
    expect(panel.style.width).toBe('100%');
    expect(panel.style.getPropertyValue('--yuri-context-panel-width')).toBe('700px');
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].width).toBe(700);

    const separator = host.querySelector('[role="separator"]')!;
    expect(separator.hasAttribute('data-context-resize-handle')).toBe(true);
    expect(separator.classList.contains('w-4')).toBe(true);
    expect(separator.classList.contains('-left-1')).toBe(true);
    expect(separator.classList.contains('touch-none')).toBe(true);
    const grip = separator.querySelector('[aria-hidden="true"]')!;
    expect(grip.classList.contains('rounded-full')).toBe(true);
    expect(grip.classList.contains('opacity-0')).toBe(true);
    expect(grip.classList.contains('bg-muted-foreground/25')).toBe(true);
    expect(panel.classList.contains('overflow-visible')).toBe(true);
    expect(panel.querySelector('[data-context-panel-surface]')?.classList.contains('overflow-hidden')).toBe(true);
    await act(async () => separator.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 700, pointerId: 1 })));
    expect(grip.classList.contains('opacity-100')).toBe(true);
    await act(async () => separator.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 800, pointerId: 1 })));
    expect(onReservedWidthChange).toHaveBeenLastCalledWith(600);
    await act(async () => separator.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 800, pointerId: 1 })));
    expect(grip.classList.contains('opacity-0')).toBe(true);
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].width).toBe(600);

    await act(async () => separator.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: 800, pointerId: 2 })));
    await act(async () => separator.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 1200, pointerId: 2 })));
    expect(onReservedWidthChange).toHaveBeenLastCalledWith(300);
    await act(async () => separator.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: 1200, pointerId: 2 })));
    expect(useUIStore.getState().contextPanelByDirectory['/repo'].width).toBe(300);
    expect(panel.style.getPropertyValue('--yuri-context-panel-width')).toBe('300px');

    await act(async () => useUIStore.getState().toggleContextPanelExpanded('/repo'));
    expect(onReservedWidthChange).toHaveBeenLastCalledWith(Infinity);
    expect(host.querySelector('[data-context-resize-handle]')).not.toBeNull();
    await act(async () => useUIStore.getState().closeContextPanel('/repo'));
    expect(onReservedWidthChange).toHaveBeenLastCalledWith(0);
  });

  test('an encoded file link uses the decoded filename for its tab title', async () => {
    const path = '30 📚 Learning/📚 Knowledge/相机画幅图解.eficy';
    harness.files.readFile.mockResolvedValue({ content: 'file content' });
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    await act(async () => openFileReference(encodeURI(path), false, { effectiveDirectory: '/repo', referenceKind: 'href' }));
    expect(activeFilePath()).toBe(`/repo/${path}`);
    const title = host.querySelector('[role="tab"][aria-selected="true"]')?.textContent;
    expect(title).toContain('相机画幅图解.eficy');
    expect(title).not.toContain('%E7');
  });

  test('a custom file reference opens its tab before reading and keeps the read error inline', async () => {
    const failure = deferred<{ content: string }>();
    harness.files.readFile.mockReturnValue(failure.promise);
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    await act(async () => openFileReference('/repo/report.eficy', false, { effectiveDirectory: '/repo' }));
    expect(activeFilePath()).toBe('/repo/report.eficy');
    expect(host.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toContain('report.eficy');
    await act(async () => failure.reject(new Error('file read unavailable')));
    expect(activeFilePath()).toBe('/repo/report.eficy');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('file read unavailable');
  });

  test('native browser opacity follows tab visibility and clears on unmount', async () => {
    vi.stubGlobal('__YURI_ELECTRON__', true);
    await act(async () => {
      useUIStore.getState().openContextBrowser('/repo');
      reactRoot.render(<ContextPanel directory="/repo" />);
    });
    expect(document.documentElement.hasAttribute('data-yuri-native-browser-visible')).toBe(true);
    await act(async () => useUIStore.getState().closeContextPanel('/repo'));
    expect(document.documentElement.hasAttribute('data-yuri-native-browser-visible')).toBe(false);
    await act(async () => useUIStore.getState().openContextBrowser('/repo'));
    expect(document.documentElement.hasAttribute('data-yuri-native-browser-visible')).toBe(true);
    harness.files.readFile.mockResolvedValue({ content: 'file content' });
    await open('/repo/file.ts');
    expect(document.documentElement.hasAttribute('data-yuri-native-browser-visible')).toBe(false);
    await act(async () => useUIStore.getState().openContextBrowser('/repo'));
    expect(document.documentElement.hasAttribute('data-yuri-native-browser-visible')).toBe(true);
    await act(async () => reactRoot.render(<ContextPanel directory="/other" />));
    expect(document.documentElement.hasAttribute('data-yuri-native-browser-visible')).toBe(false);
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    expect(document.documentElement.hasAttribute('data-yuri-native-browser-visible')).toBe(true);
    await act(async () => reactRoot.render(null));
    expect(document.documentElement.hasAttribute('data-yuri-native-browser-visible')).toBe(false);
  });

  test('an iframe browser does not disable sidebar vibrancy', async () => {
    vi.stubGlobal('__YURI_ELECTRON__', false);
    await act(async () => {
      useUIStore.getState().openContextBrowser('/repo');
      reactRoot.render(<ContextPanel directory="/repo" />);
    });
    expect(document.documentElement.hasAttribute('data-yuri-native-browser-visible')).toBe(false);
  });

  test.each([
    ['/repo/.../B.ts', 'ENOENT: no such file or directory'],
    ['/repo/folder', 'EISDIR: illegal operation on a directory'],
    ['/outside/B.ts', 'EACCES: permission denied'],
    ['/outside/B.ts', 'Path is outside the workspace'],
    ['/repo/B.ts', 'Network request failed'],
  ])('binds the panel to failed %s and settles both pending intents (%s)', async (path, message) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    const failure = deferred<{ content: string }>();
    harness.files.readFile.mockImplementation((requested: string) => requested === '/repo/A.ts'
      ? Promise.resolve({ content: 'content-A' }) : failure.promise);
    await open('/repo/A.ts');
    // A is already open; focus is irrelevant to establishing the previous content.
    useUIStore.setState({ pendingFileFocusPath: null });
    await act(async () => reactRoot.render(<FilePanel />));
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-A');

    await open(path, true);
    expect(host.querySelector('[data-testid="editor"]')?.textContent).not.toBe('content-A');
    await act(async () => useUIStore.getState().setPendingFileFocusPath(path));
    // A failed read stays terminal even while unrelated UI updates continue.
    harness.files.readFile.mockImplementation((requested: string) => requested === '/repo/A.ts'
      ? Promise.resolve({ content: 'content-A' }) : new Promise(() => {}));
    await act(async () => failure.reject(new Error(message)));
    expect(useUIStore.getState().pendingFileFocusPath).toBeNull();
    expect(useUIStore.getState().pendingFileNavigation).toBeNull();
    expect(host.querySelector('h1')?.textContent).toBe(path);
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(message);
    expect(host.querySelector('[data-testid="editor"]')).toBeNull();
    const count = harness.files.readFile.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    for (let index = 0; index < 3; index += 1) {
      await act(async () => reactRoot.render(<FilePanel />));
    }
    expect(harness.files.readFile.mock.calls.length).toBe(count);
    expect(harness.files.readFile.mock.calls.filter(([requested]) => requested === path)).toHaveLength(1);
  });

  test('a late B failure preserves the newer C request and content', async () => {
    const b = deferred<{ content: string }>();
    const c = deferred<{ content: string }>();
    harness.files.readFile.mockImplementation((path: string) => path === '/repo/B.ts' ? b.promise : c.promise);
    await open('/repo/B.ts', true);
    await act(async () => reactRoot.render(<FilePanel />));
    await open('/repo/C.ts', true);
    await act(async () => useUIStore.getState().setPendingFileFocusPath('/repo/C.ts'));
    const navigation = useUIStore.getState().pendingFileNavigation;
    await act(async () => b.reject(new Error('ENOENT: no such file or directory')));
    expect(useUIStore.getState().pendingFileNavigation).toBe(navigation);
    expect(useUIStore.getState().pendingFileFocusPath).toBe('/repo/C.ts');
    await act(async () => c.resolve({ content: 'content-C' }));
    expect(host.querySelector('h1')?.textContent).toBe('/repo/C.ts');
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-C');
    expect(harness.files.readFile.mock.calls.filter(([path]) => path === '/repo/C.ts')).toHaveLength(1);
  });

  test.each([
    ['/repo/B.ts', 'ENOENT: no such file or directory'],
    ['/repo/folder', 'EISDIR: illegal operation on a directory'],
  ])('full view preserves fallback and directory expansion after %s fails', async (path, message) => {
    const failure = deferred<{ content: string }>();
    const previousPath = path.endsWith('folder') ? '/repo/folder/A.ts' : '/repo/A.ts';
    harness.files.readFile.mockImplementation((requested: string) => requested === previousPath
      ? Promise.resolve({ content: 'content-A' }) : failure.promise);
    useFilesViewTabsStore.getState().setSelectedPath('/repo', previousPath);
    await act(async () => reactRoot.render(<FilesView />));
    await open(path, true);
    await act(async () => useUIStore.getState().setPendingFileFocusPath(path));
    await act(async () => failure.reject(new Error(message)));
    expect(useUIStore.getState().pendingFileNavigation).toBeNull();
    expect(useUIStore.getState().pendingFileFocusPath).toBeNull();
    expect(useFilesViewTabsStore.getState().byRoot['/repo'].selectedPath).toBe(previousPath);
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-A');
    expect(harness.files.readFile.mock.calls.filter(([requested]) => requested === path)).toHaveLength(1);
    if (path.endsWith('folder')) {
      expect(useFilesViewTabsStore.getState().byRoot['/repo'].expandedPaths).toContain(path);
      expect(harness.files.listDirectory).toHaveBeenCalledWith(path);
    }
  });

  test.each(['focus', 'navigation'] as const)('a pending %s intent for another panel does not reload the bound file', async (intent) => {
    harness.files.readFile.mockResolvedValue({ content: 'content-A' });
    await open('/repo/A.ts');
    useUIStore.setState({ pendingFileFocusPath: null });
    await act(async () => reactRoot.render(<FilePanel />));
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-A');
    const count = harness.files.readFile.mock.calls.length;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', false);
    if (intent === 'focus') useUIStore.getState().setPendingFileFocusPath('/repo/other/B.md');
    else useUIStore.getState().setPendingFileNavigation({ path: '/repo/other/B.md', line: 3, column: 1 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    expect(harness.files.readFile.mock.calls.length).toBe(count);
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-A');
  });

  test('an allowed outside file still uses the existing read capability', async () => {
    harness.files.readFile.mockResolvedValue({ content: 'outside-content' });
    await open('/outside/C.ts');
    await act(async () => reactRoot.render(<FilePanel />));
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('outside-content');
    expect(harness.files.readFile).toHaveBeenCalledWith('/outside/C.ts', {
      allowOutsideWorkspace: true,
      outsideFileGrant: undefined,
      directory: '/repo',
    });
  });
});

async function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((entry) => entry.textContent === label || entry.getAttribute('aria-label') === label);
  expect(button, label).toBeTruthy();
  await act(async () => button!.click());
}

function activeFilePath() {
  const panel = useUIStore.getState().contextPanelByDirectory['/repo'];
  return panel?.tabs.find((tab) => tab.id === panel.activeTabId)?.targetPath;
}

describe('ContextPanel writable file navigation', () => {
  test.each([
    ['tab', false], ['reference', false], ['line-reference', false],
    ['tab', true], ['reference', true],
  ] as const)('keeps A draft until a decision for %s (autosave %s)', async (source, autoSave) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame', 'cancelAnimationFrame'] });
    window.localStorage.setItem('yuri:files:auto-save-enabled', String(autoSave));
    harness.files.readFile.mockImplementation(async (path: string) => ({ content: path === '/repo/A.ts' ? 'content-A' : 'content-B' }));
    useUIStore.getState().openContextFile('/repo', '/repo/B.ts');
    useUIStore.getState().openContextFile('/repo', '/repo/A.ts');
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    const editor = host.querySelector<HTMLTextAreaElement>('[data-testid="draft"]')!;
    expect(editor.readOnly).toBe(false);
    await act(async () => {
      editor.value = 'unsaved-A';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const requestB = async () => {
      await act(async () => {
        if (source === 'tab') {
          const tab = [...host.querySelectorAll<HTMLElement>('[role="tab"]')].find((entry) => entry.textContent?.includes('B.ts'));
          expect(tab).toBeTruthy();
          tab!.click();
        } else if (source === 'line-reference') {
          await openFileReference('/repo/B.ts:3', false, { effectiveDirectory: '/repo' });
        } else {
          await openFileReference('/repo/B.ts', false, { effectiveDirectory: '/repo' });
        }
      });
    };
    await requestB();
    expect(activeFilePath()).toBe('/repo/A.ts');
    expect(host.querySelector('[data-testid="draft"]')).toBe(editor);
    expect(editor.value).toBe('unsaved-A');
    expect(harness.files.writeFile).not.toHaveBeenCalled();
    expect(harness.files.readFile.mock.calls.filter(([path]) => path === '/repo/B.ts')).toHaveLength(0);
    await clickButton('filesView.dialog.cancel');
    expect(activeFilePath()).toBe('/repo/A.ts');
    expect(editor.value).toBe('unsaved-A');
    expect(useUIStore.getState().pendingFileFocusPath).toBeNull();
    expect(useUIStore.getState().pendingFileNavigation).toBeNull();
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    expect(document.querySelector('[role="dialog"][data-state="open"]')).toBeNull();
    await requestB();
    if (autoSave) {
      await act(async () => { await vi.advanceTimersByTimeAsync(1600); });
      expect(harness.files.writeFile).toHaveBeenCalledWith('/repo/A.ts', 'unsaved-A');
      await clickButton('filesView.unsaved.saveChanges');
    } else {
      const save = deferred<{ success: boolean }>();
      harness.files.writeFile.mockReturnValueOnce(save.promise);
      await clickButton('filesView.unsaved.saveChanges');
      expect(activeFilePath()).toBe('/repo/A.ts');
      expect(host.querySelector('[data-testid="draft"]')).toBe(editor);
      expect(editor.value).toBe('unsaved-A');
      expect(harness.files.readFile.mock.calls.filter(([path]) => path === '/repo/B.ts')).toHaveLength(0);
      await act(async () => save.resolve({ success: true }));
    }
    expect(harness.files.writeFile).toHaveBeenCalledWith('/repo/A.ts', 'unsaved-A');
    expect(activeFilePath()).toBe('/repo/B.ts');
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-B');
  });

  test('a failed save retains A and explicit discard then opens B', async () => {
    harness.files.readFile.mockImplementation(async (path: string) => ({ content: path === '/repo/A.ts' ? 'content-A' : 'content-B' }));
    harness.files.writeFile.mockResolvedValue({ success: false });
    useUIStore.getState().openContextFile('/repo', '/repo/A.ts');
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    const editor = host.querySelector<HTMLTextAreaElement>('[data-testid="draft"]')!;
    await act(async () => {
      editor.value = 'unsaved-A';
      editor.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => useUIStore.getState().openContextFile('/repo', '/repo/B.ts'));
    await clickButton('filesView.unsaved.saveChanges');
    expect(activeFilePath()).toBe('/repo/A.ts');
    expect(host.querySelector('[data-testid="draft"]')).toBe(editor);
    expect(editor.value).toBe('unsaved-A');
    expect(harness.files.readFile.mock.calls.filter(([path]) => path === '/repo/B.ts')).toHaveLength(0);
    await clickButton('filesView.unsaved.discard');
    expect(activeFilePath()).toBe('/repo/B.ts');
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('content-B');
    expect(harness.files.writeFile).toHaveBeenCalledTimes(1);
  });

  test('explicit retry recovers the same failed target after the file becomes readable', async () => {
    harness.files.readFile.mockRejectedValueOnce(new Error('ENOENT: file not found')).mockResolvedValue({ content: 'recovered-B' });
    useUIStore.getState().openContextFile('/repo', '/repo/B.ts');
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    expect(harness.files.readFile).toHaveBeenCalledTimes(1);
    await act(async () => reactRoot.render(<ContextPanel directory="/repo" />));
    expect(harness.files.readFile).toHaveBeenCalledTimes(1);
    await clickButton('contextPanel.preview.actions.retry');
    expect(harness.files.readFile).toHaveBeenCalledTimes(2);
    expect(activeFilePath()).toBe('/repo/B.ts');
    expect(host.querySelector('[data-testid="editor"]')?.textContent).toBe('recovered-B');
    expect(host.querySelector('[role="alert"]')).toBeNull();
  });
});
