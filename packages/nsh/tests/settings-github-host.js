/** In-memory synthetic boundary only. No Host libraries, filesystem, network, OAuth, Keychain or Git. */
import { createSettingsFixtureScope } from './settings-raw-fixture-scope.mjs';
export function createHost() {
  const authority = createSettingsFixtureScope('synthetic-github-host');
  const oauth = { id: 'synthetic-oauth', source: 'oauth', current: true, user: { login: 'synthetic-oauth', name: 'Fixture OAuth' } };
  const cli = { id: 'gh-cli', source: 'gh-cli', current: false, user: { login: 'synthetic-cli', name: 'Fixture CLI' } };
  let accounts = [oauth, cli], profiles = [], disabled = false, mode = 'pending';
  let reads = 0, starts = 0, completes = 0, activations = 0, removals = 0, imports = 0, opened = 0, cancellations = 0;
  const flows = new Map();
  const ok = body => ({ status: 200, body });
  function keys(value, expected) { if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error('Unexpected synthetic argument shape'); }
  function snapshot() {
    const current = accounts.find(account => account.current);
    return { connected: !!current, ...(current ? { user: current.user } : {}), accounts, capabilities: { exactAccountRemoval: true, deviceFlowCancellation: true }, ghCli: { available: true, disabled, active: current?.source === 'gh-cli', ...(!disabled ? { user: cli.user } : {}) } };
  }
  return { call(name, input = {}) {
    if (name === 'connection.list') return authority.snapshot(input);
    if (name === 'github.fixture.scope') return authority.control(input);
    if (name === 'github.fixture.scenario') { keys(input, ['mode']); if (!['pending', 'connected', 'expired', 'denied', 'unknown', 'fail-read', 'slow'].includes(input.mode)) throw new Error('Unexpected synthetic mode'); mode = input.mode; return true; }
    if (name === 'github.fixture.audit') { keys(input, []); return { reads, starts, completes, activations, removals, imports, opened, cancellations, profileCount: profiles.length, scope: authority.audit() }; }
    if (name === 'github.fixture.open') { keys(input, ['url']); if (input.url !== 'https://github.com/login/device') throw new Error('Unsafe synthetic URL'); opened++; return true; }
    if (name !== 'runtime.request') throw new Error('Unexpected synthetic host capability');
    const { path, method, body } = input;
    authority.admit(input);
    if (method === 'GET') {
      if (body !== undefined || !['/api/github/auth/status', '/api/git/discover-credentials', '/api/git/identities'].includes(path)) throw new Error('Unexpected synthetic read');
      reads++;
      if (mode === 'fail-read') return { status: 503, body: { error: 'synthetic read failure' } };
      if (path === '/api/github/auth/status') return ok(snapshot());
      if (path === '/api/git/identities') return ok(profiles);
      return ok([{ host: 'git.example', username: 'synthetic' }]);
    }
    if (path === '/api/github/auth/start' && method === 'POST') { keys(body, []); if (flows.size >= 128) throw new Error('Synthetic flow capacity'); starts++; const deviceCode = `synthetic-device-code-${starts}`; flows.set(deviceCode, { phase: 'pending', result: null }); return ok({ deviceCode, userCode: 'FAKE-CODE', verificationUri: 'https://github.com/login/device', expiresIn: 600, interval: 1, cancellable: true }); }
    if (path === '/api/github/auth/cancel' && method === 'POST') {
      keys(body, ['deviceCode']); const flow = flows.get(body.deviceCode); if (!flow) throw new Error('Unknown synthetic lease'); cancellations++;
      if (flow.phase === 'complete') return ok({ cancelled: false, status: 'complete', providerRevoked: false });
      flow.phase = 'cancelled'; return ok({ cancelled: true, status: 'cancelled', providerRevoked: false });
    }
    if (path === '/api/github/auth/complete' && method === 'POST') {
      keys(body, ['deviceCode']); const flow = flows.get(body.deviceCode); if (!flow) throw new Error('Unexpected synthetic device code'); completes++;
      if (flow.phase === 'cancelled') return ok({ connected: false, status: 'access_denied' });
      if (flow.phase === 'complete') return ok(flow.result);
      if (mode === 'unknown') return { status: 503, body: { error: 'synthetic unknown ACK' } };
      if (mode !== 'connected') return ok({ connected: false, status: mode === 'expired' ? 'expired_token' : mode === 'denied' ? 'access_denied' : mode === 'slow' ? 'slow_down' : 'authorization_pending' });
      accounts = accounts.map(account => ({ ...account, current: false })).filter(account => account.id !== 'synthetic-added');
      const added = { id: 'synthetic-added', source: 'oauth', current: true, user: { login: 'synthetic-added', name: 'Fixture Added' } }; accounts.push(added);
      flow.phase = 'complete'; flow.result = { connected: true, user: added.user, accounts }; return ok(flow.result);
    }
    if (path === '/api/github/auth/activate' && method === 'POST') {
      keys(body, ['accountId']); if (!accounts.some(account => account.id === body.accountId)) throw new Error('Unknown synthetic account');
      activations++; accounts = accounts.map(account => ({ ...account, current: account.id === body.accountId })); return ok(snapshot());
    }
    if (path === '/api/github/auth/gh-cli' && method === 'POST') { keys(body, ['disabled']); if (typeof body.disabled !== 'boolean') throw new Error('Invalid synthetic CLI preference'); disabled = body.disabled; return ok({ disabled }); }
    if (path === '/api/github/auth' && method === 'DELETE') {
      keys(body, ['selection', 'expectedCurrent']); keys(body.selection, ['source', 'accountId']);
      const current = accounts.find(account => account.current), expected = body.expectedCurrent;
      if (expected !== null) keys(expected, ['source', 'accountId']);
      if (current?.source !== expected?.source || current?.id !== expected?.accountId) return { status: 409, body: { code: 'github_account_changed' } };
      const selection = body.selection;
      if (selection.source !== 'oauth' || !accounts.some(account => account.source === selection.source && account.id === selection.accountId)) throw new Error('Unsafe synthetic removal');
      const disconnected = current?.source === selection.source && current?.id === selection.accountId;
      removals++; accounts = accounts.filter(account => account.source !== selection.source || account.id !== selection.accountId);
      if (disconnected) accounts = accounts.map(account => ({ ...account, current: false }));
      return ok({ success: true, removed: true, selection: { ...selection }, disconnected });
    }
    if (path === '/api/git/identities' && method === 'POST') {
      keys(body, ['id', 'name', 'userName', 'userEmail', 'authType', 'sshKey', 'signCommits', 'signingKey', 'host', 'color', 'icon']);
      if (body.id !== 'synthetic-import' || body.host !== 'git.example' || body.authType !== 'token' || body.userName !== 'synthetic' || body.userEmail !== 'synthetic@example.invalid' || body.name !== 'git.example' || body.sshKey !== null || body.signCommits !== false || body.signingKey !== null || body.color !== 'string' || body.icon !== 'code' || profiles.length) throw new Error('Invalid synthetic import');
      imports++; profiles.push({ ...body }); return ok({ ...body });
    }
    throw new Error('Unexpected synthetic mutation');
  } };
}
