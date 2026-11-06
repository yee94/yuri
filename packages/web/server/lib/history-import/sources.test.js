import { afterEach, beforeEach, expect, test } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import Database from 'better-sqlite3';
import { defaultSources, discoverSources, readSource, readJsonLines } from './sources.js';
import { readCursorEditor, readCursorEditorInventory, readCursorCli } from './sqlite.js';

let temporary;
const save = async (file, data) => { const name = path.join(temporary, file); await fs.mkdir(path.dirname(name), { recursive: true }); await fs.writeFile(name, data); return name; };
const lines = (items) => items.map((item) => JSON.stringify(item)).join('\n') + '\n';
beforeEach(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-source-test-')); });
afterEach(async () => { await fs.rm(temporary, { force: true, recursive: true }); });

test('discovers all four source kinds, isolates malformed files and picks the newest DSH generation', async () => {
  const claude = await save('claude/projects/project/main.jsonl', lines([{ type: 'user', uuid: 'u', timestamp: '2026-01-01', sessionId: 'main', cwd: temporary, message: { content: 'hello claude' } }]));
  await save('claude/projects/project/main/subagents/agent-child.jsonl', lines([{ type: 'user', isSidechain: true, uuid: 'c', timestamp: '2026-01-01', sessionId: 'main', cwd: temporary, message: { content: 'child' } }]));
  await save('claude/projects/project/broken.jsonl', '{not json}\n');
  await save('codex/sessions/rollout.jsonl', lines([{ type: 'session_meta', payload: { id: 'codex', cwd: temporary } }, { type: 'event_msg', payload: { type: 'user_message', message: 'hello codex' } }]));
  await save('cursor/projects/project/agent-transcripts/cursor.jsonl', lines([{ role: 'user', content: 'hello cursor' }]));
  await save('dsh/sessions/project/dsh/session.jsonl', lines([{ type: 'session', id: 'dsh', version: 0 }, { type: 'user/message', data: { source: { kind: 'user' }, content: 'old' } }]));
  const dsh = lines([{ type: 'session', id: 'dsh', version: 4, cwd: temporary }, { type: 'user/message', seq: 0, data: { source: { kind: 'user' }, content: 'hello dsh' } }]);
  await save('dsh/sessions/project/dsh/session.v4.jsonl.zstd', zstdCompressSync(Buffer.from(dsh)));
  const result = await discoverSources({ roots: ['claude', 'codex', 'cursor', 'dsh'].map((source) => ({ source, path: path.join(temporary, source) })) });
  expect(result.sessions.map((session) => session.source).sort()).toEqual(['claude', 'claude', 'codex', 'cursor', 'dsh']);
  expect(result.errors).toEqual([{ source: 'claude', file: 'broken.jsonl', code: 'invalid_source' }]);
  expect(result.sessions.find((session) => session.id === 'agent-child')).toMatchObject({ parentID: 'main', title: 'child' });
  expect(result.sessions.find((session) => session.source === 'dsh').title).toBe('hello dsh');
  for (const descriptor of result.descriptors.values()) {
    const reread = await readSource(descriptor);
    expect(descriptor.revision.hash).toBe(reread.hash);
    expect(descriptor.revision.namespace).toBe(reread.namespace);
    expect(descriptor.revision.id).toBe(reread.id);
  }
  const rediscovered = await discoverSources({ roots: [{ source: 'claude', path: claude }] });
  expect(rediscovered.sessions[0].key).toBe(result.sessions.find((session) => session.id === 'main').key);
});

test('symlinks are not followed and malformed compressed sources fail explicitly', async () => {
  await save('outside/file.jsonl', lines([{ role: 'user', content: 'do not scan' }]));
  await fs.mkdir(path.join(temporary, 'root'));
  await fs.symlink(path.join(temporary, 'outside'), path.join(temporary, 'root/link'));
  const result = await discoverSources({ roots: [{ source: 'claude', path: path.join(temporary, 'root') }] });
  expect(result.sessions).toEqual([]);
  const broken = await save('broken.jsonl.zstd', Buffer.from('bad compression'));
  await expect(readJsonLines(broken)).rejects.toBeDefined();
});

test('sample discovery stops reading at five sessions per source without counting the remaining history', async () => {
  const roots = [];
  for (let index = 0; index < 5; index++) roots.push({ source: 'claude', path: await save(`claude/projects/sample-${index}.jsonl`, lines([
    { type: 'user', sessionId: `claude-${index}`, message: { content: `Claude ${index}` } },
  ])) });
  roots.push({ source: 'claude', path: await save('claude/projects/not-read.jsonl', 'invalid JSON must not be read by sample discovery') });
  for (let index = 0; index < 12; index++) await save(`codex/sessions/sample-${index}.jsonl`, lines([
    { type: 'session_meta', payload: { id: `codex-${index}` } },
    { type: 'event_msg', payload: { type: 'user_message', message: `Codex ${index}` } },
  ]));
  roots.push({ source: 'codex', path: path.join(temporary, 'codex') });
  const sample = await discoverSources({ roots, limitPerSource: 5 });
  expect(sample.sessions.filter((session) => session.source === 'claude')).toHaveLength(5);
  expect(sample.sessions.filter((session) => session.source === 'codex')).toHaveLength(5);
  expect(sample.descriptors.size).toBe(10);
  expect(sample.errors).toEqual([]);
  const counted = await discoverSources({ roots: [...roots, roots[0]], limitPerSource: 5, includeCounts: true });
  expect(counted.counts.claude).toEqual({ value: 6, approximate: true });
  expect(counted.counts.codex).toEqual({ value: 12, approximate: true });
  expect(counted.sessions).toHaveLength(10);
  expect(counted.errors).toEqual([]);
  const full = await discoverSources({ roots });
  expect(full.sessions).toHaveLength(17);
  expect(full.errors).toEqual([{ source: 'claude', file: 'not-read.jsonl', code: 'invalid_source' }]);
  await expect(discoverSources({ roots, limitPerSource: 11 })).rejects.toThrow('invalid_preview_limit');
});

test('Cursor sample reads only bounded composer headers and never parses the remaining records', async () => {
  const file = path.join(temporary, 'state.vscdb'); const db = new Database(file);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE composerHeaders (composerId TEXT, value TEXT)');
  const put = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  const head = db.prepare('INSERT INTO composerHeaders VALUES (?, ?)');
  for (let index = 0; index < 5; index++) {
    head.run(`sample-${index}`, JSON.stringify({ name: `Sample ${index}` }));
    put.run(`composerData:sample-${index}`, JSON.stringify({ conversation: [{ type: 1, text: 'preview' }] }));
  }
  head.run('not-read', 'invalid JSON must not be parsed'); db.close();
  expect(await readCursorEditor(file, undefined, 5)).toHaveLength(5);
  const inventory = await readCursorEditorInventory(file, 5);
  expect(inventory.count).toBe(6);
  expect(inventory.sessions).toHaveLength(5);
  expect((await readCursorEditorInventory(file, 0)).sessions).toEqual([]);
  const failedPreview = await readCursorEditorInventory(file, 7);
  expect(failedPreview.count).toBe(6);
  expect(failedPreview.error).toBeDefined();
  expect(failedPreview.sessions).toEqual([]);
  const catalog = await discoverSources({ sources: ['cursor'], roots: [{ source: 'cursor', path: file }], limitPerSource: 10, includeCounts: true });
  expect(catalog.counts.cursor).toEqual({ value: 6, approximate: true });
  expect(catalog.errors).toHaveLength(1);
  await expect(readCursorEditor(file)).rejects.toBeDefined();
});

test('unreadable index counts stay unknown, while an empty source remains a successful zero', async () => {
  const file = await save('cursor/globalStorage/state.vscdb', 'not a SQLite database');
  const result = await discoverSources({ sources: ['cursor', 'dsh'], roots: [
    { source: 'cursor', path: file }, { source: 'dsh', path: path.join(temporary, 'missing') },
  ], limitPerSource: 5, includeCounts: true });
  expect(result.counts.cursor.value).toBeNull();
  expect(result.counts.dsh).toEqual({ value: 0, approximate: false });
  expect(result.errors.some((error) => error.source === 'cursor')).toBe(true);
});

test('preview subtitles use real assistant text, omit tool/thinking content, and stay bounded', async () => {
  const file = await save('claude/projects/example.jsonl', lines([
    { type: 'user', sessionId: 'example', message: { content: 'The conversation title' } },
    { type: 'assistant', message: { content: [{ type: 'thinking', thinking: 'not a preview subtitle' }, { type: 'text', text: `Actual answer\nwith context ${'x'.repeat(500)}` }] } },
  ]));
  const result = await discoverSources({ roots: [{ source: 'claude', path: file }], limitPerSource: 5 });
  expect(result.sessions[0].excerpt).toMatch(/^Actual answer with context /);
  expect(result.sessions[0].excerpt).toHaveLength(180);
  expect(result.sessions[0].excerpt).not.toContain('not a preview subtitle');
});

test('Cursor editor reads a WAL-consistent private snapshot without changing source files', async () => {
  const file = path.join(temporary, 'state.vscdb'); const db = new Database(file);
  try {
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB); CREATE TABLE composerHeaders (composerId TEXT, value TEXT)');
    const head = { name: 'Cursor example', createdAt: 10, workspaceIdentifier: { uri: { fsPath: temporary } } };
    db.prepare('INSERT INTO composerHeaders VALUES (?, ?)').run('composer', JSON.stringify(head));
    const put = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
    put.run('composerData:composer', JSON.stringify({ ...head, fullConversationHeadersOnly: [{ type: 1, bubbleId: 'u' }, { type: 2, bubbleId: 'a' }] }));
    put.run('bubbleId:composer:u', JSON.stringify({ type: 1, text: 'question', createdAt: 10 }));
    put.run('bubbleId:composer:a', JSON.stringify({ type: 2, text: 'answer', createdAt: 20 }));
    const snapshot = async () => Promise.all((await fs.readdir(temporary)).sort().map(async (name) => { const stat = await fs.stat(path.join(temporary, name), { bigint: true }); return [name, stat.size, stat.mtimeNs]; }));
    const before = await snapshot();
    const sessions = await readCursorEditor(file);
    const inventory = await readCursorEditorInventory(file, 1);
    expect(inventory.count).toBe(1);
    expect(inventory.sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ id: 'composer', directory: temporary, title: 'Cursor example' });
    expect(sessions[0].events.map((event) => event.text)).toEqual(['question', 'answer']);
    expect(await snapshot()).toEqual(before);
  } finally { db.close(); }
});

test('Cursor CLI reads ordered protobuf blob references and tool results', async () => {
  const file = path.join(temporary, 'store.db'); const db = new Database(file);
  db.exec('CREATE TABLE meta (key TEXT, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)');
  const ids = ['aa', 'bb', 'cc']; const root = Buffer.concat(ids.map((id) => Buffer.from([0x0a, 1, Number.parseInt(id, 16)])));
  const put = db.prepare('INSERT INTO blobs VALUES (?, ?)');
  put.run('root', root);
  put.run('aa', Buffer.from(JSON.stringify({ role: 'user', content: '<user_query>question</user_query>' })));
  put.run('bb', Buffer.from(JSON.stringify({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call', toolName: 'shell', args: { command: 'echo never execute' } }] })));
  put.run('cc', Buffer.from(JSON.stringify({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call', result: 'result' }] })));
  db.prepare('INSERT INTO meta VALUES (?, ?)').run('0', Buffer.from(JSON.stringify({ agentId: 'cli', latestRootBlobId: 'root', name: 'CLI' })).toString('hex'));
  db.close();
  const session = await readCursorCli(file);
  expect(session.events[0].text).toBe('question');
  expect(session.events[1]).toMatchObject({ kind: 'tool', incomplete: false, output: 'result' });
  expect(await fs.readdir(temporary)).toEqual(['store.db']);
});

test('touching an unchanged transcript does not change its import revision', async () => {
  const file = await save('chat.jsonl', lines([{ type: 'user', message: { content: 'hello' } }]));
  const descriptor = { source: 'claude', path: file, namespace: 'installation', format: 'jsonl' };
  const before = await readSource(descriptor); await fs.utimes(file, new Date(), new Date());
  expect((await readSource(descriptor)).hash).toBe(before.hash);
});

test('source discovery honors platform roots and environment overrides without reading credentials', () => {
  const result = defaultSources('/home/example', { DSH_HOME: '/data/dsh', CODEX_HOME: '/data/codex' }, 'linux');
  expect(result.find((root) => root.source === 'dsh').path).toBe('/data/dsh/sessions');
  expect(result.filter((root) => root.source === 'codex').map((root) => root.path)).toEqual(['/data/codex/sessions', '/data/codex/archived_sessions']);
  expect(JSON.stringify(result)).not.toMatch(/auth\.json|config\.toml/);
});

test('Codex active and archived copies share one identity across custom scan entry paths', async () => {
  const transcript = (text) => lines([{ type: 'session_meta', payload: { id: 'same-thread', cwd: temporary } },
    { type: 'event_msg', payload: { type: 'user_message', message: text } }]);
  const active = await save('codex/sessions/active.jsonl', transcript('old'));
  const archived = await save('codex/archived_sessions/archived.jsonl', transcript('new'));
  await fs.utimes(active, new Date(1000), new Date(1000));
  await fs.utimes(archived, new Date(2000), new Date(2000));
  const result = await discoverSources({ sources: ['codex'], roots: [{ source: 'codex', path: path.join(temporary, 'codex') }] });
  expect(result.sessions).toHaveLength(1);
  expect(result.sessions[0].title).toBe('new');
  const direct = await discoverSources({ sources: ['codex'], roots: [{ source: 'codex', path: archived }] });
  expect(direct.sessions[0].key).toBe(result.sessions[0].key);
  expect((await readSource(result.descriptors.get(result.sessions[0].key))).events[0].text).toBe('new');
});
