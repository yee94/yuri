import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HostRuntimeRegistry, type HostRuntimeDependencies } from '@/lib/remote-projects/registry';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import type { LocationOpencodeService } from '@/lib/opencode/client';
import type { RemoteProject } from '@/lib/remote-projects/types';
import { queryClient } from '@/lib/queryRuntime';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { RemoteProjectSection } from './sidebar/RemoteProjectSection';
import { remoteSummaryOptions, useRemoteProjectNavigation } from './sidebar/hooks/useRemoteProjectNavigation';
import * as desktop from '@/lib/desktop';
import { MobileChatHeader } from '@/mobile/chat/MobileChatHeader';
import { HostRuntimeContext } from '@/contexts/hostRuntimeContext';
import { getHostRuntimeServices } from '@/lib/remote-projects/runtime';
import type { DragEndEvent } from '@dnd-kit/core';
import type { SessionNavigationTarget } from '@/sync/session-navigation';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { toast } from '@/components/ui';
import type { PinnedItem } from './sidebar/SidebarPinnedSessions';

const mocks = vi.hoisted(() => ({ localDirectory: vi.fn(), localSelection: vi.fn(), events: new Set<(event: unknown) => void>(), dragContexts: new Map<string, (event: DragEndEvent) => void>() }));
vi.mock('@dnd-kit/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dnd-kit/core')>();
  return { ...actual, DndContext: (props: React.ComponentProps<typeof actual.DndContext>) => {
    for (const child of React.Children.toArray(props.children)) if (React.isValidElement<{ items?: string[] }>(child)) {
      for (const id of child.props.items ?? []) if (props.onDragEnd) mocks.dragContexts.set(id, props.onDragEnd);
    }
    return <actual.DndContext {...props} />;
  } };
});
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: vi.fn(async () => {}) }));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: (listener: (event: unknown) => void) => { mocks.events.add(listener); return () => mocks.events.delete(listener); } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => <span /> }));
vi.mock('@/components/gui-plugins/GuiPluginTitlebarItems', () => ({ GuiPluginTitlebarItems: () => null }));
vi.mock('@/components/ui/MobileResizableSheet', () => ({ MobileResizableSheet: ({ open, title, children }: { open: boolean; title: React.ReactNode; children: React.ReactNode }) => open ? <div role="dialog">{title}{children}</div> : null }));
vi.mock('@/components/session/sidebar/sortableItems', () => ({ SortableProjectItem: ({ children, projectLabel, projectIconSlot, onNewSession, onClose, onRenameStart, onToggle, isCollapsed, worktreeActionAvailable, onNewWorktreeSession }: { children: React.ReactNode; projectLabel: string; projectIconSlot?: React.ReactNode; onNewSession(): void; onClose(): void; onRenameStart(): void; onToggle(): void; isCollapsed: boolean; worktreeActionAvailable?: boolean; onNewWorktreeSession?(): void }) => <section><h2>{projectLabel}{projectIconSlot}</h2><button onClick={onNewSession}>new</button>{worktreeActionAvailable ? <button onClick={onNewWorktreeSession}>new-worktree</button> : null}<button onClick={onClose}>remove</button><button onClick={onRenameStart}>edit-project</button><button onClick={onToggle}>collapse</button>{!isCollapsed ? children : null}</section> }));
vi.mock('./NewWorktreeDialog', () => ({ NewWorktreeDialog: ({ projectId }: { projectId: string }) => <div data-worktree-project={projectId} /> }));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuItem: ({ children, onClick, disabled }: { children: React.ReactNode; onClick(): void; disabled?: boolean }) => <button disabled={disabled} onClick={onClick}>{children}</button>,
}));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>, DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

let root: Root;
let container: HTMLDivElement;
const project = (hostId: string): RemoteProject => ({ id: `ref-${hostId}`, hostId, remoteProjectId: 'project-same', path: 'C:\\Raw Path\\', label: `Project ${hostId}`, remoteState: 'ok' });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const snapshot = (hostId: string) => ({ hostId, stale: false, directories: [{ directory: project(hostId).path, sessions: [{ id: 'same-id', title: `Title ${hostId}`, time: { created: 1, updated: 2 }, metadata: { yuri: { sessionStatus: { type: 'busy' } } } }], hasMore: false }], unread: { revision: 1, sessions: {} }, folders: { version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 0 }, order: { revision: 1, sessionOrderByScope: {}, sessionOrderActivityByScope: {} } });
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
const click = async (label: string, scope: Element = container) => { const button = [...scope.querySelectorAll('button')].find((candidate) => candidate.textContent === label); expect(button, label).toBeTruthy(); await act(async () => button!.click()); await flush(); };

beforeEach(() => {
  vi.spyOn(toast, 'error').mockImplementation(() => 'remote-error');
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient.clear(); queryClient.setDefaultOptions({ queries: { retry: false } });
  useProjectsStore.setState({ projects: [project('a'), project('b')], activeProjectId: null, manualProjectOrder: [] });
  useSessionNavigationStore.getState().clearRemoteSession();
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); queryClient.clear(); container.remove(); vi.restoreAllMocks(); mocks.events.clear(); });

function registry(fetch: (path: string, init?: { method?: string; body?: BodyInit | null }) => Promise<Response>, sdk?: HostRuntimeDependencies['sdk'], service?: HostRuntimeDependencies['service']) {
  const entry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch, sdk: sdk ?? (() => { throw new Error('SDK not used'); }), service: service ?? (() => { throw new Error('Service not used'); }) });
  entry.applyCatalog({ supported: true, hubId: 'hub', hosts: ['a', 'b'].map((id) => ({ id, name: id, source: 'direct', state: 'connected' })), projects: [project('a'), project('b')] });
  return entry;
}

const renderedIds = (scope: Element = container) => [...scope.querySelectorAll('[data-remote-session]')].map((row) => row.getAttribute('data-remote-session'));
type RemoteDragItem = { kind: 'session' | 'folder'; directory: string; id: string };
const remoteDragId = (item: RemoteDragItem) => `${item.kind === 'session' ? 'session-drag' : 'folder-drop'}:${item.id}`;
const drag = async (source: RemoteDragItem, target: RemoteDragItem) => {
  await act(async () => mocks.dragContexts.get(remoteDragId(source))?.({ activatorEvent: new MouseEvent('mousedown'), collisions: null, delta: { x: 0, y: 0 },
    active: { id: remoteDragId(source), data: { current: { type: source.kind, sessionId: source.id, sessionDirectory: source.directory } }, rect: { current: { initial: null, translated: null } } },
    over: { id: remoteDragId(target), data: { current: { type: target.kind, folderId: target.id } }, rect: new DOMRect(), disabled: false } }));
  await flush(); await flush();
};
test.each([
  { mobile: true, legacyPinned: false, offline: false },
  { mobile: true, legacyPinned: true, offline: false },
  { mobile: true, legacyPinned: true, offline: true },
  { mobile: false, legacyPinned: true, offline: false },
  { mobile: false, legacyPinned: true, offline: true },
])('remote pin can be undone from the leading row and stays undone after remount (%j)', async ({ mobile, legacyPinned, offline }) => {
  let pinned = true;
  let failNext = true;
  const methods: string[] = [];
  const data = snapshot('a');
  const fetch = vi.fn(async (path: string, init?: { method?: string }) => {
    if (path.endsWith('/pin')) {
      methods.push(init?.method ?? 'GET');
      if (failNext) { failNext = false; return json({ error: 'injected pin write failure' }, 500); }
      pinned = init?.method === 'POST';
      return new Response(null, { status: 204 });
    }
    return json({ ...data, pinnedSessionIds: pinned ? ['same-id'] : [], directories: [{
      ...data.directories[0], sessions: [{ ...data.directories[0].sessions[0],
        time: { created: 1, updated: 2, ...(legacyPinned ? { pinned: 1 } : {}) },
        metadata: { yuri: { sessionStatus: { type: 'idle' } } },
      }],
    }] });
  });
  const entry = registry(fetch);
  const remoteProject = project('a');
  if (offline) entry.applyCatalog({ supported: true, hubId: 'hub', projects: [remoteProject], hosts: [
    { id: 'a', name: 'Remote', source: 'direct', state: 'offline' },
  ] });
  function Home() {
    const [items, setItems] = React.useState<PinnedItem[]>([]);
    const publish = React.useMemo(() => (_project: string, next: PinnedItem[]) => setItems(next), []);
    return <><div data-leading-pins>{items.filter((item) => item.pinned).map((item) => <React.Fragment key={item.identity}>{item.content}</React.Fragment>)}</div>
      <RemoteProjectSection project={remoteProject} registry={entry} mobile={mobile} onActivityItems={publish} /></>;
  }
  const rowSelector = mobile ? '.yuri-mobile-session-title' : '[data-session-title]';
  const toggle = async (scope: Element, action: 'pin' | 'unpin') => {
    if (mobile) {
      await act(async () => scope.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.session.menu.label"]')!.click());
      const dialog = document.querySelector('[role="dialog"]')!;
      expect(dialog.textContent).not.toContain(`remoteProjects.${action === 'pin' ? 'unpin' : 'pin'}`);
      await click(`remoteProjects.${action}`, dialog);
    } else {
      const button = scope.querySelector<HTMLButtonElement>(`[aria-label="remoteProjects.${action}"]`)!;
      expect(button.disabled).toBe(false);
      await act(async () => button.click());
    }
    await flush(); await flush();
  };
  const render = (key: string) => root.render(<QueryClientProvider client={queryClient}><Home key={key} /></QueryClientProvider>);
  await act(async () => render('first'));
  await flush(); await flush();
  const leading = container.querySelector('[data-leading-pins]')!;
  expect(leading.querySelector(rowSelector)?.textContent).toContain('Title a');
  await toggle(leading, 'unpin');
  expect(methods).toEqual(['DELETE']);
  expect(leading.querySelector(rowSelector)).not.toBeNull();
  expect(toast.error).toHaveBeenCalledWith('injected pin write failure');
  await toggle(leading, 'unpin');
  expect(methods).toEqual(['DELETE', 'DELETE']);
  expect(leading.querySelector(rowSelector)).toBeNull();
  await act(async () => render('second'));
  await flush(); await flush();
  expect(container.querySelector(`[data-leading-pins] ${rowSelector}`)).toBeNull();
  await toggle(container, 'pin');
  expect(methods).toEqual(['DELETE', 'DELETE', 'POST']);
  expect(container.querySelector(`[data-leading-pins] ${rowSelector}`)?.textContent).toContain('Title a');
});
test.each([false, true])('remote project omits archives without dropping active nested-directory sessions (mobile=%s)', async (mobile) => {
  const original = snapshot('a');
  const directory = `${project('a').path}/nested`;
  const data = { ...original, directories: [...original.directories, { ...original.directories[0], directory, sessions: [
    { ...original.directories[0].sessions[0], id: 'nested-active', title: 'Nested active', directory },
    { ...original.directories[0].sessions[0], id: 'archived-only', title: 'Archived only', directory, time: { created: 1, updated: 1, archived: 2 } },
  ] }] };
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={registry(async () => json(data))} mobile={mobile} /></QueryClientProvider>));
  await flush(); await flush();
  expect(container.textContent).toContain('Nested active');
  expect(container.textContent).not.toContain('Archived only');
  expect(container.textContent).not.toContain('sessions.sidebar.grouping.archived');
});

test('remote running and unread sessions join the shared leading list and disappear after read acknowledgement', async () => {
  const data = snapshot('a');
  const entry = registry(async () => json(data));
  const activity = vi.fn();
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} onActivityItems={activity} /></QueryClientProvider>));
  await flush(); await flush();
  expect(activity.mock.lastCall?.[1].map((item: { remoteSessionId: string }) => item.remoteSessionId)).toEqual(['same-id']);
  const idle = { ...data, pinnedSessionIds: [], directories: data.directories.map((directory) => ({ ...directory, sessions: directory.sessions.map((session) => ({ ...session, directory: directory.directory, metadata: { yuri: { sessionStatus: { type: 'idle' } } } })) })),
    unread: { revision: 2, sessions: { 'same-id': { unreadCount: 1, revision: 2 } } } };
  await act(async () => { queryClient.setQueryData(remoteSummaryOptions(entry, 'a').queryKey, idle); });
  await flush();
  expect(activity.mock.lastCall?.[1]).toHaveLength(1);
  await act(async () => { queryClient.setQueryData(remoteSummaryOptions(entry, 'a').queryKey, { ...idle, unread: { revision: 3, sessions: {} } }); });
  await flush();
  expect(activity.mock.lastCall?.[1]).toEqual([]);
});

test.each([false, true])('remote pinned rows retain project subtitles in the leading list (mobile=%s)', async (mobile) => {
  const value = snapshot('a');
  const base = value.directories[0].sessions[0];
  const data = { ...value, pinnedSessionIds: ['pin-a', 'pin-b'], unread: { revision: 1, sessions: {} }, directories: [{ ...value.directories[0], sessions: [
    { ...base, id: 'pin-a', title: 'pin-a', time: { created: 1, updated: 1 }, metadata: { yuri: { sessionStatus: { type: 'idle' } } } },
    { ...base, id: 'pin-b', title: 'pin-b', time: { created: 2, updated: 2 }, metadata: { yuri: { sessionStatus: { type: 'busy' } } } },
    { ...base, id: 'plain', title: 'plain', time: { created: 3, updated: 3 }, metadata: { yuri: { sessionStatus: { type: 'idle' } } } },
  ] }] };
  const activity = vi.fn();
  const entry = registry(async () => json(data));
  entry.applyCatalog({ supported: true, hubId: 'hub', projects: [project('a'), project('b')], hosts: [
    { id: 'a', name: 'user@development.example.com', source: 'ssh', state: 'connected' },
    { id: 'b', name: 'Other machine', source: 'direct', state: 'connected' },
  ] });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} mobile={mobile} onActivityItems={activity} /></QueryClientProvider>));
  await flush(); await flush();
  const items = activity.mock.lastCall?.[1] as Array<{ remoteSessionId: string; pinned: boolean; content: React.ReactNode }>;
  expect(items.map((item) => [item.remoteSessionId, item.pinned])).toEqual([['pin-b', true], ['pin-a', true]]);
  const leading = document.createElement('div');
  document.body.append(leading);
  const leadingRoot = createRoot(leading);
  try {
    await act(async () => leadingRoot.render(<>{items.map((item) => <React.Fragment key={item.remoteSessionId}>{item.content}</React.Fragment>)}</>));
    const titles = leading.querySelectorAll(mobile ? '.yuri-mobile-session-title' : '[data-session-title]');
    expect(titles).toHaveLength(2);
    expect([...leading.querySelectorAll('span')].filter((span) => span.textContent === 'Project a').length).toBeGreaterThanOrEqual(2);
    const identities = [...leading.querySelectorAll('[data-remote-host]')];
    expect(identities).toHaveLength(2);
    expect(identities.every((element) => element.getAttribute('data-remote-host') === 'a'
      && element.textContent === 'development.example.com'
      && element.getAttribute('aria-label')?.includes('user@development.example.com'))).toBe(true);
    expect(leading.textContent).not.toContain('Other machine');
    if (mobile) expect([...leading.querySelectorAll('.yuri-mobile-session-subtitle')].map((element) => element.textContent)).toEqual(['Project adevelopment.example.com', 'Project adevelopment.example.com']);
  } finally {
    await act(async () => leadingRoot.unmount());
    leading.remove();
  }
});

function folderFixture() {
  const value = snapshot('a');
  const session = (id: string, created: number, updated: number) => ({ ...value.directories[0].sessions[0], id, title: id, time: { created, updated } });
  const directory = project('a').path;
  const folders: SessionFolder[] = [
    { id: 'child', name: 'Child folder', parentId: 'parent', createdAt: 1, sessionIds: ['child-session'] },
    { id: 'parent', name: 'Parent folder', parentId: null, createdAt: 1, sessionIds: ['parent-session'] },
    { id: 'other', name: 'Other folder', parentId: null, createdAt: 1, sessionIds: ['other-session'] },
  ];
  return { ...value, directories: [{ ...value.directories[0], sessions: [session('root-session', 1, 999), session('parent-session', 2, 3), session('child-session', 3, 4), session('other-session', 4, 5)] }],
    folders: { ...value.folders, foldersMap: { [directory]: folders } } };
}

test('pinned order wins over explicit order and newest unpinned activity in both real rows and keyboard targets', async () => {
  const value = snapshot('a');
  const base = value.directories[0].sessions[0];
  const data = { ...value, pinnedSessionIds: ['old-pin', 'new-pin'], directories: [{ ...value.directories[0], pinnedSessionIds: ['old-pin', 'new-pin'], sessions: [
    { ...base, id: 'unpinned', title: 'unpinned', time: { created: 100, updated: 9999 } },
    { ...base, id: 'old-pin', title: 'old-pin', time: { created: 1, updated: 999 } },
    { ...base, id: 'new-pin', title: 'new-pin', time: { created: 2, updated: 2 } },
  ] }], order: { ...value.order, sessionOrderByScope: { [project('a').path]: ['unpinned', 'old-pin', 'new-pin'] } } };
  const targets = vi.fn<(_project: string, targets: SessionNavigationTarget[]) => void>();
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={registry(async () => json(data))} onNavigationTargets={targets} /></QueryClientProvider>));
  await flush(); await flush();
  expect(renderedIds()).toEqual(['new-pin', 'old-pin', 'unpinned']);
  expect(targets.mock.lastCall?.[1].map((target) => target.sessionId)).toEqual(renderedIds());
});

test('remote project header opens the shared dialog for its explicit reference even without checkout aliases', async () => {
  const data = { ...snapshot('a'), worktrees: { projectDirectories: { [project('a').path]: [] }, staleProjectDirectories: [] } };
  const fetch = vi.fn(async () => json(data)); const entry = registry(fetch);
  useProjectsStore.setState({ activeProjectId: project('b').id });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush(); const calls = fetch.mock.calls.length;
  await click('new-worktree');
  expect(container.querySelector('[data-worktree-project]')?.getAttribute('data-worktree-project')).toBe(project('a').id);
  expect(useProjectsStore.getState().activeProjectId).toBe(project('a').id);
  expect(fetch).toHaveBeenCalledTimes(calls);
  expect(useSessionNavigationStore.getState().remoteSession).toBeNull();
});

test('Host-authoritative external worktrees appear under the owning project without stealing a more specific remote project', async () => {
  const value = snapshot('a'); const external = 'D:\\External checkout\\'; const nested = `${external}nested`;
  useProjectsStore.setState((state) => ({ projects: [...state.projects, { ...project('a'), id: 'nested-reference', path: nested }] }));
  const base = value.directories[0].sessions[0];
  const data = { ...value, worktrees: { projectDirectories: { [project('a').path]: [external] }, staleProjectDirectories: [] },
    directories: [...value.directories,
      { ...value.directories[0], directory: external, sessions: [{ ...base, id: 'external-session', title: 'External worktree session' }] },
      { ...value.directories[0], directory: nested, sessions: [{ ...base, id: 'nested-session', title: 'Other explicit project session' }] }] };
  const entry = registry(async () => json(data));
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  expect(renderedIds()).toContain('external-session'); expect(renderedIds()).not.toContain('nested-session');
  await click('External worktree session');
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ projectId: project('a').id, sessionId: 'external-session', location: { hubId: 'hub', hostId: 'a', directory: external } });
});

test('desktop shared folders render parentId recursively and keyboard order follows the same nested/collapsed tree', async () => {
  const data = folderFixture();
  const targets = vi.fn<(_project: string, targets: SessionNavigationTarget[]) => void>();
  const fetch = vi.fn(async (path: string, init?: { method?: string; body?: BodyInit | null }) => {
    if (path.endsWith('/summaries')) return json(data);
    if (init?.method === 'POST') data.folders = JSON.parse(String(init.body));
    return json(data.folders);
  });
  const entry = registry(fetch);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} onNavigationTargets={targets} /></QueryClientProvider>));
  await flush(); await flush();
  expect(container.querySelector('[data-session-folder="parent"] [data-session-folder="child"]')).not.toBeNull();
  expect(renderedIds()).toEqual(['child-session', 'parent-session', 'other-session', 'root-session']);
  expect(targets.mock.lastCall?.[1].map((target) => target.sessionId)).toEqual(renderedIds());
  const parentHeader = container.querySelector<HTMLElement>('[data-session-folder="parent"] [aria-label="sessions.sidebar.folderItem.collapseAria"]')!;
  await act(async () => parentHeader.click()); await flush(); await flush();
  expect(targets.mock.lastCall?.[1].map((target) => target.sessionId)).toEqual(['other-session', 'root-session']);
});

test('shared desktop drag moves sessions across folders on the captured Host without introducing folder-only drag behavior', async () => {
  const data = folderFixture(); const directory = project('a').path;
  const fetch = vi.fn(async (path: string, init?: { method?: string; body?: BodyInit | null }) => {
    if (path.endsWith('/summaries')) return json(data);
    if (init?.method === 'POST') data.folders = JSON.parse(String(init.body));
    return json(data.folders);
  });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={registry(fetch)} /></QueryClientProvider>));
  await flush(); await flush();
  await drag({ kind: 'session', directory, id: 'child-session' }, { kind: 'folder', directory, id: 'other' });
  expect(data.folders.foldersMap[directory].find((folder) => folder.id === 'child')?.sessionIds).toEqual([]);
  expect(data.folders.foldersMap[directory].find((folder) => folder.id === 'other')?.sessionIds).toEqual(['other-session', 'child-session']);
  expect(renderedIds(container.querySelector('[data-session-folder="other"]')!)).toEqual(['other-session', 'child-session']);
  await drag({ kind: 'folder', directory, id: 'other' }, { kind: 'folder', directory, id: 'child' });
  expect(data.folders.foldersMap[directory].find((folder) => folder.id === 'other')?.parentId).toBeNull();
  fetch.mockClear();
  await drag({ kind: 'folder', directory, id: 'parent' }, { kind: 'folder', directory, id: 'other' });
  expect(fetch).not.toHaveBeenCalled();
});

test('mobile uses the existing flat project list and compact pagination, not a remote-only folder tree', async () => {
  const data = folderFixture();
  for (const session of data.directories[0].sessions) session.metadata.yuri.sessionStatus.type = 'idle';
  const fetch = vi.fn(async () => json(data));
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={registry(fetch)} mobile /></QueryClientProvider>));
  await flush(); await flush();
  const titles = () => [...container.querySelectorAll('.yuri-mobile-session-title')].map((node) => node.textContent);
  expect(titles()).toEqual(['root-session', 'other-session', 'child-session']);
  expect(container.querySelector('[data-session-folder]')).toBeNull();
  expect(container.querySelector('input[type="checkbox"]')).toBeNull();
  await click('sessions.sidebar.group.showMore');
  expect(titles()).toEqual(['root-session', 'other-session', 'child-session', 'parent-session']);
  await click('sessions.sidebar.group.showFewer');
  expect(titles()).toEqual(['root-session', 'other-session', 'child-session']);
});

test('failed shared same-folder reorder leaves membership, confirmed order and selection intact', async () => {
  const data = folderFixture(); const directory = project('a').path;
  data.folders.foldersMap[directory].find((folder) => folder.id === 'child')!.sessionIds.push('parent-session');
  data.folders.foldersMap[directory].find((folder) => folder.id === 'parent')!.sessionIds = [];
  const original = structuredClone(data.folders);
  const fetch = vi.fn(async (path: string, init?: { method?: string; body?: BodyInit | null }) => {
    if (path.endsWith('/summaries')) return json(data);
    if (path.endsWith('/order')) return json({ error: 'order write failed' }, 503);
    if (init?.method === 'POST') data.folders = JSON.parse(String(init.body));
    return json(data.folders);
  });
  const entry = registry(fetch);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  const before = queryClient.getQueryData(remoteSummaryOptions(entry, 'a').queryKey);
  await act(async () => container.querySelector('[data-remote-session="child-session"] [data-session-title]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
  await drag({ kind: 'session', directory, id: 'child-session' }, { kind: 'session', directory, id: 'parent-session' });
  expect(data.folders.foldersMap).toEqual(original.foldersMap);
  expect(queryClient.getQueryData(remoteSummaryOptions(entry, 'a').queryKey)).toBe(before);
  expect(renderedIds(container.querySelector('[data-session-folder="child"]')!)).toEqual(['child-session', 'parent-session']);
  expect(toast.error).toHaveBeenCalledWith('order write failed');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.querySelector('[data-remote-session="child-session"]')?.getAttribute('data-session-selected')).toBe('true');
  const writes = fetch.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes.map(([path]) => path)).toEqual(['/api/hosts/a/api/session-folders/order']);
});

test('a selected group moves together across folders and clears selection only after Host confirmation', async () => {
  const data = folderFixture(); const directory = project('a').path;
  const fetch = vi.fn(async (path: string, init?: { method?: string; body?: BodyInit | null }) => {
    if (path.endsWith('/summaries')) return json(data);
    if (init?.method === 'POST') data.folders = JSON.parse(String(init.body));
    return json(data.folders);
  });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={registry(fetch)} /></QueryClientProvider>));
  await flush(); await flush();
  for (const id of ['parent-session', 'child-session']) await act(async () => container.querySelector(`[data-remote-session="${id}"] [data-session-title]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })));
  await drag({ kind: 'session', directory, id: 'child-session' }, { kind: 'folder', directory, id: 'other' });
  expect(data.folders.foldersMap[directory].find((folder) => folder.id === 'other')?.sessionIds).toEqual(['other-session', 'parent-session', 'child-session']);
  expect(container.querySelectorAll('[data-session-selected="true"]')).toHaveLength(0);
});

test('a Host generation change during folder body decoding cannot write a stale tree through a new entry', async () => {
  const data = folderFixture(); const directory = project('a').path;
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/summaries')) return json(data);
    const response = json(data.folders); const decode = response.json.bind(response);
    response.json = async () => {
      const value = await decode();
      entry.applyCatalog({ supported: true, hubId: 'hub', projects: [project('a'), project('b')], hosts: ['a', 'b'].map((id) => ({ id, name: id, source: 'direct', state: id === 'a' ? 'offline' : 'connected' })) });
      return value;
    };
    return response;
  });
  const entry = registry(fetch);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush(); fetch.mockClear();
  await drag({ kind: 'session', directory, id: 'other-session' }, { kind: 'folder', directory, id: 'child' });
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/hosts/a/api/session-folders']);
  expect(renderedIds(container.querySelector('[data-session-folder="child"]')!)).toEqual(['child-session']);
  expect(toast.error).toHaveBeenCalledWith('remoteProjects.host-unavailable');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test('shared folder actions preserve failed mutations and deletion releases descendant sessions', async () => {
  const data = folderFixture(); const directory = project('a').path; let rejectFolderWrite = false;
  const targets = vi.fn<(_project: string, targets: SessionNavigationTarget[]) => void>();
  const fetch = vi.fn(async (path: string, init?: { method?: string; body?: BodyInit | null }) => {
    if (path.endsWith('/summaries')) return json(data);
    if (init?.method === 'POST') {
      if (rejectFolderWrite) return json({ error: 'folder write rejected' }, 503);
      data.folders = JSON.parse(String(init.body));
    }
    return json(data.folders);
  });
  const entry = registry(fetch);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} onNavigationTargets={targets} /></QueryClientProvider>));
  await flush(); await flush();
  expect(renderedIds()).toEqual(['child-session', 'parent-session', 'other-session', 'root-session']);
  expect(targets.mock.lastCall?.[1].map((target) => target.sessionId)).toEqual(renderedIds());
  const before = queryClient.getQueryData(remoteSummaryOptions(entry, 'a').queryKey);
  rejectFolderWrite = true;
  await drag({ kind: 'session', directory, id: 'other-session' }, { kind: 'folder', directory, id: 'child' });
  expect(queryClient.getQueryData(remoteSummaryOptions(entry, 'a').queryKey)).toBe(before);
  expect(renderedIds(container.querySelector('[data-session-folder="child"]')!)).toEqual(['child-session']);
  expect(toast.error).toHaveBeenCalledWith('folder write rejected');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  rejectFolderWrite = false;
  const parent = container.querySelector('[data-session-folder="parent"]')!;
  await act(async () => parent.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.folderItem.deleteFolderAria"]')!.click());
  await flush(); await flush();
  expect(data.folders.foldersMap[directory].map((folder) => folder.id)).toEqual(['other']);
  expect(renderedIds()).toEqual(['other-session', 'root-session', 'child-session', 'parent-session']);
});

test('new sub-folder action on the shared folder UI writes its actual parentId and keeps the editor open on failure', async () => {
  const data = folderFixture(); const directory = project('a').path; let reject = true;
  const fetch = vi.fn(async (path: string, init?: { method?: string; body?: BodyInit | null }) => {
    if (path.endsWith('/summaries')) return json(data);
    if (init?.method === 'POST') {
      if (reject) return json({ error: 'create failed' }, 503);
      data.folders = JSON.parse(String(init.body));
    }
    return json(data.folders);
  });
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={registry(fetch)} /></QueryClientProvider>));
  await flush(); await flush();
  const child = container.querySelector('[data-session-folder="child"]')!;
  await act(async () => child.querySelector<HTMLButtonElement>('[aria-label="sessions.sidebar.folderItem.newSubfolderAria"]')!.click());
  const input = container.querySelector<HTMLInputElement>('form input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Grandchild folder'); input.dispatchEvent(new Event('input', { bubbles: true })); });
  await click('sessions.sidebar.session.rename.save');
  expect(container.querySelector('form input')).not.toBeNull();
  expect(toast.error).toHaveBeenCalledWith('create failed');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  reject = false;
  await click('sessions.sidebar.session.rename.save');
  const created = data.folders.foldersMap[directory].find((folder) => folder.name === 'Grandchild folder');
  expect(created?.parentId).toBe('child');
  expect(container.querySelector(`[data-session-folder="parent"] [data-session-folder="child"] [data-session-folder="${created?.id}"]`)).not.toBeNull();
});

test('the shared remote folder New action opens a Host draft with targetFolderId, never a local draft', async () => {
  const data = folderFixture(); const entry = registry(async () => json(data));
  const localDirectory = vi.spyOn(useDirectoryStore.getState(), 'setDirectory');
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  await act(async () => container.querySelector<HTMLButtonElement>('[data-session-folder="child"] [aria-label="sessions.sidebar.folderItem.newSessionAria"]')!.click());
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ sessionId: null, location: { hubId: 'hub', hostId: 'a', directory: project('a').path }, draft: { targetFolderId: 'child' } });
  expect(localDirectory).not.toHaveBeenCalled();
});

test('mounted remote sections load Hub snapshots and select same raw session ID without touching local directory', async () => {
  const localDirectory = vi.spyOn(useDirectoryStore.getState(), 'setDirectory');
  const fetch = vi.fn(async (path: string) => json(snapshot(path.includes('/a/') ? 'a' : 'b')));
  const entry = registry(fetch);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /><RemoteProjectSection project={project('b')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  expect(container.textContent).toContain('Title a'); expect(container.textContent).toContain('Title b');
  await click('Title b');
  expect(useSessionNavigationStore.getState().remoteSession).toEqual({ projectId: 'ref-b', location: { hubId: 'hub', hostId: 'b', directory: 'C:\\Raw Path\\' }, sessionId: 'same-id' });
  expect(localDirectory).not.toHaveBeenCalled();
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/hosts/a/summaries', '/api/hosts/b/summaries']);
  await click('new', container.querySelector('section')!);
  expect(useSessionNavigationStore.getState().remoteSession?.sessionId).toBeNull();
  expect(useSessionNavigationStore.getState().remoteSession?.location.hostId).toBe('a');
});

test('pin writes go only to the selected Host; failed write preserves prior summary and exposes retry', async () => {
  let fail = true;
  const fetch = vi.fn(async (path: string) => path.endsWith('/summaries') ? json(snapshot('a')) : json({ error: 'denied by remote' }, fail ? 503 : 200));
  const entry = registry(fetch);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  const before = queryClient.getQueryData(remoteSummaryOptions(entry, 'a').queryKey);
  await click('remoteProjects.pin');
  expect(fetch).toHaveBeenCalledWith('/api/hosts/a/api/yuri/session-index/session/same-id/pin', expect.objectContaining({ method: 'POST' }));
  expect(queryClient.getQueryData(remoteSummaryOptions(entry, 'a').queryKey)).toBe(before);
  expect(toast.error).toHaveBeenCalledWith('denied by remote');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  fail = false;
  await click('remoteProjects.pin');
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test('token events create zero summary requests; offline hosts preserve rows without adding a status banner', async () => {
  const fetch = vi.fn(async (path: string) => json(snapshot(path.includes('/a/') ? 'a' : 'b')));
  const entry = registry(fetch);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /><RemoteProjectSection project={project('b')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  fetch.mockClear();
  const beforeB = queryClient.getQueryData(remoteSummaryOptions(entry, 'b').queryKey);
  await act(async () => {
    for (let index = 0; index < 50; index++) for (const listener of mocks.events) listener({ type: 'remote-host-event', envelope: { type: 'yuri:host-event', properties: { hubId: 'hub', hostId: 'a', payload: { type: 'message.part.delta', properties: {} } } } });
  });
  await flush(); expect(fetch).not.toHaveBeenCalled();
  await act(async () => { for (const listener of mocks.events) listener({ type: 'remote-host-status', envelope: { type: 'yuri:host-status', properties: { hubId: 'hub', hostId: 'a', host: { id: 'a', name: 'a', source: 'direct', state: 'offline' } } } }); });
  await flush();
  expect(container.textContent).not.toContain('remoteProjects.unknown');
  expect(container.textContent).not.toContain('remoteProjects.state.offline');
  expect(container.textContent).toContain('Title a'); expect(container.textContent).toContain('Title b');
  expect(queryClient.getQueryData(remoteSummaryOptions(entry, 'b').queryKey)).toBe(beforeB);
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/hosts/a/summaries']);
});

test('remote rename uses the captured Host service and raw directory, without a local session mutation', async () => {
  const updateSession = vi.fn(async () => ({}));
  const resolveService = vi.fn(() => ({ updateSession }) as unknown as LocationOpencodeService);
  const entry = registry(async () => json(snapshot('a')), undefined, resolveService);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  await click('sessions.sidebar.session.menu.rename');
  await click('sessions.sidebar.session.rename.save');
  expect(resolveService).toHaveBeenCalledWith(expect.objectContaining({ hubId: 'hub', hostId: 'a', directory: 'C:\\Raw Path\\' }), expect.anything(), expect.anything());
  expect(updateSession).toHaveBeenCalledWith('same-id', { title: 'Title a' }, 'C:\\Raw Path\\');
});

test('remote delete requires confirmation, keeps failures retryable, deduplicates submissions and clears only the matching selection', async () => {
  let deleted = false;
  let fail = true;
  let finish!: () => void;
  const deleteSession = vi.fn(async () => {
    if (fail) throw new Error('Delete denied');
    await new Promise<void>((resolve) => { finish = resolve; });
    deleted = true;
    return true;
  });
  const resolveService = vi.fn(() => ({ deleteSession }) as unknown as LocationOpencodeService);
  const fetch = vi.fn(async () => { const value = snapshot('a'); if (deleted) value.directories[0].sessions = []; return json(value); });
  const entry = registry(fetch, () => ({} as OpenCodeClient), resolveService);
  useSessionNavigationStore.getState().openRemoteSession(project('a'), { hubId: 'hub', hostId: 'a', directory: project('a').path }, 'same-id');
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  await click('sessions.sidebar.dialogs.deleteSession.titleAction');
  expect(deleteSession).not.toHaveBeenCalled();
  await click('sessions.sidebar.dialogs.cancel');
  expect(deleteSession).not.toHaveBeenCalled();
  await click('sessions.sidebar.dialogs.deleteSession.titleAction');
  await click('sessions.sidebar.bulkActions.delete');
  expect(toast.error).toHaveBeenCalledWith('Delete denied');
  expect(renderedIds()).toEqual(['same-id']);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain('Delete denied');
  expect(container.textContent).toContain('sessions.sidebar.dialogs.deleteSession.title');
  expect(useSessionNavigationStore.getState().remoteSession?.sessionId).toBe('same-id');
  fail = false;
  await click('sessions.sidebar.bulkActions.delete');
  await click('sessions.sidebar.bulkActions.delete');
  expect(deleteSession).toHaveBeenCalledTimes(2);
  await act(async () => finish()); await flush();
  expect(deleteSession).toHaveBeenLastCalledWith('same-id', project('a').path);
  expect(resolveService).toHaveBeenLastCalledWith(expect.objectContaining({ hubId: 'hub', hostId: 'a', directory: project('a').path }), expect.anything(), expect.anything());
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ sessionId: null, location: { hostId: 'a', directory: project('a').path } });
  expect(renderedIds()).toEqual([]);
});

test('remote delete never clears a later selection on another Host with the same session ID', async () => {
  let finish!: (value: boolean) => void;
  const deleteSession = vi.fn(() => new Promise<boolean>((resolve) => { finish = resolve; }));
  const entry = registry(async () => json(snapshot('a')), () => ({} as OpenCodeClient), () => ({ deleteSession }) as unknown as LocationOpencodeService);
  useSessionNavigationStore.getState().openRemoteSession(project('a'), { hubId: 'hub', hostId: 'a', directory: project('a').path }, 'same-id');
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  await click('sessions.sidebar.dialogs.deleteSession.titleAction');
  await click('sessions.sidebar.bulkActions.delete');
  useSessionNavigationStore.getState().openRemoteSession(project('b'), { hubId: 'hub', hostId: 'b', directory: project('b').path }, 'same-id');
  const later = useSessionNavigationStore.getState().remoteSession;
  await act(async () => finish(true)); await flush();
  expect(useSessionNavigationStore.getState().remoteSession).toBe(later);
});

test('delete confirmation retains the captured Host entry and refuses a changed authorization scope', async () => {
  const deleteSession = vi.fn(async () => true);
  const entry = registry(async () => json(snapshot('a')), () => ({} as OpenCodeClient), () => ({ deleteSession }) as unknown as LocationOpencodeService);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  await click('sessions.sidebar.dialogs.deleteSession.titleAction');
  await act(async () => { entry.applyCatalog({ supported: true, hubId: 'hub', hosts: [{ id: 'a', name: 'replacement', source: 'direct', state: 'connected', scopeGeneration: 'new-authorization' }], projects: [project('a')] }); });
  await click('sessions.sidebar.bulkActions.delete');
  expect(deleteSession).not.toHaveBeenCalled();
  expect(toast.error).toHaveBeenCalled();
  expect(renderedIds()).toEqual(['same-id']);
});

test('bulk remote delete retains only failed targets and retries them without deleting successful sessions twice', async () => {
  let fail = true;
  const removed = new Set<string>();
  const deleteSession = vi.fn(async (id: string) => {
    if (id === 'failed' && fail) throw new Error('Partial delete failed');
    removed.add(id); return true;
  });
  const value = snapshot('a');
  const sessions = ['ok', 'failed'].map((id) => ({ ...value.directories[0].sessions[0], id, title: id }));
  const entry = registry(async () => json({ ...value, directories: [{ ...value.directories[0], sessions: sessions.filter((session) => !removed.has(session.id)) }] }), () => ({} as OpenCodeClient), () => ({ deleteSession }) as unknown as LocationOpencodeService);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  await act(async () => { for (const row of container.querySelectorAll<HTMLElement>('[data-session-title]')) row.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); });
  await click('sessions.sidebar.bulkActions.delete');
  const confirms = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === 'sessions.sidebar.bulkActions.delete');
  await act(async () => confirms.at(-1)!.click()); await flush();
  expect(deleteSession.mock.calls.map(([id]) => id).sort()).toEqual(['failed', 'ok']);
  expect(renderedIds()).toEqual(['failed']);
  expect(toast.error).toHaveBeenCalledWith('Partial delete failed');
  expect(container.querySelector('[role="alert"]')).toBeNull();
  fail = false;
  const retry = [...container.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent === 'sessions.sidebar.bulkActions.delete').at(-1)!;
  await act(async () => retry.click()); await flush();
  expect(deleteSession.mock.calls.filter(([id]) => id === 'ok')).toHaveLength(1);
  expect(deleteSession.mock.calls.filter(([id]) => id === 'failed')).toHaveLength(2);
  expect(renderedIds()).toEqual([]);
});

test('failed remote child loading reports outside the tree, retains cached children and retries through the toast action', async () => {
  let fail = false;
  const list = vi.fn(async () => {
    if (fail) throw new Error('Child read failed');
    return { data: [{ id: 'child', title: 'Child cached', parentID: 'same-id', time: { created: 1, updated: 1 }, location: { directory: project('a').path } }], cursor: {} };
  });
  const value = snapshot('a');
  const entry = registry(async () => json({ ...value, directories: [{ ...value.directories[0], sessions: [{ ...value.directories[0].sessions[0], hasChildren: true }] }] }), () => ({ session: { list } }) as unknown as OpenCodeClient);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush(); await click('sessions.sidebar.session.subsessions.expand');
  expect(container.textContent).toContain('Child cached');
  fail = true;
  await act(async () => { await queryClient.invalidateQueries({ queryKey: [...entry.resolve({ hubId: 'hub', hostId: 'a', directory: project('a').path }).queryScope, 'navigation-children'] }); });
  await flush();
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).not.toContain('Child read failed');
  expect(container.textContent).toContain('Child cached');
  expect(toast.error).toHaveBeenCalledWith('Child read failed', expect.objectContaining({ action: expect.objectContaining({ label: 'remoteProjects.retry' }) }));
  const action = vi.mocked(toast.error).mock.lastCall?.[1]?.action;
  fail = false;
  await act(async () => { if (action && typeof action === 'object' && 'onClick' in action) action.onClick({} as React.MouseEvent<HTMLButtonElement>); });
  await flush();
  expect(list).toHaveBeenCalledTimes(3);
});

test('children are loaded only on expansion through the same Host SDK, then navigate with raw child identity', async () => {
  const list = vi.fn(async () => ({ data: [{ id: 'child', parentID: 'same-id', title: 'Child a', time: { created: 1, updated: 2 }, location: { directory: project('a').path } }], cursor: {} }));
  const resolveSdk = vi.fn(() => ({ session: { list } }) as unknown as OpenCodeClient);
  const entry = registry(async () => { const value = snapshot('a'); return json({ ...value, directories: [{ ...value.directories[0], sessions: [{ ...value.directories[0].sessions[0], hasChildren: true }] }] }); }, resolveSdk);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush(); expect(list).not.toHaveBeenCalled();
  await click('sessions.sidebar.session.subsessions.expand');
  expect(resolveSdk).toHaveBeenCalledWith(expect.objectContaining({ hubId: 'hub', hostId: 'a', directory: project('a').path }), expect.anything(), expect.anything());
  expect(list).toHaveBeenCalledWith(expect.objectContaining({ parentID: 'same-id', directory: project('a').path }), expect.objectContaining({ signal: expect.any(AbortSignal) }));
  await click('Child a');
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ sessionId: 'child', location: { hubId: 'hub', hostId: 'a', directory: project('a').path } });
});

test('expanded children share pin/time sorting and exact visible keyboard order, and collapse removes their targets', async () => {
  const value = snapshot('a');
  const data = { ...value, pinnedSessionIds: ['child-pin'], directories: [{ ...value.directories[0], sessions: [{ ...value.directories[0].sessions[0], hasChildren: true }] }] };
  const list = vi.fn(async () => ({ data: [
    { id: 'child-latest', parentID: 'same-id', title: 'Latest child', time: { created: 2, updated: 999 }, location: { directory: project('a').path } },
    { id: 'child-pin', parentID: 'same-id', title: 'Pinned child', time: { created: 1, updated: 1 }, location: { directory: project('a').path } },
  ], cursor: {} }));
  const targets = vi.fn<(_project: string, targets: SessionNavigationTarget[]) => void>();
  const entry = registry(async () => json(data), () => ({ session: { list } }) as unknown as OpenCodeClient);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} onNavigationTargets={targets} /></QueryClientProvider>));
  await flush(); await flush();
  await click('sessions.sidebar.session.subsessions.expand');
  expect(renderedIds()).toEqual(['same-id', 'child-pin', 'child-latest']);
  expect(targets.mock.lastCall?.[1].map((target) => target.sessionId)).toEqual(renderedIds());
  await click('sessions.sidebar.session.subsessions.collapse');
  expect(targets.mock.lastCall?.[1].map((target) => target.sessionId)).toEqual(['same-id']);
});

test('older sessions are demand-paged from the Host SDK, preserving explicit cursor and bounded requests', async () => {
  const list = vi.fn(async ({ cursor }: { cursor?: string }) => ({ data: [{ id: cursor ? 'older-2' : 'older-1', title: cursor ? 'Older two' : 'Older one', time: { created: 1, updated: 1 }, location: { directory: project('a').path } }], cursor: cursor ? {} : { next: 'next-page' } }));
  const entry = registry(async () => { const value = snapshot('a'); return json({ ...value, directories: [{ ...value.directories[0], hasMore: true }] }); }, () => ({ session: { list } }) as unknown as OpenCodeClient);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={project('a')} registry={entry} /></QueryClientProvider>));
  await flush(); await flush(); expect(list).not.toHaveBeenCalled();
  await click('sessions.sidebar.group.showMore');
  expect(list).toHaveBeenCalledTimes(1);
  await click('sessions.sidebar.group.showMore');
  expect(list).toHaveBeenCalledTimes(3);
  expect(list.mock.calls[2][0]).toMatchObject({ cursor: 'next-page' });
  expect(container.textContent).toContain('Older one'); expect(container.textContent).toContain('Older two');
});

test('custom project icons use the remote project ID and Host fetch, and release browser object URLs on unmount', async () => {
  const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:remote-icon');
  const revokeUrl = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  const fetch = vi.fn(async (path: string) => path.endsWith('/icon') ? new Response('icon-bytes', { headers: { 'Content-Type': 'image/png' } }) : json(snapshot('a')));
  const entry = registry(fetch);
  const imageProject = { ...project('a'), iconImage: { mime: 'image/png', updatedAt: 1, source: 'custom' as const } };
  await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectSection project={imageProject} registry={entry} /></QueryClientProvider>));
  await flush(); await flush();
  expect(fetch).toHaveBeenCalledWith('/api/hosts/a/api/projects/project-same/icon', expect.objectContaining({ query: { v: 1 } }));
  expect(createUrl).toHaveBeenCalledOnce();
  expect(container.querySelector('img')?.getAttribute('src')).toBe('blob:remote-icon');
  await act(async () => root.render(null));
  expect(revokeUrl).toHaveBeenCalledWith('blob:remote-icon');
});

test('local-only navigation adds zero requests, event subscriptions or timers even on a supported desktop', async () => {
  useProjectsStore.setState({ projects: [{ id: 'local', path: '/local' }], activeProjectId: 'local' });
  vi.spyOn(desktop, 'isDesktopShell').mockReturnValue(true);
  const fetch = vi.spyOn(globalThis, 'fetch');
  const timers = vi.spyOn(globalThis, 'setTimeout');
  const subscriptions = mocks.events.size;
  function LocalOnly() { useRemoteProjectNavigation(); return <span>local</span>; }
  await act(async () => root.render(<QueryClientProvider client={queryClient}><LocalOnly /></QueryClientProvider>));
  expect(fetch).not.toHaveBeenCalled();
  expect(mocks.events.size).toBe(subscriptions);
  expect(timers).not.toHaveBeenCalled();
});

test('the real mobile chat header reads the remote summary title and machine, never the retained Hub title', async () => {
  const fetch = vi.fn(async () => json(snapshot('a')));
  const scope = registry(fetch);
  useSessionNavigationStore.getState().openRemoteSession(project('a'), { hubId: 'hub', hostId: 'a', directory: project('a').path }, 'same-id');
  const value = { registry: scope, entry: scope.resolve({ hubId: 'hub', hostId: 'a', directory: project('a').path }), demand: getHostRuntimeServices(scope).demand };
  await act(async () => root.render(<QueryClientProvider client={queryClient}><HostRuntimeContext.Provider value={value}><MobileChatHeader title="Wrong Hub title" onBack={() => {}} onOpenMenu={() => {}} /></HostRuntimeContext.Provider></QueryClientProvider>));
  await flush(); await flush();
  expect(container.textContent).toContain('Title a');
  expect(container.textContent).not.toContain('Wrong Hub title');
  expect(container.querySelector('.yuri-mobile-detail-title')?.textContent).toBe('Title a');
  expect(container.querySelector('.yuri-mobile-detail-subtitle [data-remote-host="a"]')).not.toBeNull();
  expect(container.querySelector('[data-remote-host="a"]')?.textContent).toContain('a');
  expect(fetch.mock.calls).toHaveLength(1);
  await act(async () => root.render(<QueryClientProvider client={queryClient}><HostRuntimeContext.Provider value={value}><MobileChatHeader title="Wrong Hub title" subtitle="mobile.chat.syncingMessages" onBack={() => {}} onOpenMenu={() => {}} /></HostRuntimeContext.Provider></QueryClientProvider>));
  expect(container.querySelector('.yuri-mobile-detail-subtitle')?.textContent).toBe('mobile.chat.syncingMessages');
  expect(container.querySelector('[data-remote-host]')).toBeNull();
  await act(async () => root.render(<QueryClientProvider client={queryClient}><HostRuntimeContext.Provider value={value}><MobileChatHeader title="Wrong Hub title" onBack={() => {}} onOpenMenu={() => {}} /></HostRuntimeContext.Provider></QueryClientProvider>));
  expect(container.querySelector('.yuri-mobile-detail-subtitle [data-remote-host="a"]')).not.toBeNull();
  await act(async () => root.render(<MobileChatHeader title="Hub title" onBack={() => {}} onOpenMenu={() => {}} />));
  expect(container.textContent).toContain('Hub title');
  expect(container.querySelector('[data-remote-host]')).toBeNull();
  expect(fetch.mock.calls).toHaveLength(1);
});
