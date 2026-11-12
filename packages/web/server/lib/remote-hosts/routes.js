import { WebSocketServer } from 'ws';
import express from 'express';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createProjectRegistry } from '../projects/registry.js';
import { projectRemoteStatusEvent, remoteFailure } from './gateway.js';
import { projectMetadata } from './store.js';
import { REMOTE_PREVIEW_TOKEN_MARKER, replacePreviewToken } from './preview-scope.js';
import { projectRemoteConfiguration } from './configuration.js';
import { RUNTIME_CONTRACT_MIN_VERIFIED } from '../opencode/runtime-contract.js';
import { parseFilePreviewPath, replaceFilePreviewUrlAuthToken } from '../preview/file-preview-path.js';

const websocketPath = (path) => path === '/api/terminal/ws' || path.startsWith('/api/preview/proxy/');
const safeRoute = (route, method) => {
  if (!route.startsWith('/api/') || /[\\\r\n]/.test(route)) return false;
  const pathname = new URL(route, 'http://remote.invalid').pathname;
  if (pathname === '/api/magic-prompts'
    || /^\/api\/github\/(?:auth\/status|issues\/(?:list|get|comments)|pulls\/(?:list|context))$/.test(pathname)) {
    return method === 'GET' || method === 'HEAD';
  }
  if (pathname.startsWith('/api/yuri/content-search') && method !== 'GET') return false;
  if (/^\/api\/config\/(?:settings|global|.*\/file)(\/|$)/.test(pathname)
    || (/^\/api\/experimental(?:\/|$)/.test(pathname) && !/^\/api\/experimental\/worktree(?:\/|$)/.test(pathname))) return false;
  if (/^\/api\/(hosts|client-auth|system|gui-network|remote-desktop|assistants|scheduled-tasks)(\/|$)/.test(pathname)
    || /^\/api\/yuri\/(transcript-cache|config-sync|relay|realtime-proxy)(\/|$)/.test(pathname)) return false;
  if (method !== 'GET' && method !== 'HEAD' && /^\/api\/(config|provider|plugin|mcp|global|agent|command|skill|settings|opencode|push)(\/|$)/.test(pathname)) return false;
  return /^\/api\/(info|fs|git|terminal|preview|session|sessions|session-folders|session-order|permission|permission-auto-accept|question|question-auto-delegate|form|command|agent|provider|config|plugin|skill|mcp|find|file|vcs|path|project|projects|experimental|location|session-activity)(\/|$)/.test(pathname)
    || /^\/api\/yuri\/(session|session-index|session-unread|session-folders|session-order|message-queue|content-search|events)(\/|$)/.test(pathname);
};
const report = (res, error) => {
  if (res.headersSent) return res.destroy();
  const code = error?.code || 'remote_unavailable';
  // Transport failures may contain URL credentials or content. Never serialize
  // arbitrary upstream Error.message or log the request/response body.
  const allowed = new Set(['remote_incompatible', 'remote_authorization_required', 'host_unavailable',
    'project_not_found', 'validation_error', 'stale_host', 'subscription_not_found', 'content_capacity', 'remote_request_failed',
    'remote_ssh_authentication_failed', 'remote_ssh_unavailable', 'remote_relay_unavailable', 'remote_service_starting']);
  const publicCode = allowed.has(code) ? code : 'remote_unavailable';
  return res.status(error?.status || 503).json({ code: publicCode, error: publicCode,
    retryable: ![401, 403, 404, 409].includes(error?.status),
    ...(publicCode === 'remote_incompatible' ? { minimumVersion: { remoteProjectsProtocol: 1, opencode: RUNTIME_CONTRACT_MIN_VERIFIED } } : {}) });
};

export function registerRemoteHostRoutes(app, { gateway, getAuth, server, isRequestOriginAllowed,
  remoteClientAuthRuntime, readSettings, persistSettings, validateDirectoryPath,
  globalEventHub, broadcaster, supportedRemote = false, version = 'unknown', getOpenCodeCompatibility = () => null }) {
  const store = gateway.store;
  const registry = createProjectRegistry({ persistSettings, validateDirectoryPath });
  const jsonParser = express.json({ limit: '1mb' });
  const parseMutation = (req, res, next) => jsonParser(req, res, (error) => {
    if (error) return res.status(400).json({ code: 'validation_error', error: 'Invalid project mutation payload' });
    next();
  });
  const resources = new Map();
  const tracked = new Set();
  const authorizedResources = new Map();
  const expirations = new Map();
  const expiryTimers = new Map();
  const closeOwner = (owner) => {
    for (const [resource, id] of authorizedResources) if (id === owner) authorizedResources.delete(resource);
    for (const close of [...(resources.get(owner) || [])]) close();
    gateway.releaseOwner(owner);
  };
  const armExpiry = (owner, force = false) => {
    if (expiryTimers.has(owner) || (!force && !store.projects().length) || !expirations.get(owner)) return;
    const delay = Math.max(0, expirations.get(owner) - Date.now());
    const timer = setTimeout(() => {
      expiryTimers.delete(owner);
      if (expirations.get(owner) <= Date.now()) closeOwner(owner);
      else armExpiry(owner, force);
    }, Math.min(delay, 2147483647));
    timer.unref?.(); expiryTimers.set(owner, timer);
  };
  const authorize = async (req, res, { aggregate = true } = {}) => {
    const clientRequest = Object.create(req);
    clientRequest.headers = { ...req.headers };
    delete clientRequest.headers.cookie;
    const auth = await getAuth()?.resolveAuthContext(clientRequest, res);
    // A password-less browser cookie is not a pairing grant. Native local
    // clients use a real server-issued desktop-local credential as well.
    if (auth?.type !== 'client' || !auth.clientId) throw remoteFailure('remote_authorization_required', 401);
    const client = auth.client || (await remoteClientAuthRuntime?.listClients?.())?.find((entry) => entry.id === auth.clientId);
    if (!client) throw remoteFailure('remote_authorization_required', 401);
    if (client.revokedAt || (client.expiresAt && Date.parse(client.expiresAt) <= Date.now())) throw remoteFailure('remote_authorization_required', 401);
    if (aggregate && client.clientKind !== 'desktop-local'
      && !(client.authMethod === 'pairing' && client.pairingId && ['desktop', 'mobile'].includes(client.clientKind))) {
      throw remoteFailure('remote_authorization_required', 403);
    }
    if (client.expiresAt) expirations.set(auth.clientId, Date.parse(client.expiresAt));
    return auth.clientId;
  };
  const retainResource = (owner, close) => {
    let entries = resources.get(owner);
    if (!entries) { entries = new Set(); resources.set(owner, entries); }
    entries.add(close);
    armExpiry(owner);
    return () => {
      entries.delete(close);
      if (!entries.size) {
        resources.delete(owner); clearTimeout(expiryTimers.get(owner)); expiryTimers.delete(owner);
      }
    };
  };
  const track = (req, res, owner) => {
    if (tracked.has(res)) return;
    tracked.add(res);
    authorizedResources.set(res, owner);
    const release = gateway.observe(res, owner);
    const remove = retainResource(owner, () => res.destroy());
    res.once('close', () => { tracked.delete(res); authorizedResources.delete(res); release(); remove(); });
  };
  const revoke = remoteClientAuthRuntime?.subscribeRevocation?.((id) => {
    closeOwner(id);
  }) || (() => {});
  // This is the already-existing client -> Hub stream, not a new socket per host.
  app.use((req, res, next) => {
    if (!/^\/api\/(global\/event|event)(?:\?|$)/.test(req.originalUrl || req.url)) return next();
    const writeHead = res.writeHead;
    res.writeHead = function (...args) {
      const result = writeHead.apply(this, args);
      if (this.statusCode === 200) void authorize(req, res).then((owner) => {
        if (!res.destroyed && !res.writableEnded) track(req, res, owner);
      }).catch(() => {});
      return result;
    };
    next();
  });

  // Local-only directory authority. Returning only local projects prevents
  // A -> B from silently aggregating B -> C and prevents cycles.
  app.get('/api/projects', async (_req, res) => {
    try { res.json({ projects: (await readSettings()).projects?.filter((p) => !p.hostId) || [] }); }
    catch (error) { report(res, error); }
  });
  app.post('/api/projects', async (req, res) => {
    try {
      await authorize(req, res, { aggregate: false });
      const result = await registry.register({ ...req.body, activate: false });
      app.emit('yuri:projects-changed');
      res.json({ project: result.project, created: result.created });
    } catch (error) { report(res, error); }
  });
  app.patch('/api/projects/:id', async (req, res) => {
    try {
      await authorize(req, res, { aggregate: false });
      let project;
      const settings = await persistSettings((current) => ({ projects: (current.projects || []).map((entry) => {
        if (entry.id !== req.params.id || entry.hostId) return entry;
        project = { ...entry, ...projectMetadata(req.body) }; return project;
      }) }));
      project = settings.projects?.find((p) => p.id === req.params.id);
      if (!project) throw remoteFailure('project_not_found', 404);
      app.emit('yuri:projects-changed');
      res.json({ project });
    } catch (error) { report(res, error); }
  });
  app.get('/api/hosts/capabilities', async (req, res) => {
    try {
      await authorize(req, res, { aggregate: false });
      res.json({ remoteProjects: supportedRemote, protocol: 1, instanceId: store.hubId, version,
        opencode: getOpenCodeCompatibility() });
    } catch (error) { report(res, error); }
  });
  app.get('/api/hosts/status-stream', async (req, res) => {
    try {
      const owner = await authorize(req, res, { aggregate: false });
      res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      res.flushHeaders();
      const send = (event) => {
        let payload = projectRemoteStatusEvent(event.payload || event);
        if (!payload) return;
        if (payload.type === 'yuri:notification') payload = { type: payload.type, properties: {
          sessionID: payload.properties?.sessionID, sessionId: payload.properties?.sessionId,
          title: payload.properties?.title, kind: payload.properties?.kind, tag: payload.properties?.tag,
          directory: payload.properties?.directory, event: payload.properties?.event,
          instanceId: payload.properties?.instanceId || store.hubId } };
        const frame = `data: ${JSON.stringify({ directory: event.directory || payload.properties?.directory || 'global', payload })}\n\n`;
        if (res.writableLength > 256 * 1024) return res.destroy();
        res.write(frame);
      };
      const unsubscribeNative = globalEventHub.subscribeEvent(send);
      const unsubscribeYuri = broadcaster.subscribe((payload, options) => send({ payload, directory: options?.directory }));
      const projectsChanged = () => send({ type: 'yuri:projects-changed', properties: {} });
      app.on('yuri:projects-changed', projectsChanged);
      const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 1000);
      const remove = retainResource(owner, () => res.destroy());
      armExpiry(owner, true);
      res.once('close', () => { clearInterval(heartbeat); unsubscribeNative(); unsubscribeYuri(); remove(); app.off('yuri:projects-changed', projectsChanged); });
      res.write(': ready\n\n');
    } catch (error) { report(res, error); }
  });
  app.get('/api/hosts', (_req, res, next) => {
    if (gateway.supported) return next();
    res.json({ supported: false, hubId: store.hubId, hosts: [], projects: [], reason: 'pc_hub_required' });
  });
  app.use('/api/hosts', async (req, res, next) => {
    try {
      req.remoteHostOwner = await authorize(req, res);
      const operation = new AbortController();
      req.remoteHostSignal = operation.signal;
      const remove = retainResource(req.remoteHostOwner, () => {
        operation.abort();
        if (!res.headersSent) res.status(401).json({ code: 'remote_authorization_required', error: 'remote_authorization_required' });
        else res.destroy();
      });
      const release = gateway.observe(res, req.remoteHostOwner, { status: false });
      const hostMatch = /^\/api\/hosts\/([^/]+)(?:\/|$)/.exec(req.originalUrl);
      const priority = /\/api\/session(?:\/|\?)/.test(req.originalUrl)
        || (req.method !== 'GET' && req.method !== 'HEAD');
      const releaseHost = hostMatch ? gateway.retainHost(decodeURIComponent(hostMatch[1]), res, priority) : () => {};
      res.once('close', () => { operation.abort(); release(); releaseHost(); remove(); });
      res.setHeader('Cache-Control', 'private, no-store');
      next();
    } catch (error) { report(res, error); }
  });
  app.get('/api/hosts', async (_req, res) => {
    try { res.json(await gateway.list()); } catch (error) { report(res, error); }
  });
  app.get('/api/hosts/projects', (_req, res) => res.json({ projects: store.projects() }));
  app.get('/api/hosts/:hostId/summaries', (req, res) => {
    try { res.json(gateway.summaries(req.params.hostId)); } catch (error) { report(res, error); }
  });
  app.post('/api/hosts/:hostId/connect', async (req, res) => {
    try { res.json({ host: await gateway.connect(req.params.hostId) }); } catch (error) { report(res, error); }
  });
  app.post('/api/hosts/:hostId/projects', parseMutation, async (req, res) => {
    try {
      const remote = await gateway.json(req.params.hostId, '/api/projects', { method: 'POST',
        signal: req.remoteHostSignal,
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: req.body?.path, label: req.body?.label }) });
      if (req.remoteHostSignal.aborted) throw remoteFailure('remote_authorization_required', 401);
      if (!remote.project?.id || !remote.project?.path || remote.project.hostId) throw remoteFailure('remote_invalid_project');
      const existed = store.projects(req.params.hostId).some((p) => p.path === remote.project.path);
      const project = store.saveProject(req.params.hostId, remote.project);
      for (const owner of resources.keys()) armExpiry(owner);
      gateway.projectReferencesChanged(req.params.hostId);
      if (!existed) broadcaster({ type: 'yuri:project-order-changed', properties: { occurredAt: Date.now() } });
      res.json({ project, created: !existed });
    } catch (error) { report(res, error); }
  });
  app.patch('/api/hosts/:hostId/projects/:projectId', parseMutation, async (req, res) => {
    try {
      const project = store.projects(req.params.hostId).find((p) => p.id === req.params.projectId);
      if (!project) throw remoteFailure('project_not_found', 404);
      const remote = await gateway.json(req.params.hostId, `/api/projects/${encodeURIComponent(project.remoteProjectId)}`,
        { method: 'PATCH', signal: req.remoteHostSignal, headers: { 'content-type': 'application/json' }, body: JSON.stringify(projectMetadata(req.body)) });
      if (req.remoteHostSignal.aborted) throw remoteFailure('remote_authorization_required', 401);
      const refreshed = store.refreshProject(project, remote.project);
      if (!refreshed) throw remoteFailure('project_not_found', 404);
      res.json({ project: refreshed });
    } catch (error) { report(res, error); }
  });
  app.delete('/api/hosts/:hostId/projects/:projectId', (req, res) => {
    const removed = store.removeProject(req.params.hostId, req.params.projectId);
    if (removed) broadcaster({ type: 'yuri:project-order-changed', properties: { occurredAt: Date.now() } });
    gateway.projectReferencesChanged(req.params.hostId); res.status(204).end();
  });
  app.post('/api/hosts/:hostId/subscriptions', parseMutation, async (req, res) => {
    let lease;
    try {
      lease = await gateway.subscribe(req.params.hostId, req.body, req.remoteHostOwner);
      await authorize(req, res);
      if (res.destroyed || req.aborted) throw remoteFailure('remote_authorization_required', 401);
      res.json(lease);
    }
    catch (error) {
      if (lease) { try { gateway.release(req.params.hostId, lease.id, req.remoteHostOwner); } catch { /* Revocation may already have removed it. */ } }
      report(res, error);
    }
  });
  app.delete('/api/hosts/:hostId/subscriptions/:id', (req, res) => {
    try { gateway.release(req.params.hostId, req.params.id, req.remoteHostOwner); res.status(204).end(); }
    catch (error) { report(res, error); }
  });
  app.post('/api/hosts/:hostId/api/preview/targets', parseMutation, (req, res, next) => {
    try {
      if (req.body?.kind === 'file') {
        const directory = gateway.assertProjectDirectory(req.params.hostId, req.body.directory);
        req.body = { ...req.body, directory };
      }
      next();
    } catch (error) { report(res, error); }
  });
  app.delete('/api/hosts/:hostId/api/preview/targets/:id', parseMutation, (_req, _res, next) => next());
  app.use('/api/hosts/:hostId', async (req, res) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    res.once('close', abort);
    const remove = retainResource(req.remoteHostOwner, () => { controller.abort(); res.destroy(); });
    try {
      const route = req.url;
      if (!safeRoute(route, req.method)) return res.status(403).json({ code: 'remote_scope_forbidden', error: 'remote_scope_forbidden' });
      const url = new URL(route, 'http://remote.invalid');
      if (url.pathname.startsWith('/api/preview/proxy/') && url.pathname.includes('/_file/')) {
        if (!parseFilePreviewPath(url.pathname) || !['GET', 'HEAD'].includes(req.method)) {
          return res.status(403).json({ code: 'remote_scope_forbidden', error: 'remote_scope_forbidden' });
        }
        url.pathname = replaceFilePreviewUrlAuthToken(url.pathname, '-');
      }
      for (const key of ['yuri_url_token', 'oc_client_token']) url.searchParams.delete(key);
      const headers = {};
      const hostPrefix = `/api/hosts/${encodeURIComponent(req.params.hostId)}`;
      const preview = url.pathname.startsWith('/api/preview/');
      const previewAuth = preview ? await getAuth().issueClientUrlToken(req) : null;
      if (preview) headers['x-yuri-preview-hub-prefix'] = hostPrefix;
      for (const name of ['accept', 'content-type', 'x-opencode-directory', 'x-opencode-directory-encoding',
        'last-event-id', 'range', 'if-none-match', 'x-yuri-gui-revision',
        'x-yuri-content-length', 'x-yuri-sha256', 'x-yuri-mime', 'x-yuri-filename']) if (typeof req.headers[name] === 'string') headers[name] = req.headers[name];
      const init = { method: req.method, headers, signal: controller.signal };
      if (!['GET', 'HEAD'].includes(req.method)) {
        if (req.body !== undefined) init.body = JSON.stringify(req.body);
        else { init.body = Readable.toWeb(req); init.duplex = 'half'; }
      }
      const streaming = preview || init.duplex === 'half'
        || /^\/api\/fs\/(raw|serve)(\/|$)/.test(url.pathname)
        || /^\/api\/terminal\/[^/]+\/stream$/.test(url.pathname)
        || url.pathname === '/api/yuri/events';
      const response = await gateway.request(req.params.hostId, `${url.pathname}${url.search}`, init, {
        streaming, longRunning: streaming || !['GET', 'HEAD'].includes(req.method),
      });
      res.status(response.status);
      const location = response.headers.get('location');
      if (location) {
        const target = new URL(location, `http://remote.invalid${url.pathname}`);
        if (target.origin !== 'http://remote.invalid') throw remoteFailure('remote_redirect_forbidden', 502);
        const scoped = target.pathname.startsWith(`${hostPrefix}/`) ? target.pathname : `${hostPrefix}${target.pathname}`;
        res.setHeader('Location', `${scoped}${target.search}${target.hash}`.replaceAll(REMOTE_PREVIEW_TOKEN_MARKER, previewAuth?.token || ''));
      }
      for (const name of ['content-type', 'content-range', 'content-disposition', 'content-security-policy', 'referrer-policy', 'accept-ranges', 'etag', 'last-modified', 'x-inertia', 'x-yuri-gui-revision', 'x-yuri-gui-code', 'x-yuri-file-exists']) {
        const value = response.headers.get(name); if (value) res.setHeader(name, value);
      }
      if (/^\/api\/(config|provider|plugin|mcp|agent)(\/|$)/.test(url.pathname)
        && (response.headers.get('content-type') || '').includes('application/json')) {
        return res.json(projectRemoteConfiguration(await response.json()));
      }
      const textualPreview = preview && /text\/|javascript|ecmascript|application\/json/.test(response.headers.get('content-type') || '');
      const body = textualPreview && response.body ? replacePreviewToken(response.body, previewAuth?.token || '') : response.body;
      if (body) for await (const chunk of body) {
        if (controller.signal.aborted) break;
        if (!res.write(chunk)) await once(res, 'drain', { signal: controller.signal });
      }
      res.end();
    } catch (error) { if (!controller.signal.aborted) report(res, error); }
    finally { remove(); res.off('close', abort); }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const onUpgrade = async (req, socket, head) => {
    const url = new URL(req.url, 'http://hub.invalid');
    const match = /^\/api\/hosts\/([^/]+)(\/api\/.*)$/.exec(url.pathname);
    if (!match) {
      if (url.pathname === '/api/global/event/ws') {
        try {
          const owner = await authorize(req, null);
          authorizedResources.set(socket, owner);
          const release = gateway.observe(socket, owner);
          const remove = retainResource(owner, () => socket.destroy());
          socket.once('close', () => { authorizedResources.delete(socket); release(); remove(); });
        } catch { /* Existing message stream handler owns its authentication. */ }
      }
      return;
    }
    let upstream;
    let downstream;
    const pendingFrames = [];
    let pendingBytes = 0;
    let admissionFailed = false;
    let removeResource = () => {};
    try {
      if (!websocketPath(match[2]) || !await isRequestOriginAllowed(req)) throw remoteFailure('remote_authorization_required', 403);
      if (match[2].startsWith('/api/preview/proxy/') && match[2].includes('/_file/')) throw remoteFailure('remote_authorization_required', 403);
      const owner = await authorize(req, null);
      removeResource = retainResource(owner, () => { socket.destroy(); upstream?.close(); });
      const release = gateway.observe(socket, owner);
      const releaseHost = gateway.retainHost(decodeURIComponent(match[1]), socket);
      socket.once('close', () => { admissionFailed = true; pendingFrames.length = 0; upstream?.close(); removeResource(); release(); releaseHost(); });
      url.searchParams.delete('yuri_url_token');
      const protocols = typeof req.headers['sec-websocket-protocol'] === 'string'
        ? req.headers['sec-websocket-protocol'].split(',').map((value) => value.trim()).filter(Boolean) : [];
      upstream = await gateway.openWebSocket(decodeURIComponent(match[1]), `${match[2]}${url.search}`, protocols, {
        onMessage: ({ data }) => {
          if (admissionFailed) return;
          if (downstream?.readyState === 1) { downstream.send(data); return; }
          pendingBytes += Buffer.byteLength(data);
          if (pendingBytes > 1024 * 1024 || pendingFrames.length >= 256) {
            admissionFailed = true; pendingFrames.length = 0; upstream?.close();
            return;
          }
          pendingFrames.push(data);
        },
      });
      if (socket.destroyed || admissionFailed) throw remoteFailure('remote_authorization_required', 401);
      await new Promise((resolve, reject) => {
        if (upstream.readyState === 1) return resolve();
        if (upstream.readyState !== 0) return reject(remoteFailure('remote_unavailable'));
        const timer = setTimeout(() => { upstream.close(); reject(remoteFailure('remote_unavailable')); }, 15000);
        upstream.onopen = () => { clearTimeout(timer); resolve(); };
        upstream.onerror = upstream.onclose = () => { clearTimeout(timer); reject(remoteFailure('remote_unavailable')); };
      });
      await authorize(req, null);
      if (socket.destroyed || admissionFailed || upstream.readyState !== 1) throw remoteFailure('remote_authorization_required', 401);
      wss.handleUpgrade(req, socket, head, (client) => {
        downstream = client;
        upstream.onclose = () => client.close();
        upstream.onerror = () => client.close(1011);
        client.on('message', (data, binary) => {
          if (upstream.readyState === 1) upstream.send(binary ? data : data.toString());
        });
        client.once('close', () => { upstream.close(); removeResource(); });
        for (const data of pendingFrames) client.send(data);
        pendingFrames.length = 0; pendingBytes = 0;
      });
    } catch {
      admissionFailed = true; pendingFrames.length = 0;
      upstream?.close(); removeResource();
      if (!socket.destroyed) socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    }
  };
  server.on('upgrade', onUpgrade);
  return {
    canReceiveHostEvents(resource) {
      const owner = authorizedResources.get(resource) || authorizedResources.get(resource?._socket);
      return Boolean(owner && (!expirations.has(owner) || expirations.get(owner) > Date.now()));
    },
    stop() {
    revoke(); server.off('upgrade', onUpgrade);
    for (const timer of expiryTimers.values()) clearTimeout(timer);
    authorizedResources.clear();
    for (const entries of resources.values()) for (const close of [...entries]) close();
    wss.close(); gateway.stop();
  } };
}
