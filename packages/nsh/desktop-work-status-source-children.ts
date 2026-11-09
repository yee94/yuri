import { normalizeDirectoryKey } from '../ui/src/lib/pathNormalization';
import { record, text } from './model';
import type { PageOperation } from './page-operations';
import type { DesktopWorkStatusChild, DesktopWorkStatusScope } from './desktop-work-status-core';

export const desktopWorkStatusChildReadLimits = Object.freeze({ pageSize: 200, pages: 5, rows: 1000 });
export type DesktopWorkStatusChildActivity = (sessionID: string, directory: string) => DesktopWorkStatusChild['activity'];

/** Explicit exact-parent read only. Default activity is unknown; a session row is never live-status authority. */
export async function readDesktopWorkStatusChildren(operation: PageOperation, scope: DesktopWorkStatusScope, activity?: DesktopWorkStatusChildActivity): Promise<DesktopWorkStatusChild[]> {
  const current = () => operation.current() && operation.scope?.hostID === scope.host.hostID && operation.scope?.lease === scope.host.lease;
  const check = () => { if (!current()) throw new Error('work_status_children_stale'); };
  check();
  if (!scope.sessionID || !scope.directory) throw new Error('work_status_children_scope');
  const directory = scope.directory, parentID = scope.sessionID;
  const location = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
  const rows: Array<{ id: string; title?: string }> = [], ids = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < desktopWorkStatusChildReadLimits.pages; page++) {
    check();
    // location is request context; directory is session.list's actual filter. Cursor pages retain that filter in the opaque cursor.
    const params = cursor ? `${location}&cursor=${encodeURIComponent(cursor)}&limit=200` : `${location}&directory=${encodeURIComponent(directory)}&parentID=${encodeURIComponent(parentID)}&limit=200`;
    const payload = await operation.request(`/api/session?${params}`, 'GET'); check();
    const body = record(payload), paging = record(body.cursor);
    if (!Array.isArray(body.data) || !body.cursor || typeof body.cursor !== 'object' || Array.isArray(body.cursor) || body.data.length > 200 || body.partial === true) throw new Error('work_status_children_invalid_page');
    for (const raw of body.data) {
      const row = record(raw), id = text(row.id), rowDirectory = text(record(row.location).directory);
      if (!id || row.parentID !== parentID || !rowDirectory || normalizeDirectoryKey(rowDirectory) !== normalizeDirectoryKey(directory)
        || row.directory !== undefined && normalizeDirectoryKey(text(row.directory)) !== normalizeDirectoryKey(directory) || ids.has(id)
        || row.title !== undefined && typeof row.title !== 'string') throw new Error('work_status_children_invalid_scope');
      ids.add(id); rows.push({ id, ...(row.title === undefined ? {} : { title: row.title }) });
    }
    if (rows.length > desktopWorkStatusChildReadLimits.rows || paging.next !== undefined && paging.next !== null && (typeof paging.next !== 'string' || !paging.next)) throw new Error('work_status_children_invalid_cursor');
    const next = typeof paging.next === 'string' ? paging.next : null;
    if (!next) {
      if (body.complete === false || body.hasMore === true) throw new Error('work_status_children_incomplete');
      check();
      return rows.map(row => {
        const state = activity?.(row.id, directory) ?? 'unknown';
        if (!['working', 'idle', 'unknown'].includes(state)) throw new Error('work_status_children_invalid_activity');
        return { ...row, parentID, directory, activity: state };
      });
    }
    if (!body.data.length || cursors.has(next)) throw new Error('work_status_children_cursor_did_not_advance');
    cursors.add(next); cursor = next;
  }
  throw new Error('work_status_children_incomplete');
}
