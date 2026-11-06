import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

// Receipts contain identities/status only, never transcript/config contents.
export function createImportStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS import_job (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, runtime TEXT NOT NULL,
    state TEXT NOT NULL, total INTEGER NOT NULL, created INTEGER NOT NULL
  ); CREATE TABLE IF NOT EXISTS import_receipt (
    job TEXT NOT NULL, position INTEGER NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY(job, position)
  );`);
  if (!db.prepare('PRAGMA table_info(import_job)').all().some((column) => column.name === 'progress')) db.exec('ALTER TABLE import_job ADD COLUMN progress TEXT');
  if (!db.prepare('PRAGMA table_info(import_job)').all().some((column) => column.name === 'request')) db.exec('ALTER TABLE import_job ADD COLUMN request TEXT');
  if (!db.prepare('PRAGMA table_info(import_job)').all().some((column) => column.name === 'dismissed')) db.exec('ALTER TABLE import_job ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0');
  db.prepare("UPDATE import_job SET state = 'interrupted' WHERE state = 'running'").run();
  const get = (id, owner, runtime) => {
    const row = db.prepare('SELECT * FROM import_job WHERE id = ? AND owner = ? AND runtime = ?').get(id, owner, runtime);
    if (!row) return null;
    const completed = db.prepare('SELECT COUNT(*) AS count FROM import_receipt WHERE job = ?').get(id).count;
    const recent = db.prepare('SELECT position, result FROM import_receipt WHERE job = ? ORDER BY position DESC LIMIT 40').all(id);
    const failures = db.prepare("SELECT position, result FROM import_receipt WHERE job = ? AND (json_extract(result, '$.status') = 'failed' OR json_extract(result, '$.project') = 'failed' OR json_extract(result, '$.index') = 'failed') ORDER BY position LIMIT 40").all(id);
    const results = [...new Map([...failures, ...recent].map((entry) => [entry.position, entry])).values()]
      .sort((left, right) => left.position - right.position).map((entry) => JSON.parse(entry.result));
    return { id: row.id, state: row.state, total: row.total, completed, created: row.created, results, resumable: Boolean(row.request) && !['completed', 'partial'].includes(row.state), dismissed: Boolean(row.dismissed),
      ...(row.progress ? { progress: JSON.parse(row.progress) } : {}) };
  };
  return {
    create: (id, owner, runtime, total, request = null) => db.prepare("INSERT INTO import_job (id, owner, runtime, state, total, created, request) VALUES (?, ?, ?, 'running', ?, ?, ?)").run(id, owner, runtime, total, Date.now(), request ? JSON.stringify(request) : null),
    request: (id, owner, runtime) => {
      const row = db.prepare('SELECT request FROM import_job WHERE id = ? AND owner = ? AND runtime = ?').get(id, owner, runtime);
      return row?.request ? JSON.parse(row.request) : null;
    },
    restart: db.transaction((id, request) => {
      db.prepare('DELETE FROM import_receipt WHERE job = ?').run(id);
      db.prepare("UPDATE import_job SET state = 'running', total = 0, progress = NULL, request = ? WHERE id = ?").run(JSON.stringify(request), id);
    }),
    progress: (id, progress, total = null) => db.prepare('UPDATE import_job SET progress = ?, total = COALESCE(?, total) WHERE id = ?').run(JSON.stringify(progress), total, id),
    append: (id, position, result) => db.prepare('INSERT INTO import_receipt VALUES (?, ?, ?)').run(id, position, JSON.stringify(result)),
    finish: (id, state) => db.prepare('UPDATE import_job SET state = ? WHERE id = ?').run(state, id),
    dismiss: (id, owner, runtime) => db.prepare("UPDATE import_job SET dismissed = 1 WHERE id = ? AND owner = ? AND runtime = ? AND state != 'running'").run(id, owner, runtime).changes > 0,
    latest: (owner, runtime) => {
      const row = db.prepare('SELECT id FROM import_job WHERE owner = ? AND runtime = ? AND dismissed = 0 ORDER BY created DESC LIMIT 1').get(owner, runtime);
      return row ? get(row.id, owner, runtime) : null;
    },
    unfinished: (owner, runtime) => db.prepare(`SELECT j.*, (SELECT COUNT(*) FROM import_receipt r WHERE r.job = j.id) AS completed,
      (SELECT COUNT(*) FROM import_receipt r WHERE r.job = j.id AND (json_extract(result, '$.status') = 'failed' OR json_extract(result, '$.project') = 'failed' OR json_extract(result, '$.index') = 'failed')) AS failures
      FROM import_job j WHERE owner = ? AND runtime = ? AND state NOT IN ('completed', 'partial') AND dismissed = 0 ORDER BY created`).all(owner, runtime)
      .map((row) => ({ id: row.id, state: row.state, total: row.total, completed: row.completed, created: row.created,
        results: [], failures: row.failures, resumable: Boolean(row.request), ...(row.progress ? { progress: JSON.parse(row.progress) } : {}) })),
    get,
    close: () => db.close(),
  };
}
