import { expect, test, vi } from 'vitest';
import { discoverNative } from './native.js';

const info = (id) => ({ id: `ses_${id}`, title: `Conversation ${id}`, location: { directory: '/workspace/example' }, time: { updated: id } });
const clientFor = (size) => ({ session: { list: vi.fn(async ({ cursor, limit }) => {
  const offset = Number(cursor || 0); const end = Math.min(size, offset + limit);
  return { data: Array.from({ length: end - offset }, (_, index) => info(offset + index)), cursor: end < size ? { next: String(end) } : {} };
}) }, message: { list: vi.fn(async () => ({ data: [
  { type: 'assistant', content: [{ type: 'reasoning', text: 'private reasoning' }, { type: 'tool', text: 'tool output' }, { type: 'text', text: 'Real\n assistant answer' }] },
], cursor: {} })) } });

test('5000 native sessions count only metadata, with five bounded message pages and no writes', async () => {
  const client = clientFor(5000);
  const result = await discoverNative(client, 'runtime', { limitPerSource: 5, includeCounts: true });
  expect(result.counts.opencode).toEqual({ value: 5000, approximate: false });
  expect(result.sessions).toHaveLength(5); expect(result.errors).toEqual([]);
  expect(client.session.list).toHaveBeenCalledTimes(50);
  expect(client.message.list).toHaveBeenCalledTimes(5);
  expect(client.message.list.mock.calls.every(([query]) => query.limit === 10)).toBe(true);
  expect(result.sessions[0].excerpt).toBe('Real assistant answer');
  expect(result.descriptors.size).toBe(5);
});

test('full native discovery never reads messages; failed pagination does not claim a partial count', async () => {
  const client = clientFor(101);
  const full = await discoverNative(client, 'runtime');
  expect(full.sessions).toHaveLength(101); expect(client.message.list).not.toHaveBeenCalled();
  client.session.list.mockRejectedValueOnce(new Error('offline'));
  const failed = await discoverNative(client, 'runtime', { limitPerSource: 5, includeCounts: true });
  expect(failed.counts.opencode.value).toBeNull(); expect(failed.errors).toHaveLength(1);
});

test('counting failure keeps readable examples; repeated cursors and oversized catalogs stay bounded', async () => {
  const client = clientFor(5001);
  const result = await discoverNative(client, 'runtime', { limitPerSource: 5, includeCounts: true });
  expect(result.sessions).toHaveLength(5); expect(result.counts.opencode.value).toBeNull();
  expect(result.errors[0].code).toBe('too_many_sessions');
  client.session.list.mockResolvedValue({ data: [info(1)], cursor: { next: 'same' } });
  const repeated = await discoverNative(client, 'runtime', { limitPerSource: 5, includeCounts: true });
  expect(repeated.errors[0].code).toBe('invalid_source');
  expect(repeated.counts.opencode.value).toBeNull();
});
