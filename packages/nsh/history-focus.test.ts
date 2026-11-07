import { expect, it, vi } from 'vitest';
import { createNativeHistoryFocus } from './history-focus';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  let active = true, scope = 'host:1/session:one/reset:0', more = true, loading = false, error = '';
  const visible = new Set<string>(['tail']), hidden = new Set<string>();
  const reveal = vi.fn<(messageID: string) => boolean>(() => true), load = vi.fn<() => Promise<void>>(async () => { more = false; });
  const changed = vi.fn();
  const focus = createNativeHistoryFocus({
    current: () => active, scope: () => scope, hasMessage: id => visible.has(id), isHidden: id => hidden.has(id),
    more: () => more, olderLoading: () => loading, historyError: () => error,
    loadOlder: load, reveal, changed,
  });
  return { focus, load, reveal, visible, hidden, changed, active: (next: boolean) => { active = next; }, scope: (next: string) => { scope = next; }, more: (next: boolean) => { more = next; }, loading: (next: boolean) => { loading = next; }, error: (next: string) => { error = next; } };
}

it('reveals a first-page target once without loading older or jumping to tail; same focus is idempotent', async () => {
  const f = fixture(); f.visible.add('target');
  expect((await f.focus.focus('target')).status).toBe('revealed');
  await f.focus.focus('target');
  expect(f.load).not.toHaveBeenCalled(); expect(f.reveal.mock.calls).toEqual([['target']]);
});

it('finds a middle-of-history target beyond 100 opaque pages with serial loads and no ID ranking', async () => {
  const f = fixture(); let cursor = 'opaque:/+?=start', inFlight = 0, maximum = 0;
  const seen: string[] = [];
  f.load.mockImplementation(async () => {
    inFlight++; maximum = Math.max(maximum, inFlight); seen.push(cursor);
    await Promise.resolve();
    f.visible.add(`nonchronological-${130 - seen.length}`);
    cursor = `opaque:/+?=${seen.length}`;
    if (seen.length === 125) f.visible.add('a-target-before-z');
    inFlight--;
  });
  const result = await f.focus.focus('a-target-before-z');
  expect(result.status).toBe('revealed'); expect(result.loads).toBe(125);
  expect(seen).toHaveLength(125); expect(seen[0]).toBe('opaque:/+?=start'); expect(seen.at(-1)).toBe('opaque:/+?=124');
  expect(maximum).toBe(1); expect(f.reveal.mock.calls).toEqual([['a-target-before-z']]);
});

it('keeps advancing cursor-only pages even when no visible message or array changes', async () => {
  const f = fixture(); let pages = 0;
  f.load.mockImplementation(async () => { pages++; if (pages === 8) f.visible.add('target'); });
  expect((await f.focus.focus('target')).status).toBe('revealed'); expect(pages).toBe(8);
});

it('keeps the target and loaded content on swallowed history errors, does not auto-retry, and retries explicitly', async () => {
  const f = fixture(); let attempts = 0;
  f.load.mockImplementation(async () => {
    attempts++;
    if (attempts === 1) { f.visible.add('loaded-earlier'); return; }
    if (attempts === 2) { f.error('fixture page offline'); return; }
    f.error(''); f.visible.add('target');
  });
  const failed = await f.focus.focus('target');
  expect(failed).toMatchObject({ status: 'error', messageID: 'target', error: 'history' });
  expect(f.visible.has('loaded-earlier')).toBe(true); expect(attempts).toBe(2); expect(f.reveal).not.toHaveBeenCalled();
  for (let i = 0; i < 100; i++) await f.focus.focus('target');
  expect(attempts).toBe(2);
  expect((await f.focus.retry()).status).toBe('revealed'); expect(attempts).toBe(3);
  expect(f.reveal.mock.calls).toEqual([['target']]);
});

it('stops after a thrown page failure and permits one later explicit attempt', async () => {
  const f = fixture(); f.load.mockRejectedValueOnce(new Error('fixture transport failed'));
  expect((await f.focus.focus('target'))).toMatchObject({ status: 'error', error: 'load', messageID: 'target' });
  expect(f.load).toHaveBeenCalledTimes(1); f.load.mockImplementation(async () => { f.visible.add('target'); });
  expect((await f.focus.retry()).status).toBe('revealed');
});

it('preserves a pre-existing pagination error until explicit retry instead of silently retrying it on focus', async () => {
  const f = fixture(); f.error('prior failure');
  expect((await f.focus.focus('target')).error).toBe('history'); expect(f.load).not.toHaveBeenCalled();
  f.load.mockImplementation(async () => { f.error(''); f.visible.add('target'); });
  await f.focus.retry(); expect(f.load).toHaveBeenCalledTimes(1); expect(f.reveal).toHaveBeenCalledTimes(1);
});

it('returns not-found for authoritative exhausted empty history and after searching to exhaustion', async () => {
  const empty = fixture(); empty.visible.clear(); empty.more(false);
  expect((await empty.focus.focus('missing')).status).toBe('not-found'); expect(empty.load).not.toHaveBeenCalled(); expect(empty.reveal).not.toHaveBeenCalled();
  const f = fixture(); let pages = 0;
  f.load.mockImplementation(async () => { if (++pages === 3) f.more(false); });
  expect((await f.focus.focus('missing')).status).toBe('not-found'); expect(pages).toBe(3); expect(f.reveal).not.toHaveBeenCalled();
});

it('does not treat revert-hidden messages as found even if a broad hasMessage callback says present', async () => {
  const f = fixture(); f.visible.add('hidden'); f.hidden.add('hidden');
  expect((await f.focus.focus('hidden')).status).toBe('hidden'); expect(f.load).not.toHaveBeenCalled(); expect(f.reveal).not.toHaveBeenCalled();
});

it('stops at a newly loaded hidden target without revealing or discarding the successful page', async () => {
  const f = fixture(); f.load.mockImplementation(async () => { f.visible.add('preserved'); f.hidden.add('hidden'); });
  expect((await f.focus.focus('hidden')).status).toBe('hidden'); expect(f.load).toHaveBeenCalledTimes(1);
  expect(f.visible.has('preserved')).toBe(true); expect(f.reveal).not.toHaveBeenCalled();
});

it('cancel fences an in-flight completion without aborting or rolling back its page', async () => {
  const f = fixture(), gate = deferred<void>();
  f.load.mockImplementation(async () => { await gate.promise; f.visible.add('target'); });
  const pending = f.focus.focus('target'); await flush(); f.focus.cancel();
  gate.resolve(); expect((await pending).status).toBe('cancelled');
  expect(f.focus.state().status).toBe('cancelled'); expect(f.visible.has('target')).toBe(true); expect(f.reveal).not.toHaveBeenCalled();
  await f.focus.retry(); expect(f.reveal).not.toHaveBeenCalled();
});

it('does not issue a page if cancelled before the first scheduled load', async () => {
  const f = fixture(); const pending = f.focus.focus('target'); f.focus.cancel();
  expect((await pending).status).toBe('cancelled'); expect(f.load).not.toHaveBeenCalled();
});

it('scope changes and page exit independently fence old asynchronous reveals', async () => {
  for (const invalidate of [(f: ReturnType<typeof fixture>) => f.scope('host:2/session:one/reset:0'), (f: ReturnType<typeof fixture>) => f.active(false)]) {
    const f = fixture(), gate = deferred<void>();
    f.load.mockImplementation(async () => { await gate.promise; f.visible.add('target'); });
    const pending = f.focus.focus('target'); await flush(); invalidate(f); gate.resolve();
    expect((await pending).status).toBe('cancelled'); expect(f.reveal).not.toHaveBeenCalled(); expect(f.load).toHaveBeenCalledTimes(1);
  }
});

it('switching targets shares the old page barrier, never overlaps requests or reveals the old target', async () => {
  const f = fixture(), gate = deferred<void>(); let firstPage = true;
  f.load.mockImplementation(async () => {
    if (firstPage) { firstPage = false; await gate.promise; f.visible.add('old'); }
    else f.visible.add('new');
  });
  const old = f.focus.focus('old'); await flush(); const next = f.focus.focus('new'); await flush();
  expect(f.load).toHaveBeenCalledTimes(1); gate.resolve();
  expect((await old)).toMatchObject({ status: 'cancelled', messageID: 'old' });
  expect((await next)).toMatchObject({ status: 'revealed', messageID: 'new' });
  expect(f.load).toHaveBeenCalledTimes(2); expect(f.reveal.mock.calls).toEqual([['new']]);
});

it('joins an existing external older flight before revealing, without requesting a second page', async () => {
  const f = fixture(), gate = deferred<void>(); f.loading(true);
  let wireRequests = 1;
  const externalFlight = gate.promise.then(() => { f.loading(false); f.visible.add('target'); });
  let loading = true; externalFlight.then(() => { loading = false; });
  f.load.mockImplementation(async () => { if (!loading) wireRequests++; await externalFlight; });
  const pending = f.focus.focus('target'); await flush();
  expect(f.reveal).not.toHaveBeenCalled(); expect(f.load).toHaveBeenCalledTimes(1);
  gate.resolve(); expect((await pending).status).toBe('revealed'); expect(wireRequests).toBe(1); expect(f.load).toHaveBeenCalledTimes(1);
});

it('reveals the row containing a grouped inner message using the current display index, not a stale key or tail', async () => {
  const f = fixture(); let rows = [{ key: 'tail-key', ids: ['tail'] }]; const command = vi.fn();
  f.load.mockImplementation(async () => { rows = [...rows, { key: 'stable-mounted-key', ids: ['older-head', 'inner-target', 'real-tail'] }]; f.visible.add('inner-target'); });
  f.reveal.mockImplementation((id: string) => { const index = rows.findIndex(row => row.ids.includes(id)); if (index < 0) return false; command({ index, animated: false, viewPosition: 0.5 }); return true; });
  await f.focus.focus('inner-target'); expect(command.mock.calls).toEqual([[{ index: 1, animated: false, viewPosition: 0.5 }]]);
});

it('keeps reveal failures retryable and never silently marks a missing ListRef as success', async () => {
  const f = fixture(); f.visible.add('target'); f.reveal.mockReturnValueOnce(false);
  expect((await f.focus.focus('target'))).toMatchObject({ status: 'error', error: 'reveal', messageID: 'target' });
  expect(f.load).not.toHaveBeenCalled(); expect((await f.focus.retry()).status).toBe('revealed'); expect(f.reveal).toHaveBeenCalledTimes(2);
});

it('a repeated focus while loading shares its result rather than queueing another navigation', async () => {
  const f = fixture(), gate = deferred<void>(); f.load.mockImplementation(async () => { await gate.promise; f.visible.add('target'); });
  const first = f.focus.focus('target'); await flush(); const second = f.focus.focus('target');
  expect(second).toBe(first); gate.resolve(); await Promise.all([first, second]); expect(f.load).toHaveBeenCalledTimes(1); expect(f.reveal).toHaveBeenCalledTimes(1);
});

it('cancel settles navigation immediately but retains the wire-flight barrier for later targets', async () => {
  const f = fixture(), gate = deferred<void>();
  f.load.mockImplementation(async () => { await gate.promise; f.visible.add('old'); f.visible.add('new'); });
  const old = f.focus.focus('old'); await flush(); f.focus.cancel();
  expect((await old).status).toBe('cancelled');
  const next = f.focus.focus('new'); await flush(); expect(f.load).toHaveBeenCalledTimes(1); expect(f.reveal).not.toHaveBeenCalled();
  gate.resolve(); expect((await next).status).toBe('revealed'); expect(f.load).toHaveBeenCalledTimes(1); expect(f.reveal.mock.calls).toEqual([['new']]);
});

it('an unrelated older-page error does not hide an already visible target', async () => {
  const f = fixture(); f.error('prior older error'); f.visible.add('target');
  expect((await f.focus.focus('target')).status).toBe('revealed'); expect(f.load).not.toHaveBeenCalled();
});

it('a reveal command throwing is an explicit retryable failure and an empty id never falls back to tail', async () => {
  const f = fixture(); f.visible.add('target'); f.reveal.mockImplementationOnce(() => { throw new Error('fixture List detached'); });
  expect((await f.focus.focus('target'))).toMatchObject({ status: 'error', error: 'reveal' });
  expect((await f.focus.retry()).status).toBe('revealed');
  const empty = fixture(); expect((await empty.focus.focus(''))).toMatchObject({ status: 'error', error: 'invalid-target' });
  expect(empty.load).not.toHaveBeenCalled(); expect(empty.reveal).not.toHaveBeenCalled();
});
