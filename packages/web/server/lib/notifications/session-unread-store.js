import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Durable attention, independent of notification delivery settings and client presence. */
export function createSessionUnreadStore({ dbPath, onChanged = () => {} }) {
  if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS unread_meta (id INTEGER PRIMARY KEY CHECK(id = 1), revision INTEGER NOT NULL);
    INSERT OR IGNORE INTO unread_meta VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS session_unread (
      id TEXT PRIMARY KEY, directory TEXT NOT NULL DEFAULT '',
      unreadCount INTEGER NOT NULL DEFAULT 0, hasError INTEGER NOT NULL DEFAULT 0,
      manual INTEGER NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 0,
      terminal INTEGER NOT NULL DEFAULT 0, eventAt INTEGER NOT NULL DEFAULT 0,
      sequence INTEGER NOT NULL DEFAULT 0
    );
  `);
  const find = db.prepare('SELECT * FROM session_unread WHERE id = ?');
  const revision = () => db.prepare('SELECT revision FROM unread_meta WHERE id = 1').get().revision;
  const publicRow = (row) => ({
    directory: row.directory, unreadCount: row.unreadCount, hasError: Boolean(row.hasError),
    manual: Boolean(row.manual), revision: row.revision,
  });
  const snapshot = () => ({
    revision: revision(),
    sessions: Object.fromEntries(db.prepare('SELECT * FROM session_unread').all().map(row => [row.id, publicRow(row)])),
  });
  const writeRow = db.prepare(`INSERT OR REPLACE INTO session_unread
    (id, directory, unreadCount, hasError, manual, revision, terminal, eventAt, sequence)
    VALUES (@id, @directory, @unreadCount, @hasError, @manual, @revision, @terminal, @eventAt, @sequence)`);
  const empty = (id) => ({ id, directory: '', unreadCount: 0, hasError: 0, manual: 0, revision: 0, terminal: 0, eventAt: 0, sequence: 0 });
  const commit = (decide) => {
    const changed = db.transaction(() => {
      const next = decide();
      if (!next) return false;
      if (next.publish) {
        db.prepare('UPDATE unread_meta SET revision = revision + 1 WHERE id = 1').run();
        next.row.revision = revision();
      }
      writeRow.run(next.row);
      return next.publish;
    })();
    if (changed) onChanged(revision());
  };
  return {
    snapshot,
    observe({ id, directory = '', kind, eventAt = 0, sequence = 0 }) {
      commit(() => {
        const current = find.get(id) ?? empty(id);
        if (sequence && sequence <= current.sequence) return null;
        if (!sequence && eventAt && eventAt < current.eventAt) return null;
        const row = { ...current, directory: directory || current.directory,
          eventAt: Math.max(eventAt, current.eventAt), sequence: Math.max(sequence, current.sequence) };
        if (kind === 'running') {
          row.terminal = 0;
          if (row.hasError) row.unreadCount = Math.max(0, row.unreadCount - 1);
          row.hasError = 0;
        } else if (!row.terminal) {
          row.terminal = 1;
          row.unreadCount += 1;
          if (kind === 'error') row.hasError = 1;
        }
        return { row, publish: row.unreadCount !== current.unreadCount || row.hasError !== current.hasError };
      });
    },
    mark({ id, directory = '', unread, expectedRevision }) {
      commit(() => {
        const current = find.get(id) ?? empty(id);
        // Read only the exact state the client observed, never a newer completion or manual mark.
        if (!unread && (expectedRevision !== current.revision || current.unreadCount === 0)) return null;
        return { row: { ...current, directory: directory || current.directory,
          unreadCount: unread ? Math.max(1, current.unreadCount) : 0,
          hasError: unread ? current.hasError : 0, manual: unread ? 1 : 0 }, publish: true };
      });
      return snapshot();
    },
    remove(id) {
      const changed = db.transaction(() => {
        if (!db.prepare('DELETE FROM session_unread WHERE id = ?').run(id).changes) return false;
        db.prepare('UPDATE unread_meta SET revision = revision + 1 WHERE id = 1').run();
        return true;
      })();
      if (changed) onChanged(revision());
    },
    close: () => db.close(),
  };
}
