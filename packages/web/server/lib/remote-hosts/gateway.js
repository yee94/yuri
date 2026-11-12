import crypto from 'node:crypto';
import { createSessionIndexService } from '../session-index/service.js';
import { applySessionIndexEvent } from '../session-index/event-ingest.js';
import { createUpstreamSseReader } from '../event-stream/upstream-reader.js';
import { createRemoteTransport } from './transport.js';
import { remoteDeadlineSignal } from './deadline.js';

export const remoteFailure = (code, status = 503) => Object.assign(new Error(code), { code, status });
const publicError = (error) => {
  const code = error?.status === 401 || error?.status === 403 ? 'remote_authorization_required'
    : ['remote_incompatible', 'remote_ssh_authentication_failed', 'remote_ssh_unavailable', 'remote_relay_unavailable', 'remote_service_starting'].includes(error?.code) ? error.code
      : error?.code === 'host_unavailable' ? 'host_unavailable' : 'remote_unavailable';
  return { code, message: code };
};
const fingerprint = (host) => crypto.createHash('sha256').update(JSON.stringify(host)).digest('hex');
const directoryKey = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
const statusEvent = (payload) => /^(session\.(created|updated|deleted|renamed|moved|status|idle|error|execution\.(started|succeeded|failed|interrupted)|retry|model\.selected|inbox\.(enqueued|delivered))|yuri:session-(index-changed|status|activity|metadata|folders-changed|order-changed|unread-changed)|yuri:project.*|yuri:worktree-topology-changed|yuri:notification)$/.test((payload?.type || '').replace(/\.\d+$/, ''));
export const projectRemoteStatusEvent = (payload) => {
  if (!statusEvent(payload)) return null;
  const type = payload.type.replace(/\.\d+$/, '');
  if (type.startsWith('session.inbox.')) return { type: 'yuri:session-index-changed', properties: { cause: 'change' } };
  if (!type.startsWith('session.')) return payload;
  const select = (value) => {
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(['id', 'sessionID', 'title', 'directory', 'parentID', 'hasChildren', 'location', 'time', 'model', 'status']
      .filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
    if (value.info) result.info = select(value.info);
    if (value.metadata?.yuri) {
      const yuri = value.metadata.yuri;
      result.metadata = { yuri: Object.fromEntries(['assistant', 'assigned', 'scheduledTask', 'smallModel', 'llm', 'archive', 'titleRefresh', 'sessionStatus']
        .filter((key) => yuri[key] && typeof yuri[key] === 'object').map((key) => [key,
          Object.fromEntries(['assistantID', 'name', 'from', 'taskID', 'purpose', 'archivedAt', 'activityUpdatedAt', 'type', 'changedAt']
            .filter((field) => ['string', 'number'].includes(typeof yuri[key][field])).map((field) => [field, yuri[key][field]]))])) };
    }
    if (value.reason === 'shutdown') result.reason = 'shutdown';
    return result;
  };
  return { type: payload.type, ...(payload.created ? { created: payload.created } : {}),
    ...(payload.durable ? { durable: { seq: payload.durable.seq } } : {}),
    ...(payload.data ? { data: select(payload.data) } : {}),
    ...(payload.properties ? { properties: select(payload.properties) } : {}) };
};

export function createRemoteHostGateway({ store, indexDbPath, adapter, broadcast = () => {},
  transportFactory = createRemoteTransport, onNotification = null, maxContentSubscriptions = 8,
  requestTimeoutMs = 15000, operationTimeoutMs = 300000 }) {
  const connections = new Map();
  const scopes = new Map();
  const indexes = new Map();
  const leases = new Map();
  const observers = new Map();
  const statusObservers = new Set();
  const interactiveHosts = new Map();
  const priorityRequests = new Map();
  const contentChannels = new Map();
  const ownerGenerations = new Map();
  let stopped = false;
  let reconcilePromise = null;
  let reconcilePending = false;
  let refreshActive = 0;
  const refreshQueue = new Set();
  const indexFor = (hostId) => {
    let service = indexes.get(hostId);
    if (!service) {
      service = createSessionIndexService({ dbPath: indexDbPath,
        getRuntimeConfig: () => ({ apiBaseUrl: `hub:${store.hubId}:remote-host:${hostId}` }) });
      indexes.set(hostId, service);
    }
    return service;
  };
  const descriptors = async () => {
    const hosts = adapter ? await adapter.listHosts() : [];
    if (stopped) return hosts;
    const present = new Set();
    for (const host of hosts) {
      present.add(host.id);
      const identity = fingerprint(host);
      if (scopes.get(host.id)?.fingerprint !== identity) {
        scopes.set(host.id, { fingerprint: identity, generation: crypto.randomUUID() });
      }
    }
    for (const id of scopes.keys()) if (!present.has(id)) scopes.delete(id);
    return hosts;
  };
  const stateFor = (id) => connections.get(id)?.state || 'idle';
  const directoryResolver = (id) => {
    const projects = store.projects(id);
    const worktrees = store.organization(id).worktrees?.projectDirectories || {};
    const roots = projects.map((project) => ({ project, directory: project.path, root: directoryKey(project.path) }));
    const linked = projects.flatMap((project) => (worktrees[project.path] || [])
      .map((root) => ({ project, directory: root, root: directoryKey(root) })));
    return (directory) => {
      const key = directoryKey(directory);
      const match = (candidates) => {
        let best;
        for (const candidate of candidates) if ((key === candidate.root || key.startsWith(candidate.root === '/' ? '/' : `${candidate.root}/`))
          && (!best || candidate.root.length > best.root.length)) best = candidate;
        return best;
      };
      return match(roots) || match(linked);
    };
  };
  const assertProjectDirectory = (id, directory) => {
    if (typeof directory !== 'string' || directory.includes('\0')
      || directory.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) throw remoteFailure('project_not_found', 404);
    const owner = directoryResolver(id)(directory);
    if (!owner) throw remoteFailure('project_not_found', 404);
    return owner.directory;
  };
  const hostView = (host) => ({ id: host.id, name: host.name || host.label || host.id,
    source: host.source, available: true, state: stateFor(host.id), ...store.receipt(host.id),
    scopeGeneration: scopes.get(host.id)?.generation,
    generation: connections.get(host.id)?.generation,
    ...(connections.get(host.id)?.version ? { version: connections.get(host.id).version,
      capabilities: { remoteProjects: true } } : {}) });
  const setState = (connection, state, error) => {
    if (connections.get(connection.host.id) !== connection || stopped) return;
    const changed = connection.state !== state;
    connection.state = state;
    if (error) store.saveReceipt(connection.host.id, { lastError: publicError(error) });
    if (changed || error) broadcast({ type: 'yuri:host-status', properties: {
      hubId: store.hubId, hostId: connection.host.id, host: hostView(connection.host) } });
  };
  const emit = (hostId, payload, directory) => broadcast({ type: 'yuri:host-event', properties: {
    hubId: store.hubId, hostId, generation: connections.get(hostId)?.generation,
    ...(directory ? { directory } : {}), payload } });
  const closeConnection = (connection) => {
    connection.controller.abort();
    connection.reader?.stop();
    connection.transport?.close();
    for (const [id, lease] of leases) if (lease.hostId === connection.host.id) {
      releaseLease(id);
    }
    if (connections.get(connection.host.id) === connection) connections.delete(connection.host.id);
  };
  const current = (connection) => !stopped && !connection.controller.signal.aborted
    && connections.get(connection.host.id) === connection;
  const resolveHost = async (id) => {
    const host = (await descriptors()).find((entry) => entry.id === id);
    if (!host) {
      const old = connections.get(id);
      if (old) closeConnection(old);
      for (const project of store.projects(id)) store.markProject(project.id, 'host-unavailable');
      throw remoteFailure('host_unavailable', 404);
    }
    const old = connections.get(id);
    if (old && !old.preparing && (old.fingerprint !== fingerprint(host)
      || old.scopeGeneration !== scopes.get(id)?.generation)) closeConnection(old);
    return host;
  };
  const ensure = async (id) => {
    if (stopped || !observers.size) throw remoteFailure('gateway_no_clients');
    const host = await resolveHost(id);
    if (stopped || !observers.size) throw remoteFailure('gateway_no_clients');
    let connection = connections.get(id);
    if (!connection) {
      store.saveHost(host);
      connection = { host, fingerprint: fingerprint(host), scopeGeneration: scopes.get(id)?.generation,
        generation: crypto.randomUUID(), state: 'idle', controller: new AbortController(), failures: 0, topologyDirty: true };
      connections.set(id, connection);
    }
    if (!connection.ready) {
      setState(connection, 'connecting');
      connection.ready = (async () => {
        if (connection.host.source === 'ssh' && adapter.prepareHost) {
          connection.preparing = true;
          const prepared = await adapter.prepareHost(id);
          const latest = await resolveHost(id);
          if (!current(connection) || fingerprint(prepared) !== fingerprint(latest)) throw remoteFailure('stale_host', 409);
          connection.host = prepared;
          connection.fingerprint = fingerprint(prepared);
          connection.scopeGeneration = scopes.get(id)?.generation;
          store.saveHost(prepared);
          connection.preparing = false;
        }
        const transport = await transportFactory(connection.host, { signal: connection.controller.signal });
        if (!current(connection)) { transport.close(); throw remoteFailure('stale_host', 409); }
        connection.transport = transport;
        let capability = transport.capabilities;
        if (!capability) {
          const response = await transport.fetch('/api/hosts/capabilities', {
            signal: remoteDeadlineSignal(requestTimeoutMs, [connection.controller.signal]),
          });
          if (response.status === 401 || response.status === 403) throw remoteFailure('remote_authorization_required', response.status);
          capability = response.ok ? await response.json().catch(() => null) : null;
        }
        if (!capability?.remoteProjects || capability.protocol !== 1 || !capability?.instanceId
          || capability.opencode?.compatible === false) throw remoteFailure('remote_incompatible', 409);
        if (capability.opencode?.ready === false && !capability.opencode?.version) throw remoteFailure('remote_service_starting');
        connection.version = capability.version;
        connection.instanceId = capability.instanceId;
        await resolveHost(id);
        if (!current(connection)) throw remoteFailure('stale_host', 409);
        return connection;
      })().catch((error) => {
        connection.preparing = false;
        connection.ready = null;
        connection.transport?.close();
        connection.transport = null;
        setState(connection, error?.status === 401 || error?.status === 403 ? 'unauthorized'
          : error?.code === 'remote_incompatible' ? 'incompatible' : 'offline', error);
        throw error;
      });
    }
    return connection.ready;
  };
  const request = async (id, route, init = {}, { refresh = false, streaming = false, longRunning = false } = {}) => {
    init.signal?.throwIfAborted();
    if (!refresh && (/^\/api\/session(?:\/|\?)/.test(route) || (init.method && !['GET', 'HEAD'].includes(init.method)))) {
      for (const connection of connections.values()) {
        if (connection.refreshController) { connection.refreshPreempted = true; connection.refreshController.abort(); }
      }
    }
    const connection = await ensure(id);
    const generation = connection.fingerprint;
    const deadlineMs = longRunning ? operationTimeoutMs : requestTimeoutMs;
    const headerDeadline = new AbortController();
    const headerTimer = setTimeout(() => headerDeadline.abort(), deadlineMs);
    let response;
    try {
      response = await connection.transport.fetch(route, { ...init,
        signal: streaming ? AbortSignal.any([connection.controller.signal, headerDeadline.signal,
          ...(init.signal ? [init.signal] : [])]) : remoteDeadlineSignal(deadlineMs,
          [connection.controller.signal, headerDeadline.signal, ...(init.signal ? [init.signal] : [])]) });
    } finally {
      clearTimeout(headerTimer);
    }
    const latest = await resolveHost(id);
    if (!current(connection) || fingerprint(latest) !== generation) {
      await response.body?.cancel(); throw remoteFailure('stale_host', 409);
    }
    if (response.status === 401 || response.status === 403) {
      setState(connection, 'unauthorized', remoteFailure('remote_authorization_required', response.status));
      connection.reader?.stop();
      connection.reader = null;
      connection.transport?.close();
      connection.ready = null;
      for (const [leaseId, lease] of leases) if (lease.hostId === id) {
        releaseLease(leaseId);
      }
    }
    return response;
  };
  const json = async (id, route, init, options) => {
    init?.signal?.throwIfAborted();
    const connection = await ensure(id);
    const consumption = new AbortController();
    try {
      const response = await request(id, route, { ...init,
        signal: init?.signal ? AbortSignal.any([init.signal, consumption.signal]) : consumption.signal }, options);
      if (!response.ok) { await response.body?.cancel(); throw remoteFailure('remote_request_failed', response.status); }
      const value = await response.json();
      await resolveHost(id);
      if (!current(connection)) throw remoteFailure('stale_host', 409);
      return value;
    } finally {
      consumption.abort();
    }
  };
  const refreshWorktrees = async (connection, references, signal) => {
    const previous = store.organization(connection.host.id).worktrees || {};
    const projectDirectories = { ...previous.projectDirectories };
    const stale = new Set(previous.staleProjectDirectories || []);
    const refreshAll = connection.topologyDirty;
    let changed = refreshAll;
    connection.topologyDirty = false;
    for (const project of references) {
      if (!refreshAll && Object.hasOwn(projectDirectories, project.path) && !stale.has(project.path)) continue;
      changed = true;
      try {
        const rows = await json(connection.host.id, `/api/git/worktrees?directory=${encodeURIComponent(project.path)}`, { signal }, { refresh: true });
        if (!Array.isArray(rows) || rows.some((row) => typeof row?.path !== 'string')) throw remoteFailure('remote_invalid_snapshot');
        const projectKey = directoryKey(project.path);
        const checkout = rows.map((row) => directoryKey(row.path))
          .filter((root) => projectKey === root || projectKey.startsWith(root === '/' ? '/' : `${root}/`))
          .sort((a, b) => b.length - a.length)[0];
        const suffix = checkout && projectKey !== checkout
          ? projectKey.slice(checkout === '/' ? 1 : checkout.length + 1) : '';
        projectDirectories[project.path] = checkout ? rows.map((row) => suffix
          ? `${row.path.replace(/[\\/]+$/, '')}${row.path.includes('\\') ? '\\' : '/'}${suffix.replace(/\//g, row.path.includes('\\') ? '\\' : '/')}`
          : row.path) : [];
        stale.delete(project.path);
      } catch {
        if (signal.aborted || !current(connection)) { connection.topologyDirty = true; return; }
        stale.add(project.path);
      }
    }
    if (signal.aborted || !current(connection)) return;
    const roots = new Set(references.map((project) => project.path));
    store.saveOrganization(connection.host.id, 'worktrees', {
      projectDirectories: Object.fromEntries(Object.entries(projectDirectories).filter(([root]) => roots.has(root))),
      staleProjectDirectories: [...stale].filter((root) => roots.has(root)),
    });
    return changed;
  };
  const refresh = async (connection) => {
    if (!current(connection)) return;
    const controller = new AbortController();
    connection.refreshController = controller;
    try {
      let snapshot = await json(connection.host.id, '/api/yuri/session-index', { signal: controller.signal }, { refresh: true });
      if (!current(connection) || controller.signal.aborted) return;
      if (!Array.isArray(snapshot.directories)) throw remoteFailure('remote_invalid_snapshot');
      const references = store.projects(connection.host.id);
      const topologyChanged = await refreshWorktrees(connection, references, controller.signal);
      if (!current(connection) || controller.signal.aborted) return;
      if (topologyChanged) {
        const worktrees = store.organization(connection.host.id).worktrees?.projectDirectories || {};
        const directories = [...new Set(references.flatMap((project) => [project.path, ...(worktrees[project.path] || [])]))];
        let queued;
        try {
          queued = await json(connection.host.id, '/api/yuri/session-index/sync', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ directories }), signal: controller.signal,
          }, { refresh: true });
        } catch (error) { connection.topologyDirty = true; throw error; }
        if (Array.isArray(queued.directories)) snapshot = queued;
        if (!current(connection) || controller.signal.aborted) return;
      }
      const service = indexFor(connection.host.id);
      const ownerFor = directoryResolver(connection.host.id);
      for (const directory of snapshot.directories) if (ownerFor(directory.directory)) {
        service.replaceDirectory(directory);
        for (const session of directory.sessions || []) {
          const status = session.metadata?.yuri?.sessionStatus;
          if (status?.type) service.updateStatus(session.id, status.type, status.changedAt || Date.now());
        }
      }
      const previousPins = service.snapshot().pinnedSessionIds;
      const pins = new Set(snapshot.pinnedSessionIds || []);
      for (const pin of previousPins) if (!pins.has(pin)) service.clearPinned(pin);
      for (const pin of pins) service.setPinned(pin);
      const remote = await json(connection.host.id, '/api/projects', { signal: controller.signal }, { refresh: true });
      if (!Array.isArray(remote.projects) || !current(connection) || controller.signal.aborted) return;
      for (const reference of references) {
        const project = remote.projects.find((p) => p.path === reference.path && !p.hostId);
        if (project) store.refreshProject(reference, project);
        else store.markProject(reference.id, 'remote-removed');
      }
      for (const [kind, route] of [['unread', '/api/yuri/session-unread'], ['folders', '/api/session-folders'], ['order', '/api/session-folders/order']]) {
        const organization = await json(connection.host.id, route, { signal: controller.signal }, { refresh: true });
        if (!current(connection) || controller.signal.aborted) return;
        store.saveOrganization(connection.host.id, kind, organization);
      }
      store.saveReceipt(connection.host.id, { lastSyncedAt: Date.now(), lastError: undefined });
      connection.snapshotReady = !snapshot.sync?.active || snapshot.directories.length > 0;
      emit(connection.host.id, { type: 'yuri:session-index-changed', properties: { cause: 'change' } });
    } catch (error) {
      if (!controller.signal.aborted) setState(connection, 'degraded', error);
    } finally {
      if (connection.refreshController === controller) connection.refreshController = null;
      if (connection.refreshPreempted && current(connection) && statusObservers.size) {
        connection.refreshPreempted = false; refreshQueue.add(connection.host.id);
      }
    }
  };
  const pump = () => {
    if (stopped) return;
    const prioritizedHosts = new Set(priorityRequests.values());
    for (const id of [...refreshQueue]) {
      if (refreshActive >= 2) break;
      const connection = connections.get(id);
      if (!connection) { refreshQueue.delete(id); continue; }
      if (connection.refreshing || prioritizedHosts.has(id)) continue;
      refreshQueue.delete(id);
      refreshActive++;
      connection.refreshing = true;
      void refresh(connection).finally(() => {
        refreshActive--; connection.refreshing = false; pump();
      });
    }
  };
  const enqueueRefresh = (connection) => { refreshQueue.add(connection.host.id); pump(); };
  const startStatus = (connection) => {
    if (connection.reader || !statusObservers.size || !store.projects(connection.host.id).length) return;
    const id = connection.host.id;
    connection.reader = createUpstreamSseReader({
      buildUrl: () => 'http://remote.invalid/api/hosts/status-stream',
      fetchImpl: async (_url, init) => {
        try {
          const connected = await ensure(id);
          return connected.transport.fetch('/api/hosts/status-stream', { ...init,
            signal: AbortSignal.any([init.signal, connection.controller.signal]) });
        } catch (error) {
          connection.failures++; throw error;
        }
      },
      signal: connection.controller.signal,
      reconnectDelayMs: () => Math.min(30000, 500 * 2 ** Math.min(connection.failures, 6)) * (0.8 + Math.random() * 0.4),
      stallTimeoutMs: 1500,
      onConnect: () => {
        if (!current(connection)) return;
        connection.failures = 0;
        connection.topologyDirty = true;
        connection.snapshotReady = false;
        store.saveReceipt(id, { lastConnectedAt: Date.now(), lastError: undefined });
        setState(connection, 'connected'); enqueueRefresh(connection);
      },
      onEvent: (event) => {
        if (!current(connection) || !statusEvent(event.payload)) return;
        const data = event.payload.data || event.payload.properties || {};
        const sessionId = data.sessionID || data.sessionId || data.info?.id || data.id;
        const directory = event.directory && event.directory !== 'global' ? event.directory
          : data.location?.directory || data.directory || data.info?.directory
            || (sessionId ? indexFor(id).findBySessionId(sessionId)?.directory : null);
        if (sessionId && (!directory || !directoryResolver(id)(directory))) return;
        if (applySessionIndexEvent(indexFor(id), event, Date.now())) {
          store.saveReceipt(id, { lastSyncedAt: Date.now() });
        }
        let payload = event.payload;
        if (payload.type === 'yuri:notification') {
          const notification = { ...payload.properties, instanceId: payload.properties?.instanceId || connection.instanceId,
            hostId: id, hubId: store.hubId, directory: directory || payload.properties?.directory };
          onNotification?.(notification);
          payload = { ...payload, properties: { ...notification, desktopNotificationDelivered: Boolean(onNotification) } };
        }
        emit(id, payload, directory || event.directory);
        if (event.payload.type === 'yuri:worktree-topology-changed' || /^yuri:project/.test(event.payload.type)) connection.topologyDirty = true;
        if (/^yuri:session-(index|unread|order|folders|metadata)/.test(event.payload.type)
          || /^yuri:project/.test(event.payload.type) || event.payload.type === 'yuri:worktree-topology-changed') enqueueRefresh(connection);
      },
      onDisconnect: ({ reason }) => {
        if (reason !== 'stopped') {
          connection.failures++;
          connection.snapshotReady = false;
          if (!['unauthorized', 'incompatible'].includes(connection.state)) setState(connection, 'offline');
        }
      },
      onError: ({ status }) => {
        connection.failures++;
        setState(connection, status === 401 || status === 403 ? 'unauthorized' : 'offline');
        if (status === 401 || status === 403) {
          connection.transport?.close(); connection.ready = null;
          for (const [leaseId, lease] of leases) if (lease.hostId === id) releaseLease(leaseId);
        }
      },
    });
    void connection.reader.start();
  };
  const reconcile = () => {
    if (reconcilePromise) { reconcilePending = true; return reconcilePromise; }
    reconcilePromise = (async () => {
      const hosts = await descriptors();
      if (stopped) return;
      const needed = new Set(statusObservers.size ? store.projects().map((p) => p.hostId) : []);
      for (const project of store.projects()) if (!hosts.some((host) => host.id === project.hostId)) store.markProject(project.id, 'host-unavailable');
      for (const connection of connections.values()) {
        const host = hosts.find((h) => h.id === connection.host.id);
        if (!host) {
          setState(connection, 'offline', remoteFailure('host_unavailable', 404));
          emit(connection.host.id, { type: 'yuri:projects-changed', properties: {} });
        }
        if (!observers.size || (!needed.has(connection.host.id) && !interactiveHosts.has(connection.host.id))
          || !host || (!connection.preparing && (fingerprint(host) !== connection.fingerprint
            || scopes.get(connection.host.id)?.generation !== connection.scopeGeneration))) closeConnection(connection);
      }
      if (!observers.size || stopped) return;
      await Promise.allSettled([...needed].map(async (id) => {
        try { const connection = await ensure(id); startStatus(connection); }
        catch {
          // A failed first connection still needs the bounded SSE retry owner.
          const connection = connections.get(id);
          if (connection) startStatus(connection);
        }
      }));
    })().catch((error) => {
      for (const connection of connections.values()) setState(connection, 'degraded', error);
    }).finally(() => {
      reconcilePromise = null;
      if (reconcilePending && !stopped) { reconcilePending = false; void reconcile(); }
    });
    return reconcilePromise;
  };
  const releaseLease = (id) => {
    const lease = leases.get(id);
    if (!lease) return;
    leases.delete(id);
    lease.channel.users.delete(id);
    if (!lease.channel.users.size) {
      lease.channel.reader.stop(); contentChannels.delete(lease.channel.key);
    }
  };
  const releaseOwner = (owner) => {
    ownerGenerations.set(owner, (ownerGenerations.get(owner) || 0) + 1);
    for (const [id, lease] of leases) if (lease.owner === owner) releaseLease(id);
  };
  const observe = (resource, owner, { status = true } = {}) => {
    if (observers.has(resource)) return () => {};
    if (status) statusObservers.add(resource);
    observers.set(resource, owner); void reconcile();
    return () => {
      observers.delete(resource);
      statusObservers.delete(resource);
      if (![...statusObservers].some((entry) => observers.get(entry) === owner)) releaseOwner(owner);
      if (!statusObservers.size) {
        refreshQueue.clear();
        for (const connection of connections.values()) {
          connection.reader?.stop(); connection.reader = null;
          connection.refreshController?.abort();
        }
      }
      if (!observers.size) {
        refreshQueue.clear();
        for (const connection of [...connections.values()]) closeConnection(connection);
      }
    };
  };
  const unsubscribeAdapter = adapter?.subscribe?.(() => {
    if (stopped || (!scopes.size && !store.projects().length && !connections.size)) return;
    // Observe each saved-catalog change, even while no transport is retained, so
    // removing and re-adding an identical Host cannot resurrect an old scope.
    void descriptors().then(() => {
      if (!stopped && (store.projects().length || connections.size)) void reconcile();
    }).catch(() => {
      if (!stopped && (store.projects().length || connections.size)) void reconcile();
    });
  }) || (() => {});
  return {
    store, request, json, reconcile, observe, ensure, releaseOwner, assertProjectDirectory, supported: Boolean(adapter),
    projectReferencesChanged(id) {
      const connection = connections.get(id);
      if (connection && statusObservers.size) { connection.topologyDirty = true; enqueueRefresh(connection); }
      void reconcile();
    },
    retainHost(hostId, resource, priority = false) {
      let consumers = interactiveHosts.get(hostId);
      if (!consumers) { consumers = new Set(); interactiveHosts.set(hostId, consumers); }
      consumers.add(resource);
      if (priority) priorityRequests.set(resource, hostId);
      return () => {
        consumers.delete(resource);
        priorityRequests.delete(resource);
        if (!consumers.size) {
          interactiveHosts.delete(hostId);
          if (!stopped && !store.projects(hostId).length) {
            refreshQueue.delete(hostId);
            const connection = connections.get(hostId);
            if (connection) closeConnection(connection);
          }
        }
        pump();
      };
    },
    async list() {
      const hosts = await descriptors();
      for (const host of hosts) store.saveHost(host);
      for (const p of store.projects()) if (!hosts.some((h) => h.id === p.hostId)) store.markProject(p.id, 'host-unavailable');
      const removed = new Set(store.projects().filter((p) => p.remoteState === 'host-unavailable' && !hosts.some((h) => h.id === p.hostId)).map((p) => p.hostId));
      const unavailable = [...removed].map((id) => ({ ...(store.savedHosts().find((host) => host.id === id) || { id, name: id, source: 'direct' }),
        ...store.receipt(id), state: 'offline', available: false }));
      return { supported: Boolean(adapter), hubId: store.hubId, hosts: [...hosts.map(hostView), ...unavailable], projects: store.projects(),
        ...(!adapter ? { reason: 'pc_hub_required' } : {}) };
    },
    async connect(id) { const connection = await ensure(id); startStatus(connection); return hostView(connection.host); },
    summaries(id) {
      const references = new Set(store.projects(id).map((p) => directoryKey(p.path)));
      if (!references.size) throw remoteFailure('project_not_found', 404);
      const stale = stateFor(id) !== 'connected' || !connections.get(id)?.snapshotReady;
      const snapshot = indexFor(id).snapshot();
      const ownerFor = directoryResolver(id);
      return { ...snapshot, ...store.organization(id), hostId: id, hubId: store.hubId, stale, ...store.receipt(id),
        directories: snapshot.directories.filter((d) => ownerFor(d.directory)).map((d) => ({ ...d,
          sessions: stale ? d.sessions.map((s) => ({ ...s, metadata: { ...s.metadata, yuri: { ...s.metadata?.yuri,
            sessionStatus: { type: 'unknown', lastKnown: s.metadata?.yuri?.sessionStatus?.type } } } })) : d.sessions })) };
    },
    async subscribe(id, input, owner) {
      const ownerGeneration = ownerGenerations.get(owner) || 0;
      if (input?.sessionId !== undefined && (typeof input.sessionId !== 'string' || !input.sessionId || input.sessionId.length > 512)) {
        throw remoteFailure('validation_error', 400);
      }
      assertProjectDirectory(id, input?.directory);
      const connection = await ensure(id);
      if ((ownerGenerations.get(owner) || 0) !== ownerGeneration || ![...observers.values()].includes(owner)) {
        throw remoteFailure('remote_authorization_required', 401);
      }
      const leaseId = crypto.randomUUID();
      const key = JSON.stringify([id, input.directory, input.sessionId || '']);
      const shared = contentChannels.get(key);
      if (shared) {
        shared.users.add(leaseId);
        leases.set(leaseId, { hostId: id, directory: input.directory, owner, channel: shared });
        if (shared.readyGeneration) emit(id, { type: 'yuri:content-ready', properties: {
          id: leaseId, sessionId: input.sessionId, channelId: shared.id, readyGeneration: shared.readyGeneration } }, input.directory);
        return { id: leaseId, channelId: shared.id, readyGeneration: shared.readyGeneration };
      }
      if (contentChannels.size >= maxContentSubscriptions) throw remoteFailure('content_capacity', 429);
      const route = `/api/event?directory=${encodeURIComponent(input.directory)}`;
      let channel;
      const reader = createUpstreamSseReader({ buildUrl: () => `http://remote.invalid${route}`,
        signal: connection.controller.signal,
        fetchImpl: (_url, init) => connection.transport.fetch(route, init),
        reconnectDelayMs: () => Math.min(30000, 500 * 2 ** Math.min(channel.failures, 6)) * (0.8 + Math.random() * 0.4),
        onConnect: () => {
          if (!current(connection) || contentChannels.get(key) !== channel) return;
          channel.failures = 0;
          channel.readyGeneration = crypto.randomUUID();
          for (const activeLease of channel.users) emit(id, { type: 'yuri:content-ready', properties: {
            id: activeLease, sessionId: input.sessionId, channelId: channel.id, readyGeneration: channel.readyGeneration } }, input.directory);
        },
        onDisconnect: ({ reason }) => { if (reason !== 'stopped') channel.failures++; },
        onError: ({ status }) => {
          channel.failures++;
          if (status === 401 || status === 403) {
            channel.failures = Math.max(channel.failures, 6);
            setState(connection, 'unauthorized', remoteFailure('remote_authorization_required', status));
            connection.transport?.close(); connection.ready = null;
            for (const [leaseId, lease] of leases) if (lease.hostId === id) releaseLease(leaseId);
          }
        },
        onEvent: (event) => {
          if (!current(connection)) return;
          const data = event.payload?.properties || event.payload?.data;
          const session = data?.sessionID || data?.info?.sessionID || data?.part?.sessionID;
          if (input.sessionId && session && session !== input.sessionId) return;
          if (!statusEvent(event.payload)) emit(id, event.payload, event.directory || input.directory);
        } });
      channel = { id: crypto.randomUUID(), key, reader, users: new Set([leaseId]), readyGeneration: null, failures: 0 };
      contentChannels.set(key, channel);
      leases.set(leaseId, { hostId: id, directory: input.directory, owner, channel });
      void reader.start();
      return { id: leaseId, channelId: channel.id };
    },
    release(id, leaseId, owner) {
      const lease = leases.get(leaseId);
      if (!lease || lease.hostId !== id || lease.owner !== owner) throw remoteFailure('subscription_not_found', 404);
      releaseLease(leaseId);
    },
    async openWebSocket(id, route, protocols, options) {
      const connection = await ensure(id);
      const socket = await connection.transport.openWebSocket(route, protocols, options);
      await resolveHost(id);
      if (!current(connection)) { socket.close(); throw remoteFailure('stale_host', 409); }
      return socket;
    },
    stop() {
      unsubscribeAdapter();
      stopped = true; refreshQueue.clear(); observers.clear(); statusObservers.clear();
      for (const connection of [...connections.values()]) closeConnection(connection);
      for (const service of indexes.values()) service.close();
      scopes.clear();
      store.close();
    },
  };
}
