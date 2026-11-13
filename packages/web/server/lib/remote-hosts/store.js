import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const metadataKeys = ['label', 'icon', 'iconImage', 'iconBackground', 'color'];
export const projectMetadata = (value) => Object.fromEntries(metadataKeys
  .filter((key) => Object.hasOwn(value || {}, key)).map((key) => [key, value[key]]));

// This database has deliberately no message/part/body columns. Only the remote
// authority's presentation metadata and connection receipts can cross this seam.
export function createRemoteHostStore(dbPath) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS remote_project (
    id TEXT PRIMARY KEY, host_id TEXT NOT NULL, path TEXT NOT NULL,
    remote_project_id TEXT NOT NULL, metadata TEXT NOT NULL, state TEXT NOT NULL,
    added_at INTEGER NOT NULL, UNIQUE(host_id, path));
    CREATE TABLE IF NOT EXISTS remote_host_receipt (
      host_id TEXT PRIMARY KEY, connected_at INTEGER, synced_at INTEGER,
      error_code TEXT, error_message TEXT);
    CREATE TABLE IF NOT EXISTS remote_hub_identity (id TEXT PRIMARY KEY);`);
  db.exec(`CREATE TABLE IF NOT EXISTS remote_organization (
    host_id TEXT NOT NULL, kind TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(host_id, kind));`);
  db.exec('CREATE TABLE IF NOT EXISTS remote_host_display (id TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL)');
  db.exec('CREATE TABLE IF NOT EXISTS remote_host_authority (host_id TEXT PRIMARY KEY, instance_id TEXT NOT NULL)');
  db.prepare('INSERT INTO remote_hub_identity(id) SELECT ? WHERE NOT EXISTS (SELECT 1 FROM remote_hub_identity)')
    .run(crypto.randomUUID());
  const hubId = db.prepare('SELECT id FROM remote_hub_identity').get().id;
  const instanceFor = (hostId) => db.prepare('SELECT instance_id FROM remote_host_authority WHERE host_id = ?').get(hostId)?.instance_id;
  const decode = (row) => row && ({ id: row.id, hostId: row.host_id, path: row.path,
    ...(row.instance_id ? { instanceId: row.instance_id } : {}),
    remoteProjectId: row.remote_project_id, remoteState: row.state,
    ...JSON.parse(row.metadata), addedAt: row.added_at, lastOpenedAt: row.added_at });
  const projects = (hostId) => (hostId
    ? db.prepare('SELECT p.*, a.instance_id FROM remote_project p LEFT JOIN remote_host_authority a ON a.host_id = p.host_id WHERE p.host_id = ? ORDER BY p.added_at, p.id').all(hostId)
    : db.prepare('SELECT p.*, a.instance_id FROM remote_project p LEFT JOIN remote_host_authority a ON a.host_id = p.host_id ORDER BY p.added_at, p.id').all()).map(decode);
  return {
    hubId, projects, instanceFor,
    bindInstance(hostId, instanceId) {
      if (typeof instanceId !== 'string' || !instanceId.trim() || instanceId !== instanceId.trim()
        || instanceId.length > 512 || /[\x00-\x1f]/.test(instanceId)) {
        throw Object.assign(new Error('remote_incompatible'), { code: 'remote_incompatible', status: 409 });
      }
      db.prepare('INSERT OR IGNORE INTO remote_host_authority(host_id, instance_id) VALUES (?, ?)').run(hostId, instanceId);
      if (instanceFor(hostId) !== instanceId) {
        throw Object.assign(new Error('remote_instance_mismatch'), { code: 'remote_instance_mismatch', status: 409 });
      }
      return instanceId;
    },
    hasProjects() { return Boolean(db.prepare('SELECT 1 FROM remote_project LIMIT 1').get()); },
    saveHost(host) {
      db.prepare(`INSERT INTO remote_host_display VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,
        source=excluded.source WHERE name != excluded.name OR source != excluded.source`)
        .run(host.id, host.name || host.label || host.id, host.source);
    },
    savedHosts() { return db.prepare('SELECT id, name, source FROM remote_host_display').all(); },
    organization(hostId) {
      return Object.fromEntries(db.prepare('SELECT kind, snapshot FROM remote_organization WHERE host_id = ?').all(hostId)
        .map((row) => [row.kind, JSON.parse(row.snapshot)]));
    },
    saveOrganization(hostId, kind, input) {
      const text = (value) => typeof value === 'string' ? value.slice(0, 4096) : '';
      let snapshot;
      if (kind === 'unread') snapshot = { revision: Number(input.revision) || 0,
        sessions: Object.fromEntries(Object.entries(input.sessions || {}).map(([id, row]) => [text(id), {
          directory: text(row.directory), unreadCount: Number(row.unreadCount) || 0, hasError: row.hasError === true,
          manual: row.manual === true, revision: Number(row.revision) || 0,
        }])) };
      if (kind === 'folders') snapshot = { version: 1, updatedAt: Number(input.updatedAt) || 0,
        foldersMap: Object.fromEntries(Object.entries(input.foldersMap || {}).filter(([, rows]) => Array.isArray(rows))
          .map(([scope, rows]) => [text(scope), rows.map((row) => ({ id: text(row.id), name: text(row.name),
            sessionIds: (row.sessionIds || []).filter((id) => typeof id === 'string').map(text),
            createdAt: Number(row.createdAt) || 0, parentId: row.parentId ? text(row.parentId) : null }))])),
        collapsedFolderIds: (input.collapsedFolderIds || []).filter((id) => typeof id === 'string').map(text) };
      if (kind === 'order') snapshot = { revision: Number(input.revision) || 0,
        sessionOrderByScope: Object.fromEntries(Object.entries(input.sessionOrderByScope || {}).filter(([, rows]) => Array.isArray(rows))
          .map(([scope, rows]) => [text(scope), rows.filter((id) => typeof id === 'string').map(text)])),
        sessionOrderActivityByScope: Object.fromEntries(Object.entries(input.sessionOrderActivityByScope || {})
          .map(([scope, values]) => [text(scope), Object.fromEntries(Object.entries(values || {})
             .filter(([, value]) => typeof value === 'number' && Number.isFinite(value)))])) };
      if (kind === 'worktrees') snapshot = {
        projectDirectories: Object.fromEntries(Object.entries(input.projectDirectories || {}).filter(([, rows]) => Array.isArray(rows))
          .map(([root, rows]) => [text(root), [...new Set(rows.filter((value) => typeof value === 'string' && value).map(text))]])),
        staleProjectDirectories: (input.staleProjectDirectories || []).filter((value) => typeof value === 'string').map(text),
      };
      if (!snapshot) throw new Error('Invalid organization kind');
      db.prepare('INSERT OR REPLACE INTO remote_organization VALUES (?, ?, ?)').run(hostId, kind, JSON.stringify(snapshot));
    },
    saveProject(hostId, remote) {
      const prior = projects(hostId).find((p) => p.path === remote.path);
      const id = prior?.id || `remote-${crypto.createHash('sha256').update(JSON.stringify([hubId, hostId, remote.path])).digest('hex').slice(0, 24)}`;
      db.prepare(`INSERT INTO remote_project VALUES (?, ?, ?, ?, ?, 'ok', ?)
        ON CONFLICT(host_id, path) DO UPDATE SET remote_project_id=excluded.remote_project_id,
        metadata=excluded.metadata, state='ok'`).run(id, hostId, remote.path, remote.id,
        JSON.stringify(projectMetadata(remote)), prior?.addedAt || Date.now());
      return projects(hostId).find((p) => p.id === id);
    },
    refreshProject(reference, remote) {
      if (remote?.path !== reference.path || !remote?.id || remote.hostId) return null;
      const updated = db.prepare(`UPDATE remote_project SET remote_project_id = ?, metadata = ?, state = 'ok'
        WHERE id = ? AND host_id = ? AND path = ? AND added_at = ? AND remote_project_id = ?`).run(remote.id,
        JSON.stringify(projectMetadata(remote)), reference.id, reference.hostId, reference.path, reference.addedAt, reference.remoteProjectId);
      return updated.changes ? projects(reference.hostId).find((p) => p.id === reference.id) : null;
    },
    markProject(id, state) { db.prepare('UPDATE remote_project SET state = ? WHERE id = ?').run(state, id); },
    removeProject(hostId, id) { return db.prepare('DELETE FROM remote_project WHERE host_id = ? AND id = ?').run(hostId, id).changes > 0; },
    receipt(hostId) {
      const row = db.prepare('SELECT * FROM remote_host_receipt WHERE host_id = ?').get(hostId);
      return row ? { lastConnectedAt: row.connected_at || undefined, lastSyncedAt: row.synced_at || undefined,
        ...(row.error_code ? { lastError: { code: row.error_code, message: row.error_message } } : {}) } : {};
    },
    saveReceipt(hostId, input) {
      const previous = this.receipt(hostId);
      const value = { ...previous, ...input };
      db.prepare(`INSERT INTO remote_host_receipt VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(host_id) DO UPDATE SET connected_at=excluded.connected_at,
        synced_at=excluded.synced_at, error_code=excluded.error_code, error_message=excluded.error_message`)
        .run(hostId, value.lastConnectedAt || null, value.lastSyncedAt || null,
          value.lastError?.code || null, value.lastError?.message || null);
    },
    close() { db.close(); },
  };
}
