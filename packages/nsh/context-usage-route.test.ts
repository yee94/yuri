import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from './model';
import { createContextUsageRoute, type ContextMessageCommit } from './context-usage-route-core';

const h = vi.hoisted(() => ({
  call: vi.fn(), cleanups: [] as Array<() => void>, disposers: [] as Array<() => void>,
  listeners: new Map<string, Set<(value: unknown) => void>>(), setLifecycle: (_value: string) => {},
}));
// Small dependency-tracked signal fixture. The production createChat/writers/route are not replaced.
vi.mock('nsh', () => {
  type Reaction = { run: () => void; stop: () => void };
  let reading: Reaction | undefined, depth = 0, flushing = false;
  const queued = new Set<Reaction>();
  const dependencies = new Map<Reaction, Set<Set<Reaction>>>();
  function flush() {
    if (depth || flushing) return;
    flushing = true;
    try { while (queued.size) { const next = queued.values().next().value!; queued.delete(next); next.run(); } }
    finally { flushing = false; }
  }
  function signal<T>(initial: T) {
    let value = initial; const observers = new Set<Reaction>();
    const get = () => { if (reading) { observers.add(reading); dependencies.get(reading)!.add(observers); } return value; };
    const set = (next: T) => { if (Object.is(value, next)) return; value = next; for (const observer of observers) queued.add(observer); flush(); };
    return Object.assign(get, { set, update: (work: (value: T) => T) => set(work(value)) });
  }
  const lifecycle = signal('active'); h.setLifecycle = lifecycle.set;
  return {
    signal, lifecycle, locale: () => 'en-US',
    batch: <T>(work: () => T) => { depth++; try { return work(); } finally { depth--; flush(); } },
    untracked: <T>(work: () => T) => { const previous = reading; reading = undefined; try { return work(); } finally { reading = previous; } },
    cleanup: (work: () => void) => h.cleanups.push(work),
    effect: (work: () => void | (() => void)) => {
      let stopped = false, cleanup: void | (() => void);
      const reaction: Reaction = { run: () => {
        if (stopped) return;
        cleanup?.(); dependencies.get(reaction)?.forEach(set => set.delete(reaction)); dependencies.set(reaction, new Set());
        const previous = reading; reading = reaction;
        try { cleanup = work(); } finally { reading = previous; }
      }, stop: () => { stopped = true; queued.delete(reaction); dependencies.get(reaction)?.forEach(set => set.delete(reaction)); cleanup?.(); dependencies.delete(reaction); } };
      h.disposers.push(reaction.stop); reaction.run();
    },
    Storage: { getItem: async () => null, setItem: async () => {} },
    host: { available: () => true, call: h.call, on: (name: string, listener: (value: unknown) => void) => {
      const listeners = h.listeners.get(name) ?? new Set(); listeners.add(listener); h.listeners.set(name, listeners); return () => { listeners.delete(listener); };
    } },
  };
});

const target = { kind: 'session' as const, id: 'context', title: 'Actual second session', directory: '/workspace/actual' };
const user = (id: string): Row => ({ id, type: 'user', text: id, time: { created: 1 } });
const assistant = (id: string, extra: Row = {}): Row => ({ id, type: 'assistant', sessionID: target.id, model: { id: 'model', providerID: 'actual' },
  cost: .002, tokens: { input: 1200, output: 100, reasoning: 20, cache: { read: 300, write: 40 } },
  time: { created: 1000, streamed: 2000, completed: 2100 }, finish: 'stop', content: [{ type: 'text', text: id }], ...extra });
const page = (rows: Row[] = [user('u'), assistant('a', { finish: 'tool-calls' }), assistant('b')], cursor?: string) => ({ data: [...rows].reverse(), ...(cursor ? { cursor: { next: cursor } } : {}) });
const catalog = { schemaVersion: 1, providers: [{ id: 'decoy', models: { wrong: { id: 'wrong', limit: { context: 1 } } } }, { id: 'actual', name: 'Actual provider', models: { model: { id: 'model', name: 'Actual model', limit: { context: 400000 } } } }] };
const flush = async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const emit = (type: string, body: Row = {}) => {
  for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key: 'chat', data: JSON.stringify({ type, data: { sessionID: target.id, ...body }, location: { directory: target.directory } }) });
};
const requests = () => h.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input as { path: string; method: string });
const streams = () => h.call.mock.calls.filter(([name]) => name === 'runtime.stream' || name === 'runtime.stop');
let read: (path: string) => unknown;
const routes: Array<ReturnType<typeof createContextUsageRoute>> = [];
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); h.cleanups = []; h.disposers = []; h.listeners.clear(); h.setLifecycle('active');
  read = path => {
    if (path.includes('/message?')) return page();
    if (path.startsWith('/api/session/context?')) return { id: target.id, directory: target.directory, title: target.title, time: { created: 1 } };
    if (path.startsWith('/api/config/catalog/providers?')) return catalog;
    if (path === '/api/session/active') return {};
    if (path.includes('/inbox?') || path.includes('/form?') || path.includes('/permission/request?')) return [];
    throw new Error('Unexpected production fixture GET: ' + path);
  };
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected: 'fixture', runtimeScope: { hostID: 'fixture', lease: 'fixture-lease' }, connections: [{ id: 'fixture', label: 'Fixture', url: 'https://fixture.example' }] };
    if (name === 'runtime.request') { if (input.method !== 'GET') throw new Error('Fixture forbids writes'); return { status: 200, body: await read(input.path) }; }
    return true;
  });
});
afterEach(() => { routes.splice(0).forEach(route => route.dispose()); h.disposers.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); vi.restoreAllMocks(); vi.useRealTimers(); });
async function open(wait = true) {
  const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target);
  if (wait) await flush();
  return { state, chat };
}
async function routeFor(opened: Awaited<ReturnType<typeof open>>) {
  const transport = await import('./runtime'), routeRead = vi.fn((path: string) => transport.request(path));
  const route = createContextUsageRoute({ chat: opened.chat, target, scope: opened.chat.messageScope,
    current: () => opened.state.isCurrentHostScope(opened.chat.messageScope.generation, opened.chat.messageScope.hostID), read: routeRead, showAssistantTps: true });
  routes.push(route); route.setActive(true); await flush(); return { route, routeRead };
}

describe('production createChat message commit observer', () => {
  it('notifies first GET only after resolved authority and committed rows; callback throws cannot interrupt writer or other listeners', async () => {
    const normal = read, gate = deferred<unknown>(); read = path => path.includes('/message?') ? gate.promise : normal(path);
    const { chat } = await open(false), seen: Array<{ resolved: boolean; ids: string[] }> = [];
    chat.observeMessageCommits(() => { throw new Error('Broken consumer'); });
    chat.observeMessageCommits(() => seen.push({ resolved: chat.messagesResolved(), ids: chat.messages().map(row => row.id) }));
    expect(seen).toEqual([]); expect(chat.messagesResolved()).toBe(false);
    gate.resolve(page()); await flush();
    expect(seen).toEqual([{ resolved: true, ids: ['u', 'a', 'b'] }]); expect(chat.messageReadError()).toBe('');
  });
  it('emits one touched batch containing multiple messages and does not rescan/diff the loaded window for the observer', async () => {
    const { chat } = await open(), seen: ContextMessageCommit[] = [];
    chat.observeMessageCommits(commit => seen.push(commit));
    emit('session.text.delta', { assistantMessageID: 'a', ordinal: 0, delta: '1' });
    emit('session.text.delta', { assistantMessageID: 'b', ordinal: 0, delta: '2' });
    await vi.advanceTimersByTimeAsync(32);
    expect(seen).toHaveLength(1); expect(seen[0]).toMatchObject({ kind: 'patch', messages: [{ id: 'a', text: 'a1' }, { id: 'b', text: 'b2' }] });
    const patch = seen[0]; if (patch.kind !== 'patch') throw new Error('Expected patch');
    expect(patch.messages[0]).toBe(chat.messages()[1]); expect(patch.messages[1]).toBe(chat.messages()[2]);
    seen.length = 0;
    emit('session.text.ended', { assistantMessageID: 'a', ordinal: 0, text: 'a1' });
    expect(seen).toEqual([]); // Buffered unchanged entries do not become duplicate commits.
  });
  it('hasGap never reports an unadopted new row, while adopted existing-row changes are still patched', async () => {
    const { chat } = await open(), seen: ContextMessageCommit[] = []; chat.hasGap.set(true);
    chat.observeMessageCommits(commit => seen.push(commit));
    emit('session.text.delta', { assistantMessageID: 'a', ordinal: 0, delta: ' adopted' });
    emit('session.text.delta', { assistantMessageID: 'not-adopted', ordinal: 0, delta: 'held outside window' });
    await vi.advanceTimersByTimeAsync(32);
    expect(seen).toMatchObject([{ kind: 'patch', messages: [{ id: 'a' }] }]); expect(chat.messages().some(row => row.id === 'not-adopted')).toBe(false);
    seen.length = 0; emit('session.text.delta', { assistantMessageID: 'not-adopted', ordinal: 0, delta: ' again' }); await vi.advanceTimersByTimeAsync(32);
    expect(seen).toEqual([]);
  });
  it('0 listeners/closed overview adds zero Message patch pushes, requests or draft-token work', async () => {
    const { chat } = await open(), listener = vi.fn(), off = chat.observeMessageCommits(listener); off(); h.call.mockClear();
    let messagePushes = 0; const original = Array.prototype.push;
    Array.prototype.push = function<T>(this: T[], ...values: T[]) {
      if (values.some(value => !!value && typeof value === 'object' && 'contextRaw' in value)) messagePushes++;
      return original.apply(this, values);
    };
    try {
      for (let index = 0; index < 200; index++) { emit('session.text.delta', { assistantMessageID: 'b', ordinal: 0, delta: '.' }); chat.setDraftText(`draft ${index}`); }
      await vi.advanceTimersByTimeAsync(32);
      expect(messagePushes).toBe(0); expect(listener).not.toHaveBeenCalled(); expect(requests()).toEqual([]);
    } finally { Array.prototype.push = original; }
  });
  it('GET/prepend/revert/clear/materialization commit snapshots and success follows the resolved transition', async () => {
    const normal = read; let marker: { messageID: string } | null = null;
    const slim = assistant('a', { content: [{ id: 'call', type: 'tool', name: 'read', slim: true, state: { status: 'completed' } }] });
    read = path => path.includes('/message/a?') ? assistant('a', { content: [{ id: 'call', type: 'tool', name: 'read', state: { status: 'completed', output: 'Actual exact body' } }] })
      : path.startsWith('/api/session/context?') ? { id: target.id, directory: target.directory, revert: marker }
      : path.includes('/message?') ? page([user('u'), slim, assistant('b')]) : normal(path);
    const { chat } = await open(), seen: ContextMessageCommit[] = [];
    chat.observeMessageCommits(commit => seen.push(commit));
    await chat.activityMaterialization.request(['a']); expect(seen.map(commit => commit.kind)).toEqual(['snapshot']);
    expect(chat.messages()[1].tools[0].state).toMatchObject({ output: 'Actual exact body' });
    seen.length = 0; marker = { messageID: 'b' }; chat.revert.set(marker); expect(chat.messagesResolved()).toBe(false); expect(seen).toEqual([{ kind: 'snapshot' }]);
    await chat.load(false, ['messages']); expect(chat.messagesResolved()).toBe(true); expect(seen.at(-1)?.kind).toBe('snapshot');
    marker = null; chat.revert.set(null); expect(chat.messagesResolved()).toBe(false);
    read = path => path.includes('/message?') ? page([]) : normal(path); await chat.load(false, ['messages']);
    expect(chat.messagesResolved()).toBe(true); expect(chat.messages()).toEqual([]); expect(seen.at(-1)).toEqual({ kind: 'snapshot' });
    // A real opaque prepend shares the same commit boundary.
    const rows = Array.from({ length: 20 }, (_, index) => assistant(`tail-${index}`));
    read = path => path.includes('/message?') ? path.includes('cursor=') ? page([user('older')]) : page(rows, 'opaque') : normal(path);
    await chat.load(false, ['messages']); seen.length = 0; await chat.loadOlder();
    expect(chat.messages()[0].id).toBe('older'); expect(seen).toEqual([{ kind: 'snapshot' }]); expect(chat.messagesResolved()).toBe(true);
  });
  it('Host retirement and cleanup clear subscriptions; late snapshots and stream events cannot notify', async () => {
    const opened = await open(), listener = vi.fn(), gate = deferred<unknown>(), normal = read;
    opened.chat.observeMessageCommits(listener); read = path => path.includes('/message?') ? gate.promise : normal(path);
    const loading = opened.chat.load(false, ['messages']); await flush();
    await opened.state.loadConnections({ forceReconnect: true }); gate.resolve(page([assistant('stale')])); await loading;
    emit('session.text.delta', { assistantMessageID: 'late', ordinal: 0, delta: 'stale' }); await vi.advanceTimersByTimeAsync(32);
    expect(listener).not.toHaveBeenCalled(); expect(opened.chat.messagesResolved()).toBe(false);
    const after = opened.chat.observeMessageCommits(listener); after();
  });
  it('destroyed Chat drops every callback and does not retain late subscriptions', async () => {
    const { chat } = await open(), listener = vi.fn(); chat.observeMessageCommits(listener);
    h.cleanups.splice(0).forEach(stop => stop());
    emit('session.text.delta', { assistantMessageID: 'b', ordinal: 0, delta: 'after close' }); await vi.advanceTimersByTimeAsync(32);
    chat.observeMessageCommits(listener); await chat.load(false, ['messages']); expect(listener).not.toHaveBeenCalled();
  });
});

describe('production read-only overview route with real Chat authority', () => {
  it('pending/failed first message GET stays unknown, while a successful empty retry resolves a real zero snapshot', async () => {
    const normal = read, gate = deferred<unknown>(); read = path => path.includes('/message?') ? gate.promise : normal(path);
    const opened = await open(false), { route } = await routeFor(opened);
    expect(route.owner.view()).toBeUndefined(); expect(route.owner.state()).toMatchObject({ resolved: false, loading: true });
    gate.resolve({ malformed: true }); await flush();
    expect(route.owner.view()).toBeUndefined(); expect(route.owner.state()).toMatchObject({ resolved: false, error: 'Invalid message page' });
    read = path => path.includes('/message?') ? page([]) : normal(path); await route.retry();
    expect(route.owner.state()).toMatchObject({ resolved: true, error: '' }); expect(route.owner.view()).toMatchObject({ messagesCount: 0, totalAssistantCost: 0 });
    expect(route.owner.known()).toMatchObject({ cost: true, tokens: { total: true } });
  });
  it('reads only exact session/catalog, then applies all same-batch message patches synchronously without another history scan', async () => {
    const opened = await open(), { route, routeRead } = await routeFor(opened);
    expect(routeRead.mock.calls.map(([path]) => path)).toEqual(['/api/session/context?directory=%2Fworkspace%2Factual', '/api/config/catalog/providers?directory=%2Fworkspace%2Factual']);
    expect(route.owner.view()).toMatchObject({ messagesCount: 3, totalAssistantCost: .004, providerModel: { providerName: 'Actual provider', contextLimit: 400000 } });
    const before = route.owner.operations();
    emit('session.text.delta', { assistantMessageID: 'a', ordinal: 0, delta: '1' }); emit('session.text.delta', { assistantMessageID: 'b', ordinal: 0, delta: '2' });
    await vi.advanceTimersByTimeAsync(32);
    expect(route.owner.message('a')?.parts[0]).toMatchObject({ text: 'a1' }); expect(route.owner.message('b')?.parts[0]).toMatchObject({ text: 'b2' });
    expect(route.owner.operations().messageVisits - before.messageVisits).toBe(2); expect(route.owner.operations().resets).toBe(before.resets); expect(routeRead).toHaveBeenCalledTimes(2);
    const draftBaseline = route.owner.operations(); for (let index = 0; index < 200; index++) opened.chat.setDraftText(`draft ${index}`);
    expect(route.owner.operations()).toEqual(draftBaseline); expect(routeRead).toHaveBeenCalledTimes(2);
  });
  it('GET failures and metadata errors preserve prior metrics/raw JSON; Retry performs GETs only and never writes', async () => {
    const opened = await open(), { route, routeRead } = await routeFor(opened), normal = read, prior = route.owner.view(), json = route.owner.json('b');
    read = path => { if (path.includes('/message?')) throw new Error('Actual GET failed'); return normal(path); };
    await opened.chat.load(false, ['messages']); expect(route.owner.state().error).toBe('Actual GET failed'); expect(route.owner.view()).toEqual(prior); expect(route.owner.json('b')).toBe(json);
    read = path => { if (path.includes('/catalog/providers?')) throw new Error('Actual catalog failed'); return normal(path); };
    await route.refresh(); expect(route.owner.state().error).toBe('Actual catalog failed'); expect(route.owner.view()).toEqual(prior);
    read = normal; await route.retry(); expect(route.owner.state().error).toBe(''); expect(opened.chat.messageReadError()).toBe('');
    expect(routeRead.mock.calls.every(([path]) => !path.includes('/message'))).toBe(true); expect(requests().every(request => request.method === 'GET')).toBe(true);
  });
  it('cold metadata failure remains unknown, not a fake zero snapshot, and explicit retry recovers', async () => {
    const opened = await open(), normal = read;
    read = path => { if (path.includes('/catalog/providers?')) throw new Error('cold metadata failed'); return normal(path); };
    const { route } = await routeFor(opened);
    expect(route.owner.view()).toBeUndefined(); expect(route.owner.state()).toMatchObject({ resolved: false, error: 'cold metadata failed' });
    read = normal; await route.refresh(); expect(route.owner.view()?.messagesCount).toBe(3); expect(route.owner.known().cost).toBe(true);
  });
  it('sync-only overview preserves the existing stream owner while display/composer/Goal become inactive', async () => {
    const opened = await open(), { route } = await routeFor(opened), { batch } = await import('nsh');
    const call = h.call.getMockImplementation()!;
    h.call.mockImplementation(async (name, input) => {
      if (name === 'runtime.request' && input.path.startsWith('/api/rpc/opencode.goal/get?')) {
        expect(input).toMatchObject({ method: 'POST', body: { input: { sessionID: target.id } } });
        return { status: 200, body: { output: { id: 'real-fixture-goal', objective: 'Existing active goal', status: 'active', rounds: 1, maxRounds: 20, boot: 'fixture', updatedAt: 1 } } };
      }
      return call(name, input);
    });
    const initialGoal = opened.chat.goal.observe(); await flush(); initialGoal();
    expect(opened.chat.goal.state().goal?.id).toBe('real-fixture-goal');
    h.call.mockImplementation(call);
    h.call.mockClear();
    const streamCount = streams().length;
    batch(() => { opened.chat.syncActive.set(true); opened.chat.active.set(false); }); await flush();
    expect(streams()).toHaveLength(streamCount);
    opened.chat.setDraftText('do not send');
    expect(await opened.chat.send()).toBe(false); expect(await opened.chat.command('goal', 'must not run')).toBe(false);
    const actionsAtStart = requests().length;
    expect(await opened.chat.cancelInbox('queued')).toBe(false); expect(await opened.chat.editInbox('queued')).toBe(false); expect(await opened.chat.steerInbox('queued')).toBe(false); await opened.chat.stop();
    expect(requests()).toHaveLength(actionsAtStart);
    expect(await opened.chat.goal.controller.toggle()).toBe('blocked');
    const stopGoal = opened.chat.goal.observe(); await flush(); stopGoal();
    emit('session.text.delta', { assistantMessageID: 'b', ordinal: 0, delta: ' overview' }); await vi.advanceTimersByTimeAsync(32);
    expect(route.owner.message('b')?.parts[0]).toMatchObject({ text: 'b overview' });
    expect(requests().some(request => request.method !== 'GET' || request.path.startsWith('/api/rpc/'))).toBe(false);
    batch(() => { opened.chat.active.set(true); opened.chat.syncActive.set(false); }); expect(streams()).toHaveLength(streamCount);
  });
  it('hidden/background route unsubscribes, performs zero patch work, and resumes with exactly one loaded-window snapshot', async () => {
    const opened = await open(), { route, routeRead } = await routeFor(opened), before = route.owner.operations();
    route.setActive(false);
    emit('session.text.delta', { assistantMessageID: 'b', ordinal: 0, delta: ' hidden' }); await vi.advanceTimersByTimeAsync(32);
    expect(route.owner.operations()).toEqual(before);
    route.setActive(true); route.setActive(true);
    expect(route.owner.operations().resets).toBe(before.resets + 1); expect(route.owner.message('b')?.parts[0]).toMatchObject({ text: 'b hidden' }); expect(routeRead).toHaveBeenCalledTimes(2);
    route.setActive(false); h.setLifecycle('inactive');
    const stopped = route.owner.operations(); emit('session.text.delta', { assistantMessageID: 'b', ordinal: 0, delta: ' ignored' }); await vi.advanceTimersByTimeAsync(32);
    expect(route.owner.operations()).toEqual(stopped);
    h.setLifecycle('active'); await flush(); route.setActive(true); expect(route.owner.operations().resets).toBe(stopped.resets + 1);
  });
  it('fences late metadata on hide/Host switch and rejects a mismatched captured Chat before any read', async () => {
    const opened = await open(), normal = read, gate = deferred<unknown>();
    read = path => path.includes('/catalog/providers?') ? gate.promise : normal(path);
    const { route, routeRead } = await routeFor(opened); route.setActive(false); gate.resolve(catalog); await flush();
    expect(route.owner.view()).toBeUndefined(); expect(routeRead).toHaveBeenCalledTimes(2);
    read = normal; route.setActive(true); await flush(); expect(route.owner.view()?.messagesCount).toBe(3);
    const late = deferred<unknown>(); read = path => path.includes('/catalog/providers?') ? late.promise : normal(path);
    const refresh = route.refresh(); await flush();
    await opened.state.loadConnections({ forceReconnect: true }); const previous = route.owner.operations(); late.resolve(catalog); await refresh; await route.refresh();
    expect(route.owner.operations()).toEqual(previous);
    expect(() => createContextUsageRoute({ chat: opened.chat, target, scope: { ...opened.chat.messageScope, directory: '/wrong-first-project' }, current: () => true, read: async () => { throw new Error('must not read'); }, showAssistantTps: true })).toThrow('captured Chat');
    route.dispose(); expect(route.owner.view()).toBeUndefined();
  });
});
