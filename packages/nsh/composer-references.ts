import { record, text, type CompiledSubmission } from './model';
import { buildMentionRows } from '../ui/src/lib/composer-autocomplete/rows';
import type { ComposerAutocompleteListRow } from '../ui/src/lib/composer-autocomplete/types';
import { rankFileMentionSearch, resolveFileMentionSearchQuery } from '../ui/src/lib/search/fileMentionSearch';

export type ReferenceKind = 'file' | 'directory' | 'agent' | 'skill' | 'session';
export type ReferenceScope = { host: string; draft: string; directory: string };
export type ReferenceCandidate = { kind: ReferenceKind; value: string; label: string; directory?: string; description?: string; scope?: ReferenceScope };
export type NativeReference = ReferenceCandidate & { start: number; end: number; display: string };
export type ReferenceDocument = { text: string; references: NativeReference[] };
export type ScopedReferenceDocument = ReferenceDocument & { scope: ReferenceScope };
export const referenceKinds: ReferenceKind[] = ['file', 'directory', 'agent', 'skill', 'session'];
const limit = 12;
export const sameReferenceScope = (a: ReferenceScope, b: ReferenceScope) => a.host === b.host && a.draft === b.draft && a.directory === b.directory;

/** Explicit sidecars only: arbitrary @ text never becomes an attachment or skill. */
export function validateNativeReferences(document: ReferenceDocument): NativeReference[] {
  if (document.references.length > 64) throw new Error('native-reference-limit');
  const references = [...document.references].sort((a, b) => a.start - b.start);
  let end = 0;
  for (const ref of references) {
    if (!referenceKinds.includes(ref.kind) || !ref.value || !Number.isInteger(ref.start) || !Number.isInteger(ref.end)
      || ref.start < end || ref.start < 0 || ref.end <= ref.start || ref.end > document.text.length
      || document.text.slice(ref.start, ref.end) !== ref.display || ref.display !== `@${ref.label}`
      || /[\u0000-\u001f]/.test(ref.value) || (ref.kind === 'skill' && /[\s\]]/.test(ref.value))) throw new Error('native-reference-invalid');
    end = ref.end;
  }
  return references;
}

/** Native Input reports the entire value. Rebase an unchanged suffix; editing a chip removes its semantics. */
export function editNativeReferences(document: ReferenceDocument, next: string): ReferenceDocument {
  const refs = validateNativeReferences(document), before = document.text;
  let start = 0, oldEnd = before.length, newEnd = next.length;
  while (start < oldEnd && start < newEnd && before[start] === next[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
  const delta = newEnd - oldEnd;
  const rebased = refs.flatMap(ref => {
    if (ref.end <= start) return [ref];
    if (ref.start >= oldEnd) return [{ ...ref, start: ref.start + delta, end: ref.end + delta }];
    return [];
  });
  return { text: next, references: rebased.filter(ref => (!ref.start || /\s/.test(next[ref.start - 1])) && (ref.end === next.length || /\s/.test(next[ref.end]))) };
}

export function insertNativeReference(document: ReferenceDocument, candidate: ReferenceCandidate, start = document.text.length, end = start): ReferenceDocument {
  validateNativeReferences(document);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > document.text.length) throw new Error('native-reference-range');
  const display = `@${candidate.label}`;
  const lead = start && !/\s/.test(document.text[start - 1]) ? ' ' : '';
  const trail = end === document.text.length || !/\s/.test(document.text[end]) ? ' ' : '';
  const replacement = lead + display + trail;
  const delta = replacement.length - (end - start);
  const references = document.references.flatMap(ref => {
    if (ref.end <= start) return [ref];
    if (ref.start >= end) return [{ ...ref, start: ref.start + delta, end: ref.end + delta }];
    return [];
  });
  const result = { text: document.text.slice(0, start) + replacement + document.text.slice(end), references: [...references, { ...candidate, start: start + lead.length, end: start + lead.length + display.length, display }] };
  validateNativeReferences(result);
  return result;
}

export function nativeReferenceTrigger(value: string): { start: number; end: number; query: string } | null {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(value);
  if (!match) return null;
  return { start: value.length - match[1].length - 1, end: value.length, query: match[1] };
}

export function referenceRoute(kind: ReferenceKind, directory: string, query: string, max = limit): string {
  const location = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
  if (kind === 'file' || kind === 'directory') return `/api/fs/find?${location}&query=${encodeURIComponent(query)}&type=${kind}&limit=${max}`;
  if (kind === 'session') return `/api/session?search=${encodeURIComponent(query)}&limit=${max}&order=desc&archived=false`;
  return `/api/${kind}?${location}`;
}

export function referenceCandidates(kind: ReferenceKind, response: unknown, query: string, directory: string, max = limit): ReferenceCandidate[] {
  const payload = record(response).data ?? response;
  // Session.list returns {items,next}; fs/agent/skill use {location,data}.
  const rows = Array.isArray(payload) ? payload : record(payload).items;
  if (!Array.isArray(rows)) throw new Error('native-reference-catalog-invalid');
  const result: ReferenceCandidate[] = [], needle = query.toLowerCase();
  for (const entry of rows) {
    const row = record(entry);
    if (kind === 'agent' && (row.hidden === true || row.mode === 'primary')) continue;
    if ((kind === 'file' || kind === 'directory') && row.type !== kind) continue;
    const value = text(kind === 'file' || kind === 'directory' ? row.path : kind === 'agent' ? row.name : row.id);
    const label = kind === 'session' ? text(row.title) || value : kind === 'skill' ? text(row.name) || value : value;
    if (!value || (!`${value} ${label}`.toLowerCase().includes(needle) && kind !== 'file' && kind !== 'directory' && kind !== 'session')) continue;
    result.push({ kind, value, label, ...(kind === 'session' ? { directory: text(record(row.location).directory) || text(row.directory) || directory } : {}), description: text(row.description) });
    if (result.length === max) break;
  }
  return result;
}

export type ReferenceSearchState = { rows: ReferenceCandidate[]; busy: boolean; failed: boolean };
/** One mounted picker, one active domain, one debounced request. close/update fence every stale completion. */
export function createReferenceSearch(send: (path: string) => Promise<unknown>, publish: (state: ReferenceSearchState) => void, delay = 250) {
  let generation = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let active: { scope: ReferenceScope; kind: ReferenceKind; query: string } | undefined;
  let catalog: { scope: ReferenceScope; kind: ReferenceKind; data: unknown } | undefined;
  const cancel = () => { generation++; clearTimeout(timer); timer = undefined; };
  function update(scope: ReferenceScope, kind: ReferenceKind, query: string, open: boolean) {
    cancel();
    if (!open || !scope.host || !scope.draft || !scope.directory) { active = undefined; catalog = undefined; publish({ rows: [], busy: false, failed: false }); return; }
    if (!active || !sameReferenceScope(active.scope, scope) || active.kind !== kind) catalog = undefined;
    active = { scope: { ...scope }, kind, query };
    const version = generation;
    publish({ rows: [], busy: true, failed: false });
    timer = setTimeout(() => { void (async () => {
      try {
        const data = catalog?.data ?? await send(referenceRoute(kind, scope.directory, query));
        if (version !== generation) return;
        const rows = referenceCandidates(kind, data, query, scope.directory).map(candidate => ({ ...candidate, scope: { ...scope } }));
        if (kind === 'agent' || kind === 'skill') {
          const payload = record(data).data ?? data;
          // Skill.list includes entire SKILL.md bodies; the picker never retains them.
          const compact = Array.isArray(payload) ? payload.map(entry => {
            const row = record(entry);
            return { id: row.id, name: row.name, description: row.description, hidden: row.hidden, mode: row.mode };
          }) : payload;
          catalog = { scope: { ...scope }, kind, data: { data: compact } };
        }
        publish({ rows, busy: false, failed: false });
      } catch { if (version === generation) publish({ rows: [], busy: false, failed: true }); }
    })(); }, delay);
  }
  return { update, close() { cancel(); active = undefined; catalog = undefined; publish({ rows: [], busy: false, failed: false }); }, dispose() { cancel(); active = undefined; catalog = undefined; } };
}

export type MixedReferenceRow = { candidate: ReferenceCandidate; presentation: ComposerAutocompleteListRow };
export type MixedReferenceSearchState = { rows: MixedReferenceRow[]; busy: boolean; failed: boolean };

/** Web's exact joint title/description tiers, ten non-chat slots and flat path order. No React/DOM imports. */
export function mixedReferenceRows(candidates: readonly ReferenceCandidate[], query: string): MixedReferenceRow[] {
  const byRow = new Map<string, ReferenceCandidate>();
  const skills: Array<{ name: string; scope: string; description?: string }> = [];
  const agents: Array<{ name: string; description?: string }> = [];
  const sessions: Array<{ id: string; title: string; directory?: string }> = [];
  const paths: Array<{ path: string; name: string; relativePath: string; extension?: string; isDirectory: boolean }> = [];
  for (const candidate of candidates) {
    if (candidate.kind === 'skill') {
      byRow.set(`skill:${candidate.value}-native`, candidate);
      skills.push({ name: candidate.value, scope: 'native', description: candidate.description });
    } else if (candidate.kind === 'agent') {
      byRow.set(`agent:${candidate.value}`, candidate);
      agents.push({ name: candidate.value, description: candidate.description });
    } else if (candidate.kind === 'session') {
      byRow.set(`session:${candidate.value}`, candidate);
      sessions.push({ id: candidate.value, title: candidate.label, directory: candidate.directory });
    } else {
      const path = candidate.value.replace(/\\/g, '/');
      const root = candidate.scope?.directory.replace(/\\/g, '/').replace(/\/$/, '');
      const relativePath = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
      const name = path.replace(/\/$/, '').split('/').pop() || path;
      // One physical path is one row; a directory result wins a duplicate file result, as on Web.
      const rowID = `file:${path}`;
      const existing = byRow.get(rowID);
      if (existing && (existing.kind === 'directory' || candidate.kind !== 'directory')) continue;
      if (existing) paths.splice(paths.findIndex(item => item.path === path), 1);
      byRow.set(rowID, candidate);
      paths.push({ path, name, relativePath, extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined, isDirectory: candidate.kind === 'directory' });
    }
  }
  const pathHits = rankFileMentionSearch(paths, query, { limit: 20 });
  return buildMentionRows({ skills, agents, sessions, recentFiles: [], pathHits, searchQuery: query, untitledSession: '', skillBadge: '', sessionBadge: '' })
    .flatMap(presentation => {
      const candidate = byRow.get(presentation.id);
      return candidate ? [{ candidate, presentation }] : [];
    });
}

/** A single mounted mixed surface. Catalogs are metadata-only, one scope, at most two bounded entries. */
export function createMixedReferenceSearch(send: (path: string) => Promise<unknown>, publish: (state: MixedReferenceSearchState) => void, delay = 180) {
  type Catalog = { entries?: ReferenceCandidate[]; flight?: Promise<unknown> };
  let agents: Catalog | undefined, skills: Catalog | undefined;
  let scope: ReferenceScope | undefined, scopeVersion = 0, generation = 0, opened = false, disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cancel = () => { generation++; clearTimeout(timer); timer = undefined; };
  const valid = (version: number) => !disposed && opened && version === generation;
  async function catalog(kind: 'agent' | 'skill', at: ReferenceScope, epoch: number): Promise<ReferenceCandidate[] | null> {
    let entry = kind === 'agent' ? agents : skills;
    if (!entry) { entry = {}; if (kind === 'agent') agents = entry; else skills = entry; }
    if (entry.entries) return entry.entries;
    entry.flight ??= send(referenceRoute(kind, at.directory, ''));
    const response = await entry.flight;
    // A closed surface never even enumerates a late catalog response.
    if (disposed || !opened || epoch !== scopeVersion) return null;
    if (!entry.entries) {
      const payload = record(response).data ?? response;
      if (!Array.isArray(payload) || payload.length > 2048) throw new Error('native-reference-catalog-limit');
      entry.entries = referenceCandidates(kind, response, '', at.directory, 2048).map(candidate => ({
        ...candidate, description: candidate.description?.slice(0, 2048), scope: { ...at },
      }));
      entry.flight = undefined;
    }
    return entry.entries;
  }
  function update(at: ReferenceScope, query: string, open: boolean, currentSessionID?: string) {
    cancel();
    if (disposed) return;
    if (!open || !at.host || !at.draft || !at.directory) { close(); return; }
    if (!scope || !sameReferenceScope(scope, at)) { scopeVersion++; agents = undefined; skills = undefined; scope = { ...at }; }
    opened = true;
    const version = generation, epoch = scopeVersion, captured = { ...at }, needle = query.trim();
    publish({ rows: [], busy: true, failed: false });
    timer = setTimeout(() => {
      if (!valid(version)) return;
      const buckets: Partial<Record<ReferenceKind, ReferenceCandidate[]>> = {};
      let failed = false;
      const pathQuery = resolveFileMentionSearchQuery(needle);
      const jobs: Array<{ kind: ReferenceKind; run: () => Promise<ReferenceCandidate[] | null> }> = [
        { kind: 'agent', run: () => catalog('agent', captured, epoch) },
        { kind: 'skill', run: () => catalog('skill', captured, epoch) },
        { kind: 'session', run: async () => {
          const result = await send(referenceRoute('session', captured.directory, needle, needle ? 12 : 6));
          if (!valid(version)) return null;
          return referenceCandidates('session', result, '', captured.directory).filter(row => row.value !== currentSessionID).slice(0, needle ? 12 : 5);
        } },
        ...(pathQuery ? (['file', 'directory'] as const).map(kind => ({ kind, run: async () => {
          const max = kind === 'file' ? 80 : 40;
          const result = await send(referenceRoute(kind, captured.directory, pathQuery, max));
          if (!valid(version)) return null;
          return referenceCandidates(kind, result, '', captured.directory, max);
        } })) : []),
      ];
      let pending = jobs.length;
      const emit = () => {
        if (!valid(version)) return;
        // Match Web source order before shared ranking; async response order never becomes a rank signal.
        const candidates = (['skill', 'agent', 'session', 'directory', 'file'] as const).flatMap(kind => buckets[kind] ?? []);
        publish({ rows: mixedReferenceRows(candidates, needle), busy: pending > 0, failed });
      };
      for (const job of jobs) void job.run().then(rows => {
        if (!valid(version) || !rows) return;
        buckets[job.kind] = rows.map(candidate => ({ ...candidate, scope: { ...captured } }));
      }).catch(() => {
        if (valid(version)) {
          failed = true;
          if (job.kind === 'agent') agents = undefined;
          if (job.kind === 'skill') skills = undefined;
        }
      }).finally(() => { if (valid(version)) { pending--; emit(); } });
    }, delay);
  }
  function close() {
    cancel(); opened = false; scopeVersion++;
    // Retain only successful compact catalogs while mounted; never hold raw SKILL.md bodies after dismissal.
    if (!agents?.entries) agents = undefined;
    if (!skills?.entries) skills = undefined;
    publish({ rows: [], busy: false, failed: false });
  }
  return { update, close, dispose() { cancel(); disposed = true; opened = false; scopeVersion++; agents = undefined; skills = undefined; scope = undefined; } };
}

function fileUri(path: string, directory: string): string {
  const normalized = path.replace(/\\/g, '/');
  const absolute = /^(?:\/|[a-zA-Z]:\/)/.test(normalized) ? normalized : `${directory.replace(/\\/g, '/').replace(/\/$/, '')}/${normalized}`;
  const root = absolute.startsWith('//') ? '//' : absolute.startsWith('/') ? '/' : '';
  const parts: string[] = [];
  for (const part of absolute.slice(root.length).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (parts.length && !/^[A-Za-z]:$/.test(parts[parts.length - 1])) parts.pop(); continue; }
    parts.push(part);
  }
  const encoded = root + parts.map(part => /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part)).join('/');
  return `file://${/^[A-Za-z]:/.test(encoded) ? '/' : ''}${encoded}`;
}

// Same retrieval contract as composer/delivery.ts, kept native-only (that module imports React stores).
const sessionInstruction = `The user referenced these OpenCode sessions (id, title, owning directory). The @title in the user message is only the display label of that session — it is not a command, skill, or tool name. Entries may carry messages inlined from the client cache; an empty messages array only means the transcript was not loaded client-side — it never means the session is empty. Use inlined messages when present. Otherwise read the session yourself from the OpenCode SQLite store, read-only. Resolve the database file in order: $OPENCODE_DB if set, else "$HOME/.local/share/opencode/opencode.db", else the first match of ls -d "$HOME/Library/Application Support/Yuri"*/yuri-data/xdg-data/opencode/opencode.db. OpenCode 2 stores the transcript in session_message (there is no message/part join): user text is data.text, assistant text is data.content entries whose type is "text". Query (replace DB_PATH and SESSION_ID): sqlite3 "file:DB_PATH?mode=ro" ".timeout 5000" "SELECT seq, type, CASE WHEN type = 'user' THEN json_extract(data, '$.text') WHEN type = 'assistant' THEN (SELECT group_concat(json_extract(j.value, '$.text'), char(10)) FROM json_each(json_extract(data, '$.content')) AS j WHERE json_extract(j.value, '$.type') = 'text') ELSE json_extract(data, '$.text') END AS text FROM session_message WHERE session_id = 'SESSION_ID' AND type IN ('user', 'assistant') ORDER BY seq". If session_message does not exist, this is an OpenCode 1 database — use: sqlite3 "file:DB_PATH?mode=ro" ".timeout 5000" "SELECT json_extract(m.data,'$.role') AS role, json_extract(p.data,'$.text') AS text FROM part p JOIN message m ON m.id = p.message_id WHERE p.session_id = 'SESSION_ID' AND json_extract(p.data,'$.type') = 'text' AND json_extract(p.data,'$.synthetic') IS NULL ORDER BY p.time_created". The database is live — always open it read-only as shown.
`;

export type NativeSessionReferenceContext = { id: string; title: string; directory: string; messages: Array<{ role: string; text: string }> };

/** Submission-only hydration, never picker work. Failure is not an empty transcript. */
export async function hydrateNativeReferenceSessions(document: ScopedReferenceDocument, scope: ReferenceScope, send: (path: string) => Promise<unknown>, isCurrent = () => true): Promise<NativeSessionReferenceContext[]> {
  if (!sameReferenceScope(document.scope, scope)) throw new Error('native-reference-scope-mismatch');
  const contexts: NativeSessionReferenceContext[] = [];
  for (const ref of validateNativeReferences(document)) {
    if (ref.kind !== 'session' || contexts.some(item => item.id === ref.value)) continue;
    const context: NativeSessionReferenceContext = { id: ref.value, title: ref.label, directory: ref.directory || scope.directory, messages: [] };
    const seen = new Set<string>(), cursors = new Set<string>();
    let cursor = '', chars = 0;
    for (let page = 0; page < 50 && chars < 150_000; page++) {
      if (!isCurrent()) throw new Error('native-reference-scope-changed');
      const response = record(await send(`/api/session/${encodeURIComponent(ref.value)}/message?limit=20&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      if (!isCurrent()) throw new Error('native-reference-scope-changed');
      if (!Array.isArray(response.data)) throw new Error('native-reference-transcript-invalid');
      const messages: NativeSessionReferenceContext['messages'] = [];
      for (const entry of [...response.data].reverse()) {
        const row = record(entry), id = text(row.id), role = text(row.type);
        if (!id || seen.has(id) || (role !== 'user' && role !== 'assistant')) continue;
        seen.add(id);
        const content = Array.isArray(row.content) ? row.content : [];
        const body = role === 'user' ? text(row.text) : content.map(record).filter(part => part.type === 'text' && part.synthetic !== true).map(part => text(part.text)).join('\n');
        if (!body) continue;
        const fitted = body.slice(0, Math.max(0, 150_000 - chars));
        chars += fitted.length;
        if (fitted) messages.push({ role, text: fitted });
      }
      context.messages.unshift(...messages);
      cursor = text(record(response.cursor).next);
      if (!cursor) break;
      if (cursors.has(cursor)) throw new Error('native-reference-cursor-repeated');
      cursors.add(cursor);
    }
    contexts.push(context);
  }
  return contexts;
}

function fitSessionContexts(contexts: NativeSessionReferenceContext[]): string {
  const budget = Math.floor((36_000 - sessionInstruction.length - 2 - contexts.length) / contexts.length);
  return JSON.stringify(contexts.map(context => {
    const fitted: NativeSessionReferenceContext = { ...context, title: context.title.slice(0, 512), messages: [] };
    while (JSON.stringify(fitted).length > budget && fitted.title.length) fitted.title = fitted.title.slice(0, Math.max(0, fitted.title.length - (JSON.stringify(fitted).length - budget)));
    if (JSON.stringify(fitted).length > budget) throw new Error('native-reference-context-limit');
    for (const message of context.messages) {
      const room = budget - JSON.stringify(fitted).length - 80;
      if (room <= 0) break;
      const body = message.text.slice(0, room);
      fitted.messages.push({ role: message.role, text: body.length < message.text.length ? `${body}\n[Message truncated]` : body });
      // JSON escaping can exceed raw text size. Fit this actual wire representation.
      while (JSON.stringify(fitted).length > budget && fitted.messages.at(-1)!.text.length) {
        const last = fitted.messages.at(-1)!;
        last.text = last.text.slice(0, Math.max(0, last.text.length - Math.max(1, JSON.stringify(fitted).length - budget)));
      }
      if (body.length < message.text.length) break;
    }
    return fitted;
  }));
}

export function compileNativeReferences(document: ScopedReferenceDocument, scope: ReferenceScope, compiledText?: string, contexts?: NativeSessionReferenceContext[]): CompiledSubmission {
  if (!scope.host || !scope.draft || !scope.directory) throw new Error('native-reference-scope-invalid');
  if (!sameReferenceScope(document.scope, scope)) throw new Error('native-reference-scope-mismatch');
  const references = validateNativeReferences(document);
  if (references.some(ref => ref.scope && !sameReferenceScope(ref.scope, scope))) throw new Error('native-reference-scope-mismatch');
  const files: NonNullable<CompiledSubmission['files']> = [], agents: NonNullable<CompiledSubmission['agents']> = [], skills: NonNullable<CompiledSubmission['skills']> = [];
  const sessions: NativeSessionReferenceContext[] = [];
  const seen = new Set<string>();
  let cursor = 0, authored = '';
  for (const ref of references) {
    authored += document.text.slice(cursor, ref.start);
    authored += ref.kind === 'skill' ? `[skill:${ref.value}]` : ref.kind === 'agent' ? `@${ref.value}` : ref.display;
    cursor = ref.end;
    const key = `${ref.kind}:${ref.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (ref.kind === 'file' || ref.kind === 'directory') {
      const uri = fileUri(ref.value, scope.directory);
      if (!files.some(file => file.kind !== 'contact' && file.uri === uri)) files.push({ uri, name: ref.value.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() });
    } else if (ref.kind === 'agent') agents.push({ name: ref.value });
    else if (ref.kind === 'skill') skills.push({ id: ref.value });
    else sessions.push(contexts?.find(context => context.id === ref.value) ?? { id: ref.value, title: ref.label, directory: ref.directory || scope.directory, messages: [] });
  }
  authored += document.text.slice(cursor);
  if (compiledText !== undefined) authored = compiledText;
  if (sessions.length) authored += `\n${sessionInstruction}${fitSessionContexts(sessions)}`;
  return { text: authored, ...(files.length ? { files } : {}), ...(agents.length ? { agents } : {}), ...(skills.length ? { skills } : {}) };
}
