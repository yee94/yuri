import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { HostRuntimeRegistry, type HostRuntimeEntry } from '@/lib/remote-projects/registry';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import { MobileSessionStatusBar } from './MobileSessionStatusBar';
import { queryClient } from '@/lib/queryRuntime';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { locationSessionKey } from '@/lib/remote-projects/location';

const f = vi.hoisted(() => ({
  registry: undefined as unknown, summaries: {} as Record<string, unknown>, fail: false, remoteCompletion: false,
  local: { id: 'same', title: 'LOCAL', directory: '/repo', time: { created: 1, updated: 1 } },
  localRead: vi.fn(), localMutation: vi.fn(), localGit: vi.fn(async (_path: string) => false),
  refreshLocal: vi.fn(), localBranch: vi.fn(async () => null), localWorktree: vi.fn(),
  update: vi.fn(), remove: vi.fn(), phone: vi.fn(), toastError: vi.fn(), toastSuccess: vi.fn(), localStoreWrite: vi.fn(), list: vi.fn(),
  active: new Set<string>(), pinned: new Set<string>(), dirs: new Map(), worktrees: new Map(),
}));
vi.mock('@/queries/remoteProjectQueries', async (original) => ({ ...await original<object>(),
  supportsRemoteProjects: () => true, useRemoteProjectRuntime: () => ({ registry: f.registry }), getHostRuntimeRegistry: () => f.registry,
}));
vi.mock('@/stores/useUIStore', async () => {
  const { create } = await import('zustand');
  return { useUIStore: create((set) => ({ isMobile: true, mobileSessionPanelOpen: true, mobileSessionFilterProjectId: null,
    setMobileSessionPanelOpen: (open: boolean) => set({ mobileSessionPanelOpen: open }), setMobileSessionFilterProjectId: (id: string | null) => set({ mobileSessionFilterProjectId: id }),
  })) };
});
vi.mock('@/stores/useProjectsStore', async () => {
  const { create } = await import('zustand');
  return { useProjectsStore: create((set) => ({ projects: [], activeProjectId: null, setActiveProjectIdOnly: (id: string) => set({ activeProjectId: id }), removeProject: f.remove })) };
});
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: Object.assign((select: (state: unknown) => unknown) => select({
  currentSessionId: 'same', setCurrentSession: f.localMutation, openNewSessionDraft: f.localMutation, archiveSession: f.localMutation,
  shareSession: f.localMutation, unshareSession: f.localMutation, updateSessionTitle: f.localMutation, requestSessionSmartTitle: f.localMutation,
  availableWorktreesByProject: f.worktrees, getSessionsByDirectory: () => [f.local],
}), { getState: () => ({ activePaginationByDirectory: f.dirs, availableWorktreesByProject: f.worktrees }), setState: f.localStoreWrite }) }));
vi.mock('@/sync/sync-context', () => ({ useAllLiveSessions: () => [f.local], useActiveSessionTreeIds: () => f.active }));
vi.mock('@/stores/useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: Object.assign((select: (state: unknown) => unknown) => select({ activeSessions: [], activePaginationByDirectory: f.dirs }), { getState: () => ({ activePaginationByDirectory: f.dirs }) }),
  mergeLiveSessionWithGlobalSession: (session: unknown) => session, refreshGlobalSessionsForDirectories: f.refreshLocal,
  syncGlobalSessionsForDirectories: f.localMutation, loadMoreGlobalSessionsForDirectory: f.localMutation,
}));
vi.mock('@/sync/notification-store', () => ({ useNotificationStore: (select: (state: unknown) => unknown) => select({ index: { session: { unseenCount: {} } } }) }));
vi.mock('@/mobile/useSessionReadMenuAction', () => ({ useSessionReadMenuAction: (session: { id: string } | null) => { if (session) f.localRead(session.id); return { unread: false, onToggleRead: undefined }; } }));
vi.mock('@/queries/sessionIndexPinQueries', () => ({ usePinnedSessionIds: () => f.pinned, useTogglePinnedSession: () => f.localMutation }));
vi.mock('@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds', () => ({ useAlwaysVisibleSessionIds: () => f.pinned }));
vi.mock('@/stores/useSessionStatusBarCollapseStore', async () => {
  const { create } = await import('zustand');
  return { useSessionStatusBarCollapseStore: create((set) => ({ expandedWorktreeGroups: {}, setWorktreeGroupExpanded: (key: string, expanded: boolean) => set((state: { expandedWorktreeGroups: Record<string, boolean> }) => ({ expandedWorktreeGroups: { ...state.expandedWorktreeGroups, [key]: expanded } })) })) };
});
vi.mock('@/stores/useWorktreeOrderStore', () => ({ useWorktreeOrderStore: (select: (state: unknown) => unknown) => select({ orderByProject: {} }), orderWorktrees: (_order: unknown, trees: unknown) => trees }));
vi.mock('@/hooks/useRuntimeAPIs', () => { const git = { checkIsGitRepository: f.localGit }; return { useRuntimeAPIs: () => ({ git }) }; });
vi.mock('@/lib/worktrees/worktreeStatus', () => ({ getRootBranch: f.localBranch }));
vi.mock('@/lib/worktrees/worktreeManager', () => ({ forceRefreshProjectWorktreeCatalog: f.localWorktree }));
vi.mock('@/lib/platform', () => ({ isIPadApp: () => false, isCapacitorApp: () => true }));
vi.mock('@/mobile/useMobileNavigationStore', () => ({ useMobileNavigationStore: { getState: () => ({ openSession: f.localMutation, openDraft: f.localMutation, openRemoteProject: f.phone }) } }));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => ({ currentTheme: { metadata: { variant: 'light' }, colors: { surface: { foreground: '' } } } }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/toast', () => ({ toast: { error: f.toastError, success: f.toastSuccess, custom: vi.fn(), dismiss: vi.fn() } }));
vi.mock('@/components/ui', () => ({ toast: { error: f.toastError, success: f.toastSuccess, custom: vi.fn(), dismiss: vi.fn() } }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/session/SessionBusyIndicator', () => ({ SessionBusyIndicator: () => <span data-busy /> }));
vi.mock('@/components/ui/MobileWindowMotion', () => ({ MobileWindowMotion: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <section data-sessions-sheet>{children}</section> : null }));
vi.mock('@/components/ui/MobileOverlayPanel', () => ({ MobileOverlayPanel: ({ open, title, children, footer }: { open: boolean; title: string; children: React.ReactNode; footer: React.ReactNode }) => open ? <section data-overlay={title}>{children}{footer}</section> : null }));
vi.mock('@/components/ui/ScrollableOverlay', () => ({ ScrollableOverlay: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui/useMobileSheetSnap', () => ({ MOBILE_SHEET_EXPANDED_SNAP: 1, useMobileSheetSnap: () => ({ reset: () => {} }) }));
vi.mock('@/components/ui/MobileSheetSnapHandle', () => ({ MobileSheetSnapHandle: () => null }));
vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ContextMenuTrigger: ({ render, children }: { render: React.ReactElement; children: React.ReactNode }) => React.cloneElement(render, {}, children),
  ContextMenuContent: ({ children }: { children: React.ReactNode }) => <div data-row-menu>{children}</div>,
  ContextMenuSeparator: () => null, ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick: () => void }) => <button onClick={onClick}>{children}</button>,
}));
vi.mock('@/components/session/NewWorktreeDialog', async () => {
  const { useHostRuntime } = await import('@/contexts/HostRuntimeProvider');
  return { NewWorktreeDialog: ({ open, onWorktreeCreated }: { open: boolean; onWorktreeCreated(path: string, options?: { sessionId?: string; remote?: boolean }): void }) => {
    const host = useHostRuntime();
    return open ? <button data-worktree-create-host={host?.entry.location.hostId} onClick={() => onWorktreeCreated('C:\\new\\worktree\\src', { sessionId: 'created', remote: f.remoteCompletion })}>complete-worktree</button> : null;
  } };
});
vi.mock('@/components/session/DirectoryExplorerDialog', () => ({ DirectoryExplorerDialog: () => null }));
vi.mock('@/apps/MobileProjectEditSurface', () => ({ MobileProjectEditSurface: () => null }));
vi.mock('@/apps/MobileDeleteWorktreeDialog', async () => {
  const { useHostRuntime } = await import('@/contexts/HostRuntimeProvider');
  return { MobileDeleteWorktreeDialog: ({ onDeleted }: { onDeleted(): void }) => {
    const host = useHostRuntime();
    return <button data-worktree-delete-host={host?.entry.location.hostId} onClick={onDeleted}>complete-worktree-delete</button>;
  } };
});

let root: Root, node: HTMLDivElement, registry: HostRuntimeRegistry;
const projects = [
  { id: 'local', path: '/repo' },
  { id: 'a', hubId: 'hub', hostId: 'a', path: '/repo', label: 'A' },
  { id: 'b', hubId: 'hub', hostId: 'b', path: '/repo', label: 'B' },
];
const rawWorktree = 'C:\\external\\checkout\\src';
const snapshot = (id: string) => ({ hostId: id, stale: false, revision: 1, pinnedSessionIds: [],
  directories: [{ directory: id === 'a' ? rawWorktree : '/repo', sessions: [{ id: 'same', title: `HOST ${id}`, time: { created: 2, updated: 3 } }], hasMore: false }],
  worktrees: { projectDirectories: { '/repo': [rawWorktree] }, staleProjectDirectories: [] },
  unread: { revision: 7, sessions: { same: { directory: id === 'a' ? rawWorktree : '/repo', unreadCount: 1, hasError: false, manual: false, revision: 7 } } },
});
const fetchHost = vi.fn(async (path: string, _options?: RequestInit) => {
  const host = path.split('/')[3];
  if (path.endsWith('/summaries')) return new Response(JSON.stringify(f.summaries[host]), { headers: { 'content-type': 'application/json' } });
  if (f.fail) return new Response(JSON.stringify({ error: 'failed write' }), { status: 500 });
  if (path.endsWith('/api/git/check')) return new Response(JSON.stringify({ isGitRepository: true }));
  if (path.endsWith('/api/git/worktrees')) return new Response(JSON.stringify([{ path: rawWorktree, branch: 'feature/remote', name: 'remote-checkout', head: 'abc' }, { path: '/repo', branch: 'main', name: 'root', head: 'def' }]));
  if (path.includes('/session-unread/')) return new Response(JSON.stringify(f.summaries[host] && (f.summaries[host] as ReturnType<typeof snapshot>).unread));
  return new Response('{}', { headers: { 'content-type': 'application/json' } });
});
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); queryClient.clear(); f.fail = false; f.remoteCompletion = false; f.summaries = { a: snapshot('a'), b: snapshot('b') };
  f.update.mockResolvedValue({}); f.remove.mockResolvedValue(undefined);
  registry = new HostRuntimeRegistry('hub', { transportIdentity: 'test', isCurrent: () => true, fetch: fetchHost,
    sdk: () => ({ session: { list: f.list } }) as unknown as OpenCodeClient, service: () => ({ updateSession: f.update, deleteSession: vi.fn(async () => true) }) as unknown as ReturnType<HostRuntimeEntry['service']>,
  });
  for (const id of ['a', 'b']) registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: id, host: { id, name: `Machine ${id}`, source: 'direct', state: 'connected' } } });
  f.registry = registry;
  useProjectsStore.setState({ projects, activeProjectId: 'a' });
  useUIStore.setState({ mobileSessionPanelOpen: true, mobileSessionFilterProjectId: null });
  useSessionNavigationStore.getState().clearRemoteSession();
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); registry.dispose(); queryClient.clear(); node.remove(); });
const mount = async () => { await act(async () => root.render(<QueryClientProvider client={queryClient}><MobileSessionStatusBar /></QueryClientProvider>)); await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); }); };
const key = (hostId: string) => locationSessionKey({ hubId: 'hub', hostId, directory: (f.summaries[hostId] as ReturnType<typeof snapshot>).directories[0].directory }, 'same');
const row = (hostId: string) => [...node.querySelectorAll<HTMLElement>('[data-mobile-session-context-trigger]')].find((element) => element.dataset.mobileSessionContextTrigger === key(hostId))!;
const menu = (hostId: string, label: string) => [...row(hostId).parentElement!.querySelectorAll<HTMLButtonElement>('[data-row-menu] button')].find((button) => button.textContent === label)!;

it('mounts all-project same-ID/path local and two Host rows without merging remote refs into Hub catalogs', async () => {
  await mount();
  expect(node.textContent).toContain('LOCAL'); expect(node.textContent).toContain('HOST a'); expect(node.textContent).toContain('HOST b');
  expect(row('a')).not.toBe(row('b'));
  expect(node.textContent).toContain('Machine a'); expect(node.textContent).toContain('Machine b');
  expect(f.localRead.mock.calls.every(([id]) => id === 'same')).toBe(true);
  expect(f.localGit.mock.calls.every(([path]) => path === '/repo')).toBe(true);
  expect(f.refreshLocal.mock.calls.every(([dirs]) => (dirs as string[]).every((path) => path === '/repo'))).toBe(true);
});

it('opens the selected Host session in its authoritative external raw worktree cwd, not the Hub', async () => {
  await mount(); await act(async () => row('a').click());
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ projectId: 'a', sessionId: 'same', location: { hostId: 'a', directory: rawWorktree } });
  expect(f.phone).toHaveBeenCalledTimes(1); expect(f.localMutation).not.toHaveBeenCalled();
});

it('archive success targets raw ID/cwd; a failed sibling write preserves its original row', async () => {
  await mount();
  await act(async () => menu('a', 'sessions.sidebar.bulkActions.archive').click());
  expect(f.update).toHaveBeenCalledWith('same', expect.objectContaining({ time: expect.objectContaining({ archived: expect.any(Number) }) }), rawWorktree);
  expect(row('a')).toBeUndefined(); expect(row('b')).toBeDefined(); expect(f.localMutation).not.toHaveBeenCalled();
  f.update.mockRejectedValueOnce(new Error('offline'));
  await act(async () => menu('b', 'sessions.sidebar.bulkActions.archive').click());
  expect(row('b')).toBeDefined(); expect(f.toastError).toHaveBeenCalled();
});

it('pin uses the selected Host Yuri route, and rejects failure without altering the other Host', async () => {
  await mount(); await act(async () => menu('a', 'sessions.sidebar.session.menu.pin').click());
  expect(fetchHost.mock.calls.some(([path]) => path === '/api/hosts/a/api/yuri/session-index/session/same/pin')).toBe(true);
  f.fail = true; await act(async () => menu('b', 'sessions.sidebar.session.menu.pin').click());
  expect(f.toastError).toHaveBeenCalled(); expect(row('a')).toBeDefined(); expect(row('b')).toBeDefined();
  expect(f.localMutation).not.toHaveBeenCalled();
});

it('local-only repeated mounted renders perform zero Host discovery/summary/resolve work', async () => {
  useProjectsStore.setState({ projects: [projects[0]], activeProjectId: 'local' });
  const resolve = vi.spyOn(registry, 'resolve');
  for (let i = 0; i < 50; i++) await act(async () => root.render(<QueryClientProvider client={queryClient}><MobileSessionStatusBar /></QueryClientProvider>));
  expect(fetchHost).not.toHaveBeenCalled(); expect(resolve).not.toHaveBeenCalled();
});

const button = (label: string) => [...node.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === label)!;
const projectMenu = async (key: string) => {
  const target = [...node.querySelectorAll<HTMLElement>('[data-mobile-long-press-trigger]')].find((element) => element.dataset.mobileLongPressTrigger === key)!;
  await act(async () => target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
};

it('New in a selected remote project preserves its Host while All uses the latest raw worktree', async () => {
  await mount();
  await act(async () => button('B · Machine b').click());
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="mobile.sessions.newChat"]')!.click());
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ projectId: 'b', sessionId: null, location: { hostId: 'b', directory: '/repo' } });
  await act(async () => useUIStore.setState({ mobileSessionPanelOpen: true, mobileSessionFilterProjectId: null }));
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="mobile.sessions.newChat"]')!.click());
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ projectId: 'a', sessionId: null, location: { hostId: 'a', directory: rawWorktree } });
  expect(f.localMutation).not.toHaveBeenCalled();
});

it('rename failure preserves the editor and input; retry and smart title use raw ID/cwd', async () => {
  await mount();
  await act(async () => menu('a', 'sessions.sidebar.session.menu.rename').click());
  const input = node.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Changed title');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  f.update.mockRejectedValueOnce(new Error('offline'));
  await act(async () => button('sessions.sidebar.session.rename.save').click());
  expect(node.querySelector<HTMLInputElement>('input')?.value).toBe('Changed title');
  expect(row('b')).toBeDefined();
  await act(async () => button('sessions.sidebar.session.rename.save').click());
  expect(f.update).toHaveBeenLastCalledWith('same', { title: 'Changed title' }, rawWorktree);
  expect(node.querySelector('input')).toBeNull();
  await act(async () => menu('b', 'sessions.sidebar.session.menu.rename').click());
  f.update.mockRejectedValueOnce(new Error('offline'));
  await act(async () => button('sessions.sidebar.session.rename.smartTitle').click());
  expect(node.querySelector('input')).not.toBeNull();
  await act(async () => button('sessions.sidebar.session.rename.smartTitle').click());
  expect(f.update).toHaveBeenLastCalledWith('same', { metadata: { yuri: { titleRefresh: expect.objectContaining({ requestedAt: expect.any(Number), lastAutoTitle: 'HOST b' }) } } }, '/repo');
  expect(node.querySelector('input')).toBeNull(); expect(f.localMutation).not.toHaveBeenCalled();
});

it('mark read carries the Host revision, and failed read preserves both Host rows', async () => {
  await mount();
  await act(async () => menu('a', 'sessions.sidebar.session.menu.markRead').click());
  const request = fetchHost.mock.calls.find(([path]) => path === '/api/hosts/a/api/yuri/session-unread/same');
  expect(request).toBeDefined(); expect(JSON.parse(request![1]!.body as string)).toEqual({ unread: false, expectedRevision: 7 });
  f.fail = true;
  await act(async () => menu('b', 'sessions.sidebar.session.menu.markRead').click());
  expect(row('a')).toBeDefined(); expect(row('b')).toBeDefined(); expect(f.toastError).toHaveBeenCalled();
  expect(f.localMutation).not.toHaveBeenCalled();
});

it('worktree New uses authoritative external raw cwd rather than its project root or Hub', async () => {
  await mount(); await act(async () => button('A · Machine a').click());
  await projectMenu(`worktree:a:${rawWorktree}`);
  await act(async () => button('sessions.sidebar.project.actions.newSession').click());
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ projectId: 'a', sessionId: null, location: { hostId: 'a', directory: rawWorktree } });
  expect(f.localMutation).not.toHaveBeenCalled();
});

it('paging preserves successful pages on error and retries the same cursor without replaying earlier pages', async () => {
  const summary = f.summaries.b as ReturnType<typeof snapshot>;
  summary.directories[0].hasMore = true;
  f.list.mockResolvedValueOnce({ data: [{ id: 'older', title: 'Older page', time: { created: 1, updated: 1 }, location: { directory: '/repo' } }], cursor: { next: 'cursor-2' } });
  await mount(); await act(async () => button('B · Machine b').click());
  await act(async () => button('sessions.sidebar.group.showMore').click());
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });
  expect(node.textContent).toContain('Older page');
  f.list.mockRejectedValueOnce(new Error('page offline'));
  await act(async () => button('sessions.sidebar.group.showMore').click());
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });
  expect(node.textContent).toContain('Older page'); expect(row('b')).toBeDefined();
  f.list.mockResolvedValueOnce({ data: [{ id: 'oldest', title: 'Oldest page', time: { created: 0, updated: 0 }, location: { directory: '/repo' } }], cursor: {} });
  await act(async () => button('sessions.sidebar.group.showMore').click());
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });
  expect(node.textContent).toContain('Oldest page'); expect(node.textContent).toContain('Older page');
  expect(f.list).toHaveBeenCalledTimes(3);
  expect(f.list.mock.calls.map(([args]) => args.cursor)).toEqual([undefined, 'cursor-2', 'cursor-2']);
  expect(f.list.mock.calls.every(([args]) => args.directory === '/repo')).toBe(true); expect(f.localMutation).not.toHaveBeenCalled();
});

it('retains worktree branch metadata, scopes original dialog boundaries, and keeps remote callbacks out of Hub stores', async () => {
  await mount(); await act(async () => button('A · Machine a').click());
  expect(node.textContent).toContain('feature/remote');
  await projectMenu(`worktree:a:${rawWorktree}`);
  await act(async () => button('mobile.projectEdit.deleteWorktreeConfirmButton').click());
  expect(node.querySelector('[data-worktree-delete-host="a"]')).not.toBeNull();
  f.localStoreWrite.mockClear();
  await act(async () => button('complete-worktree-delete').click());
  expect(f.localStoreWrite).not.toHaveBeenCalled();
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.project.actions.newWorktree"]')!.click());
  expect(node.querySelector('[data-worktree-create-host="a"]')).not.toBeNull();
  await act(async () => button('complete-worktree').click());
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ projectId: 'a', sessionId: 'created', location: { hostId: 'a', directory: 'C:\\new\\worktree\\src' } });
  expect(f.localMutation).not.toHaveBeenCalled();
});

it('archive Undo restores only its Host and preserves the archived view when unarchive fails', async () => {
  await mount(); await act(async () => menu('a', 'sessions.sidebar.bulkActions.archive').click());
  const options = f.toastSuccess.mock.calls.find(([key]) => key === 'sessions.sidebar.session.archive.success')![1];
  f.update.mockRejectedValueOnce(new Error('unarchive failed'));
  await act(async () => options.action.onClick());
  expect(row('a')).toBeUndefined(); expect(row('b')).toBeDefined();
  await act(async () => options.action.onClick());
  expect(f.update).toHaveBeenLastCalledWith('same', { time: { archived: null } }, rawWorktree);
  expect(row('a')).toBeDefined(); expect(row('b')).toBeDefined(); expect(f.localMutation).not.toHaveBeenCalled();
});

it('keeps the share action explicit without fabricating a Host or Hub sharing API', async () => {
  await mount(); fetchHost.mockClear();
  await act(async () => menu('a', 'sessions.sidebar.session.menu.share').click());
  expect(f.toastError).toHaveBeenCalledWith('remoteProjects.nativeCapabilityUnavailable');
  expect(f.localMutation).not.toHaveBeenCalled(); expect(fetchHost).not.toHaveBeenCalled();
});

it('an old Host rename response cannot close a newly opened sibling editor', async () => {
  await mount(); await act(async () => menu('a', 'sessions.sidebar.session.menu.rename').click());
  let complete!: (value: object) => void;
  f.update.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await act(async () => button('sessions.sidebar.session.rename.save').click());
  await act(async () => menu('b', 'sessions.sidebar.session.menu.rename').click());
  await act(async () => complete({}));
  expect(node.querySelector<HTMLInputElement>('input')?.value).toBe('HOST b');
  expect(f.localMutation).not.toHaveBeenCalled();
});

it('same raw ID and same raw cwd on two Hosts stay separate during pin, read and navigation', async () => {
  const a = f.summaries.a as ReturnType<typeof snapshot>;
  a.directories[0].directory = '/repo'; a.unread.sessions.same.directory = '/repo';
  await mount();
  expect(row('a')).toBeDefined(); expect(row('b')).toBeDefined(); expect(key('a')).not.toBe(key('b'));
  await act(async () => menu('a', 'sessions.sidebar.session.menu.pin').click());
  await act(async () => menu('b', 'sessions.sidebar.session.menu.markRead').click());
  expect(fetchHost.mock.calls.some(([path]) => path === '/api/hosts/a/api/yuri/session-index/session/same/pin')).toBe(true);
  expect(fetchHost.mock.calls.some(([path]) => path === '/api/hosts/b/api/yuri/session-unread/same')).toBe(true);
  await act(async () => row('b').click());
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ projectId: 'b', sessionId: 'same', location: { hostId: 'b', directory: '/repo' } });
  expect(f.localMutation).not.toHaveBeenCalled();
});

it('remote worktree pagination sends the raw Windows cwd, including on retry', async () => {
  (f.summaries.a as ReturnType<typeof snapshot>).directories[0].hasMore = true;
  f.list.mockRejectedValueOnce(new Error('offline'));
  await mount(); await act(async () => button('A · Machine a').click());
  const worktree = [...node.querySelectorAll<HTMLButtonElement>('[data-mobile-long-press-trigger]')].find((element) => element.dataset.mobileLongPressTrigger === `worktree:a:${rawWorktree}`)!;
  await act(async () => worktree.click());
  await act(async () => button('sessions.sidebar.group.showMore').click());
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });
  expect(row('a')).toBeDefined();
  f.list.mockResolvedValueOnce({ data: [], cursor: {} });
  await act(async () => button('sessions.sidebar.group.showMore').click());
  await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 20)); });
  expect(f.list.mock.calls.map(([args]) => args.directory)).toEqual([rawWorktree, rawWorktree]);
  expect(f.localMutation).not.toHaveBeenCalled();
});

it('reconnected Host rejects an old archive completion instead of hiding a new-generation row', async () => {
  await mount();
  let complete!: (value: object) => void;
  f.update.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
  await act(async () => menu('a', 'sessions.sidebar.bulkActions.archive').click());
  await act(async () => {
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: 'a', host: { id: 'a', name: 'Machine a', source: 'direct', state: 'offline' } } });
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: 'a', host: { id: 'a', name: 'Machine a', source: 'direct', state: 'connected' } } });
  });
  await act(async () => complete({}));
  expect(row('a')).toBeDefined(); expect(row('b')).toBeDefined(); expect(f.toastSuccess).not.toHaveBeenCalled();
  expect(f.localMutation).not.toHaveBeenCalled();
});

it('a remote worktree helper completion preserves its existing draft/bootstrap metadata without reopening navigation', async () => {
  await mount(); await act(async () => button('A · Machine a').click());
  await act(async () => node.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.project.actions.newWorktree"]')!.click());
  f.remoteCompletion = true;
  await act(async () => useSessionNavigationStore.getState().openRemoteSession(projects[1], { hubId: 'hub', hostId: 'a', directory: 'C:\\new\\worktree\\src' }, null, {
    title: 'Created worktree', bootstrapWaitEnabled: false, bootstrapPendingDirectory: 'C:\\new\\worktree\\src',
    pendingWorktreeRequestId: 'pending-attachment', initialPrompt: 'Keep this prompt',
  }));
  const selected = useSessionNavigationStore.getState().remoteSession;
  await act(async () => button('complete-worktree').click());
  expect(useSessionNavigationStore.getState().remoteSession).toBe(selected);
  expect(f.phone).toHaveBeenCalledTimes(1); expect(f.localMutation).not.toHaveBeenCalled();
});
