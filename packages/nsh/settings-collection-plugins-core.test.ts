import { expect, test, vi } from 'vitest';
import { createCollectionPluginUpdates } from './settings-collection-plugins-core';
import type { Row } from './model';

test('a failed registry item and an uncertain write do not block complete later items or replay writes', async () => {
  const send = vi.fn(async (path: string, method?: string): Promise<unknown> => {
    if (path.includes('registry')) {
      if (path.includes('first')) throw new Error('registry offline');
      return { results: [] };
    }
    if (path.includes('/update') && method === 'POST' && send.mock.calls.filter(call => call[0].includes('/update')).length === 1) throw new Error('response lost');
    return { success: true };
  });
  const batch = createCollectionPluginUpdates(send, () => true, '/captured');
  const rows = [{ id: 'one', spec: 'first@latest' }, { id: 'two', spec: 'second@latest' }, { id: 'three', spec: 'third@latest' }];
  await batch.update(rows);
  expect(batch.results().map(item => [item.id, item.state])).toEqual([['one', 'failed'], ['two', 'unknown'], ['three', 'updated']]);
  await batch.update(rows);
  expect(send.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(2);
  expect(send.mock.calls.filter(call => call[1] === 'POST').every(call => call[0] === '/api/plugin/update?location%5Bdirectory%5D=%2Fcaptured')).toBe(true);
});

test('a pinned registry update uses the actual entry PATCH and preserves options by omission', async () => {
  const send = vi.fn(async (path: string): Promise<unknown> => path.includes('registry') ? { results: [{ spec: 'example@1.0.0', kind: 'npm-ok', hasUpdate: true, name: 'example', latestVersion: '2.0.0' }] } : { reloadFailed: true, warning: 'reload pending' });
  const batch = createCollectionPluginUpdates(send, () => true, '/captured');
  await batch.update([{ id: 'entry/one', spec: 'example@1.0.0', options: { preserve: true } }]);
  expect(send).toHaveBeenLastCalledWith('/api/config/plugins/entry/entry%2Fone?directory=%2Fcaptured', 'PATCH', { spec: 'example@2.0.0' });
  expect(batch.results()).toEqual([{ id: 'entry/one', state: 'updated', message: 'reload pending' }]);
});

test('unknown pinned receipt reconciles exact entry identity with GET only, independently of another failed read', async () => {
  let recovering = false;
  const send = vi.fn(async (path: string, method = 'GET'): Promise<unknown> => {
    if (method === 'PATCH') throw new Error('lost response');
    if (path.includes('registry')) return { results: [{ spec: 'example@1', kind: 'npm-ok', hasUpdate: true, name: 'example', latestVersion: '2' }] };
    if (recovering) return { entries: [{ id: 'rewritten-id', scope: 'user', spec: 'example@2', sourcePath: '/captured/config.jsonc' }], files: [] };
    throw new Error('read offline');
  });
  const batch = createCollectionPluginUpdates(send, () => true, '/captured');
  await batch.update([{ id: 'exact', scope: 'user', spec: 'example@1', sourcePath: '/captured/config.jsonc' }]);
  expect(batch.results()[0].state).toBe('unknown');
  await batch.reconcile(); expect(batch.results()[0].state).toBe('unknown');
  recovering = true; const before = send.mock.calls.length;
  await batch.reconcile();
  expect(send.mock.calls.slice(before).every(call => !call[1] || call[1] === 'GET')).toBe(true);
  expect(batch.results()[0].state).toBe('updated');
  expect(send.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(1);
});

test('runtime unknown receipt verifies target and version, cannot be cleared by another package or replayed', async () => {
  let version = '1', target = 'example@latest';
  const send = vi.fn(async (path: string, method = 'GET'): Promise<unknown> => {
    if (path.includes('registry')) return { results: [] };
    if (path.startsWith('/api/config/plugins')) return { entries: [{ id: 'runtime', spec: 'example@latest', scope: 'project', sourcePath: '/captured/opencode.jsonc' }], files: [] };
    if (method === 'POST') throw new Error('lost response');
    return { data: [{ source: { type: 'package', target, version, outdated: version === '1', updating: false }, state: { status: 'active' } }] };
  });
  const batch = createCollectionPluginUpdates(send, () => true, '/captured');
  await batch.update([{ id: 'runtime', spec: 'example@latest', scope: 'project', sourcePath: '/captured/opencode.jsonc' }]);
  target = 'other@latest'; version = '2'; await batch.reconcile(); expect(batch.results()[0].state).toBe('unknown');
  target = 'example@latest'; await batch.reconcile(); expect(batch.results()[0].state).toBe('updated');
  await batch.update([{ id: 'runtime', spec: 'example@latest', scope: 'project', sourcePath: '/captured/opencode.jsonc' }]);
  expect(send.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
});

test('rewritten IDs do not release unknown reservations and one mismatched identity does not block another complete receipt', async () => {
  const send = vi.fn(async (path: string, method = 'GET'): Promise<unknown> => {
    if (method === 'PATCH') throw new Error('lost response');
    if (path.includes('registry')) return { results: [{ spec: 'example@1', kind: 'npm-ok', hasUpdate: true, name: 'example', latestVersion: '2' }] };
    return { entries: [{ id: 'new-project', scope: 'project', spec: 'example@2', sourcePath: '/captured/project.jsonc', options: { changed: true } }, { id: 'new-user', scope: 'user', spec: 'example@2', sourcePath: '/global/config.jsonc', options: { keep: true } }], files: [] };
  });
  const batch = createCollectionPluginUpdates(send, () => true, '/captured');
  await batch.update([{ id: 'old-project', scope: 'project', spec: 'example@1', sourcePath: '/captured/project.jsonc', options: { keep: true } }, { id: 'old-user', scope: 'user', spec: 'example@1', sourcePath: '/global/config.jsonc', options: { keep: true } }]);
  const before = send.mock.calls.length; await batch.reconcile();
  expect(send.mock.calls.slice(before).every(call => !call[1] || call[1] === 'GET')).toBe(true);
  expect(batch.results().map(item => [item.id, item.state])).toEqual([['old-project', 'unknown'], ['old-user', 'updated']]);
  await batch.update([{ id: 'new-project', scope: 'project', spec: 'example@2', sourcePath: '/captured/project.jsonc', options: { changed: true } }]);
  expect(send.mock.calls.filter(call => call[1] === 'PATCH')).toHaveLength(2);
});

test.each(['options-changed', 'missing-source-path', 'missing-scope', 'missing-id'] as const)('runtime unknown receipt stays unknown with %s even when the runtime version advances; recovery is GET-only', async failure => {
  const item: Row = { id: 'runtime', spec: 'example@latest', scope: 'project', sourcePath: '/captured/opencode.jsonc', options: { keep: true } };
  const entry: Row = { ...item, options: { keep: true } };
  if (failure === 'options-changed') entry.options = { keep: false };
  if (failure === 'missing-source-path') { delete item.sourcePath; delete entry.sourcePath; }
  if (failure === 'missing-scope') { delete item.scope; delete entry.scope; }
  if (failure === 'missing-id') { delete item.id; delete entry.id; }
  let version = '1';
  const send = vi.fn(async (path: string, method = 'GET'): Promise<unknown> => {
    if (path.includes('registry')) return { results: [] };
    if (path.startsWith('/api/config/plugins')) return { entries: [entry], files: [] };
    if (method === 'POST') throw new Error('lost update response');
    return { data: [{ source: { type: 'package', target: 'example@latest', version, outdated: version === '1', updating: false }, state: { status: 'active' } }] };
  });
  const batch = createCollectionPluginUpdates(send, () => true, '/captured');
  await batch.update([item]); expect(batch.results()[0].state).toBe('unknown');
  version = '2'; const before = send.mock.calls.length;
  await batch.reconcile();
  expect(batch.results()[0].state).toBe('unknown');
  expect(send.mock.calls.slice(before).every(call => !call[1] || call[1] === 'GET')).toBe(true);
  await batch.update([item]);
  expect(send.mock.calls.filter(call => call[1] === 'POST')).toHaveLength(1);
});
