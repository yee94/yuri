import { resolveHostRowDisplay, type ResolveHostRowDisplayArgs } from '../ui/src/components/desktop/desktopHostSwitcherDisplay';
import type { McpStatus } from '../ui/src/lib/opencode/v2-types';
import type { PageOperation } from './page-operations';
import type { AboutState } from './settings-about-core';
import { aboutUpdateActive, aboutVersion } from './settings-about-core';
import { createSettingsLaneOwner, createSettingsTransaction, scopedSettingsPath, settingsObject, settingsRows } from './settings-protocol';

export type DesktopHeaderServicesTab = 'instance' | 'usage' | 'mcp';
export type DesktopHeaderServiceResult = { status: 'accepted' | 'failed' | 'stale' | 'unsupported' | 'unknown' };
export type DesktopHeaderServiceIntent = { current(): boolean };
export type DesktopHeaderServiceOperation = Pick<PageOperation, 'current' | 'request'>;
export type DesktopHeaderServiceResource<T> = { value: T | null; loading: boolean; stale: boolean; failed: boolean };
export type DesktopHeaderInstance = {
  id: string; label: string; transport: 'local' | 'lan' | 'ssh' | 'relay' | 'unknown'; isDefault: boolean;
  display: ResolveHostRowDisplayArgs;
};
export type DesktopHeaderInstanceAction = 'switch' | 'connect' | 'default' | 'new-window' | 'add';
export type DesktopHeaderInstancesPort = {
  /** Project the EXISTING committed connection/SSH owners; never create another engine. */
  read(intent: DesktopHeaderServiceIntent): Promise<readonly DesktopHeaderInstance[]>;
  /** Optional existing-owner invalidation only; services subscribes solely while Instance is visible. */
  subscribe?(intent: DesktopHeaderServiceIntent, changed: () => void): () => void;
  available(action: DesktopHeaderInstanceAction, id?: string): boolean;
  run(action: DesktopHeaderInstanceAction, id: string | undefined, intent: DesktopHeaderServiceIntent): Promise<DesktopHeaderServiceResult>;
};
export type DesktopHeaderUpdateProjection = Pick<AboutState, 'hostUpdate' | 'updateBusy' | 'updateFailed' | 'updateUncertain' | 'updateConfirm'> & {
  /** Optional existing committed serving-Host version, never client/OpenCode version. */
  version?: string | null;
};
export type DesktopHeaderUpdatePort = {
  /** Calls only existing About.hostUpdate(), NOT About.refresh(). */
  read(intent: DesktopHeaderServiceIntent): Promise<DesktopHeaderUpdateProjection>;
  /** A real native admission gate, not HTTP route existence or manifest grants. */
  nativeGate(): boolean;
  available(): boolean;
  /** Existing owner owns prepare/confirmation/unknown-write recovery and any modal. */
  run(intent: DesktopHeaderServiceIntent): Promise<DesktopHeaderServiceResult>;
};
export type DesktopHeaderMcpRow = { name: string; status?: McpStatus; integrationID?: string };
export type DesktopHeaderServicesSnapshot = {
  tab: DesktopHeaderServicesTab | null; active: boolean;
  instances: DesktopHeaderServiceResource<readonly DesktopHeaderInstance[]>;
  update: DesktopHeaderServiceResource<DesktopHeaderUpdateProjection>;
  configs: DesktopHeaderServiceResource<readonly string[]>;
  statuses: DesktopHeaderServiceResource<readonly DesktopHeaderMcpRow[]>;
  mcp: readonly DesktopHeaderMcpRow[];
  mutations: Readonly<Record<string, 'pending' | 'unknown' | 'failed'>>;
  instancePending: string | null; instanceResult: DesktopHeaderServiceResult['status'] | null;
};
export type DesktopHeaderServicesOptions = {
  directory?: string;
  current(): boolean;
  operation(): DesktopHeaderServiceOperation | null;
  instances?: DesktopHeaderInstancesPort;
  update?: DesktopHeaderUpdatePort;
  changed(value: DesktopHeaderServicesSnapshot): void;
};

const resource = <T>(): DesktopHeaderServiceResource<T> => ({ value: null, loading: false, stale: true, failed: false });
export const desktopHeaderInstanceDisplay = (row: DesktopHeaderInstance) => resolveHostRowDisplay(row.display);
export const desktopHeaderInstanceVersion = (value: DesktopHeaderUpdateProjection | null) => aboutVersion(value?.hostUpdate.value?.currentVersion) ?? aboutVersion(value?.version);
const blocked = (row: DesktopHeaderInstance) => ['incompatible', 'wrong-service', 'unreachable'].includes(desktopHeaderInstanceDisplay(row).statusKind || '');

/** Strict v2 mcp.list envelope; malformed/partial results are NOT authoritative empty. */
export function desktopHeaderMcpSnapshot(payload: unknown): readonly DesktopHeaderMcpRow[] {
  const body = settingsObject(payload);
  if (body.complete === false || body.incomplete === true) throw new Error('mcp_partial');
  const rows = settingsRows(body.data), seen = new Set<string>();
  return rows.map(row => {
    if (typeof row.name !== 'string' || !row.name || seen.has(row.name)) throw new Error('mcp_invalid');
    seen.add(row.name);
    const status = settingsObject(row.status);
    if (!['connected', 'disabled', 'pending', 'failed', 'needs_auth', 'needs_client_registration'].includes(String(status.status))) throw new Error('mcp_invalid_status');
    if (['failed', 'needs_client_registration'].includes(String(status.status)) && typeof status.error !== 'string') throw new Error('mcp_invalid_error');
    // Closed display projection: no config headers, environment or integration secrets retained.
    return { name: row.name, status: { status: status.status, ...(typeof status.error === 'string' ? { error: status.error } : {}) } as McpStatus,
      ...(typeof row.integrationID === 'string' ? { integrationID: row.integrationID } : {}) };
  });
}

/** Window-retained presenter. No React/NSH imports, timers, global store or default sender. */
export function createDesktopHeaderServices(options: DesktopHeaderServicesOptions) {
  let alive = true, retired = false, generation = 0;
  let lane: DesktopHeaderServiceOperation | null = null;
  let state: DesktopHeaderServicesSnapshot = { tab: null, active: false, instances: resource(), update: resource(), configs: resource(), statuses: resource(), mcp: [], mutations: {}, instancePending: null, instanceResult: null };
  const transport = createSettingsLaneOwner(async () => { throw new Error('services_unavailable'); }, () => false);
  transport.replaceLane(null);
  type Job = { promise: Promise<DesktopHeaderServiceResult>; finish(result: DesktopHeaderServiceResult): void };
  const jobs = new Map<string, Job>();
  const revisions = { instances: 0, update: 0, configs: 0, statuses: 0 };
  let unsubscribeInstances: (() => void) | undefined;
  const authority = () => { if (!alive || retired) return false; if (!options.current()) retired = true; return !retired; };
  function publish(next: DesktopHeaderServicesSnapshot) { state = next; if (authority()) options.changed(next); }
  function demanded(tab: 'instance' | 'mcp') { return authority() && state.active && state.tab === tab; }
  function current(serial: number, captured: DesktopHeaderServiceOperation | null, tab: 'instance' | 'mcp') {
    return demanded(tab) && generation === serial && captured !== null && lane === captured && options.operation() === captured && captured.current();
  }
  function mergeMcp() {
    const statuses = new Map(state.statuses.value?.map(row => [row.name, row]));
    const names = new Set([...(state.configs.value || []), ...statuses.keys()]);
    state = { ...state, mcp: [...names].sort((a, b) => a.localeCompare(b)).map(name => statuses.get(name) || { name }) };
  }
  function revoke() {
    generation++;
    unsubscribeInstances?.(); unsubscribeInstances = undefined;
    transport.replaceLane(null);
    for (const job of jobs.values()) job.finish({ status: 'stale' });
    jobs.clear();
    const stale = <T>(value: DesktopHeaderServiceResource<T>) => value.stale && !value.loading ? value : { ...value, stale: true, loading: false };
    const mutations = Object.fromEntries(Object.entries(state.mutations).map(([name, status]) => [name, status === 'pending' ? 'unknown' as const : status]));
    publish({ ...state, instances: stale(state.instances), update: stale(state.update), configs: stale(state.configs), statuses: stale(state.statuses), mutations,
      instanceResult: state.instancePending ? 'unknown' : state.instanceResult, instancePending: null });
  }
  function reconcile() {
    const candidate = authority() ? options.operation() : null, next = candidate?.current() ? candidate : null;
    if (next !== lane) { lane = next; revoke(); }
    if (lane && state.active && (state.tab === 'mcp' || state.tab === 'instance') && !transport.capture()) transport.replaceLane(lane);
  }
  function work(key: string, tab: 'mcp' | 'instance', run: (intent: DesktopHeaderServiceIntent) => Promise<DesktopHeaderServiceResult>): Promise<DesktopHeaderServiceResult> {
    const captured = lane, serial = generation;
    if (!current(serial, captured, tab)) return Promise.resolve({ status: 'unsupported' });
    const prior = jobs.get(key); if (prior) return prior.promise;
    let finish!: Job['finish'];
    const promise = new Promise<DesktopHeaderServiceResult>(resolve => { finish = resolve; });
    const job = { promise, finish }; jobs.set(key, job);
    const intent = { current: () => current(serial, captured, tab) };
    void (async () => {
      let result: DesktopHeaderServiceResult;
      try { result = await run(intent); } catch { result = { status: 'failed' }; }
      if (!intent.current()) result = { status: 'stale' };
      if (jobs.get(key) === job) jobs.delete(key);
      finish(result);
    })();
    return promise;
  }
  function read<K extends 'instances' | 'update' | 'configs' | 'statuses'>(key: K, tab: 'instance' | 'mcp', load: (intent: DesktopHeaderServiceIntent) => Promise<NonNullable<DesktopHeaderServicesSnapshot[K]['value']>>) {
    return work(`read:${key}`, tab, async intent => {
      const revision = ++revisions[key];
      publish({ ...state, [key]: { ...state[key], loading: true, failed: false } });
      try {
        const value = await load(intent);
        if (!intent.current() || revisions[key] !== revision) return { status: 'stale' };
        const failed = key === 'update' && ((value as DesktopHeaderUpdateProjection).hostUpdate.status !== 'ready' || (value as DesktopHeaderUpdateProjection).hostUpdate.value?.checkFailed === true);
        state = { ...state, [key]: { value, loading: false, stale: failed, failed } };
        if (key === 'configs' || key === 'statuses') mergeMcp();
        publish(state); return { status: failed ? 'failed' : 'accepted' };
      } catch {
        if (!intent.current() || revisions[key] !== revision) return { status: 'stale' };
        publish({ ...state, [key]: { ...state[key], loading: false, failed: true, stale: true } });
        return { status: 'failed' };
      }
    });
  }
  const location = options.directory ? `?location%5Bdirectory%5D=${encodeURIComponent(options.directory)}` : '';
  function readStatuses() {
    const captured = transport.capture();
    return read('statuses', 'mcp', async () => {
      if (!captured) throw new Error('services_unavailable');
      return desktopHeaderMcpSnapshot(await captured.request(`/api/mcp${location}`, 'GET'));
    });
  }
  async function refreshMcp(configs = false): Promise<DesktopHeaderServiceResult> {
    reconcile();
    if (!demanded('mcp') || !lane) return { status: 'unsupported' };
    const captured = transport.capture();
    const status = readStatuses();
    const results = await Promise.all([status, ...(configs ? [read('configs', 'mcp', async () => {
      if (!captured) throw new Error('services_unavailable');
      return settingsRows(await captured.request(scopedSettingsPath('/api/config/mcp', options.directory), 'GET')).map(row => {
        if (typeof row.name !== 'string' || !row.name) throw new Error('mcp_invalid_config'); return row.name;
      });
    })] : [])]);
    return { status: results.some(result => result.status === 'stale') ? 'stale' : results.every(result => result.status === 'accepted') ? 'accepted' : 'failed' };
  }
  async function refreshInstance(): Promise<DesktopHeaderServiceResult> {
    reconcile();
    if (!demanded('instance') || !lane) return { status: 'unsupported' };
    const results = await Promise.all([
      ...(options.instances ? [read('instances', 'instance', intent => options.instances!.read(intent))] : []),
      ...(options.update ? [read('update', 'instance', intent => options.update!.read(intent))] : []),
    ]);
    return { status: !results.length ? 'unsupported' : results.some(result => result.status === 'stale') ? 'stale' : results.every(result => result.status === 'accepted') ? 'accepted' : 'failed' };
  }
  function instanceAvailable(action: DesktopHeaderInstanceAction, id?: string) {
    if (!current(generation, lane, 'instance') || state.instancePending || !options.instances?.available(action, id)) return false;
    if (action === 'add') return true;
    const row = state.instances.value?.find(row => row.id === id);
    if (!row || state.instances.stale) return false;
    if ((action === 'default' && !row.isDefault || action === 'new-window') && blocked(row)) return false;
    return action !== 'connect' || row.transport === 'ssh' && (!row.display.sshPhase || row.display.sshPhase === 'idle');
  }
  function updateAvailable() {
    const value = state.update.value;
    return current(generation, lane, 'instance') && !state.instancePending && !jobs.has('update-action') && !state.update.stale && !state.update.failed && !!options.update?.nativeGate() && options.update.available()
      && !!value && !value.updateBusy && !value.updateUncertain && !value.hostUpdate.refreshing && value.hostUpdate.status === 'ready'
      && !!value.hostUpdate.value?.supported && !!value.hostUpdate.value.plan && !value.hostUpdate.value.checkFailed && !aboutUpdateActive(value.hostUpdate.value);
  }
  return {
    snapshot: () => state,
    /** Only header tab/open notification and root lifecycle drive demand. Never call from draft effects. */
    update(value: { tab: DesktopHeaderServicesTab | null; active: boolean }) {
      if (!alive) return;
      const changed = value.tab !== state.tab || value.active !== state.active, previousLane = lane;
      if (changed) { state = { ...state, ...value }; revoke(); }
      reconcile();
      if (!unsubscribeInstances && options.instances?.subscribe && current(generation, lane, 'instance')) {
        const serial = generation, captured = lane;
        const intent = { current: () => current(serial, captured, 'instance') };
        unsubscribeInstances = options.instances.subscribe(intent, () => {
          if (!intent.current()) return;
          // Source notifications supersede older retained projections, not MCP
          // or updater reads. An in-flight snapshot must not swallow a push.
          revisions.instances++;
          const prior = jobs.get('read:instances');
          if (prior) { prior.finish({ status: 'stale' }); jobs.delete('read:instances'); }
          void read('instances', 'instance', next => options.instances!.read(next));
        });
      }
      if (!changed && previousLane === lane) return;
      if (demanded('mcp')) void refreshMcp(true);
      if (demanded('instance')) void refreshInstance();
    },
    refreshMcp, refreshInstance, instanceAvailable, updateAvailable,
    /** Push only existing-owner projections; exact captured lane, no fetch or enumeration. */
    projectInstances(value: readonly DesktopHeaderInstance[], operation: DesktopHeaderServiceOperation): boolean {
      if (operation !== lane || !current(generation, operation, 'instance')) return false;
      revisions.instances++;
      publish({ ...state, instances: { value, loading: false, stale: false, failed: false } }); return true;
    },
    projectUpdate(value: DesktopHeaderUpdateProjection, operation: DesktopHeaderServiceOperation): boolean {
      if (operation !== lane || !current(generation, operation, 'instance')) return false;
      revisions.update++;
      const failed = value.hostUpdate.status !== 'ready' || value.hostUpdate.value?.checkFailed === true;
      publish({ ...state, update: { value, loading: false, stale: failed, failed } }); return true;
    },
    async toggleMcp(name: string, connected: boolean): Promise<DesktopHeaderServiceResult> {
      reconcile();
      if (!demanded('mcp') || state.statuses.stale || state.statuses.failed || state.statuses.loading || !state.mcp.some(row => row.name === name) || state.mutations[name] === 'pending' || state.mutations[name] === 'unknown') return { status: 'unsupported' };
      const captured = transport.capture(); if (!captured) return { status: 'unsupported' };
      return work(`mutation:${name}`, 'mcp', async intent => {
        publish({ ...state, mutations: { ...state.mutations, [name]: 'pending' } });
        const transaction = createSettingsTransaction(captured.request, intent.current);
        try {
          await transaction(`/api/experimental/mcp/${encodeURIComponent(name)}/${connected ? 'connect' : 'disconnect'}${location}`, 'POST');
        } catch {
          if (!intent.current()) return { status: 'stale' };
          publish({ ...state, mutations: { ...state.mutations, [name]: 'unknown' } });
          return { status: 'unknown' };
        }
        if (!intent.current()) return { status: 'stale' };
        // A refresh opened while POST was pending may describe the pre-write
        // state. The required verification must start AFTER acknowledgement.
        revisions.statuses++;
        const beforeWrite = jobs.get('read:statuses');
        if (beforeWrite) { beforeWrite.finish({ status: 'stale' }); jobs.delete('read:statuses'); }
        const result = await readStatuses();
        if (!intent.current()) return { status: 'stale' };
        const actual = state.statuses.value?.find(row => row.name === name)?.status?.status;
        const mutations = { ...state.mutations }; delete mutations[name];
        if (result.status !== 'accepted' || (connected ? actual !== 'connected' : !actual || actual === 'connected')) mutations[name] = 'failed';
        publish({ ...state, mutations });
        return { status: mutations[name] ? 'failed' : 'accepted' };
      });
    },
    /** Explicit read-only retry after unknown POST; never resends it. */
    async reconcileMcp(name: string): Promise<DesktopHeaderServiceResult> {
      const result = await refreshMcp();
      if (result.status === 'accepted' && state.statuses.value?.some(row => row.name === name)) {
        const mutations = { ...state.mutations }; delete mutations[name]; publish({ ...state, mutations });
      }
      return result;
    },
    runInstance(action: DesktopHeaderInstanceAction, id?: string): Promise<DesktopHeaderServiceResult> {
      reconcile();
      if (!instanceAvailable(action, id)) return Promise.resolve({ status: 'unsupported' });
      return work('instance-action', 'instance', async intent => {
        publish({ ...state, instancePending: `${action}:${id || ''}`, instanceResult: null });
        let result: DesktopHeaderServiceResult;
        try { result = await options.instances!.run(action, id, intent); } catch { result = { status: 'unknown' }; }
        if (!intent.current()) return { status: 'stale' };
        publish({ ...state, instancePending: null, instanceResult: result.status });
        // No optimistic current/default row; root publishes only committed authority.
        if (result.status === 'accepted' && action !== 'add') await refreshInstance();
        return intent.current() ? result : { status: 'stale' };
      });
    },
    runUpdate(): Promise<DesktopHeaderServiceResult> {
      reconcile();
      if (!updateAvailable()) return Promise.resolve({ status: 'unsupported' });
      return work('update-action', 'instance', async intent => {
        try { return await options.update!.run(intent); } catch { return { status: 'unknown' }; }
      });
    },
    dispose() { if (!alive) return; alive = false; retired = true; lane = null; revoke(); },
  };
}
export type DesktopHeaderServicesOwner = ReturnType<typeof createDesktopHeaderServices>;
