import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { WebSocket, WebSocketServer } from 'ws';
import { createPrivateRelayServer } from '../../../../relay-server/src/index.js';
import { startRelayHost } from '../relay/host-client.js';
import { exportPublicKeyJwk, generateEcdhKeyPair } from '../relay/e2ee.js';
import { createPreviewProxyRuntime } from '../preview/proxy-runtime.js';
import { createProxyMiddleware, responseInterceptor } from 'http-proxy-middleware';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createGlobalUiEventBroadcaster } from '../event-stream/runtime.js';
import { createRemoteHostStore } from './store.js';
import { createRemoteHostGateway } from './gateway.js';
import { registerRemoteHostRoutes } from './routes.js';
import { registerTranscriptCacheRoutes } from '../transcript-cache/routes.js';
import { registerFsRoutes } from '../fs/routes.js';
import { createTerminalRuntime } from '../terminal/runtime.js';
import { readTerminalWsControlFrame, createTerminalWsControlFrame } from '../terminal/terminal-ws-protocol.js';
import { createTranscriptCacheService } from '../transcript-cache/service.js';
import { runRemoteProjectOperation } from '../gui-customization/projects-remote.js';

const require = createRequire(import.meta.url);
const disposers = [];
afterEach(async () => { for (const dispose of disposers.splice(0).reverse()) await dispose(); });
const wait = async (test) => { await vi.waitFor(test, { timeout: 5000, interval: 10 }); };

async function host({ adapter = null, supportedRemote = true, failHubWrite = false, requestTimeoutMs = 500,
  operationTimeoutMs = requestTimeoutMs, indexStats, requireClientAuth = false, productionTerminal = false, terminalFrames = [] } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-remote-host-test-'));
  const clients = createRemoteClientAuthRuntime({ fsPromises: fs, path, crypto, storePath: path.join(directory, 'clients.json') });
  const issued = await clients.createClient({ clientKind: 'desktop-local', authMethod: 'pairing', pairingId: 'test-pairing' });
  const auth = createUiAuth({ password: null, requireClientAuth, clientAuthController: clients, readSettingsFromDiskMigrated: async () => ({}) });
  const app = express();
  registerCommonRequestMiddleware(app, { express });
  const server = http.createServer(app);
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  const store = createRemoteHostStore(path.join(directory, 'remote-hosts.sqlite'));
  let fail = failHubWrite;
  if (failHubWrite) {
    const save = store.saveProject;
    store.saveProject = (...args) => { if (fail) { fail = false; throw new Error('injected disk failure'); } return save(...args); };
  }
  const sseClients = new Set();
  const broadcast = createGlobalUiEventBroadcaster({ sseClients, wsClients: new Set(),
    writeSseEvent: (res, payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`) });
  const eventSubscribers = new Set();
  const globalEventHub = { subscribeEvent(listener) { eventSubscribers.add(listener); return () => eventSubscribers.delete(listener); } };
  let runtime;
  const gateway = createRemoteHostGateway({ store, indexDbPath: path.join(directory, 'session-index.sqlite'), adapter,
    broadcast: (payload, options) => broadcast(payload, { ...options,
      targetFilter: (resource) => runtime?.canReceiveHostEvents(resource) === true }), requestTimeoutMs, operationTimeoutMs });
  let settings = { projects: [] };
  let requests = 0;
  let capabilityGate = Promise.resolve();
  let capabilityRequests = 0;
  let worktrees = [];
  let worktreeFailure = false;
  let worktreeRequests = 0;
  app.use((_req, _res, next) => { requests++; next(); });
  app.use(async (req, _res, next) => {
    if (req.path === '/api/hosts/capabilities') { capabilityRequests++; await capabilityGate; }
    next();
  });
  app.get('/auth/session', auth.handleSessionStatus);
  app.post('/auth/url-token', auth.handleUrlAuthToken);
  app.use('/api', auth.requireAuth);
  runtime = registerRemoteHostRoutes(app, { gateway, getAuth: () => auth, server,
    isRequestOriginAllowed: () => true, remoteClientAuthRuntime: clients,
    readSettings: async () => settings,
    persistSettings: async (update) => { settings = { ...settings, ...update(settings) }; return settings; },
    validateDirectoryPath: async (value) => typeof value === 'string' && value.startsWith('/')
      ? { ok: true, directory: value } : { ok: false, error: 'invalid path' },
    globalEventHub, broadcaster: broadcast, supportedRemote, version: 'test-version' });
  app.get('/api/global/event', (req, res) => {
    res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' }); res.flushHeaders();
    sseClients.add(res); res.once('close', () => sseClients.delete(res)); res.write(': ready\n\n');
  });
  const content = new Set();
  const terminalRuntime = productionTerminal ? createTerminalRuntime({ app, server, express, fs: require('node:fs'), path,
    uiAuthController: auth, buildAugmentedPath: () => process.env.PATH || '', searchPathFor: () => null, isExecutable: () => false,
    isRequestOriginAllowed: async () => true, rejectWebSocketUpgrade: (socket) => socket.destroy(),
    TERMINAL_INPUT_WS_HEARTBEAT_INTERVAL_MS: 30000, TERMINAL_INPUT_WS_REBIND_WINDOW_MS: 1000,
    TERMINAL_INPUT_WS_MAX_REBINDS_PER_WINDOW: 3 }) : null;
  const terminal = new WebSocketServer({ noServer: true });
  server.on('upgrade', async (req, socket, head) => {
    if (productionTerminal) return;
    if (new URL(req.url, 'http://local.invalid').pathname !== '/api/terminal/ws') return;
    const token = await auth.ensureSessionToken(req, null);
    if (!token) return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    terminal.handleUpgrade(req, socket, head, (ws) => {
      for (const frame of terminalFrames) ws.send(frame);
      ws.on('message', (data, binary) => ws.send(data, { binary }));
    });
  });
  app.get('/api/event', (_req, res) => {
    res.set({ 'Content-Type': 'text/event-stream' }); res.flushHeaders(); content.add(res);
    res.once('close', () => content.delete(res)); res.write(': ready\n\n');
  });
  let summaries = { directories: [], pinnedSessionIds: [] };
  let indexGate = Promise.resolve();
  let indexRequests = 0;
  let indexActive = 0;
  let indexMax = 0;
  const indexSyncRequests = [];
  app.post('/api/yuri/session-index/sync', express.json(), (req, res) => {
    indexSyncRequests.push(req.body.directories);
    for (const directory of req.body.directories || []) if (!summaries.directories.some((entry) => entry.directory === directory)) {
      summaries.directories.push({ directory, sessions: [], hasMore: false });
    }
    res.status(202).json(summaries);
  });
  app.get('/api/yuri/session-index', async (_req, res) => {
    indexRequests++; indexActive++; indexMax = Math.max(indexMax, indexActive);
    if (indexStats) { indexStats.active++; indexStats.max = Math.max(indexStats.max, indexStats.active); }
    res.once('close', () => { indexActive--; if (indexStats) indexStats.active--; });
    await indexGate;
    if (!res.destroyed) res.json(summaries);
  });
  app.get('/api/yuri/session-unread', (_req, res) => res.json({ revision: 0, sessions: {} }));
  app.get('/api/git/worktrees', (_req, res) => {
    worktreeRequests++;
    if (worktreeFailure) return res.status(503).json({ code: 'worktree_catalog_unavailable' });
    res.json(worktrees);
  });
  app.get('/api/session-folders', (_req, res) => res.json({ version: 1, foldersMap: {}, collapsedFolderIds: [] }));
  app.get('/api/session-folders/order', (_req, res) => res.json({ revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} }));
  let messageHeaders;
  app.post('/api/session/:id/message', express.json(), (req, res) => {
    messageHeaders = req.headers;
    res.json({ received: req.body });
  });
  app.get('/api/fs/raw', (_req, res) => res.type('text/plain').send('remote file body'));
  const previewRuntime = createPreviewProxyRuntime({ crypto, URL, createProxyMiddleware, responseInterceptor });
  previewRuntime.attach(app, { server, express, uiAuthController: auth, isRequestOriginAllowed: () => true,
    rejectWebSocketUpgrade: (socket) => socket.destroy() });
  const transcript = createTranscriptCacheService({ dbPath: path.join(directory, 'transcript-cache.sqlite') });
  registerTranscriptCacheRoutes(app, { transcriptCacheService: transcript });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' };
  disposers.push(async () => {
    runtime.stop(); terminal.close(); transcript.close(); auth.dispose();
    await terminalRuntime?.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { app, server, store, gateway, url, headers, clients, issued, directory, content, auth,
    emit(payload, scope = '/same/path') { for (const listener of eventSubscribers) listener({ payload, directory: scope }); },
    setSummaries(value) { summaries = value; }, get projects() { return settings.projects; },
    get requests() { return requests; }, get statusStreams() { return eventSubscribers.size; },
    get liveClients() { return sseClients.size; }, broadcast,
    get capabilityRequests() { return capabilityRequests; },
    get messageHeaders() { return messageHeaders; },
    setCapabilityGate(promise) { capabilityGate = promise; },
    get indexRequests() { return indexRequests; }, get indexActive() { return indexActive; }, get indexMax() { return indexMax; },
    setIndexGate(promise) { indexGate = promise; },
    setWorktrees(paths) { worktrees = paths.map((path) => ({ path })); },
    setWorktreeFailure(value) { worktreeFailure = value; },
    get worktreeRequests() { return worktreeRequests; },
    get indexSyncRequests() { return indexSyncRequests; },
    call(route, method = 'GET', body) { return fetch(`${url}${route}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); },
  };
}

async function aggregate(options = {}) {
  const remote = await host({ requireClientAuth: options.requireClientAuth, productionTerminal: options.productionTerminal,
    terminalFrames: options.terminalFrames });
  let hosts = [{ id: 'remote-1', label: 'Remote', source: 'direct', apiUrl: remote.url, clientToken: remote.issued.token }];
  const listeners = new Set();
  const adapter = { listHosts: async () => hosts, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const hub = await host({ adapter, ...options });
  return { hub, remote, setHosts(next) { hosts = next; for (const fn of listeners) fn(); } };
}

describe('Remote Host production HTTP contract', () => {
  it('forwards metadata writes with their directory and patch, but rejects other methods and stale targets', async () => {
    const { hub, remote } = await aggregate();
    const writes = [];
    remote.app.put('/api/yuri/sessions/:id/metadata', express.json(), (req, res) => {
      writes.push({ id: req.params.id, body: req.body });
      res.json({ metadata: req.body.patch });
    });
    const route = '/api/hosts/remote-1/api/yuri/sessions/same-id/metadata';
    const body = { directory: '/same/path', patch: { yuri: { label: 'metadata' } } };
    const response = await hub.call(route, 'PUT', body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ metadata: body.patch });
    expect(writes).toEqual([{ id: 'same-id', body }]);
    expect((await hub.call(route, 'POST', body)).status).toBe(403);
    expect((await fetch(`${hub.url}${route}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).status).toBe(401);
    const rejected = await fetch(`${hub.url}${route}`, { method: 'PUT', headers: { ...hub.headers, 'x-yuri-target-instance': 'other-instance' }, body: JSON.stringify(body) });
    expect(rejected.status).toBe(409);
    expect(writes).toHaveLength(1);
  });

  it('routes deletion to the target Host without deleting the same-ID Hub session', async () => {
    const { hub, remote } = await aggregate();
    const remoteDelete = vi.fn((req, res) => res.json({ deleted: req.params.id }));
    const localDelete = vi.fn((_req, res) => res.status(500).json({ error: 'Must not delete locally' }));
    remote.app.delete('/api/session/:id', remoteDelete);
    hub.app.delete('/api/session/:id', localDelete);
    const response = await hub.call('/api/hosts/remote-1/api/session/same-id', 'DELETE');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ deleted: 'same-id' });
    expect(remoteDelete).toHaveBeenCalledOnce();
    expect(localDelete).not.toHaveBeenCalled();
  });

  it('forwards archive and unarchive only to the authenticated target Host', async () => {
    const { hub, remote } = await aggregate();
    const received = [];
    remote.app.put('/api/yuri/sessions/:id/archive', express.json(), (req, res) => {
      received.push({ id: req.params.id, body: req.body });
      res.json({ session: { id: req.params.id, time: { archived: req.body.archivedAt } } });
    });
    for (const archivedAt of [123, 0]) {
      const response = await hub.call('/api/hosts/remote-1/api/yuri/sessions/session-1/archive', 'PUT', { directory: '/same/path', archivedAt });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ session: { id: 'session-1', time: { archived: archivedAt } } });
    }
    expect(received).toEqual([123, 0].map((archivedAt) => ({ id: 'session-1', body: { directory: '/same/path', archivedAt } })));
    for (const [route, method] of [['sessions/session-1/archive', 'POST'], ['sessions/session-1/unknown', 'PUT']]) {
      expect((await hub.call(`/api/hosts/remote-1/api/yuri/${route}`, method, {})).status).toBe(403);
    }
    expect(received).toHaveLength(2);
  });

  it('rejects a connection retarget before reading or mutating the replacement authority', async () => {
    const { hub, remote, setHosts } = await aggregate();
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    expect(hub.store.projects()[0].instanceId).toBe(remote.store.hubId);
    const replacement = await host();
    setHosts([{ id: 'remote-1', source: 'direct', apiUrl: replacement.url, clientToken: replacement.issued.token }]);
    const response = await hub.call('/api/hosts/remote-1/api/session/same-id/message', 'POST', { text: 'do not send' });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'remote_instance_mismatch' });
    expect(replacement.messageHeaders).toBeUndefined();
    expect(hub.store.projects()[0].instanceId).toBe(remote.store.hubId);
  });

  it('checks an explicit target authority without forwarding the Hub-only marker', async () => {
    const { hub, remote } = await aggregate();
    const route = `${hub.url}/api/hosts/remote-1/api/session/same-id/message`;
    const send = (instanceId) => fetch(route, { method: 'POST', headers: { ...hub.headers, 'x-yuri-target-instance': instanceId }, body: '{}' });
    expect((await send('other-instance')).status).toBe(409);
    expect(remote.messageHeaders).toBeUndefined();
    expect((await send(remote.store.hubId)).status).toBe(200);
    expect(remote.messageHeaders['x-yuri-target-instance']).toBeUndefined();
  });

  it('retains only the task host status stream without a UI and releases it on completion', async () => {
    const { hub, remote, setHosts } = await aggregate();
    const other = await host();
    setHosts([
      { id: 'remote-1', source: 'direct', apiUrl: remote.url, clientToken: remote.issued.token },
      { id: 'remote-2', source: 'direct', apiUrl: other.url, clientToken: other.issued.token },
    ]);
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    await hub.call('/api/hosts/remote-2/projects', 'POST', { path: '/same/path' });
    const onEvent = vi.fn();
    const lease = await hub.gateway.acquireTask('remote-1', { instanceId: remote.store.hubId, onEvent });
    expect(lease.target).toEqual({ hubId: hub.store.hubId, hostId: 'remote-1', instanceId: remote.store.hubId });
    await wait(() => expect(remote.statusStreams).toBe(1));
    expect(hub.liveClients).toBe(0);
    expect(other.statusStreams).toBe(0);
    expect(other.indexRequests).toBe(0);
    const uiAbort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: uiAbort.signal });
    await wait(() => expect(other.statusStreams).toBe(1));
    uiAbort.abort(); await stream.body.cancel().catch(() => {});
    await wait(() => expect(other.statusStreams).toBe(0));
    expect(remote.statusStreams).toBe(1);
    remote.emit({ type: 'session.execution.succeeded', data: { sessionID: 'same-id', directory: '/same/path' } });
    await wait(() => expect(onEvent.mock.calls.some(([event]) => event.payload.type === 'session.execution.succeeded')).toBe(true));
    remote.emit({ type: 'session.execution.interrupted', data: { sessionID: 'same-id', directory: '/same/path', reason: 'user',
      error: { name: 'MessageAbortedError', message: 'private error body', stack: 'private stack' } } });
    await wait(() => expect(onEvent.mock.calls.some(([event]) => event.payload.type === 'session.execution.interrupted')).toBe(true));
    const interrupted = onEvent.mock.calls.find(([event]) => event.payload.type === 'session.execution.interrupted')[0];
    expect(interrupted.payload.data).toEqual({ sessionID: 'same-id', directory: '/same/path', reason: 'user', error: { name: 'MessageAbortedError' } });
    expect(JSON.stringify(interrupted)).not.toContain('private');
    const sibling = await hub.gateway.acquireTask('remote-1', { onEvent: vi.fn() });
    lease.release(); lease.release();
    expect(remote.statusStreams).toBe(1);
    sibling.release();
    await wait(() => expect(remote.statusStreams).toBe(0));
    await expect(lease.json('/api/projects')).rejects.toThrow();
  });

  it('cancels task reads and rejects stale leases after descriptor revocation', async () => {
    const { hub, remote, setHosts } = await aggregate();
    const abort = new AbortController();
    const lease = await hub.gateway.acquireTask('remote-1', { signal: abort.signal });
    expect(remote.statusStreams).toBe(0);
    expect(await lease.json('/api/projects')).toEqual({ projects: [] });
    let entered;
    const receiving = new Promise((resolve) => { entered = resolve; });
    remote.app.get('/api/session/slow-task', (_req, res) => {
      res.type('application/json').write('{"unfinished":');
      entered();
    });
    const pending = expect(lease.json('/api/session/slow-task')).rejects.toThrow();
    await receiving;
    abort.abort();
    await pending;
    await expect(lease.json('/api/projects')).rejects.toThrow();
    const active = await hub.gateway.acquireTask('remote-1');
    setHosts([]);
    await expect(active.json('/api/projects')).rejects.toMatchObject({ code: 'host_unavailable' });
    active.release();
  });

  it('closes server task demand before its database on shutdown and tolerates late release', async () => {
    const { hub, remote } = await aggregate();
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    const task = await hub.gateway.acquireTask('remote-1', { onEvent: vi.fn() });
    await wait(() => expect(remote.statusStreams).toBe(1));
    hub.gateway.stop();
    task.release();
    hub.gateway.stop();
    await wait(() => expect(remote.statusStreams).toBe(0));
    await expect(task.json('/api/projects')).rejects.toThrow();
    await expect(hub.gateway.list()).rejects.toMatchObject({ code: 'host_unavailable' });
  });

  it('delivers task status for authorized sessions without adding Hub project references or indexing them', async () => {
    const { hub, remote } = await aggregate();
    const onEvent = vi.fn();
    const task = await hub.gateway.acquireTask('remote-1', { instanceId: remote.store.hubId, onEvent });
    await wait(() => expect(remote.statusStreams).toBe(1));
    expect(hub.store.projects()).toEqual([]);
    remote.emit({ type: 'session.execution.interrupted', data: { sessionID: 'not-in-hub', reason: 'user',
      error: { name: 'MessageAbortedError', message: 'private body' } } });
    await wait(() => expect(onEvent.mock.calls.some(([event]) => event.payload.type === 'session.execution.interrupted')).toBe(true));
    expect(onEvent.mock.calls.find(([event]) => event.payload.type === 'session.execution.interrupted')[0].payload.data)
      .toEqual({ sessionID: 'not-in-hub', reason: 'user', error: { name: 'MessageAbortedError' } });
    expect(hub.store.projects()).toEqual([]);
    expect((await hub.call('/api/hosts/remote-1/summaries')).status).toBe(404);
    expect(remote.indexRequests).toBe(0);
    task.release();
    await wait(() => expect(remote.statusStreams).toBe(0));
  });

  it('shares admission and one HTTP status stream across 50 background task leases', async () => {
    const { hub, remote } = await aggregate();
    const tasks = await Promise.all(Array.from({ length: 50 }, () => hub.gateway.acquireTask('remote-1', { onEvent: vi.fn() })));
    await wait(() => expect(remote.statusStreams).toBe(1));
    expect(remote.capabilityRequests).toBe(1);
    expect(remote.indexRequests).toBe(0);
    expect(hub.liveClients).toBe(0);
    for (const task of tasks.slice(0, -1)) task.release();
    expect(remote.statusStreams).toBe(1);
    tasks.at(-1).release();
    await wait(() => expect(remote.statusStreams).toBe(0));
  });

  it('forwards worktree dialog GitHub reads and prompt templates without allowing machine mutations', async () => {
    const { hub, remote } = await aggregate();
    const reads = ['/api/github/auth/status', '/api/github/issues/list', '/api/github/pulls/list',
      '/api/github/issues/get', '/api/github/issues/comments', '/api/github/pulls/context', '/api/magic-prompts'];
    for (const route of reads) {
      remote.app.get(route, (req, res) => res.json({ source: 'remote', route, directory: req.query.directory }));
      const response = await hub.call(`/api/hosts/remote-1${route}?directory=%2Fremote%2Frepo`);
      expect(response.status, route).toBe(200);
      expect(await response.json()).toEqual({ source: 'remote', route, directory: '/remote/repo' });
    }
    const before = remote.requests;
    for (const [route, method] of [
      ['/api/github/auth/start', 'POST'], ['/api/github/auth/logout', 'POST'],
      ['/api/github/auth/status', 'POST'], ['/api/github/issues/list', 'POST'],
      ['/api/github/auth/unknown', 'GET'], ['/api/magic-prompts', 'PUT'],
      ['/api/magic-prompts', 'POST'], ['/api/magic-prompts', 'DELETE'],
    ]) {
      const response = await hub.call(`/api/hosts/remote-1${route}`, method);
      expect(response.status, `${method} ${route}`).toBe(403);
      expect(await response.json()).toMatchObject({ code: 'remote_scope_forbidden' });
    }
    expect(remote.requests).toBe(before);
  });

  it('preserves the production terminal greeting while downstream authorization is completing', async () => {
    const { hub, remote } = await aggregate({ requireClientAuth: true, productionTerminal: true });
    const directFrames = [];
    const direct = new WebSocket(`${remote.url.replace('http:', 'ws:')}/api/terminal/ws`, { headers: remote.headers });
    disposers.push(() => direct.terminate());
    direct.on('message', (data) => directFrames.push(readTerminalWsControlFrame(data)));
    await wait(() => expect(directFrames).toContainEqual({ t: 'ok', v: 2 }));
    direct.close();
    const authorize = hub.auth.resolveAuthContext;
    let upgrades = 0;
    hub.auth.resolveAuthContext = async (...args) => {
      const result = await authorize(...args);
      if (args[0].headers.upgrade === 'websocket' && ++upgrades === 2) await new Promise((resolve) => setTimeout(resolve, 30));
      return result;
    };
    const frames = [];
    const socket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/api/hosts/remote-1/api/terminal/ws`, { headers: hub.headers });
    disposers.push(() => socket.terminate());
    socket.on('message', (data) => frames.push(readTerminalWsControlFrame(data)));
    await once(socket, 'open');
    await vi.waitFor(() => expect(frames).toContainEqual({ t: 'ok', v: 2 }), { timeout: 300 });
    socket.send(createTerminalWsControlFrame({ t: 'b', s: 'missing-session' }));
    await wait(() => expect(frames).toContainEqual({ t: 'e', c: 'SESSION_NOT_FOUND', f: false }));
  });

  it.each(['bytes', 'frames', 'revoked'])('rejects admission without forwarding early frames when %s exceeds its boundary', async (boundary) => {
    const terminalFrames = boundary === 'bytes' ? [Buffer.alloc(1024 * 1024 + 1)]
      : boundary === 'frames' ? Array.from({ length: 257 }, () => '') : ['must-not-leak'];
    const { hub } = await aggregate({ requireClientAuth: true, terminalFrames });
    const authorize = hub.auth.resolveAuthContext;
    let upgrades = 0;
    hub.auth.resolveAuthContext = async (...args) => {
      if (args[0].headers.upgrade === 'websocket' && ++upgrades === 2) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        if (boundary === 'revoked') await hub.clients.revokeClient(hub.issued.client.id);
      }
      return authorize(...args);
    };
    const socket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/api/hosts/remote-1/api/terminal/ws`, { headers: hub.headers });
    disposers.push(() => socket.terminate());
    const opened = vi.fn();
    const message = vi.fn();
    socket.on('open', opened);
    socket.on('message', message);
    socket.on('error', () => {});
    await new Promise((resolve) => socket.once('close', resolve));
    expect(opened).not.toHaveBeenCalled();
    expect(message).not.toHaveBeenCalled();
  });

  it('preserves the order and text/binary types of frames sent before downstream admission', async () => {
    const { hub } = await aggregate({ terminalFrames: ['first', Buffer.from([0, 255, 1]), 'last'], requireClientAuth: true });
    const authorize = hub.auth.resolveAuthContext;
    let upgrades = 0;
    hub.auth.resolveAuthContext = async (...args) => {
      const result = await authorize(...args);
      if (args[0].headers.upgrade === 'websocket' && ++upgrades === 2) await new Promise((resolve) => setTimeout(resolve, 30));
      return result;
    };
    const frames = [];
    const socket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/api/hosts/remote-1/api/terminal/ws`, { headers: hub.headers });
    disposers.push(() => socket.terminate());
    socket.on('message', (data, binary) => frames.push({ data: binary ? [...data] : data.toString(), binary }));
    await once(socket, 'open');
    socket.send('after-admission');
    await wait(() => expect(frames).toEqual([
      { data: 'first', binary: false }, { data: [0, 255, 1], binary: true },
      { data: 'last', binary: false }, { data: 'after-admission', binary: false },
    ]));
  });

  it('keeps the scope generation across short discovery connections without retaining unreferenced transports', async () => {
    const { hub, remote } = await aggregate({ requireClientAuth: true });
    const before = await (await hub.call('/api/hosts')).json();
    const scope = before.hosts[0].scopeGeneration;
    expect(scope).toEqual(expect.any(String));
    expect(remote.requests).toBe(0);
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    const wires = new Set();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await hub.call('/api/hosts/remote-1/connect', 'POST');
        expect(response.status).toBe(200);
        const { host: connected } = await response.json();
        expect(connected.scopeGeneration).toBe(scope);
        wires.add(connected.generation);
        await wait(async () => expect((await hub.gateway.list()).hosts[0].state).toBe('idle'));
        expect(await (await hub.call('/api/hosts/remote-1/api/fs/raw')).text()).toBe('remote file body');
        const after = await (await hub.call('/api/hosts')).json();
        expect(after.hosts[0]).toMatchObject({ state: 'idle', scopeGeneration: scope });
        expect(after.hosts[0].generation).toBeUndefined();
      }
      expect(wires.size).toBe(3);
      expect(remote.statusStreams).toBe(0);
      expect(remote.indexRequests).toBe(0);
      expect(remote.indexSyncRequests).toEqual([]);
    } finally { abort.abort(); await stream.body.cancel().catch(() => {}); }
  });

  it('retires scope generations on credential changes and host removal without ABA reuse', async () => {
    const { hub, remote, setHosts } = await aggregate({ requireClientAuth: true });
    const descriptor = { id: 'remote-1', label: 'Remote', source: 'direct', apiUrl: remote.url, clientToken: remote.issued.token };
    const scope = async () => (await (await hub.call('/api/hosts')).json()).hosts[0]?.scopeGeneration;
    const first = await scope();
    expect(first).toEqual(expect.any(String));
    const issued = await remote.clients.createClient({ clientKind: 'desktop-local', authMethod: 'pairing', pairingId: 'rotated' });
    setHosts([{ ...descriptor, clientToken: issued.token }]);
    const rotated = await scope();
    setHosts([descriptor]);
    const restoredCredential = await scope();
    setHosts([]);
    expect(await scope()).toBeUndefined();
    setHosts([descriptor]);
    const restoredHost = await scope();
    setHosts([]);
    setHosts([descriptor]);
    const rapidReadd = await scope();
    expect(new Set([first, rotated, restoredCredential, restoredHost, rapidReadd]).size).toBe(5);
    expect(remote.requests).toBe(0);
  });

  it('rejects a late physical response when credentials rotate and return to their original value', async () => {
    const { hub, remote, setHosts } = await aggregate({ requireClientAuth: true });
    let reached;
    const entered = new Promise((resolve) => { reached = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    remote.app.get('/api/fs/late-scope', async (_req, res) => {
      reached();
      await gate;
      if (!res.destroyed) res.json({ stale: true });
    });
    const descriptor = { id: 'remote-1', label: 'Remote', source: 'direct', apiUrl: remote.url, clientToken: remote.issued.token };
    const initial = (await (await hub.call('/api/hosts')).json()).hosts[0].scopeGeneration;
    const pending = hub.call('/api/hosts/remote-1/api/fs/late-scope');
    try {
      await entered;
      const issued = await remote.clients.createClient({ clientKind: 'desktop-local', authMethod: 'pairing', pairingId: 'rotated' });
      setHosts([{ ...descriptor, clientToken: issued.token }]);
      setHosts([descriptor]);
      await hub.gateway.reconcile();
      const current = (await (await hub.call('/api/hosts')).json()).hosts[0].scopeGeneration;
      expect(current).not.toBe(initial);
      release();
      const old = await pending;
      expect([409, 503]).toContain(old.status);
      expect(await old.json()).not.toHaveProperty('stale');
      expect(await (await hub.call('/api/hosts/remote-1/api/fs/raw')).text()).toBe('remote file body');
      expect(remote.statusStreams).toBe(0);
    } finally { release(); }
  });

  it('preserves authoritative optional file existence through the Hub for present, empty and missing files', async () => {
    const { hub, remote } = await aggregate({ requireClientAuth: true });
    registerFsRoutes(remote.app, { os, path, fsPromises: fs, crypto,
      normalizeDirectoryPath: (value) => value, yuriDataDir: remote.directory });
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: remote.directory });
    for (const [name, content, exists] of [
      ['present.txt', 'remote file contents', true], ['empty.txt', '', true], ['missing.txt', '', false],
    ]) {
      const file = path.join(remote.directory, name);
      if (exists) await fs.writeFile(file, content);
      const route = `/api/fs/read?${new URLSearchParams({ path: file, optional: 'true', directory: remote.directory })}`;
      const authoritative = await remote.call(route);
      expect(authoritative.status).toBe(200);
      expect(authoritative.headers.get('x-yuri-file-exists')).toBe(String(exists));
      const forwarded = await hub.call(`/api/hosts/remote-1${route}`);
      expect(forwarded.status).toBe(200);
      expect.soft(forwarded.headers.get('x-yuri-file-exists'), name).toBe(String(exists));
      expect(await forwarded.text()).toBe(await authoritative.text());
    }
  });

  it('streams attachment bytes and integrity headers to remote storage without forwarding client credentials', async () => {
    const { hub, remote } = await aggregate({ requireClientAuth: true });
    registerFsRoutes(remote.app, { os, path, fsPromises: fs, crypto,
      normalizeDirectoryPath: (value) => value, yuriDataDir: remote.directory });
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: remote.directory });
    const received = [];
    const capture = (req) => {
      if (req.url.startsWith('/api/fs/prompt-attachments/')) received.push(req.headers);
    };
    remote.server.prependListener('request', capture);
    try {
      for (const [name, mime, bytes] of [
        ['文件.bin', 'application/octet-stream', Buffer.from([0, 255, 128, 13, 10])],
        ['data.json', 'application/json', Buffer.from('{  "keep": true }\n')],
      ]) {
        const digest = crypto.createHash('sha256').update(bytes).digest('hex');
        const headers = { ...hub.headers, 'content-type': mime,
          'x-yuri-content-length': String(bytes.length), 'x-yuri-sha256': digest,
          'x-yuri-mime': mime, 'x-yuri-filename': encodeURIComponent(name),
          'x-opencode-directory': remote.directory, cookie: 'hub-only=value', 'x-unrelated': 'not-forwarded' };
        const route = `${hub.url}/api/hosts/remote-1/api/fs/prompt-attachments/att-bytes?storage=temporary`;
        const response = await fetch(route, { method: 'PUT', headers, body: bytes });
        expect(response.status).toBe(200);
        const stored = await response.json();
        disposers.push(() => fs.rm(path.dirname(stored.path), { recursive: true, force: true }));
        expect(stored).toMatchObject({ success: true, size: bytes.length, sha256: digest, mime });
        expect(path.basename(stored.path)).toBe(name);
        expect(await fs.readFile(stored.path)).toEqual(bytes);
        const upstream = received.at(-1);
        expect(upstream.authorization === remote.headers.Authorization).toBe(true);
        expect(upstream.cookie).toBeUndefined();
        expect(upstream['x-unrelated']).toBeUndefined();
        const invalid = await fetch(route, { method: 'PUT', headers: { ...headers, 'x-yuri-sha256': '0'.repeat(64) }, body: bytes });
        expect(invalid.status).toBe(400);
        expect(await invalid.json()).toEqual({ error: 'Attachment digest mismatch' });
      }
    } finally { remote.server.off('request', capture); }
  });

  it('does not resurrect a reference deleted while the remote project catalog refresh was in flight', async () => {
    const { hub, remote } = await aggregate();
    const first = await (await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' })).json();
    const second = await (await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/another/path' })).json();
    let reached;
    const reachedCatalog = new Promise(resolve => { reached = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const holdCatalog = (req, res) => {
      if (req.method !== 'GET' || new URL(req.url, remote.url).pathname !== '/api/projects') return;
      const end = res.end;
      res.end = function (...args) { reached(); void gate.then(() => { if (!res.destroyed) end.apply(res, args); }); return res; };
    };
    remote.server.prependListener('request', holdCatalog);
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    try {
      await reachedCatalog;
      expect((await hub.call(`/api/hosts/remote-1/projects/${first.project.id}`, 'DELETE')).status).toBe(204);
      release();
      await wait(() => expect(hub.store.receipt('remote-1').lastSyncedAt).toBeTruthy());
      expect(hub.store.projects().map(project => project.id)).toEqual([second.project.id]);
      expect((await hub.call(`/api/hosts/remote-1/projects/${second.project.id}`, 'DELETE')).status).toBe(204);
      await wait(() => expect(remote.statusStreams).toBe(0));
    } finally { release(); abort.abort(); await stream.body.cancel().catch(() => {}); remote.server.off('request', holdCatalog); }
  });
  it('does not restore a Hub reference deleted while a metadata PATCH is completing remotely', async () => {
    const { hub, remote } = await aggregate();
    const { project } = await (await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' })).json();
    const send = hub.gateway.json;
    let completed;
    const completion = new Promise(resolve => { completed = resolve; });
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    hub.gateway.json = async (...args) => {
      const result = await send(...args);
      if (args[2]?.method === 'PATCH') { completed(); await gate; }
      return result;
    };
    const patch = hub.call(`/api/hosts/remote-1/projects/${project.id}`, 'PATCH', { label: 'remote committed' });
    try {
      await completion;
      expect((await hub.call(`/api/hosts/remote-1/projects/${project.id}`, 'DELETE')).status).toBe(204);
      release();
      expect((await patch).status).toBe(404);
      expect(hub.store.hasProjects()).toBe(false);
      expect(remote.projects[0].label).toBe('remote committed');
    } finally { release(); hub.gateway.json = send; }
  });
  it('authorizes file targets against the authoritative root, strips Hub path credentials and revokes through the Host', async () => {
    const { hub, remote } = await aggregate({ requireClientAuth: true });
    const root = path.join(remote.directory, 'file-project');
    await fs.mkdir(path.join(root, 'nested'), { recursive: true });
    await fs.writeFile(path.join(root, 'index.html'), '<link rel="stylesheet" href="style.css"><p>remote file</p>');
    await fs.writeFile(path.join(root, 'style.css'), 'body { color: red; }');
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: root });
    const received = [];
    const capture = (req) => received.push({ method: req.method, url: req.url,
      usesRemoteCredential: req.headers.authorization === `Bearer ${remote.issued.token}` });
    remote.server.prependListener('request', capture);
    const created = await hub.call('/api/hosts/remote-1/api/preview/targets', 'POST', {
      kind: 'file', directory: path.join(root, 'nested'), path: path.join(root, 'index.html'),
    });
    expect(created.status).toBe(200);
    const target = await created.json();
    expect(target.kind).toBe('file');
    const tokenResponse = await (await hub.call('/auth/url-token', 'POST', {})).json();
    const hubToken = tokenResponse.token;
    expect(typeof hubToken).toBe('string');
    const route = `${target.proxyBasePath}/_file/${target.previewToken}/${hubToken}${target.entryPath}`;
    const document = await fetch(hub.url + route);
    expect(document.status).toBe(200);
    expect(document.headers.get('referrer-policy')).toBe('no-referrer');
    expect(document.headers.get('cache-control')).toContain('no-store');
    expect(await document.text()).toContain('remote file');
    const asset = await fetch(new URL('style.css', hub.url + route));
    expect(asset.status).toBe(200); expect(await asset.text()).toContain('color: red');
    const forwarded = received.filter(req => req.url.includes('/_file/'));
    expect(forwarded.length).toBe(2);
    expect(forwarded.every(req => !req.url.includes(hubToken) && req.url.includes(`/${target.previewToken}/-/`) && req.usesRemoteCredential)).toBe(true);
    const beforeDenied = received.length;
    for (const directory of ['/not-referenced', `${root}/../outside`, `${root}/./nested`]) {
      expect((await hub.call('/api/hosts/remote-1/api/preview/targets', 'POST', {
        kind: 'file', directory, path: path.join(root, 'index.html'),
      })).status).toBe(404);
    }
    expect(received.length).toBe(beforeDenied);
    const ws = new WebSocket(`${hub.url.replace('http:', 'ws:')}${route}`, { headers: hub.headers });
    await new Promise(resolve => { ws.on('error', resolve); ws.on('unexpected-response', (_req, response) => { response.resume(); resolve(); }); });
    expect(ws.readyState).not.toBe(WebSocket.OPEN); ws.terminate();
    expect((await fetch(`${hub.url}/api/hosts/remote-1/api/preview/targets?yuri_url_token=${hubToken}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'file', directory: root, path: path.join(root, 'index.html') }),
    })).status).toBe(401);
    expect((await fetch(`${hub.url}/api/hosts/remote-1/api/preview/targets/${target.id}?yuri_url_token=${hubToken}`, {
      method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ previewToken: target.previewToken }),
    })).status).toBe(401);
    expect((await hub.call(`/api/hosts/remote-1/api/preview/targets/${target.id}`, 'DELETE', { previewToken: target.previewToken })).status).toBe(204);
    expect((await hub.call(route)).status).toBe(404);
    remote.server.off('request', capture);
  });
  it('releases the last project status stream while the authorized Hub window stays online', async () => {
    const { hub, remote } = await aggregate();
    const first = await (await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' })).json();
    const second = await (await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/another/path' })).json();
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    try {
      await wait(() => expect(remote.statusStreams).toBe(1));
      expect((await hub.call(`/api/hosts/remote-1/projects/${first.project.id}`, 'DELETE')).status).toBe(204);
      expect(remote.statusStreams).toBe(1);
      expect((await hub.call(`/api/hosts/remote-1/projects/${second.project.id}`, 'DELETE')).status).toBe(204);
      await wait(() => expect(remote.statusStreams).toBe(0));
      expect(hub.liveClients).toBe(1);
      expect(remote.projects).toHaveLength(2);
    } finally { abort.abort(); await stream.body.cancel().catch(() => {}); }
  });
  it('asks the remote scheduler to discover summaries without requiring a remote UI window', async () => {
    const { hub, remote } = await aggregate();
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    expect(remote.indexSyncRequests).toEqual([]);
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    try {
      await wait(() => expect(remote.indexSyncRequests).toEqual([['/same/path']]));
      await wait(async () => expect((await (await hub.call('/api/hosts/remote-1/summaries')).json()).directories)
        .toHaveLength(1));
      const before = remote.indexRequests;
      remote.emit({ type: 'yuri:session-index-changed', properties: { cause: 'change' } });
      await wait(() => expect(remote.indexRequests).toBeGreaterThan(before));
      expect(remote.indexSyncRequests).toHaveLength(1);
    } finally { abort.abort(); await stream.body.cancel().catch(() => {}); }
  });
  it('forwards scoped form reads and replies to the remote authority', async () => {
    const { hub, remote } = await aggregate();
    remote.app.get('/api/form', (_req, res) => res.json([{ id: 'remote-form', sessionID: 'remote-session' }]));
    remote.app.post('/api/form/:id/reply', express.json(), (req, res) => res.json({ id: req.params.id, reply: req.body }));
    expect(await (await hub.call('/api/hosts/remote-1/api/form')).json()).toEqual([{ id: 'remote-form', sessionID: 'remote-session' }]);
    expect(await (await hub.call('/api/hosts/remote-1/api/form/remote-form/reply', 'POST', { answers: ['yes'] })).json())
      .toEqual({ id: 'remote-form', reply: { answers: ['yes'] } });
  });
  it('does not revive persisted busy status merely because a reconnect opened its status stream', async () => {
    const { hub, remote } = await aggregate();
    remote.setSummaries({ directories: [{ directory: '/same/path', hasMore: false, sessions: [{
      id: 'busy-session', directory: '/same/path', title: 'Busy', time: { created: 1, updated: 2 },
      metadata: { yuri: { sessionStatus: { type: 'busy', changedAt: Date.now() } } },
    }] }] });
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    const firstAbort = new AbortController();
    const first = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: firstAbort.signal });
    const snapshot = async () => (await hub.call('/api/hosts/remote-1/summaries')).json();
    await wait(async () => expect((await snapshot()).stale).toBe(false));
    firstAbort.abort(); await first.body.cancel().catch(() => {});
    await wait(() => expect(remote.statusStreams).toBe(0));
    let resume;
    remote.setIndexGate(new Promise((resolve) => { resume = resolve; }));
    const before = remote.indexRequests;
    const secondAbort = new AbortController();
    const second = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: secondAbort.signal });
    try {
      await wait(() => expect(remote.indexRequests).toBeGreaterThan(before));
      const pending = await snapshot();
      expect(pending.stale).toBe(true);
      expect(pending.directories[0].sessions[0].metadata.yuri.sessionStatus.type).toBe('unknown');
      resume();
      await wait(async () => expect((await snapshot()).stale).toBe(false));
    } finally { resume(); secondAbort.abort(); await second.body.cancel().catch(() => {}); }
  });
  it('keeps external worktree summaries and content under their authoritative remote project', async () => {
    const { hub, remote } = await aggregate();
    remote.setWorktrees(['/same/path', '/outside/branch']);
    remote.setSummaries({ directories: ['/same/path', '/same/path/nested', '/outside/branch', '/unrelated'].map((directory, i) => ({
      directory, sessions: [{ id: `session-${i}`, directory, title: directory, time: { created: 1, updated: 2 } }], hasMore: false,
    })) });
    expect((await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' })).status).toBe(200);
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    const snapshot = async () => (await hub.call('/api/hosts/remote-1/summaries')).json();
    try {
      await wait(async () => expect((await snapshot()).directories.map((row) => row.directory).sort())
        .toEqual(['/outside/branch', '/same/path', '/same/path/nested']));
      expect((await hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/outside/branch', sessionId: 'session-2' })).status).toBe(200);
      expect((await hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/unrelated', sessionId: 'session-3' })).status).toBe(404);
      const reopened = createRemoteHostStore(path.join(hub.directory, 'remote-hosts.sqlite'));
      try { expect(reopened.organization('remote-1').worktrees.projectDirectories['/same/path']).toEqual(['/same/path', '/outside/branch']); }
      finally { reopened.close(); }
      const worktreeRequests = remote.worktreeRequests;
      const indexRequests = remote.indexRequests;
      remote.emit({ type: 'yuri:session-index-changed', properties: { cause: 'change' } });
      await wait(() => expect(remote.indexRequests).toBeGreaterThan(indexRequests));
      await wait(async () => expect((await snapshot()).lastSyncedAt).toBeGreaterThan(0));
      expect(remote.worktreeRequests).toBe(worktreeRequests);
      remote.setWorktreeFailure(true);
      remote.emit({ type: 'yuri:worktree-topology-changed', properties: { projectDirectory: '/same/path', directory: '/outside/branch', operation: 'removed' } });
      await wait(async () => expect((await snapshot()).worktrees.staleProjectDirectories).toEqual(['/same/path']));
      expect((await snapshot()).directories.some((row) => row.directory === '/outside/branch')).toBe(true);
      remote.setWorktreeFailure(false);
      remote.setWorktrees(['/same/path']);
      remote.emit({ type: 'yuri:worktree-topology-changed', properties: { projectDirectory: '/same/path', directory: '/outside/branch', operation: 'removed' } });
      await wait(async () => expect((await snapshot()).directories.some((row) => row.directory === '/outside/branch')).toBe(false));
      expect((await snapshot()).worktrees.staleProjectDirectories).toEqual([]);
    } finally {
      abort.abort(); await stream.body.cancel().catch(() => {});
    }
  });
  it('maps only the effective nested source directory into each authoritative worktree', async () => {
    const { hub, remote } = await aggregate();
    remote.setWorktrees(['/repo', '/outside/branch']);
    remote.setSummaries({ directories: ['/repo', '/repo/src', '/outside/branch', '/outside/branch/src', '/outside/branch/docs'].map((directory) => ({
      directory, sessions: [], hasMore: false,
    })) });
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/repo/src' });
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    try {
      await wait(async () => expect((await (await hub.call('/api/hosts/remote-1/summaries')).json()).directories.map((row) => row.directory).sort())
        .toEqual(['/outside/branch/src', '/repo/src']));
      expect((await hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/outside/branch' })).status).toBe(404);
      expect((await hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/outside/branch/docs' })).status).toBe(404);
      expect((await hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/repo/src/../docs' })).status).toBe(404);
      expect((await hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/outside/branch/src' })).status).toBe(200);
      const snapshot = await (await hub.call('/api/hosts/remote-1/summaries')).json();
      expect(snapshot.worktrees.projectDirectories['/repo/src']).toEqual(['/repo/src', '/outside/branch/src']);
    } finally { abort.abort(); await stream.body.cancel().catch(() => {}); }
  });
  it('keeps local-only startup at zero upstream requests/subscriptions and never exposes host credentials', async () => {
    const { hub, remote } = await aggregate();
    expect(remote.requests).toBe(0);
    const response = await hub.call('/api/hosts');
    const list = await response.json();
    expect(list.hosts[0]).toMatchObject({ id: 'remote-1', source: 'direct', state: 'idle' });
    expect(JSON.stringify(list)).not.toContain(remote.issued.token);
    expect(JSON.stringify(list)).not.toContain(remote.url);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(remote.requests).toBe(0);
    expect(remote.statusStreams).toBe(0);
  });

  it('rejects passwordless browsers, arbitrary cookies, unpaired clients and missing hosts', async () => {
    const { hub } = await aggregate();
    expect((await fetch(`${hub.url}/api/hosts`)).status).toBe(401);
    expect((await fetch(`${hub.url}/api/hosts`, { headers: { Cookie: 'yuri_ui_session=forged' } })).status).toBe(401);
    const ordinary = await hub.clients.createClient({ clientKind: 'mobile', authMethod: 'password' });
    expect((await fetch(`${hub.url}/api/hosts`, { headers: { Authorization: `Bearer ${ordinary.token}` } })).status).toBe(403);
    expect((await hub.call('/api/hosts/absent/api/fs/raw')).status).toBe(404);
  });

  it('admits the native local credential while a passwordless session alone cannot discover remote hosts', async () => {
    const { hub } = await aggregate();
    const session = await fetch(`${hub.url}/auth/session`);
    expect(session.status).toBe(200);
    expect((await fetch(`${hub.url}/api/hosts`)).status).toBe(401);
    const token = await hub.clients.ensureDesktopLocalClientToken('');
    const response = await fetch(`${hub.url}/api/hosts`, { headers: { Authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    expect((await response.json()).hosts).toHaveLength(1);
    expect((await fetch(`${hub.url}/api/hosts`)).status).toBe(401);
  });

  it('creates remote first; retries a Hub disk failure by association without duplicating or deleting remote data', async () => {
    const { hub, remote } = await aggregate({ failHubWrite: true });
    const route = '/api/hosts/remote-1/projects';
    expect((await hub.call(route, 'POST', { path: '/same/path', label: 'Remote project' })).status).toBe(503);
    expect(remote.projects).toHaveLength(1);
    const first = await (await hub.call(route, 'POST', { path: '/same/path' })).json();
    expect(first.project).toMatchObject({ hostId: 'remote-1', path: '/same/path', remoteState: 'ok' });
    const again = await (await hub.call(route, 'POST', { path: '/same/path' })).json();
    expect(again.project.id).toBe(first.project.id);
    expect(remote.projects).toHaveLength(1);
    expect((await hub.call(`${route}/${first.project.id}`, 'PATCH', { label: 'Changed', color: 'blue' })).status).toBe(200);
    expect(remote.projects[0].label).toBe('Changed');
    expect((await hub.call(`${route}/${first.project.id}`, 'DELETE')).status).toBe(204);
    expect(remote.projects).toHaveLength(1);
    expect(hub.store.projects()).toHaveLength(0);
    expect(remote.statusStreams).toBe(0);
    expect(remote.indexRequests).toBe(0);
  });

  it('allows an Agent to discover an unassociated machine and add its first project through the same persisted UI authority', async () => {
    const { hub, remote } = await aggregate();
    const discovery = await runRemoteProjectOperation(hub.gateway, 'remote-hosts', {});
    expect(discovery).toMatchObject({ hosts: [{ name: 'Remote', target: { hubId: hub.store.hubId, hostId: 'remote-1', instanceId: remote.store.hubId } }], complete: true });
    expect(hub.store.projects()).toEqual([]);
    const target = discovery.hosts[0].target;
    const tip = vi.fn(); const unsubscribe = hub.broadcast.subscribe(tip);
    try {
      const added = await runRemoteProjectOperation(hub.gateway, 'add-remote', { target, path: '/remote-only/项目 & # 100%', label: 'Remote project' });
      expect(added).toMatchObject({ created: true, target, project: { hostId: 'remote-1', instanceId: target.instanceId, path: '/remote-only/项目 & # 100%', label: 'Remote project' } });
      expect(remote.projects).toHaveLength(1);
      expect(hub.projects).toEqual([]);
      expect((await (await hub.call('/api/hosts/projects')).json()).projects).toEqual([added.project]);
      expect(tip.mock.calls.filter(([event]) => event.type === 'yuri:project-order-changed')).toHaveLength(1);
      const repeated = await (await hub.call('/api/hosts/remote-1/projects', 'POST', { path: added.project.path, label: 'Do not rename' })).json();
      expect(repeated).toEqual({ project: added.project, created: false });
      expect(tip.mock.calls.filter(([event]) => event.type === 'yuri:project-order-changed')).toHaveLength(1);
      expect(hub.gateway.assertProjectDirectory(target.hostId, added.project.path)).toBe(added.project.path);
      const remoteCreate = vi.fn((req, res) => res.json({ data: { ...req.body, time: { created: 1, updated: 1 } } }));
      const localCreate = vi.fn((_req, res) => res.status(500).end());
      remote.app.post('/api/session', express.json(), remoteCreate);
      hub.app.post('/api/session', express.json(), localCreate);
      const created = await runRemoteProjectOperation(hub.gateway, 'create-session', {
        target, directory: added.project.path, sessionID: 'ses_remote_new', title: 'Remote worker',
      });
      expect(created).toMatchObject({ created: true, session: { sessionID: 'ses_remote_new', directory: added.project.path, target } });
      expect(remoteCreate).toHaveBeenCalledOnce();
      expect(localCreate).not.toHaveBeenCalled();
      expect(remote.statusStreams).toBe(0);
      expect(remote.indexRequests).toBe(0);
      expect(remote.content.size).toBe(0);
      await expect(runRemoteProjectOperation(hub.gateway, 'add-remote', { target: { ...target, instanceId: 'replacement' }, path: '/wrong-target' })).rejects.toMatchObject({ code: 'remote_instance_mismatch' });
      expect(remote.projects).toHaveLength(1);
    } finally { unsubscribe(); }
  });

  it('retains remote registration after an Agent Hub write failure and safely completes the same association on retry', async () => {
    const { hub, remote } = await aggregate({ failHubWrite: true });
    const { hosts } = await runRemoteProjectOperation(hub.gateway, 'remote-hosts', {});
    const input = { target: hosts[0].target, path: '/remote-only' };
    await expect(runRemoteProjectOperation(hub.gateway, 'add-remote', input)).rejects.toThrow('injected disk failure');
    expect(remote.projects).toHaveLength(1);
    expect(hub.store.projects()).toEqual([]);
    const saved = await runRemoteProjectOperation(hub.gateway, 'add-remote', input);
    expect(saved.created).toBe(true);
    expect((await runRemoteProjectOperation(hub.gateway, 'add-remote', input)).created).toBe(false);
    expect(remote.projects).toHaveLength(1);
    expect(hub.store.projects()).toHaveLength(1);
    expect(hub.projects).toEqual([]);
    expect(remote.statusStreams).toBe(0);
  });

  it('multiplexes one lightweight status stream, retains SQLite summaries offline and releases all streams on revoke', async () => {
    const { hub, remote } = await aggregate();
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    remote.setSummaries({ directories: [{ directory: '/same/path', sessions: [{ id: 'same-session', title: 'Remote title',
      directory: '/same/path', time: { created: 1, updated: 2 }, metadata: { yuri: { sessionStatus: { type: 'busy' } } } }], hasMore: false }] });
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    const reader = stream.body.getReader();
    const events = [];
    const read = (async () => { try {
      for (;;) { const value = await reader.read(); if (value.done) break; events.push(new TextDecoder().decode(value.value)); }
    } catch { /* revoke/abort closes the stream */ } })();
    await wait(() => expect(remote.statusStreams).toBe(1));
    await wait(async () => expect((await (await hub.call('/api/hosts/remote-1/summaries')).json()).directories[0]?.sessions[0]?.title).toBe('Remote title'));
    remote.emit({ type: 'session.renamed', data: { sessionID: 'same-session', title: 'Renamed' }, created: Date.now() });
    await wait(() => expect(events.join('')).toContain('Renamed'));
    remote.emit({ type: 'message.part.delta', properties: { sessionID: 'same-session', delta: 'SECRET_BODY' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.join('')).not.toContain('SECRET_BODY');
    await hub.clients.revokeClient(hub.issued.client.id);
    await wait(() => expect(remote.statusStreams).toBe(0));
    await wait(() => expect(hub.liveClients).toBe(0));
    abort.abort(); await read;
    const snapshot = hub.gateway.summaries('remote-1');
    expect(snapshot.stale).toBe(true);
    expect(snapshot.directories[0].sessions[0].title).toBe('Renamed');
    expect(snapshot.directories[0].sessions[0].metadata.yuri.sessionStatus.type).toBe('unknown');
  });

  it('preserves failed metadata writes and marks remote removal without deleting the Hub reference', async () => {
    const { hub, remote } = await aggregate();
    const route = '/api/hosts/remote-1/projects';
    const { project } = await (await hub.call(route, 'POST', { path: '/same/path', label: 'Original' })).json();
    remote.projects.splice(0);
    const failed = await hub.call(`${route}/${project.id}`, 'PATCH', { label: 'Not committed' });
    expect(failed.status).toBe(404);
    expect(hub.store.projects()[0].label).toBe('Original');
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    await wait(() => expect(hub.store.projects()[0].remoteState).toBe('remote-removed'));
    expect(hub.store.projects()[0].id).toBe(project.id);
    const restored = await (await hub.call(route, 'POST', { path: '/same/path', label: 'Restored' })).json();
    expect(restored.project).toMatchObject({ id: project.id, label: 'Restored', remoteState: 'ok' });
    expect(remote.projects).toHaveLength(1);
    abort.abort(); await stream.body.cancel().catch(() => {});
  });

  it('proxies content without Hub cache writes or client credentials and rejects machine mutations/recursive aggregation', async () => {
    const { hub, remote } = await aggregate();
    const response = await fetch(`${hub.url}/api/hosts/remote-1/api/session/s1/message?directory=%2Fsame%2Fpath`, {
      method: 'POST', headers: { ...hub.headers, Cookie: 'private=hub-cookie' }, body: JSON.stringify({ text: 'UNIQUE_TRANSCRIPT_MARKER' }),
    });
    const payload = await response.json();
    expect(payload.received.text).toBe('UNIQUE_TRANSCRIPT_MARKER');
    expect(remote.messageHeaders.authorization).toBe(`Bearer ${remote.issued.token}`);
    expect(remote.messageHeaders.cookie).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain(remote.issued.token);
    for (const route of ['api/config', 'api/hosts', 'api/yuri/transcript-cache/session', 'api/system/update']) {
      expect((await hub.call(`/api/hosts/remote-1/${route}`, 'POST', {})).status).toBe(403);
    }
    expect((await hub.call('/api/yuri/transcript-cache/session?hostId=remote-1&transport=remote:hub:host&generation=0&directory=/same/path&sessionID=s1')).status).toBe(403);
    for (const name of ['remote-hosts.sqlite', 'session-index.sqlite', 'transcript-cache.sqlite']) {
      const bytes = await fs.readFile(path.join(hub.directory, name)).catch((error) => {
        if (error.code === 'ENOENT') return Buffer.alloc(0); throw error;
      });
      expect(bytes.includes(Buffer.from('UNIQUE_TRANSCRIPT_MARKER'))).toBe(false);
    }
    const Database = require('better-sqlite3');
    const db = new Database(path.join(hub.directory, 'transcript-cache.sqlite'));
    expect(db.prepare('SELECT count(*) AS n FROM transcript_cache_content').get().n).toBe(0);
    db.close();
  });

  it('shares content leases across clients and refuses a ninth active subscription instead of evicting readers', async () => {
    const { hub, remote } = await aggregate();
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    const lease = async (sessionId) => hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/same/path', sessionId });
    const a = await (await lease('s0')).json();
    const b = await (await lease('s0')).json();
    await wait(() => expect(remote.content.size).toBe(1));
    await hub.call(`/api/hosts/remote-1/subscriptions/${a.id}`, 'DELETE');
    expect(remote.content.size).toBe(1);
    for (let i = 1; i < 8; i++) expect((await lease(`s${i}`)).status).toBe(200);
    expect((await lease('s9')).status).toBe(429);
    expect(remote.content.size).toBeLessThanOrEqual(8);
    await hub.call(`/api/hosts/remote-1/subscriptions/${b.id}`, 'DELETE');
    abort.abort(); await stream.body.cancel().catch(() => {});
    await wait(() => expect(remote.content.size).toBe(0));
  });

  it('routes terminal WebSocket upgrades through the host prefix with real credentials', async () => {
    const { hub } = await aggregate();
    const socket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/api/hosts/remote-1/api/terminal/ws`, { headers: hub.headers });
    await once(socket, 'open');
    const reply = once(socket, 'message'); socket.send('terminal input');
    expect((await reply)[0].toString()).toBe('terminal input');
    socket.close(); await once(socket, 'close');
  });

  it('shares one delayed SSH preparation and transport across simultaneous cold HTTP requests', async () => {
    const remote = await host();
    const descriptor = { id: 'ssh-cold', source: 'ssh', apiUrl: remote.url, clientToken: remote.issued.token };
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const prepareHost = vi.fn(async () => { await gate; return descriptor; });
    const hub = await host({ adapter: { listHosts: async () => [descriptor], prepareHost } });
    const requests = Array.from({ length: 5 }, async () => {
      const response = await hub.call('/api/hosts/ssh-cold/api/fs/raw');
      return { status: response.status, body: await response.text() };
    });
    await wait(() => expect(prepareHost).toHaveBeenCalledTimes(1));
    release();
    expect(await Promise.all(requests)).toEqual(Array.from({ length: 5 }, () => ({ status: 200, body: 'remote file body' })));
    expect(prepareHost).toHaveBeenCalledTimes(1);
    expect(remote.capabilityRequests).toBe(1);
  });

  it('explicit connect waits through SSH preparation and remote admission without starting directory or status reads', async () => {
    const remote = await host();
    const descriptor = { id: 'ssh-cold', source: 'ssh', apiUrl: remote.url, clientToken: remote.issued.token };
    let sshReady;
    let serviceReady;
    const sshGate = new Promise((resolve) => { sshReady = resolve; });
    remote.setCapabilityGate(new Promise((resolve) => { serviceReady = resolve; }));
    let progress;
    const prepareHost = vi.fn(async (_id, { onProgress }) => { progress = onProgress; await sshGate; return descriptor; });
    const hub = await host({ adapter: { listHosts: async () => [descriptor], prepareHost }, requestTimeoutMs: 5000 });
    let completed = false;
    const connection = hub.call('/api/hosts/ssh-cold/connect', 'POST').then((response) => { completed = true; return response; });
    try {
      await wait(() => expect(prepareHost).toHaveBeenCalledOnce());
      expect(completed).toBe(false);
      expect(remote.requests).toBe(0);
      for (const phase of ['checking', 'installing', 'updating', 'starting']) {
        progress(phase);
        const catalog = await (await hub.call('/api/hosts')).json();
        expect(catalog.hosts[0]).toMatchObject({ state: 'connecting', preparationPhase: phase });
      }
      progress('private native detail');
      expect((await (await hub.call('/api/hosts')).json()).hosts[0].preparationPhase).toBe('starting');
      sshReady();
      await wait(() => expect(remote.capabilityRequests).toBe(1));
      progress('updating');
      expect((await (await hub.call('/api/hosts')).json()).hosts[0].preparationPhase).toBeUndefined();
      expect(completed).toBe(false);
      serviceReady();
      const response = await connection;
      expect(response.status).toBe(200);
      expect((await response.json()).host).toMatchObject({ id: 'ssh-cold', version: 'test-version' });
      expect(remote.requests).toBe(1);
      expect(remote.statusStreams).toBe(0);
      expect(remote.indexRequests).toBe(0);
    } finally {
      sshReady(); serviceReady();
      await connection;
    }
  });

  it('broadcasts safe SSH progress on the existing client stream and clears failed/late preparation before retry', async () => {
    const remote = await host();
    const descriptor = { id: 'ssh-cold', source: 'ssh', apiUrl: remote.url, clientToken: remote.issued.token };
    let progress;
    let rejectPreparation;
    const gate = new Promise((_resolve, reject) => { rejectPreparation = reject; });
    const prepareHost = vi.fn(async (_id, { onProgress }) => { progress = onProgress; await gate; return descriptor; });
    const hub = await host({ adapter: { listHosts: async () => [descriptor], prepareHost } });
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    const reader = stream.body.getReader();
    const events = [];
    const read = (async () => { try {
      for (;;) { const value = await reader.read(); if (value.done) break; events.push(new TextDecoder().decode(value.value)); }
    } catch { /* abort closes the stream */ } })();
    const connection = hub.call('/api/hosts/ssh-cold/connect', 'POST');
    try {
      await wait(() => expect(prepareHost).toHaveBeenCalledOnce());
      progress('updating');
      await wait(() => expect(events.join('')).toContain('"preparationPhase":"updating"'));
      rejectPreparation(Object.assign(new Error('private native details'), { code: 'remote_ssh_unavailable' }));
      expect((await connection).status).toBe(503);
      await wait(() => expect(events.join('')).toContain('"state":"offline"'));
      expect(events.join('')).not.toContain('private native details');
      progress('installing');
      expect((await (await hub.call('/api/hosts')).json()).hosts[0].preparationPhase).toBeUndefined();
      expect(events.join('')).not.toContain('"preparationPhase":"installing"');
      prepareHost.mockImplementation(async (_id, { onProgress }) => {
        onProgress('checking');
        progress('installing');
        expect((await (await hub.call('/api/hosts')).json()).hosts[0].preparationPhase).toBe('checking');
        return descriptor;
      });
      expect((await hub.call('/api/hosts/ssh-cold/connect', 'POST')).status).toBe(200);
    } finally {
      rejectPreparation(new Error('test cleanup')); await connection;
      abort.abort(); await read;
    }
  });

  it('isolates colliding host/session paths, keeps offline partitions and fairly bounds refresh work with a stalled host', async () => {
    const stats = { active: 0, max: 0 };
    const remotes = await Promise.all(Array.from({ length: 3 }, () => host({ indexStats: stats })));
    const descriptors = remotes.map((remote, index) => ({ id: `host-${index}`, name: `Host ${index}`, source: 'direct',
      apiUrl: remote.url, clientToken: remote.issued.token }));
    const hub = await host({ adapter: { listHosts: async () => descriptors }, requestTimeoutMs: 2000 });
    const summary = (title) => ({ directories: [{ directory: '/same/path', sessions: [{ id: 'same-id', title,
      directory: '/same/path', time: { created: 1, updated: Date.now() } }], hasMore: false }] });
    for (let index = 0; index < 3; index++) {
      remotes[index].setSummaries(summary(`Title ${index}`));
      expect((await hub.call(`/api/hosts/host-${index}/projects`, 'POST', { path: '/same/path' })).status).toBe(200);
    }
    expect(new Set(hub.store.projects().map((project) => project.id)).size).toBe(3);
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    for (let index = 0; index < 3; index++) await wait(async () => {
      const snapshot = await (await hub.call(`/api/hosts/host-${index}/summaries`)).json();
      expect(snapshot.directories[0]?.sessions[0]?.title).toBe(`Title ${index}`);
    });
    let release;
    remotes[0].setIndexGate(new Promise((resolve) => { release = resolve; }));
    for (let index = 0; index < 3; index++) {
      remotes[index].setSummaries(summary(`New ${index}`));
      remotes[index].broadcast({ type: 'yuri:session-index-changed', properties: { cause: 'change' } });
    }
    for (const index of [1, 2]) await wait(async () => {
      const snapshot = await (await hub.call(`/api/hosts/host-${index}/summaries`)).json();
      expect(snapshot.directories[0]?.sessions[0]?.title).toBe(`New ${index}`);
    });
    expect(remotes[0].indexActive).toBe(1);
    expect(stats.max).toBeLessThanOrEqual(2);
    expect(remotes.every((remote) => remote.indexMax === 1)).toBe(true);
    abort.abort(); await stream.body.cancel().catch(() => {});
    await wait(() => expect(remotes.every((remote) => remote.statusStreams === 0)).toBe(true));
    await wait(() => expect(remotes[0].indexActive).toBe(0));
    release();
    const reopened = createRemoteHostStore(path.join(hub.directory, 'remote-hosts.sqlite'));
    const offline = createRemoteHostGateway({ store: reopened, indexDbPath: path.join(hub.directory, 'session-index.sqlite') });
    expect(reopened.hubId).toBe(hub.store.hubId);
    expect(offline.summaries('host-0').directories[0].sessions[0].title).toBe('Title 0');
    expect(offline.summaries('host-1').directories[0].sessions[0].title).toBe('New 1');
    expect(offline.summaries('host-2').directories[0].sessions[0].title).toBe('New 2');
    offline.stop();
  });

  it('never sends host content to anonymous or unpaired global-stream consumers', async () => {
    const { hub, remote } = await aggregate();
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    const aborts = [new AbortController(), new AbortController()];
    const authorized = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: aborts[0].signal });
    const unauthorized = await fetch(`${hub.url}/api/global/event`, { signal: aborts[1].signal });
    const text = ['', ''];
    const reads = [authorized, unauthorized].map(async (response, index) => {
      try { for await (const chunk of response.body) text[index] += new TextDecoder().decode(chunk); } catch { /* Stream disposal. */ }
    });
    await hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/same/path', sessionId: 's1' });
    await wait(() => expect(remote.content.size).toBe(1));
    for (const res of remote.content) res.write(`data: ${JSON.stringify({ type: 'message.part.delta', properties: { sessionID: 's1', delta: 'AUTHORIZED_REMOTE_CONTENT' } })}\n\n`);
    await wait(() => expect(text[0]).toContain('AUTHORIZED_REMOTE_CONTENT'));
    expect(text[1]).not.toContain('yuri:host-');
    expect(text[1]).not.toContain('AUTHORIZED_REMOTE_CONTENT');
    for (const abort of aborts) abort.abort(); await Promise.all(reads);
  });

  it('closes direct terminal sockets when the saved host or credential is removed', async () => {
    const { hub, setHosts } = await aggregate();
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    const socket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/api/hosts/remote-1/api/terminal/ws`, { headers: hub.headers });
    await once(socket, 'open');
    const closed = once(socket, 'close');
    setHosts([]);
    await closed;
    const list = await (await hub.call('/api/hosts')).json();
    expect(list.projects[0].remoteState).toBe('host-unavailable');
    expect(list.hosts[0]).toMatchObject({ id: 'remote-1', available: false, state: 'offline' });
  });

  it('does not resurrect a content lease if its owner is revoked while the host is connecting', async () => {
    const { hub, remote } = await aggregate();
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    let release;
    remote.setCapabilityGate(new Promise((resolve) => { release = resolve; }));
    const before = remote.capabilityRequests;
    const pending = hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/same/path', sessionId: 'pending' });
    await wait(() => expect(remote.capabilityRequests).toBeGreaterThan(before));
    await hub.clients.revokeClient(hub.issued.client.id);
    release();
    expect((await pending).status).toBe(401);
    expect(remote.content.size).toBe(0);
  });

  it('closes existing direct terminal sockets when the issuing Hub client is revoked', async () => {
    const { hub } = await aggregate();
    const socket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/api/hosts/remote-1/api/terminal/ws`, { headers: hub.headers });
    await once(socket, 'open');
    const closed = once(socket, 'close');
    await hub.clients.revokeClient(hub.issued.client.id);
    await closed;
    expect((await hub.call('/api/hosts')).status).toBe(401);
  });

  it('rejects a terminal upgrade if its client is revoked during the upstream handshake', async () => {
    const { hub, remote } = await aggregate();
    let admit;
    remote.setCapabilityGate(new Promise((resolve) => { admit = resolve; }));
    const socket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/api/hosts/remote-1/api/terminal/ws`, { headers: hub.headers });
    let opened = false;
    socket.on('open', () => { opened = true; });
    socket.on('error', () => {});
    try {
      await wait(() => expect(remote.capabilityRequests).toBeGreaterThan(0));
      await hub.clients.revokeClient(hub.issued.client.id);
      admit();
      await wait(() => expect(socket.readyState).toBe(WebSocket.CLOSED));
      expect(opened).toBe(false);
    } finally {
      admit();
      socket.terminate();
    }
  });

  it('bounds response-header waits even for the streaming HTTP proxy', async () => {
    const { hub, remote } = await aggregate({ requestTimeoutMs: 200 });
    remote.app.get('/api/session/stall', (_req, _res) => {});
    const controller = new AbortController();
    let status;
    const request = fetch(`${hub.url}/api/hosts/remote-1/api/session/stall`, {
      headers: hub.headers, signal: controller.signal,
    }).then((response) => { status = response.status; }, () => {});
    try {
      await wait(() => expect(status).toBe(503));
    } finally {
      controller.abort();
      await request;
    }
  });

  it('continues another hosts refresh while an interactive response body is still streaming', async () => {
    const slow = await host();
    const fast = await host();
    const hub = await host({ adapter: { listHosts: async () => [
      { id: 'slow', source: 'direct', apiUrl: slow.url, clientToken: slow.issued.token },
      { id: 'fast', source: 'direct', apiUrl: fast.url, clientToken: fast.issued.token },
    ] } });
    for (const id of ['slow', 'fast']) await hub.call(`/api/hosts/${id}/projects`, 'POST', { path: '/same/path' });
    const streams = new AbortController();
    const globalStream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: streams.signal });
    const requestAbort = new AbortController();
    let response;
    try {
      await wait(() => expect(fast.statusStreams).toBe(1));
      await wait(async () => expect((await (await hub.call('/api/hosts/fast/summaries')).json()).lastSyncedAt).toBeGreaterThan(0));
      slow.app.get('/api/session/stream', (_req, res) => {
        res.type('application/json'); res.flushHeaders(); res.write('{');
      });
      response = await fetch(`${hub.url}/api/hosts/slow/api/session/stream`, {
        headers: hub.headers, signal: requestAbort.signal,
      });
      const previous = fast.indexRequests;
      fast.emit({ type: 'yuri:session-index-changed', properties: { cause: 'change' } });
      await wait(() => expect(fast.indexRequests).toBeGreaterThan(previous));
    } finally {
      requestAbort.abort(); streams.abort();
      await response?.body?.cancel().catch(() => {});
      await globalStream.body.cancel().catch(() => {});
    }
  });

  it('times out incomplete session JSON but allows a file body to outlive that deadline', async () => {
    const { hub, remote } = await aggregate({ requestTimeoutMs: 200 });
    remote.app.get('/api/session/incomplete', (_req, res) => {
      res.type('application/json'); res.flushHeaders(); res.write('{');
    });
    const controller = new AbortController();
    const incomplete = await fetch(`${hub.url}/api/hosts/remote-1/api/session/incomplete`, {
      headers: hub.headers, signal: controller.signal,
    });
    let rejected = false;
    const body = incomplete.text().catch(() => { rejected = true; });
    try {
      await wait(() => expect(rejected).toBe(true));
    } finally {
      controller.abort(); await body;
    }
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    remote.app.get('/api/fs/serve/large', async (_req, res) => {
      res.type('application/octet-stream'); res.flushHeaders(); res.write('first-');
      await gate;
      res.end('last');
    });
    const file = await hub.call('/api/hosts/remote-1/api/fs/serve/large');
    const content = file.text();
    try {
      await new Promise((resolve) => setTimeout(resolve, 250));
      release();
      expect(await content).toBe('first-last');
    } finally {
      release();
    }
  });

  it('does not apply the short snapshot timeout to a synchronous shell operation', async () => {
    const { hub, remote } = await aggregate({ requestTimeoutMs: 100, operationTimeoutMs: 2000 });
    remote.app.post('/api/session/task/shell', async (_req, res) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      res.json({ complete: true });
    });
    const response = await hub.call('/api/hosts/remote-1/api/session/task/shell', 'POST', { command: 'fixture' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ complete: true });
  });

  it('closes direct terminal sockets after the target revokes its saved credential', async () => {
    const { hub, remote } = await aggregate();
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    await wait(() => expect(remote.statusStreams).toBe(1));
    const socket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/api/hosts/remote-1/api/terminal/ws`, { headers: hub.headers });
    await once(socket, 'open');
    const closed = once(socket, 'close');
    await remote.clients.revokeClient(remote.issued.client.id);
    await closed;
    abort.abort(); await stream.body.cancel().catch(() => {});
  });

  it('sends ready for each shared lease and changes ready generation after content reconnect', async () => {
    const { hub, remote } = await aggregate();
    await hub.call('/api/hosts/remote-1/projects', 'POST', { path: '/same/path' });
    const abort = new AbortController();
    const response = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    let text = '';
    const read = (async () => { try { for await (const chunk of response.body) text += new TextDecoder().decode(chunk); } catch { /* Stream disposal. */ } })();
    const first = await (await hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/same/path', sessionId: 'shared' })).json();
    await wait(() => expect(text).toContain(first.id));
    const second = await (await hub.call('/api/hosts/remote-1/subscriptions', 'POST', { directory: '/same/path', sessionId: 'shared' })).json();
    expect(second.channelId).toBe(first.channelId);
    await wait(() => expect(text).toContain(second.id));
    const generations = () => [...text.matchAll(/"readyGeneration":"([^"]+)"/g)].map((match) => match[1]);
    const initial = generations()[0];
    await hub.call(`/api/hosts/remote-1/subscriptions/${first.id}`, 'DELETE');
    for (const res of remote.content) res.end();
    await wait(() => expect(new Set(generations()).size).toBeGreaterThan(1));
    expect(generations().at(-1)).not.toBe(initial);
    abort.abort(); await read;
  });

  it('keeps preview registration, HTML subresources and redirects on the selected host without forwarding Hub URL tokens', async () => {
    const { hub } = await aggregate();
    const target = http.createServer((req, res) => {
      if (req.url === '/asset.css') { res.writeHead(200, { 'Content-Type': 'text/css' }); res.end('body{color:red}'); return; }
      if (req.url === '/redirect') { res.writeHead(302, { Location: '/next' }); res.end(); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<!doctype html><link rel="stylesheet" href="/asset.css"><body>Remote preview</body>');
    });
    target.listen(0, '127.0.0.1'); await once(target, 'listening');
    disposers.push(() => new Promise((resolve) => target.close(resolve)));
    const registration = await (await hub.call('/api/hosts/remote-1/api/preview/targets', 'POST', {
      url: `http://127.0.0.1:${target.address().port}`,
    })).json();
    expect(registration.proxyBasePath).toMatch(/^\/api\/hosts\/remote-1\/api\/preview\/proxy\//);
    const authResponse = await hub.call('/auth/url-token', 'POST');
    const token = (await authResponse.json()).token;
    const previewUrl = `${hub.url}${registration.proxyBasePath}/?yuri_preview_token=${registration.previewToken}&yuri_url_token=${token}`;
    const html = await (await fetch(previewUrl)).text();
    expect(html).toContain('/api/hosts/remote-1/api/preview/proxy/');
    expect(html).not.toContain('__YURI_HUB_URL_AUTH__');
    const assetMatch = html.match(/href="([^"]*asset\.css[^"]*)"/);
    expect(assetMatch).not.toBeNull();
    expect((await fetch(`${hub.url}${assetMatch[1].replaceAll('&amp;', '&')}`)).status).toBe(200);
    const redirect = await fetch(`${hub.url}${registration.proxyBasePath}/redirect?yuri_preview_token=${registration.previewToken}&yuri_url_token=${token}`, { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get('location')).toContain(`${registration.proxyBasePath}/next`);
  });

  it.each([0, 1, 2])('uses the real E2EE Relay client for Relay-only hosts, including terminal forwarding (%i)', async (iteration) => {
    const productionTerminal = iteration === 2;
    const remote = await host({ requireClientAuth: true, productionTerminal });
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
    const relayUrl = relay.wsUrl;
    const relayHost = startRelayHost({ relayUrl, identity, getLocalPort: () => remote.server.address().port,
      authorizeRequest: remote.auth.authorizeRelayRequest, onStatus: () => {}, logger: { info() {}, warn() {} } });
    disposers.push(async () => { relayHost.stop(); await relay.stop(); });
    const paired = await remote.clients.createClient({ clientKind: 'desktop', authMethod: 'pairing', pairingId: 'relay-pair', usesRelay: true });
    const descriptor = { id: 'relay-only', name: 'Relay Host', source: 'relay', clientToken: paired.token,
      relay: { relayUrl, serverId, hostEncPubJwk: identity.hostEncPubJwk } };
    const hub = await host({ adapter: { listHosts: async () => [descriptor] }, requestTimeoutMs: 5000 });
    if (productionTerminal) {
      const authorize = hub.auth.resolveAuthContext;
      let upgrades = 0;
      hub.auth.resolveAuthContext = async (...args) => {
        const result = await authorize(...args);
        if (args[0].headers.upgrade === 'websocket' && ++upgrades === 2) await new Promise((resolve) => setTimeout(resolve, 30));
        return result;
      };
    }
    const reads = await Promise.all(Array.from({ length: 5 }, async () => {
      const response = await hub.call('/api/hosts/relay-only/api/fs/raw');
      return { status: response.status, body: await response.text() };
    }));
    expect(reads).toEqual(Array.from({ length: 5 }, () => ({ status: 200, body: 'remote file body' })));
    const abort = new AbortController();
    const stream = await fetch(`${hub.url}/api/global/event`, { headers: hub.headers, signal: abort.signal });
    const created = await hub.call('/api/hosts/relay-only/projects', 'POST', { path: '/same/path' });
    expect({ status: created.status, body: await created.json() }).toMatchObject({ status: 200,
      body: { project: { hostId: 'relay-only', path: '/same/path' } } });
    const { hosts: authenticatedHosts } = await runRemoteProjectOperation(hub.gateway, 'remote-hosts', {});
    const target = authenticatedHosts[0].target;
    const registered = await runRemoteProjectOperation(hub.gateway, 'add-remote', { target, path: '/agent-relay-project' });
    expect(registered).toMatchObject({ created: true, target, project: { path: '/agent-relay-project', hostId: 'relay-only' } });
    const createSession = vi.fn((req, res) => res.json({ data: { ...req.body, time: { created: 1, updated: 1 } } }));
    remote.app.post('/api/session', express.json(), createSession);
    expect(await runRemoteProjectOperation(hub.gateway, 'create-session', { target, directory: registered.project.path, sessionID: 'ses_relay_new' }))
      .toMatchObject({ created: true, session: { sessionID: 'ses_relay_new', directory: registered.project.path, target } });
    expect(createSession).toHaveBeenCalledOnce();
    await wait(() => expect(remote.statusStreams).toBe(1));
    const socket = new WebSocket(`${hub.url.replace('http:', 'ws:')}/api/hosts/relay-only/api/terminal/ws`, { headers: hub.headers });
    disposers.push(() => socket.terminate());
    const frames = [];
    if (productionTerminal) socket.on('message', (data) => frames.push(readTerminalWsControlFrame(data)));
    await once(socket, 'open');
    if (productionTerminal) {
      await wait(() => expect(frames).toContainEqual({ t: 'ok', v: 2 }));
      socket.send(createTerminalWsControlFrame({ t: 'p' }));
      await wait(() => expect(frames).toContainEqual({ t: 'po', v: 2 }));
      socket.send(createTerminalWsControlFrame({ t: 'b', s: 'missing-session' }));
      await wait(() => expect(frames).toContainEqual({ t: 'e', c: 'SESSION_NOT_FOUND', f: false }));
    } else {
      const reply = once(socket, 'message'); socket.send('encrypted terminal');
      expect((await reply)[0].toString()).toBe('encrypted terminal');
    }
    socket.close(); await once(socket, 'close');
    abort.abort(); await stream.body.cancel().catch(() => {});
    await wait(() => expect(remote.statusStreams).toBe(0));
    const onEvent = vi.fn();
    const task = await hub.gateway.acquireTask('relay-only', { instanceId: remote.store.hubId, onEvent });
    expect(hub.liveClients).toBe(0);
    await wait(() => expect(remote.statusStreams).toBe(1));
    expect((await task.json('/api/projects')).projects[0].path).toBe('/same/path');
    remote.emit({ type: 'session.execution.succeeded', data: { sessionID: 'remote-worker', directory: '/same/path' } });
    await wait(() => expect(onEvent.mock.calls.some(([event]) => event.payload.type === 'session.execution.succeeded')).toBe(true));
    task.release();
    await wait(() => expect(remote.statusStreams).toBe(0));
  }, 20000);
});
