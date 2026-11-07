import { expect, it, vi } from 'vitest';
import { createSettingsGitHub, type GitHubDependencies } from './settings-github-core';
import { createSettingsGitCredentials, type GitCredentialsDependencies } from './settings-git-credentials-core';
import { createSettingsAbout, type AboutDependencies } from './settings-about-core';

const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(done => { resolve = done; }); return { promise, resolve }; };
const account = { id: 'synthetic-oauth', source: 'oauth' as const, current: true, user: { login: 'synthetic' } };
const status = { connected: true, accounts: [account], user: account.user, capabilities: { exactAccountRemoval: true, deviceFlowCancellation: true } };
const plan = { version: '2.4.0', kind: 'cli-package', planId: 'synthetic-plan', rollback: false, restartRequired: true };
const update = { supported: true, host: 'cli', serverId: 'synthetic-server', channel: 'stable', currentVersion: '2.3.0', available: true, checkError: null, update: plan, operation: null };

it('retains an unknown exact deletion and only GET reconciles after replacing its lane', async () => {
  let current = true;
  const write = deferred(), request = vi.fn(async (_path: string, method?: string) => method === 'DELETE' ? write.promise : status);
  const core = createSettingsGitHub({ request, current: () => current, open: async () => true });
  await core.setActive(true); core.requestRemoval(core.state().status!.accounts[0]);
  const removing = core.confirmRemoval(); await Promise.resolve(); await Promise.resolve();
  expect(core.state().pending?.kind).toBe('remove');
  current = false;
  const replacement: GitHubDependencies = { request: vi.fn(async () => ({ connected: false, accounts: [] })), current: () => true, open: async () => true };
  core.replaceLane(replacement); await core.setActive(true);
  expect(core.state().pending).toBeNull();
  const adopted = core.state(); write.resolve({ success: true }); await removing;
  expect(core.state()).toBe(adopted);
  expect(request.mock.calls.filter(([, method]) => method === 'DELETE')).toHaveLength(1);
  expect(replacement.request).toHaveBeenCalledExactlyOnceWith('/api/github/auth/status');
  core.dispose();
});

it('does not let an old read or finally clear a replacement GitHub read flight', async () => {
  const oldRead = deferred(), newRead = deferred(); let current = true;
  const core = createSettingsGitHub({ current: () => current, request: () => oldRead.promise, open: async () => true });
  const old = core.setActive(true); current = false;
  core.replaceLane({ current: () => true, request: () => newRead.promise, open: async () => true });
  const next = core.setActive(true); oldRead.resolve(status); await old;
  expect(core.state().refreshing).toBe(true); expect(core.state().status).toBeNull();
  newRead.resolve(status); await next; expect(core.state().status?.connected).toBe(true); core.dispose();
});

it('forgets the old device secret without replaying Host cancellation after suspension', async () => {
  let current = true; const cancel = deferred();
  const request = vi.fn(async (path: string) => path.endsWith('/start')
    ? { deviceCode: 'synthetic-secret', userCode: 'SYNTHETIC', verificationUri: 'https://github.com/login/device', expiresIn: 60, interval: 10, cancellable: true }
    : path.endsWith('/cancel') ? cancel.promise : status);
  const core = createSettingsGitHub({ current: () => current, request, open: async () => true });
  await core.setActive(true); await core.connect(); const stopping = core.cancel();
  expect(core.state().pending?.kind).toBe('connect'); current = false;
  const next = vi.fn(async () => status); core.replaceLane({ current: () => true, request: next, open: async () => true });
  await core.setActive(true); const retained = core.state();
  cancel.resolve({ cancelled: true, status: 'cancelled', providerRevoked: false }); await stopping;
  expect(core.state()).toBe(retained); expect(core.state().pending?.kind).toBe('connect');
  expect(core.state().flow).toBeNull(); expect(JSON.stringify(core.state())).not.toContain('synthetic-secret');
  expect(next).toHaveBeenCalledExactlyOnceWith('/api/github/auth/status'); core.dispose();
});

it('retains a credential draft and selected source across suspension, with no POST', async () => {
  const deps: GitCredentialsDependencies = { current: () => true, id: () => 'synthetic-profile', request: async path => path.endsWith('discover-credentials') ? [{ host: 'synthetic.invalid', username: 'synthetic' }] : [] };
  const core = createSettingsGitCredentials(deps); await core.setActive(true); core.begin(core.candidates()[0]);
  core.edit('userEmail', 'synthetic@example.invalid'); const draft = core.state().draft;
  const request = vi.fn(deps.request); core.replaceLane({ ...deps, request }); await core.setActive(true);
  expect(core.state().draft).toBe(draft); expect(request.mock.calls.every(([, method]) => !method || method === 'GET')).toBe(true);
  core.dispose();
});

it('lane replacement itself never dispatches dispose-time OAuth cancellation', async () => {
  const request = vi.fn(async (path: string) => path.endsWith('/start')
    ? { deviceCode: 'synthetic-secret', userCode: 'SYNTHETIC', verificationUri: 'https://github.com/login/device', expiresIn: 60, interval: 10, cancellable: true }
    : status);
  const core = createSettingsGitHub({ current: () => true, request, open: async () => true });
  await core.setActive(true); await core.connect();
  const next = vi.fn(async () => status); core.replaceLane({ current: () => true, request: next, open: async () => true });
  await core.setActive(true);
  expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/github/auth/status', '/api/github/auth/start']);
  expect(next).toHaveBeenCalledExactlyOnceWith('/api/github/auth/status'); expect(core.state().flow).toBeNull(); core.dispose();
});

it('journals the import before dispatch and reconciles its exact profile without replay', async () => {
  const write = deferred(); let current = true, posted: unknown;
  const deps: GitCredentialsDependencies = { current: () => current, id: () => 'synthetic-profile', request: async (path, method, body) => {
    if (method === 'POST') { posted = body; return write.promise; }
    return path.endsWith('discover-credentials') ? [{ host: 'synthetic.invalid', username: 'synthetic' }] : [];
  } };
  const core = createSettingsGitCredentials(deps); await core.setActive(true); core.begin(core.candidates()[0]); core.edit('userEmail', 'synthetic@example.invalid');
  const saving = core.save(); await Promise.resolve(); await Promise.resolve(); expect(core.state().pending).toEqual(posted);
  current = false;
  const request = vi.fn(async (path: string) => path.endsWith('discover-credentials') ? [] : [posted]);
  core.replaceLane({ ...deps, current: () => true, request }); await core.setActive(true);
  expect(core.state().saved).toBe(true); expect(core.state().pending).toBeNull();
  const adopted = core.state(); write.resolve(posted); await saving; expect(core.state()).toBe(adopted);
  expect(request).toHaveBeenCalledTimes(2); core.dispose();
});

it('retains uncertain Host update receipt and prevents an old result adopting or clearing a new flight', async () => {
  let current = true; const write = deferred(), read = deferred();
  const deps: AboutDependencies = { current: () => current, hostID: 'synthetic-host', read: async () => update, submitUpdate: () => write.promise, call: async () => { throw new Error('Unexpected Native'); } };
  const core = createSettingsAbout(deps); await core.prepareUpdate(); const saving = core.confirmUpdate();
  expect(core.state().updateUncertain).toBe(true); current = false;
  const submitUpdate = vi.fn(); core.replaceLane({ ...deps, current: () => true, read: () => read.promise, submitUpdate });
  const loading = core.reconcileUpdate(); write.resolve({ operation: { id: 'synthetic-task', status: 'checking', version: plan.version, channel: 'stable', kind: plan.kind, progress: null } }); await saving;
  expect(core.state().hostUpdate.refreshing).toBe(true); expect(core.state().updateUncertain).toBe(true);
  read.resolve(update); await loading; expect(submitUpdate).not.toHaveBeenCalled(); core.dispose();
});

it('keeps an acknowledged update task through replacement without POSTing it again', async () => {
  const operation = { id: 'synthetic-task', status: 'downloading', version: plan.version, channel: 'stable', kind: plan.kind, progress: 25 };
  const deps: AboutDependencies = { current: () => true, hostID: 'synthetic-host', read: async () => update, submitUpdate: async () => ({ operation }), call: async () => null };
  const core = createSettingsAbout(deps); await core.prepareUpdate(); await core.confirmUpdate();
  const task = core.state().hostUpdate.value?.task; const submitUpdate = vi.fn();
  core.replaceLane({ ...deps, submitUpdate, read: async () => { throw new Error('Synthetic restart gap'); } }); await core.reconcileUpdate();
  expect(core.state().hostUpdate.value?.task).toBe(task); expect(submitUpdate).not.toHaveBeenCalled(); core.dispose();
});
