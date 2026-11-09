import type { Connection } from './model';
import type { DesktopRemoteConnectionsState, DesktopSshInstance, DesktopSshSnapshot } from './desktop-remote-connections-core';
import type { DesktopHeaderInstance, DesktopHeaderInstancesPort, DesktopHeaderServiceIntent, DesktopHeaderServiceResult } from './desktop-header-services';

export type DesktopHeaderConnectionTarget = Readonly<Pick<Connection, 'id' | 'url' | 'authorizationID'>>;
export type DesktopHeaderCommittedConnections = Readonly<{ connections: readonly Connection[]; connection: Connection | null; online: boolean }>;
export type DesktopHeaderRemoteProjection = Readonly<{
  owner: object | null; state: DesktopHeaderRemoteState | null; available: boolean; connectAvailable: boolean;
}>;
export type DesktopHeaderRemoteState = Readonly<{
  snapshot: Readonly<Pick<DesktopSshSnapshot, 'revision' | 'saving' | 'instances' | 'statuses'>> | null;
  ready: boolean; busy: boolean; failed: boolean; unknown: boolean; syncUnknown: boolean;
}>;
/** Closed O(1) projection: no controller methods, request receipts or sync document/history metadata. */
export function desktopHeaderRemoteState(value: DesktopRemoteConnectionsState): DesktopHeaderRemoteState {
  const snapshot = value.snapshot;
  return { snapshot: snapshot ? { revision: snapshot.revision, saving: snapshot.saving, instances: snapshot.instances, statuses: snapshot.statuses } : null,
    ready: value.ready, busy: value.busy, failed: value.failed, unknown: !!value.unknown, syncUnknown: value.sync?.phase === 'unknown' };
}
/** Only the existing window SSH root may implement this. Neither read nor subscribe performs discovery/IO. */
export type DesktopHeaderRemoteConnectionsSource = {
  projection(): DesktopHeaderRemoteProjection;
  subscribe(listener: () => void): () => void;
  connect(target: Readonly<DesktopSshInstance>, intent: DesktopHeaderServiceIntent): Promise<DesktopHeaderServiceResult>;
};
export type DesktopHeaderInstancesRootOptions = {
  current(): boolean;
  committed: {
    read(): DesktopHeaderCommittedConnections | null;
    subscribe(listener: () => void): () => void;
  };
  remote?: DesktopHeaderRemoteConnectionsSource;
  /** Main owns pageDeparture/files guards and final exact-target revalidation. Never call a bare switch here. */
  switch?: {
    available(): boolean;
    run(target: DesktopHeaderConnectionTarget, intent: DesktopHeaderServiceIntent & { from: DesktopHeaderConnectionTarget | null }): Promise<DesktopHeaderServiceResult>;
  };
  add?: { available(): boolean; run(intent: DesktopHeaderServiceIntent & { from: DesktopHeaderConnectionTarget | null }): Promise<DesktopHeaderServiceResult> };
};
type Target = { kind: 'connection'; connection: DesktopHeaderConnectionTarget } | { kind: 'ssh'; instance: Readonly<DesktopSshInstance>; connect: boolean };
type Cache = { committed: DesktopHeaderCommittedConnections; remote: DesktopHeaderRemoteProjection; rows: readonly DesktopHeaderInstance[]; targets: ReadonlyMap<string, Target> };
const identity = (row: Connection | DesktopHeaderConnectionTarget | null): DesktopHeaderConnectionTarget | null => row ? Object.freeze({ id: row.id, url: row.url, ...(row.authorizationID !== undefined ? { authorizationID: row.authorizationID } : {}) }) : null;
const same = (a: DesktopHeaderConnectionTarget | null, b: DesktopHeaderConnectionTarget | null) => a === b || !!a && !!b && a.id === b.id && a.url === b.url && a.authorizationID === b.authorizationID;
export const desktopHeaderSameSshTarget = (a: Readonly<DesktopSshInstance>, b: Readonly<DesktopSshInstance>) => a.id === b.id && a.label === b.label && a.host === b.host && a.user === b.user && a.port === b.port && a.remotePort === b.remotePort && a.localPort === b.localPort && a.managed === b.managed;
const missingRemote: DesktopHeaderRemoteProjection = { owner: null, state: null, available: false, connectAvailable: false };
const usableRemote = (remote: DesktopHeaderRemoteProjection) => !!remote.owner && !!remote.state?.snapshot && remote.available && !remote.state.failed;
function receipt(value: unknown): DesktopHeaderServiceResult {
  if (value && typeof value === 'object' && 'status' in value && ['accepted', 'failed', 'stale', 'unsupported', 'unknown'].includes(String(value.status))) return { status: value.status as DesktopHeaderServiceResult['status'] };
  return { status: 'unknown' };
}

/** Pure adapter over committed metadata and the UNIQUE SSH root. No Host/GET/catalog/engine/updater. */
export function createDesktopHeaderInstancesRootController(options: DesktopHeaderInstancesRootOptions) {
  let alive = true, retired = false, fresh = false, cache: Cache | undefined, lease: DesktopHeaderServiceIntent | undefined;
  const subscriptions = new Set<() => void>();
  const current = () => { if (!alive || retired) return false; if (!options.current()) retired = true; return !retired; };
  const demanded = () => current() && fresh && lease?.current() === true;
  function remoteProjection() { return options.remote?.projection() || missingRemote; }
  function project(committed: DesktopHeaderCommittedConnections, remote: DesktopHeaderRemoteProjection): Cache {
    const previous = cache;
    if (previous && previous.committed.connections === committed.connections && previous.committed.connection === committed.connection && previous.committed.online === committed.online && previous.remote.owner === remote.owner && previous.remote.state === remote.state && previous.remote.available === remote.available && previous.remote.connectAvailable === remote.connectAvailable) return previous;
    const ids = new Set<string>();
    for (const row of committed.connections) {
      if (typeof row.id !== 'string' || !row.id || ids.has(row.id) || typeof row.label !== 'string' || typeof row.url !== 'string') throw new Error('instances_invalid_committed');
      ids.add(row.id);
    }
    if (committed.connection && !committed.connections.some(row => same(row, committed.connection))) throw new Error('instances_uncommitted_selection');
    const snapshot = remote.state?.snapshot;
    const instances = remote.owner ? snapshot?.instances || [] : [];
    const statuses = new Map(remote.owner ? snapshot?.statuses.map(row => [row.id, row]) : []);
    // Only native-acknowledged ready connection IDs establish an association.
    // Duplicate claims are ambiguous, NOT first-match wins; URLs are never inspected.
    const bindings = new Map<string, DesktopSshInstance[]>();
    for (const instance of instances) {
      const status = statuses.get(instance.id);
      if (status?.phase !== 'ready' || !status.connectionID || !ids.has(status.connectionID)) continue;
      const bound = bindings.get(status.connectionID) || []; bindings.set(status.connectionID, [...bound, instance]);
    }
    const targets = new Map<string, Target>(), matched = new Set<string>();
    const rows: DesktopHeaderInstance[] = committed.connections.map(connection => {
      const bound = bindings.get(connection.id), instance = bound?.length === 1 ? bound[0] : undefined;
      if (instance) matched.add(instance.id);
      const id = `connection:${connection.id}`, active = same(connection, committed.connection);
      targets.set(id, { kind: 'connection', connection: identity(connection)! });
      return { id, label: connection.label, transport: instance ? 'ssh' : 'unknown', isDefault: false, display: {
        isActive: active, isSsh: !!instance, runtimeIsConnected: active && committed.online,
        runtimeConnectionPhase: committed.online ? 'connected' : 'checking', currentTransportIsRelay: false,
        probe: null, sshPhase: instance && usableRemote(remote) ? statuses.get(instance.id)?.phase : undefined,
      } };
    });
    for (const instance of instances) {
      if (matched.has(instance.id)) continue;
      const status = statuses.get(instance.id), id = `ssh:${instance.id}`;
      const connect = usableRemote(remote) && remote.connectAvailable && !remote.state?.busy && !remote.state?.unknown && !remote.state?.syncUnknown && !snapshot?.saving && (!status || status.phase === 'idle') && !status?.running;
      targets.set(id, { kind: 'ssh', instance: Object.freeze({ ...instance }), connect });
      rows.push({ id, label: instance.label, transport: 'ssh', isDefault: false, display: {
        isActive: false, isSsh: true, runtimeIsConnected: false, runtimeConnectionPhase: 'unknown', currentTransportIsRelay: false,
        probe: null, sshPhase: usableRemote(remote) ? status?.phase : undefined,
      } });
    }
    return { committed, remote, rows, targets };
  }
  const port: DesktopHeaderInstancesPort = {
    async read(intent) {
      if (!current() || !intent.current()) throw new Error('instances_stale');
      lease = intent;
      try {
        const committed = options.committed.read();
        if (!committed) throw new Error('instances_unavailable');
        const value = project(committed, remoteProjection());
        if (!current() || !intent.current()) throw new Error('instances_stale');
        cache = value; fresh = true; return value.rows;
      } catch (error) { fresh = false; throw error; }
    },
    subscribe(intent, listener) {
      if (!current() || !intent.current()) return () => {};
      let live = true;
      const notify = () => { if (!live || !current() || !intent.current()) return; fresh = false; listener(); };
      const stopCommitted = options.committed.subscribe(notify), stopRemote = options.remote?.subscribe(notify);
      const stop = () => { if (!live) return; live = false; stopCommitted(); stopRemote?.(); subscriptions.delete(stop); };
      subscriptions.add(stop); return stop;
    },
    available(action, id) {
      if (!demanded()) return false;
      if (action === 'default' || action === 'new-window') return false;
      if (action === 'add') return options.add?.available() === true;
      const target = id ? cache?.targets.get(id) : undefined;
      if (!target) return false;
      if (action === 'switch') return target.kind === 'connection' && options.switch?.available() === true;
      if (target.kind !== 'ssh' || !target.connect || !options.remote) return false;
      const latest = remoteProjection();
      return latest.owner === cache?.remote.owner && latest.state === cache?.remote.state && usableRemote(latest) && latest.connectAvailable;
    },
    async run(action, id, intent) {
      if (!intent.current() || !port.available(action, id)) return { status: 'unsupported' };
      const captured = cache!, target = id ? captured.targets.get(id) : undefined;
      const from = identity(captured.committed.connection);
      const exact = () => {
        if (!current() || !intent.current() || lease?.current() !== true) return false;
        try {
          const live = options.committed.read();
          if (!live || !same(from, live.connection)) return false;
          if (target?.kind === 'connection') return live.connections.some(row => same(row, target.connection));
          if (target?.kind === 'ssh') {
            const remote = remoteProjection(), instance = remote.state?.snapshot?.instances.find(row => row.id === target.instance.id);
            return remote.owner === captured.remote.owner && usableRemote(remote) && !!instance && desktopHeaderSameSshTarget(instance, target.instance);
          }
          return action === 'add';
        } catch { return false; }
      };
      if (!exact()) return { status: 'stale' };
      const guarded = { current: exact, from };
      try {
        if (action === 'switch' && target?.kind === 'connection') return receipt(await options.switch!.run(target.connection, guarded));
        if (action === 'add') return receipt(await options.add!.run(guarded));
        if (action === 'connect' && target?.kind === 'ssh') return receipt(await options.remote!.connect(target.instance, guarded));
        return { status: 'unsupported' };
      } catch { return { status: exact() ? 'unknown' : 'stale' }; }
    },
  };
  return Object.assign(port, {
    /** Publisher retains prior rows after read failure, but cannot use them for actions. */
    snapshot: () => cache?.rows ?? null,
    dispose() { if (!alive) return; alive = false; retired = true; fresh = false; for (const stop of [...subscriptions]) stop(); },
  });
}
export type DesktopHeaderInstancesRoot = ReturnType<typeof createDesktopHeaderInstancesRootController>;
