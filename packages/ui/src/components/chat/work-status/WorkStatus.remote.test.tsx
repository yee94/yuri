import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { HostRuntimeProvider } from '@/contexts/HostRuntimeProvider';
import { HostRuntimeRegistry, type HostRuntimeEntry } from '@/lib/remote-projects/registry';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import { queryClient } from '@/lib/queryRuntime';
import { getRemoteChatOwner } from '@/sync/remote-chat-context';
import { ChatView } from '@/components/views/ChatView';
import { dict } from '@/lib/i18n/messages/en';

const fixture = vi.hoisted(() => ({
  selection: null as null | { projectId: string; sessionId: string; location: { hubId: string; hostId: string; directory: string } },
  projects: ['a', 'b'].map((hostId) => ({ id: `project-${hostId}`, hostId, hubId: 'hub', path: 'C:\\repo', label: `Project ${hostId}` })),
  ui: { isMobile: false, isExpandedInput: false, workStatusPanelEnabled: true, workStatusOverlayOpen: false,
    isRightSidebarOpen: false, contextPanelByDirectory: {}, setWorkStatusPanelFits: vi.fn(),
    setWorkStatusPanelVisible: vi.fn(), setWorkStatusOverlayOpen: vi.fn(),
    openContextPanel: vi.fn(), openContextPanelTab: vi.fn(), setRightSidebarTab: vi.fn(), setRightSidebarOpen: vi.fn() },
  copy: vi.fn(async () => ({ ok: true })),
  localReads: vi.fn(() => { throw new Error('Remote work status read Hub state'); }),
  plugins: vi.fn(),
  subscribeEvents: vi.fn(),
}));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: () => { fixture.subscribeEvents(); return () => {}; } }));
vi.mock('@/sync/transcript-durable-store-runtime', async () => {
  const { createMemoryTranscriptDurableStore } = await import('@/sync/transcript-durable-store');
  return { createRuntimeTranscriptDurableStore: () => createMemoryTranscriptDurableStore() };
});
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict, params: Record<string, string | number> = {}) =>
  Object.entries(params).reduce<string>((text, [name, value]) => text.replace(`{${name}}`, String(value)), dict[key]) }) }));
vi.mock('@/lib/clipboard', () => ({ copyTextToClipboard: fixture.copy }));
vi.mock('@/lib/desktop', () => ({ isVSCodeRuntime: () => false, isDesktopShell: () => false, isDesktopLocalOriginActive: () => false }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git: undefined }) }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => 'C:\\HUB' }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (state: unknown) => unknown) => select({
  projects: [{ id: 'hub', path: 'C:\\repo', label: 'WRONG HUB PROJECT' }, ...fixture.projects],
}) }));
vi.mock('@/stores/useSessionNavigationStore', () => ({ useSessionNavigationStore: (select: (state: unknown) => unknown) => select({ remoteSession: fixture.selection }) }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: (select: (state: unknown) => unknown) => select({
  currentSessionId: 'HUB-retained', currentSessionDirectory: 'C:\\HUB', newSessionDraft: null,
  get availableWorktreesByProject() { return fixture.localReads(); },
  get worktreeMetadata() { return fixture.localReads(); },
}) }));
vi.mock('@/sync/sync-context', () => ({ useDirectorySync: fixture.localReads, useSessionLatestTodos: fixture.localReads, useDirectoryStore: fixture.localReads }));
vi.mock('@/stores/useTodosPersistStore', () => ({ useTodosPersistStore: fixture.localReads }));
vi.mock('@/components/gui-plugins/GuiPluginWorkStatus', () => ({ GuiPluginWorkStatus: () => { fixture.plugins(); return null; } }));
vi.mock('@/stores/useUIStore', async (original) => ({ ...await original<typeof import('@/stores/useUIStore')>(),
  useUIStore: (select: (state: unknown) => unknown) => select(fixture.ui),
}));
vi.mock('@/components/chat/ChatContainer', () => ({ ChatContainer: () => <main>Chat transcript boundary</main> }));
vi.mock('@/components/chat/ChatErrorBoundary', () => ({ ChatErrorBoundary: ({ children }: React.PropsWithChildren) => children }));

let root: Root, container: HTMLDivElement;
let registry: HostRuntimeRegistry;
let calls: Array<{ hostId: string; path: string; method?: string; directory?: unknown }>;
let statusReads: string[], listReads: string[];
let failChildren: boolean;
let childBusy: boolean;
let todos: unknown[];
let deferredTrees: { promise: Promise<Response>; resolve: (response: Response) => void } | undefined;
const directory = 'C:\\trees\\topic';
const location = (hostId: string) => ({ hubId: 'hub', hostId, directory });
const json = (body: unknown) => Response.json(body);
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); }); };
const render = async (hostId = 'a', tick = 0, active = true) => {
  fixture.selection = { projectId: `project-${hostId}`, sessionId: 'same', location: location(hostId) };
  await act(async () => root.render(<QueryClientProvider client={queryClient}><div data-tick={tick}>
    <HostRuntimeProvider key={hostId} registry={registry} location={location(hostId)}><ChatView active={active} /></HostRuntimeProvider>
  </div></QueryClientProvider>));
  await flush();
};

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); queryClient.clear();
  calls = []; statusReads = []; listReads = []; failChildren = false; childBusy = true; deferredTrees = undefined;
  todos = [{ content: 'Remote plan', status: 'in_progress', priority: 'high' }];
  vi.spyOn(window, 'matchMedia').mockImplementation((media) => Object.assign(new EventTarget(), {
    media, matches: true, onchange: null, addListener: vi.fn(), removeListener: vi.fn(),
  }) as MediaQueryList);
  registry = new HostRuntimeRegistry('hub', {
    transportIdentity: 'transport', isCurrent: () => true,
    fetch: async (path, init) => {
      const hostId = path.split('/')[3];
      const query = init?.query;
      calls.push({ hostId, path, method: init?.method, directory: query instanceof URLSearchParams ? query.get('directory') : query?.directory });
      if (init?.method === 'DELETE' && path.includes('/subscriptions/')) return new Response(null, { status: 204 });
      if (path.endsWith('/worktrees') && hostId === 'a' && deferredTrees) return deferredTrees.promise;
      if (path.endsWith('/worktrees')) return json([{ head: 'h', name: `topic-${hostId}`, branch: `branch-${hostId}`, path: directory }]);
      if (path.endsWith('/check')) return json({ isGitRepository: true });
      if (path.endsWith('/status')) return json({ current: `branch-${hostId}`, files: [{ path: 'a.ts', index: 'M', working_dir: ' ' }],
        diffStats: { 'a.ts': { insertions: 8, deletions: 2 } } });
      if (path.endsWith('/message')) return json({ data: [{ id: 'msg_asst', type: 'assistant', time: { created: 1, completed: 2 }, content: [
        { id: 'todo', type: 'tool', name: 'todowrite', state: { status: 'completed', input: { todos } } },
        { id: 'task', type: 'tool', name: 'task', state: { status: 'completed', input: { description: 'Task description' }, metadata: { sessionId: 'child' } } },
      ] }] });
      if (path.endsWith('/subscriptions')) return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : json({ id: `lease-${hostId}` });
      if (path.endsWith('/inbox')) return json([]);
      throw new Error(`Unexpected request ${path}`);
    },
    sdk: (scope) => ({
      session: { get: async () => ({ id: 'same', title: 'Remote session', directory }),
        list: async (input: { directory: string; parentID: string }) => {
          listReads.push(scope.hostId!); expect(input).toMatchObject({ directory, parentID: 'same' });
          if (failChildren) throw new Error('Children offline');
          return { data: [{ id: 'child', title: `Child ${scope.hostId}` }] };
        } },
      permission: { request: { list: async () => ({ data: [] }) } }, form: { list: async () => ({ data: [] }) },
    }) as unknown as OpenCodeClient,
    service: (scope) => ({ getSessionActive: async () => {
      statusReads.push(scope.hostId!); return { state: 'supported', membership: { ...(childBusy ? { child: { type: 'running' } } : {}), same: { type: 'running' } } };
    } }) as unknown as ReturnType<HostRuntimeEntry['service']>,
  });
  registry.applyCatalog({ hubId: 'hub', supported: true, projects: [], hosts: ['a', 'b'].map((id) => ({ id, name: id, source: 'direct', state: 'connected', generation: 'wire' })) });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); registry.dispose(); queryClient.clear(); vi.restoreAllMocks(); });

it('mounts all five built-in capabilities, uses raw Host APIs and Location-keyed actions, and shares chat demand', async () => {
  const owner = getRemoteChatOwner(registry, registry.resolve(location('a')));
  const releaseOwner = owner.retain();
  const releaseChat = owner.state.observe('same', () => {});
  try {
    await render();
    expect(container.querySelector('aside[aria-hidden="false"]')).not.toBeNull();
    expect(container.textContent).toContain('Project a');
    expect(container.textContent).toContain('branch-a');
    expect(container.textContent).toContain('topic-a');
    expect(container.textContent).toContain('Changes+8−2');
    expect(container.textContent).toContain('Remote plan');
    expect(container.textContent).toContain('1 working');
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Copy Worktree Path"]')!.click());
    expect(fixture.copy).toHaveBeenCalledWith(directory);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open Git panel"]')!.click());
    expect(fixture.ui.openContextPanel).toHaveBeenCalledWith(registry.resolve(location('a')).key);
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Subagents"] button')!.click());
    const child = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Child a');
    expect(child).toBeDefined();
    await act(async () => child!.click());
    expect(fixture.ui.openContextPanelTab).toHaveBeenCalledWith(registry.resolve(location('a')).key,
      { mode: 'chat', dedupeKey: 'session:child', label: 'Child a', readOnly: true });
    expect(fixture.localReads).not.toHaveBeenCalled(); expect(fixture.plugins).not.toHaveBeenCalled();
    expect(calls.every((call) => call.hostId === 'a')).toBe(true);
    expect(calls.filter((call) => call.path.endsWith('/subscriptions'))).toHaveLength(1);
    expect(fixture.subscribeEvents).toHaveBeenCalledTimes(1);
    const counts = [calls.length, listReads.length, statusReads.length];
    for (let tick = 1; tick <= 50; tick++) await render('a', tick);
    expect([calls.length, listReads.length, statusReads.length]).toEqual(counts);
    await act(async () => {
      for (let token = 0; token < 100; token++) registry.ingest({ type: 'yuri:host-event', properties: {
        hubId: 'hub', hostId: 'a', generation: 'wire', directory,
        payload: { type: 'session.next.text.delta', data: { timestamp: token, sessionID: 'same', assistantMessageID: 'msg_asst', textID: 'txt', delta: 'x' } },
      } });
    });
    expect([calls.length, listReads.length, statusReads.length]).toEqual(counts);
    expect(calls.filter((call) => /worktrees|status|check|message$/.test(call.path)).every((call) => call.directory === directory)).toBe(true);
  } finally { releaseChat(); releaseOwner(); }
});

it('isolates same-ID and same-path Hosts, preserves children on refresh failure, and clears authoritative empty todos', async () => {
  await render('a');
  expect(container.textContent).toContain('Project a');
  failChildren = true;
  await act(async () => queryClient.invalidateQueries({ predicate: (query) => query.queryKey.includes('same') }));
  await flush();
  expect(container.textContent).toContain('1 working');
  expect(container.querySelector('[role="status"]')).not.toBeNull();
  failChildren = false;
  await render('b');
  expect(container.textContent).toContain('Project b'); expect(container.textContent).toContain('branch-b');
  expect(container.textContent).not.toContain('Project a'); expect(container.textContent).not.toContain('branch-a');
  expect(fixture.localReads).not.toHaveBeenCalled();
  childBusy = false;
  const messageReads = calls.filter((call) => call.path.endsWith('/message')).length;
  await act(async () => registry.ingest({ type: 'yuri:host-event', properties: { hubId: 'hub', hostId: 'b', generation: 'wire', directory,
    payload: { type: 'session.status', properties: { sessionID: 'child', status: { type: 'idle' } } },
  } }));
  await flush();
  expect(container.querySelector('[aria-label="Subagents"]')?.textContent).toContain('1 done');
  expect(calls.filter((call) => call.path.endsWith('/message'))).toHaveLength(messageReads);
  todos = [];
  const owner = getRemoteChatOwner(registry, registry.resolve(location('b')));
  await act(async () => owner.state.repository.refreshFromAuthority(owner.state.scope('same')));
  expect(container.textContent).not.toContain('Remote plan');
  expect(container.querySelector('[aria-label="Tasks"]')).toBeNull();
});

it('does not start work-status reads or leases for an inactive remote conversation', async () => {
  await render('a', 0, false);
  expect(container.querySelector('aside')).toBeNull();
  expect(calls).toEqual([]); expect(listReads).toEqual([]); expect(statusReads).toEqual([]);
  expect(fixture.localReads).not.toHaveBeenCalled();
});

it('rejects a late old-Host worktree result and releases visible work when inactive', async () => {
  let resolve!: (response: Response) => void;
  const resolvers = { promise: new Promise<Response>((done) => { resolve = done; }), resolve: (response: Response) => resolve(response) };
  deferredTrees = resolvers;
  await render('a');
  await render('b');
  await act(async () => resolvers.resolve(json([{ head: 'h', name: 'LATE A TREE', branch: 'late', path: directory }])));
  expect(container.textContent).toContain('topic-b'); expect(container.textContent).not.toContain('LATE A TREE');
  await render('b', 0, false);
  expect(container.querySelector('aside')).toBeNull();
  expect(calls.filter((call) => call.path.endsWith('/subscriptions') && call.method === 'POST')).toHaveLength(2);
  expect(calls.filter((call) => call.path.includes('/subscriptions/') && call.method === 'DELETE')).toHaveLength(2);
});
