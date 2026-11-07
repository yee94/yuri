import { describe, expect, test, vi } from 'vitest';
import { createChatHeaderMetadata, headerCatalogLimits, headerContextBaseline, type ChatHeaderMetadata } from './chat-header-metadata';

const target = { kind: 'session' as const, id: 'ses_a', title: 'Conversation', directory: '/workspace/a b' };
const assistant = { id: 'a1', type: 'assistant', tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 30, write: 10 } } };
const model = { id: 'chat', providerID: 'fixture', limit: { context: 1000 } };
const catalog = { schemaVersion: 1, providers: [{ id: 'fixture', models: { chat: model, alternate: { id: 'alternate', limit: { context: 400000 } } } }] };
const page = { data: [assistant, { id: 'u1', type: 'user', model: { id: 'chat', providerID: 'fixture' } }], complete: true };
const session = { data: { id: target.id, title: 'Actual session title', model: { id: 'chat', providerID: 'fixture' }, tokens: { input: 999999 } } };

describe('Chat header metadata authority', () => {
  test('newest assistant baseline includes input/output/reasoning/cache, not cumulative session usage', () => {
    expect(headerContextBaseline(page).baseline).toMatchObject({ totalTokens: 165, messageId: 'a1' });
    expect(headerContextBaseline({ data: [{ ...assistant, id: 'new', tokens: { input: 7 } }, assistant] }).baseline).toMatchObject({ messageId: 'new', totalTokens: 7 });
  });
  test('completed/missing-status compaction invalidates old tokens; running/failed does not', () => {
    for (const status of ['completed', undefined]) expect(headerContextBaseline({ data: [{ id: 'c', type: 'compaction', status, tokens: { input: 800 } }, assistant] }).baseline).toEqual({ compacted: true });
    for (const status of ['running', 'failed']) expect(headerContextBaseline({ data: [{ id: 'c', type: 'compaction', status }, assistant] }).baseline).toMatchObject({ totalTokens: 165 });
  });
  test('exact catalog lookup supports nondefault models without borrowing another limit', () => {
    const limits = headerCatalogLimits(catalog);
    expect(limits.get(JSON.stringify(['fixture', 'chat']))).toBe(1000);
    expect(limits.get(JSON.stringify(['fixture', 'alternate']))).toBe(400000);
    expect(limits.get(JSON.stringify(['other', 'chat']))).toBeUndefined();
    expect(() => headerCatalogLimits({})).toThrow('Invalid model catalog');
  });
  test('bounded single-session reads, deduplication and failed-refresh preservation', async () => {
    const values: ChatHeaderMetadata[] = [];
    let fail = false, now = 0;
    const read = vi.fn(async (path: string) => {
      if (fail) throw new Error('offline');
      if (path.includes('/message?')) return page;
      if (path.includes('/catalog/providers')) return catalog;
      if (path.includes('/git/status')) return { current: 'main' };
      return session;
    });
    const controller = createChatHeaderMetadata({ target, current: () => true, now: () => now, read, changed: value => values.push(value) });
    await Promise.all([controller.refresh(), controller.refresh()]);
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.map(call => call[0])).toContain('/api/session/ses_a/message?directory=%2Fworkspace%2Fa%20b&limit=20&order=desc');
    expect(read.mock.calls.filter(call => /catalog/.test(call[0]))).toHaveLength(1);
    expect(read.mock.calls.some(call => /session-index|model\/default/.test(call[0]))).toBe(false);
    expect(values.at(-1)).toMatchObject({ tokens: 165, limit: 1000, title: 'Actual session title', branch: 'main', errors: [] });
    fail = true; now = 60001;
    await controller.refresh();
    expect(values.at(-1)).toMatchObject({ tokens: 165, limit: 1000, errors: ['offline', 'offline', 'offline', 'offline'] });
  });
  test('late Host/page completions and disposal cannot publish stale metadata', async () => {
    let current = true;
    const completions: ((value: unknown) => void)[] = [];
    const changed = vi.fn();
    const controller = createChatHeaderMetadata({ target, current: () => current, changed, read: () => new Promise(done => { completions.push(done); }) });
    const pending = controller.refresh();
    current = false; controller.dispose();
    completions.forEach(done => done({}));
    await pending;
    expect(changed).toHaveBeenCalledTimes(1);
  });
  test('one failed resource keeps unrelated successful branch and measured usage', async () => {
    let latest: ChatHeaderMetadata | undefined;
    const controller = createChatHeaderMetadata({ target, current: () => true, changed: value => { latest = value; }, read: async path => {
      if (path.includes('/message?')) return page;
      if (path.includes('/catalog/providers')) throw new Error('limits unavailable');
      if (path.includes('/git/status')) return { current: 'main' };
      return session;
    } });
    await controller.refresh();
    expect(latest).toMatchObject({ branch: 'main', tokens: 165, errors: ['limits unavailable'] });
    expect(latest?.limit).toBeUndefined();
  });
  test('50 repeated settled refreshes never rescan/refetch a fresh catalog; expiry invalidates it', async () => {
    let now = 0;
    const read = vi.fn(async (path: string) => path.includes('/catalog/providers') ? catalog : path.includes('/message?') ? page : path.includes('/git/status') ? { current: 'main' } : session);
    const controller = createChatHeaderMetadata({ target, now: () => now, current: () => true, read, changed: () => {} });
    for (let index = 0; index < 50; index++) await controller.refresh();
    expect(read.mock.calls.filter(call => call[0].includes('/catalog/providers'))).toHaveLength(1);
    now = 60001;
    await controller.refresh();
    expect(read.mock.calls.filter(call => call[0].includes('/catalog/providers'))).toHaveLength(2);
    controller.dispose();
  });
});
