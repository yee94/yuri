import { describe, expect, it, vi } from 'vitest';
import { acceptBtwIntent, createBtwGenerate, createBtwOwner, type BtwScope } from './chat-btw-model';
import { bindRequest } from './runtime';

const nativeHost = vi.hoisted(() => ({ available: () => true, call: vi.fn() }));
vi.mock('nsh', () => ({ host: nativeHost }));

const scope: BtwScope = { runtime: { hostID: 'host', lease: 'lease-1' }, directory: '/project', sessionID: 'session/one' };
const deferred = () => { let resolve!: (value: unknown) => void; let reject!: (error: unknown) => void; const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('Native BTW official request adapter', () => {
  it('uses the production native request callback with captured immutable Host lease', async () => {
    nativeHost.call.mockResolvedValueOnce({ status: 200, body: { data: { text: 'answer' } } });
    const generate = createBtwGenerate(scope, bindRequest(scope.runtime));
    await expect(generate('question')).resolves.toBe('answer');
    expect(nativeHost.call).toHaveBeenCalledExactlyOnceWith('runtime.request', {
      path: '/api/session/session%2Fone/generate', method: 'POST', body: { prompt: 'question' }, expectedHost: { hostID: 'host', lease: 'lease-1' },
    });
  });
  it('makes exactly one generate POST with only prompt and unwraps the official data envelope', async () => {
    const request = vi.fn(async () => ({ data: { text: ' answer ' } }));
    const owner = createBtwOwner(scope, createBtwGenerate(scope, request), () => true);
    expect(acceptBtwIntent(owner, { question: 'Why?' }, false)).toBe('accepted');
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual(['/api/session/session%2Fone/generate', 'POST', { prompt: expect.stringContaining('Why?') }]);
    expect(owner.snapshot().turns[0]).toMatchObject({ answer: 'answer', status: 'complete' });
  });
  it.each([undefined, {}, { text: 'old guessed envelope' }, { data: {} }, { data: { text: '' } }])('rejects malformed/empty success %j', async response => {
    const owner = createBtwOwner(scope, createBtwGenerate(scope, async () => response), () => true);
    owner.ask('question'); await settle();
    expect(owner.snapshot().turns[0]?.status).toBe('failed');
  });
});

describe('Native BTW lifecycle', () => {
  it('bare open performs no request; references reject without touching full main draft/queue/selection', () => {
    const generate = vi.fn(async () => 'answer');
    const owner = createBtwOwner(scope, generate, () => true);
    const main = { text: '/btw why @file', attachments: ['attachment'], inline: ['inline'], queue: ['queued'], references: ['file'], selection: 'model' };
    const before = structuredClone(main);
    expect(acceptBtwIntent(owner, { question: 'why' }, true)).toBe('plainTextRequired');
    expect(main).toEqual(before);
    expect(owner.snapshot().open).toBe(false);
    expect(acceptBtwIntent(owner, { question: '' }, false)).toBe('accepted');
    expect(owner.snapshot().open).toBe(true);
    expect(generate).not.toHaveBeenCalled();
  });
  it('gates concurrent sends and replays successful side history without loading main messages', async () => {
    const first = deferred();
    const request = vi.fn().mockImplementationOnce(() => first.promise).mockResolvedValue({ data: { text: 'second' } });
    const owner = createBtwOwner(scope, createBtwGenerate(scope, request), () => true);
    expect(owner.ask('one')).toBe(true); expect(owner.ask('duplicate')).toBe(false); expect(owner.retry()).toBe(false);
    first.resolve({ data: { text: 'first' } }); await settle();
    owner.ask('two'); await settle();
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]?.[2].prompt).toContain('User: one\n\nAssistant: first');
  });
  it('unknown failures remain failed; explicit retry replaces latest turn, never repeats main writes', async () => {
    const request = vi.fn().mockRejectedValueOnce(undefined).mockResolvedValue({ data: { text: 'recovered' } });
    const owner = createBtwOwner(scope, createBtwGenerate(scope, request), () => true);
    owner.ask('question'); await settle(); expect(owner.snapshot().turns[0]?.status).toBe('failed');
    expect(owner.retry()).toBe(true); await settle();
    expect(owner.snapshot().turns).toHaveLength(1);
    expect(owner.snapshot().turns[0]?.answer).toBe('recovered');
    expect(request.mock.calls.map(call => call[1])).toEqual(['POST', 'POST']);
  });
  it('cancel/retry uses exact request identity; cancelled response cannot overwrite retry', async () => {
    const old = deferred(), fresh = deferred();
    const request = vi.fn().mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise);
    const owner = createBtwOwner(scope, createBtwGenerate(scope, request), () => true);
    owner.ask('question'); owner.cancel(); expect(owner.retry()).toBe(true);
    old.resolve({ data: { text: 'late old answer' } }); await settle();
    expect(owner.snapshot().turns[0]?.status).toBe('pending');
    fresh.resolve({ data: { text: 'new answer' } }); await settle();
    expect(owner.snapshot().turns[0]?.answer).toBe('new answer');
  });
  it('close/reopen ABA and stale action revisions cannot publish or affect the new conversation', async () => {
    const old = deferred(); const request = vi.fn().mockImplementationOnce(() => old.promise).mockResolvedValue({ data: { text: 'new' } });
    const owner = createBtwOwner(scope, createBtwGenerate(scope, request), () => true);
    owner.ask('old'); const action = owner.capture(); owner.close(); owner.open(); owner.edit('new draft');
    expect(owner.close(action)).toBe(false); expect(owner.submit(action)).toBe(false);
    old.resolve({ data: { text: 'late' } }); await settle();
    expect(owner.snapshot()).toMatchObject({ open: true, draft: 'new draft', turns: [] });
    owner.submit(); await settle(); expect(owner.snapshot().turns[0]?.answer).toBe('new');
  });
  it('Host lease retirement suppresses late result and further network work', async () => {
    const result = deferred(); let current = true;
    const request = vi.fn(() => result.promise);
    const owner = createBtwOwner(scope, createBtwGenerate(scope, request), () => current);
    owner.ask('question'); current = false; owner.retire(); current = true;
    result.resolve({ data: { text: 'wrong host' } }); await settle();
    expect(owner.snapshot().turns).toEqual([]); expect(owner.ask('again')).toBe(false); expect(request).toHaveBeenCalledTimes(1);
  });
  it('50 unrelated side draft edits never rebuild history or make network requests', async () => {
    const generate = vi.fn(async () => 'answer');
    const owner = createBtwOwner(scope, generate, () => true);
    owner.ask('question'); await settle();
    const history = owner.snapshot().turns;
    for (let index = 0; index < 50; index++) owner.edit(`draft ${index}`);
    expect(owner.snapshot().turns).toBe(history);
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
