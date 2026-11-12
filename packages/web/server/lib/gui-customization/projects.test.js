import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectRegistry } from '../projects/registry.js';
import { createProjectIdFromPath } from '../projects/project-id.js';
import { createSettingsRuntime } from '../opencode/settings-runtime.js';
import { createSettingsNormalizationRuntime } from '../opencode/settings-normalization-runtime.js';
import { createProjectDirectoryRuntime } from '../opencode/project-directory-runtime.js';
import { registerProjectsSkill, PROJECTS_SKILL_PATH } from './projects.js';

describe('session project registration API', () => {
  let root, workspace, settingsPath, runtime, server, origin, getSession, binding, registerProject, shared, failWrites, tips, gateway;
  const auth = { Authorization: `Basic ${Buffer.from('opencode:fixture').toString('base64')}` };
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-skill-'));
    workspace = path.join(root, '项目 & # 100%');
    await fs.mkdir(workspace);
    settingsPath = path.join(root, 'settings.json');
    const normalization = createSettingsNormalizationRuntime({ os, path, processLike: process });
    tips = vi.fn(); failWrites = false; shared = true;
    runtime = createSettingsRuntime({ fsPromises: { ...fs, rename: (...args) => failWrites ? Promise.reject(new Error('private-write-error')) : fs.rename(...args) },
      path, crypto, SETTINGS_FILE_PATH: settingsPath, ...normalization,
      sanitizeSettingsUpdate: (patch) => patch, mergePersistedSettings: (current, patch) => ({ ...current, ...patch }),
      formatSettingsResponse: (value) => value, resolveDirectoryCandidate: (value) => value, onProjectOrderChanged: tips,
    });
    const { validateDirectoryPath } = createProjectDirectoryRuntime({ fsPromises: fs, path, normalizeDirectoryPath: normalization.normalizeDirectoryPath });
    const registry = createProjectRegistry({ persistSettings: runtime.persistSettings, validateDirectoryPath });
    registerProject = vi.fn((input) => registry.register(input));
    getSession = vi.fn(async () => ({ metadata: { yuri: { scheduledTaskSkill: { hostOrigin: binding } } } }));
    const app = express();
    gateway = { supported: true, acquireTask: vi.fn(), registerProject: vi.fn(), list: vi.fn(async () => ({ supported: true, hubId: 'hub', hosts: [], projects: [] })) };
    registerProjectsSkill(app, { express, getIsSharedOpenCodeService: () => shared, getOpenCodeAuthHeaders: () => auth,
      createClient: () => ({ session: { get: getSession } }), registerProject, readSettingsFromDiskStrict: runtime.readSettingsFromDiskStrict,
      sanitizeProjects: normalization.sanitizeProjects,
      remoteHostGateway: gateway,
    });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    origin = `http://127.0.0.1:${server.address().port}`; binding = origin;
  });
  afterEach(async () => { await new Promise((resolve) => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const request = (operation, input = {}, headers = auth) => fetch(`${origin}${PROJECTS_SKILL_PATH}`, { method: 'POST',
    headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sessionID: 'ses_one', operation, input }) });

  it('confirms persisted registration, deduplicates canonical paths and preserves existing selection/settings', async () => {
    const oldPath = path.join(root, 'offline');
    const oldId = createProjectIdFromPath(oldPath);
    await fs.writeFile(settingsPath, JSON.stringify({ secret: 'private-settings', projects: [{ id: oldId, path: oldPath, label: 'Old' }], activeProjectId: oldId }));
    const response = await request('add', { path: workspace, label: 'App' });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const added = await response.json();
    expect(added).toEqual({ created: true, project: { id: expect.any(String), path: await fs.realpath(workspace), label: 'App' } });
    const alias = path.join(root, 'alias'); await fs.symlink(workspace, alias);
    expect(await (await request('add', { path: alias, label: 'Do not rename' })).json()).toEqual({ ...added, created: false });
    const persisted = await runtime.readSettingsFromDiskStrict();
    expect(persisted.projects).toHaveLength(2);
    expect(persisted.activeProjectId).toBe(oldId);
    expect(persisted.secret).toBe('private-settings');
    expect(tips).toHaveBeenCalledTimes(1);
    const listed = await (await request('list')).json();
    expect(listed.projects).toContainEqual(added.project);
    expect(JSON.stringify({ added, listed })).not.toContain('private-settings');
  });

  it('rejects invalid input and nonexistent/file paths without changing saved state', async () => {
    await fs.writeFile(settingsPath, JSON.stringify({ projects: [], secret: 'saved' }));
    const before = await fs.readFile(settingsPath, 'utf8');
    for (const input of [{}, [], null, { path: 'relative' }, { path: workspace, activate: true }, { path: workspace, label: '' },
      { path: workspace, label: 'x'.repeat(81) }, { path: workspace + '\u0000' }, { path: path.join(root, 'missing') }, { path: settingsPath }]) {
      expect((await request('add', input)).status).toBe(400);
    }
    expect((await request('remove', { path: workspace })).status).toBe(400);
    expect((await request('list', { path: workspace })).status).toBe(400);
    expect(await fs.readFile(settingsPath, 'utf8')).toBe(before);
    expect(tips).not.toHaveBeenCalled();
  });

  it('requires service authentication, shared ownership and the admitted Host before registration', async () => {
    for (const headers of [{}, { Authorization: 'Bearer browser' }, { ...auth, Origin: origin }]) expect((await request('add', { path: workspace }, headers)).status).toBe(403);
    shared = false;
    expect((await request('describe')).status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
    shared = true; binding = 'http://127.0.0.1:1';
    for (const operation of ['describe', 'list', 'add']) expect((await request(operation, operation === 'add' ? { path: workspace } : {})).status).toBe(403);
    expect(registerProject).not.toHaveBeenCalled();
  });

  it('keeps remote discovery under the existing service and per-session admission gate', async () => {
    expect(await (await request('describe')).json()).toMatchObject({ remoteSupported: true });
    expect(await (await request('remote-projects')).json()).toEqual({ projects: [], failed: [], complete: true });
    gateway.list.mockClear();
    for (const headers of [{}, { Authorization: 'Bearer browser' }, { ...auth, Origin: origin }]) expect((await request('remote-projects', {}, headers)).status).toBe(403);
    binding = 'http://127.0.0.1:1';
    expect((await request('remote-projects')).status).toBe(403);
    expect(gateway.list).not.toHaveBeenCalled();
    expect(gateway.acquireTask).not.toHaveBeenCalled();
  });

  it('advertises and gates remote machine discovery and registration independently of local registration', async () => {
    const target = { hubId: 'hub', hostId: 'host', instanceId: 'instance' };
    const input = { target, path: '/remote/repo', label: 'Remote' };
    const described = await (await request('describe')).json();
    expect(described.inputs).toMatchObject({ 'remote-hosts': '{}', 'add-remote': expect.stringContaining('instanceId') });
    expect(await (await request('remote-hosts')).json()).toEqual({ hosts: [], failed: [], complete: true });
    gateway.registerProject.mockResolvedValue({ project: { id: 'remote-ref', path: input.path, hostId: target.hostId }, created: true });
    expect(await (await request('add-remote', input)).json()).toMatchObject({ project: { id: 'remote-ref', path: input.path }, created: true, target });
    expect(gateway.registerProject).toHaveBeenCalledExactlyOnceWith('host', { path: input.path, label: 'Remote' }, { instanceId: 'instance', signal: expect.any(AbortSignal) });
    expect(registerProject).not.toHaveBeenCalled();
    for (const value of [{ ...input, path: 'relative' }, { ...input, target: { hostId: 'host' } }, { ...input, label: '' }, { ...input, activate: true }]) expect((await request('add-remote', value)).status).toBe(400);
    for (const operation of ['remote-hosts', 'add-remote']) {
      for (const headers of [{}, { Authorization: 'Bearer browser' }, { ...auth, Origin: origin }]) expect((await request(operation, operation === 'add-remote' ? input : {}, headers)).status).toBe(403);
    }
    gateway.registerProject.mockRejectedValueOnce(new Error('private-token /local/path'));
    const failed = await request('add-remote', input);
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toMatch(/private-token|local\/path/);
    binding = 'http://127.0.0.1:1';
    expect((await request('add-remote', input)).status).toBe(403);
    expect((await request('remote-hosts')).status).toBe(403);
    expect(gateway.registerProject).toHaveBeenCalledTimes(2);
  });

  it('never reports corrupt reads or failed persistence as successful empty or added results', async () => {
    for (const corrupt of ['{broken', '[]', 'null', '{"projects":{}}']) {
      await fs.writeFile(settingsPath, corrupt);
      expect((await request('list')).status).toBe(503);
      expect(await fs.readFile(settingsPath, 'utf8')).toBe(corrupt);
    }
    await fs.writeFile(settingsPath, '{"projects":[]}');
    failWrites = true;
    const response = await request('add', { path: workspace });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-write-error');
    expect(await fs.readFile(settingsPath, 'utf8')).toBe('{"projects":[]}');
    expect(tips).not.toHaveBeenCalled();
  });

  it('releases remote task demand when the bound caller disconnects', async () => {
    const target = { hubId: 'hub', hostId: 'host', instanceId: 'instance' };
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    let released;
    const stopped = new Promise((resolve) => { released = resolve; });
    const release = vi.fn(released);
    gateway.assertProjectDirectory = vi.fn();
    gateway.acquireTask.mockImplementation(async (_id, { signal }) => ({ target, release,
      request: async () => {
        entered();
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
      },
    }));
    const controller = new AbortController();
    const pending = fetch(`${origin}${PROJECTS_SKILL_PATH}`, { method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ sessionID: 'ses_one', operation: 'sessions', input: { target, directory: '/repo' } }),
    }).catch(() => null);
    await started;
    controller.abort();
    await pending;
    await stopped;
    expect(release).toHaveBeenCalledOnce();
  });
});
