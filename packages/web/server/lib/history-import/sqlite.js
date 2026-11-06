// Cursor editor layout adapted from Agent Connect; see AGENT_CONNECT_LICENSE.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { fail, timestamp, textOf } from './events.js';

const MAX_DB_BYTES = 1024 * 1024 * 1024;
const stamp = async (file) => {
  try { const stat = await fs.lstat(file, { bigint: true });
    if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid_source');
    if (stat.size > BigInt(MAX_DB_BYTES)) fail('source_too_large');
    return `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const json = (value) => JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : value);

// Never open the original database: even SQLite readonly opens can create SHM
// or change read marks. Copy DB + WAL, reject a changing source, then transact on
// the private snapshot. A busy/changing database is retryable, not empty success.
async function readSqliteSnapshot(file, read) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-history-'));
    let db;
    try {
      const before = await Promise.all([stamp(file), stamp(`${file}-wal`)]);
      if (!before[0]) fail('source_missing');
      const target = path.join(temporary, 'snapshot.db');
      await fs.copyFile(file, target);
      if (before[1]) await fs.copyFile(`${file}-wal`, `${target}-wal`);
      const after = await Promise.all([stamp(file), stamp(`${file}-wal`)]);
      if (JSON.stringify(before) !== JSON.stringify(after)) continue;
      db = new Database(target, { readonly: true, fileMustExist: true, timeout: 1000 });
      return db.transaction(() => read(db))();
    } finally {
      db?.close();
      await fs.rm(temporary, { recursive: true, force: true });
    }
  }
  fail('source_busy');
}

const kv = (db, key) => {
  const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key);
  return row?.value == null ? null : json(row.value);
};
const folderPath = (value) => {
  if (typeof value === 'string') { try { return value.startsWith('file:') ? fileURLToPath(value) : value; } catch { return ''; } }
  return value?.fsPath ?? value?.path ?? '';
};

async function readCursorEditorSnapshot(file, wantedID, limit, includeCount = false) {
  return readSqliteSnapshot(file, (db) => {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    if (!tables.has('cursorDiskKV')) fail('unsupported_source_version');
    const count = includeCount ? db.prepare(tables.has('composerHeaders')
      ? 'SELECT COUNT(*) AS count FROM composerHeaders'
      : "SELECT COUNT(*) AS count FROM cursorDiskKV WHERE key LIKE 'composerData:%'").get().count : undefined;
    try {
      let heads;
      if (tables.has('composerHeaders')) {
        heads = db.prepare('SELECT composerId, value FROM composerHeaders LIMIT ?').all(limit ?? 5001).map((row) => ({ ...json(row.value), composerId: row.composerId }));
      } else {
        heads = db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%' LIMIT ?").all(limit ?? 5001).map((row) => ({ ...json(row.value), composerId: row.key.slice('composerData:'.length) }));
      }
      if (heads.length > 5000) fail('too_many_sessions');
      const selected = wantedID ? heads.filter((head) => head.composerId === wantedID) : heads;
      const sessions = selected.map((head) => {
        const composer = kv(db, `composerData:${head.composerId}`);
        if (!composer) fail('source_missing');
        const headers = composer.fullConversationHeadersOnly ?? composer.conversation ?? [];
        if (!Array.isArray(headers) || headers.length > 100000) fail('invalid_source');
        const events = []; const warnings = new Set(['tools_archived', 'usage_unknown']);
        for (const header of headers) {
          const bubble = header.text != null ? header : kv(db, `bubbleId:${head.composerId}:${header.bubbleId}`);
          if (!bubble) { warnings.add('missing_records'); continue; }
          const time = timestamp(bubble.createdAt, timestamp(head.createdAt));
          const tool = bubble.toolFormerData;
          if (header.type === 1 || bubble.type === 1) {
            if (bubble.context?.selectedImages?.length || bubble.images?.length) warnings.add('attachments_omitted');
            if (bubble.text) events.push({ kind: 'user', text: bubble.text, time });
          } else if (tool) {
            events.push({ kind: 'tool', time, name: tool.name, input: tool.rawArgs ?? tool.params ?? '', output: textOf(tool.result), incomplete: tool.status !== 'completed' });
            if (tool.status !== 'completed') warnings.add('unfinished_tools');
          } else if (bubble.thinking?.text) events.push({ kind: 'thinking', text: bubble.thinking.text, time });
          else if (bubble.text) events.push({ kind: 'assistant-text', text: bubble.text, time });
        }
        return { id: head.composerId, title: head.name || composer.name || events.find((event) => event.kind === 'user')?.text?.slice(0, 100) || head.composerId,
          directory: folderPath(head.workspaceIdentifier?.uri ?? composer.workspaceIdentifier?.uri), parentID: head.parentComposerId,
          events, warnings: [...warnings] };
      }).filter((session) => session.events.length);
      return { sessions, count };
    } catch (error) {
      if (!includeCount) throw error;
      return { sessions: [], count, error };
    }
  });
}

export async function readCursorEditor(file, wantedID, limit) {
  return (await readCursorEditorSnapshot(file, wantedID, limit)).sessions;
}

export const readCursorEditorInventory = (file, limit) => readCursorEditorSnapshot(file, undefined, limit, true);

// Only the small length-delimited protobuf fields needed for the CLI's ordered
// message IDs are decoded. Unknown fields are skipped, never guessed as messages.
function lengthFields(buffer, wanted) {
  const fields = []; let offset = 0;
  const varint = () => {
    let value = 0; let multiplier = 1;
    for (let count = 0; count < 10 && offset < buffer.length; count++) {
      const byte = buffer[offset++]; value += (byte & 127) * multiplier;
      if (!Number.isSafeInteger(value)) fail('invalid_source');
      if (!(byte & 128)) return value;
      multiplier *= 128;
    }
    fail('invalid_source');
  };
  while (offset < buffer.length) {
    const tag = varint(); const wire = tag & 7; const field = Math.floor(tag / 8);
    if (wire === 0) varint();
    else if (wire === 1) offset += 8;
    else if (wire === 5) offset += 4;
    else if (wire === 2) {
      const length = varint(); const end = offset + length;
      if (end > buffer.length) fail('invalid_source');
      if (field === wanted) fields.push(buffer.subarray(offset, end));
      offset = end;
    } else fail('unsupported_source_version');
    if (offset > buffer.length) fail('invalid_source');
  }
  return fields;
}

export async function readCursorCli(file) {
  let sidecar = {};
  try { sidecar = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'meta.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return readSqliteSnapshot(file, (db) => {
    const raw = db.prepare("SELECT value FROM meta WHERE key = '0'").get()?.value;
    if (!raw) fail('invalid_source');
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
    const meta = JSON.parse(text.trim().startsWith('{') ? text : Buffer.from(text, 'hex').toString('utf8'));
    const getBlob = (id) => {
      const row = db.prepare('SELECT data FROM blobs WHERE id = ?').get(id);
      if (!row) fail('missing_records');
      const value = row.data;
      return Buffer.isBuffer(value) ? value : Buffer.from(value, /^[\[{]/.test(value.trim()) ? 'utf8' : 'hex');
    };
    const root = getBlob(meta.latestRootBlobId);
    const ids = [];
    // Archives are source history; current root follows them. Dedup only blob IDs.
    for (const archive of lengthFields(root, 13)) {
      const key = archive.toString('hex');
      const payload = getBlob(key);
      ids.push(...lengthFields(payload, 1).map((id) => id.toString('hex')));
    }
    ids.push(...lengthFields(root, 1).map((id) => id.toString('hex')));
    if (ids.length > 100000) fail('source_too_large');
    const entries = [...new Set(ids)].map((id) => json(getBlob(id)));
    const time = timestamp(meta.createdAt ?? sidecar.createdAtMs);
    const events = []; const results = new Map(); const warnings = new Set(['tools_archived', 'usage_unknown']);
    for (const message of entries) for (const part of Array.isArray(message.content) ? message.content : []) if (part.type === 'tool-result') results.set(part.toolCallId, part);
    for (const message of entries) {
      if (!['user', 'assistant'].includes(message.role)) continue;
      const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
      if (!Array.isArray(content)) fail('invalid_source');
      for (const part of content) {
        if (part.type === 'text') {
          let text = part.text;
          if (message.role === 'user') text = text.match(/<user_query>([\s\S]*?)<\/user_query>/)?.[1] ?? text;
          events.push({ kind: message.role === 'user' ? 'user' : 'assistant-text', text, time });
        } else if (part.type === 'reasoning') events.push({ kind: 'thinking', text: part.text ?? '', time });
        else if (part.type === 'tool-call') {
          const result = results.get(part.toolCallId);
          events.push({ kind: 'tool', time, name: part.toolName, input: part.args ?? part.input ?? {}, output: textOf(result?.result ?? result?.output), incomplete: !result });
          if (!result) warnings.add('unfinished_tools');
        } else warnings.add('attachments_omitted');
      }
    }
    if (!events.length) fail('empty_transcript');
    return { id: meta.agentId ?? path.basename(path.dirname(file)), title: sidecar.title ?? meta.name ?? '', directory: sidecar.cwd ?? '',
      parentID: meta.subagentInfo?.parentAgentId, events, warnings: [...warnings] };
  });
}
