import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { Schema } from 'effect';
import { SessionTransfer } from '@opencode/schema/session-transfer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProjectRegistry } from '../projects/registry.js';
import { createSettingsRuntime } from '../opencode/settings-runtime.js';
import { createSettingsNormalizationRuntime } from '../opencode/settings-normalization-runtime.js';
import { createProjectDirectoryRuntime } from '../opencode/project-directory-runtime.js';
import { registerProjectsSkill, PROJECTS_SKILL_PATH } from './projects.js';

const execFileAsync = promisify(execFile);
const clientScript = fileURLToPath(new URL('./projects-client.mjs', import.meta.url));

describe('bound session import API (import-session)', () => {
  let root, workspace, settingsPath, registrationFile, server, origin, binding;
  let storedSessions, importMock, onImported, registerProject;
  const auth = { Authorization: `Basic ${Buffer.from('opencode:fixture').toString('base64')}` };

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-import-skill-'));
    workspace = path.join(root, 'repo');
    await fs.mkdir(workspace);
    settingsPath = path.join(root, 'settings.json');
    registrationFile = path.join(root, 'service.json');
    await fs.writeFile(registrationFile, JSON.stringify({ url: 'http://127.0.0.1:4096', password: 'fixture' }));
    const normalization = createSettingsNormalizationRuntime({ os, path, processLike: process });
    const runtime = createSettingsRuntime({
      fsPromises: fs, path, crypto, SETTINGS_FILE_PATH: settingsPath, ...normalization,
      sanitizeSettingsUpdate: (patch) => patch, mergePersistedSettings: (current, patch) => ({ ...current, ...patch }),
      formatSettingsResponse: (value) => value, resolveDirectoryCandidate: (value) => value,
    });
    const { validateDirectoryPath } = createProjectDirectoryRuntime({
      fsPromises: fs, path, normalizeDirectoryPath: normalization.normalizeDirectoryPath,
    });
    const registry = createProjectRegistry({ persistSettings: runtime.persistSettings, validateDirectoryPath });
    registerProject = vi.fn((input) => registry.register(input));
    storedSessions = new Map();
    importMock = vi.fn(async (transfer) => {
      Schema.decodeUnknownSync(SessionTransfer.Data)({ info: transfer.info, messages: transfer.messages });
      storedSessions.set(transfer.info.id, transfer.info);
      return transfer.info;
    });
    const getSession = vi.fn(async ({ sessionID }) => {
      if (sessionID === 'ses_caller') return { metadata: { yuri: { scheduledTaskSkill: { hostOrigin: binding } } } };
      const existing = storedSessions.get(sessionID);
      if (!existing) throw Object.assign(new Error('not found'), { status: 404 });
      return existing;
    });
    onImported = vi.fn();

    const app = express();
    registerProjectsSkill(app, {
      express,
      getIsSharedOpenCodeService: () => true,
      getOpenCodeAuthHeaders: () => auth,
      createClient: () => ({ session: { get: getSession, import: importMock } }),
      registerProject,
      removeProject: registry.remove,
      readSettingsFromDiskStrict: runtime.readSettingsFromDiskStrict,
      sanitizeProjects: normalization.sanitizeProjects,
      onImported,
      hasAssistant: async (id) => id === 'ast_live',
    });
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    origin = `http://127.0.0.1:${server.address().port}`;
    binding = origin;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });

  const call = (operation, input = {}, caller = { sessionID: 'ses_caller' }) => fetch(`${origin}${PROJECTS_SKILL_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ ...caller, operation, input }),
  });

  it('imports normalized external transcripts via session.import, registers the project, indexes the session and deduplicates retries', async () => {
    const described = await (await call('describe')).json();
    expect(described.importSupported).toBe(true);
    expect(described.inputs['import-session']).toContain('session.import');

    const payload = {
      directory: workspace,
      title: '<system-reminder>ignore</system-reminder> WorkBuddy migration thread',
      source: 'workbuddy',
      sourceId: 'wb-conv-001',
      messages: [
        { role: 'user', text: 'Summarize the rollout checklist', time: '2026-01-02T00:00:00.000Z' },
        {
          role: 'assistant',
          thinking: 'Checking deployment steps',
          tools: [{ name: 'read', input: { path: 'README.md' }, output: 'ok' }],
          text: 'Here is the checklist.',
          time: '2026-01-02T00:00:05.000Z',
        },
      ],
    };

    const firstRes = await call('import-session', payload);
    expect(firstRes.status).toBe(200);
    const first = await firstRes.json();
    const canonical = await fs.realpath(workspace);
    expect(first).toMatchObject({
      imported: true,
      skipped: false,
      project: { path: canonical },
      session: {
        id: expect.stringMatching(/^ses_/),
        title: 'WorkBuddy migration thread',
        directory: canonical,
      },
    });
    expect(importMock).toHaveBeenCalledOnce();
    expect(registerProject).toHaveBeenCalledWith({ path: canonical });
    expect(onImported).toHaveBeenCalledWith(expect.objectContaining({ id: first.session.id }));

    // Retrying with the same source + sourceId + payload is idempotent.
    const retryRes = await call('import-session', payload, { assistantID: 'ast_live' });
    expect(retryRes.status).toBe(200);
    const retry = await retryRes.json();
    expect(retry).toMatchObject({ imported: false, skipped: true, session: { id: first.session.id } });
    expect(importMock).toHaveBeenCalledOnce();
  });

  it('rejects missing directories without creating them and enforces payload limits on non-import ops', async () => {
    const missing = path.join(root, 'does-not-exist');
    const res = await call('import-session', {
      directory: missing,
      messages: [{ role: 'user', text: 'hello' }],
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'validation_error' });
    await expect(fs.stat(missing)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(importMock).not.toHaveBeenCalled();

    // Non-import operations still enforce the 16 KiB payload cap.
    const huge = await call('add', { path: workspace, label: 'x'.repeat(20_000) });
    expect(huge.status).toBe(413);

    // Import operations allow transcripts larger than 16 KiB.
    const bigRes = await call('import-session', {
      directory: workspace,
      messages: [{ role: 'user', text: 'a'.repeat(32_000) }],
    });
    expect(bigRes.status).toBe(200);
    expect((await bigRes.json()).imported).toBe(true);
  });

  it('works end-to-end through projects-client.mjs describe and import-session commands', async () => {
    const encoded = Buffer.from(JSON.stringify({
      hostOrigin: origin,
      upstreamOrigin: 'http://127.0.0.1:4096',
      registrationFile,
      assistantID: 'ast_live',
    })).toString('base64url');
    const { stdout: descOut } = await execFileAsync(process.execPath, [clientScript, encoded, 'describe']);
    const desc = JSON.parse(descOut);
    expect(desc.importSupported).toBe(true);
    expect(desc.commands['import-session']).toContain('import-session');

    const input = JSON.stringify({
      directory: workspace,
      source: 'external-agent',
      sourceId: 'ext-42',
      events: [
        { kind: 'user', text: '<user_query>Clean fallback title</user_query>', time: 1700000000000 },
        { kind: 'assistant-text', text: 'Done.', time: 1700000001000 },
      ],
    });
    const child = execFile(process.execPath, [clientScript, encoded, 'import-session']);
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdin.end(input);
    const code = await new Promise((resolve) => child.on('close', resolve));
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed).toMatchObject({
      imported: true,
      skipped: false,
      session: { title: 'Clean fallback title' },
    });
  });
});
