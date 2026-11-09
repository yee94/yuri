import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desktopSidebarNavigationStatus, desktopSidebarSessionStateKey } from './desktop-sidebar-projection';
import type { Row } from './model';

const h = vi.hoisted(() => ({ call: vi.fn(), cleanups: [] as Array<() => void>, stops: [] as Array<() => void>, listeners: new Map<string, Set<(value: unknown) => void>>() }));
vi.mock('nsh', () => ({
  signal: <T>(value: T) => Object.assign(() => value, { set: (next: T) => { value = next; } }),
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(), lifecycle: () => 'active',
  effect: (work: () => unknown) => { const dispose = work(); if (typeof dispose === 'function') h.stops.push(dispose as () => void); },
  cleanup: (work: () => void) => h.cleanups.push(work), Storage: { getItem: async () => null, setItem: async () => {} },
  host: { available: () => true, call: h.call, on: (name: string, work: (value: unknown) => void) => { const listeners = h.listeners.get(name) ?? new Set(); listeners.add(work); h.listeners.set(name, listeners); return () => { listeners.delete(work); }; } },
}));
let connection: { id: string; url: string; authorizationID: string }, lease: string;
let snapshot: Row, tasks: Row, index: Row, failure: string;
const contact = { id: 'bot', revision: 3, enabled: true, working: true, avatarSeed: 'saved-avatar', activeContactTurn: { turnID: 'turn', messageID: 'msg', status: 'running', admittedAt: 10 }, unreadCount: 102,
  latestMessagePreview: { messageID: 'msg', ordinal: 1, role: 'assistant', text: 'preview', fallbackKind: null, createdAt: 50 } };
const requests = () => h.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input as { path: string; method: string });
const emit = (type: string, body: Row, directory = '/repo') => { for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key: 'global', data: JSON.stringify({ type, data: body, directory }) }); };
beforeEach(() => {
  vi.resetModules(); h.cleanups = []; h.stops = []; h.listeners.clear(); failure = '';
  connection = { id: 'one', url: 'https://host.example', authorizationID: 'authorization' }; lease = 'lease-one';
  snapshot = { revision: 3, enabled: true, assistants: [contact] };
  tasks = { tasks: [{ projectId: 'project', task: { id: 'task', state: { lastStatus: 'running' } } }], failedProjectIds: [] };
  index = { available: true, directories: [{ directory: '/repo', sessions: [{ id: 'root', title: 'Root', time: { updated: 1 }, hasChildren: true }] }] };
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected: connection.id, connections: [connection], runtimeScope: { hostID: connection.id, lease } };
    if (name !== 'runtime.request') throw new Error('unexpected_native_call');
    if (input.path === failure) throw new Error('fixture_failed');
    const body = input.path === '/api/yuri/assistants/snapshot' ? snapshot : input.path === '/api/yuri/session-index' ? index : input.path === '/api/yuri/scheduled-tasks' ? tasks : input.path === '/api/config/settings' ? { projects: [{ id: 'project', path: '/repo' }] } : input.path === '/api/debug/location' ? [] : null;
    if (body === null) throw new Error('unexpected_request');
    return { status: 200, body };
  });
});
afterEach(() => { h.stops.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); });
async function open() { const state = await import('./state'); await state.loadConnections(); await state.refresh(); return state; }

describe('existing root producer → scoped desktop sidebar authority → consumer', () => {
  it('publishes real enabled/revision, saved contact fields, task status and index child hint, with only the original four reads', async () => {
    const state = await open(), source = state.desktopSidebarAuthority()!;
    expect(requests()).toHaveLength(4); expect(requests().every(row => row.method === 'GET')).toBe(true);
    const { revision: _contactRevision, ...fields } = contact;
    expect(source.assistants).toMatchObject({ enabled: true, revision: 3, contacts: [fields] });
    expect(source.sessions?.get(desktopSidebarSessionStateKey({ id: 'root', directory: '/repo' }))).toEqual({ hasChildren: true });
    expect(desktopSidebarNavigationStatus(source, source.scope)).toEqual({ avatar: { id: 'bot', avatarSeed: 'saved-avatar' }, assistantRunning: true, assistantUnread: 102, scheduleRunning: true });
    expect(source.sessions?.values().next().value).not.toHaveProperty('navigationRunning');
  });
  it('uses adopted AssistantHome snapshots, rejects late revision/scope and never derives enabled from app.bots', async () => {
    const state = await open(), source = state.desktopSidebarAuthority()!, { readAssistantSnapshot } = await import('./assistants-core');
    snapshot = { ...snapshot, revision: 4, enabled: false, assistants: [] };
    const lane = state.captureHostOperation(), received = await readAssistantSnapshot(lane);
    state.adoptAssistantCatalogSnapshot(received, source.scope);
    expect(state.desktopSidebarAuthority()!.assistants).toMatchObject({ enabled: false, revision: 4, contacts: [] });
    state.app.bots.set([contact]); expect(state.desktopSidebarAuthority()!.assistants?.enabled).toBe(false);
    expect(state.adoptAssistantCatalogSnapshot({ revision: 3, enabled: true, assistants: [contact] }, source.scope)).toBe(false);
    connection = { ...connection, authorizationID: 'new-authorization' }; await state.loadConnections();
    expect(state.desktopSidebarAuthority()!.assistants).toBeUndefined();
    expect(state.adoptAssistantCatalogSnapshot(received, source.scope)).toBe(false);
    expect(desktopSidebarNavigationStatus(source, state.desktopSidebarAuthority()!.scope)).toBeNull();
  });
  it('failure/partial keeps prior running, unread and failed-project task fields without clearing other successful projects', async () => {
    const state = await open(), prior = state.desktopSidebarAuthority()!;
    failure = '/api/yuri/assistants/snapshot';
    tasks = { tasks: [{ projectId: 'good', task: { id: 'good', lastStatus: 'success' } }], failedProjectIds: ['project'] };
    await expect(state.refresh()).rejects.toThrow('fixture_failed');
    const next = state.desktopSidebarAuthority()!;
    expect(next.assistants).toBe(prior.assistants); expect(next.schedules).toEqual([{ task: { lastStatus: 'success' } }, { task: { lastStatus: 'running' } }]);
    expect(desktopSidebarNavigationStatus(next, next.scope)).toMatchObject({ assistantUnread: 102, assistantRunning: true, scheduleRunning: true });
    connection = { ...connection, authorizationID: 'replaced' }; await state.loadConnections();
    await expect(state.refresh()).rejects.toThrow('fixture_failed');
    expect(state.desktopSidebarAuthority()!.schedules).toEqual([{ task: { lastStatus: 'success' } }]);
  });
  it('contact display catalogs preserve same-authority prior on failure, but never adopt old rows under a new authorization', async () => {
    const state = await open(), before = state.desktopContactCatalog();
    expect(before.sessions).toBe(state.app.sessions()); expect(before.assistants).toBe(state.app.bots()); expect(before.tasks).toHaveLength(1);
    failure = '/api/yuri/session-index'; await expect(state.refresh()).rejects.toThrow();
    expect(state.desktopContactCatalog().sessions).toBe(before.sessions);
    const oldBots = state.app.bots();
    connection = { ...connection, authorizationID: 'new-authorization' }; await state.loadConnections();
    expect(state.app.sessions()).toBe(before.sessions); expect(state.app.bots()).toBe(oldBots);
    expect(state.desktopContactCatalog()).toEqual({ sessions: [], assistants: [], tasks: [] });
    await expect(state.refresh()).rejects.toThrow();
    expect(state.desktopContactCatalog().sessions).toEqual([]);
    expect(state.desktopContactCatalog().assistants).toBe(state.app.bots()); expect(state.desktopContactCatalog().tasks).toHaveLength(1);
    const priorReads = requests().length;
    for (let count = 0; count < 50; count++) { state.app.error.set('draft:' + count); expect(state.desktopContactCatalog().sessions).toEqual([]); }
    expect(requests()).toHaveLength(priorReads);
  });
  it('projects attention and real global execution events publish unread/own-running; shell activity is never guessed', async () => {
    const state = await open(); state.observeRuntime(() => {});
    const key = desktopSidebarSessionStateKey({ id: 'root', directory: '/repo' });
    emit('session.execution.started', { sessionID: 'root' });
    expect(state.desktopSidebarAuthority()!.sessions?.get(key)).toEqual({ hasChildren: true, running: true });
    emit('session.execution.succeeded', { sessionID: 'root' });
    expect(state.desktopSidebarAuthority()!.sessions?.get(key)).toEqual({ hasChildren: true, running: false, unreadCount: 1 });
    const { projectsAttention } = await import('./projects-attention'); projectsAttention.setViewedSession(JSON.stringify([state.epoch(), connection.id]), 'root');
    expect(state.desktopSidebarAuthority()!.sessions?.get(key)).not.toHaveProperty('unreadCount', 1);
    expect(state.desktopSidebarAuthority()!.sessions?.get(key)).not.toHaveProperty('navigationRunning');
    expect(requests().filter(row => row.path !== '/api/debug/location')).toHaveLength(4);
  });
  it('50 unrelated input updates perform zero catalog enumeration, no reads or projection invalidation', async () => {
    const state = await open(), source = state.desktopSidebarAuthority()!, rows = state.app.sessions();
    const iterator = vi.spyOn(rows, Symbol.iterator), before = requests().length;
    for (let input = 0; input < 50; input++) { state.app.error.set(`draft:${input}`); expect(state.desktopSidebarAuthority()).toBe(source); }
    expect(iterator).not.toHaveBeenCalled(); expect(requests()).toHaveLength(before);
  });
  it('contact cards reuse exact live status, never infer idle from a terminal execution or retain status across reconnect/scope changes', async () => {
    const state = await open(); state.observeRuntime(() => {});
    const scope = state.app.runtimeScope()!, status = () => state.desktopContactSessionStatus(scope, 'root', '/repo');
    expect(status()).toBeUndefined(); const before = requests().filter(row => row.path !== '/api/debug/location').length;
    emit('session.status', { sessionID: 'root', status: { type: 'busy' } });
    expect(status()).toEqual({ type: 'busy' }); const original = status();
    for (let index = 0; index < 50; index++) {
      emit('session.status', { sessionID: 'root', status: { type: 'busy' } }); state.app.error.set('input:' + index);
      expect(status()).toBe(original);
    }
    emit('session.status', { sessionID: 'other', status: { type: 'retry' } }); expect(status()).toBe(original);
    expect(state.desktopContactSessionStatus(scope, 'root', '/elsewhere')).toBeUndefined();
    expect(state.desktopContactSessionStatus({ ...scope, lease: 'stale-lease' }, 'root', '/repo')).toBeUndefined();
    emit('session.status', { sessionID: 'root', status: { type: 'retry' } }); expect(status()).toEqual({ type: 'retry' });
    emit('session.execution.succeeded', { sessionID: 'root' }); expect(status()).toBeUndefined();
    emit('session.status', { sessionID: 'root', status: { type: 'idle' } }); expect(status()).toEqual({ type: 'idle' });
    emit('server.connected', {}); expect(status()).toBeUndefined();
    emit('session.status', { sessionID: 'root', status: { type: 'busy' } }); expect(status()).toEqual({ type: 'busy' });
    expect(requests().filter(row => row.path !== '/api/debug/location')).toHaveLength(before);
    connection = { ...connection, authorizationID: 'new-authorization' }; await state.loadConnections(); expect(status()).toBeUndefined();
  });
  it('missing root metadata is unknown, and incomplete AssistantHome snapshot cannot publish empty success', async () => {
    snapshot = { assistants: [] };
    const state = await open(); expect(state.desktopSidebarAuthority()!.assistants).toBeUndefined();
    const { readAssistantSnapshot } = await import('./assistants-core'); snapshot = { revision: 4, enabled: false, assistants: [], complete: false };
    await expect(readAssistantSnapshot(state.captureHostOperation())).rejects.toThrow('invalid_response');
    expect(state.desktopSidebarAuthority()!.assistants).toBeUndefined();
  });
  it('the existing schedules page writer updates the same raw app.tasks authority, with no new root read', async () => {
    const state = await open(), { createScheduledCatalog } = await import('./schedules-state');
    const catalog = createScheduledCatalog(), before = requests().length;
    tasks = { tasks: [{ projectId: 'project', task: { id: 'task', state: { lastStatus: 'success' } } }], failedProjectIds: [] };
    await catalog.load();
    const authority = state.desktopSidebarAuthority()!;
    expect(authority.schedules).toEqual([{ task: { lastStatus: 'success' } }]);
    expect(desktopSidebarNavigationStatus(authority, authority.scope)?.scheduleRunning).toBe(false);
    expect(requests()).toHaveLength(before + 1); expect(requests().at(-1)?.path).toBe('/api/yuri/scheduled-tasks');
    catalog.dispose();
  });
  it('optional contact projection never becomes a new Home validity gate for the existing native wire', async () => {
    const state = await open(), before = state.desktopSidebarAuthority()!.assistants;
    const nativeContact = { id: 'alpha', name: 'Contact alpha', revision: 9, enabled: true, unreadCount: 0, effectiveWorkspacePath: '/repo', latestMessagePreview: { text: 'Preview alpha', createdAt: 1 } };
    snapshot = { revision: 9, enabled: true, assistants: [nativeContact] };
    const { readAssistantSnapshot } = await import('./assistants-core');
    const received = await readAssistantSnapshot(state.captureHostOperation());
    expect(state.adoptAssistantCatalogSnapshot(received)).toBe(true);
    expect(state.app.bots()).toEqual([nativeContact]);
    expect(state.desktopSidebarAuthority()!.assistants?.contacts).toBe(before?.contacts);
    expect(state.adoptAssistantCatalogSnapshot({ revision: 8, enabled: true, assistants: [contact] })).toBe(false);
    expect(state.app.bots()).toEqual([nativeContact]);
  });
});
