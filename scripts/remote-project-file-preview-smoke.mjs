import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createUiAuth } from '../packages/web/server/lib/ui-auth/ui-auth.js';
import { createRemoteClientAuthRuntime } from '../packages/web/server/lib/client-auth/remote-clients.js';
import { createRemoteHostStore } from '../packages/web/server/lib/remote-hosts/store.js';
import { createRemoteHostGateway } from '../packages/web/server/lib/remote-hosts/gateway.js';
import { registerRemoteHostRoutes } from '../packages/web/server/lib/remote-hosts/routes.js';
import { createPreviewProxyRuntime } from '../packages/web/server/lib/preview/proxy-runtime.js';
import { registerAuthAndAccessRoutes, registerCommonRequestMiddleware } from '../packages/web/server/lib/opencode/core-routes.js';
import { createPrivateRelayServer } from '../packages/relay-server/src/index.js';
import { startRelayHost } from '../packages/web/server/lib/relay/host-client.js';
import { exportPublicKeyJwk, generateEcdhKeyPair } from '../packages/web/server/lib/relay/e2ee.js';

const require = createRequire(new URL('../packages/web/package.json', import.meta.url));
const express = require('express');
const { createProxyMiddleware, responseInterceptor } = require('http-proxy-middleware');

const sourceManifest = async () => {
  const files = [
    'scripts/remote-project-file-preview-smoke.mjs', 'packages/web/package.json', 'bun.lock',
    ...['proxy-runtime.js', 'file-target.js', 'file-preview-path.js'].map((file) => `packages/web/server/lib/preview/${file}`),
    ...['routes.js', 'gateway.js', 'store.js', 'preview-scope.js', 'transport.js', 'relay-client.bundle.js'].map((file) => `packages/web/server/lib/remote-hosts/${file}`),
    'packages/web/server/lib/ui-auth/ui-auth.js', 'packages/web/server/lib/client-auth/remote-clients.js',
    'packages/web/server/lib/opencode/core-routes.js',
    'packages/web/server/lib/relay/host-client.js', 'packages/web/server/lib/relay/tunnel-host.js',
  ].sort();
  const sources = [];
  for (const file of files) sources.push({ file, sha256: crypto.createHash('sha256').update(await fs.readFile(new URL(`../${file}`, import.meta.url))).digest('hex') });
  const sourceHash = crypto.createHash('sha256').update(sources.map(({ file, sha256 }) => `${file}\0${sha256}\n`).join('')).digest('hex');
  return { algorithm: 'sha256 of sorted file + NUL + file-sha256 + LF', sourceHash, sources,
    runtime: { node: process.version, platform: process.platform, arch: process.arch } };
};

/** Isolated production routes, credentials and ephemeral loopback listeners only. */
export async function createFilePreviewSmokeFixture({ relay: relayEnabled = false } = {}) {
  const manifest = await sourceManifest();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-file-preview-smoke-'));
  const disposers = [];
  const requests = [];
  const stop = async () => {
    for (const dispose of disposers.splice(0).reverse()) await dispose();
    await fs.rm(directory, { recursive: true, force: true });
  };
  async function host(name, adapter) {
    const data = path.join(directory, name);
    const root = path.join(data, 'project');
    await fs.mkdir(path.join(root, 'docs', 'nested'), { recursive: true });
    await fs.mkdir(path.join(root, 'assets'), { recursive: true });
    const files = {
      'docs/index.html': `<!doctype html><html><head><link rel=stylesheet href="../assets/style.css"><script type=module src="../assets/main.mjs"></script></head><body><h1>${name}</h1><img id=picture src="../assets/pixel.svg"><iframe src="nested/frame.html"></iframe><img id=root-picture src="/assets/pixel.svg"></body></html>`,
      'assets/style.css': '@import "./extra.css"; body { background-image: url("./pixel.svg"); color: rgb(12, 34, 56); }',
      'assets/extra.css': 'h1 { font-size: 23px; }',
      'assets/main.mjs': `import { value } from './part.mjs'; const dynamic = await import('./dynamic.mjs'); const data = await (await fetch('../assets/data.json')).json(); const root = await (await fetch('/assets/data.json')).json(); window.graph = {value, dynamic:dynamic.value, data:data.host, root:root.host};`,
      'assets/part.mjs': `export const value = '${name}-module';`,
      'assets/dynamic.mjs': `export const value = '${name}-dynamic';`,
      'assets/data.json': JSON.stringify({ host: name }),
      'assets/pixel.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>',
      'docs/nested/frame.html': '<!doctype html><html><head></head><body><img src="../../assets/pixel.svg"><script>fetch("../../assets/data.json").then(r=>r.json()).then(d=>window.nested=d.host)</script></body></html>',
    };
    for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(root, file), text);
    await fs.writeFile(path.join(data, 'outside.txt'), 'must not escape');
    await fs.symlink(path.join(data, 'outside.txt'), path.join(root, 'escape.txt'));
    const clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(data, 'clients.json') });
    const issued = await clients.createClient({ clientKind: 'desktop-local', authMethod: 'pairing', pairingId: `fixture-${name}` });
    const auth = createUiAuth({ password: null, requireClientAuth: true, clientAuthController: clients, readSettingsFromDiskMigrated: async () => ({}) });
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    const server = http.createServer(app);
    const sockets = new Set();
    server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
    const store = createRemoteHostStore(path.join(data, 'hosts.sqlite'));
    const gateway = createRemoteHostGateway({ store, indexDbPath: path.join(data, 'index.sqlite'), adapter,
      broadcast() {}, requestTimeoutMs: 5000, operationTimeoutMs: 5000 });
    let settings = { projects: [] };
    const broadcaster = Object.assign(() => {}, { subscribe: () => () => {} });
    const previewResponses = new Set();
    app.use((req, res, next) => {
      if (req.path.includes('/api/preview/proxy/')) {
        previewResponses.add(res); res.once('close', () => previewResponses.delete(res));
      }
      // Store only credential-free request evidence, never the envelope's tokens.
      requests.push({ host: name, method: req.method,
        path: req.path.replace(/(\/_file\/)[^/]+\/[^/]+/, '$1[preview]/[url-auth]'),
        leakedHubToken: name !== 'hub' && /yuri_url_/.test(req.path) });
      next();
    });
    registerAuthAndAccessRoutes(app, { express, uiAuthController: auth, remoteClientAuthRuntime: clients,
      tunnelAuthController: { classifyRequestScope: () => 'local' },
      readSettingsFromDiskMigrated: async () => settings });
    const runtime = registerRemoteHostRoutes(app, { gateway, getAuth: () => auth, server,
      isRequestOriginAllowed: () => true, remoteClientAuthRuntime: clients,
      readSettings: async () => settings,
      persistSettings: async (update) => { settings = { ...settings, ...update(settings) }; return settings; },
      validateDirectoryPath: async (value) => ({ ok: true, directory: value }),
      globalEventHub: { subscribeEvent: () => () => {} }, broadcaster, supportedRemote: true, version: 'fixture' });
    app.get('/api/git/worktrees', (_req, res) => res.json([]));
    app.get('/api/yuri/session-index', (_req, res) => res.json({ directories: [], pinnedSessionIds: [] }));
    app.post('/api/yuri/session-index/sync', express.json(), (_req, res) => res.status(202).json({ directories: [] }));
    app.get('/api/global/event', (_req, res) => { res.type('text/event-stream').write(': fixture\n\n'); });
    createPreviewProxyRuntime({ crypto, URL, createProxyMiddleware, responseInterceptor }).attach(app, {
      server, express, uiAuthController: auth, isRequestOriginAllowed: () => true,
      rejectWebSocketUpgrade: (socket, status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`),
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' };
    disposers.push(async () => {
      runtime.stop(); auth.dispose();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    });
    return { origin, root, issued, clients, auth, headers, server, get activePreviewResponses() { return previewResponses.size; },
      call: (route, method = 'GET', body) => fetch(`${origin}${route}`, { method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) }) };
  }
  try {
    const first = await host('remote-a');
    const second = await host('remote-b');
    const descriptors = [first, second].map((remote, index) => ({
      id: index === 0 ? 'a' : 'b', label: 'Fixture', source: 'direct', apiUrl: remote.origin, clientToken: remote.issued.token,
    }));
    if (relayEnabled) {
      const relay = createPrivateRelayServer({ host: '127.0.0.1', port: 0 });
      await relay.start();
      const encryption = await generateEcdhKeyPair();
      const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
      const jwk = publicKey.export({ format: 'jwk' });
      const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
      const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
      const identity = { serverId, hostEncPubJwk: await exportPublicKeyJwk(encryption.publicKey), hostEncPrivateKey: encryption.privateKey,
        signRelayAuth(role, connectionId) {
          const ts = Date.now();
          return { ts, sig: crypto.sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId || ''}`),
            { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'), pk: Buffer.from(canonical).toString('base64url') };
        } };
      const relayHost = startRelayHost({ relayUrl: relay.wsUrl, identity, getLocalPort: () => first.server.address().port,
        authorizeRequest: first.auth.authorizeRelayRequest, onStatus() {}, logger: { info() {}, warn() {} } });
      disposers.push(async () => { relayHost.stop(); await relay.stop(); });
      const paired = await first.clients.createClient({ clientKind: 'desktop', authMethod: 'pairing', pairingId: 'fixture-relay', usesRelay: true });
      descriptors[0] = { id: 'a', label: 'Fixture Relay', source: 'relay', clientToken: paired.token,
        relay: { relayUrl: relay.wsUrl, serverId, hostEncPubJwk: identity.hostEncPubJwk } };
    }
    const adapter = { listHosts: async () => descriptors, subscribe: () => () => {} };
    const hub = await host('hub', adapter);
    const targets = [];
    for (const [hostId, remote] of [['a', first], ['b', second]]) {
      const registered = await hub.call(`/api/hosts/${hostId}/projects`, 'POST', { path: remote.root });
      if (!registered.ok) throw new Error(`Fixture project registration failed (${registered.status}): ${await registered.text()}`);
      const response = await hub.call(`/api/hosts/${hostId}/api/preview/targets`, 'POST', {
        kind: 'file', directory: remote.root, path: path.join(remote.root, 'docs/index.html'),
      });
      if (!response.ok) throw new Error(`Fixture target registration failed (${response.status}): ${await response.text()}`);
      const target = await response.json();
      const tokenResponse = await hub.call('/auth/url-token', 'POST');
      if (!tokenResponse.ok) throw new Error(`Fixture URL authentication failed (${tokenResponse.status})`);
      const token = await tokenResponse.json();
      targets.push({ hostId, ...target, route: `${target.proxyBasePath}/_file/${target.previewToken}/${token.token}${target.entryPath}` });
    }
    return { directory, hub, first, second, targets, requests, stop, manifest,
      transports: { browserToHub: 'loopback HTTP', hubToA: relayEnabled ? 'real E2EE Relay' : 'loopback HTTP', hubToB: 'loopback HTTP' } };
  } catch (error) { await stop(); throw error; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fixture = await createFilePreviewSmokeFixture({ relay: process.env.YURI_FILE_PREVIEW_SMOKE_RELAY === '1' });
  const output = process.env.YURI_FILE_PREVIEW_SMOKE_STATE;
  if (!output) { await fixture.stop(); throw new Error('YURI_FILE_PREVIEW_SMOKE_STATE must name an isolated temporary state file'); }
  await fs.writeFile(output, JSON.stringify({ origin: fixture.hub.origin, targets: fixture.targets, manifest: fixture.manifest, transports: fixture.transports }), { mode: 0o600 });
  console.log('File preview fixture ready; credentials are isolated in the private state file, not logs.');
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void fixture.stop().then(() => process.exit(0)); });
}
