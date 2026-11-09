import { normalizePath } from '../ui/src/lib/pathNormalization';
import { record, sessionsFrom, text, type Session } from './model';

export type SessionCatalogIssues = Readonly<{ failedDirectories: readonly string[]; pendingDirectories: readonly string[] }>;

/** Display adoption is per directory. A partial display never grants whole-catalog authority. */
export function sessionCatalogFrom(payload: unknown, previous: readonly Session[]) {
  const raw = record(payload), sync = record(raw.sync);
  if (raw.available !== true || !Array.isArray(raw.directories)) throw new Error('Session index unavailable');
  function paths(key: string) {
    const value = sync[key];
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some(path => typeof path !== 'string' || !normalizePath(path))) throw new Error('Invalid session index sync state');
    return value.map(path => normalizePath(path)!);
  }
  const failed = new Set(paths('failedDirectories')), pending = new Set(paths('pendingDirectories')), completed = new Set(paths('completedDirectories'));
  const incomplete = raw.partial === true || raw.complete === false || sync.active === true
    || typeof sync.completed === 'number' && typeof sync.total === 'number' && sync.completed < sync.total;
  const grouped = new Map<string, Session[]>();
  for (const row of previous) {
    const path = normalizePath(row.directory); if (!path) continue;
    const rows = grouped.get(path) ?? []; rows.push(row); grouped.set(path, rows);
  }
  const next = new Map<string, Session[]>(), seen = new Set<string>();
  for (const item of raw.directories) {
    const entry = record(item), path = normalizePath(text(entry.directory));
    if (!path || seen.has(path)) throw new Error('Invalid session index directory');
    seen.add(path);
    if (!Array.isArray(entry.sessions) || entry.sessions.some(row => !text(record(row).id))) { failed.add(path); continue; }
    const rows = sessionsFrom({ available: true, directories: [{ ...entry, directory: path }] });
    const prior = grouped.get(path) ?? [];
    const known = !failed.has(path) && !pending.has(path) && (!incomplete || completed.has(path));
    if (!known) {
      // Failed/pending index entries may seed a cold display, never erase a prior successful read.
      const retained = new Map(rows.map(row => [row.id, row]));
      for (const row of prior) retained.set(row.id, row);
      next.set(path, [...retained.values()]);
    } else {
      const boundary = rows.length ? Math.min(...rows.map(row => row.updated)) : 0;
      const ids = new Set(rows.map(row => row.id));
      const tail = entry.hasMore === true ? prior.filter(row => !ids.has(row.id) && (!rows.length || row.updated < boundary)) : [];
      next.set(path, [...rows, ...tail]);
    }
  }
  const complete = !incomplete && !failed.size && !pending.size;
  for (const [path, rows] of grouped) if (!next.has(path) && (!complete || failed.has(path) || pending.has(path))) next.set(path, rows);
  const sessions = [...next.values()].flat().sort((a, b) => b.updated - a.updated);
  const issues: SessionCatalogIssues | undefined = complete ? undefined : { failedDirectories: [...failed], pendingDirectories: [...pending] };
  return { sessions, complete, issues };
}
