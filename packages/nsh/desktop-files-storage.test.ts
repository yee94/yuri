import { expect, test } from 'vitest';
import { createDesktopFileJournalStorage } from './desktop-files-storage';
import { createDesktopEditorJournal, DESKTOP_JOURNAL_PREFIX } from './desktop-files-journal';
import { createDesktopEditors, type DesktopEditorOperation } from './desktop-files-editor-model';
import { desktopPanelScopeKey, type DesktopPanelScope } from './desktop-panel-model';

const scope: DesktopPanelScope = { host: { hostID: 'synthetic', lease: 'never-persist' }, authorityKey: 'synthetic-authority', sessionID: 'session', directory: '/workspace' };
const key = DESKTOP_JOURNAL_PREFIX + JSON.stringify([desktopPanelScopeKey(scope), '/workspace/source.ts']);
const raw = (text = 'draft') => JSON.stringify({ version: 1, scope: { ...scope, host: { hostID: scope.host.hostID } }, path: '/workspace/source.ts', text, base: 'base', wire: 'base', eol: '\n', bom: false, pending: null, conflict: false });
function fixture() {
  let snapshot = { status: 'ready', version: 0, requestID: null as string | null, records: {} as Record<string, string> };
  let loseCommit = false, rejectCommit = false, loseSync = false, fakeReceipt = false;
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const native = async <T>(name: string, body: Record<string, unknown>): Promise<T> => {
    calls.push({ name, body });
    const method = name.split('.').pop();
    if (method === 'commit') {
      if (rejectCommit) return { status: 'denied', code: 'file_journal_owner_conflict' } as T;
      if (body.expectedVersion !== snapshot.version) return { status: 'denied', code: 'file_journal_owner_conflict' } as T;
      snapshot = { status: 'ready', version: snapshot.version + 1, requestID: String(body.requestID), records: body.records as Record<string, string> };
      if (loseCommit) throw new Error('transport_lost');
    }
    if (method === 'sync' && loseSync) throw new Error('sync_lost');
    return { ...snapshot, ...(fakeReceipt ? { requestID: 'another' } : {}) } as T;
  };
  return { native, calls, snapshot: () => snapshot, lost(value: boolean) { loseCommit = value; }, rejected(value: boolean) { rejectCommit = value; }, syncLost(value: boolean) { loseSync = value; }, fake(value: boolean) { fakeReceipt = value; } };
}
test('native snapshot CAS mutations and sync bind exact durable version/receipt, never NSH Storage or local paths', async () => {
  const f = fixture(), storage = createDesktopFileJournalStorage(f.native);
  expect(await storage.keys()).toEqual([]); await storage.setItem(key, raw()); await storage.sync!();
  expect(await storage.getItem(key)).toBe(raw());
  const commit = f.calls.find(call => call.name.endsWith('.commit'))!;
  expect(Object.keys(commit.body).sort()).toEqual(['expectedVersion', 'records', 'requestID']);
  expect(f.calls.at(-1)?.body).toEqual({ version: 1, requestID: commit.body.requestID });
  await storage.removeItem(key); await storage.sync!(); expect(await storage.keys()).toEqual([]);
});
test('lost commit ACK only verifies the native receipt/barrier and never replays the transaction', async () => {
  const f = fixture(), storage = createDesktopFileJournalStorage(f.native); f.lost(true);
  await storage.setItem(key, raw());
  expect(f.calls.filter(call => call.name.endsWith('.commit'))).toHaveLength(1);
  expect(f.calls.filter(call => call.name.endsWith('.sync'))).toHaveLength(1);
  expect(await storage.getItem(key)).toBe(raw());
});
test('a busy sync response is not a negative receipt for the earlier commit, and missing capabilities have no Storage fallback', async () => {
  const f = fixture(); f.lost(true); let busy = true;
  const storage = createDesktopFileJournalStorage(async <T>(name: string, body: Record<string, unknown>) => name.endsWith('.sync') && busy ? { status: 'denied', code: 'file_journal_busy' } as T : f.native<T>(name, body));
  await expect(storage.setItem(key, raw())).rejects.toThrow('commit_unknown');
  await expect(storage.getItem(key)).rejects.toThrow('commit_unknown');
  busy = false; f.lost(false); await storage.recover!(); expect(await storage.getItem(key)).toBeNull();
  const missing = createDesktopFileJournalStorage(async () => { throw new Error('unsupported_desktop_capability'); });
  await expect(missing.keys()).rejects.toThrow('unsupported_desktop_capability');
  await expect(missing.setItem(key, raw())).rejects.toThrow('unsupported_desktop_capability');
});
test('unconfirmed native commit freezes all operations; explicit recovery verifies then CAS-rolls back prior snapshot', async () => {
  const f = fixture(), storage = createDesktopFileJournalStorage(f.native); f.lost(true); f.syncLost(true);
  await expect(storage.setItem(key, raw())).rejects.toThrow('commit_unknown');
  await expect(storage.getItem(key)).rejects.toThrow('commit_unknown');
  await expect(storage.removeItem(key)).rejects.toThrow('commit_unknown');
  expect(f.calls.filter(call => call.name.endsWith('.commit'))).toHaveLength(1);
  f.syncLost(false); f.lost(false); await storage.recover!();
  expect(f.snapshot().records).toEqual({}); expect(await storage.getItem(key)).toBeNull();
  expect(f.calls.filter(call => call.name.endsWith('.commit'))).toHaveLength(2);
});
test('failed recovery rollback retains its original target through a second uncertain commit', async () => {
  const f = fixture(); let failRollback = false;
  const storage = createDesktopFileJournalStorage(async <T>(name: string, body: Record<string, unknown>) => {
    if (name.endsWith('.commit') && failRollback) { f.lost(true); f.syncLost(true); }
    return f.native<T>(name, body);
  });
  f.lost(true); f.syncLost(true); await expect(storage.setItem(key, raw())).rejects.toThrow();
  f.syncLost(false); f.lost(false); failRollback = true;
  await expect(storage.recover!()).rejects.toThrow('rollback_unconfirmed');
  failRollback = false; f.syncLost(false); f.lost(false);
  await storage.recover!(); expect(f.snapshot().records).toEqual({});
  expect(f.calls.filter(call => call.name.endsWith('.commit'))).toHaveLength(2);
});
test('schema/capacity failures never invoke commit and forged sync ACK is never accepted', async () => {
  const f = fixture(), storage = createDesktopFileJournalStorage(f.native);
  for (const [name, value] of [['other', raw()], [key, JSON.stringify({ token: 'not-allowed' })]]) await expect(storage.setItem(name, value)).rejects.toThrow();
  expect(f.calls.some(call => call.name.endsWith('.commit'))).toBe(false);
  await storage.setItem(key, raw()); f.fake(true); await expect(storage.sync!()).rejects.toThrow('receipt');
});
test('cold native snapshots retain other directory and authority partitions rather than filtering by the current Host', async () => {
  const f = fixture(), first = createDesktopFileJournalStorage(f.native);
  await first.setItem(key, raw('first partition'));
  const otherScope = { ...scope, authorityKey: 'different-authorization', directory: '/another' };
  const otherKey = DESKTOP_JOURNAL_PREFIX + JSON.stringify([desktopPanelScopeKey(otherScope), '/another/source.ts']);
  const other = JSON.parse(raw('second partition')); other.scope.authorityKey = otherScope.authorityKey; other.scope.directory = otherScope.directory; other.path = '/another/source.ts';
  await first.setItem(otherKey, JSON.stringify(other));
  const cold = createDesktopFileJournalStorage(f.native);
  expect((await cold.keys()).sort()).toEqual([key, otherKey].sort());
  expect(await cold.getItem(key)).toContain('first partition'); expect(await cold.getItem(otherKey)).toContain('second partition');
});
test('native journal injects into production core: hydrate, durable save/Discard and failed native transaction cannot send Host POST', async () => {
  const f = fixture(), storage = createDesktopFileJournalStorage(f.native);
  let journal: ReturnType<typeof createDesktopEditorJournal>, wire = 'base', posts = 0;
  const model = createDesktopEditors({ onChange: doc => journal?.queue(doc), persist: (doc, next) => journal.checkpoint(doc, next) });
  journal = createDesktopEditorJournal(storage, model); await journal.ready;
  const doc = model.acquire(scope, 'source.ts')!.document;
  const op: DesktopEditorOperation = { scope, current: () => true, request: async (route, method, body) => {
    if (route.includes('/stat?')) return { path: '/workspace/source.ts', isFile: true, size: wire.length, mtimeMs: 1, isBinary: false, mimeType: 'text/plain' };
    if (route.includes('/read?')) return wire;
    if (method === 'POST') { posts++; wire = (body as { content: string }).content; return { success: true, path: '/workspace/source.ts' }; }
    throw new Error('unexpected');
  } };
  await model.load(doc, op); model.edit(doc, 'durable save'); expect(await model.save(doc, op)).toBe(true); expect(posts).toBe(1);
  model.edit(doc, 'discard me'); expect(await model.discard(doc)).toBe(true); expect(doc.state().text).toBe('durable save');
  model.edit(doc, 'keep failure'); f.rejected(true); expect(await model.save(doc, op)).toBe(false);
  expect(doc.state().text).toBe('keep failure'); expect(posts).toBe(1); journal.stop();
});
