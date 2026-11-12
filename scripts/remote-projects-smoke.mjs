import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

// Exercise the actual server entrypoint, not only the Gateway's isolated router.
// All credentials and state belong to the disposable fixture.
const temporaryBase = path.join(os.tmpdir(), 'opencode');
await fs.mkdir(temporaryBase, { recursive: true });
const root = await fs.mkdtemp(path.join(temporaryBase, 'yuri-remote-projects-smoke-'));
for (const key of Object.keys(process.env)) {
  if (/^(YURI_|OPENCODE_)/.test(key)) delete process.env[key];
}
Object.assign(process.env, {
  HOME: root,
  XDG_CONFIG_HOME: path.join(root, 'config'),
  XDG_DATA_HOME: path.join(root, 'data'),
  XDG_STATE_HOME: path.join(root, 'state'),
  YURI_DATA_DIR: path.join(root, 'hub'),
  YURI_RUNTIME: 'desktop',
  YURI_SKIP_OPENCODE_START: 'true',
});

const fixtureProjects = new Map();
const requests = [];
const fixture = createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://fixture.invalid').pathname;
  requests.push({ method: req.method, pathname });
  const reply = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (pathname === '/api/hosts/capabilities') {
    return reply(200, { remoteProjects: true, protocol: 1, instanceId: 'fixture-remote', version: '0.2.40-beta.2' });
  }
  if (pathname === '/api/projects' && req.method === 'POST') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const input = JSON.parse(raw);
    const previous = fixtureProjects.get(input.path);
    const project = previous ?? { id: crypto.randomUUID(), path: input.path, label: input.label };
    fixtureProjects.set(project.path, project);
    return reply(200, { project, created: !previous });
  }
  if (pathname === '/api/projects') return reply(200, { projects: [...fixtureProjects.values()] });
  if (pathname === '/api/fs/raw') return reply(200, { origin: 'fixture-remote' });
  if (pathname === '/api/yuri/session-index') {
    return reply(200, { directories: [...fixtureProjects.values()].map(project => ({
      directory: project.path, sessions: [], hasMore: false, pinnedSessionIds: [],
    })) });
  }
  if (pathname.endsWith('/health')) return reply(200, { healthy: true, version: '2.2.1' });
  return reply(404, { error: 'unsupported_fixture_route' });
});
await new Promise((resolve, reject) => {
  fixture.once('error', reject);
  fixture.listen(0, '127.0.0.1', resolve);
});
const fixtureOrigin = `http://127.0.0.1:${fixture.address().port}`;
const fixtureToken = crypto.randomUUID();
process.env.OPENCODE_HOST = fixtureOrigin;

let hub;
const assertions = [];
try {
  const { createRemoteClientAuthRuntime } = await import('../packages/web/server/lib/client-auth/remote-clients.js');
  const clientAuth = createRemoteClientAuthRuntime({
    fsPromises: fs, path, crypto, storePath: path.join(root, 'hub', 'remote-clients.json'),
  });
  const { token } = await clientAuth.createClient({ label: 'Isolated smoke', clientKind: 'desktop-local' });
  const { startWebUiServer } = await import('../packages/web/server/index.js');
  hub = await startWebUiServer({
    port: 0, host: '127.0.0.1', apiOnly: true, attachSignals: false, exitOnShutdown: false,
    remoteHostsAdapter: { listHosts: async () => [{
      id: 'fixture', name: 'Fixture PC', source: 'direct', apiUrl: fixtureOrigin,
      clientToken: fixtureToken,
    }] },
  });
  const origin = `http://127.0.0.1:${hub.getPort()}`;
  const call = (route, init = {}, authenticated = true) => fetch(`${origin}${route}`, {
    ...init, signal: AbortSignal.timeout(20_000),
    headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
  });
  const catalogResponse = await call('/api/hosts');
  assert.equal(catalogResponse.status, 200);
  const catalog = await catalogResponse.json();
  assert.equal(catalog.supported, true);
  assert.equal(catalog.hosts[0].id, 'fixture');
  assert.equal(catalog.hosts[0].clientToken, undefined);
  assert.equal(catalog.hosts[0].apiUrl, undefined);
  assert.equal(requests.filter(r => r.pathname.startsWith('/api/hosts/')).length, 0);
  assertions.push('production catalog, credential redaction, lazy remote connection');

  const unauthed = await call('/api/hosts/fixture/api/fs/raw', {}, false);
  assert.ok([401, 403].includes(unauthed.status));
  assertions.push('production authorization rejects unpaired request');

  const create = () => call('/api/hosts/fixture/projects', {
    method: 'POST', body: JSON.stringify({ path: '/workspace/shared', label: 'Shared' }),
  });
  const createdResponse = await create();
  assert.equal(createdResponse.status, 200, JSON.stringify({
    response: await createdResponse.clone().text(),
    fixtureRequests: requests,
    clientStillValid: Boolean(await clientAuth.authenticateBearerToken(token, {})),
  }));
  const created = await createdResponse.json();
  const repeatedResponse = await create();
  assert.equal(repeatedResponse.status, 200, await repeatedResponse.clone().text());
  const repeated = await repeatedResponse.json();
  assert.equal(created.project.id, repeated.project.id);
  assert.equal(created.project.hostId, 'fixture');
  assert.equal(fixtureProjects.size, 1);
  assertions.push('remote-first registration and idempotent Hub reference');

  const contentResponse = await call('/api/hosts/fixture/api/fs/raw');
  assert.equal(contentResponse.status, 200);
  assert.deepEqual(await contentResponse.json(), { origin: 'fixture-remote' });
  assertions.push('production HTTP proxy reaches the remote origin');

  const removed = await call(`/api/hosts/fixture/projects/${encodeURIComponent(created.project.id)}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal(fixtureProjects.size, 1);
  const remaining = await (await call('/api/hosts/projects')).json();
  assert.equal(remaining.projects.length, 0);
  assertions.push('removing Hub reference preserves remote project');
  console.log(JSON.stringify({ kind: 'production-server-smoke', assertions, passed: true,
    limitations: ['synthetic direct upstream', 'no desktop or mobile UI', 'not performance evidence', 'no Relay/SSH evidence'] }));
} catch (error) {
  process.exitCode = 1;
  console.error(error);
} finally {
  await hub?.stop({ exitProcess: false, forceCloseConnections: true });
  fixture.closeAllConnections();
  await new Promise(resolve => fixture.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
// The production entrypoint installs process-wide watchers and exception handlers.
// This finite smoke owns its process; an assertion failure must never become a hang.
process.exit(process.exitCode ?? 0);
