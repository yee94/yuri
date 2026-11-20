import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import express from 'express';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { registerAuthAndAccessRoutes } from '../opencode/core-routes.js';
import { createSessionIndexService } from '../session-index/service.js';
import { createSessionMetadataStore } from '../session-metadata/session-metadata-store.js';
import { createSessionArchiveService } from '../session-metadata/session-archive.js';
import { createCustomizationSkillInstaller } from './session-skill.js';
import { registerProjectsSkill, PROJECTS_SKILL_PATH } from './projects.js';
import { createProjectSessionLifecycle, lifecycleOperations } from './projects-lifecycle.js';

describe('bound session lifecycle helper end to end', () => {
  let root, server, origin, auth, password, index, metadata, archive, records, publish, caller, command, shared, runtime;
  const run = (command, input) => new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      try { resolve({ code, stdout, stderr, value: JSON.parse(code === 0 ? stdout : stderr) }); }
      catch (error) { reject(error); }
    });
    child.stdin.end(input === undefined ? '' : JSON.stringify(input));
  });
  const request = (operation, input = {}, headers = auth) => fetch(`${origin}${PROJECTS_SKILL_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ sessionID: caller.id, operation, input }),
  });
  const commands = async () => {
    const result = await run(command);
    expect(result.code).toBe(0);
    expect(result.value.lifecycleSupported).toBe(true);
    expect(Object.keys(result.value.commands)).toEqual(['list', 'add', 'task-view', ...lifecycleOperations]);
    return result.value.commands;
  };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-lifecycle-'));
    password = randomUUID(); shared = true; runtime = 'http://runtime.test';
    auth = { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` };
    const registrationFile = path.join(root, 'service.json');
    await fs.writeFile(registrationFile, JSON.stringify({ url: runtime, password }), { mode: 0o600 });
    index = createSessionIndexService({ dbPath: path.join(root, 'index.sqlite'), getRuntimeConfig: () => ({ apiBaseUrl: runtime }) });
    metadata = createSessionMetadataStore({ dataDir: root });
    const now = Date.now();
    records = new Map([['ses_target', { id: 'ses_target', title: 'Target', directory: root, time: { created: now, updated: now } }]]);
    index.upsert(records.get('ses_target'));
    index.clearSettled('ses_target');
    publish = vi.fn();
    archive = createSessionArchiveService({
      sessionMetadataStore: metadata, sessionIndexService: index,
      fetchUpstreamSession: async ({ sessionID }) => records.get(sessionID) ?? null,
      broadcastSessionEvent: publish,
    });
    caller = { id: 'ses_caller', metadata: { yuri: { scheduledTaskSkill: {} } } };
    const app = express();
    registerAuthAndAccessRoutes(app, {
      express, tunnelAuthController: { classifyRequestScope: () => 'local' },
      uiAuthController: createUiAuth({ password: randomUUID() }),
      getScheduledTaskSkillAuthHeaders: () => auth,
    });
    registerProjectsSkill(app, {
      express, getIsSharedOpenCodeService: () => shared, getOpenCodeAuthHeaders: () => auth,
      createClient: () => ({ session: { get: async () => caller } }),
      sessionLifecycle: createProjectSessionLifecycle({
        sessionIndexService: index, sessionArchiveService: archive, sessionMetadataStore: metadata,
        publishSessionIndexChange: publish,
      }),
    });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    origin = `http://127.0.0.1:${server.address().port}`;
    caller.metadata.yuri.scheduledTaskSkill.hostOrigin = origin;
    let pointer;
    await createCustomizationSkillInstaller({ yuriDataDir: root })({
      session: { instructions: { entry: { put: ({ value }) => { pointer = value; } } } },
    }, caller.id, { projectBinding: { hostOrigin: origin, upstreamOrigin: runtime, registrationFile } });
    command = pointer.split('Bound project helper: ')[1].split('\n')[0];
  });
  afterEach(async () => {
    archive.stop?.();
    await new Promise((resolve) => server.close(resolve));
    index.close();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('discovers, settles, re-reads and restores through staged commands without UI password, preserving pins and metadata', async () => {
    expect((await fetch(`${origin}/api/yuri/session-index`)).status).toBe(401);
    index.setPinned('ses_target');
    const cmd = await commands();
    const list = await run(cmd['task-sessions'], {});
    expect(list.value.sessions).toEqual([expect.objectContaining({ sessionID: 'ses_target', settled: false, pinned: true })]);
    expect((await run(cmd['settle-session'], { sessionID: 'ses_target' })).value).toEqual({ sessionID: 'ses_target', settled: true });
    expect(publish).toHaveBeenCalledOnce();
    expect((await run(cmd['task-sessions'], { directory: root })).value.sessions[0]).toMatchObject({ settled: true, pinned: true });
    expect((await run(cmd['session-state'], { sessionID: 'ses_target' })).value).toMatchObject({ indexed: true, settled: true, pinned: true, archivedAt: 0 });
    expect(await metadata.get('ses_target')).toEqual({});
    expect((await run(cmd['unsettle-session'], { sessionID: 'ses_target' })).value.settled).toBe(false);
    expect((await run(cmd['task-sessions'], {})).value.sessions[0].settled).toBe(false);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(list.stdout).not.toContain(password);
  });

  it('round-trips session archive through its real owner and persisted metadata, independently of settle', async () => {
    const cmd = await commands();
    const saved = await run(cmd['archive-session'], { sessionID: 'ses_target', directory: root });
    expect(saved.value).toMatchObject({ sessionID: 'ses_target', archived: true, archivedAt: expect.any(Number), index: { ok: true } });
    expect((await createSessionMetadataStore({ dataDir: root }).get('ses_target')).yuri.archive.archivedAt).toBe(saved.value.archivedAt);
    expect((await run(cmd['task-sessions'], {})).value.sessions).toEqual([]);
    expect((await run(cmd['session-state'], { sessionID: 'ses_target' })).value).toEqual({
      sessionID: 'ses_target', indexed: false, archivedAt: saved.value.archivedAt, settled: null, pinned: null,
    });
    const restored = await run(cmd['unarchive-session'], { sessionID: 'ses_target' });
    expect(restored.value).toMatchObject({ archived: false, archivedAt: 0, index: { ok: true } });
    expect((await run(cmd['task-sessions'], {})).value.sessions).toHaveLength(1);
    expect(saved.stdout + restored.stdout).not.toContain(password);
  });

  it('rejects unknown IDs and invalid input instead of fabricating successful settle writes', async () => {
    const cmd = await commands();
    const result = await run(cmd['settle-session'], { sessionID: 'ses_missing' });
    expect(result).toMatchObject({ code: 1, value: { status: 404, code: 'session_not_found', terminal: false } });
    expect((await run(cmd['archive-session'], { sessionID: 'ses_missing' })).value).toMatchObject({ status: 404, code: 'not_found' });
    expect((await run(cmd['session-state'], { sessionID: 'ses_missing' })).value).toMatchObject({ status: 404, code: 'session_not_found' });
    for (const operation of lifecycleOperations) {
      for (const input of [null, [], { sessionID: 'invalid' }, { sessionID: 'ses_target', target: {} }, { directory: 'relative' }]) {
        expect((await request(operation, input)).status).toBe(400);
      }
    }
    expect(publish).not.toHaveBeenCalled();
  });

  it('gates every lifecycle operation by service authentication and admitted Host, and prevents cross-runtime writes', async () => {
    for (const operation of lifecycleOperations) {
      const input = operation === 'task-sessions' ? {} : { sessionID: 'ses_target' };
      for (const headers of [{}, { Authorization: 'Bearer browser' }, { ...auth, Origin: origin }]) {
        expect((await request(operation, input, headers)).status).toBe(403);
      }
      caller.metadata.yuri.scheduledTaskSkill.hostOrigin = 'http://127.0.0.1:1';
      expect((await request(operation, input)).status).toBe(403);
      caller.metadata.yuri.scheduledTaskSkill.hostOrigin = origin;
    }
    runtime = 'http://other-runtime.test';
    expect((await request('task-sessions')).status).toBe(200);
    expect((await (await request('task-sessions')).json()).sessions).toEqual([]);
    expect((await request('settle-session', { sessionID: 'ses_target' })).status).toBe(404);
    shared = false;
    expect((await request('describe')).status).toBe(403);
    expect(publish).not.toHaveBeenCalled();
  });

  it('returns metadata read failures as errors and partial archive repair without leaking raw exceptions', async () => {
    const cmd = await commands();
    const failedRead = vi.spyOn(metadata, 'getAll').mockRejectedValueOnce(new Error('private-token'));
    expect((await run(cmd['task-sessions'], {})).value).toMatchObject({ status: 503, code: 'session_operation_failed' });
    failedRead.mockRestore();
    const failedIndex = vi.spyOn(index, 'upsertAndReportChange').mockImplementation(() => { throw new Error('private-token'); });
    const result = await run(cmd['archive-session'], { sessionID: 'ses_target' });
    expect(result.value).toMatchObject({ archived: true, index: { ok: false, retryable: true } });
    expect(result.stdout + result.stderr).not.toContain('private-token');
    failedIndex.mockRestore();
  });

  it('rejects a stale indexed session archive and propagates metadata/write failures without publishing success', async () => {
    await metadata.setSessionMetadata('ses_target', { yuri: { archive: { archivedAt: Date.now() } } }, { allowArchive: true });
    expect((await request('unsettle-session', { sessionID: 'ses_target' })).status).toBe(409);
    expect((await request('task-sessions')).status).toBe(200);
    expect((await (await request('task-sessions')).json()).sessions).toEqual([]);
    await metadata.setSessionMetadata('ses_target', { yuri: { archive: { archivedAt: 0 } } }, { allowArchive: true });
    const failedRead = vi.spyOn(metadata, 'get').mockRejectedValueOnce(new Error('private-token'));
    expect((await request('settle-session', { sessionID: 'ses_target' })).status).toBe(503);
    failedRead.mockRestore();
    const failedWrite = vi.spyOn(index, 'setSettled').mockImplementationOnce(() => { throw new Error('private-token'); });
    const response = await request('settle-session', { sessionID: 'ses_target' });
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-token');
    failedWrite.mockRestore();
    expect(publish).not.toHaveBeenCalled();
  });

  it('paginates a scoped index completely without mistaking it for full upstream history', async () => {
    for (let n = 0; n < 55; n++) index.upsert({ ...records.get('ses_target'), id: `ses_${n}`, directory: path.join(root, `repo-${n}`) });
    const cmd = await commands();
    const first = await run(cmd['task-sessions'], {});
    expect(first.value).toMatchObject({ indexedOnly: true, nextCursor: '50', historyComplete: false });
    expect(first.value.sessions).toHaveLength(50);
    const next = await run(cmd['task-sessions'], { cursor: first.value.nextCursor });
    expect(next.value).toMatchObject({ nextCursor: null });
    expect(next.value.sessions).toHaveLength(6);
    const all = [...first.value.sessions, ...next.value.sessions];
    expect(new Set(all.map((row) => row.sessionID)).size).toBe(56);
    expect((await run(cmd['task-sessions'], { directory: root })).value.sessions).toHaveLength(1);
  });

  it('filters by settled state and orders rows across directories by activity, newest first, with live status', async () => {
    const now = Date.now();
    index.upsert({ id: 'ses_old', title: 'Old', directory: path.join(root, 'a'), time: { created: now - 9000, updated: now - 9000 } });
    index.upsert({ id: 'ses_new', title: 'New', directory: path.join(root, 'b'), time: { created: now + 9000, updated: now + 9000 } });
    for (const id of ['ses_old', 'ses_new']) index.clearSettled(id);
    index.setSettled('ses_old');
    const cmd = await commands();
    const ids = async (input) => (await run(cmd['task-sessions'], input)).value.sessions.map((row) => row.sessionID);
    expect(await ids({})).toEqual(['ses_new', 'ses_target', 'ses_old']);
    expect(await ids({ settled: false })).toEqual(['ses_new', 'ses_target']);
    expect(await ids({ settled: true })).toEqual(['ses_old']);
    expect((await run(cmd['task-sessions'], { settled: false })).value.sessions[0]).toMatchObject({ settled: false, status: 'idle' });
    for (const input of [{ settled: 'false' }, { settled: null }]) expect((await request('task-sessions', input)).status).toBe(400);
    const view = (await run(cmd['task-view'], { settled: false })).value;
    expect(view.sessions.map((row) => row.sessionID)).toEqual(['ses_new', 'ses_target']);
    expect(view).toMatchObject({ nextCursor: null, remoteComplete: true, remoteFailed: [] });
    expect((await request('task-view', { directory: root })).status).toBe(400);
  });
});
