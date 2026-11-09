import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { captureIssuedStream, issuedStream, resetIssuedStreams } from './tests/session-stream-fixture';
import type { NativeHistoryPresentation } from './history-presentation';

const h = vi.hoisted(() => ({
  call: vi.fn(), cleanups: [] as Array<() => void>, stops: [] as Array<() => void>, depth: 0,
  listeners: new Map<string, Set<(value: unknown) => void>>(),
  watch: (_read: () => void): (() => void) => () => {}, setLifecycle: (_value: string) => {},
}));

// Dependency-tracked signals: a UI observer only runs for fields it read, and
// nested batches flush once. This is not the native engine or a UIKit proof.
vi.mock('nsh', () => {
  type Node = Set<Reaction>;
  type Reaction = { run: () => void; nodes: Set<Node>; disposed: boolean; dispose?: () => void };
  let current: Reaction | undefined, flushing = false;
  const pending = new Set<Reaction>();
  function flush() {
    if (h.depth || flushing) return;
    flushing = true;
    try { while (pending.size) { const next = pending.values().next().value!; pending.delete(next); if (!next.disposed) next.run(); } }
    finally { flushing = false; }
  }
  function signal<T>(value: T) {
    const node: Node = new Set();
    const get = () => { if (current) { node.add(current); current.nodes.add(node); } return value; };
    const set = (next: T) => {
      if (Object.is(value, next)) return;
      value = next; for (const reaction of node) pending.add(reaction); flush();
    };
    return Object.assign(get, { set, update: (work: (previous: T) => T) => set(work(value)) });
  }
  function untracked<T>(work: () => T) { const previous = current; current = undefined; try { return work(); } finally { current = previous; } }
  function effect(work: () => unknown) {
    const reaction: Reaction = { nodes: new Set(), disposed: false, run() {
      untracked(() => reaction.dispose?.()); reaction.dispose = undefined;
      reaction.nodes.forEach(node => node.delete(reaction)); reaction.nodes.clear();
      const previous = current; current = reaction;
      try { const dispose = work(); if (typeof dispose === 'function') reaction.dispose = dispose as () => void; }
      finally { current = previous; }
    } };
    const stop = () => { if (reaction.disposed) return; reaction.disposed = true; pending.delete(reaction); reaction.nodes.forEach(node => node.delete(reaction)); untracked(() => reaction.dispose?.()); };
    h.stops.push(stop); reaction.run(); return stop;
  }
  const life = signal('active'); h.setLifecycle = life.set; h.watch = effect;
  return {
    signal, effect, untracked, lifecycle: life,
    batch: <T>(work: () => T) => { h.depth++; try { return work(); } finally { h.depth--; flush(); } },
    cleanup: (work: () => void) => h.cleanups.push(work),
    Storage: { getItem: async () => null, setItem: async () => {} },
    host: { available: () => true, call: h.call, on: (name: string, listener: (value: unknown) => void) => {
      const entries = h.listeners.get(name) ?? new Set(); entries.add(listener); h.listeners.set(name, entries); return () => { entries.delete(listener); };
    } },
  };
});

const target = { kind: 'session' as const, id: 'presentation-scope', title: 'History', directory: '/fixture' };
const ticks = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const wireRows = (start: number, count = 20) => Array.from({ length: count }, (_, index) => ({ id: `m-${start + index}`, type: 'user', text: `Body ${start + index}` }));
const page = (start = 20, next: string | null = 'older', count = 20) => ({ data: wireRows(start, count).reverse(), cursor: { next } });
let read: (path: string, method: string, body: Record<string, unknown>) => unknown;
let marker: { messageID: string } | null;
const emit = (type: string, data: Record<string, unknown> = {}) => {
  for (const listener of h.listeners.get('runtime.event') ?? []) listener({ ...issuedStream(h.call), data: JSON.stringify({ type, data: { sessionID: target.id, ...data } }) });
};
beforeEach(() => {
  resetIssuedStreams(h.call);
  vi.resetModules(); vi.useFakeTimers(); h.call.mockReset(); h.cleanups = []; h.stops = []; h.listeners.clear(); h.depth = 0; h.setLifecycle('active'); marker = null;
  read = path => path.includes('/message?') ? page() : path.startsWith(`/api/session/${target.id}?`) ? { id: target.id, revert: marker }
    : path === '/api/session/active' ? {} : [];
  h.call.mockImplementation(async (name, input) => {
    if (name === 'runtime.stream') captureIssuedStream(h.call, input);
    if (name === 'connection.list') return { selected: 'fixture', runtimeScope: { hostID: 'fixture', lease: 'fixture-lease' }, connections: [{ id: 'fixture', label: 'Fixture', url: 'https://fixture.example' }] };
    if (name === 'runtime.request') return { status: 200, body: await read(input.path, input.method, input.body) };
    return true;
  });
});
afterEach(() => { h.stops.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); vi.useRealTimers(); });

async function open(options: { throws?: boolean; listener?: boolean; assistant?: boolean; footerController?: boolean; footerEnabled?: boolean } = {}) {
  const state = await import('./state'), reactive = await import('nsh'); await state.loadConnections();
  const presentation = reactive.signal<NativeHistoryPresentation | null>(null), footprint = reactive.signal(0);
  const notices: NativeHistoryPresentation[] = [], depths: number[] = [];
  const { createNativeHistoryFooterController } = await import('./history-footer-controller');
  const footerController = options.footerController ? createNativeHistoryFooterController({ current: () => reactive.lifecycle() === 'active', changed: value => footprint.set(value.minHeight) }) : undefined;
  footerController?.setEnabled(options.footerEnabled ?? false);
  const callback = (next: NativeHistoryPresentation) => {
    depths.push(h.depth); notices.push(next); presentation.set(next);
    if (footerController) footerController.beforeHistoryPresentationFlush(next);
    else if (next.authority === 'reset') footprint.set(0);
    else if (next.authority === 'successful-history' && !visible(next) && !next.readError) footprint.set(53);
    if (options.throws) throw new Error('fixture observer failure');
  };
  const chat = state.createChat(options.assistant ? { ...target, kind: 'assistant', id: 'bot' } : target, options.listener === false ? {} : { beforeHistoryPresentationFlush: callback });
  await ticks();
  const frames: Array<{ next: NativeHistoryPresentation | null; footprint: number; ids: string[] }> = [];
  h.watch(() => {
    const next = presentation();
    const facts = { more: chat.more(), historyError: chat.historyError(), boundaryMissing: chat.historyBoundaryMissing(), repairPending: chat.historyRepairPending(), hasGap: chat.hasGap(), readError: chat.messageReadError(), resolved: chat.messagesResolved() };
    const historyGeneration = chat.historyGeneration(), rows = chat.messages();
    const height = footprint();
    if (next && chat.active() && reactive.lifecycle() === 'active' && state.isCurrentHostScope(next.scope.generation, next.scope.hostID)) {
      expect(facts).toEqual({ more: next.more, historyError: next.historyError, boundaryMissing: next.boundaryMissing, repairPending: next.repairPending, hasGap: next.hasGap, readError: next.readError, resolved: next.resolved });
      expect(historyGeneration).toBe(next.scope.historyGeneration);
    }
    frames.push({ next, footprint: height, ids: rows.map(row => row.id) });
  });
  return { state, chat, notices, frames, depths, presentation, footprint, footerController };
}
function visible(next: NativeHistoryPresentation) { return next.more || !!next.historyError || next.boundaryMissing || next.repairPending || next.hasGap; }

it('actual createChat adoption flushes production controller footprint with rows without awaiting a pending natural ref', async () => {
  const { chat, frames, footprint, footerController: controller } = await open({ footerController: true, footerEnabled: true });
  const gate = deferred<{ bounds: { size: { height: number } } }>();
  const natural = controller!.captureNatural(), node = { measure: () => gate.promise };
  natural.ref(node); natural.onLayout({ bounds: { size: { height: 37.25 } } });
  controller!.captureEvents().onScroll({ offset: { y: 0 } });
  const confirming = natural.confirm(), before = frames.length, normal = read;
  read = (path, method, body) => path.includes('cursor=older') ? page(0, null) : normal(path, method, body);
  await chat.loadOlder();
  expect(chat.messages()).toHaveLength(40); expect(footprint()).toBe(37.25);
  const terminal = frames.slice(before).filter(frame => frame.next?.authority === 'successful-history' && !visible(frame.next));
  expect(terminal).toHaveLength(1); expect(terminal[0]).toMatchObject({ footprint: 37.25 }); expect(terminal[0]!.ids).toHaveLength(40);
  gate.resolve({ bounds: { size: { height: 99 } } });
  expect(await confirming).toBe('stale'); expect(footprint()).toBe(37.25);
}, 15000);

it('actual production controller remains OFF by default and adopts history when natural measure never resolves', async () => {
  const { chat, footprint, footerController: controller } = await open({ footerController: true });
  const natural = controller!.captureNatural(); natural.ref({ measure: () => new Promise(() => {}) }); void natural.confirm();
  controller!.captureEvents().onScroll({ offset: { y: 0 } });
  const normal = read; read = (path, method, body) => path.includes('cursor=older') ? page(0, null) : normal(path, method, body);
  await chat.loadOlder();
  expect(chat.messages()).toHaveLength(40); expect(footprint()).toBe(0); expect(controller!.snapshot().enabled).toBe(false);
}, 15000);

it('flushes final exhausted facts, rows and a synchronous UI footprint in one dependency-tracked batch', async () => {
  const { chat, notices, frames, depths } = await open(); const before = frames.length;
  const normal = read; read = (path, method, body) => path.includes('cursor=older') ? page(0, null) : normal(path, method, body);
  await chat.loadOlder();
  const terminal = notices.filter(next => next.authority === 'successful-history' && !visible(next));
  expect(terminal).toHaveLength(1); expect(depths.every(depth => depth > 0)).toBe(true);
  expect(terminal[0]!.scope).toEqual({ hostID: 'fixture', generation: 1, owner: 1, historyGeneration: 0, targetKind: 'session', targetID: target.id, directory: '/fixture' });
  const changed = frames.slice(before).filter(frame => frame.next === terminal[0]);
  expect(changed).toHaveLength(1); expect(changed[0]!.footprint).toBe(53); expect(changed[0]!.ids).toHaveLength(40);
  const count = notices.length; for (let i = 0; i < 5; i++) await chat.load(false, ['messages']);
  expect(notices).toHaveLength(count);
});

it('keeps full predicates: more=false does not hide a missing revert boundary or a pending repair', async () => {
  const normal = read; read = (path, method, body) => path.includes('/message?') ? page(20, null, 1) : normal(path, method, body);
  const { chat, notices, footprint } = await open(); footprint.set(0);
  marker = { messageID: 'outside' }; chat.revert.set(marker);
  expect(notices.at(-1)).toMatchObject({ authority: 'reset', more: false, boundaryMissing: true, repairPending: false, resolved: false });
  marker = null; chat.revert.set(null);
  expect(notices.at(-1)).toMatchObject({ authority: 'reset', boundaryMissing: false, repairPending: true });
  read = (path, method, body) => { if (path.includes('/message?')) throw new Error('fixture rebuild offline'); return normal(path, method, body); };
  await chat.load(false, ['messages']); expect(visible(notices.at(-1)!)).toBe(true); expect(footprint()).toBe(0);
});

it('older failure preserves rows/cursor and publishes read/history errors together; retry clear is only presentation', async () => {
  const { chat, notices, footprint } = await open(), previous = chat.messages(), normal = read;
  read = (path, method, body) => { if (path.includes('cursor=older')) throw new Error('fixture older failure'); return normal(path, method, body); };
  const before = notices.length; await chat.loadOlder(true);
  expect(notices.slice(before)).toHaveLength(1);
  expect(notices.at(-1)).toMatchObject({ authority: 'failure', more: true, historyError: 'fixture older failure', readError: 'fixture older failure', resolved: true });
  expect(chat.messages()).toBe(previous); expect(footprint()).toBe(0);
  const gate = deferred<unknown>(); read = (path, method, body) => path.includes('cursor=older') ? gate.promise : normal(path, method, body);
  const retry = chat.loadOlder(); await ticks();
  expect(notices.at(-1)).toMatchObject({ authority: 'presentation', historyError: '', readError: 'fixture older failure', more: true });
  expect(footprint()).toBe(0); gate.resolve(page(0, null)); await retry;
  expect(notices.at(-1)).toMatchObject({ authority: 'successful-history', more: false, historyError: '', readError: '' }); expect(chat.messages()).toHaveLength(40);
});

it('never promotes a failed first read, malformed page or nonadvancing cursor to successful empty history', async () => {
  const normal = read; let mode = 'offline';
  read = (path, method, body) => {
    if (!path.includes('/message?')) return normal(path, method, body);
    if (mode === 'offline') throw new Error('fixture first offline');
    if (mode === 'malformed') return { invalid: true };
    if (mode === 'cycle') return page(0);
    return mode === 'initial' ? page() : page(0, null, 0);
  };
  const { chat, notices, footprint } = await open();
  expect(notices.at(-1)).toMatchObject({ authority: 'failure', resolved: false, more: false }); expect(footprint()).toBe(0);
  mode = 'malformed'; await chat.load(false, ['messages']); expect(notices.at(-1)?.authority).toBe('failure'); expect(chat.messagesResolved()).toBe(false);
  mode = 'initial'; await chat.load(false, ['messages']); mode = 'cycle'; await chat.loadOlder();
  expect(notices.at(-1)?.authority).toBe('failure'); expect(chat.more()).toBe(true); expect(chat.historyError()).toContain('cursor');
  mode = 'empty'; await chat.loadOlder(); expect(chat.more()).toBe(false); expect(notices.at(-1)?.authority).toBe('successful-history');
});

it('keeps unrelated partial status failure independent, but failed session boundary authority cannot admit a hold', async () => {
  const { chat, notices, footprint } = await open(), normal = read;
  read = (path, method, body) => {
    if (path === '/api/session/active') throw new Error('fixture status failure');
    if (path.includes('/message?')) return page(20, null, 1);
    return normal(path, method, body);
  };
  await chat.load(); expect(notices.at(-1)?.authority).toBe('successful-history'); expect(chat.error()).toContain('status');
  footprint.set(0);
  read = (path, method, body) => {
    if (path.startsWith(`/api/session/${target.id}?`)) throw new Error('fixture boundary failure');
    if (path.includes('/message?')) return page(20, null, 0);
    return normal(path, method, body);
  };
  await chat.load(false, ['messages']); expect(notices.at(-1)?.authority).toBe('failure'); expect(footprint()).toBe(0);
});

it('stages disjoint sliding tails without adopting their rows and clears gap only with the final successful batch', async () => {
  const { chat, notices } = await open(), previous = chat.messages(), normal = read;
  read = (path, method, body) => {
    if (!path.includes('/message?')) return normal(path, method, body);
    const cursor = new URL(path, 'https://fixture.example').searchParams.get('cursor');
    const start = cursor ? Number(cursor.slice(5)) : 200; return page(start, start ? `from-${start - 20}` : null);
  };
  await chat.load(false, ['messages']); expect(chat.messages()).toBe(previous);
  expect(notices.at(-1)).toMatchObject({ authority: 'presentation', hasGap: true });
  const before = notices.length; await chat.load(false, ['messages']);
  expect(notices.slice(before)).toHaveLength(1); expect(notices.at(-1)).toMatchObject({ authority: 'successful-history', hasGap: false, more: true });
  expect(chat.messages()).toHaveLength(200);
});

it('publishes anonymous committed reset once, stays pending on failure and succeeds only after authority rebuild', async () => {
  const { chat, notices, footprint } = await open(), before = chat.historyGeneration(), normal = read;
  emit('session.revert.committed'); emit('session.revert.committed');
  expect(notices.at(-1)).toMatchObject({ authority: 'reset', resolved: false, repairPending: true, scope: { historyGeneration: before + 1 } });
  expect(notices.filter(next => next.authority === 'reset')).toHaveLength(1);
  read = (path, method, body) => { if (path.includes('/message?')) throw new Error('fixture repair unavailable'); return normal(path, method, body); };
  await chat.load(false, ['messages']); expect(chat.historyRepairPending()).toBe(true); expect(footprint()).toBe(0);
  read = (path, method, body) => path.includes('/message?') ? page(0, null, 0) : normal(path, method, body);
  await chat.load(false, ['messages']); expect(notices.at(-1)).toMatchObject({ authority: 'successful-history', repairPending: false, resolved: true }); expect(chat.messages()).toEqual([]);
});

it('trims a known committed boundary in the same reset batch and rejects its later stale stream rows', async () => {
  const { chat, notices } = await open(); marker = { messageID: 'm-25' }; chat.revert.set(marker);
  const generation = chat.historyGeneration(); marker = null; emit('session.revert.committed', { to: 'm-25' });
  expect(notices.at(-1)).toMatchObject({ authority: 'reset', boundaryMissing: false, hasGap: false, resolved: false, scope: { historyGeneration: generation + 1 } });
  expect(chat.messages()).toHaveLength(5); const count = notices.length;
  emit('session.revert.committed', { to: 'm-25' }); emit('session.text.delta', { assistantMessageID: 'm-26', ordinal: 0, delta: 'retired' });
  await vi.advanceTimersByTimeAsync(32); expect(notices).toHaveLength(count); expect(chat.messages()).toHaveLength(5);
});

it('updates a missing boundary on structural stream insertion, not on same-ID tokens, input or exact-fill', async () => {
  const { chat, notices } = await open(); marker = { messageID: 'new-boundary' }; chat.revert.set(marker);
  emit('session.text.delta', { assistantMessageID: marker.messageID, ordinal: 0, delta: 'first' }); await vi.advanceTimersByTimeAsync(32);
  expect(notices.at(-1)).toMatchObject({ authority: 'presentation', boundaryMissing: false });
  const before = notices.length, some = vi.spyOn(chat.messages(), 'some'); h.call.mockClear();
  for (let i = 0; i < 100; i++) { chat.setDraftText(`draft-${i}`); emit('session.text.delta', { assistantMessageID: marker.messageID, ordinal: 0, delta: 'a' }); }
  await vi.advanceTimersByTimeAsync(32);
  expect(notices).toHaveLength(before); expect(some).not.toHaveBeenCalled();
  expect(h.call.mock.calls.filter(([name]) => name === 'runtime.request')).toHaveLength(0);
});

it('fences page/background/owner/Host completions and never calls a retired or disposed presentation owner', async () => {
  const { state, chat, notices } = await open(), normal = read, gate = deferred<unknown>();
  read = (path, method, body) => path.includes('/message?') ? gate.promise : normal(path, method, body);
  const loading = chat.load(false, ['messages']); await ticks(); const before = notices.length;
  chat.active.set(false); gate.resolve(page(0, null)); await loading; expect(notices).toHaveLength(before);
  chat.revert.set({ messageID: 'hidden' }); expect(notices).toHaveLength(before);
  // Hidden pages are not UI flush consumers; stop their test UI observer too.
  h.stops.at(-1)!();
  await state.loadConnections({ forceReconnect: true }); chat.revert.set(null); expect(notices).toHaveLength(before);
  h.cleanups.forEach(stop => stop()); chat.revert.set({ messageID: 'disposed' }); expect(notices).toHaveLength(before);
});

it('contact generation reset reports only the new rows and generation in the successful adoption flush', async () => {
  const normal = read; let generation = 1;
  read = (path, method, body) => path.includes('/contact/messages') ? { messages: [{ id: `contact-${generation}`, role: 'assistant', text: 'Body', ordinal: 1 }], complete: true, generation, revision: 1 }
    : path.endsWith('/assistants/snapshot') ? { assistants: [{ id: 'bot', working: false }] } : normal(path, method, body);
  const { chat, notices, frames } = await open({ assistant: true }), before = chat.historyGeneration(); generation = 2;
  await chat.load(false, ['messages']); expect(notices.at(-1)).toMatchObject({ authority: 'successful-history', scope: { targetKind: 'assistant', targetID: 'bot', historyGeneration: before + 1 } });
  expect(frames.at(-1)?.ids).toEqual(['contact-2']);
});

it('repairCommittedHistory emits success for an ambiguously committed write without changing message snapshot semantics', async () => {
  marker = { messageID: 'outside' };
  const { chat, notices } = await open(), normal = read;
  const snapshots: number[] = []; chat.observeMessageCommits(() => snapshots.push(chat.messages().length));
  read = (path, method, body) => {
    if (path.includes('/revert/commit?')) { marker = null; throw new Error('fixture lost commit acknowledgement'); }
    if (path.includes('/message?') && marker === null) return page(0, null, 1);
    return normal(path, method, body);
  };
  chat.setDraftText('replacement'); expect(await chat.send()).toBe(false);
  expect(notices.at(-1)).toMatchObject({ authority: 'successful-history', more: false, repairPending: false, readError: '', resolved: true });
  expect(chat.messages().map(row => row.id)).toEqual(['m-0']); expect(snapshots.at(-1)).toBe(1);
  expect(h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.path.includes('/prompt?'))).toHaveLength(0);
});

it('a background or newer mounted owner cannot receive a pending old page presentation', async () => {
  const { state, chat, notices } = await open(), normal = read, gate = deferred<unknown>();
  read = (path, method, body) => path.includes('/message?') ? gate.promise : normal(path, method, body);
  const loading = chat.load(false, ['messages']); await ticks(); const before = notices.length;
  h.setLifecycle('background'); gate.resolve(page(0, null)); await loading; expect(notices).toHaveLength(before);
  read = normal; h.setLifecycle('active'); await ticks();
  // The old presentation observer is no longer the mounted UI owner.
  h.stops.at(-1)!();
  const nextGate = deferred<unknown>(); read = (path, method, body) => path.includes('/message?') ? nextGate.promise : normal(path, method, body);
  const old = chat.load(false, ['messages']); await ticks(); const count = notices.length;
  state.createChat({ ...target, id: 'new-owner' }); nextGate.resolve(page(0, null)); await old; await ticks(); expect(notices).toHaveLength(count);
});

it('isolates a throwing presentation callback and preserves the existing post-resolved message observer contract', async () => {
  const { chat, notices } = await open({ throws: true }); const snapshots: Array<{ resolved: boolean; count: number }> = [];
  chat.observeMessageCommits(() => snapshots.push({ resolved: chat.messagesResolved(), count: chat.messages().length }));
  const normal = read; read = (path, method, body) => path.includes('cursor=older') ? page(0, null) : normal(path, method, body);
  await chat.loadOlder(); expect(chat.messages()).toHaveLength(40); expect(chat.more()).toBe(false);
  expect(notices.at(-1)?.authority).toBe('successful-history'); expect(snapshots).toEqual([{ resolved: true, count: 40 }]);
});

it('constructs no presentation facts or scope without the optional listener', async () => {
  const freeze = vi.spyOn(Object, 'freeze'); const { chat } = await open({ listener: false });
  marker = { messageID: 'missing' }; chat.revert.set(marker);
  await chat.load(false, ['messages']); await chat.loadOlder();
  expect(freeze.mock.calls.filter(([value]) => value && typeof value === 'object' && ('targetKind' in value || 'authority' in value && 'scope' in value))).toEqual([]);
  freeze.mockRestore();
});
