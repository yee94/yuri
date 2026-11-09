import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
const preferenceEffects = vi.hoisted(() => [] as Array<() => void>);
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  untracked: <T>(work: () => T) => work(),
  effect: (work: () => void) => { preferenceEffects.push(work); work(); },
  Storage: { getItem: storage.get, setItem: storage.set },
}));
const target = { kind: 'session' as const, id: 'session', title: 'Test', directory: '/workspace' };
type Store = ReturnType<(typeof import('./drafts'))['openDraft']>;
let directory: string, stores: Store[];
const pathFor = (key: string) => join(directory, Buffer.from(key).toString('base64url') + '.json');
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); stores = [];
  preferenceEffects.length = 0;
  directory = await mkdtemp(join(tmpdir(), 'nsh-draft-storage-'));
  storage.get.mockReset().mockImplementation(async (key: string) => { try { return await readFile(pathFor(key), 'utf8'); } catch (failure) { if ((failure as NodeJS.ErrnoException).code === 'ENOENT') return null; throw failure; } });
  storage.set.mockReset().mockImplementation(async (key: string, value: string) => { await writeFile(pathFor(key), value); });
});
afterEach(async () => { await Promise.allSettled(stores.map(store => store.close())); vi.useRealTimers(); await rm(directory, { recursive: true, force: true }); });
async function open(host = 'host', chat = target) { const { openDraft } = await import('./drafts'); const store = openDraft(host, chat); stores.push(store); return store; }

describe('native durable draft storage boundary', () => {
  it('round-trips canonical contact descriptors in attachments and the exact unknown submission without local-file conversion', async () => {
    const { assistantAttachmentURI } = await import('./assistant-attachment-model');
    const contactTarget = { ...target, kind: 'assistant' as const, id: 'bot' };
    const contact = { type: 'file' as const, assistantID: 'bot', attachmentID: 'uploaded', sha256: 'a'.repeat(64), size: 17, mime: 'text/plain', filename: 'note.txt' };
    const file = { uri: assistantAttachmentURI('bot', 'uploaded'), name: 'note.txt', mime: contact.mime, contact };
    const { openDraft, sameAttachment } = await import('./drafts');
    const first = openDraft('host', contactTarget); stores.push(first); await first.ready;
    first.attachments.set([file]); first.pendingSend.set({ id: 'contact-input', text: '', files: [file], delivery: 'steer', uncertain: true });
    await first.flush(); await first.close(); vi.resetModules();
    const second = (await import('./drafts')).openDraft('host', contactTarget); stores.push(second); await second.ready;
    expect(second.attachments()).toEqual([file]); expect(second.pendingSend()?.files).toEqual([file]);
    expect(sameAttachment(file, { ...file, contact: { ...contact, sha256: 'b'.repeat(64) } })).toBe(false);
    expect(await readFile(pathFor(first.key), 'utf8')).not.toContain('file://');
  });
  it.each(['sha256', 'uri', 'mime'] as const)('rejects malformed contact %s on flush without erasing the prior draft', async field => {
    const store = await open(); await store.ready; store.draft.set('Keep prior'); await store.flush();
    const before = await readFile(pathFor(store.key), 'utf8');
    const contact = { type: 'file' as const, assistantID: 'bot', attachmentID: 'uploaded', sha256: field === 'sha256' ? 'bad' : 'a'.repeat(64), size: 17, mime: 'text/plain' };
    store.attachments.set([{ uri: field === 'uri' ? 'file:///not-uploaded' : '/api/yuri/assistants/bot/contact/attachments/uploaded', name: 'note.txt', mime: field === 'mime' ? 'image/png' : 'text/plain', contact }]);
    await expect(store.flush()).rejects.toThrow('attachment_invalid_receipt');
    expect(await readFile(pathFor(store.key), 'utf8')).toBe(before);
    expect(store.draft()).toBe('Keep prior');
  });
  it('contact descriptors and compiled pending snapshots roundtrip with exact host/assistant ownership', async () => {
    const { openDraft } = await import('./drafts');
    const { pickedAttachmentFrom } = await import('./attachments');
    const bot = { kind: 'assistant' as const, id: 'bot', title: 'Bot', directory: '' };
    const file = pickedAttachmentFrom({ type: 'file', attachmentID: 'att_image', sha256: 'a'.repeat(64), size: 12, mime: 'image/png', filename: 'a.png' }, { hostID: 'host', target: bot });
    const first = openDraft('host', bot); stores.push(first); await first.ready;
    first.draft.set('inspect'); first.attachments.set([file]);
    first.pendingSend.set({ id: 'pending', text: 'inspect', files: [file], delivery: 'steer', uncertain: true, compiled: { text: 'inspect', files: [file] }, references: first.document() });
    await first.close();
    const restored = openDraft('host', bot); stores.push(restored); await restored.ready;
    expect(restored.attachments()).toEqual([file]); expect(restored.pendingSend()?.compiled?.files).toEqual([file]);
    restored.draft.set('newer edit'); restored.attachments.set([{ ...file, attachmentID: 'att_new' }]);
    expect(restored.matches('inspect', [file])).toBe(false); await restored.flush();
    const other = openDraft('host', { ...bot, id: 'other' }); stores.push(other); await other.ready; expect(other.attachments()).toEqual([]);
    const host = openDraft('other-host', bot); stores.push(host); await host.ready; expect(host.attachments()).toEqual([]);
    const saved = JSON.parse(await readFile(pathFor(restored.key), 'utf8')); saved.attachments[0].assistantID = 'other';
    await writeFile(pathFor(restored.key), JSON.stringify(saved));
    const invalid = openDraft('host', bot); stores.push(invalid); await expect(invalid.ready).rejects.toThrow('owner_mismatch');
    expect(invalid.status()).toBe('error'); invalid.draft.set('keep input');
    await expect(invalid.flush()).rejects.toThrow(); expect(invalid.draft()).toBe('keep input');
  });
  it('malformed contact-like legacy draft is not reinterpreted as valid session URI', async () => {
    const first = await open(); await first.ready; first.draft.set('saved'); first.attachments.set([{ uri: 'file:///host/a', name: 'a', mime: 'text/plain' }]); await first.close();
    const raw = JSON.parse(await readFile(pathFor(first.key), 'utf8')); raw.attachments[0].attachmentID = 'att_smuggled';
    const original = JSON.stringify(raw); await writeFile(pathFor(first.key), original);
    const next = await open(); await expect(next.ready).rejects.toThrow('invalid_session_attachment');
    await expect(next.flush()).rejects.toThrow(); expect(await readFile(pathFor(first.key), 'utf8')).toBe(original);
  });
  async function policyStore(getter: () => boolean | null, host = 'host') {
    const { openDraft } = await import('./drafts'); const store = openDraft(host, target, { persistChatDraft: getter }); stores.push(store); await store.ready; return store;
  }
  it('live getter publishes policy changes through the existing debounced lane without editor input or explicit flush', async () => {
    let enabled = false; const store = await policyStore(() => enabled);
    store.draft.set('current content'); await store.flush();
    enabled = true; preferenceEffects.forEach(effect => effect()); await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).draft).toBe('current content'));
    enabled = false; preferenceEffects.forEach(effect => effect()); await vi.advanceTimersByTimeAsync(300);
    await vi.waitFor(async () => expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).draft).toBe('')); expect(store.draft()).toBe('current content');
    await store.close(); storage.set.mockClear(); enabled = true; preferenceEffects.forEach(effect => effect()); await vi.advanceTimersByTimeAsync(300);
    expect(storage.set).not.toHaveBeenCalled();
  });
  it('disabled persistence suppresses ordinary restore/write but keeps operations and attachment references across restart', async () => {
    const first = await open(); await first.ready;
    first.insertReference({ kind: 'skill', value: 'review', label: 'Review' });
    const document = first.document(), file = { uri: 'attachment://one', name: 'a', mime: 'text/plain' };
    first.attachments.set([file]);
    first.pendingSend.set({ id: 'pending', text: document.text, references: document, files: [file], delivery: 'queue', uncertain: true });
    first.queueEdit.set({ id: 'editing', text: 'queued text', files: [file] });
    await first.close(); vi.resetModules();
    const second = await policyStore(() => false);
    expect(second.draft()).toBe(''); expect(second.references()).toEqual([]);
    second.draft.set('memory only'); await second.flush();
    const saved = JSON.parse(await readFile(pathFor(second.key), 'utf8'));
    expect(saved.draft).toBe(''); expect(saved.pendingSend.references).toEqual(document); expect(saved.attachments).toEqual([file]); expect(saved.queueEdit.id).toBe('editing');
    storage.set.mockClear();
    for (let i = 0; i < 200; i++) second.draft.set(`memory ${i}`);
    await vi.advanceTimersByTimeAsync(300); await second.flush(); expect(storage.set).not.toHaveBeenCalled(); expect(second.draft()).toBe('memory 199');
    await second.close(); vi.resetModules(); const third = await policyStore(() => false);
    expect(third.draft()).toBe(''); expect(third.pendingSend()?.id).toBe('pending'); expect(third.queueEdit()?.id).toBe('editing'); expect(third.attachments()).toEqual([file]);
  });
  it.each([true, false])('unknown authority preserves old bytes and edited input before resolving %s', async enabled => {
    const first = await open(); await first.ready; first.draft.set('old durable'); await first.close(); vi.resetModules();
    let policy: boolean | null = null; const store = await policyStore(() => policy);
    expect(store.draft()).toBe(''); store.draft.set('current memory'); await store.flush();
    expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).draft).toBe('old durable');
    policy = enabled; await store.flush(); expect(store.draft()).toBe('current memory');
    expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).draft).toBe(enabled ? 'current memory' : '');
    policy = true; await store.flush(); await store.close(); vi.resetModules();
    const reopened = await policyStore(() => true); expect(reopened.draft()).toBe('current memory');
    const other = await policyStore(() => true, 'another-host'); expect(other.draft()).toBe('');
  });
  it('unknown to true restores untouched ordinary data; false to true uses current content instead', async () => {
    const first = await open(); await first.ready; first.draft.set('old durable'); await first.close(); vi.resetModules();
    let policy: boolean | null = null; const store = await policyStore(() => policy);
    policy = true; await store.flush(); expect(store.draft()).toBe('old durable');
    policy = false; await store.flush(); expect(store.draft()).toBe('old durable');
    store.draft.set('replacement'); policy = true; await store.flush();
    expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).draft).toBe('replacement');
  });
  it('disabled cleanup write failure is explicit and retries CAS without losing pending data or memory', async () => {
    const first = await open(); await first.ready; first.draft.set('saved'); await first.close(); vi.resetModules();
    const store = await policyStore(() => false); store.draft.set('current');
    storage.set.mockRejectedValueOnce(new Error('quota'));
    await expect(store.flush()).rejects.toThrow('quota'); expect(store.status()).toBe('error');
    expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).draft).toBe('saved'); expect(store.draft()).toBe('current');
    await store.retry(); expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).draft).toBe(''); expect(store.draft()).toBe('current');
    const raw = JSON.parse(await readFile(pathFor(store.key), 'utf8')); raw.revision++;
    await writeFile(pathFor(store.key), JSON.stringify(raw)); store.pendingSend.set({ id: 'stable', text: 'operation', files: [], delivery: 'steer', uncertain: true });
    await expect(store.flush()).rejects.toThrow('另一页面'); expect(store.pendingSend()?.id).toBe('stable');
    await store.restore(); await store.retry(); expect(JSON.parse(await readFile(pathFor(store.key), 'utf8')).pendingSend.id).toBe('stable');
  });
  it('disabled persistence never overwrites corrupt storage', async () => {
    const { draftKey, openDraft } = await import('./drafts'); const key = draftKey('host', target);
    await writeFile(pathFor(key), '{broken'); const store = openDraft('host', target, { persistChatDraft: () => false }); stores.push(store);
    store.draft.set('memory'); await expect(store.ready).rejects.toThrow(); await expect(store.flush()).rejects.toThrow();
    expect(await readFile(pathFor(key), 'utf8')).toBe('{broken'); expect(store.draft()).toBe('memory');
  });
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
  it('round-trips the explicit preserving policy and captured selection without consuming the source sidecars', async () => {
    const first = await open(); await first.ready; first.setDraftText('/explore '); first.insertReference({ kind: 'skill', value: 'keep', label: 'Keep' });
    const document = first.document(), file = { uri: 'attachment://keep', name: 'keep', mime: 'text/plain' }; first.attachments.set([file]);
    first.pendingSend.set({ id: 'magic', text: document.text, files: [], delivery: 'steer', inputMode: 'normal', uncertain: true, references: { text: document.text, references: [], scope: first.scope }, compiled: { text: 'compiled', files: [] },
      localMagic: { version: 1, command: 'explore', resourcePolicy: 'preserve', selection: { model: { providerID: 'p', modelID: 'm', variant: '' }, agent: 'build' } } });
    await first.close(); vi.resetModules(); const second = await open(); await second.ready;
    expect(second.document()).toEqual(document); expect(second.attachments()).toEqual([file]);
    expect(second.pendingSend()?.localMagic).toEqual({ version: 1, command: 'explore', resourcePolicy: 'preserve', selection: { model: { providerID: 'p', modelID: 'm', variant: '' }, agent: 'build' } });
  });
  it('malformed preserving markers fail closed without stripping the policy or overwriting saved bytes', async () => {
    const { draftKey } = await import('./drafts'), key = draftKey('host', target);
    const raw = JSON.stringify({ version: 1, revision: 1, draft: '/explore', references: [], attachments: [], queueEdit: null,
      pendingSend: { id: 'magic', text: '/explore', files: [], delivery: 'queue', uncertain: true, inputMode: 'normal', compiled: { text: 'compiled', files: [] }, localMagic: { version: 1, resourcePolicy: 'preserve', command: 'explore', selection: {} } } });
    await writeFile(pathFor(key), raw); const store = await open(); await expect(store.ready).rejects.toThrow('local-magic-invalid-journal');
    store.setDraftText('new'); await expect(store.flush()).rejects.toThrow(); expect(await readFile(pathFor(key), 'utf8')).toBe(raw);
  });
  it('round-trips unknown compact in the original v1 pending journal while preserving the independent authored document', async () => {
    const first = await open(); await first.ready; first.setDraftText('authored input'); first.insertReference({ kind: 'skill', value: 'keep', label: 'Keep' }); const document = first.document();
    first.attachments.set([{ uri: 'attachment://keep', name: 'keep', mime: 'text/plain' }]);
    first.pendingSend.set({ id: 'compact-stable', text: '', files: [], delivery: 'steer', uncertain: true, inputMode: 'normal', references: { text: '', references: [], scope: first.scope }, localCompact: { version: 1, resourcePolicy: 'preserve' } });
    await first.close(); vi.resetModules(); const second = await open(); await second.ready;
    expect(second.document()).toEqual(document); expect(second.attachments()).toHaveLength(1); expect(second.pendingSend()).toMatchObject({ id: 'compact-stable', uncertain: true, localCompact: { version: 1, resourcePolicy: 'preserve' } });
  });
  it('rejects malformed compact journals rather than dropping their discriminator and replaying as a prompt', async () => {
    const store = await open(); await store.ready; store.setDraftText('keep'); await store.flush(); const before = await readFile(pathFor(store.key), 'utf8');
    store.pendingSend.set({ id: 'bad-compact', text: '', files: [], delivery: 'steer', uncertain: true, inputMode: 'normal', compiled: { text: 'must not replay', files: [] }, localCompact: { version: 1, resourcePolicy: 'preserve' } });
    await expect(store.flush()).rejects.toThrow('local-compact-invalid-journal'); expect(await readFile(pathFor(store.key), 'utf8')).toBe(before);
  });
});
