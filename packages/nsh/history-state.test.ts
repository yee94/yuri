import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ call: vi.fn(), cleanups: [] as Array<() => void>, disposers: [] as Array<() => void>, listeners: new Map<string, Set<(value: unknown) => void>>() }));
vi.mock('nsh', () => ({
  signal: <T>(value: T) => Object.assign(() => value, { set: (next: T) => { value = next; } }),
  batch: (work: () => void) => work(), untracked: <T>(work: () => T) => work(), lifecycle: () => 'active',
  cleanup: (work: () => void) => h.cleanups.push(work), effect: (work: () => unknown) => { const stop = work(); if (typeof stop === 'function') h.disposers.push(stop as () => void); },
  Storage: { getItem: async () => null, setItem: async () => {} },
  host: { available: () => true, call: h.call, on: (name: string, listener: (value: unknown) => void) => { const entries = h.listeners.get(name) ?? new Set(); entries.add(listener); h.listeners.set(name, entries); return () => { entries.delete(listener); }; } },
}));
const target = { kind: 'session' as const, id: 'history-scope', title: 'History fixture', directory: '/fixture' };
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const token = 'opaque:/+?=& next';
const rows = (start: number, count = 20) => Array.from({ length: count }, (_, i) => ({ id: `row-${start + i}`, type: 'user', text: `Body ${start + i}` }));
const page = (start: number, next: string | null = token, count = 20) => ({ data: rows(start, count).reverse(), cursor: { next } });
let read: (url: URL) => unknown;
const requests = () => h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.path.includes('/message?')).map(([, input]) => new URL(input.path, 'https://fixture.example'));
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); h.cleanups = []; h.disposers = []; h.listeners.clear();
  read = url => url.searchParams.has('cursor') ? page(0, null) : page(20);
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected: 'fixture', runtimeScope: { hostID: 'fixture', lease: 'fixture-lease' }, connections: [{ id: 'fixture', label: 'Fixture', url: 'https://fixture.example' }] };
    if (name !== 'runtime.request') return true;
    const path = input.path as string;
    const body = path.includes('/message?') ? await read(new URL(path, 'https://fixture.example'))
      : path.startsWith('/api/session/history-scope?') ? { id: target.id }
      : path === '/api/session/active' ? {} : [];
    return { status: 200, body };
  });
});
afterEach(() => { h.disposers.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); vi.useRealTimers(); });
async function open() { const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush(); return { state, chat }; }

it('does not swallow an older request made during the tail flight; deduplicates the waiting older callers', async () => {
  const { chat } = await open(); const gate = deferred<unknown>();
  read = url => url.searchParams.has('cursor') ? page(0, null) : gate.promise;
  const tail = chat.load(false, ['messages']); await flush();
  const older = chat.load(true), duplicate = chat.load(true);
  gate.resolve(page(20)); await Promise.all([tail, older, duplicate]); await flush();
  expect(requests().filter(url => url.searchParams.has('cursor'))).toHaveLength(1);
  expect(chat.messages().map(row => row.id)).toEqual(rows(0, 40).map(row => row.id));
  expect(chat.more()).toBe(false);
});

it('keeps untouched message and array references through identical tail polls and retains the oldest cursor', async () => {
  const { chat } = await open(); await chat.load(true);
  const previous = chat.messages();
  read = () => page(20);
  for (let i = 0; i < 10; i++) await chat.load(false, ['messages']);
  expect(chat.messages()).toBe(previous);
  for (let i = 0; i < previous.length; i++) expect(chat.messages()[i]).toBe(previous[i]);
  expect(chat.more()).toBe(false);
});

it('uses the opaque cursor unchanged and never adds order to cursor reads', async () => {
  const { chat } = await open(); await chat.load(true);
  const older = requests().find(url => url.searchParams.has('cursor'))!;
  expect(older.searchParams.get('cursor')).toBe(token);
  expect(older.searchParams.has('order')).toBe(false);
  expect(older.searchParams.get('limit')).toBe('20');
});

it('preserves valid history on failure, blocks repeated automatic attempts, and manually retries the same cursor', async () => {
  const { chat } = await open(); const previous = chat.messages();
  read = url => { if (url.searchParams.has('cursor')) throw new Error('fixture older unavailable'); return page(20); };
  await chat.loadOlder(true);
  expect(chat.messages()).toBe(previous); expect(chat.historyError()).toContain('fixture older unavailable');
  await chat.load(false, ['status']);
  expect(chat.historyError()).toContain('fixture older unavailable');
  for (let i = 0; i < 100; i++) await chat.loadOlder(true);
  expect(requests().filter(url => url.searchParams.has('cursor'))).toHaveLength(1);
  read = url => url.searchParams.has('cursor') ? page(0, null) : page(20);
  await chat.loadOlder();
  expect(requests().filter(url => url.searchParams.has('cursor')).map(url => url.searchParams.get('cursor'))).toEqual([token, token]);
  expect(chat.historyError()).toBe(''); expect(chat.messages()).toHaveLength(40);
});

it('rejects a stationary cursor without changing the readable window or allowing an auto-load loop', async () => {
  const { chat } = await open(); const previous = chat.messages();
  read = () => page(0, token);
  await chat.loadOlder(true);
  expect(chat.historyError()).not.toBe(''); expect(chat.messages()).toBe(previous); expect(chat.more()).toBe(true);
  for (let i = 0; i < 20; i++) await chat.loadOlder(true);
  expect(requests().filter(url => url.searchParams.has('cursor'))).toHaveLength(1);
});

it('adopts exactly one cursor-only system page, leaving the existing window intact', async () => {
  const { chat } = await open(); const previous = chat.messages();
  read = () => ({ data: Array.from({ length: 20 }, (_, i) => ({ id: `hidden-${i}`, type: 'system' })), cursor: { next: 'next-system-boundary' } });
  await chat.loadOlder(true);
  expect(requests().filter(url => url.searchParams.has('cursor'))).toHaveLength(1);
  expect(chat.messages()).toBe(previous); expect(chat.more()).toBe(true);
  read = () => page(0, null); await chat.loadOlder();
  expect(requests().at(-1)?.searchParams.get('cursor')).toBe('next-system-boundary');
  expect(chat.messages()).toHaveLength(40);
});

it('stages a disjoint tail after the bounded catchup and resumes without presenting a false contiguous window', async () => {
  const { chat } = await open(); const previous = chat.messages();
  read = url => { const cursor = url.searchParams.get('cursor'); const start = cursor ? Number(cursor.slice(5)) : 200; return page(start, start > 0 ? `from-${start - 20}` : null); };
  await chat.load(false, ['messages']);
  expect(chat.hasGap()).toBe(true); expect(chat.messages()).toBe(previous);
  expect(requests().length).toBe(7); // Initial + fresh tail + five bridge pages.
  await chat.load(false, ['messages']);
  expect(chat.hasGap()).toBe(false);
  expect(chat.messages().map(row => row.id)).toEqual(rows(20, 200).map(row => row.id));
  expect(new Set(chat.messages().map(row => row.id)).size).toBe(200);
  // Catchup does not replace the separately owned oldest-history cursor.
  expect(chat.more()).toBe(true);
});

it('fences an older request waiting behind a tail when the Host changes', async () => {
  const { state, chat } = await open(); const gate = deferred<unknown>(); const previous = chat.messages();
  read = () => gate.promise;
  const tail = chat.load(false, ['messages']); await flush(); const older = chat.load(true);
  await state.loadConnections({ forceReconnect: true }); gate.resolve(page(20));
  await Promise.all([tail, older]);
  expect(chat.messages()).toBe(previous); expect(requests().filter(url => url.searchParams.has('cursor'))).toHaveLength(0);
});

it('does not let an older overlap overwrite newly streamed text', async () => {
  const { chat } = await open(); const gate = deferred<unknown>();
  read = () => gate.promise; const older = chat.load(true); await flush();
  for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key: 'chat', data: JSON.stringify({ type: 'session.text.delta', data: { sessionID: target.id, assistantMessageID: 'row-20', ordinal: 0, delta: ' live' } }) });
  await vi.advanceTimersByTimeAsync(32);
  gate.resolve(page(1, null)); await older;
  expect(chat.messages().find(row => row.id === 'row-20')?.text).toContain('live');
});

it('does not use a newly streamed latest row as proof that a staged gap has been bridged', async () => {
  const { chat } = await open();
  read = url => { const cursor = url.searchParams.get('cursor'); const start = cursor ? Number(cursor.slice(5)) : 200; return page(start, start > 0 ? `from-${start - 20}` : null); };
  await chat.load(false, ['messages']);
  for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key: 'chat', data: JSON.stringify({ type: 'session.text.delta', data: { sessionID: target.id, assistantMessageID: 'row-219', ordinal: 0, delta: ' live' } }) });
  await vi.advanceTimersByTimeAsync(32);
  expect(chat.messages().map(row => row.id)).toEqual(rows(20).map(row => row.id));
  await chat.load(false, ['messages']);
  expect(chat.hasGap()).toBe(false);
  expect(chat.messages().map(row => row.id)).toEqual(rows(20, 200).map(row => row.id));
});

it('restarts catchup if the fresh newest page no longer overlaps the staged tail', async () => {
  const { chat } = await open(); let newest = 200;
  read = url => { const cursor = url.searchParams.get('cursor'); const start = cursor ? Number(cursor.slice(5)) : newest; return page(start, start > 0 ? `from-${start - 20}` : null); };
  await chat.load(false, ['messages']); newest = 260;
  await chat.load(false, ['messages']);
  expect(chat.hasGap()).toBe(true);
  await chat.load(false, ['messages']); await chat.load(false, ['messages']);
  expect(chat.hasGap()).toBe(false);
  expect(chat.messages().map(row => row.id)).toEqual(rows(20, 260).map(row => row.id));
});

it('initializes the older boundary even if a live row arrived before the first GET completed', async () => {
  const gate = deferred<unknown>(); read = () => gate.promise;
  const state = await import('./state'); await state.loadConnections(); const chat = state.createChat(target); await flush();
  for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key: 'chat', data: JSON.stringify({ type: 'session.text.delta', data: { sessionID: target.id, assistantMessageID: 'live-newest', ordinal: 0, delta: 'live' } }) });
  await vi.advanceTimersByTimeAsync(32); gate.resolve(page(20)); await flush();
  expect(chat.hasGap()).toBe(false); expect(chat.more()).toBe(true);
  expect(chat.messages().map(row => row.id)).toEqual([...rows(20).map(row => row.id), 'live-newest']);
  read = () => page(0, null); await chat.load(true);
  expect(requests().at(-1)?.searchParams.get('cursor')).toBe(token);
  expect(chat.messages()).toHaveLength(41);
});

it('older overlap never settles already-published live text even when the delta preceded the request', async () => {
  const { chat } = await open();
  for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key: 'chat', data: JSON.stringify({ type: 'session.text.delta', data: { sessionID: target.id, assistantMessageID: 'row-20', ordinal: 0, delta: ' live' } }) });
  await vi.advanceTimersByTimeAsync(32);
  read = () => page(1, null); await chat.load(true);
  expect(chat.messages().find(row => row.id === 'row-20')?.text).toContain('live');
});

it('rejects a cursor cycle across separate older page requests', async () => {
  const { chat } = await open();
  read = () => page(0, 'second-boundary'); await chat.loadOlder();
  const previous = chat.messages(); read = () => page(0, token); await chat.loadOlder();
  expect(chat.historyError()).toContain('cursor'); expect(chat.messages()).toBe(previous);
});

it('initializes pagination when an exhausted empty session later gets a full tail', async () => {
  read = () => page(0, null, 0); const { chat } = await open();
  read = () => page(20); await chat.load(false, ['messages']);
  expect(chat.more()).toBe(true); read = () => page(0, null); await chat.loadOlder();
  expect(chat.messages()).toHaveLength(40);
});

it('does not use live rows published during the newest GET as authoritative bridge anchors', async () => {
  const { chat } = await open(); const gate = deferred<unknown>();
  read = url => { const cursor = url.searchParams.get('cursor'); if (!cursor) return gate.promise; const start = Number(cursor.slice(5)); return page(start, start > 0 ? `from-${start - 20}` : null); };
  const tail = chat.load(false, ['messages']); await flush();
  for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key: 'chat', data: JSON.stringify({ type: 'session.text.delta', data: { sessionID: target.id, assistantMessageID: 'row-219', ordinal: 0, delta: ' live' } }) });
  await vi.advanceTimersByTimeAsync(32); gate.resolve(page(200, 'from-180')); await tail;
  expect(chat.hasGap()).toBe(true);
  expect(requests()).toHaveLength(7);
});
