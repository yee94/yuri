import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Header } from './Header';
import { TitlebarLeftControls } from './TitlebarLeftControls';
import { useUIStore } from '@/stores/useUIStore';
import { locationKey } from '@/lib/remote-projects/location';
import { queryClient } from '@/lib/queryRuntime';
import { SessionSwitcherDropdown } from '@/components/session/SessionSwitcherDropdown';
import { toast } from '@/components/ui';
import { useRemoteOperationError } from '@/lib/remote-projects/operation-errors';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';

const fixture = vi.hoisted(() => ({
  project: { id: 'remote-project', hostId: 'remote-host', hubId: 'https://hub.example', path: '/workspace', label: 'Project', remoteProjectId: 'host-project', remoteState: 'ok' },
  remote: { projectId: 'remote-project', sessionId: 'same-session', location: { hubId: 'https://hub.example', hostId: 'remote-host', directory: '/workspace' } },
  t: (key: string) => key, noop: () => {}, localRead: vi.fn(),
  isRemote: true, mobile: false, discovery: vi.fn(),
  registry: undefined as unknown,
  transcript: null as null | { messageOrder: string[]; messagesByID: Record<string, unknown>; partsByMessageID: Record<string, unknown[]> },
  modelScope: vi.fn(),
  localSwitcher: vi.fn(), remoteNavigate: vi.fn(), activeProject: vi.fn(), runProps: vi.fn(),
  localNew: vi.fn(), localSelect: vi.fn(), localItems: [] as unknown[],
  branchRead: vi.fn(),
  online: true, summaryError: null as Error | null,
  catalogError: null as Error | null, catalogRefresh: vi.fn(), summaryRefresh: vi.fn(),
  catalogHub: 'https://hub.example',
  catalogAvailable: true, summaryEmpty: false, boundHost: null as null | { registry: unknown },
  extraProjects: [] as unknown[], extraDirectories: [] as unknown[],
  topology: { projectDirectories: {} as Record<string, string[]>, staleProjectDirectories: [] as string[] },
  quota: { results: [], dropdownProviderIds: [], selectedModels: {}, expandedFamilies: {}, loadSettings: () => {}, fetchAllQuotas: async () => {}, setDisplayMode: () => {}, toggleFamilyExpanded: () => {} },
}));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: Object.assign((select: (state: unknown) => unknown) => select({ activeProjectId: fixture.project.id, projects: [fixture.isRemote ? fixture.project : { ...fixture.project, hostId: undefined }, ...fixture.extraProjects] }), { getState: () => ({ setActiveProjectIdOnly: fixture.activeProject }) }) }));
vi.mock('@/stores/useSessionNavigationStore', () => ({ useSessionNavigationStore: Object.assign((select: (state: unknown) => unknown) => select({ remoteSession: fixture.remote }), { getState: () => ({ openRemoteSession: fixture.remoteNavigate }) }) }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => fixture.project.path, useEffectiveLocationKey: () => 'yuri-remote-location:' + JSON.stringify([fixture.project.hubId, fixture.project.hostId, fixture.project.path]) }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (state: unknown) => unknown) => select({ currentSessionId: 'same-session', newSessionDraft: null, openNewSessionDraft: fixture.localNew, setCurrentSession: fixture.localSelect, worktreeMetadata: new Map([['same-session', { path: '/local-worktree' }]]) }) }));
vi.mock('@/sync/sync-context', () => ({
  useCurrentSessionEntity: (id: string | null) => { fixture.localRead(id); return { id, title: 'LOCAL SECRET TITLE', directory: '/local' }; },
  useSessionContextUsage: () => null, useSessionMessagesResolved: () => true,
  useGlobalSessionStatus: () => ({ type: 'idle' }),
}));
vi.mock('@/sync/notification-store', () => ({ useSessionUnseenCount: () => 0 }));
vi.mock('@/queries/remoteProjectQueries', () => ({
  useRemoteProjectRuntime: () => { fixture.discovery(); return { registry: fixture.registry, error: fixture.catalogError, catalog: fixture.catalogAvailable ? { hubId: fixture.catalogHub, projects: [fixture.project, ...fixture.extraProjects], hosts: [{ id: fixture.project.hostId, name: 'Build machine' }] } : undefined }; },
  ensureRemoteHostCatalog: fixture.catalogRefresh,
  useRemoteHostSummaries: () => ({ error: fixture.summaryError, refetch: fixture.summaryRefresh, data: { hubId: fixture.catalogHub, hostId: fixture.project.hostId, stale: !fixture.online, worktrees: fixture.topology, pinnedSessionIds: [], unread: { sessions: { 'same-session': { unreadCount: 2 } } }, directories: fixture.summaryEmpty ? [] : [{ directory: '/workspace', sessions: [{ id: 'same-session', directory: '/workspace', title: 'REMOTE TITLE', hasChildren: true, time: { created: 1, updated: 2 }, metadata: { yuri: { sessionStatus: { type: 'busy' } } } }, { id: 'other', directory: '/workspace', title: 'OTHER REMOTE', time: { created: 1, updated: 1 } }] }, ...fixture.extraDirectories] } }),
}));
vi.mock('@/contexts/HostRuntimeProvider', () => ({ useHostRuntime: () => fixture.boundHost, useRemoteHost: () => ({ state: fixture.online ? 'connected' : 'offline' }) }));
vi.mock('@/components/session/sidebar/hooks/useSwitcherItems', () => ({ useSwitcherItems: () => { fixture.localSwitcher(); return fixture.localItems; } }));
vi.mock('@/queries/gitBranchQueries', () => ({ gitBranchesQueryOptions: (_directory: string, _git: unknown, _transport: unknown, _storage: unknown, entry: { key: string }) => ({ queryKey: ['switcher-branch', entry.key], queryFn: () => { fixture.branchRead(); throw new Error('Switcher must only read the existing scoped branch cache'); } }) }));
vi.mock('@/sync/transcript-repository-runtime', () => ({
  subscribeTranscriptRepositoryBinding: () => () => {}, getTranscriptRepositoryBindingRevision: () => 0,
  getTranscriptRepository: () => fixture.transcript ? { subscribe: () => () => {}, getTranscript: () => fixture.transcript } : null,
  transcriptScope: (location: unknown, sessionID: string) => ({ location, sessionID }),
}));
vi.mock('@/queries/configCatalogQueries', () => ({ providerCatalogQueryOptions: (directory: string, _transport: string, entry: unknown) => {
  fixture.modelScope(directory, entry);
  return { queryKey: ['remote-header-models'], staleTime: Infinity, queryFn: async () => ({ providers: [{ id: 'remote-provider', models: { remoteModel: { limit: { context: 1000, output: 100 } } } }] }) };
} }));
vi.mock('@/components/ui/ContextUsageDisplay', () => ({ ContextUsageDisplay: (props: { totalTokens: number; onClick: () => void }) => <button data-context-tokens={props.totalTokens} onClick={props.onClick}>Usage</button> }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: (select: (state: unknown) => unknown) => select({ getCurrentModel: () => null }) }));
vi.mock('@/stores/useQuotaStore', () => ({ useQuotaStore: (select: (state: unknown) => unknown) => select(fixture.quota), useQuotaAutoRefresh: () => {} }));
vi.mock('@/stores/useGitHubAuthStore', () => ({ useGitHubAuthStore: (select: (state: unknown) => unknown) => select({ setStatus: fixture.noop }) }));
vi.mock('@/queries/githubAuthQueries', () => ({ useGitHubAuthQuery: () => ({ data: null }) }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({}) }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: fixture.mobile }), useTabletStandalonePwaRuntime: () => false }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.t }) }));
vi.mock('@/hooks/useDesktopWindowControlsLayout', () => ({ useDesktopWindowControlsLayout: () => ({ usesFramelessChrome: false }) }));
vi.mock('@/hooks/useDesktopWindowFullscreen', () => ({ useDesktopWindowFullscreen: () => false }));
vi.mock('@/lib/desktop', () => ({ isDesktopShell: () => true, isVSCodeRuntime: () => false, isWebRuntime: () => false, canUseElectronDesktopIPC: () => true, getElectronPlatform: () => 'darwin', isDesktopLocalOriginActive: () => true, invokeDesktop: vi.fn(), startDesktopWindowDrag: vi.fn() }));
vi.mock('@/components/gui-plugins/GuiPluginTitlebarItems', () => ({ GuiPluginTitlebarItems: () => null }));
vi.mock('@/components/chat/work-status/WorkStatusToggle', () => ({ WorkStatusToggle: () => <div data-local-work-status /> }));
vi.mock('@/components/desktop/WindowsWindowControls', () => ({ WindowsWindowControls: () => null }));
vi.mock('@/components/desktop/DesktopHostSwitcher', () => ({ DesktopHostSwitcherDialog: () => null }));
vi.mock('@/components/desktop/DesktopCurrentHostButton', () => ({ DesktopCurrentHostButton: () => null }));
vi.mock('@/components/desktop/OpenInAppButton', () => ({ OpenInAppButton: () => <div data-local-editor /> }));
vi.mock('@/components/layout/ProjectActionsButton', () => ({ ProjectActionsButton: (props: unknown) => { fixture.runProps(props); return null; } }));
vi.mock('@/components/mcp/McpDropdown', () => ({ McpDropdownContent: () => null }));
vi.mock('@/components/update/HostVersionUpdate', () => ({ ConnectedHostVersionUpdate: () => null }));
vi.mock('./GlobalSearchButton', () => ({ GlobalSearchButton: () => null }));
vi.mock('./SidebarBrandMark', () => ({ SidebarBrandMark: () => null }));
vi.mock('@/stores/useSidebarBrandStore', () => ({ useSidebarBrandStore: (select: (state: unknown) => unknown) => select({ sidebarBrandName: '' }) }));

let root: Root, node: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  vi.clearAllMocks();
  vi.spyOn(toast, 'error').mockImplementation(() => 'switcher-error');
  fixture.isRemote = true; fixture.mobile = false;
  fixture.registry = undefined; fixture.transcript = null;
  fixture.online = true; fixture.summaryError = null;
  fixture.catalogError = null;
  fixture.localItems = [];
  fixture.remote.location.directory = '/workspace';
  fixture.remote.location.hostId = 'remote-host';
  fixture.project.hostId = 'remote-host';
  fixture.project.path = '/workspace';
  fixture.catalogHub = fixture.project.hubId;
  fixture.catalogAvailable = true; fixture.summaryEmpty = false; fixture.boundHost = null;
  fixture.extraProjects = []; fixture.extraDirectories = [];
  fixture.topology = { projectDirectories: {}, staleProjectDirectories: [] };
  queryClient.clear();
  useUIStore.setState({ contextPanelByDirectory: {}, contextToolDiffByDirectory: {}, isRightSidebarOpen: false, activeMainTab: 'chat', isSessionDropdownOpen: false });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});

it('shows the same Host identity in the real mobile Header', async () => {
  fixture.mobile = true;
  await act(async () => root.render(<Header />));
  expect(node.textContent).toContain('Build machine');
  expect(node.textContent).not.toContain('LOCAL SECRET TITLE');
  expect(fixture.localRead).toHaveBeenCalledWith(null);
});

it.each([false, true])('keeps operational errors next to the real Header machine name without opening the session switcher (mobile=%s)', async (mobile) => {
  fixture.mobile = mobile;
  const location = { ...fixture.remote.location };
  const entry = { location, key: locationKey(location), queryScope: ['header-errors', mobile], sdk: vi.fn() };
  const registry = { hubId: location.hubId, resolve: () => entry } as unknown as HostRuntimeRegistry;
  fixture.registry = registry;
  const retry = vi.fn();
  function FailureOwner({ message }: { message: string | null }) {
    useRemoteOperationError(registry, location.hostId, message, retry);
    return null;
  }
  const render = (message: string | null) => <><FailureOwner message={message} /><Header /></>;
  await act(async () => root.render(render('Remote draft storage unavailable')));
  const trigger = node.querySelector<HTMLElement>('[data-remote-host-error]');
  expect(trigger).not.toBeNull();
  expect(node.textContent).toContain('Build machine');
  expect(node.textContent).not.toContain('Remote draft storage unavailable');
  expect(trigger!.closest('[aria-label="sessions.switcher.openAria"]')).toBeNull();
  expect(trigger!.closest('[data-remote-header-host]')?.textContent).toBe('Build machine');
  expect(trigger!.previousElementSibling?.textContent).toBe('Build machine');
  await act(async () => trigger!.click());
  expect(document.querySelector('[data-remote-host-error-popup]')?.textContent).toContain('Remote draft storage unavailable');
  expect(useUIStore.getState().isSessionDropdownOpen).toBe(false);
  await act(async () => document.querySelector<HTMLButtonElement>('[data-remote-host-error-popup] button')!.click());
  expect(retry).toHaveBeenCalledOnce();
  await act(async () => root.render(render(null)));
  expect(node.querySelector('[data-remote-host-error]')).toBeNull();
});

it('does not mount Remote Header discovery for a local project across 50 unrelated parent renders', async () => {
  fixture.isRemote = false;
  for (let i = 0; i < 50; i++) await act(async () => root.render(<Header />));
  expect(fixture.discovery).not.toHaveBeenCalled();
  expect(node.textContent).not.toContain('Build machine');
  expect(node.querySelector('[data-local-editor]')).not.toBeNull();
});

it('updates the real deep-link Header from authoritative metadata with empty summaries and no catalog, then does zero metadata work across 50 parent updates', async () => {
  fixture.summaryEmpty = true; fixture.catalogAvailable = false;
  const location = { ...fixture.remote.location, directory: '/external/deep-link raw' };
  fixture.remote.location.directory = location.directory;
  const sdk = vi.fn(() => { throw new Error('Header must not fetch metadata or content'); });
  const entry = { location, key: locationKey(location), queryScope: ['metadata', location.hubId, location.hostId, locationKey(location), 1], sdk };
  fixture.boundHost = { registry: { hubId: location.hubId, resolve: () => entry } };
  const key = [...entry.queryScope, 'chat', 'same-session', 'session'];
  const build = vi.spyOn(queryClient.getQueryCache(), 'build');
  const buildCount = () => build.mock.calls.filter((call) => JSON.stringify(call[1].queryKey) === JSON.stringify(key)).length;
  let reads = 0;
  const metadata = { id: 'same-session', location: { directory: location.directory }, get title() { reads++; return 'AUTHORITATIVE DEEP LINK'; } };
  const ownerRead = vi.fn(async () => metadata);
  await act(async () => root.render(<Header />));
  expect(node.textContent).toContain('Untitled Session');
  await act(async () => { await queryClient.fetchQuery({ queryKey: key, queryFn: ownerRead }); });
  await act(async () => { await vi.waitFor(() => expect(node.textContent).toContain('AUTHORITATIVE DEEP LINK')); });
  expect(node.textContent).not.toContain('LOCAL SECRET TITLE');
  const before = { reads, builds: buildCount() };
  for (let index = 0; index < 50; index++) await act(async () => root.render(<Header />));
  expect(reads).toBe(before.reads);
  expect(buildCount()).toBe(before.builds);
  expect(ownerRead).toHaveBeenCalledOnce();
  expect(sdk).not.toHaveBeenCalled();
  expect(fixture.localRead.mock.calls.every(([id]) => id === null)).toBe(true);
  build.mockRestore();
});

it('keeps summary continuity until metadata arrives and retains the authoritative title after a failed refresh', async () => {
  const location = { ...fixture.remote.location };
  const entry = { location, key: locationKey(location), queryScope: ['metadata-continuity', locationKey(location), 1], sdk: vi.fn() };
  fixture.registry = { hubId: location.hubId, resolve: () => entry };
  const key = [...entry.queryScope, 'chat', 'same-session', 'session'];
  await act(async () => root.render(<Header />));
  expect(node.textContent).toContain('REMOTE TITLE');
  await act(async () => { await queryClient.fetchQuery({ queryKey: key, queryFn: async () => ({ id: 'same-session', location: { directory: location.directory }, title: 'LIVE METADATA TITLE' }) }); });
  await act(async () => { await vi.waitFor(() => expect(node.textContent).toContain('LIVE METADATA TITLE')); });
  expect(node.textContent).not.toContain('REMOTE TITLE');
  await act(async () => { await expect(queryClient.fetchQuery({ queryKey: key, staleTime: 0, retry: false, queryFn: async () => { throw new Error('metadata refresh offline'); } })).rejects.toThrow('metadata refresh offline'); });
  expect(node.textContent).toContain('LIVE METADATA TITLE');
  expect(entry.sdk).not.toHaveBeenCalled();
});

it('isolates metadata titles for the same raw session ID across Hosts and ignores old-Host cache updates', async () => {
  fixture.summaryEmpty = true;
  const makeEntry = (hostId: string) => {
    const location = { ...fixture.remote.location, hostId };
    return { location, key: locationKey(location), queryScope: ['metadata-host', location.hubId, hostId, locationKey(location), 1], sdk: vi.fn() };
  };
  const first = makeEntry('remote-host'), second = makeEntry('other-host');
  const firstKey = [...first.queryScope, 'chat', 'same-session', 'session'];
  const secondKey = [...second.queryScope, 'chat', 'same-session', 'session'];
  fixture.registry = { hubId: fixture.project.hubId, resolve: (location: { hostId: string }) => location.hostId === 'remote-host' ? first : second };
  queryClient.setQueryData(firstKey, { id: 'same-session', location: first.location, title: 'FIRST HOST TITLE' });
  await act(async () => root.render(<Header />));
  expect(node.textContent).toContain('FIRST HOST TITLE');
  fixture.project.hostId = 'other-host'; fixture.remote.location.hostId = 'other-host';
  await act(async () => root.render(<Header />));
  expect(node.textContent).not.toContain('FIRST HOST TITLE');
  expect(node.textContent).toContain('Untitled Session');
  await act(async () => { queryClient.setQueryData(firstKey, { id: 'same-session', location: first.location, title: 'LATE FIRST HOST TITLE' }); });
  expect(node.textContent).not.toContain('LATE FIRST HOST TITLE');
  await act(async () => { await queryClient.fetchQuery({ queryKey: secondKey, queryFn: async () => ({ id: 'same-session', location: second.location, title: 'SECOND HOST TITLE' }) }); });
  await act(async () => { await vi.waitFor(() => expect(node.textContent).toContain('SECOND HOST TITLE')); });
  expect(first.sdk).not.toHaveBeenCalled(); expect(second.sdk).not.toHaveBeenCalled();
  expect(fixture.localRead.mock.calls.every(([id]) => id === null)).toBe(true);
});

it('keeps the real context usage action from an already-bound remote transcript without reading local usage', async () => {
  const location = fixture.remote.location;
  const entry = { location, key: locationKey(location), queryScope: ['remote'], sdk: () => ({}) };
  fixture.registry = { resolve: () => entry };
  let recordReads = 0;
  const messages: Record<string, unknown> = { message: { id: 'message', role: 'assistant', providerID: 'remote-provider', modelID: 'remoteModel', tokens: { input: 120, output: 30 } } };
  const records = new Proxy(messages, { get(target, key) { recordReads++; return typeof key === 'string' ? target[key] : undefined; } });
  fixture.transcript = { messageOrder: [...Array.from({ length: 10_000 }, (_, index) => `older-${index}`), 'message'], messagesByID: records, partsByMessageID: { message: [] } };
  queryClient.setQueryData(['remote-header-models'], { providers: [{ id: 'remote-provider', models: { remoteModel: { limit: { context: 1000, output: 100 } } } }] });
  await act(async () => root.render(<Header />));
  const usage = node.querySelector<HTMLButtonElement>('[data-context-tokens="150"]')!;
  expect(usage).not.toBeNull();
  expect(fixture.modelScope).toHaveBeenCalledWith('/workspace', entry);
  expect(fixture.modelScope).toHaveBeenCalledTimes(1);
  const calls = fixture.modelScope.mock.calls.length;
  expect(recordReads).toBeLessThan(10);
  const reads = recordReads;
  for (let i = 0; i < 50; i++) await act(async () => root.render(<Header />));
  expect(fixture.modelScope).toHaveBeenCalledTimes(calls);
  expect(recordReads).toBe(reads);
  await act(async () => usage.click());
  expect(useUIStore.getState().contextPanelByDirectory[locationKey(location)]?.tabs[0].mode).toBe('context');
  expect(fixture.localRead).toHaveBeenCalledWith(null);
});

it.each(['default', 'compact'] as const)('uses the real Header switcher and %s tree for scoped select/New, status and recursive children', async (variant) => {
  const list = vi.fn(async ({ parentID }: { parentID: string }) => ({ data: [{ id: parentID === 'same-session' ? 'child' : 'grandchild', parentID, title: parentID === 'same-session' ? 'REMOTE CHILD' : 'REMOTE GRANDCHILD', time: { created: 1, updated: 1 } }] }));
  const entry = { location: fixture.remote.location, key: locationKey(fixture.remote.location), queryScope: ['switcher', variant], sdk: () => ({ session: { list } }) };
  fixture.registry = { hubId: fixture.project.hubId, resolve: () => entry, assertCurrent: fixture.noop, subscribeEvents: () => fixture.noop };
  queryClient.setQueryData(['switcher-branch', entry.key], { current: 'remote-branch' });
  await act(async () => root.render(variant === 'default' ? <Header /> : <SessionSwitcherDropdown variant={variant} scopeProjectId={fixture.project.id}><button>Compact</button></SessionSwitcherDropdown>));
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  expect(fixture.localSwitcher).not.toHaveBeenCalled();
  expect(document.body.textContent).not.toContain('LOCAL SECRET TITLE');
  if (variant === 'default') expect(document.body.textContent).toContain('remote-branch');
  expect(document.querySelector('[aria-label="sessions.sidebar.session.status.active"]')).not.toBeNull();
  expect(list).not.toHaveBeenCalled();
  const expand = () => document.querySelector<HTMLElement>('[data-switcher-expand]')!;
  await act(async () => { expand().click(); await new Promise<void>((resolve) => queueMicrotask(resolve)); });
  await act(async () => { await vi.waitFor(() => expect(document.body.textContent).toContain('REMOTE CHILD')); });
  expect(list).toHaveBeenCalledWith({ directory: '/workspace', parentID: 'same-session', limit: 30 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  const childExpand = document.querySelectorAll<HTMLElement>('[data-switcher-expand]')[1];
  await act(async () => childExpand.click());
  await act(async () => { await vi.waitFor(() => expect(document.body.textContent).toContain('REMOTE GRANDCHILD')); });
  const child = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="session-switcher-item"]')).find((row) => row.textContent?.includes('REMOTE GRANDCHILD'))!;
  await act(async () => child.click());
  expect(fixture.remoteNavigate).toHaveBeenLastCalledWith(fixture.project, fixture.remote.location, 'grandchild', undefined);
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  const newAction = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((row) => row.textContent?.includes('sessions.sidebar.header.actions.newSession'))!;
  await act(async () => newAction.click());
  expect(fixture.remoteNavigate).toHaveBeenLastCalledWith(fixture.project, fixture.remote.location, null, undefined);
  expect(fixture.localSwitcher).not.toHaveBeenCalled();
  expect(fixture.localNew).not.toHaveBeenCalled();
  expect(fixture.localSelect).not.toHaveBeenCalled();
  expect(fixture.branchRead).not.toHaveBeenCalled();
});

it('preserves local switcher selection and New without mounting remote discovery', async () => {
  fixture.isRemote = false;
  fixture.localItems = [{ node: { session: { id: 'local-other', title: 'LOCAL ROW', directory: '/workspace', time: { created: 1, updated: 1 } }, children: [], worktree: null }, projectId: fixture.project.id, groupDirectory: '/workspace', secondaryMeta: null }];
  await act(async () => root.render(<SessionSwitcherDropdown><button>Local</button></SessionSwitcherDropdown>));
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  await act(async () => document.querySelector<HTMLElement>('[data-slot="session-switcher-item"]')!.click());
  expect(fixture.localSelect).toHaveBeenCalledWith('local-other', '/workspace');
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  const newAction = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((row) => row.textContent?.includes('sessions.sidebar.header.actions.newSession'))!;
  await act(async () => newAction.click());
  expect(fixture.localNew).toHaveBeenCalledOnce();
  expect(fixture.discovery).not.toHaveBeenCalled();
  expect(fixture.remoteNavigate).not.toHaveBeenCalled();
});

it('retains cached remote rows and unread state on failed offline refresh without reviving busy state', async () => {
  fixture.online = false; fixture.summaryError = new Error('Host refresh failed');
  const entry = { location: fixture.remote.location, key: locationKey(fixture.remote.location), queryScope: ['offline'], sdk: vi.fn() };
  fixture.registry = { hubId: fixture.project.hubId, resolve: () => entry, assertCurrent: fixture.noop };
  await act(async () => root.render(<Header />));
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  expect(document.body.textContent).toContain('OTHER REMOTE');
  expect(document.body.textContent).not.toContain('Host refresh failed');
  expect(toast.error).toHaveBeenCalledWith('Host refresh failed', expect.objectContaining({ action: expect.objectContaining({ label: 'remoteProjects.retry' }) }));
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[aria-label="sessions.sidebar.session.status.unread"]')).not.toBeNull();
  expect(document.querySelector('[aria-label="sessions.sidebar.session.status.active"]')).toBeNull();
  expect(entry.sdk).not.toHaveBeenCalled();
  expect(fixture.localSwitcher).not.toHaveBeenCalled();
});

it('catalog and navigation failures never insert error rows into the real switcher', async () => {
  fixture.catalogAvailable = false; fixture.catalogError = new Error('Catalog failed');
  await act(async () => root.render(<SessionSwitcherDropdown><button>Remote</button></SessionSwitcherDropdown>));
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  expect(toast.error).toHaveBeenCalledWith('Catalog failed', expect.anything());
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Catalog failed');
  await act(async () => [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'remoteProjects.retry')!.click());
  expect(fixture.catalogRefresh).toHaveBeenCalledOnce();
  fixture.catalogAvailable = true; fixture.catalogError = null;
  fixture.registry = { hubId: fixture.project.hubId, resolve: () => ({ location: fixture.remote.location, key: locationKey(fixture.remote.location), queryScope: ['navigate'], sdk: vi.fn() }), assertCurrent: fixture.noop };
  fixture.remoteNavigate.mockImplementationOnce(() => { throw new Error('Navigation failed'); });
  await act(async () => root.render(<SessionSwitcherDropdown><button>Remote</button></SessionSwitcherDropdown>));
  await act(async () => document.querySelector<HTMLElement>('[data-slot="session-switcher-item"]')!.click());
  expect(toast.error).toHaveBeenCalledWith('Navigation failed');
  expect(document.body.textContent).not.toContain('Navigation failed');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(fixture.localSelect).not.toHaveBeenCalled();
});

it('passes explicit Hub/Host project identity to the mobile Run button without hiding it', async () => {
  fixture.mobile = true;
  await act(async () => root.render(<Header />));
  expect(fixture.runProps).toHaveBeenCalledWith(expect.objectContaining({ projectRef: expect.objectContaining({ id: fixture.project.id, path: fixture.project.path, hostId: fixture.project.hostId, hubId: fixture.project.hubId }), directory: '/workspace' }));
});

it('keeps New in the selected remote worktree raw cwd, not the project root or Hub cwd', async () => {
  fixture.remote.location.directory = '/worktrees/topic/raw space';
  fixture.topology.projectDirectories['/workspace'] = ['/worktrees/topic'];
  const entry = { location: fixture.remote.location, key: locationKey(fixture.remote.location), queryScope: ['worktree'], sdk: vi.fn() };
  fixture.registry = { hubId: fixture.project.hubId, resolve: () => entry, assertCurrent: fixture.noop };
  await act(async () => root.render(<Header />));
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  const newAction = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((row) => row.textContent?.includes('sessions.sidebar.header.actions.newSession'))!;
  await act(async () => newAction.click());
  expect(fixture.remoteNavigate).toHaveBeenLastCalledWith(fixture.project, { ...fixture.remote.location, directory: '/worktrees/topic/raw space' }, null, undefined);
  expect(fixture.localNew).not.toHaveBeenCalled();
});

it('rejects a cached project from a different Hub rather than routing its same raw IDs locally or to the new Hub', async () => {
  fixture.catalogHub = 'https://other-hub.example';
  fixture.registry = { hubId: fixture.catalogHub, resolve: vi.fn(), assertCurrent: fixture.noop };
  await act(async () => root.render(<SessionSwitcherDropdown scopeProjectId={fixture.project.id}><button>Remote</button></SessionSwitcherDropdown>));
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  expect(toast.error).toHaveBeenCalledWith('remoteProjects.host-unavailable', expect.anything());
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.querySelector('[data-slot="session-switcher-item"]')).toBeNull();
  expect(fixture.localSwitcher).not.toHaveBeenCalled();
  expect(fixture.localNew).not.toHaveBeenCalled();
  expect(fixture.remoteNavigate).not.toHaveBeenCalled();
});

it('retains cached children through a failed Host read and offers retry without touching Hub selection', async () => {
  const list = vi.fn().mockRejectedValue(new Error('Child refresh failed'));
  const entry = { location: fixture.remote.location, key: locationKey(fixture.remote.location), queryScope: ['child-failure'], sdk: () => ({ session: { list } }) };
  fixture.registry = { hubId: fixture.project.hubId, resolve: () => entry, assertCurrent: fixture.noop, subscribeEvents: () => fixture.noop };
  const key = [...entry.queryScope, 'navigation-children', 'same-session', 30];
  queryClient.setQueryDefaults(key, { retry: false });
  queryClient.setQueryData(key, { sessions: [{ id: 'cached-child', parentID: 'same-session', title: 'CACHED CHILD', time: { created: 1, updated: 1 } }], hasMore: false });
  await act(async () => root.render(<SessionSwitcherDropdown><button>Remote</button></SessionSwitcherDropdown>));
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  await act(async () => document.querySelector<HTMLElement>('[data-switcher-expand]')!.click());
  expect(document.body.textContent).toContain('CACHED CHILD');
  await act(async () => { await queryClient.invalidateQueries({ queryKey: key, exact: true }); });
  await act(async () => { await vi.waitFor(() => expect(toast.error).toHaveBeenCalledWith('Child refresh failed', expect.anything())); });
  expect(document.body.textContent).toContain('CACHED CHILD');
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(document.body.textContent).not.toContain('Child refresh failed');
  const action = vi.mocked(toast.error).mock.lastCall?.[1]?.action;
  expect(action).toMatchObject({ label: 'remoteProjects.retry' });
  expect(fixture.localSelect).not.toHaveBeenCalled();
  expect(fixture.localNew).not.toHaveBeenCalled();
});

it('drops late child results after switching Hosts even when project path and session IDs are identical', async () => {
  let finish!: (result: { data: unknown[] }) => void;
  const list = vi.fn(() => new Promise<{ data: unknown[] }>((resolve) => { finish = resolve; }));
  fixture.registry = { hubId: fixture.project.hubId, assertCurrent: fixture.noop, subscribeEvents: () => fixture.noop,
    resolve: (location: typeof fixture.remote.location) => ({ location, key: locationKey(location), queryScope: [location.hostId], sdk: () => ({ session: { list } }) }) };
  await act(async () => root.render(<SessionSwitcherDropdown><button>Remote</button></SessionSwitcherDropdown>));
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  await act(async () => document.querySelector<HTMLElement>('[data-switcher-expand]')!.click());
  expect(list).toHaveBeenCalledOnce();
  fixture.project.hostId = 'other-host';
  await act(async () => root.render(<SessionSwitcherDropdown><button>Remote</button></SessionSwitcherDropdown>));
  await act(async () => finish({ data: [{ id: 'old-child', parentID: 'same-session', title: 'OLD HOST CHILD', time: { created: 1, updated: 1 } }] }));
  expect(document.body.textContent).not.toContain('OLD HOST CHILD');
  const other = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="session-switcher-item"]')).find((row) => row.textContent?.includes('OTHER REMOTE'))!;
  await act(async () => other.click());
  expect(fixture.remoteNavigate).toHaveBeenLastCalledWith(fixture.project, { ...fixture.remote.location, hostId: 'other-host' }, 'other', undefined);
  expect(fixture.localSelect).not.toHaveBeenCalled();
});

it.each([false, true])('uses verified external worktree ownership in the real Header dropdown, child SDK cwd, selection and New (stale topology: %s)', async (stale) => {
  const checkout = '/external/checkouts/topic raw';
  const selectedDirectory = `${checkout}/app`;
  const childDirectory = `${checkout}/child raw`;
  fixture.topology.projectDirectories = { '/workspace': [checkout], '/host-only-root': ['/external/host-only'] };
  fixture.topology.staleProjectDirectories = stale ? ['/workspace'] : [];
  fixture.extraProjects = [
    { ...fixture.project, id: 'explicit', path: `${checkout}/explicit` },
    { ...fixture.project, id: 'other-host-project', hostId: 'another-host', path: '/host-only-root' },
  ];
  const row = (id: string, directory: string, title: string) => ({ id, directory, title, time: { created: 3, updated: 3 } });
  fixture.extraDirectories = [
    { directory: selectedDirectory, sessions: [row('same-session', selectedDirectory, 'EXTERNAL HEADER TITLE')] },
    { directory: `${checkout}/explicit`, sessions: [row('explicit', `${checkout}/explicit`, 'OTHER EXPLICIT PROJECT')] },
    { directory: '/external/checkouts/sibling/app', sessions: [row('sibling', '/external/checkouts/sibling/app', 'UNVERIFIED SIBLING')] },
    { directory: '/external/host-only/app', sessions: [row('other-host', '/external/host-only/app', 'OTHER HOST WORKTREE')] },
  ];
  fixture.remote.location.directory = selectedDirectory;
  const list = vi.fn(async ({ parentID }: { directory: string; parentID: string }) => ({ data: parentID === 'same-session' ? [
    { ...row('child', childDirectory, 'EXTERNAL CHILD'), parentID, location: { directory: childDirectory } },
    { ...row('bad-child', '/external/checkouts/sibling/app', 'UNVERIFIED CHILD'), parentID, location: { directory: '/external/checkouts/sibling/app' } },
    { ...row('host-child', '/external/host-only/app', 'OTHER HOST CHILD'), parentID, location: { directory: '/external/host-only/app' } },
  ] : [] }));
  fixture.registry = { hubId: fixture.project.hubId, assertCurrent: fixture.noop, subscribeEvents: () => fixture.noop,
    resolve: (location: typeof fixture.remote.location) => ({ location, key: locationKey(location), queryScope: ['external', location.hostId, location.directory], sdk: () => ({ session: { list } }) }) };
  await act(async () => root.render(<Header />));
  expect(node.textContent).toContain('EXTERNAL HEADER TITLE');
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  expect(document.body.textContent).not.toContain('UNVERIFIED SIBLING');
  expect(document.body.textContent).not.toContain('OTHER HOST WORKTREE');
  expect(document.body.textContent).not.toContain('OTHER EXPLICIT PROJECT');
  const externalRow = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="session-switcher-item"]')).find((item) => item.textContent?.includes('EXTERNAL HEADER TITLE'))!;
  await act(async () => externalRow.click());
  expect(fixture.remoteNavigate).toHaveBeenLastCalledWith(fixture.project, { ...fixture.remote.location, directory: selectedDirectory }, 'same-session', undefined);
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  const parent = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="session-switcher-item"]')).find((item) => item.textContent?.includes('REMOTE TITLE'))!;
  await act(async () => parent.querySelector<HTMLElement>('[data-switcher-expand]')!.click());
  await act(async () => { await vi.waitFor(() => expect(document.body.textContent).toContain('EXTERNAL CHILD')); });
  expect(document.body.textContent).not.toContain('UNVERIFIED CHILD');
  expect(document.body.textContent).not.toContain('OTHER HOST CHILD');
  const child = Array.from(document.querySelectorAll<HTMLElement>('[data-slot="session-switcher-item"]')).find((item) => item.textContent?.includes('EXTERNAL CHILD'))!;
  await act(async () => child.querySelector<HTMLElement>('[data-switcher-expand]')!.click());
  expect(list).toHaveBeenCalledWith({ directory: childDirectory, parentID: 'child', limit: 30 }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  await act(async () => child.click());
  expect(fixture.remoteNavigate).toHaveBeenLastCalledWith(fixture.project, { ...fixture.remote.location, directory: childDirectory }, 'child', undefined);
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  const newAction = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.includes('sessions.sidebar.header.actions.newSession'))!;
  await act(async () => newAction.click());
  expect(fixture.remoteNavigate).toHaveBeenLastCalledWith(fixture.project, { ...fixture.remote.location, directory: selectedDirectory }, null, undefined);
  expect(fixture.localNew).not.toHaveBeenCalled(); expect(fixture.localSelect).not.toHaveBeenCalled();
});

it('does not infer a nested project checkout from the parent repository topology, even for the selected raw cwd', async () => {
  fixture.project.path = '/workspace/src';
  fixture.remote.location.directory = '/external/topic/src';
  fixture.extraProjects = [{ ...fixture.project, id: 'parent-repo', path: '/workspace' }];
  fixture.topology.projectDirectories = { '/workspace': ['/external/topic'], '/workspace/src': [] };
  fixture.extraDirectories = [{ directory: '/external/topic/src', sessions: [{ id: 'same-session', directory: '/external/topic/src', title: 'UNVERIFIED NESTED TITLE', time: { created: 3, updated: 3 } }] }];
  fixture.registry = { hubId: fixture.project.hubId, assertCurrent: fixture.noop,
    resolve: (location: typeof fixture.remote.location) => ({ location, key: locationKey(location), queryScope: ['nested', location.directory], sdk: fixture.noop }) };
  await act(async () => root.render(<Header />));
  expect(node.textContent).not.toContain('UNVERIFIED NESTED TITLE');
  await act(async () => useUIStore.getState().setSessionDropdownOpen(true));
  expect(document.body.textContent).not.toContain('UNVERIFIED NESTED TITLE');
  const newAction = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent?.includes('sessions.sidebar.header.actions.newSession'))!;
  await act(async () => newAction.click());
  expect(fixture.remoteNavigate).not.toHaveBeenCalled();
  expect(fixture.localNew).not.toHaveBeenCalled();
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('renders the real Header and titlebar with remote session identity, not the same-ID local session', async () => {
  await act(async () => root.render(<><Header /><TitlebarLeftControls /></>));
  expect(node.textContent).toContain('REMOTE TITLE');
  expect(node.textContent).toContain('Build machine');
  expect(node.textContent).not.toContain('LOCAL SECRET TITLE');
  expect(fixture.localRead).toHaveBeenCalledWith(null);
  expect(node.querySelector('[data-local-editor]')).toBeNull();
  const key = locationKey(fixture.remote.location);
  expect(node.querySelector('[data-titlebar-location]')?.getAttribute('data-titlebar-location')).toBe(key);
  const toggle = node.querySelector<HTMLButtonElement>('[aria-label="contextPanel.actions.togglePanel"]')!;
  await act(async () => toggle.click());
  expect(useUIStore.getState().contextPanelByDirectory[key]?.isOpen).toBe(true);
  expect(useUIStore.getState().contextPanelByDirectory['/workspace']).toBeUndefined();
});
