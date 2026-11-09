import { expect, test, vi } from 'vitest';
import { createDesktopEditorJournal, DESKTOP_JOURNAL_PREFIX, type DesktopJournalStorage } from './desktop-files-journal';
import { createDesktopEditors, type DesktopEditorOperation } from './desktop-files-editor-model';
import type { DesktopPanelScope } from './desktop-panel-model';

const scope: DesktopPanelScope = { host: { hostID: 'synthetic', lease: 'private-lease-never-stored' }, authorityKey: 'stable-synthetic-authority', sessionID: 'session', directory: '/workspace' };
function storageFixture() {
  const entries = new Map<string, string>();
  let fail = '', writes = 0;
  const storage: DesktopJournalStorage = {
    async keys() { if (fail === 'read') throw new Error('read_failed'); return [...entries.keys()]; },
    async getItem(key) { return entries.get(key) ?? null; },
    async setItem(key, value) { writes++; if (fail === 'write') throw new Error('quota_or_disk_failed'); entries.set(key, value); },
    async removeItem(key) { writes++; if (fail === 'delete') throw new Error('delete_failed'); entries.delete(key); },
    async sync() { if (fail === 'sync') throw new Error('disk_sync_failed'); },
  };
  return { entries, storage, writes: () => writes, fail(value: string) { fail = value; } };
}
async function fixture(storage: DesktopJournalStorage) {
  let journal: ReturnType<typeof createDesktopEditorJournal> | undefined;
  const model = createDesktopEditors({ onChange: document => journal?.queue(document), persist: (document, next) => journal!.checkpoint(document, next) });
  journal = createDesktopEditorJournal(storage, model);
  await journal.ready;
  let wire = 'base', posts = 0, unknown = false, statStatus = 0;
  const operation = (owner = scope): DesktopEditorOperation => ({ scope: owner, current: () => true, request: async (path, method, body) => {
    const file = new URL('https://synthetic.invalid' + path).searchParams.get('path') || (body as { path?: string } | undefined)?.path;
    if (path.startsWith('/api/fs/stat?')) { if (statStatus) throw Object.assign(new Error('stat_failed'), { status: statStatus }); return { path: file, isFile: true, size: wire.length, mtimeMs: 1, isBinary: false, mimeType: 'text/plain' }; }
    if (path.startsWith('/api/fs/read?')) return wire;
    if (path.startsWith('/api/fs/write?') && method === 'POST') { posts++; if (unknown) throw new Error('unknown_post'); wire = (body as { content: string }).content; return { success: true, path: file }; }
    throw new Error('Unexpected synthetic request');
  } });
  async function open(path = 'a.ts', owner = scope) { const document = model.acquire(owner, path)!.document; if (!document.state().loaded) await model.load(document, operation(owner)); return document; }
  return { model, journal, operation, open, posts: () => posts, unknown(value: boolean) { unknown = value; }, statStatus(value: number) { statStatus = value; }, remote(value: string) { wire = value; } };
}

test('cold restart restores only document buffers under exact authority/Host/session/directory/path, never writes Host', async () => {
  const s = storageFixture(), first = await fixture(s.storage), doc = await first.open();
  first.model.edit(doc, 'RECOVER_ME'); expect(await first.journal.flush()).toBe(true); first.journal.stop();
  expect([...s.entries.values()].join('')).not.toContain(scope.host.lease);
  expect([...s.entries.values()].join('')).not.toContain('request');
  const next = await fixture(s.storage), restored = await next.open();
  expect(restored.state()).toMatchObject({ text: 'RECOVER_ME', base: 'base', pending: null, durability: 'ready' });
  expect(next.posts()).toBe(0);
  expect(next.model.acquire({ ...scope, host: { ...scope.host, lease: 'renewed' } }, 'a.ts')!.document).toBe(restored);
  for (const other of [{ ...scope, authorityKey: 'other' }, { ...scope, directory: '/other' }, { ...scope, sessionID: 'other' }, { ...scope, host: { hostID: 'other', lease: 'other' } }]) {
    expect(next.model.acquire(other, 'a.ts')!.document.state().text).toBe('');
    expect(await next.model.save(restored, next.operation(other))).toBe(false);
  }
  expect(next.posts()).toBe(0); next.journal.stop();
});

test('restored unknown receipts keep the writer pinned and only verify GET, including failed 401/404 and old base', async () => {
  const s = storageFixture(), first = await fixture(s.storage), doc = await first.open();
  first.model.edit(doc, 'uncertain'); first.unknown(true);
  expect(await first.model.save(doc, first.operation())).toBe(false);
  expect(first.posts()).toBe(1); await first.journal.flush(); first.journal.stop();
  const next = await fixture(s.storage), restored = await next.open();
  expect(restored.state()).toMatchObject({ pending: { text: 'uncertain', wire: 'uncertain' }, error: 'unknown' });
  for (const status of [401, 404, 0]) { next.statStatus(status); expect(await next.model.save(restored, next.operation())).toBe(false); }
  expect(next.posts()).toBe(0); expect(await next.model.discard(restored)).toBe(false);
  next.remote('uncertain'); expect(await next.model.save(restored, next.operation())).toBe(true);
  expect(next.posts()).toBe(0); expect(s.entries.size).toBe(0); next.journal.stop();
});

test('checkpoint failure forbids POST, preserves prior Storage and current input, freezes automatic writes until explicit retry', async () => {
  const s = storageFixture(), f = await fixture(s.storage), doc = await f.open();
  f.model.edit(doc, 'prior'); await f.journal.flush(); const prior = [...s.entries.values()][0];
  f.model.edit(doc, 'current'); s.fail('write');
  expect(await f.model.save(doc, f.operation())).toBe(false); expect(f.posts()).toBe(0);
  expect(doc.state()).toMatchObject({ text: 'current', pending: null, durability: 'error' });
  expect([...s.entries.values()][0]).toBe(prior);
  const calls = s.writes(); s.fail(''); f.model.edit(doc, 'later'); expect(await f.journal.flush()).toBe(false);
  expect(s.writes()).toBe(calls); expect(await f.journal.retry()).toBe(true);
  expect([...s.entries.values()][0]).toContain('later'); expect(doc.state().text).toBe('later'); f.journal.stop();
});

test('failed durable Discard never clears current input or prior journal; deletion must succeed before close can become clean', async () => {
  const s = storageFixture(), f = await fixture(s.storage), doc = await f.open();
  f.model.edit(doc, 'keep'); await f.journal.flush(); const prior = [...s.entries.values()][0]; s.fail('delete');
  expect(await f.model.discard(doc)).toBe(false); expect(doc.state().text).toBe('keep'); expect([...s.entries.values()][0]).toBe(prior);
  expect(f.model.protected(doc)).toBe(true); s.fail(''); await f.journal.retry();
  expect(await f.model.discard(doc)).toBe(true); expect(doc.state().text).toBe('base'); expect(s.entries.size).toBe(0); f.journal.stop();
});

test('read failure and malformed/foreign identity records fail closed without deleting or replacing anything', async () => {
  const s = storageFixture(); s.fail('read'); const f = await fixture(s.storage);
  expect(f.journal.state().hydrated).toBe(false); expect(f.posts()).toBe(0); s.fail(''); expect(await f.journal.retry()).toBe(true); f.journal.stop();
  const valid = await fixture(s.storage), doc = await valid.open(); valid.model.edit(doc, 'draft'); await valid.journal.flush(); valid.journal.stop();
  const [key, raw] = [...s.entries][0];
  for (const mutate of [(record: Record<string, unknown>) => ({ ...record, bearer: 'not-allowed' }), (record: Record<string, unknown>) => ({ ...record, path: '/outside' }), (record: Record<string, unknown>) => ({ ...record, wire: 'inconsistent baseline' })]) {
    const invalid = JSON.stringify(mutate(JSON.parse(raw))); s.entries.set(key, invalid);
    const next = await fixture(s.storage); expect(next.journal.state().hydrated).toBe(false);
    expect(s.entries.get(key)).toBe(invalid); expect(s.writes()).toBe(1); next.journal.stop();
  }
});

test('journal capacity is independent of memory capacity; no dirty entry is evicted to make disk room', async () => {
  const s = storageFixture(), f = await fixture(s.storage);
  for (let i = 0; i < 5; i++) { const doc = await f.open(i + '.ts'); f.model.edit(doc, 'x'.repeat(900_000)); }
  expect(await f.journal.flush()).toBe(false); expect(f.journal.state().error).toBe('desktop_journal_capacity');
  expect(f.model.documents()).toHaveLength(5); expect(f.model.documents().every(doc => doc.state().text.length === 900_000)).toBe(true);
  expect(f.posts()).toBe(0); expect(f.journal.state().bytes).toBeLessThan(4 * 1024 * 1024); f.journal.stop();
});

test('foreign journal writers are detected before overwriting, and unrelated Storage keys are never scanned as documents', async () => {
  const s = storageFixture(); s.entries.set('unrelated-setting', 'kept');
  const f = await fixture(s.storage), doc = await f.open(); f.model.edit(doc, 'draft'); await f.journal.flush();
  const key = [...s.entries.keys()].find(key => key.startsWith(DESKTOP_JOURNAL_PREFIX))!;
  s.entries.set(key, 'foreign-value'); f.model.edit(doc, 'newer'); expect(await f.journal.flush()).toBe(false);
  expect(s.entries.get(key)).toBe('foreign-value'); expect(s.entries.get('unrelated-setting')).toBe('kept'); expect(doc.state().text).toBe('newer'); f.journal.stop();
});

test('NSH Storage without a real disk barrier is never treated as crash-safe admission for POST or Discard', async () => {
  const s = storageFixture(), f = await fixture({ ...s.storage, sync: undefined }), doc = await f.open();
  f.model.edit(doc, 'kept'); await f.journal.flush();
  expect(await f.model.save(doc, f.operation())).toBe(false);
  expect(f.posts()).toBe(0); expect(doc.state().text).toBe('kept');
  expect(f.journal.state().error).toBe('desktop_journal_durable_checkpoint_unavailable');
  await f.journal.retry(); expect(await f.model.discard(doc)).toBe(false); expect(doc.state().text).toBe('kept'); f.journal.stop();
});

test('50 accepted input events only replace a journal job; full serialization and Storage writes happen at flush, not per keystroke', async () => {
  const s = storageFixture(), f = await fixture(s.storage), doc = await f.open();
  const stringify = vi.spyOn(JSON, 'stringify');
  for (let i = 0; i < 50; i++) f.model.edit(doc, 'draft-' + i);
  const serializations = stringify.mock.calls.length; stringify.mockRestore();
  expect(serializations).toBe(0); expect(s.writes()).toBe(0);
  expect(await f.journal.flush()).toBe(true); expect(s.writes()).toBe(1); f.journal.stop();
});

test('a failed disk barrier never authorizes POST and failed Discard rolls the journal cache back to its prior record', async () => {
  const s = storageFixture(), f = await fixture(s.storage), doc = await f.open();
  f.model.edit(doc, 'keep-on-sync-failure'); await f.journal.flush(); const prior = [...s.entries.values()][0];
  s.fail('sync'); expect(await f.model.discard(doc)).toBe(false);
  expect(doc.state().text).toBe('keep-on-sync-failure'); expect([...s.entries.values()][0]).toBe(prior);
  expect(f.model.protected(doc)).toBe(true); expect(f.journal.state().error).toBe('desktop_journal_rollback_unconfirmed');
  expect(await f.model.save(doc, f.operation())).toBe(false); expect(f.posts()).toBe(0);
  s.fail(''); expect(await f.journal.retry()).toBe(true); expect(await f.model.discard(doc)).toBe(true); f.journal.stop();
});

test('a queued clean checkpoint cannot erase a newer buffer that an earlier flush already persisted', async () => {
  const s = storageFixture(); let pause = false, release: (() => void) | undefined;
  const f = await fixture({ ...s.storage, async getItem(key) { if (pause) { pause = false; await new Promise<void>(resolve => { release = resolve; }); } return s.storage.getItem(key); } });
  const doc = await f.open(); f.model.edit(doc, 'captured-save'); pause = true;
  const flushing = f.journal.flush(); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  const clean = { ...doc.state(), base: 'captured-save', wire: 'captured-save', text: 'captured-save', pending: null };
  const checkpoint = f.journal.checkpoint(doc, clean);
  f.model.edit(doc, 'newer accepted buffer'); release!();
  expect(await flushing).toBe(true); expect(await checkpoint).toBe(true);
  const saved = JSON.parse([...s.entries.values()][0]);
  expect(saved).toMatchObject({ text: 'newer accepted buffer', base: 'captured-save' }); f.journal.stop();
});

test('Discard freezes only its own native input until the durable deletion completes, then clears or preserves the whole prior draft', async () => {
  const s = storageFixture(); let pause = false, release: (() => void) | undefined;
  const f = await fixture({ ...s.storage, async removeItem(key) { if (pause) { pause = false; await new Promise<void>(resolve => { release = resolve; }); } await s.storage.removeItem(key); } });
  const doc = await f.open(); f.model.edit(doc, 'explicitly discarded buffer'); await f.journal.flush(); pause = true;
  const discarding = f.model.discard(doc); await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  expect(doc.state().discarding).toBe(true); expect(f.model.edit(doc, 'not accepted while read-only')).toBe(false);
  expect(doc.state().text).toBe('explicitly discarded buffer'); release!();
  expect(await discarding).toBe(true); expect(doc.state()).toMatchObject({ text: 'base', discarding: false });
  expect(f.model.protected(doc)).toBe(false); f.journal.stop();
});

test('refresh Discard cannot replace a draft without a durable checkpoint, even after successful read-only Host verification', async () => {
  const s = storageFixture(), f = await fixture({ ...s.storage, sync: undefined }), doc = await f.open();
  f.model.edit(doc, 'must survive refresh'); await f.journal.flush(); const prior = [...s.entries.values()][0];
  f.remote('new remote');
  expect(await f.model.load(doc, f.operation(), true)).toBe(false);
  expect(doc.state().text).toBe('must survive refresh'); expect([...s.entries.values()][0]).toBe(prior);
  expect(f.posts()).toBe(0); f.journal.stop();
});

test('a Storage rejection after updating its cache restores the prior record and keeps the latest input available for explicit retry', async () => {
  const s = storageFixture(); let reject = false;
  const f = await fixture({ ...s.storage, async setItem(key, value) { await s.storage.setItem(key, value); if (reject) { reject = false; throw new Error('cache_applied_before_rejection'); } } });
  const doc = await f.open(); f.model.edit(doc, 'prior draft'); await f.journal.flush(); const prior = [...s.entries.values()][0];
  f.model.edit(doc, 'latest draft'); reject = true;
  expect(await f.model.save(doc, f.operation())).toBe(false);
  expect([...s.entries.values()][0]).toBe(prior); expect(doc.state().text).toBe('latest draft'); expect(f.posts()).toBe(0);
  expect(await f.journal.retry()).toBe(true); expect([...s.entries.values()][0]).toContain('latest draft'); f.journal.stop();
});

test('a failed checkpoint never rolls back over a foreign record that appeared while the native barrier awaited', async () => {
  const s = storageFixture(); let foreign = false;
  const f = await fixture({ ...s.storage, async sync() { if (foreign) { const key = [...s.entries.keys()][0]; s.entries.set(key, 'foreign owner value'); throw new Error('disk_failed'); } } });
  const doc = await f.open(); f.model.edit(doc, 'prior draft'); await f.journal.flush();
  f.model.edit(doc, 'latest draft'); foreign = true;
  expect(await f.model.save(doc, f.operation())).toBe(false);
  expect([...s.entries.values()][0]).toBe('foreign owner value'); expect(doc.state().text).toBe('latest draft');
  expect(f.journal.state().error).toBe('desktop_journal_rollback_unconfirmed'); expect(f.posts()).toBe(0); f.journal.stop();
});
