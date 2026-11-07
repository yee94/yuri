import { describe, expect, it, vi } from 'vitest';
import { messageFrom, type Message, type Row } from './model';
import { createActivityMaterializer, hasSlimActivity, materializedActivityMessage } from './transcript-materialization';

const part = (slim = true): Row => ({ id: 'call', type: 'tool', name: 'bash', ...(slim ? { slim } : {}), state: { status: 'completed', input: { command: 'fixture' }, ...(slim ? {} : { output: 'OUTPUT' }) } });
const msg = (id: string, content: Row[] = [part()]): Message => messageFrom({ id, type: 'assistant', sessionID: 's', content, finish: 'stop' })!;
const full = (id: string) => msg(id, [part(false)]);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(ids = ['a', 'b', 'c', 'd', 'e']) {
  const messages = new Map(ids.map(id => [id, msg(id)]));
  const reads = new Map<string, ReturnType<typeof deferred<Message>>>();
  let current = true;
  const read = vi.fn((id: string) => { const gate = deferred<Message>(); reads.set(id, gate); return gate.promise; });
  const apply = vi.fn((next: Message, source: Message) => { if (messages.get(source.id) !== source) return false; messages.set(next.id, next); return true; });
  const controller = createActivityMaterializer({ current: () => current, message: id => messages.get(id), read, apply, changed: vi.fn() });
  return { ...controller, messages, reads, read, apply, hide: () => { current = false; controller.cancel(); } };
}

describe('exact Activity response boundary', () => {
  it.each(['native', 'legacy', 'wrapped'])('accepts %s bodies while retaining ordered metadata and turn identity', shape => {
    const expected = { ...msg('a'), ordinal: 9, agent: 'original', time: { created: 1, completed: 5 } };
    const info = { id: 'a', sessionID: 's', role: 'assistant', type: 'assistant', agent: 'different' };
    const payload = shape === 'native' ? { ...info, content: [part(false)] } : { info, parts: [part(false)] };
    const result = materializedActivityMessage(shape === 'wrapped' ? { data: payload } : payload, expected, 's');
    expect(result).toMatchObject({ id: 'a', ordinal: 9, agent: 'original', time: expected.time });
    expect(result.tools[0]).toMatchObject({ state: { output: 'OUTPUT' } }); expect(hasSlimActivity(result)).toBe(false);
    expect(expected.content?.[0]?.slim).toBe(true);
  });
  it.each([
    {}, { id: 'other', content: [] }, { id: 'a', sessionID: 'other', content: [] },
    { info: { id: 'a' }, parts: [part()] }, { id: 'a', content: [{ type: 'reasoning', slim: true }] },
    { id: 'a', content: [{ type: 'file', slim: true }] }, { id: 'a' },
  ])('rejects missing, mismatched and still-slim records instead of empty success: %j', payload => {
    expect(() => materializedActivityMessage(payload, msg('a'), 's')).toThrow();
  });
  it('accepts an authoritative successful empty response', () => {
    const result = materializedActivityMessage({ id: 'a', content: [] }, msg('a'), 's');
    expect(result.content).toEqual([]); expect(hasSlimActivity(result)).toBe(false);
  });
});

describe('Chat-owned Activity exact-fill queue', () => {
  it('a user expansion promotes an already queued automatic read without duplicating it', async () => {
    const f = fixture(); const automatic = f.request(['a', 'b', 'c', 'd'], { automatic: true }); await flush();
    const user = f.request(['d']); f.reads.get('a')!.resolve(full('a')); await flush();
    expect(f.read.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'd']);
    f.reads.get('d')!.resolve(full('d')); await user; await flush();
    for (const id of ['b', 'c']) f.reads.get(id)!.resolve(full(id)); await automatic;
    expect(f.read).toHaveBeenCalledTimes(4);
  });
  it('deduplicates calls, caps physical concurrency at two and keeps FIFO within priority groups', async () => {
    const f = fixture();
    const automatic = f.request(['a', 'a', 'b', 'c', 'd'], { automatic: true });
    const duplicate = f.request(['a'], { automatic: true }); await flush();
    expect(f.read.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    const user = f.request(['e']); await flush(); expect(f.read).toHaveBeenCalledTimes(2);
    f.reads.get('b')!.resolve(full('b')); await flush();
    expect(f.read.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'e']);
    f.reads.get('a')!.resolve(full('a')); await duplicate; await flush();
    expect(f.read.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'e', 'c']);
    f.reads.get('e')!.resolve(full('e')); await user; await flush();
    expect(f.read.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'e', 'c', 'd']);
    for (const id of ['c', 'd']) f.reads.get(id)!.resolve(full(id));
    await automatic;
    await f.request(['a', 'b', 'c', 'd', 'e'], { automatic: true }); expect(f.read).toHaveBeenCalledTimes(5);
  });
  it('isolates one failure, survives row remount requests, and retries only failed IDs explicitly', async () => {
    const f = fixture(); const work = f.request(['a', 'b']); await flush();
    f.reads.get('a')!.reject(new Error('offline')); f.reads.get('b')!.resolve(full('b')); await work;
    expect(f.state(['a', 'b'])).toEqual({ loading: false, failed: true, empty: false });
    for (let i = 0; i < 50; i++) await f.request(['a', 'b'], { automatic: true });
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.messages.get('b')!.tools[0]).toMatchObject({ state: { output: 'OUTPUT' } });
    const retry = f.request(['a', 'b', 'c'], { retryErrorsOnly: true }); await flush();
    expect(f.read.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'a']);
    f.reads.get('a')!.resolve(full('a')); await retry; expect(f.state(['a', 'b']).failed).toBe(false);
  });
  it('a later authoritative full body clears the failure without another exact request', async () => {
    const f = fixture(); const work = f.request(['a']); await flush(); f.reads.get('a')!.reject(new Error('offline')); await work;
    f.messages.set('a', full('a')); await f.request(['a'], { automatic: true });
    expect(f.state(['a'])).toEqual({ loading: false, failed: false, empty: false }); expect(f.read).toHaveBeenCalledTimes(1);
  });
  it('exposes successful no-output separately from failure', async () => {
    const f = fixture(); const work = f.request(['a']); await flush();
    f.reads.get('a')!.resolve(msg('a', [{ type: 'tool', state: { status: 'completed' } }])); await work;
    expect(f.state(['a'])).toEqual({ loading: false, failed: false, empty: true });
  });
  it('fences queued and active results on hide, settles callers, and preserves failure until scope reset', async () => {
    const f = fixture(); const work = f.request(['a', 'b', 'c']); await flush();
    f.reads.get('a')!.reject(new Error('offline')); await flush();
    expect(f.read).toHaveBeenCalledTimes(3); f.hide(); await work;
    for (const id of ['b', 'c']) f.reads.get(id)!.resolve(full(id)); await flush();
    expect(f.apply).not.toHaveBeenCalled(); expect(f.state(['a']).failed).toBe(true);
    await f.request(['d']); expect(f.read).toHaveBeenCalledTimes(3);
    f.cancel(true); expect(f.state(['a', 'b', 'c'])).toEqual({ loading: false, failed: false, empty: false });
  });
  it('does no transport work if cancelled before the dispatch microtask', async () => {
    const f = fixture(); const work = f.request(['a', 'b', 'c']); f.cancel(); await work; await flush();
    expect(f.read).not.toHaveBeenCalled(); expect(f.apply).not.toHaveBeenCalled();
  });
  it('old completions cannot replace newer same-ID messages or retire a new generation flight', async () => {
    const f = fixture(); const old = f.request(['a']); await flush(); const oldRead = f.reads.get('a')!;
    f.cancel(true); await old;
    const newer = { ...msg('a'), agent: 'new-generation' }; f.messages.set('a', newer);
    const next = f.request(['a']); await flush();
    oldRead.resolve(full('a')); await flush(); expect(f.state(['a']).loading).toBe(true); expect(f.messages.get('a')).toBe(newer);
    f.reads.get('a')!.resolve(full('a')); await next; expect(f.state(['a']).loading).toBe(false);
    const stale = f.request(['b']); await flush(); const source = f.messages.get('b')!;
    f.messages.set('b', { ...source, finish: 'tool-calls' }); f.reads.get('b')!.resolve(full('b')); await stale;
    expect(f.messages.get('b')!.finish).toBe('tool-calls'); expect(f.state(['b']).failed).toBe(true);
  });
  it('treats synchronous transport throws as retryable errors', async () => {
    const source = msg('a');
    const f = createActivityMaterializer({ current: () => true, message: () => source, read: () => { throw new Error('sync'); }, apply: vi.fn(), changed: vi.fn() });
    await f.request(['a']); expect(f.state(['a']).failed).toBe(true);
  });
});
