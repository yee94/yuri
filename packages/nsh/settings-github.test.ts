import { afterEach, expect, it, vi } from 'vitest';
import { createSettingsGitHub } from './settings-github-core';
import { gitHubAccountKey, gitHubFlow, gitHubStatus, gitSettingsResponse } from './settings-github-protocol';

afterEach(() => vi.useRealTimers());

it('uses the real device handshake, increases slow_down, and never exposes deviceCode in presentation', async () => {
  vi.useFakeTimers();
  const calls: Array<[string, string | undefined, unknown]> = [];
  const request = vi.fn(async (path: string, method?: string, body?: unknown) => {
    calls.push([path, method, body]);
    if (path.endsWith('/start')) return { deviceCode: 'synthetic-device', userCode: 'FAKE-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 600, interval: 1 };
    if (path.endsWith('/complete')) return { connected: false, status: 'slow_down' };
    return { connected: false, accounts: [] };
  });
  const controller = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await controller.setActive(true);
  await controller.connect();
  expect(JSON.stringify(controller.state())).not.toContain('synthetic-device');
  expect(controller.state().flow?.userCode).toBe('FAKE-CODE');
  await vi.advanceTimersByTimeAsync(1000);
  expect(calls.at(-1)).toEqual(['/api/github/auth/complete', 'POST', { deviceCode: 'synthetic-device' }]);
  await vi.advanceTimersByTimeAsync(5999);
  expect(calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(2);
  controller.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

const oauth = { id: 'same-login', source: 'oauth' as const, current: true, user: { login: 'synthetic' } };
const cli = { id: 'gh-cli', source: 'gh-cli' as const, current: false, user: { login: 'synthetic' } };
const status = () => ({ connected: true, accounts: [oauth, cli], user: oauth.user, ghCli: { available: true, active: false, disabled: false }, capabilities: { exactAccountRemoval: true, deviceFlowCancellation: true } });
const flow = () => ({ deviceCode: 'synthetic-device', userCode: 'FAKE', verificationUri: 'https://github.com/login/device', expiresIn: 60, interval: 1 });
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise<unknown>(done => { resolve = done; }); return { promise, resolve }; };

it('preserves the last confirmed snapshot on read failure, but accepts successful empty', async () => {
  const request = vi.fn().mockResolvedValueOnce(status()).mockRejectedValueOnce(new Error('secret must not escape')).mockResolvedValueOnce({ connected: false, accounts: [] });
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); const previous = c.state().status;
  await c.refresh(); expect(c.state().status).toBe(previous); expect(c.state().issue).toBe('read');
  expect(JSON.stringify(c.state())).not.toContain('secret');
  await c.refresh(); expect(c.state().status?.accounts).toEqual([]); c.dispose();
});

it('pauses when covered/backgrounded, resumes the same unexpired flow, and clears the lease on cancel', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async path => path.endsWith('/start') ? flow() : path.endsWith('/complete') ? { connected: false, status: 'authorization_pending' } : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await c.setActive(false);
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(10_000); expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(0);
  await c.setActive(true); await vi.advanceTimersByTimeAsync(1000);
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
  c.cancel(); expect(c.state().flow).toBeNull(); expect(vi.getTimerCount()).toBe(0); c.dispose();
});

it('expires while inactive without exchanging a stale device code on resume', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async path => path.endsWith('/start') ? flow() : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await c.setActive(false); await vi.advanceTimersByTimeAsync(61_000); await c.setActive(true);
  expect(c.state().issue).toBe('expired'); expect(c.state().flow).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  expect(request.mock.calls.some(([path]) => path.endsWith('/complete'))).toBe(false); c.dispose();
});

it('does not replay a completion with an unknown write result, and only recovers via GET and explicit acknowledgement', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async path => { if (path.endsWith('/start')) return flow(); if (path.endsWith('/complete')) throw new Error('unknown commit'); return status(); });
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await vi.advanceTimersByTimeAsync(1000);
  expect(c.state().pending?.kind).toBe('connect'); expect(c.state().flow).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  await c.connect(); await c.setActive(false); await c.setActive(true); await vi.advanceTimersByTimeAsync(100_000);
  expect(request.mock.calls.filter(([path]) => path.endsWith('/start'))).toHaveLength(1);
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1);
  expect(c.state().pending?.kind).toBe('connect'); c.acknowledgeUnknown(); expect(c.state().pending).toBeNull(); c.dispose();
});

it('never replays an acknowledged completion when its read-back fails', async () => {
  vi.useFakeTimers(); let reads = 0;
  const request = vi.fn(async path => { if (path.endsWith('/start')) return flow(); if (path.endsWith('/complete')) return { connected: true, user: oauth.user }; if (++reads > 1) throw new Error('offline'); return status(); });
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await vi.advanceTimersByTimeAsync(1000); await c.refresh();
  expect(c.state().connected).toBe(true); expect(c.state().pending).toBeNull(); expect(c.state().issue).toBe('read');
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1); c.dispose();
});

it.each(['expired_token', 'access_denied'])('terminates %s and allows an explicit fresh start', async terminal => {
  vi.useFakeTimers();
  const request = vi.fn(async path => path.endsWith('/start') ? flow() : path.endsWith('/complete') ? { connected: false, status: terminal } : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await vi.advanceTimersByTimeAsync(1000);
  expect(c.state().flow).toBeNull(); expect(c.state().issue).toBe(terminal === 'access_denied' ? 'denied' : 'expired');
  expect(vi.getTimerCount()).toBe(0); await c.connect(); expect(c.state().flow).not.toBeNull(); c.dispose();
});

it('rejects late Host-generation completions and cancelled starts', async () => {
  vi.useFakeTimers(); const start = deferred(); let current = true;
  const changed = vi.fn(); const request = vi.fn(async path => path.endsWith('/start') ? start.promise : status());
  const c = createSettingsGitHub({ request, current: () => current, open: async () => true, changed });
  await c.setActive(true); const pending = c.connect(); c.cancel(); start.resolve(flow()); await pending;
  expect(c.state().flow).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  current = false; const count = changed.mock.calls.length; await c.refresh(); await c.connect();
  expect(changed).toHaveBeenCalledTimes(count); c.dispose();
});

it('captures exact source identity for activation; never conflates equal logins', async () => {
  const request = vi.fn(async path => path.endsWith('/activate') ? { ...status(), accounts: [{ ...oauth, current: false }, { ...cli, current: true }] } : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.activate(cli);
  expect(request).toHaveBeenCalledWith('/api/github/auth/activate', 'POST', { accountId: 'gh-cli' });
  expect(gitHubAccountKey(oauth)).not.toBe(gitHubAccountKey(cli)); c.dispose();
});

it('requires current-OAuth confirmation and preflight identity; never activates an account just to delete it', async () => {
  let value = status(); const request = vi.fn(async () => value);
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); c.requestRemoval(cli); expect(c.state().removal).toBeNull();
  c.requestRemoval(oauth); c.cancelRemoval(); await c.confirmRemoval(); expect(request).toHaveBeenCalledTimes(1);
  c.requestRemoval(oauth); value = { ...status(), accounts: [{ ...oauth, current: false }, { ...cli, current: true }], ghCli: { available: true, active: true, disabled: false } };
  await c.confirmRemoval(); expect(c.state().issue).toBe('identity');
  expect(request.mock.calls.every(call => call.length === 1)).toBe(true); c.dispose();
});

it('does not retry unknown DELETE and reconciles absence via the exact account key', async () => {
  let removed = false;
  const request = vi.fn(async (_path, method) => { if (method === 'DELETE') { removed = true; throw new Error('lost ACK'); } return removed ? { connected: false, accounts: [] } : status(); });
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); c.requestRemoval(oauth); await c.confirmRemoval();
  expect(c.state().pending?.kind).toBe('remove'); await c.confirmRemoval(); await c.refresh(); expect(c.state().pending).toBeNull();
  expect(request.mock.calls.filter(([, method]) => method === 'DELETE')).toHaveLength(1); c.dispose();
});

it('uses the CLI preference wire without logging out an OAuth account', async () => {
  const request = vi.fn(async path => path.endsWith('/gh-cli') ? { disabled: true } : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.setCliDisabled(true);
  expect(request).toHaveBeenCalledWith('/api/github/auth/gh-cli', 'POST', { disabled: true });
  expect(request.mock.calls.some(([path]) => path === '/api/github/auth')).toBe(false); c.dispose();
});

it('strictly parses untrusted replies and refuses code-bearing or external verification URLs', () => {
  for (const verificationUri of ['http://github.com/login/device', 'https://github.com.evil/login/device', 'https://github.com/login/device?token=synthetic', 'https://github.com/login/device#synthetic']) expect(() => gitHubFlow({ ...flow(), verificationUri })).toThrow();
  for (const value of [null, {}, { connected: 'false' }, { connected: false, accounts: {} }, { ...status(), accounts: [oauth, oauth] }]) expect(() => gitHubStatus(value)).toThrow();
  expect(gitHubStatus({ ...status(), accessToken: 'never-retain' })).not.toHaveProperty('accessToken');
  expect(gitHubStatus({ ...status(), user: { login: 'synthetic', avatarUrl: 'https://avatars.githubusercontent.com/u/123?v=4' } }).user?.avatarUrl).toBe('https://avatars.githubusercontent.com/u/123?v=4');
  expect(gitHubStatus({ ...status(), user: { login: 'synthetic', avatarUrl: 'https://avatars.githubusercontent.com/u/123?token=never-retain' } }).user).not.toHaveProperty('avatarUrl');
  expect(() => gitSettingsResponse({ status: 500, body: { accessToken: 'never-retain' } })).toThrow('Git settings request failed');
});

it('cancellation during an exchange releases timers, suppresses late results, and requires read-back for an unknown commit', async () => {
  vi.useFakeTimers(); const complete = deferred();
  const request = vi.fn(async path => path.endsWith('/start') ? flow() : path.endsWith('/complete') ? complete.promise : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await vi.advanceTimersByTimeAsync(1000); c.cancel();
  expect(c.state().pending?.kind).toBe('connect'); expect(c.state().flow).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  complete.resolve({ connected: true, user: oauth.user }); await Promise.resolve(); await Promise.resolve();
  expect(c.state().connected).toBe(false); await c.refresh(); expect(c.state().pending?.kind).toBe('connect');
  expect(request.mock.calls.filter(([path]) => path.endsWith('/complete'))).toHaveLength(1); c.dispose();
});

it('expires a hung exchange within the lease deadline without replay, then ignores its late ACK', async () => {
  vi.useFakeTimers(); const complete = deferred();
  const request = vi.fn(async path => path.endsWith('/start') ? { ...flow(), expiresIn: 3 } : path.endsWith('/complete') ? complete.promise : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await vi.advanceTimersByTimeAsync(3000);
  expect(c.state().issue).toBe('unknown'); expect(c.state().flow).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  complete.resolve({ connected: true, user: oauth.user }); await Promise.resolve(); await Promise.resolve();
  expect(c.state().connected).toBe(false); c.dispose();
});

it('does not publish a stale read after cover/resume and recovers an external-link failure without restarting authorization', async () => {
  vi.useFakeTimers(); const initial = deferred(); let reads = 0;
  const request = vi.fn(async path => path.endsWith('/start') ? flow() : ++reads === 1 ? initial.promise : { connected: false, accounts: [] });
  const open = vi.fn().mockRejectedValueOnce(new Error('private link failure')).mockResolvedValue(true);
  const c = createSettingsGitHub({ request, current: () => true, open });
  const loading = c.setActive(true); await c.setActive(false); await c.setActive(true); initial.resolve(status()); await loading;
  expect(c.state().status?.accounts).toEqual([]);
  await c.connect(); expect(c.state().issue).toBe('open'); await c.open(); expect(open).toHaveBeenCalledTimes(2); expect(c.state().issue).toBeNull();
  expect(request.mock.calls.filter(([path]) => path.endsWith('/start'))).toHaveLength(1); c.dispose();
});

it('rejects ambiguous backend account ids shared by CLI and OAuth sources', async () => {
  const request = vi.fn(async () => ({ ...status(), accounts: [oauth, { ...cli, id: oauth.id }] }));
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.activate({ ...cli, id: oauth.id });
  expect(c.state().issue).toBe('identity'); expect(request).toHaveBeenCalledTimes(1); c.dispose();
});

it('preserves the activation ACK snapshot when the follow-up status request fails', async () => {
  let reads = 0;
  const request = vi.fn(async path => {
    if (path.endsWith('/activate')) return { ...status(), user: cli.user, accounts: [{ ...oauth, current: false }, { ...cli, current: true }], ghCli: { available: true, active: true, disabled: false } };
    if (++reads > 1) throw new Error('offline'); return status();
  });
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.activate(cli); expect(c.state().status?.ghCli?.active).toBe(true); expect(c.state().pending).toBeNull(); expect(c.state().issue).toBe('read'); c.dispose();
});

it('cannot acknowledge an unknown exchange while the native request is still unresolved', async () => {
  vi.useFakeTimers(); const complete = deferred();
  const request = vi.fn(async path => path.endsWith('/start') ? flow() : path.endsWith('/complete') ? complete.promise : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await vi.advanceTimersByTimeAsync(1000); c.cancel(); await c.refresh(); c.acknowledgeUnknown();
  expect(c.state().pending?.kind).toBe('connect');
  complete.resolve({ connected: true, user: oauth.user }); for (let index = 0; index < 10; index++) await Promise.resolve();
  expect(c.state().reconciled).toBe(false); await c.refresh(); c.acknowledgeUnknown(); expect(c.state().pending).toBeNull(); c.dispose();
});

it('releases an expired lease on resume even when the status read is hung', async () => {
  vi.useFakeTimers(); const read = deferred(); let hang = false;
  const request = vi.fn(async path => path.endsWith('/start') ? { ...flow(), expiresIn: 3 } : hang ? read.promise : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await c.setActive(false); await vi.advanceTimersByTimeAsync(4000); hang = true;
  const resumed = c.setActive(true); expect(c.state().flow).toBeNull(); expect(c.state().issue).toBe('expired');
  read.resolve(status()); await resumed; expect(c.state().flow).toBeNull(); c.dispose();
});

it('sends an exact selection plus captured expected-current for an inactive OAuth account, without activation', async () => {
  let removed = false;
  const request = vi.fn(async (path, method, body) => {
    if (method === 'DELETE') { removed = true; return { success: true, removed: true, selection: body.selection, disconnected: false }; }
    return { ...status(), accounts: removed ? [{ ...cli, current: true }] : [{ ...oauth, current: false }, { ...cli, current: true }], ghCli: { available: true, active: true, disabled: false } };
  });
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); c.requestRemoval({ ...oauth, current: false }); await c.confirmRemoval();
  expect(request).toHaveBeenCalledWith('/api/github/auth', 'DELETE', { selection: { source: 'oauth', accountId: 'same-login' }, expectedCurrent: { source: 'gh-cli', accountId: 'gh-cli' } });
  expect(request.mock.calls.some(([path]) => path.endsWith('/activate'))).toBe(false); expect(c.state().pending).toBeNull(); c.dispose();
});

it('does not send a selector to a legacy Host that might ignore it', async () => {
  const request = vi.fn(async () => ({ ...status(), capabilities: undefined }));
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); c.requestRemoval(oauth); await c.confirmRemoval();
  expect(c.state().issue).toBe('unsupported'); expect(request).toHaveBeenCalledTimes(1); c.dispose();
});

it('cancels a managed Host lease once without claiming provider-token revocation', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async path => path.endsWith('/start') ? { ...flow(), cancellable: true } : path.endsWith('/cancel') ? { cancelled: true, status: 'cancelled', providerRevoked: false } : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await c.cancel(); c.dispose();
  expect(request).toHaveBeenCalledWith('/api/github/auth/cancel', 'POST', { deviceCode: 'synthetic-device' });
  expect(request.mock.calls.filter(([path]) => path.endsWith('/cancel'))).toHaveLength(1);
  expect(c.state().cancellation).toBe('cancelled'); expect(c.state().flow).toBeNull(); expect(vi.getTimerCount()).toBe(0);
  expect(JSON.stringify(c.state())).not.toContain('synthetic-device');
});

it('keeps cancellation unknown if the Host reports an already-completed grant, and never repeats completion', async () => {
  vi.useFakeTimers();
  const request = vi.fn(async path => path.endsWith('/start') ? { ...flow(), cancellable: true } : path.endsWith('/cancel') ? { cancelled: false, status: 'complete', providerRevoked: false } : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.connect(); await c.cancel();
  expect(c.state().pending?.kind).toBe('connect'); expect(c.state().cancellation).toBe('unknown'); await c.refresh();
  expect(request.mock.calls.some(([path]) => path.endsWith('/complete'))).toBe(false); c.dispose();
});

it('cancels a start response that arrives after explicit cancellation rather than leaking a server lease', async () => {
  vi.useFakeTimers(); const start = deferred();
  const request = vi.fn(async path => path.endsWith('/start') ? start.promise : path.endsWith('/cancel') ? { cancelled: true, status: 'cancelled', providerRevoked: false } : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); const starting = c.connect(); await c.cancel(); start.resolve({ ...flow(), cancellable: true }); await starting;
  expect(request).toHaveBeenCalledWith('/api/github/auth/cancel', 'POST', { deviceCode: 'synthetic-device' }); expect(c.state().flow).toBeNull(); c.dispose();
});

it('treats server atomic-admission conflicts as a definite rejection, re-reads, and never resubmits deletion', async () => {
  const request = vi.fn(async (_path, method) => method === 'DELETE' ? gitSettingsResponse({ status: 409, body: { code: 'github_account_changed', private: 'never-retain' } }) : status());
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); c.requestRemoval(oauth); await c.confirmRemoval(); await c.confirmRemoval();
  expect(c.state().issue).toBe('identity'); expect(c.state().pending).toBeNull(); expect(c.state().status?.accounts).toHaveLength(2);
  expect(request.mock.calls.filter(([, method]) => method === 'DELETE')).toHaveLength(1); expect(JSON.stringify(c.state())).not.toContain('never-retain'); c.dispose();
});

it('releases a managed lease during disposal on the same Host, but never sends an old code to a replacement Host', async () => {
  vi.useFakeTimers(); let current = true;
  const request = vi.fn(async path => path.endsWith('/start') ? { ...flow(), cancellable: true } : path.endsWith('/cancel') ? { cancelled: true, status: 'cancelled', providerRevoked: false } : status());
  const first = createSettingsGitHub({ request, current: () => current, open: async () => true });
  await first.setActive(true); await first.connect(); first.dispose(); for (let index = 0; index < 10; index++) await Promise.resolve();
  expect(request.mock.calls.filter(([path]) => path.endsWith('/cancel'))).toHaveLength(1);
  const next = createSettingsGitHub({ request, current: () => current, open: async () => true });
  await next.setActive(true); await next.connect(); current = false; next.dispose();
  expect(request.mock.calls.filter(([path]) => path.endsWith('/cancel'))).toHaveLength(1); expect(vi.getTimerCount()).toBe(0);
});

it('rejects an OAuth id reserved for CLI activation even when the CLI account is not in the catalog', async () => {
  const account = { ...oauth, id: 'gh-cli', current: false };
  const request = vi.fn(async () => ({ ...status(), accounts: [account] }));
  const c = createSettingsGitHub({ request, current: () => true, open: async () => true });
  await c.setActive(true); await c.activate(account);
  expect(request).toHaveBeenCalledTimes(1); expect(c.state().issue).toBe('identity'); c.dispose();
});
