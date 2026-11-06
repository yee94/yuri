import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createInterface } from 'node:readline';
import * as zlib from 'node:zlib';
import { setImmediate } from 'node:timers/promises';
import { digest, fail, parseTranscript } from './events.js';
import { readCursorCli, readCursorEditor, readCursorEditorInventory } from './sqlite.js';

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILES = 20000;
const sourceKinds = ['claude', 'codex', 'cursor', 'dsh'];

const namespaceFor = (source, file) => {
  const parts = path.resolve(file).split(path.sep);
  const marker = source === 'codex' ? ['sessions', 'archived_sessions'] : source === 'dsh' ? ['sessions'] : source === 'cursor' ? ['projects', 'chats', 'globalStorage'] : ['projects'];
  const index = parts.findLastIndex((part) => marker.includes(part));
  return digest(index > 0 ? parts.slice(0, index).join(path.sep) || path.sep : path.dirname(file));
};

export function defaultSources(home = os.homedir(), env = process.env, platform = process.platform) {
  const cursorUser = platform === 'darwin' ? path.join(home, 'Library/Application Support/Cursor/User')
    : platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Cursor/User')
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor/User');
  const codex = env.CODEX_HOME || path.join(home, '.codex');
  return [
    { source: 'claude', path: path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects') },
    { source: 'codex', path: path.join(codex, 'sessions') }, { source: 'codex', path: path.join(codex, 'archived_sessions') },
    { source: 'cursor', path: path.join(env.CURSOR_DATA_DIR || path.join(home, '.cursor'), 'projects') },
    { source: 'cursor', path: path.join(env.CURSOR_CONFIG_DIR || path.join(home, '.cursor'), 'chats') },
    { source: 'cursor', path: path.join(cursorUser, 'globalStorage/state.vscdb') },
    { source: 'dsh', path: path.join(env.DSH_HOME || path.join(home, '.dsh'), 'sessions') },
  ];
}

async function* walk(root, budget, depth = 0) {
  if (depth > 12) fail('source_too_large');
  let stat;
  try { stat = await fs.lstat(root); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  if (stat.isSymbolicLink()) return;
  if (++budget.count > MAX_FILES) fail('too_many_files');
  if (stat.isFile()) { yield root; return; }
  if (!stat.isDirectory()) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  // DSH keeps old physical generations. Read only the highest version, with
  // mtime as tie-breaker for compressed/plain variants of that generation.
  const generations = entries.filter((entry) => entry.isFile() && /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(entry.name));
  let latest;
  for (const entry of generations) {
    const version = Number(entry.name.match(/\.v(\d+)/)?.[1] ?? 0);
    const modified = (await fs.stat(path.join(root, entry.name))).mtimeMs;
    if (!latest || version > latest.version || version === latest.version && modified > latest.modified) latest = { name: entry.name, version, modified };
  }
  for (const entry of entries) {
    if (['node_modules', '.git'].includes(entry.name) || entry.isSymbolicLink()) continue;
    if (generations.some((candidate) => candidate.name === entry.name) && latest?.name !== entry.name) continue;
    yield* walk(path.join(root, entry.name), budget, depth + 1);
  }
}

export async function readJsonLines(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid_source');
  if (stat.size > MAX_BYTES) fail('source_too_large');
  const compressed = /\.(?:zstd|zst)$/.test(file);
  if (compressed && typeof zlib.createZstdDecompress !== 'function') fail('compression_unsupported');
  const input = createReadStream(file);
  const stream = compressed ? input.pipe(zlib.createZstdDecompress()) : input;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const entries = []; let bytes = 0;
  // Forward source errors into the decompression stream (pipe does not do so).
  const onError = (error) => stream.destroy(error);
  if (stream !== input) input.on('error', onError);
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line);
      if (bytes > MAX_BYTES || line.length > 8 * 1024 * 1024 || entries.length >= 100000) fail('source_too_large');
      if (!line.trim()) continue;
      try { const entry = JSON.parse(line); if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail('invalid_source'); entries.push(entry); }
      catch { fail('invalid_source'); }
      if (entries.length % 128 === 0) await setImmediate();
    }
  } finally { lines.close(); stream.destroy(); input.destroy(); input.off('error', onError); }
  return { entries, modified: stat.mtimeMs };
}

export async function readSource(descriptor) {
  let session;
  if (descriptor.format === 'cursor-editor') {
    const sessions = await readCursorEditor(descriptor.path, descriptor.sessionID);
    session = sessions.find((item) => item.id === descriptor.sessionID);
    if (!session) fail('source_missing');
  } else if (descriptor.format === 'cursor-cli') session = await readCursorCli(descriptor.path);
  else {
    const { entries } = await readJsonLines(descriptor.path);
    const fallback = path.basename(descriptor.path).replace(/\.jsonl.*$/, '');
    const child = descriptor.source === 'claude' && path.basename(path.dirname(descriptor.path)) === 'subagents';
    session = parseTranscript(descriptor.source, child ? entries.map((entry) => ({ ...entry, isSidechain: false })) : entries, fallback);
    if (child) { session.id = fallback; session.parentID = path.basename(path.dirname(path.dirname(descriptor.path))); }
  }
  return { ...session, source: descriptor.source, namespace: descriptor.namespace,
    hash: digest({ version: 1, ...session }), descriptor };
}

export async function discoverSources({ sources = sourceKinds, roots, limitPerSource, includeCounts = false } = {}, defaults = defaultSources()) {
  if (!Array.isArray(sources) || !sources.length || sources.some((source) => !sourceKinds.includes(source))) fail('invalid_source');
  if (roots !== undefined && (!Array.isArray(roots) || roots.length > 16 || roots.some((root) => !sourceKinds.includes(root.source) || typeof root.path !== 'string' || !path.isAbsolute(root.path)))) fail('invalid_source');
  if (limitPerSource !== undefined && (!Number.isInteger(limitPerSource) || limitPerSource < 1 || limitPerSource > 10)) fail('invalid_preview_limit');
  if (typeof includeCounts !== 'boolean') fail('invalid_source');
  const locations = roots?.length ? roots.filter((root) => sources.includes(root.source)) : defaults.filter((root) => sources.includes(root.source));
  const sessions = []; const errors = []; const descriptors = new Map(); const positions = new Map(); const budget = { count: 0 };
  const sampleCounts = Object.fromEntries(sourceKinds.map((source) => [source, 0]));
  const candidateCounts = Object.fromEntries(sources.map((source) => [source, 0]));
  const unknownCounts = new Set(); const countedFiles = new Set();
  const perSourceLimit = limitPerSource ?? Infinity;
  for (const root of locations) {
    if (!includeCounts && sampleCounts[root.source] >= perSourceLimit) continue;
    try {
      for await (const file of walk(root.path, budget)) {
        let format = 'jsonl';
        if (root.source === 'cursor') {
          if (path.basename(file) === 'state.vscdb') format = 'cursor-editor';
          else if (path.basename(file) === 'store.db') format = 'cursor-cli';
          else if (!file.includes(`${path.sep}agent-transcripts${path.sep}`) || !file.endsWith('.jsonl')) continue;
        } else if (root.source === 'dsh') {
          if (!/^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(path.basename(file))) continue;
        } else if (!/\.jsonl(?:\.zst|\.zstd)?$/.test(file)) continue;
        if (includeCounts) {
          const countedKey = `${root.source}:${path.resolve(file)}`;
          if (countedFiles.has(countedKey)) continue;
          countedFiles.add(countedKey);
          if (format !== 'cursor-editor') candidateCounts[root.source]++;
        }
        if (sampleCounts[root.source] >= perSourceLimit && (!includeCounts || format !== 'cursor-editor')) continue;
        const namespace = namespaceFor(root.source, file);
        const modified = (await fs.stat(file)).mtimeMs;
        const descriptor = { source: root.source, namespace, path: file, format, modified };
        try {
          const remaining = limitPerSource === undefined ? undefined : Math.max(0, limitPerSource - sampleCounts[root.source]);
          let records;
          if (format === 'cursor-editor' && includeCounts) {
            const inventory = await readCursorEditorInventory(file, remaining);
            candidateCounts[root.source] += inventory.count;
            records = inventory.sessions;
            if (inventory.error) errors.push({ source: root.source, file: path.basename(file), code: inventory.error.code ?? 'source_unreadable' });
          } else records = format === 'cursor-editor' ? await readCursorEditor(file, undefined, remaining) : [await readSource(descriptor)];
          for (const session of records) {
            if (sampleCounts[root.source] >= perSourceLimit) break;
            const key = digest(`${root.source}:${namespace}:${session.id}`);
            const previous = descriptors.get(key);
            if (previous && previous.modified >= modified) continue;
            const item = { ...descriptor, sessionID: session.id, revision: {
              source: root.source, namespace, id: session.id, parentID: session.parentID,
              hash: session.hash ?? digest({ version: 1, ...session }), directory: session.directory,
            } };
            descriptors.set(key, item);
            const excerpt = session.events.find((event) => event.kind === 'assistant-text' && event.text?.trim())
              ?? session.events.find((event) => event.kind === 'user' && event.text?.trim());
            const summary = { key, source: root.source, id: session.id, title: session.title, directory: session.directory,
              parentID: session.parentID, messages: session.events.length, warnings: session.warnings,
              excerpt: excerpt?.text?.slice(0, 512).replace(/\s+/g, ' ').trim().slice(0, 180) ?? '',
              updated: session.events.at(-1)?.time ?? 0 };
            if (positions.has(key)) sessions[positions.get(key)] = summary;
            else { if (sessions.length >= 5000) fail('too_many_sessions'); positions.set(key, sessions.length); sessions.push(summary); sampleCounts[root.source]++; }
          }
        } catch (error) {
          if (includeCounts && format === 'cursor-editor') unknownCounts.add(root.source);
          errors.push({ source: root.source, file: path.basename(file), code: error.code ?? 'source_unreadable' });
        }
        await setImmediate();
        if (!includeCounts && sampleCounts[root.source] >= perSourceLimit) break;
      }
    } catch (error) {
      if (includeCounts) unknownCounts.add(root.source);
      errors.push({ source: root.source, code: error.code ?? 'source_unreadable' });
    }
  }
  sessions.sort((a, b) => a.updated - b.updated || a.key.localeCompare(b.key));
  const counts = includeCounts ? Object.fromEntries(sources.map((source) => [source, {
    value: unknownCounts.has(source) ? null : candidateCounts[source], approximate: candidateCounts[source] > 0,
  }])) : undefined;
  return { sessions, errors, descriptors, counts };
}
