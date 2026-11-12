import { it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRemoteHostStore } from './store.js';

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
