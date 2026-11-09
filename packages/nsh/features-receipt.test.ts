import { beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => new Map<string, string>());
vi.mock('nsh', () => ({
  signal: <T>(value: T) => { const read = () => value; read.set = (next: T) => { value = next; }; return read; },
  batch: (work: () => void) => work(), untracked: (read: () => unknown) => read(),
  Storage: { getItem: async (key: string) => storage.get(key) ?? null, setItem: async (key: string, value: string) => { storage.set(key, value); } },
}));
import { openFeatureReceipt } from './features-receipt';

const operation = { action: 'save' as const, path: '/api/yuri/assistants', method: 'POST' as const, body: { name: 'Yuri' }, resourceID: '', beforeIDs: ['existing'] };
describe('editor receipts reuse the real atomic draft partition', () => {
  beforeEach(() => storage.clear());
  it('persists before network admission and restores unknown create across disposal without any send', async () => {
    const first = openFeatureReceipt('host', 'bot:new'); await first.ready;
    await first.prepare(operation, { name: 'Yuri', prompt: 'Keep my draft' }); await first.close();
    const next = openFeatureReceipt('host', 'bot:new'); await next.ready;
    expect(next.value()).toMatchObject({ phase: 'unknown', operation, draft: { name: 'Yuri', prompt: 'Keep my draft' } });
    await next.close();
  });
  it('ACK is durable before cleanup, and another Host has an independent journal', async () => {
    const first = openFeatureReceipt('host', 'task:new'); await first.ready; await first.prepare(operation, {}); await first.confirm({ id: 'created', revision: 1 }); await first.close();
    const next = openFeatureReceipt('host', 'task:new'), other = openFeatureReceipt('other', 'task:new'); await Promise.all([next.ready, other.ready]);
    expect(next.value()?.phase).toBe('acknowledged'); expect(other.value()).toBe(null);
    await next.clear(); await next.close(); await other.close();
  });
  it('corrupt restore and overlapping owners cannot overwrite unknown evidence', async () => {
    const first = openFeatureReceipt('host', 'bot:new'); await first.ready; await first.prepare(operation, {});
    const other = openFeatureReceipt('host', 'bot:new'); await other.ready;
    await expect(first.prepare(operation, { name: 'stale' })).rejects.toThrow();
    expect(other.value()?.phase).toBe('unknown'); await other.close();
  });
  it('malformed inner receipt cannot be overwritten by a new operation', async () => {
    const first = openFeatureReceipt('host', 'bot:new'); await first.ready; await first.prepare(operation, {}); await first.close();
    const key = [...storage.keys()][0], outer = JSON.parse(storage.get(key)!); outer.draft = '{bad'; const corrupted = JSON.stringify(outer); storage.set(key, corrupted);
    const next = openFeatureReceipt('host', 'bot:new'); await expect(next.ready).rejects.toThrow();
    await expect(next.prepare(operation, {})).rejects.toThrow(); expect(storage.get(key)).toBe(corrupted); await next.close();
  });
  it('credential-shaped metadata is rejected before it can enter Storage', async () => {
    const journal = openFeatureReceipt('host', 'bot:new'); await journal.ready;
    expect(() => journal.prepare({ ...operation, body: { apiKey: 'synthetic-forbidden' } }, {})).toThrow('credentials-forbidden');
    expect([...storage.values()].some(value => value.includes('synthetic-forbidden'))).toBe(false); await journal.close();
  });
});
