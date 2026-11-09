import { expect, test } from 'vitest';
import { createDesktopFileOperationJournal } from './desktop-files-operation-journal';
import { createDesktopFileOperations } from './desktop-files-operations';
import { createDesktopEditors, type DesktopEditorOperation } from './desktop-files-editor-model';
import { validateDesktopJournalSnapshot, type DesktopJournalStorage } from './desktop-files-journal';
import type { DesktopPanelScope } from './desktop-panel-model';

const scope: DesktopPanelScope = { host: { hostID: 'synthetic', lease: 'private-lease' }, authorityKey: 'synthetic-authority', sessionID: 'session', directory: '/workspace' };
function fixture() {
  const data = new Map<string, string>(); let fail = false, posts = 0, unknown = false;
  const paths = new Set(['/workspace/source.ts']);
  const storage: DesktopJournalStorage = {
    keys: async () => [...data.keys()], getItem: async key => data.get(key) ?? null,
    setItem: async (key, raw) => { if (fail) throw new Error('disk_failed'); const next = Object.fromEntries(data); next[key] = raw; validateDesktopJournalSnapshot(next); data.set(key, raw); },
    removeItem: async key => { if (fail) throw new Error('disk_failed'); data.delete(key); }, sync: async () => { if (fail) throw new Error('disk_failed'); },
  };
  const op: DesktopEditorOperation = { scope, current: () => true, request: async (route, method = 'GET', body) => {
    if (method === 'POST') { posts++; if (unknown) throw new Error('transport_unknown'); paths.delete((body as { path: string }).path); return { success: true, path: (body as { path: string }).path }; }
    const path = new URL('https://synthetic.invalid' + route).searchParams.get('path')!;
    if (!paths.has(path)) throw Object.assign(new Error('missing'), { status: 404 });
    return { path, isFile: true, isDirectory: false };
  } };
  return { data, storage, op, posts: () => posts, fail(value: boolean) { fail = value; }, unknown(value: boolean) { unknown = value; } };
}
test('mutation intents reach a durable checkpoint before POST and cold restore is read-only, retaining both rename fences', async () => {
  const f = fixture(), journal = createDesktopFileOperationJournal(f.storage, () => {}); await journal.ready; f.unknown(true);
  const first = createDesktopFileOperations(scope, { guard: async () => () => true, confirmed() {}, persistence: journal.bind(scope) });
  expect(await first.run({ kind: 'rename', path: '/workspace/source.ts', name: 'target.ts' }, f.op)).toBe(false);
  expect(f.posts()).toBe(1); expect(f.data.size).toBe(1); expect([...f.data.values()][0]).not.toContain(scope.host.lease);
  const cold = createDesktopFileOperationJournal(f.storage, () => {}); await cold.ready;
  const locked = new Set<string>();
  const next = createDesktopFileOperations(scope, { guard: async () => () => true, confirmed() {}, persistence: cold.bind(scope), restoreLock(path) { locked.add(path); return () => { locked.delete(path); }; } });
  const record = cold.records()[0]; expect(next.restore(record.command, record.phase)).toBe(true);
  expect(locked).toEqual(new Set(['/workspace/source.ts', '/workspace/target.ts']));
  await next.inspect(f.op); expect(f.posts()).toBe(1); expect(next.protected()).toBe(true);
  expect(await next.run({ kind: 'delete', path: '/workspace/source.ts' }, f.op)).toBe(false); expect(f.posts()).toBe(1);
});
test('failed preparation never POSTs; explicit inspect can clear a proven-not-dispatched intent without replay', async () => {
  const f = fixture(), journal = createDesktopFileOperationJournal(f.storage, () => {}); await journal.ready; f.fail(true);
  const owner = createDesktopFileOperations(scope, { guard: async () => () => true, confirmed() {}, persistence: journal.bind(scope) });
  expect(await owner.run({ kind: 'delete', path: '/workspace/source.ts' }, f.op)).toBe(false); expect(f.posts()).toBe(0); expect(owner.protected()).toBe(true);
  f.fail(false); expect(await owner.inspect(f.op)).toBe(true); expect(owner.protected()).toBe(false); expect(f.posts()).toBe(0); expect(f.data.size).toBe(0);
});
test('restored path fences block Editor writes in every session while preserving recovered drafts', async () => {
  const model = createDesktopEditors();
  const release = model.beginMutation(scope, '/workspace/source.ts', true)!;
  const doc = model.acquire({ ...scope, sessionID: 'another' }, 'source.ts')!.document;
  expect(await model.load(doc, { ...fixture().op, scope: { ...scope, sessionID: 'another' } })).toBe(false);
  expect(model.beginMutation(scope, '/workspace/source.ts')).toBeNull(); release();
});
test('an acknowledged mutation with failed journal cleanup resumes only cleanup, never Host POST or duplicate invalidation', async () => {
  const f = fixture(), journal = createDesktopFileOperationJournal(f.storage, () => {}); await journal.ready;
  let invalidations = 0;
  const op: DesktopEditorOperation = { ...f.op, request: async (path, method, body) => { const value = await f.op.request(path, method, body); if (method === 'POST') f.fail(true); return value; } };
  const owner = createDesktopFileOperations(scope, { guard: async () => () => true, confirmed() { invalidations++; }, persistence: journal.bind(scope) });
  expect(await owner.run({ kind: 'delete', path: '/workspace/source.ts' }, op)).toBe(false); expect(owner.protected()).toBe(true);
  expect(f.posts()).toBe(1); expect(invalidations).toBe(1);
  f.fail(false); expect(await owner.inspect(f.op)).toBe(true);
  expect(owner.protected()).toBe(false); expect(f.posts()).toBe(1); expect(invalidations).toBe(1); expect(f.data.size).toBe(0);
});
test('strict mutation records reject credentials and arbitrary source metadata, combined capacity is enforced by native snapshot validator', async () => {
  const f = fixture(), journal = createDesktopFileOperationJournal(f.storage, () => {}); await journal.ready;
  await journal.bind(scope).start({ kind: 'delete', path: '/workspace/source.ts' });
  const [key, raw] = [...f.data][0]; const v = JSON.parse(raw); v.token = 'not-allowed';
  expect(() => validateDesktopJournalSnapshot({ [key]: JSON.stringify(v) })).toThrow();
  v.token = undefined; delete v.token; v.command.path = '/outside';
  expect(() => validateDesktopJournalSnapshot({ [key]: JSON.stringify(v) })).toThrow();
});
