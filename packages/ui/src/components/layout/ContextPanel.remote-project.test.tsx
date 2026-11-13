import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostRuntimeContext, type HostRuntimeContextValue } from '@/contexts/hostRuntimeContext';
import { locationKey } from '@/lib/remote-projects/location';
import { useUIStore } from '@/stores/useUIStore';
import { ContextPanel } from './ContextPanel';
import { previewProxyTargetCache } from '@/lib/preview/screenshot-capture';

const fixture = vi.hoisted(() => ({
  directory: '/workspace',
  fetch: vi.fn(), localFetch: vi.fn(), native: vi.fn(), localTranscript: vi.fn(),
  sessions: [{ id: 'same-session', title: 'Remote child', directory: '/workspace' }],
  t: (key: string) => key,
  query: vi.fn(),
  network: vi.fn(), local: true,
}));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => fixture.directory }));
vi.mock('@/hooks/useDesktopWindowControlsLayout', () => ({ useDesktopWindowControlsLayout: () => ({ usesFramelessChrome: false }) }));
vi.mock('@/components/desktop/WindowsWindowControls', () => ({ WindowsWindowControls: () => null }));
vi.mock('@/contexts/SelectedProjectHostBoundary', () => ({ SelectedProjectHostBoundary: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'dark' } }, themeMode: 'dark' }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.t }) }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: Object.assign(() => '/local', { getState: () => ({ currentDirectory: '/local' }) }) }));
vi.mock('@/stores/useSessionBtwStore', () => ({ useSessionBtwStore: Object.assign(() => null, { getState: () => ({ clear: vi.fn(), cancel: vi.fn() }) }) }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => fixture.localFetch(...args) }));
vi.mock('@/lib/desktopNative', () => ({ invokeDesktopCommand: (...args: unknown[]) => fixture.native(...args) }));
vi.mock('@/lib/runtime-auth', () => ({ refreshRuntimeUrlAuthToken: async () => 'short-lived-test' }));
vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ authenticatedAsset: (path: string) => `http://hub.test${path}` }) }));
vi.mock('@/lib/relay/runtime-tunnel', () => ({ isRelayModeActive: () => false }));
vi.mock('@/lib/preview/relay-preview-gateway-client', () => ({ hasDesktopPreviewGateway: () => false, ensurePreviewGatewayOrigin: vi.fn() }));
vi.mock('@/lib/preview/desktop-browser-network', () => ({ openDesktopBrowserNetwork: (...args: unknown[]) => fixture.network(...args) }));
vi.mock('@/lib/desktopLocalRuntime', () => ({ isLocalRuntimeActive: () => fixture.local }));
vi.mock('@/queries/remoteProjectQueries', () => ({ useRemoteHostSummaries: () => { fixture.query(); return { data: { directories: [{ directory: fixture.directory, sessions: fixture.sessions }] } }; } }));
vi.mock('@/sync/sync-context', () => ({
  useDirectoryStore: () => ({ subscribe: () => () => {}, getState: () => ({ session: [] }) }),
  setContextPanelViewedSession: vi.fn(), setExternallyViewedSession: vi.fn(),
}));
vi.mock('@/sync/notification-store', () => ({ markSessionViewed: vi.fn() }));
vi.mock('@/sync/session-ui-store', () => {
  const state = { currentSessionId: 'local-session', newSessionDraft: null };
  return { useSessionUIStore: Object.assign((selector: (state: unknown) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock('@/sync/input-store', () => ({ useInputStore: (selector: (state: unknown) => unknown) => selector({ addAttachedFile: vi.fn() }) }));
vi.mock('@/components/chat/RemoteChatContainer', () => ({ RemoteChatContainer: (props: { location: { hostId: string; directory: string }; sessionId: string; onNavigateSession: (id: string, directory: string) => void }) =>
  <button data-remote-session={props.sessionId} data-host={props.location.hostId} data-directory={props.location.directory} onClick={() => props.onNavigateSession('nested-session', props.location.directory)}>Remote transcript</button> }));
vi.mock('./ContextPanelSessionTranscript', () => ({ ContextPanelSessionTranscript: () => { fixture.localTranscript(); return null; } }));
vi.mock('@/components/views/FilesView', () => ({ FilesView: () => <div data-files /> }));
vi.mock('@/components/views/DiffView', () => ({ DiffView: (props: { directory: string }) => <div data-diff-directory={props.directory} /> }));
vi.mock('./RightSidebar', () => ({ RightSidebar: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('./RightSidebarTabs', () => ({ RightSidebarTabs: () => null, RightSidebarToolbar: () => null }));
vi.mock('./ContextSidebarTab', () => ({ ContextPanelContent: () => null }));
vi.mock('./BtwPanel', () => ({ BtwPanel: () => null }));
vi.mock('@/components/ui/YuriLogo', () => ({ YuriLogo: () => null }));
vi.mock('@/components/ui/sortable-tabs-strip', () => ({ SortableTabsStrip: (props: { items: { id: string; label: string }[]; onSelect: (id: string) => void }) => <nav>{props.items.map((item) => <button key={item.id} onClick={() => props.onSelect(item.id)}>{item.label}</button>)}</nav> }));

let root: Root;
let node: HTMLDivElement;
const host = (hostId: string): HostRuntimeContextValue => {
  const location = { hubId: 'hub://one', hostId, directory: fixture.directory };
  return { entry: { location, key: locationKey(location), connectionGeneration: 1, fetch: fixture.fetch, sdk: () => ({}) } } as unknown as HostRuntimeContextValue;
};
const render = async (scope: HostRuntimeContextValue) => {
  await act(async () => { root.render(<HostRuntimeContext.Provider value={scope}><ContextPanel /></HostRuntimeContext.Provider>); });
};
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Object.assign(window, { __YURI_ELECTRON__: true });
  const settings = (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM.settings;
  settings.disableIframePageLoading = true;
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.clearAllMocks();
  fixture.local = true;
  fixture.network.mockReset().mockImplementation(async (_signal, _failure, entry) => ({ partition: `yuri-browser-relay-${entry?.location.hostId ?? 'hub'}` }));
  previewProxyTargetCache.clear();
  fixture.fetch.mockImplementation(async (path: string) => path === '/api/preview/targets'
    ? Response.json({ proxyBasePath: '/api/preview/proxy/0123456789abcdef', previewToken: 'preview-test', expiresAt: Date.now() + 60_000 })
    : new Response('', { status: 200 }));
  useUIStore.setState({ contextPanelByDirectory: {}, contextToolDiffByDirectory: {}, isRightSidebarOpen: false });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); delete window.__YURI_ELECTRON__; });

it('mounts the real remote preview using Host registration/probe and never a bare localhost iframe', async () => {
  const scope = host('host-a');
  useUIStore.getState().openContextPreview(scope.entry.key, 'http://localhost:3000/path');
  await render(scope);
  expect(fixture.fetch).toHaveBeenCalledWith('/api/preview/targets', expect.objectContaining({ method: 'POST' }));
  expect(fixture.fetch.mock.calls.some(([path]) => String(path).startsWith('/api/preview/proxy/'))).toBe(true);
  const frame = node.querySelector('iframe');
  expect(frame?.src).toContain('/api/hosts/host-a/api/preview/proxy/0123456789abcdef/path');
  expect(fixture.localFetch).not.toHaveBeenCalled();
  expect(fixture.native).not.toHaveBeenCalled();
});

it('also attributes non-loopback remote preview origins to the selected Host rather than the client network', async () => {
  const scope = host('host-a');
  useUIStore.getState().openContextPreview(scope.entry.key, 'http://internal.example:3000/path');
  await render(scope);
  const registration = fixture.fetch.mock.calls.find(([path]) => path === '/api/preview/targets');
  expect(JSON.parse(registration?.[1].body)).toEqual({ url: 'http://internal.example:3000/path', allowExternal: true });
  expect(node.querySelector('iframe')?.src).toContain('/api/hosts/host-a/api/preview/proxy/');
  expect(node.querySelector('iframe')?.src).not.toContain('internal.example');
  expect(fixture.localFetch).not.toHaveBeenCalled();
});

it('gates the Remote Project webview on its network and retries without falling back to client localhost', async () => {
  const scope = host('host-b');
  fixture.network.mockRejectedValue(new Error('host offline'));
  useUIStore.getState().openContextBrowser(scope.entry.key, 'http://localhost:3000');
  await render(scope);
  expect(node.querySelector('webview')).toBeNull();
  expect(node.querySelector('iframe')).toBeNull();
  expect(fixture.network).toHaveBeenCalledWith(expect.any(AbortSignal), expect.any(Function), scope.entry);
  expect(fixture.localFetch).not.toHaveBeenCalled();
  fixture.network.mockResolvedValue({ partition: 'yuri-browser-relay-recovered' });
  const retry = [...node.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'contextPanel.preview.actions.retry')!;
  await act(async () => retry.click());
  expect(node.querySelector('webview')?.getAttribute('partition')).toBe('yuri-browser-relay-recovered');
  expect(node.querySelector('webview')?.getAttribute('src')).toBe('http://localhost:3000/');
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(fixture.localFetch).not.toHaveBeenCalled();
});

it('Web uses the client network even for a Remote Project and never registers a proxy target', async () => {
  delete window.__YURI_ELECTRON__;
  const scope = host('host-a');
  useUIStore.getState().openContextBrowser(scope.entry.key, 'http://localhost:5180/');
  await render(scope);
  expect(node.querySelector('iframe')?.src).toBe('http://localhost:5180/');
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(fixture.localFetch).not.toHaveBeenCalled();
  expect(fixture.network).not.toHaveBeenCalled();
});

it('routes the actual child session surface by raw Host location and isolates same-path panel selection', async () => {
  const a = host('host-a'), b = host('host-b');
  useUIStore.getState().openContextPanelTab(a.entry.key, { mode: 'chat', dedupeKey: 'session:same-session', readOnly: true });
  useUIStore.getState().openContextPanelTab(b.entry.key, { mode: 'file-diff', targetPath: '/workspace/b.ts' });
  await render(a);
  const child = node.querySelector<HTMLButtonElement>('[data-remote-session]')!;
  expect(child.dataset.directory).toBe('/workspace');
  expect(child.dataset.host).toBe('host-a');
  await act(async () => child.click());
  expect(node.querySelector('[data-remote-session="nested-session"]')).not.toBeNull();
  const back = node.querySelector<HTMLButtonElement>('[aria-label="chat.container.returnToParent.aria"]')!;
  await act(async () => back.click());
  expect(node.querySelector('[data-remote-session="same-session"]')).not.toBeNull();
  await render(b);
  expect(node.querySelector('[data-diff-directory]')?.getAttribute('data-diff-directory')).toBe('/workspace');
  expect(node.querySelector('[data-remote-session]')).toBeNull();
  expect(fixture.localTranscript).not.toHaveBeenCalled();
});

it('retains the isolated browser across 50 unrelated renders and changes network owner with Remote Project', async () => {
  const scope = host('host-a');
  useUIStore.getState().openContextBrowser(scope.entry.key, 'http://localhost:3000/a');
  await render(scope);
  const webview = node.querySelector('webview');
  expect(webview?.getAttribute('partition')).toBe('yuri-browser-relay-host-a');
  for (let i = 0; i < 50; i++) await render(scope);
  expect(fixture.network).toHaveBeenCalledOnce();
  expect(node.querySelector('webview')).toBe(webview);
  expect(node.querySelector('input')).not.toBeNull();
  expect(fixture.native).not.toHaveBeenCalled();
  const other = host('host-b');
  useUIStore.getState().openContextBrowser(other.entry.key, 'http://localhost:3000/a');
  await render(other);
  expect(fixture.network.mock.calls[0][0].aborted).toBe(true);
  expect(node.querySelector('webview')?.getAttribute('partition')).toBe('yuri-browser-relay-host-b');
});

it.each([true, false])('Electron session on local=%s selects direct versus current-Hub networking', async local => {
  fixture.local = local;
  const location = { hubId: 'hub://one', directory: fixture.directory };
  const scope = { entry: { location, key: locationKey(location), connectionGeneration: 0, sdk: () => ({}) } } as unknown as HostRuntimeContextValue;
  useUIStore.getState().openContextBrowser(scope.entry.key, 'http://localhost:5180/');
  await render(scope);
  expect(node.querySelector('webview')?.getAttribute('partition')).toBe(local ? 'persist:yuri-browser' : 'yuri-browser-relay-hub');
  expect(fixture.network).toHaveBeenCalledTimes(local ? 0 : 1);
  expect(fixture.localFetch).not.toHaveBeenCalled();
});

it('does not commit an old Host registration after switching the same-path panel', async () => {
  const a = host('host-a'), b = host('host-b');
  let finish!: (response: Response) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
  useUIStore.getState().openContextPreview(a.entry.key, 'http://localhost:3000/a');
  useUIStore.getState().openContextPreview(b.entry.key, 'http://localhost:3000/b');
  await render(a);
  await render(b);
  await act(async () => finish(Response.json({ proxyBasePath: '/api/preview/proxy/aaaaaaaaaaaaaaaa', previewToken: 'old-preview', expiresAt: Date.now() + 60_000 })));
  const src = node.querySelector('iframe')?.src;
  expect(src).toContain('/api/hosts/host-b/api/preview/proxy/');
  expect(src).not.toContain('old-preview');
  expect(fixture.localFetch).not.toHaveBeenCalled();
});

it('adds no remote summary Query or preview requests when mounting a local file-only panel', async () => {
  useUIStore.getState().openContextPanelTab('/workspace', { mode: 'file', targetPath: '/workspace/a.ts' });
  await act(async () => root.render(<ContextPanel />));
  expect(node.querySelector('[data-files]')).not.toBeNull();
  expect(fixture.query).not.toHaveBeenCalled();
  expect(fixture.fetch).not.toHaveBeenCalled();
  expect(fixture.localFetch).not.toHaveBeenCalled();
});
