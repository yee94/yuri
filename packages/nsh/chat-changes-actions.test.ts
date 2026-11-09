import { expect, test } from 'vitest';
import { createChangesReader } from './chat-changes-model';
import { changesWriteJournal, createChangesActions } from './chat-changes-actions';

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
  const actions = createChangesActions(reader, async (_, __, body) => { const path = (body as { path: string }).path; called.push(path); if (path === 'new.ts' && fail) return { success: false, error: 'rejected' }; return { success: true }; });
  expect(await actions.revert(['both.ts', 'new.ts'], true)).toBe(false);
  expect(actions.state().failedPaths).toEqual(['new.ts']); expect(called).toEqual(['both.ts', 'new.ts']);
  fail = false; expect(await actions.revert(actions.state().failedPaths, true)).toBe(true);
  expect(called).toEqual(['both.ts', 'new.ts', 'new.ts']);
});

test('unconfirmed commit cannot replay after refresh or cancel, while definitive rejection remains retryable', async () => {
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  let writes = 0;
  const actions = createChangesActions(reader, async () => { writes++; throw new Error('response lost'); });
  expect(await actions.commit('one')).toBe(false);
  expect(actions.state()).toMatchObject({ unknown: true, committed: false });
  await reader.refresh(); actions.cancel();
  expect(await actions.commit('one')).toBe(false); expect(await actions.move(['new.ts'], false)).toBe(false);
  expect(writes).toBe(1);
  let rejected = true;
  const retry = createChangesActions(reader, async () => rejected ? { success: false, error: 'rejected' } : { success: true });
  expect(await retry.commit('one')).toBe(false); expect(retry.state()).toMatchObject({ unknown: false });
  rejected = false; expect(await retry.commit('one')).toBe(true);
});

test('unknown batch outcome stops remaining destructive dispatch and is never offered as failed-path retry', async () => {
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  const calls: unknown[] = [];
  const actions = createChangesActions(reader, async (_, __, body) => { calls.push(body); throw new Error('lost'); });
  expect(await actions.revert(['both.ts', 'new.ts'], true)).toBe(false);
  expect(calls).toEqual([{ path: 'both.ts' }]); expect(actions.state()).toMatchObject({ unknown: true, failedPaths: [] });
});

test('durable marker precedes dispatch, survives unconfirmed outcome and blocks remount/reconnect', async () => {
  const events: string[] = [], stored = new Map<string, string>();
  const storage = { getItem: async (key: string) => stored.get(key) ?? null, setItem: async (key: string, value: string) => { events.push('persist'); stored.set(key, value); }, removeItem: async (key: string) => { events.push('clear'); stored.delete(key); } };
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  const journal = changesWriteJournal('durable-fixture', '/fixture', storage);
  const actions = createChangesActions(reader, async () => { events.push('POST'); throw new Error('lost'); }, reader.current, () => {}, journal);
  expect(await actions.commit('one')).toBe(false); // Storage authority still loading.
  await journal.restore;
  expect(await actions.commit('one')).toBe(false);
  expect(events).toEqual(['persist', 'POST']); expect([...stored.values()]).toEqual(['pending']);
  const remounted = createChangesActions(reader, async () => { events.push('REPLAY'); }, reader.current, () => {}, changesWriteJournal('durable-fixture', '/fixture', storage));
  expect(await remounted.commit('one')).toBe(false); expect(events).not.toContain('REPLAY');
  const restored = changesWriteJournal('restored-fixture', '/fixture', { ...storage, getItem: async () => 'pending' }); await restored.restore;
  expect(restored.unknown).toBe(true);
});

test('durable storage failure prevents dispatch and confirmed response clears its marker', async () => {
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  let posts = 0, marker: string | null = null;
  const journal = changesWriteJournal('confirmed-fixture', '/fixture', { getItem: async () => null, setItem: async (_, value) => { marker = value; }, removeItem: async () => { marker = null; } }); await journal.restore;
  const actions = createChangesActions(reader, async () => { posts++; expect(marker).toBe('pending'); return { success: true }; }, reader.current, () => {}, journal);
  expect(await actions.commit('once')).toBe(true); expect(marker).toBeNull(); expect(posts).toBe(1);
  const broken = changesWriteJournal('broken-fixture', '/fixture', { getItem: async () => null, setItem: async () => { throw new Error('disk full'); }, removeItem: async () => {} }); await broken.restore;
  const blocked = createChangesActions(reader, async () => { posts++; }, reader.current, () => {}, broken);
  expect(await blocked.commit('no dispatch')).toBe(false); expect(posts).toBe(1); expect(blocked.state().unknown).toBe(true);
});

test('remounted callback observer receives the completion of a retired owner without dispatching another write', async () => {
  const reader = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await reader.refresh();
  const journal = changesWriteJournal('flight-fixture', '/fixture');
  let resolve!: (value: unknown) => void, notifications = 0;
  const original = createChangesActions(reader, () => new Promise(done => { resolve = done; }), reader.current, () => {}, journal);
  const pending = original.commit('once'); await Promise.resolve(); original.cancel();
  const remounted = createChangesActions(reader, async () => { throw new Error('Must not replay'); }, reader.current, () => { notifications++; }, journal);
  expect(remounted.state().pending).toBe(true); expect(await remounted.commit('twice')).toBe(false);
  resolve({ success: true }); await pending;
  expect(remounted.state().pending).toBe(false); expect(remounted.state().needsRefresh).toBe(true); expect(notifications).toBeGreaterThan(0);
});

test('actual A/B controllers require a post-completion successful GET; a pre-ACK read and failed refresh cannot re-admit B writes', async () => {
  const journal = changesWriteJournal('actual-ab-fixture', '/fixture');
  let activeA = true, ack!: (value: unknown) => void, finishOldRead!: (value: unknown) => void;
  const readerA = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot, () => activeA);
  await readerA.refresh();
  const actionsA = createChangesActions(readerA, () => new Promise(resolve => { ack = resolve; }), readerA.current, () => {}, journal);
  const writeA = actionsA.commit('A once'); await Promise.resolve(); activeA = false; actionsA.cancel();
  let mode: 'initial' | 'old-flight' | 'failed' | 'fresh' = 'initial', reads = 0, writes = 0;
  const readerB = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async path => {
    reads++;
    if (mode === 'old-flight') return new Promise(resolve => { finishOldRead = resolve; });
    if (mode === 'failed') throw new Error('GET offline');
    return snapshot;
  });
  await readerB.refresh();
  const actionsB = createChangesActions(readerB, async () => { writes++; return { success: true }; }, readerB.current, () => {}, journal);
  const prior = readerB.state().snapshot;
  expect(await actionsB.commit('B before ACK')).toBe(false);
  mode = 'old-flight'; const oldRead = readerB.refresh();
  ack({ success: true }); await writeA;
  finishOldRead(snapshot); await oldRead;
  mode = 'initial';
  expect(actionsB.state().pending).toBe(false); expect(actionsB.state().needsRefresh).toBe(true);
  expect(await actionsB.commit('B stale after ACK')).toBe(false);
  expect(writes).toBe(0);
  const retained = readerB.state().snapshot;
  mode = 'failed'; await readerB.refresh();
  expect(readerB.state().snapshot).toBe(retained); expect(await actionsB.commit('B after failed GET')).toBe(false);
  mode = 'fresh'; await readerB.refresh();
  expect(actionsB.state().needsRefresh).toBe(false);
  expect(await actionsB.commit('B after fresh GET')).toBe(true); expect(writes).toBe(1);
  expect(prior).not.toBeNull(); expect(reads).toBeGreaterThan(3);
});

test('actual A/B controllers never clear an unknown write outcome through a newer successful status GET', async () => {
  const journal = changesWriteJournal('unknown-ab-fixture', '/fixture');
  let activeA = true, reject!: (reason: unknown) => void, writesB = 0;
  const readerA = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot, () => activeA); await readerA.refresh();
  const actionsA = createChangesActions(readerA, () => new Promise((_, fail) => { reject = fail; }), readerA.current, () => {}, journal);
  const flight = actionsA.commit('once'); await Promise.resolve(); activeA = false; actionsA.cancel();
  const readerB = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await readerB.refresh();
  const actionsB = createChangesActions(readerB, async () => { writesB++; return { success: true }; }, readerB.current, () => {}, journal);
  reject(Object.assign(new Error('lost response'), { status: 503 })); await flight;
  await readerB.refresh();
  expect(actionsB.state()).toMatchObject({ pending: false, needsRefresh: false, unknown: true });
  expect(await actionsB.commit('no replay')).toBe(false); expect(await actionsB.move(['new.ts'], false)).toBe(false);
  expect(writesB).toBe(0);
});

test('bounded journal eviction cannot make a retained pre-write reader authoritative again', async () => {
  const journal = changesWriteJournal('evicted-ab-fixture', '/fixture');
  const readerA = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await readerA.refresh();
  const readerB = createChangesReader({ kind: 'workspace', directory: '/fixture' }, async () => snapshot); await readerB.refresh();
  const actionsA = createChangesActions(readerA, async () => ({ success: true }), readerA.current, () => {}, journal);
  expect(await actionsA.commit('A once')).toBe(true); actionsA.cancel();
  for (let i = 0; i < 250; i++) changesWriteJournal('cold-eviction-fixture', `/fixture-${i}`);
  const recreated = changesWriteJournal('evicted-ab-fixture', '/fixture'); expect(recreated).not.toBe(journal);
  let writes = 0;
  const actionsB = createChangesActions(readerB, async () => { writes++; return { success: true }; }, readerB.current, () => {}, recreated);
  expect(await actionsB.commit('B stale')).toBe(false); expect(writes).toBe(0);
  await readerB.refresh(); expect(await actionsB.commit('B fresh')).toBe(true); expect(writes).toBe(1);
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
  const unscoped = createChangesReader({ kind: 'workspace', directory: '' }, async () => snapshot); await unscoped.refresh();
  const refused = createChangesActions(unscoped, async (...args) => { calls.push(args); return { success: true }; });
  await refused.move(['new.ts'], false); await refused.revert(['new.ts'], true); await refused.commit('message'); await refused.sync();
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
