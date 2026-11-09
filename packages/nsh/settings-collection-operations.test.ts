import { expect, test, vi } from 'vitest';
import { createCollectionRename, collectionCopyName, mergeCollectionEnv, renameCollectionKey } from './settings-collection-operations';

test('copy names use the complete captured catalog without writing', () => {
  expect(collectionCopyName('review', [{ name: 'review-copy' }, { name: 'review-copy-2' }])).toBe('review-copy-3');
});
test('rename preserves every captured config field and retries only verification after an uncertain create', async () => {
  const send = vi.fn(async (_path: string, method?: string, _body?: unknown): Promise<unknown> => { if (method === 'POST') throw new Error('offline'); return { scope: 'project', source: 'md', config: { prompt: 'body', custom: { retain: true } } }; });
  const rename = createCollectionRename({ domain: 'agents', name: 'old', nextName: 'new', scope: 'project', directory: '/captured', config: { prompt: 'body', custom: { retain: true } } }, send, () => true);
  expect(send).not.toHaveBeenCalled();
  await expect(rename.advance()).rejects.toThrow('offline');
  await rename.advance();
  expect(send.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
  expect(send.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(0);
  expect(rename.phase()).toBe('created');
  expect(send.mock.calls[0]).toEqual(['/api/config/agents/new?directory=%2Fcaptured', 'POST', { prompt: 'body', custom: { retain: true }, scope: 'project' }]);
});
test('delete failure retains the new entity and never replays create or delete automatically', async () => {
  const send = vi.fn(async (_path: string, method?: string): Promise<unknown> => { if (method === 'DELETE') throw new Error('offline'); if (method !== 'POST') return { config: { prompt: 'body' } }; return { success: true }; });
  const rename = createCollectionRename({ domain: 'agents', name: 'old', nextName: 'new', scope: 'user', config: { prompt: 'body' } }, send, () => true);
  await expect(rename.advance()).rejects.toThrow('offline');
  expect(rename.phase()).toBe('delete-unknown');
  await rename.advance();
  expect(send.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
  expect(send.mock.calls.filter(call => call[1] === 'DELETE')).toHaveLength(1);
  expect(rename.phase()).toBe('created');
});
test('retired scope cannot issue mutations', async () => {
  const send = vi.fn();
  const rename = createCollectionRename({ domain: 'agents', name: 'a', nextName: 'b', scope: 'user', config: {} }, send, () => false);
  await expect(rename.advance()).rejects.toThrow(); expect(send).not.toHaveBeenCalled();
});
test('MCP paste and key rename are local immutable drafts, with duplicate protection', () => {
  const source = { OLD: 'keep', TOKEN: 'old' };
  expect(mergeCollectionEnv(source, '# comment\nTOKEN="new=token"\nOTHER=next')).toEqual({ OLD: 'keep', TOKEN: 'new=token', OTHER: 'next' });
  expect(renameCollectionKey(source, 'OLD', 'NEW')).toEqual({ NEW: 'keep', TOKEN: 'old' });
  expect(() => renameCollectionKey(source, 'OLD', 'TOKEN')).toThrow();
  expect(source).toEqual({ OLD: 'keep', TOKEN: 'old' });
});
