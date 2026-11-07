import { expect, test } from 'vitest';
import { createChangesReader } from './chat-changes-model';
import { createChangesActions } from './chat-changes-actions';

const snapshot = { isClean: false, current: 'feature', files: [{ path: 'both.ts', index: 'M', working_dir: 'M' }, { path: 'new.ts', index: '?', working_dir: '?' }] };
test('mutations need workspace authority, exact paths and explicit destructive confirmation', async () => {
  const calls: unknown[] = [];
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot);
  const actions = createChangesActions(reader, async (...args) => { calls.push(args); return { success: true }; });
  expect(await actions.move(['new.ts'], false)).toBe(false);
  await reader.refresh();
  expect(await actions.revert(['new.ts'], false)).toBe(false);
  expect(await actions.move(['../outside'], false)).toBe(false);
  expect(await actions.move(['new.ts'], false)).toBe(true);
  expect(calls).toEqual([['/api/git/stage?directory=%2Ffixture', 'POST', { paths: ['new.ts'] }]]);
});

test('partial revert isolates failures and retries only the explicit failed paths', async () => {
  let fail = true; const called: string[] = [];
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  const actions = createChangesActions(reader, async (_, __, body) => { const path = (body as { path: string }).path; called.push(path); if (path === 'new.ts' && fail) throw new Error('offline'); return { success: true }; });
  expect(await actions.revert(['both.ts', 'new.ts'], true)).toBe(false);
  expect(actions.state().failedPaths).toEqual(['new.ts']); expect(called).toEqual(['both.ts', 'new.ts']);
  fail = false; expect(await actions.revert(actions.state().failedPaths, true)).toBe(true);
  expect(called).toEqual(['both.ts', 'new.ts', 'new.ts']);
});

test('commit captures only staged files, never stages their working copies, and rejects empty input', async () => {
  const calls: unknown[] = [];
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  const actions = createChangesActions(reader, async (...args) => { calls.push(args); return { success: true }; });
  expect(await actions.commit('  ')).toBe(false);
  expect(await actions.commit('exact staged change')).toBe(true);
  expect(calls).toEqual([['/api/git/commit?directory=%2Ffixture', 'POST', { message: 'exact staged change', files: ['both.ts'], stageFiles: [] }]]);
});

test('turn sources cannot stage, revert, commit, or sync even when UI is bypassed', async () => {
  const calls: unknown[] = [];
  const reader = createChangesReader({ kind: 'turn', directory: '/fixture', sessionID: 's', messageID: 'm', files: [{ path: 'old' }] }, async () => snapshot);
  const actions = createChangesActions(reader, async (...args) => { calls.push(args); return { success: true }; });
  await actions.move(['old'], false); await actions.revert(['old'], true); await actions.commit('message'); await actions.sync();
  expect(calls).toEqual([]);
});

test('sync uses authoritative fetch/read/pull/read/push order and refuses dirty behind state', async () => {
  const calls: string[] = [];
  let dirty = true;
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  const actions = createChangesActions(reader, async (path) => {
    calls.push(path.split('?')[0]);
    if (path.includes('/remotes')) return [{ name: 'origin' }];
    if (path.includes('/status')) return { ...snapshot, files: dirty ? snapshot.files : [], isClean: !dirty, behind: calls.filter(path => path === '/api/git/status').length === 1 ? 1 : 0, ahead: 1, tracking: 'origin/feature' };
    return { success: true };
  });
  expect(await actions.sync()).toBe(false); expect(calls).not.toContain('/api/git/pull'); expect(calls).not.toContain('/api/git/push');
  dirty = false; calls.length = 0;
  expect(await actions.sync()).toBe(true);
  expect(calls).toEqual(['/api/git/remotes', '/api/git/fetch', '/api/git/status', '/api/git/pull', '/api/git/status', '/api/git/push']);
});
