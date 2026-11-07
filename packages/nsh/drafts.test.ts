import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  untracked: <T>(work: () => T) => work(),
  Storage: { getItem: storage.get, setItem: storage.set },
}));
const target = { kind: 'session' as const, id: 'session', title: 'Test', directory: '/workspace' };
type Store = ReturnType<(typeof import('./drafts'))['openDraft']>;
let directory: string, stores: Store[];
const pathFor = (key: string) => join(directory, Buffer.from(key).toString('base64url') + '.json');
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); stores = [];
  directory = await mkdtemp(join(tmpdir(), 'nsh-draft-storage-'));
  storage.get.mockReset().mockImplementation(async (key: string) => { try { return await readFile(pathFor(key), 'utf8'); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return null; throw failure; } });
  storage.set.mockReset().mockImplementation(async (key: string, value: string) => { await writeFile(pathFor(key), value); });
});
afterEach(async () => { await Promise.allSettled(stores.map(store => store.close())); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });
async function open(host = 'host', chat = target) { const { openDraft } = await import('./drafts'); const store = openDraft(host, chat); stores.push(store); return store; }

describe('native durable draft storage boundary', () => {
  it('coalesces 200 input events without synchronous Storage calls or transcript work', async () => {
    const store = await open(); await store.ready; storage.get.mockClear(); storage.set.mockClear();
    for (let count = 0; count < 200; count++) store.draft.set(`input ${count}`);
    expect(storage.get).not.toHaveBeenCalled(); expect(storage.set).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300); await store.flush();
    expect(storage.set).toHaveBeenCalledTimes(1);
    expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).draft).toBe('input 199');
  });
  it('reopens after module/process-state reset from disk, including original and compiled pending payloads', async () => {
    const first = await open(); await first.ready;
    const file = { uri: 'attachment://one', name: 'note.txt', mime: 'text/plain' };
    first.draft.set('/explore original'); first.attachments.set([file]);
    first.pendingSend.set({ id: 'msg_stable', text: '/explore original', files: [file], delivery: 'queue', uncertain: true,
      preparedText: 'visible\ninstructions', compiled: { text: 'visible\ninstructions', files: [{ uri: file.uri, name: file.name }], agents: [{ name: 'explore' }], skills: [{ id: 'review' }], metadata: { diagnostic: true } } });
    await first.flush(); await first.close();
    vi.resetModules();
    const second = await open(); await second.ready;
    expect(second.draft()).toBe('/explore original'); expect(second.attachments()).toEqual([file]);
    expect(second.pendingSend()).toMatchObject({ id: 'msg_stable', text: '/explore original', delivery: 'queue', uncertain: true, preparedText: 'visible\ninstructions', compiled: { text: 'visible\ninstructions', agents: [{ name: 'explore' }], skills: [{ id: 'review' }], metadata: { diagnostic: true } } });
  });
  it('partitions actual persisted bytes by Host, directory, target kind and identity', async () => {
    const first = await open(); await first.ready; first.draft.set('private to scope'); await first.flush();
    for (const [host, chat] of [['other-host', target], ['host', { ...target, directory: '/other' }], ['host', { ...target, kind: 'assistant' }], ['host', { ...target, id: 'other-id' }]] as const) {
      const other = await open(host, chat as typeof target); await other.ready;
      expect(other.key).not.toBe(first.key); expect(other.draft()).toBe('');
    }
  });
  it('field-level restore CAS preserves newly typed text while still recovering an unknown send', async () => {
    const first = await open(); await first.ready; first.draft.set('saved');
    first.pendingSend.set({ id: 'msg_old', text: 'saved', files: [], delivery: 'steer', uncertain: true }); await first.flush(); await first.close();
    vi.resetModules();
    const read = storage.get.getMockImplementation()!;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    storage.get.mockImplementationOnce(async (key: string) => { const value = await read(key); await gate; return value; });
    const second = await open(); second.draft.set('new input before restore'); release(); await second.ready;
    expect(second.draft()).toBe('new input before restore'); expect(second.pendingSend()?.id).toBe('msg_old');
    await second.flush(); vi.resetModules(); const third = await open(); await third.ready;
    expect(third.draft()).toBe('new input before restore'); expect(third.pendingSend()?.id).toBe('msg_old');
  });
  it('serializes takeover and rejects old-page late flushes without overwriting the newest draft', async () => {
    const first = await open(); await first.ready; first.draft.set('leaving page');
    const second = await open(); await second.ready; expect(second.draft()).toBe('leaving page');
    first.draft.set('stale completion'); second.draft.set('new page');
    await first.flush(); await second.flush();
    vi.resetModules(); const third = await open(); await third.ready; expect(third.draft()).toBe('new page');
  });
  it('keeps malformed prior records and current input after failed restoration', async () => {
    const { draftKey } = await import('./drafts'); const key = draftKey('host', target);
    await writeFile(pathFor(key), '{broken'); const store = await open(); store.draft.set('new user work');
    await expect(store.ready).rejects.toThrow(); await expect(store.flush()).rejects.toThrow();
    expect(store.draft()).toBe('new user work'); expect(store.status()).toBe('error');
    expect(await readFile(pathFor(key), 'utf8')).toBe('{broken');
  });
  it('round-trips reference documents and captured pending references using the existing version 1 record', async () => {
    const first = await open(); await first.ready;
    first.setDraftText('Read '); first.insertReference({ kind: 'file', value: 'src/a b.ts', label: 'src/a b.ts' });
    first.insertReference({ kind: 'skill', value: 'real-id', label: 'Review' });
    const captured = first.document();
    first.pendingSend.set({ id: 'msg_refs', text: captured.text, files: [], delivery: 'steer', uncertain: false, references: captured });
    await first.flush(); await first.close();
    const raw = JSON.parse(await readFile(pathFor(first.key), 'utf8'));
    expect(raw.version).toBe(1); expect(raw.references).toHaveLength(2);
    vi.resetModules(); const second = await open(); await second.ready;
    expect(second.document()).toEqual(captured); expect(second.pendingSend()?.references).toEqual(captured);
  });
  it('old version 1 records default references to empty without inventing semantics from @ text', async () => {
    const { draftKey } = await import('./drafts'); const key = draftKey('host', target);
    await writeFile(pathFor(key), JSON.stringify({ version: 1, revision: 1, draft: '@review @src/a.ts', attachments: [], pendingSend: { id: 'old', text: '@review @src/a.ts', files: [], delivery: 'queue', uncertain: true }, queueEdit: null }));
    const store = await open(); await store.ready;
    expect(store.references()).toEqual([]); expect(store.pendingSend()?.references).toBeUndefined();
    store.setDraftText(`${store.draft()} `); await store.flush();
    expect(JSON.parse(await readFile(pathFor(key), 'utf8')).references).toEqual([]);
  });
  it('restores text and references as a unit while independently recovering pending-send fields', async () => {
    const first = await open(); await first.ready;
    first.insertReference({ kind: 'skill', value: 'saved', label: 'Saved' });
    const saved = first.document(); first.pendingSend.set({ id: 'pending', text: saved.text, files: [], delivery: 'steer', uncertain: true, references: saved });
    await first.flush(); await first.close(); vi.resetModules();
    const read = storage.get.getMockImplementation()!;
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    storage.get.mockImplementationOnce(async (key: string) => { const value = await read(key); await gate; return value; });
    const second = await open(); second.setDraftText('New '); second.insertReference({ kind: 'agent', value: 'new', label: 'New' });
    const edited = second.document(); release(); await second.ready;
    expect(second.document()).toEqual(edited); expect(second.pendingSend()?.references).toEqual(saved);
    await second.flush(); vi.resetModules(); const third = await open(); await third.ready;
    expect(third.document()).toEqual(edited); expect(third.pendingSend()?.references).toEqual(saved);
  });
  it('legacy draft.set and atomic document replacement rebase references without synchronous storage work', async () => {
    const store = await open(); await store.ready;
    store.insertReference({ kind: 'skill', value: 'one', label: 'Same' }); const original = store.document();
    storage.get.mockClear(); storage.set.mockClear();
    store.draft.set(`Please ${store.draft()}`);
    expect(store.references()[0].start).toBe(original.references[0].start + 7);
    const revision = store.draftRevision(), current = store.document();
    store.insertReference({ kind: 'skill', value: 'two', label: 'Same' }, current.references[0].start, current.references[0].end);
    expect(store.document().text).toBe(current.text); expect(store.references()[0].value).toBe('two'); expect(store.draftRevision()).toBeGreaterThan(revision);
    expect(storage.get).not.toHaveBeenCalled(); expect(storage.set).not.toHaveBeenCalled();
    store.setDraftText(store.draft().replace('@Same', '@different'));
    expect(store.references()).toEqual([]);
  });
  it('rejects cross-Host/draft/directory documents and keeps malformed saved reference bytes intact', async () => {
    const store = await open(); await store.ready; store.insertReference({ kind: 'skill', value: 'review', label: 'Review' });
    const doc = store.document();
    for (const scope of [{ ...doc.scope, host: 'other' }, { ...doc.scope, draft: 'other' }, { ...doc.scope, directory: '/other' }]) expect(() => store.setDocument({ ...doc, scope })).toThrow('scope-mismatch');
    expect(store.document()).toEqual(doc);
    await store.flush(); await store.close();
    const raw = JSON.parse(await readFile(pathFor(store.key), 'utf8')); raw.references[0].end++;
    const invalid = JSON.stringify(raw); await writeFile(pathFor(store.key), invalid); vi.resetModules();
    const second = await open(); second.setDraftText('Keep new input'); await expect(second.ready).rejects.toThrow();
    await expect(second.flush()).rejects.toThrow(); expect(second.draft()).toBe('Keep new input');
    expect(await readFile(pathFor(store.key), 'utf8')).toBe(invalid);
  });
  it('rejects forged captured pending scope and whitelists reference metadata on persistence', async () => {
    const store = await open(); await store.ready;
    store.insertReference({ kind: 'skill', value: 'review', label: 'Review', token: 'must-not-persist' } as never);
    await store.flush(); expect(await readFile(pathFor(store.key), 'utf8')).not.toContain('must-not-persist');
    const doc = store.document();
    store.pendingSend.set({ id: 'forged', text: doc.text, files: [], delivery: 'steer', uncertain: false, references: { ...doc, scope: { ...doc.scope, host: 'other' } } });
    await expect(store.flush()).rejects.toThrow('reference scope');
    expect(store.references()).toHaveLength(1);
  });
  it('reports quota/write failure without clearing input and retries the same record safely', async () => {
    const store = await open(); await store.ready; store.draft.set('not lost');
    storage.set.mockRejectedValueOnce(new Error('ERR_NSH_QUOTA_EXCEEDED'));
    await expect(store.flush()).rejects.toThrow('ERR_NSH_QUOTA_EXCEEDED');
    expect(store.draft()).toBe('not lost'); expect(store.error()).not.toBe('');
    await store.retry(); expect(store.status()).toBe('ready');
    expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).draft).toBe('not lost');
  });
  it('retries failed hydration without erasing text typed while storage was unavailable', async () => {
    storage.get.mockRejectedValueOnce(new Error('read unavailable'));
    const store = await open(); store.draft.set('still typing');
    await expect(store.ready).rejects.toThrow();
    expect(store.status()).toBe('error');
    await store.retry();
    expect(store.status()).toBe('ready'); expect(store.draft()).toBe('still typing');
    expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).draft).toBe('still typing');
  });
  it('whitelists attachment metadata and blocks credentials/native file bodies in compiled persistence', async () => {
    const store = await open(); await store.ready;
    store.attachments.set([{ uri: 'attachment://one', name: 'a', mime: 'text/plain', token: 'must-not-be-stored' } as never]);
    await store.flush(); expect(await readFile(pathFor(store.key), 'utf8')).not.toContain('must-not-be-stored');
    store.pendingSend.set({ id: 'msg', text: 'test', files: [], uncertain: true, delivery: 'steer', compiled: { text: 'test', metadata: { clientToken: 'must-not-be-stored' } } });
    await expect(store.flush()).rejects.toThrow('凭据');
    expect(await readFile(pathFor(store.key), 'utf8')).not.toContain('must-not-be-stored');
  });
});
