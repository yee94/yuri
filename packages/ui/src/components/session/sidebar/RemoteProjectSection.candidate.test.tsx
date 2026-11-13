import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { RemoteProjectSection } from './RemoteProjectSection';
import { createEventPipeline } from '@/sync/event-pipeline';
import { getLocationOpencodeClient, opencodeClient } from '@/lib/opencode/client';
import { remoteHostSummariesQueryOptions } from '@/queries/remoteProjectQueries';
import { toast } from '@/components/ui';

type Socket = { onmessage: ((event: { data: string }) => void) | null; onopen: (() => void) | null;
  onclose: (() => void) | null; onerror: (() => void) | null; close(): void; send(): void; readyState: number };
const wire = vi.hoisted(() => ({ sockets: [] as Socket[], ssePaths: [] as string[] }));
beforeEach(() => { wire.sockets.length = 0; wire.ssePaths.length = 0; });
vi.mock('@/lib/relay/runtime-socket', () => ({ openRuntimeWebSocket: () => {
  const socket: Socket = { onmessage: null, onopen: null, onclose: null, onerror: null, close: () => {}, send: () => {}, readyState: 1 };
  wire.sockets.push(socket); return socket;
} }));
vi.mock('@/lib/runtime-sse', () => ({ consumeRuntimeSse: (path: string, options: { signal: AbortSignal }) => {
  wire.ssePaths.push(path);
  return new Promise<void>((resolve) => options.signal.addEventListener('abort', () => resolve(), { once: true }));
} }));
vi.mock('@/lib/runtime-auth', async (original) => ({ ...await original<object>(), refreshRuntimeUrlAuthToken: async () => undefined }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/session/sidebar/sortableItems', () => ({ SortableProjectItem: ({ children }: { children: React.ReactNode }) => <section>{children}</section> }));
vi.mock('@/components/session/NewWorktreeDialog', () => ({ NewWorktreeDialog: () => null }));
vi.mock('@/components/ui/MobileResizableSheet', () => ({ MobileResizableSheet: ({ open, title, children }: { open: boolean; title: React.ReactNode; children: React.ReactNode }) => open ? <div role="dialog">{title}{children}</div> : null }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: {
  getState: () => ({ currentDirectory: null, setDirectory: vi.fn() }), subscribe: () => () => {},
} }));

// candidate-final/raw-final/ui-network-console.jsonl:1258,1300,1324.
// Wire identities and envelopes are preserved; only the physical fixture cwd is neutral.
const hubId = '1bc591e2-ef65-4bc1-b0f5-3fbaafbb1e6f';
const hostId = 'candidate-remote';
const generation = '73794672-b0a5-4649-810f-efbd0847741a';
const host = { id: hostId, name: 'Diagnostic Remote', source: 'direct' as const, available: true, state: 'connected' as const,
  lastConnectedAt: 1794427541913, generation, version: '0.2.40-beta.2', capabilities: { remoteProjects: true } };
const project = { id: 'remote-e1e45e51fd10cee3d69a13f4', hubId, hostId, path: '/fixtures/remote-project', remoteProjectId: 'upstream', remoteState: 'ok' as const };
const status = { type: 'yuri:host-status', properties: { hubId, hostId, host } };
const tip = { type: 'yuri:host-event', properties: { hubId, hostId, generation,
  payload: { type: 'yuri:session-index-changed', properties: { cause: 'change' } } } };

it('mobile Delete opens a destructive confirmation and cancelling sends no mutation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient.clear(); queryClient.setDefaultOptions({ queries: { retry: false } });
  useProjectsStore.setState({ projects: [project], activeProjectId: null, hubProjectLayout: null });
  const service = vi.fn(() => { throw new Error('No mutation before confirmation'); });
  const fetch = vi.fn(async () => Response.json({ hubId, hostId, stale: false, directories: [{ directory: project.path,
    sessions: [{ id: 'delete-session', title: 'Delete target', time: { created: 1, updated: 2 } }], hasMore: false }] }));
  const registry = new HostRuntimeRegistry(hubId, { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch,
    sdk: () => { throw new Error('No transcript read'); }, service });
  registry.applyCatalog({ supported: true, hubId, hosts: [host], projects: [project] });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project} registry={registry} mobile /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.querySelector('.yuri-mobile-session-title')?.textContent).toBe('Delete target'));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.session.menu.label"]')!.click());
    const remove = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'sessions.sidebar.dialogs.deleteSession.titleAction')!;
    await act(async () => remove.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('sessions.sidebar.dialogs.deleteSession.title');
    expect(service).not.toHaveBeenCalled();
    const cancel = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'sessions.sidebar.dialogs.cancel')!;
    await act(async () => cancel.click());
    expect(service).not.toHaveBeenCalled();
    expect(container.querySelector('.yuri-mobile-session-title')?.textContent).toBe('Delete target');
  } finally { await act(async () => root.unmount()); container.remove(); registry.dispose(); queryClient.clear(); }
});

it('failed archive reports once through toast without inserting errors or retry rows into the project layout', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient.clear(); queryClient.setDefaultOptions({ queries: { retry: false } });
  useProjectsStore.setState({ projects: [project], activeProjectId: null, hubProjectLayout: null });
  const message = 'session.archive update failed (403)';
  const notify = vi.spyOn(toast, 'error').mockImplementation(() => 'archive-error');
  const archiveFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ code: 'remote_scope_forbidden' }, { status: 403 }));
  let loadFailure = false;
  const fetch = vi.fn(async (path: string) => {
    if (loadFailure) throw new Error('Summary load failed');
    if (path.endsWith('/summaries')) return Response.json({ hubId, hostId, stale: false, directories: [{ directory: project.path,
      sessions: [{ id: 'archive-session', title: 'Keep this row', time: { created: 1, updated: 2 } }], hasMore: false }] });
    if (path.includes('/api/yuri/sessions/archive-session/archive')) return Response.json({ code: 'remote_scope_forbidden' }, { status: 403 });
    throw new Error(`Unexpected request: ${path}`);
  });
  const registry = new HostRuntimeRegistry(hubId, { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch,
    sdk: () => { throw new Error('Must not read transcripts'); }, service: getLocationOpencodeClient });
  registry.applyCatalog({ supported: true, hubId, hosts: [host], projects: [project] });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project} registry={registry} mobile /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.querySelector('.yuri-mobile-session-title')?.textContent).toBe('Keep this row'));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.session.menu.label"]')!.click());
    const archive = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'sessions.sidebar.bulkActions.archive')!;
    await act(async () => archive.click());
    await vi.waitFor(() => expect(notify).toHaveBeenCalledExactlyOnceWith(message));
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain(message);
    expect(container.textContent).not.toContain('remoteProjects.retry');
    expect(container.querySelector('.yuri-mobile-session-title')?.textContent).toBe('Keep this row');
    notify.mockClear();
    loadFailure = true;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: remoteHostSummariesQueryOptions(registry, hostId).queryKey }); });
    await vi.waitFor(() => expect(notify).toHaveBeenCalledExactlyOnceWith('Summary load failed', { id: `remote-project:${project.id}:load` }));
    expect(container.querySelector('.yuri-mobile-session-title')?.textContent).toBe('Keep this row');
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.textContent).not.toContain('Summary load failed');
    await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project} registry={registry} /></QueryClientProvider>));
    expect(container.textContent).not.toContain('Summary load failed');
    expect(container.textContent).not.toContain('remoteProjects.retry');
  } finally {
    await act(async () => root.unmount()); container.remove(); registry.dispose(); queryClient.clear(); notify.mockRestore(); archiveFetch.mockRestore();
  }
});

it('mounted production sidebar refreshes the archived global WS index tip without manual Sync or another connection', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient.clear(); queryClient.setDefaultOptions({ queries: { retry: false } });
  useProjectsStore.setState({ projects: [project], activeProjectId: null, hubProjectLayout: null });
  let indexed = false;
  const fetch = vi.fn(async (path: string) => {
    expect(path).toBe(`/api/hosts/${hostId}/summaries`);
    return Response.json({ hubId, hostId, stale: false, directories: indexed ? [{ directory: project.path,
      sessions: [{ id: 'ses_e33caa6b5ffeu1gmXLDI2yoNE2', title: 'Performance baseline session', time: { created: 1794427410770, updated: 1794427410782 } }], hasMore: false }] : [] });
  });
  const registry = new HostRuntimeRegistry(hubId, { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch,
    sdk: () => { throw new Error('Sidebar must not read transcript'); } });
  registry.applyCatalog({ supported: true, hubId, hosts: [host], projects: [project] });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const localEvent = vi.fn();
  const pipeline = createEventPipeline({ sdk: opencodeClient.getSdkClient(), transport: 'ws', onEvent: localEvent });
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project} registry={registry} /></QueryClientProvider>));
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(container.querySelector('[data-remote-session]')).toBeNull();
    await vi.waitFor(() => expect(wire.sockets).toHaveLength(1));
    const socket = wire.sockets[0];
    socket.onmessage!({ data: JSON.stringify({ type: 'ready', scope: 'global' }) });
    indexed = true;
    await act(async () => {
      for (const envelope of [status, tip]) socket.onmessage!({ data: JSON.stringify({ type: 'event', payload: envelope, directory: 'global' }) });
    });
    await vi.waitFor(() => expect(container.querySelector('[data-remote-session]')?.textContent ?? '').toContain('Performance baseline session'));
    expect(localEvent).not.toHaveBeenCalled();
    expect(wire.sockets).toHaveLength(1);
    expect(wire.ssePaths).toEqual(['/api/yuri/events']);
  } finally {
    pipeline.cleanup(); await act(async () => root.unmount()); container.remove(); registry.dispose(); queryClient.clear();
  }
});

it('desktop remote session rows open the context menu on right click and pin through it', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient.clear(); queryClient.setDefaultOptions({ queries: { retry: false } });
  useProjectsStore.setState({ projects: [project], activeProjectId: null, hubProjectLayout: null });
  let pinned = false;
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/summaries')) return Response.json({ hubId, hostId, stale: false, pinnedSessionIds: pinned ? ['ctx-session'] : [], directories: [{ directory: project.path,
      sessions: [{ id: 'ctx-session', title: 'Context menu session', time: { created: 1, updated: 2 } }], hasMore: false }] });
    if (path.includes('/session/ctx-session/pin')) { pinned = true; return Response.json({}); }
    throw new Error(`Unexpected remote request: ${path}`);
  });
  const registry = new HostRuntimeRegistry(hubId, { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch,
    sdk: () => { throw new Error('Rows must not read transcripts'); } });
  registry.applyCatalog({ supported: true, hubId, hosts: [host], projects: [project] });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project} registry={registry} mobile={false} reorderEnabled={false} /></QueryClientProvider>));
    await vi.waitFor(() => expect(container.querySelector('[data-remote-session="ctx-session"]')).not.toBeNull());
    const row = container.querySelector<HTMLElement>('[data-remote-session="ctx-session"]')!;
    await act(async () => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10, button: 2 })); });
    await vi.waitFor(() => expect(document.querySelector('[role="menu"]')).not.toBeNull());
    const pin = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')].find((item) => item.textContent === 'remoteProjects.pin')!;
    expect(pin).toBeDefined();
    await act(async () => pin.click());
    await vi.waitFor(() => expect(fetch.mock.calls.some(([path]) => path.includes('/session/ctx-session/pin'))).toBe(true));
  } finally {
    await act(async () => root.unmount()); container.remove(); registry.dispose(); queryClient.clear();
  }
});

it('mobile remote projects reuse the floating project/session cards and keep management in action sheets', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient.clear(); queryClient.setDefaultOptions({ queries: { retry: false } });
  useProjectsStore.setState({ projects: [project], activeProjectId: null, hubProjectLayout: null });
  let pinned = false;
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/summaries')) return Response.json({ hubId, hostId, stale: false, pinnedSessionIds: pinned ? ['mobile-session'] : [], directories: [{ directory: project.path,
      sessions: [{ id: 'mobile-session', title: 'Native isolation A session', time: { created: 1, updated: 2 } }], hasMore: false }] });
    if (path.includes('/session/mobile-session/pin')) { pinned = true; return Response.json({}); }
    throw new Error(`Unexpected remote request: ${path}`);
  });
  const registry = new HostRuntimeRegistry(hubId, { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch,
    sdk: () => { throw new Error('Project cards must not read transcripts'); } });
  registry.applyCatalog({ supported: true, hubId, hosts: [host], projects: [project] });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const render = (mobile: boolean) => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project} registry={registry} mobile={mobile} reorderEnabled={false} /></QueryClientProvider>);
  try {
    await act(async () => render(true));
    await vi.waitFor(() => expect(container.querySelector('.yuri-mobile-session-title')?.textContent).toBe('Native isolation A session'));
    expect(container.querySelector('.yuri-mobile-project-shell.yuri-mobile-floating-surface')).not.toBeNull();
    expect(container.querySelector('.yuri-mobile-project-card')).not.toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.querySelector('[aria-label="remoteProjects.reorder"]')).toBeNull();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(container.textContent).not.toContain('remoteProjects.newFolder');
    const projectMenu = container.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.project.actions.projectMenu"]')!;
    await act(async () => projectMenu.click());
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain('remoteProjects.newFolder');
    const newFolder = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'remoteProjects.newFolder')!;
    await act(async () => newFolder.click());
    expect(document.querySelector('input[aria-label="sessions.sidebar.session.menu.rename"]')).not.toBeNull();
    // Close the editor through the normal dialog dismiss before exercising the session sheet.
    await act(async () => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    const sessionMenu = container.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.session.menu.label"]')!;
    await act(async () => sessionMenu.click());
    const pin = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find((button) => button.textContent === 'remoteProjects.pin')!;
    await act(async () => pin.click());
    await vi.waitFor(() => expect(fetch.mock.calls.some(([path]) => path.includes('/session/mobile-session/pin'))).toBe(true));
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => render(false));
    expect(container.querySelector('.yuri-mobile-project-card')).toBeNull();
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.querySelector('.yuri-group-body [data-session-title]')).not.toBeNull();
    await act(async () => {
      registry.applyCatalog({ supported: true, hubId, hosts: [{ ...host, state: 'offline' }], projects: [project] });
      render(true);
    });
    expect(container.textContent).not.toContain('remoteProjects.unknown');
    expect(container.textContent).not.toContain('remoteProjects.state.offline');
    expect(container.querySelector('[data-remote-host]')?.getAttribute('aria-label')).toContain('remoteProjects.state.offline');
    expect(container.querySelector('.yuri-mobile-session-title')?.textContent).toBe('Native isolation A session');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.session.menu.label"]')!.click());
    const offlineActions = [...container.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')];
    expect(offlineActions.length).toBeGreaterThan(0);
    expect(offlineActions.every((button) => button.disabled)).toBe(true);
    const callsBeforeDisabledClick = fetch.mock.calls.length;
    await act(async () => offlineActions[0].click());
    expect(fetch).toHaveBeenCalledTimes(callsBeforeDisabledClick);
  } finally {
    await act(async () => root.unmount()); container.remove(); registry.dispose(); queryClient.clear();
  }
});

it('desktop remote sessions use shared groups, activity-aware order, pagination and matching keyboard targets', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient.clear(); queryClient.setDefaultOptions({ queries: { retry: false } });
  useProjectsStore.setState({ projects: [project], activeProjectId: null, hubProjectLayout: null });
  let updated = 1;
  const session = (id: string, time: number) => ({ id, title: id, time: { created: time, updated: time } });
  const fetch = vi.fn(async () => Response.json({ hubId, hostId, stale: false,
    directories: [{ directory: project.path, sessions: [session('first', 4), session('second', 3), session('third', 2), session('fourth', updated)], hasMore: false },
      { directory: '/fixtures/checkout', sessions: [session('checkout-session', 5)], hasMore: false }],
    worktrees: { projectDirectories: { [project.path]: [project.path, '/fixtures/checkout'] }, staleProjectDirectories: [] },
    order: { sessionOrderByScope: { [project.path]: ['first', 'second', 'third', 'fourth'] }, sessionOrderActivityByScope: { [project.path]: { first: 4, second: 3, third: 2, fourth: 1 } } },
  }));
  const registry = new HostRuntimeRegistry(hubId, { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch,
    sdk: () => { throw new Error('Sidebar must not read transcripts'); } });
  registry.applyCatalog({ supported: true, hubId, hosts: [host], projects: [project] });
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  const targets = vi.fn();
  const rows = () => [...container.querySelectorAll('[data-session-row]')].map((row) => row.getAttribute('data-session-row'));
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project} registry={registry} onNavigationTargets={targets} /></QueryClientProvider>));
    await vi.waitFor(() => expect(rows()).toEqual(['first', 'second', 'third', 'checkout-session']));
    expect(container.textContent).not.toContain('remoteProjects.newFolder');
    expect(container.querySelector('input[type="checkbox"]')).toBeNull();
    expect(container.querySelector('[aria-label="remoteProjects.reorder"]')).toBeNull();
    expect(container.querySelectorAll('.yuri-group')).toHaveLength(2);
    updated = 10;
    await act(async () => { await queryClient.invalidateQueries({ queryKey: remoteHostSummariesQueryOptions(registry, hostId).queryKey }); });
    await vi.waitFor(() => expect(rows()).toEqual(['fourth', 'first', 'second', 'checkout-session']));
    expect(targets.mock.lastCall?.[1].map((target: { sessionId: string }) => target.sessionId)).toEqual(rows());
    const more = [...container.querySelectorAll('button')].find((button) => button.textContent === 'sessions.sidebar.group.showMore')!;
    await act(async () => more.click());
    expect(rows()).toEqual(['fourth', 'first', 'second', 'third', 'checkout-session']);
    expect(targets.mock.lastCall?.[1].map((target: { sessionId: string }) => target.sessionId)).toEqual(rows());
  } finally { await act(async () => root.unmount()); container.remove(); registry.dispose(); queryClient.clear(); }
});
