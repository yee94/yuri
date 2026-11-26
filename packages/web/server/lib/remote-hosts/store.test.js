import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRemoteHostStore } from './store.js';

it('pins authenticated instance identity across reopen and preserves legacy project references', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-store-authority-'));
  const dbPath = path.join(root, 'remote.sqlite');
  let store = createRemoteHostStore(dbPath);
  try {
    const reference = store.saveProject('ssh', { id: 'project', path: '/same/path' });
    expect(reference.instanceId).toBeUndefined();
    store.bindInstance('ssh', 'machine-a');
    store.bindInstance('relay', 'machine-a');
    expect(store.projects('ssh')[0]).toMatchObject({ id: reference.id, instanceId: 'machine-a' });
    store.close(); store = createRemoteHostStore(dbPath);
    expect(store.bindInstance('ssh', 'machine-a')).toBe('machine-a');
    expect(() => store.bindInstance('ssh', 'machine-b')).toThrow('remote_instance_mismatch');
    expect(store.projects('ssh')[0]).toMatchObject({ id: reference.id, instanceId: 'machine-a' });
    for (const malformed of ['', ' bad', 'bad\nvalue', null]) expect(() => store.bindInstance('invalid', malformed)).toThrow('remote_incompatible');
    expect(store.instanceFor('invalid')).toBeUndefined();
  } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it('migrates legacy references in place and keeps single-path uniqueness', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-store-migrate-'));
  const dbPath = path.join(root, 'remote.sqlite');
  const { createRequire } = await import('node:module');
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const legacy = new Database(dbPath);
  legacy.exec(`CREATE TABLE remote_project (id TEXT PRIMARY KEY, host_id TEXT NOT NULL, path TEXT NOT NULL,
    remote_project_id TEXT NOT NULL, metadata TEXT NOT NULL, state TEXT NOT NULL, added_at INTEGER NOT NULL, UNIQUE(host_id, path))`);
  legacy.prepare("INSERT INTO remote_project VALUES ('remote-old', 'host', '/repo', 'p1', '{\"label\":\"Repo\"}', 'ok', 5)").run();
  legacy.close();
  let store = createRemoteHostStore(dbPath);
  try {
    expect(store.projects('host')).toEqual([expect.objectContaining({ id: 'remote-old', path: '/repo', label: 'Repo', addedAt: 5 })]);
    expect(store.projects('host')[0].paths).toBeUndefined();
    expect(store.saveProject('host', { id: 'p1', path: '/repo', label: 'Again' }).id).toBe('remote-old');
    expect(store.projects('host')).toHaveLength(1);
    store.close(); store = createRemoteHostStore(dbPath);
    expect(store.projects('host')).toEqual([expect.objectContaining({ id: 'remote-old', label: 'Again' })]);
  } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it('keeps a same-Host workspace beside a single project at its primary path and follows primary moves by remote ID', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-store-workspace-'));
  const dbPath = path.join(root, 'remote.sqlite');
  let store = createRemoteHostStore(dbPath);
  try {
    const single = store.saveProject('host', { id: 'p-repo', path: '/repo' });
    const workspace = store.saveProject('host', { id: 'ws_1', path: '/repo', paths: ['/repo', '/lib'], label: 'Both' });
    expect(workspace.id).not.toBe(single.id);
    expect(workspace).toMatchObject({ path: '/repo', paths: ['/repo', '/lib'], remoteProjectId: 'ws_1', label: 'Both' });
    expect(store.findProject('host', { id: 'ws_1', path: '/elsewhere', paths: ['/elsewhere'] })?.id).toBe(workspace.id);
    expect(store.findProject('host', { id: 'p-repo', path: '/repo' })?.id).toBe(single.id);
    const moved = store.refreshProject(workspace, { id: 'ws_1', path: '/lib', paths: ['/lib', '/repo'], label: 'Both' });
    expect(moved).toMatchObject({ id: workspace.id, path: '/lib', paths: ['/lib', '/repo'] });
    expect(store.refreshProject(moved, { id: 'ws_other', path: '/lib', paths: ['/lib'] })).toBeNull();
    expect(store.refreshProject(moved, { id: 'ws_1', path: '/lib', paths: ['/lib', '/lib'] })).toBeNull();
    expect(store.saveProject('host', { id: 'ws_1', path: '/lib', paths: ['/lib', '/repo'] }).id).toBe(workspace.id);
    expect(store.projects('host')).toHaveLength(2);
    store.close(); store = createRemoteHostStore(dbPath);
    expect(store.projects('host').find((p) => p.id === workspace.id)?.paths).toEqual(['/lib', '/repo']);
  } finally { store.close(); await fs.rm(root, { recursive: true, force: true }); }
});

it('projects the SQLite hint and never revives a removed or replaced reference during metadata refresh', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-store-refresh-'));
  const dbPath = path.join(root, 'remote.sqlite');
  let store = createRemoteHostStore(dbPath);
  const now = vi.spyOn(Date, 'now').mockReturnValue(100);
  try {
    expect(store.hasProjects()).toBe(false);
    const remote = { id: 'project', path: '/remote-only', label: 'original' };
    const reference = store.saveProject('host', remote);
    const hubId = store.hubId;
    expect(store.hasProjects()).toBe(true);
    expect(store.refreshProject(reference, { ...remote, label: 'updated' }).label).toBe('updated');
    expect(store.refreshProject({ ...reference, remoteProjectId: 'stale-remote-id' }, remote)).toBeNull();
    store.removeProject('host', reference.id);
    expect(store.refreshProject(reference, { ...remote, label: 'late' })).toBeNull();
    expect(store.hasProjects()).toBe(false);
    now.mockReturnValue(200);
    const replacement = store.saveProject('host', { ...remote, label: 'new association' });
    expect(replacement.id).toBe(reference.id);
    expect(store.refreshProject(reference, { ...remote, label: 'stale' })).toBeNull();
    expect(store.projects()[0].label).toBe('new association');
    expect(store.refreshProject(replacement, { ...remote, path: '/wrong-path' })).toBeNull();
    store.close(); store = createRemoteHostStore(dbPath);
    expect(store.hubId).toBe(hubId); expect(store.hasProjects()).toBe(true);
    store.removeProject('host', replacement.id); expect(store.hasProjects()).toBe(false);
  } finally { now.mockRestore(); store.close(); await fs.rm(root, { recursive: true, force: true }); }
});
