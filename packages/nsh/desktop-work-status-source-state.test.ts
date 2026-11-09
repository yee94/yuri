import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DesktopWorkStatusChat } from './desktop-work-status-core';

const h = vi.hoisted(() => ({
  listeners: new Map<string, Set<(payload: unknown) => void>>(), cleanups: [] as Array<() => void>, effects: [] as Array<() => void | (() => void)>, disposers: [] as Array<() => void>,
  writes: [] as unknown[], lifecycle: 'active', call: vi.fn(), storage: new Map<string, string>(),
}));
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(), computed: <T>(work: () => T) => work,
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { if (!Object.is(value, next)) { value = next; h.writes.push(next); } } }); },
  lifecycle: () => h.lifecycle, locale: () => 'en', cleanup: (work: () => void) => h.cleanups.push(work),
  effect: (work: () => void | (() => void)) => { h.effects.push(work); const stop = work(); if (stop) h.disposers.push(stop); },
  Storage: { getItem: async (key: string) => h.storage.get(key) ?? null, setItem: async (key: string, value: string) => { h.storage.set(key, value); } },
  host: { available: () => true, call: h.call, on: (name: string, listener: (payload: unknown) => void) => { const listeners = h.listeners.get(name) ?? new Set(); listeners.add(listener); h.listeners.set(name, listeners); return () => { listeners.delete(listener); }; } },
}));
const target = { kind: 'session' as const, id: 'parent', directory: '/fixture/project', title: 'Synthetic Chat' };
const identity = { hostID: 'fixture', lease: 'lease-1' };
const historyTask = { type: 'tool', id: 'historic-task', name: 'task', state: { status: 'pending', input: { description: 'Historical pending', subagent_type: 'explore' }, metadata: { sessionID: 'child' } } };
const todo = { type: 'tool', id: 'todo', name: 'todowrite', state: { status: 'completed', input: { todos: [{ content: 'Original task snapshot', status: 'pending', priority: 'medium' }] } } };
const history = () => ({ data: [{ id: 'history', type: 'assistant', content: [historyTask, todo] }], cursor: { next: null } });
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const emit = (type: string, data: Record<string, unknown> = {}, key = 'chat', created?: number, expectedHost: unknown = identity) => {
  for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key, ...(expectedHost === null ? {} : { expectedHost }), data: JSON.stringify({ type, data: { sessionID: target.id, ...data }, ...(created === undefined ? {} : { created }), location: { directory: target.directory } }) });
};
let read: (path: string) => unknown;
const requests = () => h.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input);
const notices = () => h.writes.filter((value): value is DesktopWorkStatusChat => !!value && typeof value === 'object' && 'taskFaces' in value && 'backgroundShell' in value);
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); h.listeners.clear(); h.cleanups = []; h.effects = []; h.disposers = []; h.writes = []; h.lifecycle = 'active'; h.storage.clear();
  read = path => {
    if (path.includes('/message?')) return history();
    if (path === '/api/session/active') return {};
    if (path.startsWith('/api/session/parent?')) return { id: 'parent', location: { directory: target.directory } };
    if (path.includes('/inbox?') || path.includes('/form?') || path.includes('/permission/request?')) return [];
    if (path.startsWith('/api/session?')) return { data: [{ id: 'child', parentID: 'parent', title: 'Authoritative title', location: { directory: target.directory }, execution: { type: 'running' } }], cursor: { next: null } };
    throw new Error('Unexpected source request ' + path);
  };
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected: 'fixture', runtimeScope: identity, connections: [{ id: 'fixture', url: 'https://fixture.invalid', authorizationID: 'fixture-auth' }] };
    if (name === 'runtime.request') { if (input.method !== 'GET' || input.body !== undefined || JSON.stringify(input.expectedHost) !== JSON.stringify(identity)) throw new Error('Not an exact captured read'); return { status: 200, body: await read(input.path) }; }
    if (name === 'runtime.stream' || name === 'runtime.stop') return true;
    throw new Error('Unexpected native source call ' + name);
  });
});
afterEach(() => { h.disposers.forEach(dispose => dispose()); h.cleanups.forEach(cleanup => cleanup()); vi.restoreAllMocks(); vi.useRealTimers(); });
async function start() {
  const helpers = await import('./desktop-work-status-helpers.generated');
  const faces = vi.spyOn(helpers, 'projectTranscriptSubagents');
  const tasksModule = await import('./chat-tasks-model'), original = tasksModule.createTasksProjection, scans = vi.fn();
  vi.spyOn(tasksModule, 'createTasksProjection').mockImplementation(() => { const project = original(); return (...input) => { scans(); return project(...input); }; });
  const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await chat.draftReady; await flush();
  return { state, chat, faces, scans };
}

describe('production original createChat workStatus source seams', () => {
  test('stable read-only getter reuses tasks; fifty draft/text batches cause zero task scans, helper calls, projection notices or Host calls', async () => {
    const { chat, faces, scans } = await start(); const snapshot = chat.workStatus();
    expect(snapshot.tasks).toBe(chat.tasks()); expect(snapshot.taskFaces[0]).toMatchObject({ id: 'history:historic-task', sessionID: 'child', running: true });
    expect(snapshot.activity).toBe('idle'); expect(snapshot.liveTaskPartIDs.size).toBe(0); expect(snapshot.backgroundShell).toEqual({ phase: 'unavailable' });
    const before = [faces.mock.calls.length, scans.mock.calls.length, notices().length, h.call.mock.calls.length];
    for (let i = 0; i < 50; i++) {
      chat.setDraftText(`unrelated draft ${i}`);
      emit('session.text.delta', { assistantMessageID: 'text-only', ordinal: 0, delta: 'x' });
      await vi.advanceTimersByTimeAsync(32);
      expect(chat.workStatus()).toBe(snapshot);
    }
    expect([faces.mock.calls.length, scans.mock.calls.length, notices().length, h.call.mock.calls.length]).toEqual(before);
    expect(chat.messages().find(message => message.id === 'text-only')?.text).toBe('x'.repeat(50));
  });
  test('initial/failed active read is unknown, successful empty is confirmed idle; historical pending and arbitrary busy writes never infer live task work', async () => {
    const normal = read; read = path => { if (path === '/api/session/active') throw new Error('Synthetic unavailable'); return normal(path); };
    const { chat } = await start(); expect(chat.workStatus().activity).toBe('unknown');
    chat.busy.set(true); expect(chat.workStatus().activity).toBe('unknown'); expect(chat.workStatus().liveTaskPartIDs.size).toBe(0);
    read = normal; await chat.load(false, ['status']); expect(chat.workStatus().activity).toBe('idle');
    const { desktopWorkStatusAgents } = await import('./desktop-work-status-core'); expect(desktopWorkStatusAgents(chat.workStatus(), [])[0]?.phase).toBe('unknown');
  });
  test.each([
    [{ parent: { type: 'running' } }, 'working'],
    [{ unrelated: { type: 'running' } }, 'idle'],
    [{}, 'idle'],
    [{ parent: { type: 'busy' } }, 'unknown'],
    [[{ sessionID: 'parent', status: 'running' }], 'unknown'],
  ] as const)('native v2 active GET keeps its strict membership contract: %j -> %s', async (payload, activity) => {
    const normal = read; read = path => path === '/api/session/active' ? payload : normal(path);
    const { state, chat } = await start();
    expect(chat.workStatus().activity).toBe(activity); expect(chat.workStatus().liveTaskPartIDs.size).toBe(0);
    expect(requests().filter(request => request.path === '/api/session/active')).toEqual([{ path: '/api/session/active', method: 'GET', expectedHost: identity }]);
    state.observeRuntime(() => {}); await flush();
    expect(requests().filter(request => request.path === '/api/session/active')).toHaveLength(1);
  });
  test('only exact live task part ID can work; live success/idle clears membership without promoting every historical child', async () => {
    const { chat, faces } = await start(); const count = faces.mock.calls.length;
    emit('session.execution.started', {}, 'chat', 10);
    expect(chat.workStatus().activity).toBe('working'); expect(chat.workStatus().liveTaskPartIDs.size).toBe(0); expect(faces.mock.calls.length).toBe(count);
    emit('session.tool.called', { assistantMessageID: 'live-message', id: 'live-task', name: 'task', input: { description: 'Real live task', subagent_type: 'explore' } }, 'chat', 11);
    await vi.advanceTimersByTimeAsync(32);
    expect([...chat.workStatus().liveTaskPartIDs]).toEqual(['live-message:live-task']); expect(chat.workStatus().taskFaces).toHaveLength(2);
    emit('session.tool.success', { assistantMessageID: 'live-message', id: 'live-task', content: [{ type: 'text', text: 'done' }] }, 'chat', 12);
    await vi.advanceTimersByTimeAsync(32); expect(chat.workStatus().liveTaskPartIDs.size).toBe(0);
    emit('session.status', { status: { type: 'idle' } }, 'chat', 13); expect(chat.workStatus().activity).toBe('idle');
    expect(chat.workStatus().taskFaces.find(face => face.id === 'history:historic-task')?.running).toBe(true);
  });
  test('original tool/revert seams correctly reproject faces and reuse exact chat.tasks without a message observer', async () => {
    const { chat, faces } = await start();
    expect(h.listeners.get('runtime.event')?.size).toBe(1);
    emit('session.tool.called', { assistantMessageID: 'new-message', id: 'new-todo', name: 'todowrite', input: { todos: [] } });
    await vi.advanceTimersByTimeAsync(32); expect(chat.tasks()).toEqual([]); expect(chat.workStatus().tasks).toBe(chat.tasks());
    const count = faces.mock.calls.length; chat.revert.set({ messageID: 'history' });
    expect(faces.mock.calls.length).toBeGreaterThan(count); expect(chat.workStatus().taskFaces).toEqual([]); expect(chat.workStatus().tasks).toBe(chat.tasks());
  });
  test('late prior status GET cannot overwrite a newer original live busy/retry event', async () => {
    const { chat } = await start(); const normal = read; let release!: (value: unknown) => void;
    read = path => path === '/api/session/active' ? new Promise(resolve => { release = resolve; }) : normal(path);
    const loading = chat.load(false, ['status']); await flush();
    emit('session.retry.scheduled', { reason: 'synthetic retry' }); expect(chat.workStatus().activity).toBe('working');
    release({}); await loading; expect(chat.workStatus().activity).toBe('working');
  });
  test('a queued old native lease cannot enter the new live source; missing scope never supplies live proof', async () => {
    const { chat, faces } = await start(); const prior = chat.workStatus(), calls = faces.mock.calls.length;
    emit('session.execution.started', {}, 'chat', 10, { hostID: 'fixture', lease: 'retired' });
    emit('session.tool.called', { assistantMessageID: 'old', id: 'old-task', name: 'task', input: {} }, 'chat', 11, { hostID: 'fixture', lease: 'retired' });
    await vi.advanceTimersByTimeAsync(32); expect(chat.workStatus()).toBe(prior); expect(faces.mock.calls.length).toBe(calls); expect(chat.messages().some(message => message.id === 'old')).toBe(false);
    emit('session.execution.started', {}, 'chat', 12, null); expect(chat.workStatus().activity).toBe('unknown');
    emit('session.tool.called', { assistantMessageID: 'legacy', id: 'legacy-task', name: 'task', input: {} }, 'chat', 13, null);
    await vi.advanceTimersByTimeAsync(32); expect(chat.workStatus().liveTaskPartIDs.size).toBe(0);
  });
  test('Host retirement fences late history/status callbacks and cannot notify a replacement Chat', async () => {
    const { state, chat } = await start(); const normal = read; let release!: (value: unknown) => void;
    read = path => path.includes('/message?') ? new Promise(resolve => { release = resolve; }) : normal(path);
    const old = chat.load(false, ['messages']); await flush(); await state.loadConnections({ forceReconnect: true });
    read = normal; const replacement = state.createChat(target); await flush(); const fresh = replacement.workStatus(), notifications = notices().length;
    release({ data: [{ id: 'late', type: 'assistant', content: [historyTask] }], cursor: { next: null } }); await old;
    expect(replacement.workStatus()).toBe(fresh); expect(notices()).toHaveLength(notifications); expect(chat.workStatus()).toMatchObject({ activity: 'unknown', taskFaces: [], tasks: [] });
  });
  test('original lifecycle suspension preserves displayed faces/tasks but revokes live evidence, resume requires fresh confirmation', async () => {
    const { state, chat } = await start(); emit('session.execution.started'); const prior = chat.workStatus();
    const before = h.effects.length; state.runtimeLifecycle(); const lifecycleEffect = h.effects[before]!;
    h.lifecycle = 'background'; lifecycleEffect(); expect(chat.workStatus().activity).toBe('unknown'); expect(chat.workStatus().taskFaces).toBe(prior.taskFaces); expect(chat.workStatus().tasks).toBe(prior.tasks);
    h.lifecycle = 'active'; lifecycleEffect(); await flush(); expect(chat.workStatus().activity).toBe('unknown');
    await chat.load(false, ['status']); expect(chat.workStatus().activity).toBe('idle'); expect(chat.workStatus().liveTaskPartIDs.size).toBe(0);
  });
  test('public exact two-argument child port uses existing global live cache and never performs another active GET', async () => {
    const { state } = await start(); state.observeRuntime(() => {});
    const source = await import('./desktop-work-status-source'), operation = state.captureHostOperation();
    const scope = { host: identity, authorityKey: 'fixture-authority', sessionID: target.id, directory: target.directory };
    const before = requests().filter(request => request.path === '/api/session/active').length;
    expect((await source.readDesktopWorkStatusChildren(operation, scope))[0]?.activity).toBe('unknown');
    emit('session.execution.started', { sessionID: 'child' }, 'global'); expect((await source.readDesktopWorkStatusChildren(operation, scope))[0]?.activity).toBe('working');
    emit('session.idle', { sessionID: 'child' }, 'global'); expect((await source.readDesktopWorkStatusChildren(operation, scope))[0]?.activity).toBe('idle');
    expect(requests().filter(request => request.path === '/api/session/active')).toHaveLength(before);
    expect(requests().filter(request => request.path.startsWith('/api/session?'))).toHaveLength(3);
  });
  test('opened exact children follow root live working/idle without another GET, parent projection, or unrelated-child notification', async () => {
    const { state, chat, faces, scans } = await start(); state.observeRuntime(() => {}); await flush();
    const source = await import('./desktop-work-status-source'), operation = state.captureHostOperation();
    const scope = { host: identity, authorityKey: 'fixture-authority', sessionID: target.id, directory: target.directory };
    const children = await source.readDesktopWorkStatusChildren(operation, scope), changed = vi.fn();
    const stop = source.observeDesktopWorkStatusChildren(operation, scope, children, changed);
    expect(changed.mock.calls[0][0]).toBe(children); expect(children[0].activity).toBe('unknown');
    const parent = chat.workStatus(), before = [faces.mock.calls.length, scans.mock.calls.length, notices().length, requests().length];
    for (let i = 0; i < 50; i++) {
      emit('session.execution.started', { sessionID: 'unrelated' }, 'global');
      emit('session.text.delta', { sessionID: 'child', assistantMessageID: 'child-text', delta: 'x' }, 'global');
      chat.setDraftText('draft ' + i);
    }
    expect(changed).toHaveBeenCalledTimes(1);
    emit('session.execution.started', { sessionID: 'child' }, 'global');
    expect(changed.mock.calls.at(-1)![0][0].activity).toBe('working');
    const working = changed.mock.calls.at(-1)![0];
    emit('session.execution.started', { sessionID: 'child' }, 'global'); expect(changed).toHaveBeenCalledTimes(2);
    emit('session.idle', { sessionID: 'child' }, 'global', undefined, { hostID: 'fixture', lease: 'old' }); expect(changed).toHaveBeenCalledTimes(2);
    emit('session.idle', { sessionID: 'child' }, 'global'); expect(changed.mock.calls.at(-1)![0][0].activity).toBe('idle');
    expect(changed.mock.calls.at(-1)![0]).not.toBe(working);
    emit('session.execution.started', { sessionID: 'child' }, 'global', undefined, null);
    expect(changed.mock.calls.at(-1)![0][0].activity).toBe('unknown');
    expect([faces.mock.calls.length, scans.mock.calls.length, notices().length, requests().length]).toEqual(before); expect(chat.workStatus()).toBe(parent);
    stop(); stop(); const count = changed.mock.calls.length;
    emit('session.idle', { sessionID: 'child' }, 'global'); expect(changed).toHaveBeenCalledTimes(count);
  });
  test('child subscription closes GET-to-observe gap, rejects other directory, and revokes proof on reconnect/Host retirement', async () => {
    const { state } = await start(); state.observeRuntime(() => {}); await flush();
    const source = await import('./desktop-work-status-source'), operation = state.captureHostOperation();
    const scope = { host: identity, authorityKey: 'fixture-authority', sessionID: target.id, directory: target.directory };
    const children = await source.readDesktopWorkStatusChildren(operation, scope), changed = vi.fn();
    emit('session.execution.started', { sessionID: 'child' }, 'global');
    source.observeDesktopWorkStatusChildren(operation, scope, children, changed); expect(changed.mock.calls[0][0][0].activity).toBe('working');
    const otherDirectory = { key: 'global', expectedHost: identity, data: JSON.stringify({ type: 'session.idle', data: { sessionID: 'child' }, location: { directory: '/other' } }) };
    for (const listener of h.listeners.get('runtime.event') ?? []) listener(otherDirectory);
    expect(changed).toHaveBeenCalledTimes(1);
    emit('reconnected', {}, 'global'); expect(changed.mock.calls.at(-1)![0][0].activity).toBe('unknown');
    emit('session.idle', { sessionID: 'child' }, 'global'); expect(changed.mock.calls.at(-1)![0][0].activity).toBe('idle');
    await state.loadConnections({ forceReconnect: true }); expect(changed.mock.calls.at(-1)![0][0].activity).toBe('unknown');
    const count = changed.mock.calls.length;
    emit('session.execution.started', { sessionID: 'child' }, 'global'); expect(changed).toHaveBeenCalledTimes(count);
  });
  test('original root disconnect and suspension revoke child activity; no-scope idle stays unknown', async () => {
    const { state } = await start(); state.observeRuntime(() => {}); const before = h.effects.length; state.runtimeLifecycle(); await flush();
    const source = await import('./desktop-work-status-source'), operation = state.captureHostOperation();
    const scope = { host: identity, authorityKey: 'fixture-authority', sessionID: target.id, directory: target.directory }, changed = vi.fn();
    source.observeDesktopWorkStatusChildren(operation, scope, await source.readDesktopWorkStatusChildren(operation, scope), changed);
    emit('session.execution.started', { sessionID: 'child' }, 'global'); expect(changed.mock.calls.at(-1)![0][0].activity).toBe('working');
    for (const listener of h.listeners.get('runtime.disconnected') ?? []) listener({ key: 'global', expectedHost: identity });
    expect(changed.mock.calls.at(-1)![0][0].activity).toBe('unknown');
    emit('reconnected', {}, 'global'); emit('session.idle', { sessionID: 'child' }, 'global', undefined, null);
    expect(changed.mock.calls.at(-1)![0][0].activity).toBe('unknown');
    emit('session.execution.started', { sessionID: 'child' }, 'global'); expect(changed.mock.calls.at(-1)![0][0].activity).toBe('working');
    h.lifecycle = 'background'; h.effects[before]!(); expect(changed.mock.calls.at(-1)![0][0].activity).toBe('unknown');
    const count = changed.mock.calls.length; h.lifecycle = 'active'; h.effects[before]!(); await flush();
    emit('session.execution.started', { sessionID: 'child' }, 'global'); expect(changed).toHaveBeenCalledTimes(count);
  });
});
