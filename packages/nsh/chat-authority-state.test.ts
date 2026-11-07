import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  call: vi.fn(), cleanups: [] as Array<() => void>, effects: [] as Array<() => void | (() => void)>, disposers: [] as Array<() => void>,
  listeners: new Map<string, Set<(value: unknown) => void>>(), observers: [] as Array<() => void>, depth: 0, pending: false, lifecycle: 'active',
}));
vi.mock('nsh', () => {
  const notify = () => { if (h.depth) { h.pending = true; return; } h.observers.forEach(observer => observer()); };
  return {
    signal: <T>(value: T) => Object.assign(() => value, { set: (next: T) => { if (!Object.is(value, next)) { value = next; notify(); } } }),
    batch: <T>(work: () => T) => { h.depth++; try { return work(); } finally { if (!--h.depth && h.pending) { h.pending = false; notify(); } } },
    untracked: <T>(work: () => T) => work(), lifecycle: () => h.lifecycle,
    cleanup: (work: () => void) => h.cleanups.push(work),
    effect: (work: () => void | (() => void)) => { h.effects.push(work); const stop = work(); if (stop) h.disposers.push(stop); },
    Storage: { getItem: async () => null, setItem: async () => {} },
    host: { available: () => true, call: h.call, on: (name: string, listener: (value: unknown) => void) => { const entries = h.listeners.get(name) ?? new Set(); entries.add(listener); h.listeners.set(name, entries); return () => { entries.delete(listener); }; } },
  };
});
const target = { kind: 'session' as const, id: 'authority-scope', title: 'Authority fixture', directory: '/fixture' };
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const page = (ids: string[] = ['initial']) => ({ data: ids.map(id => ({ id, type: 'assistant', text: id })).reverse() });
const emit = (type: string, data: Record<string, unknown> = {}, key = 'chat') => {
  for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key, data: JSON.stringify({ type, data: { sessionID: target.id, ...data } }) });
};
let read: (path: string) => unknown;
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); h.cleanups = []; h.effects = []; h.disposers = []; h.observers = []; h.listeners.clear(); h.depth = 0; h.pending = false; h.lifecycle = 'active';
  read = path => path.includes('/message?') ? page() : path.includes('/contact/messages') ? { messages: [{ id: 'contact-old', role: 'assistant', text: 'Old', ordinal: 1 }], generation: 1, revision: 1, complete: true }
    : path.startsWith('/api/session/authority-scope?') ? { id: target.id } : path === '/api/session/active' ? {} : path.endsWith('/assistants/snapshot') ? { assistants: [{ id: 'bot', working: false }] } : [];
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected: 'fixture', runtimeScope: { hostID: 'fixture', lease: 'fixture-lease' }, connections: [{ id: 'fixture', label: 'Fixture', url: 'https://fixture.example' }] };
    if (name === 'runtime.request') return { status: 200, body: await read(input.path) };
    return true;
  });
});
afterEach(() => { h.observers = []; h.disposers.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); vi.useRealTimers(); });
async function open(assistant = false) { const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(assistant ? { ...target, kind: 'assistant', id: 'bot' } : target); await flush(); return { state, chat }; }
function changes<T>(reader: () => T) { let previous = reader(); const values: T[] = []; h.observers.push(() => { const next = reader(); if (!Object.is(previous, next)) { values.push(next); previous = next; } }); return values; }

it('keeps failed hydration unresolved despite live events, status success and finally; successful empty GET resolves', async () => {
  const normal = read; read = path => { if (path.includes('/message?')) throw new Error('fixture hydration offline'); return normal(path); };
  const { chat } = await open(); expect(chat.messagesResolved()).toBe(false);
  emit('server.connected'); emit('session.execution.started'); emit('session.text.delta', { assistantMessageID: 'live', ordinal: 0, delta: 'visible' });
  await vi.advanceTimersByTimeAsync(32); await chat.load(false, ['status']);
  expect(chat.messages().length).toBeGreaterThan(0); expect(chat.messagesResolved()).toBe(false);
  read = path => path.includes('/message?') ? page([]) : normal(path); await chat.load(false, ['messages']);
  expect(chat.messagesResolved()).toBe(true);
});

it('a pending first GET is unresolved and a genuinely empty authority is resolved success', async () => {
  const normal = read, gate = deferred<unknown>();
  read = path => path.includes('/message?') ? gate.promise : normal(path);
  const { chat } = await open();
  expect(chat.loading()).toBe(true); expect(chat.messagesResolved()).toBe(false);
  gate.resolve(page([])); await flush();
  expect(chat.loading()).toBe(false); expect(chat.messagesResolved()).toBe(true); expect(chat.messages()).toEqual([]);
});

it('does not toggle resolved or historyGeneration for ordinary polls or older load start/failure', async () => {
  const normal = read;
  read = path => path.includes('/message?') ? { ...page(Array.from({ length: 20 }, (_, i) => `m-${i}`)), cursor: { next: 'opaque' } } : normal(path);
  const { chat } = await open(); const generation = chat.historyGeneration();
  const resolvedChanges = changes(chat.messagesResolved), generationChanges = changes(chat.historyGeneration);
  for (let i = 0; i < 10; i++) await chat.load(false, ['messages']);
  const gate = deferred<unknown>(); read = path => path.includes('/message?') ? gate.promise : normal(path);
  const older = chat.load(true); await flush(); expect(chat.messagesResolved()).toBe(true);
  gate.resolve({ malformed: true }); await older;
  expect(chat.messagesResolved()).toBe(true); expect(chat.historyGeneration()).toBe(generation);
  expect(resolvedChanges).toEqual([]); expect(generationChanges).toEqual([]);
});

it('failed tail revalidation preserves an already resolved authority without manufacturing a reset', async () => {
  const { chat } = await open(); const before = chat.historyGeneration(), previous = chat.messages(), normal = read;
  read = path => { if (path.includes('/message?')) throw new Error('fixture tail offline'); return normal(path); };
  await chat.load(false, ['messages']);
  expect(chat.messagesResolved()).toBe(true); expect(chat.messages()).toBe(previous); expect(chat.historyGeneration()).toBe(before);
});

it('increments reset epoch only for changed revert boundaries, leaving reset unresolved until the next messages authority', async () => {
  const { chat } = await open(); const initial = chat.historyGeneration();
  const normal = read; let marker: { messageID: string } | null = { messageID: 'initial' };
  read = path => path.startsWith('/api/session/authority-scope?') ? { id: target.id, revert: marker } : normal(path);
  chat.revert.set({ messageID: 'initial' });
  expect(chat.historyGeneration()).toBe(initial + 1); expect(chat.messagesResolved()).toBe(false);
  chat.revert.set({ messageID: 'initial', files: [] }); expect(chat.historyGeneration()).toBe(initial + 1);
  await chat.load(false, ['status']); expect(chat.messagesResolved()).toBe(false);
  await chat.load(false, ['messages']); expect(chat.messagesResolved()).toBe(true);
  const now = chat.historyGeneration(); marker = null; chat.revert.set(null);
  expect(chat.historyGeneration()).toBe(now + 1); expect(chat.messagesResolved()).toBe(false);
});

it('does not publish old messages as resolved in a newer contact reset scope', async () => {
  const { chat } = await open(true); const before = chat.historyGeneration();
  const seen: Array<{ generation: number; resolved: boolean; ids: string[] }> = [];
  h.observers.push(() => seen.push({ generation: chat.historyGeneration(), resolved: chat.messagesResolved(), ids: chat.messages().map(message => message.id) }));
  const normal = read;
  read = path => path.includes('/contact/messages') ? { messages: [{ id: 'contact-new', role: 'assistant', text: 'New', ordinal: 1 }], generation: 2, revision: 1, complete: true } : normal(path);
  await chat.load(false, ['messages']);
  expect(chat.historyGeneration()).toBe(before + 1); expect(chat.messagesResolved()).toBe(true);
  expect(seen.filter(snapshot => snapshot.generation > before && snapshot.resolved).every(snapshot => snapshot.ids.join() === 'contact-new')).toBe(true);
  await chat.load(false, ['messages']); expect(chat.historyGeneration()).toBe(before + 1);
});

it('tracks parallel text ordinals and publishes the final body before dropping the last streaming membership', async () => {
  const { chat } = await open();
  emit('session.text.started', { assistantMessageID: 'reply', ordinal: 0 });
  emit('session.text.started', { assistantMessageID: 'reply', ordinal: 1 });
  expect([...chat.streamingMessageIDs()]).toEqual(['reply']);
  emit('session.text.ended', { assistantMessageID: 'reply', ordinal: 0, text: 'First final' });
  expect(chat.streamingMessageIDs().has('reply')).toBe(true);
  emit('session.text.ended', { assistantMessageID: 'reply', ordinal: 1, text: 'Second final' });
  expect(chat.streamingMessageIDs().has('reply')).toBe(false);
  expect(chat.messages().find(message => message.id === 'reply')?.text).toBe('First final\n\nSecond final');
  emit('session.text.delta', { assistantMessageID: 'reply', ordinal: 1, delta: 'duplicate late' });
  expect(chat.streamingMessageIDs().has('reply')).toBe(false);
});

it('ending one text part does not disturb another message or publish a duplicate membership', async () => {
  const { chat } = await open(); const publishes = changes(chat.streamingMessageIDs);
  emit('session.text.started', { assistantMessageID: 'first', ordinal: 0 });
  emit('session.text.started', { assistantMessageID: 'first', ordinal: 1 });
  emit('session.text.delta', { assistantMessageID: 'second', ordinal: 0, delta: 'Second' });
  expect(publishes).toHaveLength(2);
  emit('session.text.ended', { assistantMessageID: 'first', ordinal: 1, text: 'One' });
  expect(publishes).toHaveLength(2);
  emit('session.text.ended', { assistantMessageID: 'first', ordinal: 0, text: 'Zero' });
  expect([...chat.streamingMessageIDs()]).toEqual(['second']); expect(publishes).toHaveLength(3);
  emit('session.text.ended', { assistantMessageID: 'first', ordinal: 0, text: 'Zero' }); expect(publishes).toHaveLength(3);
});

it('100 tokens and repeated starts do not republish streaming selection Sets or trigger history requests', async () => {
  const { chat } = await open(); h.call.mockClear(); const publishes = changes(chat.streamingMessageIDs);
  emit('session.text.started', { assistantMessageID: 'reply', ordinal: 0 }); const selected = chat.streamingMessageIDs();
  for (let i = 0; i < 100; i++) { emit('session.text.started', { assistantMessageID: 'reply', ordinal: 0 }); emit('session.text.delta', { assistantMessageID: 'reply', ordinal: 0, delta: 'a' }); }
  await vi.advanceTimersByTimeAsync(32);
  expect(chat.streamingMessageIDs()).toBe(selected); expect(publishes).toHaveLength(1);
  expect(h.call.mock.calls.filter(([name]) => name === 'runtime.request')).toHaveLength(0);
  emit('session.text.ended', { assistantMessageID: 'reply', ordinal: 0, text: 'a'.repeat(100) }); expect(publishes).toHaveLength(2);
});

it('does not infer per-message streaming from SSE, busy, reasoning or tools; terminal events clear true text streams', async () => {
  const { chat } = await open(); const empty = chat.streamingMessageIDs();
  emit('server.connected'); emit('session.execution.started');
  emit('session.reasoning.delta', { assistantMessageID: 'reason', ordinal: 0, delta: 'thinking' });
  emit('session.tool.input.started', { assistantMessageID: 'tool', id: 'call', name: 'shell' });
  emit('session.text.delta', { assistantMessageID: 'invalid', ordinal: 0 });
  expect(chat.streamingMessageIDs()).toBe(empty);
  for (const terminal of ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.idle', 'session.error']) {
    emit('session.text.delta', { assistantMessageID: terminal, ordinal: 0, delta: 'real' });
    expect(chat.streamingMessageIDs().size).toBe(1); emit(terminal); expect(chat.streamingMessageIDs().size).toBe(0);
  }
});

it('contact bubble delta/done tracks each real bubble independently, not turn busy', async () => {
  const { chat } = await open(true); const send = (type: string, data: Record<string, unknown>) => emit(type, { assistantID: 'bot', ...data }, 'global');
  send('yuri:contact-turn-start', { turnID: 'turn' }); expect(chat.streamingMessageIDs().size).toBe(0);
  send('yuri:contact-bubble-delta', { turnID: 'turn', bubbleIndex: 0, delta: 'First', done: false });
  send('yuri:contact-bubble-delta', { turnID: 'turn', bubbleIndex: 1, delta: 'Second', done: false });
  send('yuri:contact-bubble-delta', { turnID: 'turn', bubbleIndex: 0, delta: '', done: true });
  expect([...chat.streamingMessageIDs()]).toEqual(['turn:bubble:2']);
  expect(chat.messages().find(message => message.id === 'turn:bubble:1')?.text).toBe('First');
  send('yuri:contact-turn-end', { turnID: 'turn', status: 'complete' }); expect(chat.streamingMessageIDs().size).toBe(0);
});

it('a new empty contact generation clears real bubble streaming and resolves only the new empty snapshot', async () => {
  const { chat } = await open(true); const before = chat.historyGeneration();
  emit('yuri:contact-bubble-delta', { assistantID: 'bot', turnID: 'turn', bubbleIndex: 0, delta: 'Real', done: false }, 'global');
  expect(chat.streamingMessageIDs().size).toBe(1);
  const normal = read;
  read = path => path.includes('/contact/messages') ? { messages: [], complete: true, generation: 2, revision: 1 } : normal(path);
  await chat.load(false, ['messages']);
  expect(chat.historyGeneration()).toBe(before + 1); expect(chat.messagesResolved()).toBe(true);
  expect(chat.messages()).toEqual([]); expect(chat.streamingMessageIDs().size).toBe(0);
});

it('clears true streaming on hide/background/cleanup and immediately fences Host reset resolution', async () => {
  const { state, chat } = await open();
  emit('session.text.delta', { assistantMessageID: 'reply', ordinal: 0, delta: 'text' });
  chat.active.set(false); expect(chat.streamingMessageIDs().size).toBe(0);
  h.disposers[0](); chat.active.set(true); expect(chat.streamingMessageIDs().size).toBe(0);
  emit('session.text.delta', { assistantMessageID: 'next', ordinal: 0, delta: 'text' });
  h.lifecycle = 'background'; expect(chat.streamingMessageIDs().size).toBe(0); h.disposers[0](); h.lifecycle = 'active';
  expect(chat.streamingMessageIDs().size).toBe(0);
  const before = chat.historyGeneration(); await state.loadConnections({ forceReconnect: true });
  expect(chat.messagesResolved()).toBe(false); expect(chat.historyGeneration()).toBe(before + 1); expect(chat.streamingMessageIDs().size).toBe(0);
});

it('committed reset is unresolved and does not increment twice for the same committed boundary', async () => {
  const { chat } = await open(); const before = chat.historyGeneration();
  emit('session.revert.committed', { to: 'initial' });
  expect(chat.messagesResolved()).toBe(false); expect(chat.historyGeneration()).toBe(before + 1);
  emit('session.revert.committed', { to: 'initial' }); expect(chat.historyGeneration()).toBe(before + 1);
});

it('an anonymous committed repair stays unresolved through hydration failure, then resolves its successful empty rebuild', async () => {
  const { chat } = await open(); const before = chat.historyGeneration(), normal = read;
  emit('session.revert.committed'); emit('session.revert.committed');
  expect(chat.historyGeneration()).toBe(before + 1); expect(chat.messagesResolved()).toBe(false);
  read = path => { if (path.includes('/message?')) throw new Error('fixture rebuild offline'); return normal(path); };
  await chat.load(false, ['messages']); expect(chat.messagesResolved()).toBe(false);
  read = path => path.includes('/message?') ? page([]) : normal(path);
  await chat.load(false, ['messages']);
  expect(chat.messagesResolved()).toBe(true); expect(chat.messages()).toEqual([]); expect(chat.historyGeneration()).toBe(before + 1);
});

it('a pre-reset GET cannot restore resolved success after the Host authority has retired', async () => {
  const { state, chat } = await open(); const gate = deferred<unknown>(), normal = read;
  read = path => path.includes('/message?') ? gate.promise : normal(path);
  const pending = chat.load(false, ['messages']); await flush();
  const before = chat.historyGeneration(); const reconnect = state.loadConnections({ forceReconnect: true });
  expect(chat.messagesResolved()).toBe(false); expect(chat.historyGeneration()).toBe(before + 1);
  gate.resolve(page(['stale-host'])); await pending; await reconnect;
  expect(chat.messagesResolved()).toBe(false); expect(chat.messages().map(message => message.id)).toEqual(['initial']);
});
