import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { sameRuntimeScope, type RuntimeScope } from './runtime-scope';

const h = vi.hoisted(() => ({
  call: vi.fn(), cleanups: [] as Array<() => void>, stops: [] as Array<() => void>, depth: 0,
  listeners: new Map<string, Set<(value: unknown) => void>>(), storage: new Map<string, string>(), setLifecycle: (_value: string) => {},
}));
vi.mock('nsh', () => {
  type Reaction = { run: () => void; deps: Set<Set<Reaction>>; stopped: boolean; dispose?: () => void };
  let current: Reaction | undefined, flushing = false;
  const pending = new Set<Reaction>();
  function flush() {
    if (h.depth || flushing) return; flushing = true;
    try { while (pending.size) { const next = pending.values().next().value!; pending.delete(next); if (!next.stopped) next.run(); } }
    finally { flushing = false; }
  }
  function signal<T>(value: T) {
    const deps = new Set<Reaction>();
    const get = () => { if (current) { deps.add(current); current.deps.add(deps); } return value; };
    const set = (next: T) => { if (Object.is(value, next)) return; value = next; for (const effect of deps) pending.add(effect); flush(); };
    return Object.assign(get, { set, update: (work: (previous: T) => T) => set(work(value)) });
  }
  function untracked<T>(work: () => T) { const previous = current; current = undefined; try { return work(); } finally { current = previous; } }
  function effect(work: () => unknown) {
    const reaction: Reaction = { deps: new Set(), stopped: false, run() {
      untracked(() => reaction.dispose?.()); reaction.dispose = undefined; reaction.deps.forEach(deps => deps.delete(reaction)); reaction.deps.clear();
      const previous = current; current = reaction;
      try { const dispose = work(); if (typeof dispose === 'function') reaction.dispose = dispose as () => void; } finally { current = previous; }
    } };
    h.stops.push(() => { if (reaction.stopped) return; reaction.stopped = true; pending.delete(reaction); reaction.deps.forEach(deps => deps.delete(reaction)); untracked(() => reaction.dispose?.()); });
    reaction.run();
  }
  const lifecycle = signal('active'); h.setLifecycle = lifecycle.set;
  return {
    signal, effect, untracked, lifecycle,
    batch: <T>(work: () => T) => { h.depth++; try { return work(); } finally { h.depth--; flush(); } }, cleanup: (work: () => void) => h.cleanups.push(work),
    Storage: { getItem: async (key: string) => h.storage.get(key) ?? null, setItem: async (key: string, value: string) => { h.storage.set(key, value); } },
    host: { available: () => true, call: h.call, on: (name: string, listener: (value: unknown) => void) => {
      const entries = h.listeners.get(name) ?? new Set(); entries.add(listener); h.listeners.set(name, entries); return () => { entries.delete(listener); };
    } },
  };
});

const target = { kind: 'session' as const, id: 's', title: 'Lease fixture', directory: '/fixture' };
const ticks = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const entries = () => ['A', 'B'].map(id => ({ id, label: id, url: `https://${id.toLowerCase()}.example`, lastUsedAt: 0 }));
const page = () => ({ data: Array.from({ length: 20 }, (_, index) => ({ id: `m-${index}`, type: 'user', text: `Body ${index}` })).reverse(), cursor: { next: 'older' } });
let nativeScope: RuntimeScope | null, selected: string, revision: number, legacy: boolean;
let listing: (() => unknown) | undefined, handler: (path: string, method: string, body: Record<string, unknown>) => unknown;
const snapshot = () => ({ connections: entries(), selected, ...(legacy ? {} : { runtimeScope: nativeScope }) });
function changeHost(id: string) { selected = id; nativeScope = { hostID: id, lease: `native-${++revision}` }; }
function background() { nativeScope = null; h.setLifecycle('background'); }
function foreground() { changeHost(selected); h.setLifecycle('active'); }
const requests = () => h.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input);
const mutations = () => requests().filter(input => input.method !== 'GET');
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); h.cleanups = []; h.stops = []; h.listeners.clear(); h.storage.clear(); h.depth = 0; h.setLifecycle('active');
  selected = 'A'; revision = 0; legacy = false; listing = undefined; changeHost('A');
  handler = (path, method, body) => {
    if (path === '/api/config/settings') return { projects: [{ id: 'project', name: 'Fixture', path: '/fixture' }] };
    if (path === '/api/yuri/session-index') return { available: true, directories: [] };
    if (path === '/api/yuri/scheduled-tasks') return { tasks: [] };
    if (path === '/api/yuri/assistants/snapshot') return { assistants: [] };
    if (path === '/api/debug/location') return [];
    if (path === '/api/session/active') return {};
    if (path === '/api/session' && method === 'POST') return { id: 'created', title: 'Created' };
    if (path === '/api/session/s?directory=%2Ffixture') return { id: 's' };
    if (path.startsWith('/api/session/s/message?')) return page();
    if (path.startsWith('/api/session/s/inbox?') || path.startsWith('/api/session/s/form?') || path === '/api/permission/request?directory=%2Ffixture') return [];
    if (path === '/api/session/s/interrupt?directory=%2Ffixture' && method === 'POST') return null;
    if (path === '/api/session/s/prompt?directory=%2Ffixture' && method === 'POST') return { id: body.id, sessionID: 's', type: 'user', payload: { text: body.text } };
    if (path === '/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Ffixture' && method === 'POST') return { output: null };
    if (path === '/api/magic-prompts' && method === 'GET') return {};
    throw new Error(`unknown_runtime_request:${method}:${path}`);
  };
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return listing ? await listing() : snapshot();
    if (name === 'connection.select') { if (!entries().some(entry => entry.id === input.id)) throw new Error('unknown_connection'); changeHost(input.id); return snapshot(); }
    if (name === 'runtime.stop') return true;
    if (name === 'runtime.stream') {
      if (input.expectedHost && !sameRuntimeScope(input.expectedHost, nativeScope)) throw new Error('stale_runtime_scope');
      return true;
    }
    if (name === 'runtime.request') {
      if (input.method !== 'GET' && !input.expectedHost) throw new Error('scope_required');
      if (input.expectedHost && !sameRuntimeScope(input.expectedHost, nativeScope)) throw new Error('stale_runtime_scope');
      return { status: 200, body: await handler(input.path, input.method, input.body) };
    }
    throw new Error(`unknown_native_call:${name}`);
  });
});
afterEach(() => { h.stops.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); vi.useRealTimers(); });
async function open() {
  const state = await import('./state'); await state.loadConnections(); state.runtimeLifecycle();
  const chat = state.createChat(target); await chat.draftReady; await ticks(); return { state, chat };
}

it('adopts the actual select response, including A→B→A leases, without a second list or old-owner rebinding', async () => {
  const { state, chat } = await open(), old = state.captureHostRequest(), initial = state.app.runtimeScope();
  h.call.mockClear(); await state.switchConnection('B'); expect(state.app.runtimeScope()).toEqual({ hostID: 'B', lease: 'native-2' });
  await state.switchConnection('A'); expect(state.app.runtimeScope()).toEqual({ hostID: 'A', lease: 'native-3' });
  expect(h.call.mock.calls.filter(([name]) => name === 'connection.list')).toHaveLength(0);
  expect(state.resumeChatOperations()).toBe(0); chat.setDraftText('old owner'); expect(await chat.send()).toBe(false);
  await expect(old('/api/session', 'POST')).rejects.toThrow('stale_runtime_scope');
  expect(mutations().at(-1).expectedHost).toEqual(initial);
});

it('same-Host foreground builds a new operation lane while preserving the Chat, window, rows, draft and reference owners', async () => {
  const { state, chat } = await open(), before = chat.messages(), row = before[0], draft = chat.draft, messages = chat.messages, scope = state.app.runtimeScope(), connection = state.app.connection();
  chat.setDraftText('keep text and selection'); await chat.flushDraft();
  background(); expect(state.app.runtimeScope()).toBeNull(); expect(chat.messages()).toBe(before); expect(chat.draft()).toBe('keep text and selection');
  const gate = deferred<unknown>(); listing = () => gate.promise; h.call.mockClear(); foreground(); await ticks();
  expect(state.app.runtimeScope()).toBeNull(); expect(requests()).toEqual([]); expect(h.call.mock.calls.filter(([name]) => name === 'runtime.stream')).toEqual([]);
  gate.resolve(snapshot()); await ticks();
  expect(state.app.runtimeScope()).not.toEqual(scope); expect(chat.messages).toBe(messages); expect(chat.draft).toBe(draft);
  expect(state.app.connection()).toBe(connection);
  expect(chat.messages()).toBe(before); expect(chat.messages()[0]).toBe(row); expect(chat.draft()).toBe('keep text and selection');
  expect(chat.messageScope.generation).toBe(state.epoch()); expect(chat.messagesResolved()).toBe(true);
  await chat.stop(); expect(mutations().at(-1).expectedHost).toEqual(state.app.runtimeScope());
  expect(state.resumeChatOperations()).toBe(0);
});

it('an old preparation continuation cannot dispatch or clear the resumed lane, even with identical Host id', async () => {
  const { state, chat } = await open(), gate = deferred<{ text: string }>();
  chat.setDraftText('old draft'); const sending = chat.send({ prepare: () => gate.promise }); await ticks();
  background(); foreground(); await ticks(); const nextScope = state.app.runtimeScope(); chat.setDraftText('new draft');
  // The unresolved old sender cannot retain ownership of the new operation lane.
  chat.historyBusy.set(true); expect(chat.historyBusy()).toBe(true); chat.historyBusy.set(false);
  const before = mutations().length; gate.resolve({ text: 'old compiled' }); expect(await sending).toBe(false);
  expect(mutations()).toHaveLength(before); expect(chat.draft()).toBe('new draft');
  await chat.stop(); expect(mutations().at(-1).expectedHost).toEqual(nextScope);
});

it('old page completions cannot overwrite prior windows or clear newer flights after foreground reconstruction', async () => {
  const { chat } = await open(), previous = chat.messages(), normal = handler, oldGate = deferred<unknown>(), nextGate = deferred<unknown>();
  let reads = 0;
  handler = (path, method, body) => path.includes('/message?') ? (++reads === 1 ? oldGate.promise : nextGate.promise) : normal(path, method, body);
  const old = chat.load(false, ['messages']); await ticks(); background(); foreground(); await ticks();
  oldGate.resolve({ data: [{ id: 'stale', type: 'user', text: 'stale' }] }); await old;
  expect(chat.messages()).toBe(previous); const count = requests().length;
  const joined = chat.load(false, ['messages']); await ticks(); expect(requests()).toHaveLength(count);
  nextGate.resolve(page()); await joined; expect(chat.messages()).toBe(previous);
});

it('an unknown mutation is never replayed on foreground recovery; late old acknowledgement has zero new-lane side effects', async () => {
  const { chat } = await open(), normal = handler, gate = deferred<unknown>();
  handler = (path, method, body) => path.includes('/prompt?') ? gate.promise : normal(path, method, body);
  chat.setDraftText('ambiguous'); const send = chat.send(); await ticks(); expect(mutations().filter(input => input.path.includes('/prompt?'))).toHaveLength(1);
  const oldID = chat.pendingSend()?.id; background(); foreground(); await ticks(); chat.setDraftText('newer text');
  gate.resolve({ id: oldID, sessionID: 's', type: 'user', payload: { text: 'ambiguous' } }); expect(await send).toBe(false);
  expect(chat.pendingSend()?.id).toBe(oldID); expect(chat.draft()).toBe('newer text');
  expect(mutations().filter(input => input.path.includes('/prompt?'))).toHaveLength(1);
});

it('failed selection re-reads only real Native authority; same-lease metadata rename does not reconnect', async () => {
  const { state, chat } = await open(), scope = state.app.runtimeScope(), connection = state.app.connection(), generation = state.epoch();
  state.app.projects.set([{ id: 'prior', path: '/prior', name: 'Prior' }]);
  await expect(state.switchConnection('unknown')).rejects.toThrow('unknown_connection');
  expect(state.app.runtimeScope()).toBe(scope); expect(state.app.connection()).toBe(connection); expect(state.epoch()).toBe(generation);
  listing = () => ({ ...snapshot(), connections: entries().map(entry => ({ ...entry, label: 'Renamed' })) }); h.call.mockClear(); await state.loadConnections(); await ticks();
  expect(state.app.runtimeScope()).toBe(scope); expect(state.app.connection()).toBe(connection); expect(state.epoch()).toBe(generation);
  expect(state.app.connections()[0]?.label).toBe('Renamed'); expect(requests()).toEqual([]);
  expect(h.call.mock.calls.filter(([name]) => name === 'runtime.stream' || name === 'runtime.stop')).toEqual([]);
  expect(chat.messages()).toHaveLength(20); expect(state.app.projects()[0]?.id).toBe('prior');
});

it('stale and malformed list replies cannot restore a retired lease or erase prior snapshots', async () => {
  const { state, chat } = await open(), previous = chat.messages(), gate = deferred<unknown>(), saved = snapshot();
  listing = () => gate.promise; const old = state.loadConnections();
  background(); foreground(); listing = undefined; await state.loadConnections();
  const scope = state.app.runtimeScope(); gate.resolve(saved); await old; await ticks(); expect(state.app.runtimeScope()).toBe(scope); expect(chat.messages()).toBe(previous);
  const connection = state.app.connection(); listing = () => ({ ...snapshot(), runtimeScope: { hostID: 'A' } });
  await expect(state.loadConnections()).rejects.toThrow('invalid_runtime_scope'); expect(state.app.connection()).toBe(connection); expect(state.app.runtimeScope()).toBe(scope);
});

it('legacy snapshots remain read-only and never manufacture a lease from Host id or JS generation', async () => {
  legacy = true; const { state, chat } = await open(); expect(state.app.runtimeScope()).toBeNull(); expect(chat.messages()).toHaveLength(20);
  h.call.mockClear(); chat.setDraftText('cannot write'); expect(await chat.send()).toBe(false); expect(chat.error()).toBe('scope_required');
  await expect(state.createSession({ id: 'p', path: '/fixture', name: 'Fixture' })).rejects.toThrow('scope_required'); expect(mutations()).toEqual([]);
  background(); foreground(); await ticks(); expect(chat.rebuildOperationLane()).toBe(false); expect(state.app.runtimeScope()).toBeNull();
  expect(chat.messages()).toHaveLength(20); expect(await chat.send()).toBe(false); expect(mutations()).toEqual([]);
});

it('Goal, compiler and creation use captured scopes, and unknown fixture operations remain strict errors', async () => {
  const { state, chat } = await open(); const stop = chat.goal.observe(); await ticks(); stop();
  expect(mutations().find(input => input.path.includes('opencode.goal/get'))?.expectedHost).toEqual(state.app.runtimeScope());
  await state.createSession({ id: 'p', path: '/fixture', name: 'Fixture' });
  expect(mutations().at(-1).expectedHost).toEqual(state.app.runtimeScope());
  const send = state.captureHostRequest(); await expect(send('/unsupported', 'POST')).rejects.toThrow('unknown_runtime_request');
  const count = requests().filter(input => input.path === '/unsupported').length; expect(count).toBe(1);
});

it('an actual compiler reference lookup keeps its old sender and cannot continue into new-scope prompt admission', async () => {
  const { state, chat } = await open(), normal = handler, gate = deferred<unknown>(), oldScope = state.app.runtimeScope();
  handler = (path, method, body) => path === '/api/magic-prompts' ? gate.promise : normal(path, method, body);
  chat.setDraftText('/explore');
  const { compileNativePrompt } = await import('./composer');
  const oldRequest = state.captureHostRequest();
  const send = chat.send({ prepare: input => compileNativePrompt(input, oldRequest) }); await ticks();
  expect(requests().find(input => input.path === '/api/magic-prompts')?.expectedHost).toEqual(oldScope);
  background(); foreground(); await ticks(); gate.resolve({}); expect(await send).toBe(false);
  expect(mutations().filter(input => input.path.includes('/prompt?'))).toEqual([]); expect(chat.draft()).toBe('/explore');
});

it('materializer late bodies are fenced across foreground while retained slim rows remain the same objects', async () => {
  const normal = handler, gate = deferred<unknown>();
  const slim = { id: 'slim', sessionID: 's', type: 'assistant', finish: 'stop', content: [{ id: 'tool', type: 'tool', name: 'bash', slim: true, state: { status: 'completed' } }] };
  handler = (path, method, body) => path.includes('/message?') ? { data: [slim] }
    : path === '/api/session/s/message/slim?directory=%2Ffixture' ? gate.promise : normal(path, method, body);
  const { chat, state } = await open(), previous = chat.messages(), scope = state.app.runtimeScope();
  const fill = chat.activityMaterialization.request(['slim']); await ticks();
  expect(requests().find(input => input.path.includes('/message/slim?'))?.expectedHost).toEqual(scope);
  background(); foreground(); await ticks();
  gate.resolve({ ...slim, content: [{ ...slim.content[0], slim: false, state: { status: 'completed', output: 'stale body' } }] });
  await fill; await ticks(); expect(chat.messages()).toBe(previous); expect(chat.messages()[0]?.tools[0]?.slim).toBe(true);
});

it('old queue failure cannot write a new-lane error or clear a new flight', async () => {
  const { chat } = await open(), normal = handler, oldGate = deferred<unknown>(), nextGate = deferred<unknown>();
  let calls = 0;
  handler = (path, method, body) => path.startsWith('/api/session/s/inbox?') ? (++calls === 1 ? oldGate.promise : nextGate.promise) : normal(path, method, body);
  const old = chat.cancelInbox('old'); await ticks(); background(); foreground(); await ticks();
  oldGate.resolve({ malformed: true }); expect(await old).toBe(false); expect(chat.queueError()).toBe(''); expect(chat.error()).toBe('');
  // Resolve the new foreground read without turning it into an old mutation.
  nextGate.resolve([]); await ticks(); expect(mutations().filter(input => input.method === 'DELETE')).toEqual([]);
});

it('a late createSession response cannot admit a session into a resumed or switched Host', async () => {
  const { state } = await open(), normal = handler, gate = deferred<unknown>();
  handler = (path, method, body) => path === '/api/session' ? gate.promise : normal(path, method, body);
  const created = state.createSession({ id: 'p', name: 'Fixture', path: '/fixture' });
  background(); foreground(); await ticks(); gate.resolve({ id: 'old-created' }); await expect(created).rejects.toThrow('Connection changed');
  expect(mutations().filter(input => input.path === '/api/session')).toHaveLength(1);
});

it('explicit page operation reconstruction restores same-Host foreground even when a fixture repeats its lease', async () => {
  const { state, chat } = await open(), old = state.captureHostOperation(), previous = chat.messages(), nativeBefore = nativeScope;
  expect(old.current()).toBe(true); background(); const gap = state.captureHostOperation(); expect(gap.current()).toBe(false);
  nativeScope = nativeBefore; h.setLifecycle('active'); await ticks();
  const replacement = state.captureHostOperation(); expect(replacement.current()).toBe(true); expect(replacement.scope).toEqual(old.scope);
  expect(replacement.generation).not.toBe(old.generation); expect(old.current()).toBe(false); expect(gap.current()).toBe(false);
  const attempts = requests().length;
  await expect(old.request('/api/session/s/interrupt?directory=%2Ffixture', 'POST', {})).rejects.toThrow('host_operation_stale');
  expect(requests()).toHaveLength(attempts);
  expect(chat.messages()).toBe(previous); await replacement.request('/api/session/s/interrupt?directory=%2Ffixture', 'POST', {});
  expect(Object.isFrozen(replacement)).toBe(true);
});
