import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { ensureContactSchema, bumpContactGeneration } from './contact-store.js';
import {
  CONTACT_ATTACHMENT_SCHEMA_SQL, ensureContactAttachmentSchema, putContactAttachment,
  getContactAttachmentReceipt, getContactAttachmentByUploadID, retireContactAttachment,
  assertContactAttachmentReadable, materializeContactFilePart, readContactAttachmentBytes,
  toContactAttachmentDescriptor,
} from './contact-attachments.js';
import { storePromptAttachmentBytes } from '../fs/prompt-attachment-store.js';

const Database = createRequire(import.meta.url)('better-sqlite3');
const cleanups = [];
afterEach(() => { while (cleanups.length) cleanups.pop()(); });
const bytes = Buffer.from('synthetic attachment original');
const hash = createHash('sha256').update(bytes).digest('hex');
const headers = { 'x-content-size': String(bytes.length), 'x-content-sha256': hash, 'content-type': 'text/plain', 'x-attachment-filename': 'note.txt' };
const stream = () => ({ async *[Symbol.asyncIterator]() { yield bytes; } });
function fixture({ legacySchema = false } = {}) {
  const directory = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'contact-receipt-'));
  const dbPath = path.join(directory, 'attachments.sqlite');
  const db = new Database(dbPath);
  cleanups.push(() => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  ensureContactSchema(db);
  if (legacySchema) db.exec(CONTACT_ATTACHMENT_SCHEMA_SQL.replace('    retired_at INTEGER,\n', ''));
  else ensureContactAttachmentSchema(db);
  const owner = { assistantID: 'assistant_a', uploadID: 'upload_1', generation: 0 };
  const put = (extra = {}) => putContactAttachment({ db, dataDir: directory, assistantID: owner.assistantID, uploadID: owner.uploadID, expectedGeneration: 0, stream: stream(), headers, ...extra });
  const receipt = (extra = {}) => getContactAttachmentReceipt(db, { ...owner, ...extra });
  const retire = (descriptor = null, extra = {}) => retireContactAttachment(db, { ...owner, descriptor, ...extra });
  return { db, dbPath, directory, owner, put, receipt, retire };
}

describe('contact upload receipt / generation / durable retirement', () => {
  it('migrates old ownership rows in place and remains idempotent', async () => {
    const f = fixture({ legacySchema: true });
    f.db.prepare(`INSERT INTO assistant_contact_attachment VALUES ('att_old','assistant_a',0,?,?,'text/plain','note.txt','aa/old.txt','upload_old',123)`).run(hash, bytes.length);
    ensureContactAttachmentSchema(f.db);
    ensureContactAttachmentSchema(f.db);
    expect(f.receipt({ uploadID: 'upload_old' })).toMatchObject({ state: 'committed', generation: 0, descriptor: { attachmentID: 'att_old', generation: 0 } });
    expect(f.db.prepare('SELECT created_at,relative_path,retired_at FROM assistant_contact_attachment').get()).toEqual({ created_at: 123, relative_path: 'aa/old.txt', retired_at: null });
    await f.put();
  });

  it('lost ACK reconciles by exact GET only; missing receipt is not a retirement fence', async () => {
    const f = fixture();
    expect(f.receipt()).toMatchObject({ state: 'not_found', descriptor: null, currentGeneration: 0 });
    let writes = 0;
    const ack = await f.put({ storeBytes: async input => { writes++; return storePromptAttachmentBytes(input); } });
    expect(f.receipt()).toEqual({ ...f.owner, currentGeneration: 0, state: 'committed', descriptor: ack });
    expect(f.receipt().descriptor).toEqual(ack);
    expect(writes).toBe(1);
    expect(f.receipt({ assistantID: 'assistant_b' })).toMatchObject({ state: 'not_found', descriptor: null });
    expect(() => f.receipt({ generation: 1 })).toThrow(expect.objectContaining({ code: 'contact_generation_conflict' }));
    for (const generation of [undefined, null, '', '01', '-1', '1.2', true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => f.receipt({ generation })).toThrow(expect.objectContaining({ code: 'validation_error' }));
    }
  });

  it('rejects reset before dispatch without consuming bytes; legacy omitted generation binds at entry', async () => {
    const f = fixture();
    bumpContactGeneration(f.db, f.owner.assistantID);
    let reads = 0;
    await expect(f.put({ stream: { async *[Symbol.asyncIterator]() { reads++; yield bytes; } } })).rejects.toMatchObject({ code: 'contact_generation_conflict' });
    expect(reads).toBe(0);
    const legacy = await f.put({ expectedGeneration: undefined });
    expect(legacy.generation).toBe(1);
    await expect(f.put()).rejects.toMatchObject({ code: 'contact_generation_conflict' });
    await expect(f.put({ expectedGeneration: null })).rejects.toMatchObject({ code: 'validation_error' });
    await expect(f.put({ uploadID: 'modern', expectedGeneration: undefined, headers: { ...headers, accept: 'application/vnd.yuri.contact-upload+json' } })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('validates receipt-aware integrity headers without coercing arrays, booleans or unsafe sizes', async () => {
    const f = fixture();
    const modern = { ...headers, accept: 'application/vnd.yuri.contact-upload+json' };
    for (const invalid of [
      { 'x-content-size': [String(bytes.length)] }, { 'x-content-size': false }, { 'x-content-size': '' },
      { 'x-content-size': '0' }, { 'x-content-size': '01' }, { 'x-content-size': '9007199254740992' },
      { 'x-content-sha256': [hash] }, { 'x-content-sha256': false }, { 'content-type': ['text/plain'] },
      { 'x-attachment-filename': false }, { 'x-attachment-filename': '../original.txt' }, { accept: [modern.accept] },
    ]) {
      await expect(f.put({ headers: { ...modern, ...invalid } })).rejects.toMatchObject({ code: 'validation_error' });
    }
    expect(f.receipt().state).toBe('not_found');
    await expect(f.put({ headers: { ...modern, accept: 'application/json, APPLICATION/VND.YURI.CONTACT-UPLOAD+JSON; q=1' }, expectedGeneration: undefined })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it.each(['body', 'store'])('rejects reset during %s without publishing a descriptor', async phase => {
    const f = fixture();
    const extra = phase === 'body'
      ? { stream: { async *[Symbol.asyncIterator]() { yield bytes; bumpContactGeneration(f.db, f.owner.assistantID); } } }
      : { storeBytes: async input => { const stored = await storePromptAttachmentBytes(input); bumpContactGeneration(f.db, f.owner.assistantID); return stored; } };
    await expect(f.put(extra)).rejects.toMatchObject({ code: 'contact_generation_conflict' });
    expect(f.receipt()).toMatchObject({ state: 'not_found', descriptor: null });
  });

  it.each(['before', 'body', 'store'])('DELETE %s PUT commit durably prevents resurrection', async phase => {
    const f = fixture();
    let retired;
    if (phase === 'before') retired = f.retire();
    const extra = phase === 'body'
      ? { stream: { async *[Symbol.asyncIterator]() { yield bytes; retired = f.retire(); } } }
      : phase === 'store' ? { storeBytes: async input => { const stored = await storePromptAttachmentBytes(input); retired = f.retire(); return stored; } } : {};
    await expect(f.put(extra)).rejects.toMatchObject({ code: 'attachment_retired' });
    expect(retired).toMatchObject({ state: 'retired', descriptor: null, bytesDeleted: false, ownershipRetained: false, newAdmissionAllowed: false });
    expect(toContactAttachmentDescriptor(getContactAttachmentByUploadID(f.db, f.owner.assistantID, f.owner.uploadID))).toBeNull();
    const reopened = new Database(f.dbPath);
    try {
      ensureContactAttachmentSchema(reopened);
      expect(getContactAttachmentReceipt(reopened, f.owner)).toMatchObject({ state: 'retired', descriptor: null });
      await expect(putContactAttachment({ db: reopened, dataDir: f.directory, assistantID: f.owner.assistantID, uploadID: f.owner.uploadID, expectedGeneration: 0, headers, stream: stream() })).rejects.toMatchObject({ code: 'attachment_retired' });
    } finally { reopened.close(); }
  });

  it('late ACK cannot undo retirement; exact descriptor CAS isolates same-hash other uploads and originals', async () => {
    const f = fixture();
    const original = path.join(f.directory, 'original.txt'); fs.writeFileSync(original, bytes);
    const ack = await f.put();
    const other = await f.put({ uploadID: 'upload_2' });
    expect(other.attachmentID).not.toBe(ack.attachmentID);
    expect(() => f.retire(other)).toThrow(expect.objectContaining({ code: 'idempotency_conflict' }));
    expect(() => f.retire(ack, { generation: 1 })).toThrow(expect.objectContaining({ code: 'contact_generation_conflict' }));
    expect(f.receipt().state).toBe('committed');
    expect(f.retire(ack)).toMatchObject({ state: 'retired', descriptor: ack, ownershipRetained: true, bytesDeleted: false });
    expect(f.retire(ack)).toMatchObject({ state: 'retired', descriptor: ack });
    expect(() => assertContactAttachmentReadable(f.db, { assistantID: f.owner.assistantID, attachmentID: ack.attachmentID })).toThrow(expect.objectContaining({ code: 'not_found' }));
    expect(await materializeContactFilePart(f.db, f.directory, f.owner.assistantID, ack)).toMatchObject({ url: `data:text/plain;base64,${bytes.toString('base64')}` });
    const row1 = getContactAttachmentByUploadID(f.db, f.owner.assistantID, 'upload_1');
    const row2 = getContactAttachmentByUploadID(f.db, f.owner.assistantID, 'upload_2');
    expect(row2.relative_path).toBe(row1.relative_path);
    expect(fs.readFileSync(path.join(f.directory, 'prompt-attachments', row1.relative_path))).toEqual(bytes);
    expect(fs.readFileSync(original)).toEqual(bytes);
    expect((await readContactAttachmentBytes({ db: f.db, dataDir: f.directory, assistantID: f.owner.assistantID, attachmentID: other.attachmentID })).buffer).toEqual(bytes);
    expect(f.receipt({ uploadID: 'upload_2' })).toMatchObject({ state: 'committed', descriptor: other });
    await expect(f.put()).rejects.toMatchObject({ code: 'attachment_retired' });
  });

  it.each(['initial', 'body', 'store'])('same-ID %s reuse validates MIME and exact generation', async phase => {
    const f = fixture();
    const competing = () => f.put({ headers: { ...headers, 'content-type': 'application/octet-stream' } });
    let extra = {};
    if (phase === 'initial') await competing();
    if (phase === 'body') extra = { stream: { async *[Symbol.asyncIterator]() { yield bytes; await competing(); } } };
    if (phase === 'store') extra = { storeBytes: async input => { const stored = await storePromptAttachmentBytes(input); await competing(); return stored; } };
    await expect(f.put(extra)).rejects.toMatchObject({ code: 'idempotency_conflict' });
    if (f.receipt().state === 'not_found') await f.put();
    bumpContactGeneration(f.db, f.owner.assistantID);
    await expect(f.put({ expectedGeneration: 1 })).rejects.toMatchObject({ code: 'contact_generation_conflict' });
    expect(f.retire(null)).toMatchObject({ generation: 0, currentGeneration: 1, state: 'retired' });
  });

  it.each(['mime', 'generation', 'retired', 'matching'])('INSERT collision re-reads authoritative %s row without synthesizing a descriptor', async kind => {
    const f = fixture();
    const generation = kind === 'generation' ? 1 : 0;
    const mime = kind === 'mime' ? 'application/octet-stream' : 'text/plain';
    const retired = kind === 'retired' ? '123' : 'NULL';
    // A real SQLite trigger exercises collision inside the INSERT itself, after the preflight lookup.
    f.db.exec(`CREATE TRIGGER collision BEFORE INSERT ON assistant_contact_attachment
      WHEN NEW.upload_id='upload_1' AND NEW.attachment_id!='att_competing'
      BEGIN
        INSERT INTO assistant_contact_attachment(attachment_id,assistant_id,generation,sha256,size,mime,filename,relative_path,upload_id,retired_at,created_at)
        VALUES('att_competing',NEW.assistant_id,${generation},NEW.sha256,NEW.size,'${mime}',NEW.filename,'aa/existing.txt',NEW.upload_id,${retired},123);
        SELECT RAISE(FAIL, 'UNIQUE synthetic upload collision');
      END`);
    if (kind === 'matching') expect(await f.put()).toMatchObject({ attachmentID: 'att_competing', generation: 0 });
    else await expect(f.put()).rejects.toMatchObject({ code: kind === 'mime' ? 'idempotency_conflict' : kind === 'generation' ? 'contact_generation_conflict' : 'attachment_retired' });
  });

  it('failed retirement rolls back without claiming success or damaging another upload', async () => {
    const f = fixture();
    const ack = await f.put();
    f.db.exec("CREATE TRIGGER reject_retire BEFORE UPDATE OF retired_at ON assistant_contact_attachment BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END");
    expect(() => f.retire(ack)).toThrow('synthetic write failure');
    expect(f.receipt()).toMatchObject({ state: 'committed', descriptor: ack });
    expect(f.db.inTransaction).toBe(false);
    expect(() => retireContactAttachment(f.db, f.owner)).toThrow(expect.objectContaining({ code: 'validation_error' }));
  });

  it('publishes inflight before reading the body, survives restart and permits only GET or exact retirement', async () => {
    const f = fixture();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const flight = f.put({ stream: { async *[Symbol.asyncIterator]() { await gate; yield bytes; } } });
    expect(f.receipt()).toMatchObject({ state: 'inflight', descriptor: null, generation: 0, currentGeneration: 0 });
    const reader = new Database(f.dbPath);
    try { expect(getContactAttachmentReceipt(reader, f.owner).state).toBe('inflight'); }
    finally { reader.close(); }
    await expect(f.put()).rejects.toMatchObject({ code: 'attachment_upload_inflight' });
    const retired = f.retire();
    expect(retired).toMatchObject({ state: 'retired', descriptor: null, ownershipRetained: false });
    release();
    await expect(flight).rejects.toMatchObject({ code: 'attachment_retired' });
    expect(f.receipt().state).toBe('retired');
  });
});
