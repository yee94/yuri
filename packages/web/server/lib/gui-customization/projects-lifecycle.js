import path from 'node:path';
import { applyHostArchiveToIndexSnapshot } from '../session-index/host-authority-snapshot.js';

export const lifecycleOperations = ['task-sessions', 'session-state', 'settle-session', 'unsettle-session', 'archive-session', 'unarchive-session'];

export function validLifecycleInput(operation, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const allowed = operation === 'task-sessions' ? ['directory', 'cursor']
    : ['archive-session', 'unarchive-session'].includes(operation) ? ['sessionID', 'directory'] : ['sessionID'];
  if (Object.entries(input).some(([key, value]) => !allowed.includes(key)
    || typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\x00-\x1f]/.test(value))) return false;
  if (input.directory !== undefined && !path.isAbsolute(input.directory)) return false;
  if (operation === 'task-sessions') return input.cursor === undefined || /^(0|[1-9]\d{0,8})$/.test(input.cursor);
  return typeof input.sessionID === 'string' && /^ses[A-Za-z0-9_]+$/.test(input.sessionID) && input.sessionID.length <= 256;
}

const unavailable = () => Object.assign(new Error('Session lifecycle unavailable'), { code: 'unsupported', status: 501 });
const notFound = () => Object.assign(new Error('Session not found'), { code: 'session_not_found', status: 404 });

/** Reuse the same index, Host archive authority and revision publisher as the UI. */
export function createProjectSessionLifecycle({ sessionIndexService, sessionArchiveService, publishSessionIndexChange, sessionMetadataStore }) {
  if (!sessionIndexService || !sessionArchiveService || !sessionMetadataStore) return null;
  const snapshot = async () => {
    const stored = await sessionMetadataStore.getAll();
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) throw new Error('Session metadata unavailable');
    return applyHostArchiveToIndexSnapshot(sessionIndexService.snapshot(), stored);
  };
  return async (operation, input) => {
    if (operation === 'task-sessions') {
      const { directories, pinnedSessionIds = [] } = await snapshot();
      const scoped = directories.filter((item) => !input.directory || item.directory === input.directory);
      const pins = new Set(pinnedSessionIds);
      const rows = scoped.flatMap((item) => item.sessions)
        .filter((session) => !session.parentID)
        .map((session) => ({
          sessionID: session.id, directory: session.directory, title: session.title,
          settled: Number(session.time?.settled ?? 0) > 0,
          pinned: pins.has(session.id), activityUpdatedAt: session.metadata?.yuri?.titleRefresh?.activityUpdatedAt,
        }));
      const offset = Number(input.cursor ?? 0);
      return {
        sessions: rows.slice(offset, offset + 50),
        nextCursor: offset + 50 < rows.length ? String(offset + 50) : null,
        indexedOnly: true,
        historyComplete: scoped.length > 0 && scoped.every((item) => item.lastFullSyncedAt > 0 && !item.hasMore),
      };
    }
    const sessionID = input.sessionID;
    if (operation === 'session-state') {
      const hit = sessionIndexService.findBySessionId(sessionID);
      const stored = await sessionMetadataStore.get(sessionID);
      const stamp = stored?.yuri?.archive?.archivedAt;
      if (!hit && !Number.isFinite(stamp)) throw notFound();
      const view = await snapshot();
      const row = view.directories.flatMap((item) => item.sessions).find((item) => item.id === sessionID);
      return {
        sessionID, indexed: Boolean(row),
        archivedAt: Number.isFinite(stamp) ? stamp : hit.archivedAt,
        settled: row ? Number(row.time?.settled ?? 0) > 0 : null,
        pinned: row ? view.pinnedSessionIds.includes(sessionID) : null,
      };
    }
    if (operation === 'settle-session' || operation === 'unsettle-session') {
      const action = operation === 'settle-session' ? 'setSettled' : 'clearSettled';
      if (typeof sessionIndexService[action] !== 'function') throw unavailable();
      // The index writer accepts unknown IDs for pending state; this API confirms only existing sessions.
      const hit = sessionIndexService.findBySessionId(sessionID);
      if (!hit) throw notFound();
      const stored = await sessionMetadataStore.get(sessionID);
      if (Number(stored?.yuri?.archive?.archivedAt ?? hit.archivedAt) > 0) {
        throw Object.assign(new Error('Restore session archive first'), { code: 'session_archived', status: 409 });
      }
      if (!sessionIndexService[action](sessionID)) throw notFound();
      publishSessionIndexChange?.();
      return { sessionID, settled: operation === 'settle-session' };
    }
    const archived = operation === 'archive-session';
    const result = await sessionArchiveService.setArchive({
      sessionID, archivedAt: archived ? Date.now() : 0,
      ...(input.directory ? { directory: input.directory } : {}),
    });
    if (!Number.isFinite(result?.archivedAt) || (result.archivedAt > 0) !== archived
      || typeof result.index?.ok !== 'boolean') throw new Error('Session archive unconfirmed');
    return {
      sessionID, archived, archivedAt: result.archivedAt,
      index: result.index.ok ? { ok: true } : { ok: false, retryable: true },
    };
  };
}
