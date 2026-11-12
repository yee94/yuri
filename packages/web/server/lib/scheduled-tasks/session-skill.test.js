import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { OpenCode } from '@opencode/client';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerAuthAndAccessRoutes } from '../opencode/core-routes.js';
import { createProjectConfigRuntime } from '../projects/project-config.js';
import { registerScheduledTaskRoutes } from './routes.js';
import { registerScheduledTaskSessionSkill } from './session-skill.js';
import { authorizeScheduledTaskSkillRequest, SCHEDULED_TASK_SKILL_PATH } from './session-skill-contract.js';
import { registerRemoteConnectionsSkill, REMOTE_CONNECTIONS_SKILL_PATH } from '../gui-customization/remote-connections.js';
import { registerProjectsSkill, PROJECTS_SKILL_PATH } from '../gui-customization/projects.js';

describe('built-in session skill with authenticated Host', () => {
  let root, server, origin, ui, sessions, entries, store, password, auth, registrationFile, sdk, sync, failInstructions, failCleanup, connections, registerProject, remoteGateway;
  const upstreamOrigin = 'http://127.0.0.1:4096';
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'session-skill-'));
    vi.stubEnv('YURI_DATA_DIR', root);
    await fs.mkdir(path.join(root, 'project-a'));
    await fs.mkdir(path.join(root, 'project-b'));
    const projects = ['a', 'b'].map((id) => ({ id, path: path.join(root, `project-${id}`) }));
    password = randomUUID();
    auth = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
    registrationFile = path.join(root, 'service.json');
    await fs.writeFile(registrationFile, JSON.stringify({ url: upstreamOrigin, password }), { mode: 0o600 });
    sessions = new Map(); entries = new Map(); failInstructions = false; failCleanup = false;
    sdk = {
      session: {
        create: vi.fn(async (input) => {
          const session = { ...input, id: input.id ?? `ses_${randomUUID()}`, model: { providerID: 'test', id: 'model', variant: 'high' }, agent: 'build' };
          sessions.set(session.id, session);
          return session;
        }),
        get: vi.fn(async ({ sessionID }) => {
          if (!sessions.has(sessionID)) throw new Error('Not found');
          return sessions.get(sessionID);
        }),
        remove: vi.fn(async ({ sessionID }) => {
          if (failCleanup) throw new Error('Unavailable');
          sessions.delete(sessionID); entries.delete(sessionID);
        }),
        instructions: { entry: { put: vi.fn(async ({ sessionID, key, value }) => {
          if (failInstructions) throw new Error('Instructions unavailable');
          entries.set(key === 'yuri.customization' ? `${sessionID}:customization` : sessionID, value);
        }) } },
      },
    };
    const app = express();
    registerAuthAndAccessRoutes(app, {
      express,
      tunnelAuthController: { classifyRequestScope: () => 'local' },
      uiAuthController: createUiAuth({
        password: randomUUID(),
        clientAuthController: { authenticateBearerToken: async (token) => token === 'test-browser-client' ? { ok: true, clientId: 'browser' } : null },
      }),
      getScheduledTaskSkillAuthHeaders: () => auth,
    });
    store = createProjectConfigRuntime({ fsPromises: fs, path, projectsDirPath: path.join(root, 'projects') });
    sync = vi.fn(async () => {});
    const common = {
      readSettingsFromDiskMigrated: async () => ({ projects }), sanitizeProjects: (projects) => projects,
      buildOpenCodeUrl: () => upstreamOrigin, getOpenCodeAuthHeaders: () => auth,
    };
    const router = express.Router();
    registerProject = vi.fn(async (input) => ({ project: { id: 'registered', ...input }, created: true, settings: { password } }));
    remoteGateway = { supported: false, acquireTask: vi.fn(), registerProject: vi.fn(), list: vi.fn() };
    registerProjectsSkill(app, { express, getIsSharedOpenCodeService: () => true, getOpenCodeAuthHeaders: () => auth, createClient: () => sdk,
      registerProject, readSettingsFromDiskStrict: common.readSettingsFromDiskMigrated, sanitizeProjects: common.sanitizeProjects, remoteHostGateway: remoteGateway });
    connections = { list: vi.fn(async () => ({ instances: [] })), setup: vi.fn(async () => ({ id: 'ssh_one', running: true })),
      pair: vi.fn(async () => ({ url: 'yuri://connect?v=2&p=fixture', expiresAt: '2099-01-01' })) };
    registerRemoteConnectionsSkill(app, { express, adapter: connections, getIsSharedOpenCodeService: () => true, getOpenCodeAuthHeaders: () => auth, createClient: () => sdk });
    registerScheduledTaskRoutes(router, {
      ...common, projectConfigRuntime: store, scheduledTasksRuntime: { syncProject: sync },
      loadCatalog: async () => ({ models: [{ providerID: 'test', modelID: 'model' }] }),
    });
    registerScheduledTaskSessionSkill(app, {
      ...common, express, yuriDataDir: root, registrationFile,
      getIsSharedOpenCodeService: () => true, waitForOpenCodeReady: async () => {},
      createClient: () => sdk, scheduledTaskRouter: router,
      remoteConnectionsAdapter: connections,
      validateDirectoryPath: async (directory) => {
        try { return { ok: true, directory: await fs.realpath(directory) }; } catch { return { ok: false }; }
      },
    });
    app.use(router);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    origin = `http://127.0.0.1:${server.address().port}`;
    ui = OpenCode.make({ baseUrl: origin, headers: { Authorization: 'Bearer test-browser-client' } });
  });
  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });
  const create = (project = 'a') => ui.session.create({ location: { directory: path.join(root, `project-${project}`) }, title: 'User session', metadata: { existing: true } });
  const run = (command, input) => new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try { resolve({ code, stdout, stderr, value: JSON.parse(code === 0 ? stdout : stderr) }); }
      catch (error) { reject(error); }
    });
    child.stdin.end(input ? JSON.stringify(input) : '');
  });
  const commands = async (session) => {
    const describe = entries.get(session.id).split('\n')[1];
    const result = await run(describe);
    expect(result.code).toBe(0);
    return { describe, ...result.value.commands };
  };
  const task = { name: 'Daily review', enabled: false, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { prompt: 'Review the project and produce a report.' } };

  it('adds a small on-demand entry to new sessions in different projects, without credentials', async () => {
    for (const project of ['a', 'b']) {
      const session = await create(project);
      expect(session.metadata.existing).toBe(true);
      expect(entries.get(session.id)).not.toContain(password);
      expect(entries.get(session.id)).not.toContain(auth.Authorization);
      expect(entries.get(session.id)).not.toContain('IANA');
      expect(entries.get(`${session.id}:customization`)).toContain('yuri-customization');
      expect(entries.get(`${session.id}:customization`)).not.toContain(password);
      const described = await run((await commands(session)).describe);
      expect(described.code).toBe(0);
      expect(described.value.project.id).toBe(project);
      expect(described.value.skill).toContain('IANA');
    }
  });

  it('creates and reads back through the exact advertised commands with password auth enabled', async () => {
    const anonymous = await fetch(`${origin}/api/projects/a/scheduled-tasks`);
    expect(anonymous.status).toBe(401);
    const session = await create();
    const cmd = await commands(session);
    const result = await run(cmd.create, task);
    expect(result.code).toBe(0);
    expect(result.value.schedulerSynced).toBe(true);
    const saved = (await store.listScheduledTasks('a'))[0];
    expect(saved.execution).toMatchObject({ ...task.execution, providerID: 'test', modelID: 'model', agent: 'build', variant: 'high' });
    expect(saved.id).toBe(result.value.task.id);
    expect(await store.listScheduledTasks('b')).toEqual([]);
    const listed = await run(cmd.list);
    expect(listed.value.tasks[0].id).toBe(saved.id);
    expect(result.stdout + listed.stdout).not.toContain(password);
    expect(result.stdout + listed.stdout).not.toContain(task.execution.prompt);
    const duplicate = await fetch(`${origin}${SCHEDULED_TASK_SKILL_PATH}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...auth },
      body: JSON.stringify({ sessionID: session.id, operation: 'create', taskID: saved.id, input: { ...task, name: 'Overwrite' } }),
    });
    expect(duplicate.status).toBe(409);
    expect((await store.listScheduledTasks('a'))[0].name).toBe(task.name);
  });

  it('does not accept UI credentials, anonymous calls or browser origins on the bridge', async () => {
    const session = await create();
    for (const headers of [{}, { Authorization: 'Bearer test-browser-client' }, { ...auth, Origin: origin }]) {
      const response = await fetch(`${origin}${SCHEDULED_TASK_SKILL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ operation: 'check', sessionID: session.id }) });
      expect(response.status).toBe(403);
    }
    expect(authorizeScheduledTaskSkillRequest({ method: 'POST', headers: { authorization: auth.Authorization }, socket: { remoteAddress: '192.0.2.1' } }, auth)).toBe(false);
  });

  it('executes the staged remote helper through the real API auth gate and session binding', async () => {
    const session = await create();
    const pointer = entries.get(`${session.id}:customization`);
    expect(pointer).not.toContain(password);
    const command = pointer.split('Bound local desktop helper: ')[1];
    const described = await run(command);
    expect(described.code).toBe(0);
    expect(described.value.supported).toBe(true);
    expect(Object.keys(described.value.commands)).toEqual(['list', 'setup', 'pair']);
    const { commands: cmd } = described.value;
    expect((await run(cmd.list)).value).toEqual({ instances: [] });
    expect((await run(cmd.setup, { sshCommand: 'ssh user@host' })).value).toEqual({ id: 'ssh_one', running: true });
    expect(connections.setup).toHaveBeenCalledExactlyOnceWith({ sshCommand: 'ssh user@host' });
    expect((await run(cmd.pair, {})).value.url).toContain('yuri://connect');
    for (const headers of [{}, { Authorization: 'Bearer test-browser-client' }, { ...auth, Origin: origin }, { Authorization: 'Basic wrong' }]) {
      const response = await fetch(`${origin}${REMOTE_CONNECTIONS_SKILL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sessionID: session.id, operation: 'setup', input: { sshCommand: 'host' } }) });
      expect(response.status).toBe(403);
    }
    expect(connections.setup).toHaveBeenCalledTimes(1);
    sessions.get(session.id).metadata.yuri.scheduledTaskSkill.hostOrigin = 'http://127.0.0.1:1';
    const denied = await run(cmd.setup, { sshCommand: 'host' });
    expect(denied.code).toBe(1);
    expect(denied.value).toMatchObject({ status: 403, terminal: true });
    expect(denied.value.recovery).toContain('Stop this workflow');
    expect(denied.value.recovery).not.toContain('Use the bound list');
    expect(denied.stdout + denied.stderr).not.toContain(password);
    expect(connections.setup).toHaveBeenCalledTimes(1);
  });

  it('executes the exact staged project API helper and refuses browser credentials or changed Host/service bindings', async () => {
    const session = await create();
    const pointer = entries.get(`${session.id}:customization`);
    const command = pointer.split('Bound project helper: ')[1].split('\n')[0];
    const described = await run(command);
    expect(described.code).toBe(0);
    expect(described.value.supported).toBe(true);
    expect(Object.keys(described.value.commands)).toEqual(['list', 'add']);
    const { commands: cmd } = described.value;
    expect((await run(cmd.list)).value.projects).toHaveLength(2);
    const input = { path: path.join(root, 'project-b'), label: 'Existing project' };
    const added = await run(cmd.add, input);
    expect(added.value).toEqual({ project: { id: 'registered', ...input }, created: true });
    expect(registerProject).toHaveBeenCalledExactlyOnceWith(input);
    expect(added.stdout + pointer).not.toContain(password);
    for (const headers of [{}, { Authorization: 'Bearer test-browser-client' }, { ...auth, Origin: origin }, { Authorization: 'Basic wrong' }]) {
      const response = await fetch(`${origin}${PROJECTS_SKILL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ sessionID: session.id, operation: 'add', input }) });
      expect(response.status).toBe(403);
    }
    sessions.get(session.id).metadata.yuri.scheduledTaskSkill.hostOrigin = 'http://127.0.0.1:1';
    expect((await run(cmd.add, input)).value).toMatchObject({ status: 403, terminal: true });
    expect(registerProject).toHaveBeenCalledTimes(1);
    await fs.writeFile(registrationFile, JSON.stringify({ url: 'http://127.0.0.1:1', password }));
    const stale = await run(cmd.add, input);
    expect(stale.value.terminal).toBe(true);
    expect(stale.stdout + stale.stderr).not.toContain(password);
    expect(registerProject).toHaveBeenCalledTimes(1);
  });

  it('runs remote discovery and project registration through the exact staged commands and real auth gate', async () => {
    const target = { hubId: 'hub', hostId: 'host', instanceId: 'instance' };
    const release = vi.fn();
    remoteGateway.supported = true;
    remoteGateway.list.mockResolvedValue({ supported: true, hubId: target.hubId, hosts: [{ id: target.hostId, name: 'Build machine', source: 'ssh' }], projects: [] });
    remoteGateway.acquireTask.mockResolvedValue({ target, release });
    remoteGateway.registerProject.mockResolvedValue({ project: { id: 'remote-ref', hostId: target.hostId, path: '/remote/repo' }, created: true });
    const session = await create();
    const pointer = entries.get(`${session.id}:customization`);
    const command = pointer.split('Bound project helper: ')[1].split('\n')[0];
    const described = await run(command);
    expect(described.code).toBe(0);
    expect(described.value.remoteSupported).toBe(true);
    const cmd = described.value.commands;
    expect(cmd['remote-hosts']).toBeTypeOf('string');
    expect(cmd['add-remote']).toBeTypeOf('string');
    const discovered = await run(cmd['remote-hosts']);
    expect(discovered).toMatchObject({ code: 0, value: { hosts: [{ name: 'Build machine', target }], complete: true } });
    expect(release).toHaveBeenCalledOnce();
    const input = { target: discovered.value.hosts[0].target, path: '/remote/repo' };
    const added = await run(cmd['add-remote'], input);
    expect(added).toMatchObject({ code: 0, value: { project: { id: 'remote-ref', path: input.path }, created: true, target } });
    expect(remoteGateway.registerProject).toHaveBeenCalledExactlyOnceWith('host', { path: input.path }, { instanceId: 'instance', signal: expect.any(AbortSignal) });
    expect(registerProject).not.toHaveBeenCalled();
    expect(pointer + discovered.stdout + added.stdout + added.stderr).not.toContain(password);
    sessions.get(session.id).metadata.yuri.scheduledTaskSkill.hostOrigin = 'http://127.0.0.1:1';
    expect((await run(cmd['add-remote'], input)).value).toMatchObject({ status: 403, terminal: true });
    expect(remoteGateway.registerProject).toHaveBeenCalledOnce();
  });

  it('rejects unbounded connection input and sanitizes remote errors', async () => {
    const session = await create();
    const request = (operation, input) => fetch(`${origin}${REMOTE_CONNECTIONS_SKILL_PATH}`, { method: 'POST',
      headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ sessionID: session.id, operation, input }) });
    for (const input of [{}, { id: 'one', sshCommand: 'host' }, { sshCommand: 'host', password: 'secret' }, { sshCommand: ['host'] }]) expect((await request('setup', input)).status).toBe(400);
    expect((await request('pair', { relayUrl: 'wss://user:secret@relay.example.invalid' })).status).toBe(400);
    connections.setup.mockRejectedValueOnce(new Error('invalid_input'));
    expect((await request('setup', { sshCommand: 'host -oProxyCommand=anything' })).status).toBe(400);
    connections.setup.mockRejectedValue(new Error('private-token /machine/path'));
    const response = await request('setup', { sshCommand: 'host' });
    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).not.toMatch(/private-token|machine\/path/);
  });

  it('lists all projects with this session first and manages another session task by project and ID', async () => {
    const other = await commands(await create('b'));
    const otherTask = (await run(other.create, task)).value.task;
    const cmd = await commands(await create());
    const own = (await run(cmd.create, { ...task, projectId: 'b', name: 'Own cross-project task' })).value.task;
    const listed = await run(cmd.list);
    expect(listed.value.failedProjectIds).toEqual([]);
    expect(listed.value.tasks.map(({ id }) => id)).toEqual([own.id, otherTask.id]);
    expect(listed.value.tasks[0]).toMatchObject({ projectId: 'b', own: true, currentProject: false });
    expect(listed.value.tasks[1].own).toBe(false);
    expect(listed.stdout).not.toContain(task.execution.prompt);

    const target = { projectId: 'b', taskId: otherTask.id };
    const before = (await run(cmd.get, target)).value.task;
    expect(before.execution.prompt).toBe(task.execution.prompt);
    const updated = await run(cmd.update, { ...target, name: 'Renamed', schedule: { times: ['10:00'] }, execution: { prompt: 'New prompt' } });
    expect(updated.code).toBe(0);
    const after = (await run(cmd.get, target)).value.task;
    expect(after).toMatchObject({ name: 'Renamed', sourceSessionID: before.sourceSessionID,
      schedule: { kind: 'daily', times: ['10:00'], timezone: 'UTC' },
      execution: { ...before.execution, prompt: 'New prompt' },
    });
    expect((await run(cmd.resume, target)).value.task.enabled).toBe(true);
    expect((await run(cmd.pause, target)).value.task.enabled).toBe(false);
    expect((await run(cmd.delete, target)).value).toMatchObject({ deleted: true, projectId: 'b', taskId: otherTask.id });
    expect((await run(cmd.get, target)).value.error).toContain('404');
    expect((await run(cmd.update, { ...target, name: 'No recreation' })).value.error).toContain('404');
    expect((await store.listScheduledTasks('b')).map(({ id }) => id)).toEqual([own.id]);
  });

  it('keeps colliding IDs project-scoped and permits global reads without a current project', async () => {
    for (const projectId of ['a', 'b']) {
      await store.upsertScheduledTask(projectId, { ...task, id: 'same-id', execution: { ...task.execution, providerID: 'test', modelID: 'model' } });
    }
    const session = await ui.session.create({ location: { directory: root } });
    const cmd = await commands(session);
    expect((await run(cmd.list)).value.tasks).toHaveLength(2);
    expect((await run(cmd.list, { projectId: 'b' })).value.tasks).toHaveLength(1);
    expect((await run(cmd.delete, { taskId: 'same-id' })).value.error).toContain('404');
    expect((await run(cmd.delete, { projectId: 'b', taskId: 'same-id' })).code).toBe(0);
    expect(await store.listScheduledTasks('a')).toHaveLength(1);
    expect(await store.listScheduledTasks('b')).toHaveLength(0);
    expect((await run(cmd.create, { ...task, projectId: 'b' })).code).toBe(0);
  });

  it('preserves partial global reads and fails writes for unknown projects or disconnected models', async () => {
    const cmd = await commands(await create());
    const saved = (await run(cmd.create, task)).value.task;
    const target = { projectId: 'a', taskId: saved.id };
    expect((await run(cmd.update, { ...target, execution: { modelID: 'unconnected' } })).value.error).toContain('400');
    expect((await store.listScheduledTasks('a'))[0].execution.modelID).toBe('model');
    expect((await run(cmd.pause, { ...target, projectId: 'unknown' })).value.error).toContain('404');
    expect((await run(cmd.update, { ...target, execution: null })).value.error).toContain('400');
    const original = store.listScheduledTasks;
    vi.spyOn(store, 'listScheduledTasks').mockImplementation(async (id) => {
      if (id === 'b') throw new Error('Unavailable');
      return original(id);
    });
    const listed = await run(cmd.list);
    expect(listed.code).toBe(0);
    expect(listed.value.failedProjectIds).toEqual(['b']);
    expect(listed.value.tasks.map(({ id }) => id)).toEqual([saved.id]);
  });

  it('rejects sessions created outside this Host', async () => {
    const session = await sdk.session.create({ location: { directory: root } });
    const response = await fetch(`${origin}${SCHEDULED_TASK_SKILL_PATH}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ operation: 'check', sessionID: session.id }) });
    expect(response.status).toBe(403);
    expect(entries.has(session.id)).toBe(false);
  });

  it('fails initialization before advertising a broken credential and leaves existing sessions intact', async () => {
    const existing = await create();
    await fs.writeFile(registrationFile, JSON.stringify({ url: upstreamOrigin, password: randomUUID() }));
    await expect(create('b')).rejects.toThrow();
    expect(sessions.size).toBe(1);
    expect(sessions.has(existing.id)).toBe(true);
    expect(sdk.session.create).toHaveBeenCalledTimes(1);
  });

  it('rolls back only its newly created session if instruction installation fails', async () => {
    const existing = await create();
    failInstructions = true;
    await expect(create('b')).rejects.toThrow();
    expect(sessions.size).toBe(1);
    expect(sessions.has(existing.id)).toBe(true);
  });

  it('rolls back when the actual helper cannot authenticate during preflight', async () => {
    const createImpl = sdk.session.create.getMockImplementation();
    sdk.session.create.mockImplementationOnce(async (input) => {
      const session = await createImpl(input);
      await fs.writeFile(registrationFile, JSON.stringify({ url: upstreamOrigin, password: randomUUID() }));
      return session;
    });
    await expect(create()).rejects.toThrow();
    expect(sessions.size).toBe(0);
    expect(entries.size).toBe(0);
    expect(sdk.session.remove).toHaveBeenCalledTimes(1);
  });

  it('reports the retained session when rollback fails', async () => {
    failInstructions = true; failCleanup = true;
    const response = await fetch(`${origin}/api/session`, { method: 'POST', headers: { Authorization: 'Bearer test-browser-client', 'content-type': 'application/json' }, body: JSON.stringify({ location: { directory: root } }) });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(sessions.has(body.sessionID)).toBe(true);
  });

  it('does not treat scheduler sync failure as permission failure or retry the committed write', async () => {
    const session = await create();
    sync.mockRejectedValue(new Error('Scheduler unavailable'));
    const result = await run((await commands(session)).create, task);
    expect(result.code).toBe(0);
    expect(result.value.schedulerSynced).toBe(false);
    expect(await store.listScheduledTasks('a')).toHaveLength(1);
  });
});
