import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ files: new Map(), start: vi.fn(), exchange: vi.fn(), user: vi.fn(), octokit: vi.fn() }));
vi.mock('fs', () => ({ default: {
  existsSync: path => fixture.files.has(path), mkdirSync: () => undefined, chmodSync: () => undefined,
  readFileSync: path => fixture.files.get(path), writeFileSync: (path, value) => fixture.files.set(path, value),
  renameSync: (from, to) => { fixture.files.set(to, fixture.files.get(from)); fixture.files.delete(from); }, unlinkSync: path => fixture.files.delete(path),
  openSync: path => { if (fixture.files.has(path)) throw Object.assign(new Error('busy'), { code: 'EEXIST' }); fixture.files.set(path, ''); return 1; }, closeSync: () => undefined,
} }));
vi.mock('./index.js', async () => {
  const auth = await import('./auth.js');
  return { ...auth, getGitHubClientId: () => 'synthetic-client-id', startDeviceFlow: fixture.start, exchangeDeviceCode: fixture.exchange, getOctokitOrNull: () => auth.isGitHubAuthDisconnected() ? null : fixture.octokit() };
});
vi.mock('./octokit.js', () => ({ createOctokit: fixture.octokit }));
vi.mock('./gh-cli-credential.js', () => ({ getGhCliToken: () => 'synthetic-cli-token', clearGhCliTokenCache: () => undefined }));
beforeEach(() => {
  vi.resetModules(); fixture.files.clear(); vi.stubEnv('YURI_DATA_DIR', '/synthetic/github-routes');
  fixture.start.mockReset().mockResolvedValue({ device_code: 'synthetic-device', user_code: 'FAKE', verification_uri: 'https://github.com/login/device', expires_in: 600, interval: 5 });
  fixture.exchange.mockReset().mockResolvedValue({ access_token: 'synthetic-provider-result' });
  fixture.user.mockReset().mockResolvedValue({ data: { login: 'added', email: 'synthetic@example.invalid' } });
  fixture.octokit.mockReset().mockImplementation(() => ({ rest: { users: { getAuthenticated: fixture.user } } }));
});
async function harness() {
  const { registerGitHubRoutes } = await import('./routes.js');
  const routes = new Map(); const app = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (path, handler) => routes.set(`${method} ${path}`, handler)]));
  registerGitHubRoutes(app);
  return async (method, path, body) => {
    let status = 200, result;
    const res = { status: value => { status = value; return res; }, json: value => { result = value; return res; } };
    await routes.get(`${method} ${path}`)({ body, query: {} }, res); return { status, body: result };
  };
}
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const flush = async () => { for (let index = 0; index < 20; index++) await Promise.resolve(); };
const seed = async () => { const auth = await import('./auth.js'); auth.setGitHubAuth({ accountId: 'alpha', accessToken: 'synthetic-only-alpha', user: { login: 'alpha' } }); auth.setGitHubAuth({ accountId: 'beta', accessToken: 'synthetic-only-beta', user: { login: 'beta' } }); return auth; };

it('keeps body-less Web DELETE behavior, but truly admits exact selection and expected-current server-side', async () => {
  const call = await harness(), auth = await seed();
  const conflict = await call('delete', '/api/github/auth', { selection: { source: 'oauth', accountId: 'alpha' }, expectedCurrent: { source: 'oauth', accountId: 'alpha' } });
  expect(conflict).toMatchObject({ status: 409, body: { code: 'github_account_changed' } }); expect(auth.getGitHubAuth().accountId).toBe('beta');
  expect((await call('delete', '/api/github/auth', { selection: { source: 'oauth', accountId: 'alpha' }, expectedCurrent: { source: 'oauth', accountId: 'beta' } })).body.selection).toEqual({ source: 'oauth', accountId: 'alpha' });
  expect(auth.getGitHubAuth().accountId).toBe('beta');
  auth.setGitHubAuth({ accountId: 'gamma', accessToken: 'synthetic-only-gamma', user: { login: 'gamma' } });
  expect(await call('delete', '/api/github/auth')).toEqual({ status: 200, body: { success: true, removed: true } }); expect(auth.getGitHubAuth().accountId).toBe('beta');
  expect((await call('delete', '/api/github/auth', { selection: { source: 'oauth', accountId: 'beta' } })).status).toBe(200);
  const status = await call('get', '/api/github/auth/status');
  expect(status.body).toMatchObject({ connected: false, ghCli: { active: false }, capabilities: { exactAccountRemoval: true, deviceFlowCancellation: true } });
});

it('cancels an in-flight provider exchange before Host persistence and never claims third-party revocation', async () => {
  const call = await harness(), auth = await seed(), exchange = deferred(); fixture.exchange.mockReturnValueOnce(exchange.promise);
  expect((await call('post', '/api/github/auth/start', {})).body.cancellable).toBe(true);
  const completion = call('post', '/api/github/auth/complete', { deviceCode: 'synthetic-device' }); await flush();
  expect(await call('post', '/api/github/auth/cancel', { deviceCode: 'synthetic-device' })).toEqual({ status: 200, body: { cancelled: true, status: 'cancelled', providerRevoked: false } });
  exchange.resolve({ access_token: 'synthetic-provider-result' }); expect((await completion).body).toMatchObject({ connected: false, status: 'access_denied' });
  expect(fixture.octokit).not.toHaveBeenCalled(); expect(auth.getGitHubAuth().accountId).toBe('beta');
  await call('post', '/api/github/auth/complete', { deviceCode: 'synthetic-device' }); expect(fixture.exchange).toHaveBeenCalledTimes(1);
});

it('also checks cancellation after async user lookup, immediately before the synchronous write', async () => {
  const call = await harness(), auth = await seed(), user = deferred(); fixture.user.mockReturnValueOnce(user.promise);
  await call('post', '/api/github/auth/start', {});
  const completion = call('post', '/api/github/auth/complete', { deviceCode: 'synthetic-device' }); await flush();
  await call('post', '/api/github/auth/cancel', { deviceCode: 'synthetic-device' }); user.resolve({ data: { login: 'added', email: 'synthetic@example.invalid' } });
  expect((await completion).body.status).toBe('access_denied'); expect(auth.getGitHubAuth().accountId).toBe('beta');
});

it('keeps legacy deviceCode/device_code completion, clears CLI on success, and returns receipt without replaying the exchange', async () => {
  const call = await harness(), auth = await seed(); auth.setGhCliActive(true); await call('post', '/api/github/auth/start', {});
  expect((await call('post', '/api/github/auth/complete', { device_code: 'synthetic-device' })).body.connected).toBe(true);
  expect(auth.isGhCliActive()).toBe(false); expect(auth.getGitHubAuth().accountId).toBe('added');
  expect((await call('post', '/api/github/auth/complete', { deviceCode: 'synthetic-device' })).body.connected).toBe(true); expect(fixture.exchange).toHaveBeenCalledTimes(1);
  expect((await call('post', '/api/github/auth/cancel', { deviceCode: 'synthetic-device' })).body).toEqual({ cancelled: false, status: 'complete', providerRevoked: false });
});

it('rejects unissued codes and malformed exact/cancel requests without falling through to legacy delete', async () => {
  const call = await harness(), auth = await seed();
  expect((await call('post', '/api/github/auth/complete', { deviceCode: 'unissued' })).status).toBe(410); expect(fixture.exchange).not.toHaveBeenCalled();
  for (const body of [null, [], { selection: { source: 'gh-cli', accountId: 'gh-cli' } }, { accountId: 'beta' }, { selection: { source: 'oauth', accountId: 'beta' }, extra: true }]) expect((await call('delete', '/api/github/auth', body)).status).toBe(400);
  expect((await call('post', '/api/github/auth/cancel', { deviceCode: 'synthetic-device', ignored: true })).status).toBe(400);
  expect((await call('post', '/api/github/auth/cancel', { deviceCode: 'unissued' })).body).toMatchObject({ cancelled: false, status: 'unavailable', providerRevoked: false });
  expect(auth.getGitHubAuth().accountId).toBe('beta');
});

it.each(['authorization_pending', 'slow_down', 'expired_token', 'access_denied'])('preserves %s handshake semantics without another exchange after a terminal response', async status => {
  const call = await harness(); await seed(); await call('post', '/api/github/auth/start', {});
  fixture.exchange.mockResolvedValueOnce({ error: status, error_description: 'synthetic-private-provider-description' });
  expect((await call('post', '/api/github/auth/complete', { deviceCode: 'synthetic-device' })).body).toEqual({ connected: false, status, error: status });
  const next = await call('post', '/api/github/auth/complete', { deviceCode: 'synthetic-device' });
  if (['authorization_pending', 'slow_down'].includes(status)) { expect(next.body.connected).toBe(true); expect(fixture.exchange).toHaveBeenCalledTimes(2); }
  else { expect(next.body.connected).toBe(false); expect(fixture.exchange).toHaveBeenCalledTimes(1); }
});

it('HTTP 401 from a stale status read cannot delete or silently switch a newer selected account', async () => {
  const call = await harness(), auth = await seed(), user = deferred();
  // First user lookup is the separate CLI summary, then the captured OAuth request.
  fixture.user.mockResolvedValueOnce({ data: { login: 'synthetic-cli', email: 'synthetic@example.invalid' } }).mockReturnValueOnce(user.promise);
  const reading = call('get', '/api/github/auth/status'); await flush();
  auth.setGitHubAuth({ accountId: 'gamma', accessToken: 'synthetic-only-gamma', user: { login: 'gamma' } });
  user.resolve(Promise.reject(Object.assign(new Error('synthetic unauthorized'), { status: 401 })));
  expect((await reading).body.connected).toBe(false);
  expect(auth.getGitHubAuth().accountId).toBe('gamma');
  expect(auth.getGitHubAuthAccounts().map(account => account.id)).toEqual(['alpha', 'beta', 'gamma']);
});

it('failed CLI lookup on GET status never clears the selected account or writes credentials', async () => {
  const call = await harness(), auth = await seed(); auth.setGhCliActive(true);
  const before = new Map(fixture.files);
  fixture.user.mockRejectedValueOnce(Object.assign(new Error('synthetic transient lookup failure'), { status: 503 }));
  await call('get', '/api/github/auth/status');
  expect(auth.getGitHubAuthContext().selection).toEqual({ source: 'gh-cli', accountId: 'gh-cli' });
  expect(fixture.files).toEqual(before);
});
