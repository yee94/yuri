import { describe, expect, test, vi } from 'vitest';
import { createDesktopHeaderServices, desktopHeaderInstanceDisplay, desktopHeaderInstanceVersion, desktopHeaderMcpSnapshot, type DesktopHeaderInstance, type DesktopHeaderServiceOperation, type DesktopHeaderServicesSnapshot, type DesktopHeaderUpdateProjection } from './desktop-header-services';

const row = (id = 'a', active = true): DesktopHeaderInstance => ({ id, label: `Host ${id}`, transport: 'lan', isDefault: false, display: { isActive: active, isSsh: false, runtimeIsConnected: true, runtimeConnectionPhase: 'connected', currentTransportIsRelay: false, probe: { status: 'ok', latencyMs: 10 }, sshPhase: undefined } });
const update = (): DesktopHeaderUpdateProjection => ({ hostUpdate: { status: 'ready', refreshing: false, value: { supported: true, currentVersion: '1.2.3', available: true, availableVersion: '1.2.4', operation: null, checkFailed: false, serverId: 'fixture', channel: 'stable', plan: { version: '1.2.4', kind: 'cli-package', planId: 'plan', rollback: false, restartRequired: true, releaseNotes: null } } }, updateBusy: false, updateFailed: false, updateUncertain: false, updateConfirm: null });
function fixture() {
  let authority = true, enabled = true, gate = false, fail = '', deferred = false, writeUnknown = false;
  let configs: unknown = [{ name: 'Beta' }, { name: 'Alpha' }];
  let statuses: unknown = { data: [{ name: 'Alpha', status: { status: 'connected' } }, { name: 'Gamma', status: { status: 'needs_auth' } }] };
  let hosts: readonly DesktopHeaderInstance[] = [row()], version = update();
  const reads: { path: string; method: string; body: unknown }[] = [], publishes: DesktopHeaderServicesSnapshot[] = [], actions: string[] = [], pending: (() => void)[] = [];
  const makeLane = (): DesktopHeaderServiceOperation => ({ current: () => enabled, request: async (path, method = 'GET', body) => {
    reads.push({ path, method, body });
    if (deferred) await new Promise<void>(resolve => pending.push(resolve));
    if (fail && path.includes(fail)) throw new Error('private error not for UI');
    if (method === 'POST') {
      if (writeUnknown) throw new Error('lost ACK');
      statuses = { data: [{ name: 'Alpha', status: { status: path.includes('/disconnect') ? 'disabled' : 'connected' } }] }; return true;
    }
    return path.startsWith('/api/config/') ? configs : statuses;
  } });
  let lane: DesktopHeaderServiceOperation | null = makeLane();
  let instanceReads = 0, updateReads = 0, instanceFail = false, updateFail = false;
  const owner = createDesktopHeaderServices({ directory: '/work/a b', current: () => authority, operation: () => lane,
    changed: value => publishes.push(value),
    instances: { read: async intent => { instanceReads++; if (deferred) await new Promise<void>(resolve => pending.push(resolve)); if (!intent.current() || instanceFail) throw new Error('instance failed'); return hosts; }, available: () => true, run: async (action, id, intent) => { actions.push(`${action}:${id || ''}`); if (deferred) await new Promise<void>(resolve => pending.push(resolve)); return { status: intent.current() ? 'accepted' : 'stale' }; } },
    update: { read: async intent => { updateReads++; if (deferred) await new Promise<void>(resolve => pending.push(resolve)); if (!intent.current() || updateFail) throw new Error('update failed'); return version; }, nativeGate: () => gate, available: () => true, run: async () => { actions.push('update'); return { status: 'accepted' }; } },
  });
  return { owner, reads, publishes, actions, pending, makeLane,
    counts: () => ({ instanceReads, updateReads }),
    authority: (value: boolean) => { authority = value; }, enabled: (value: boolean) => { enabled = value; },
    gate: (value: boolean) => { gate = value; }, fail: (value: string) => { fail = value; },
    defer: (value: boolean) => { deferred = value; }, writeUnknown: (value: boolean) => { writeUnknown = value; },
    configs: (value: unknown) => { configs = value; }, statuses: (value: unknown) => { statuses = value; }, hosts: (value: readonly DesktopHeaderInstance[]) => { hosts = value; }, version: (value: DesktopHeaderUpdateProjection) => { version = value; },
    instanceFail: (value: boolean) => { instanceFail = value; }, updateFail: (value: boolean) => { updateFail = value; },
    lane: (value: DesktopHeaderServiceOperation | null) => { lane = value; },
    release() { pending.splice(0).forEach(resolve => resolve()); },
    async open(tab: 'mcp' | 'instance') { owner.update({ tab, active: true }); return tab === 'mcp' ? owner.refreshMcp(true) : owner.refreshInstance(); },
  };
}
describe('desktop Header runtime services retained authority', () => {
  test('zero construction/hidden/other-tab polling, and 50 input-like updates enumerate/read/publish nothing extra', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); expect(f.reads).toEqual([]); expect(f.counts()).toEqual({ instanceReads: 0, updateReads: 0 });
      f.owner.update({ tab: 'usage', active: true });
      for (let i = 0; i < 50; i++) f.owner.update({ tab: 'usage', active: true });
      expect(f.reads).toEqual([]); expect(vi.getTimerCount()).toBe(0);
      expect(await f.open('mcp')).toEqual({ status: 'accepted' }); expect(f.reads).toHaveLength(2);
      const snapshot = f.owner.snapshot(), changes = f.publishes.length;
      for (let i = 0; i < 50; i++) f.owner.update({ tab: 'mcp', active: true });
      expect(f.owner.snapshot()).toBe(snapshot); expect(f.publishes).toHaveLength(changes); expect(f.reads).toHaveLength(2);
      expect(f.owner.snapshot().mcp.map(row => row.name)).toEqual(['Alpha', 'Beta', 'Gamma']);
      expect(f.reads.map(read => read.path).sort()).toEqual(['/api/config/mcp?directory=%2Fwork%2Fa%20b', '/api/mcp?location%5Bdirectory%5D=%2Fwork%2Fa%20b']);
      f.owner.update({ tab: null, active: false }); await vi.advanceTimersByTimeAsync(90_000); expect(f.reads).toHaveLength(2); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  test('refresh is Web status-only; failed config/status preserve independent prior and sorted names', async () => {
    const f = fixture(); await f.open('mcp'); await f.owner.refreshMcp(); expect(f.reads).toHaveLength(3);
    f.configs([{ name: 'New config' }]); f.fail('/api/mcp');
    expect(await f.owner.refreshMcp(true)).toEqual({ status: 'failed' });
    expect(f.owner.snapshot().statuses).toMatchObject({ failed: true, stale: true });
    expect(f.owner.snapshot().configs).toMatchObject({ failed: false, stale: false, value: ['New config'] });
    expect(f.owner.snapshot().mcp.map(row => row.name)).toEqual(['Alpha', 'Gamma', 'New config']);
    f.fail('/api/config'); f.statuses({ data: [] }); expect(await f.owner.refreshMcp(true)).toEqual({ status: 'failed' });
    expect(f.owner.snapshot().mcp.map(row => row.name)).toEqual(['New config']);
    f.fail(''); f.configs([]); expect(await f.owner.refreshMcp(true)).toEqual({ status: 'accepted' }); expect(f.owner.snapshot().mcp).toEqual([]);
  });
  test('malformed, partial and logical errors never become empty success', async () => {
    for (const payload of [{}, { data: [] , complete: false }, { data: [], incomplete: true }, { success: false, data: [] }, { data: [{ name: 'a', status: {} }] }, { data: [{ name: 'a', status: { status: 'failed' } }] }]) expect(() => desktopHeaderMcpSnapshot(payload)).toThrow();
    expect(desktopHeaderMcpSnapshot({ data: [] })).toEqual([]);
    const f = fixture(); await f.open('mcp'); f.statuses({ data: [], complete: false });
    expect(await f.owner.refreshMcp()).toEqual({ status: 'failed' }); expect(f.owner.snapshot().mcp).toHaveLength(3);
  });
  test('modal/hidden/tab switch fences late results immediately, retained prior survives remount and a new lane', async () => {
    const f = fixture(); await f.open('mcp'); f.defer(true);
    const old = f.owner.refreshMcp(); f.owner.update({ tab: 'mcp', active: false });
    expect(await old).toEqual({ status: 'stale' }); expect(f.owner.snapshot().statuses.loading).toBe(false); expect(f.owner.snapshot().mcp).toHaveLength(3);
    f.defer(false); f.statuses({ data: [{ name: 'New lane', status: { status: 'disabled' } }] }); f.lane(f.makeLane()); await f.open('mcp');
    const prior = f.owner.snapshot(); f.release(); await Promise.resolve(); await Promise.resolve(); expect(f.owner.snapshot()).toBe(prior);
    expect(f.owner.snapshot().mcp.map(row => row.name)).toEqual(['Alpha', 'Beta', 'New lane']);
  });
  test('lane pause/resume keeps prior and does not read hidden; identity retirement never revives', async () => {
    const f = fixture(); await f.open('instance'); f.lane(null); f.owner.update({ tab: 'instance', active: true });
    expect(f.owner.snapshot().instances).toMatchObject({ stale: true, value: [row()] });
    f.owner.update({ tab: null, active: false }); const counts = f.counts(); f.lane(f.makeLane()); f.owner.update({ tab: null, active: false }); expect(f.counts()).toEqual(counts);
    await f.open('instance'); expect(f.owner.snapshot().instances.stale).toBe(false);
    f.authority(false); f.owner.update({ tab: 'instance', active: true }); const reads = f.counts(), changes = f.publishes.length;
    f.authority(true); await f.open('instance'); expect(f.counts()).toEqual(reads); expect(f.publishes).toHaveLength(changes);
  });
  test('runtime connect/disconnect use exact SDK-gap POST and reread, never config patches or optimistic Switch', async () => {
    const f = fixture(); await f.open('mcp'); f.defer(true);
    const promise = f.owner.toggleMcp('Alpha', false); expect(f.owner.snapshot().mcp[0].status?.status).toBe('connected');
    expect(f.owner.snapshot().mutations.Alpha).toBe('pending'); expect(await f.owner.toggleMcp('Alpha', false)).toEqual({ status: 'unsupported' });
    f.defer(false); f.release(); expect(await promise).toEqual({ status: 'accepted' });
    expect(f.reads.filter(read => read.method === 'POST')).toEqual([{ path: '/api/experimental/mcp/Alpha/disconnect?location%5Bdirectory%5D=%2Fwork%2Fa%20b', method: 'POST', body: undefined }]);
    expect(f.owner.snapshot().mcp[0].status?.status).toBe('disabled');
    expect(await f.owner.toggleMcp('Alpha', true)).toEqual({ status: 'accepted' }); expect(f.owner.snapshot().mcp[0].status?.status).toBe('connected');
  });
  test('unknown POST is retained and retry is GET-only; acknowledged write plus failed refresh is failed, never replayed', async () => {
    const f = fixture(); await f.open('mcp'); f.writeUnknown(true);
    expect(await f.owner.toggleMcp('Alpha', false)).toEqual({ status: 'unknown' }); expect(await f.owner.toggleMcp('Alpha', false)).toEqual({ status: 'unsupported' });
    const writes = f.reads.filter(read => read.method === 'POST').length;
    f.fail('/api/mcp'); expect(await f.owner.reconcileMcp('Alpha')).toEqual({ status: 'failed' }); expect(f.owner.snapshot().mutations.Alpha).toBe('unknown');
    f.fail(''); expect(await f.owner.reconcileMcp('Alpha')).toEqual({ status: 'accepted' }); expect(f.owner.snapshot().mutations.Alpha).toBeUndefined(); expect(f.reads.filter(read => read.method === 'POST')).toHaveLength(writes);
    f.writeUnknown(false); f.fail('/api/mcp'); expect(await f.owner.toggleMcp('Alpha', false)).toEqual({ status: 'failed' }); expect(f.owner.snapshot().mutations.Alpha).toBe('failed');
    f.fail(''); await f.owner.reconcileMcp('Alpha'); expect(f.reads.filter(read => read.method === 'POST')).toHaveLength(writes + 1);
  });
  test('late mutation never refreshes or commits after closing or switching Host', async () => {
    const f = fixture(); await f.open('mcp'); f.defer(true); const promise = f.owner.toggleMcp('Alpha', false);
    f.owner.update({ tab: 'usage', active: true }); expect(await promise).toEqual({ status: 'stale' }); expect(f.owner.snapshot().mutations.Alpha).toBe('unknown');
    const reads = f.reads.length; f.release(); await Promise.resolve(); await Promise.resolve(); expect(f.reads).toHaveLength(reads);
    expect(f.owner.snapshot().mcp[0].status?.status).toBe('connected');
  });
  test('needs auth/registration/failed remain real status; no OAuth or browser success invented', async () => {
    const f = fixture(); f.statuses({ data: [{ name: 'Auth', status: { status: 'needs_auth' }, integrationID: 'integration' }, { name: 'Registration', status: { status: 'needs_client_registration', error: 'Register a client' } }, { name: 'Failed', status: { status: 'failed', error: 'Down' } }] }); await f.open('mcp');
    expect(f.owner.snapshot().mcp.find(row => row.name === 'Auth')).toMatchObject({ status: { status: 'needs_auth' }, integrationID: 'integration' });
    expect(f.reads.every(read => read.method === 'GET')).toBe(true); expect(f.actions).toEqual([]);
  });
  test('Instance/update independent prior, native gate required even with available plan/HTTP and explicit action', async () => {
    const f = fixture(); await f.open('instance'); expect(f.reads).toEqual([]); expect(f.counts()).toEqual({ instanceReads: 1, updateReads: 1 });
    expect(f.owner.updateAvailable()).toBe(false); expect(await f.owner.runUpdate()).toEqual({ status: 'unsupported' }); expect(f.actions).toEqual([]);
    f.gate(true); expect(f.owner.updateAvailable()).toBe(true); expect(await f.owner.runUpdate()).toEqual({ status: 'accepted' });
    f.updateFail(true); f.hosts([row('b')]); expect(await f.owner.refreshInstance()).toEqual({ status: 'failed' });
    expect(f.owner.snapshot().instances.value?.[0].id).toBe('b'); expect(f.owner.snapshot().update.value?.hostUpdate.value?.currentVersion).toBe('1.2.3'); expect(f.owner.updateAvailable()).toBe(false);
    f.updateFail(false); f.instanceFail(true); expect(await f.owner.refreshInstance()).toEqual({ status: 'failed' }); expect(f.owner.snapshot().instances.value?.[0].id).toBe('b'); expect(f.owner.snapshot().update.failed).toBe(false);
  });
  test('update unknown/failed/checking/stale and active task cannot be promoted to write availability', async () => {
    const f = fixture(); f.gate(true);
    for (const patch of [{ updateUncertain: true }, { updateBusy: true }, { hostUpdate: { ...update().hostUpdate, status: 'failed' as const } }, { hostUpdate: { ...update().hostUpdate, value: { ...update().hostUpdate.value!, operation: 'installing' as const } } }]) {
      f.version({ ...update(), ...patch }); await f.open('instance'); await f.owner.refreshInstance(); expect(f.owner.updateAvailable()).toBe(false);
    }
    expect(f.actions).toEqual([]);
  });
  test('host display reuses real runtime authority and never old direct latency under Relay', async () => {
    const host = row(); host.display.currentTransportIsRelay = true;
    expect(desktopHeaderInstanceDisplay(host)).toMatchObject({ statusKind: 'ok', showViaRelay: true, latencyMs: null });
    host.display.runtimeIsConnected = false; expect(desktopHeaderInstanceDisplay(host).statusKind).toBe('checking');
    const f = fixture(); host.display.isActive = false; host.display.probe = { status: 'unreachable', latencyMs: 20 }; f.hosts([host]); await f.open('instance');
    expect(f.owner.instanceAvailable('default', 'a')).toBe(false); expect(f.owner.instanceAvailable('new-window', 'a')).toBe(false);
    expect(await f.owner.runInstance('default', 'a')).toEqual({ status: 'unsupported' });
  });
  test('Instance delegates exact existing action and no optimistic current/default, no hidden actions, missing capabilities explicit', async () => {
    const f = fixture(); await f.open('instance'); expect(await f.owner.runInstance('default', 'a')).toEqual({ status: 'accepted' }); expect(f.actions).toEqual(['default:a']); expect(f.owner.snapshot().instances.value?.[0].isDefault).toBe(false);
    f.owner.update({ tab: null, active: false }); expect(await f.owner.runInstance('switch', 'a')).toEqual({ status: 'unsupported' });
    const noPorts = createDesktopHeaderServices({ current: () => true, operation: f.makeLane, changed() {} }); noPorts.update({ tab: 'instance', active: true });
    expect(noPorts.instanceAvailable('new-window', 'a')).toBe(false); expect(noPorts.updateAvailable()).toBe(false); expect(await noPorts.refreshInstance()).toEqual({ status: 'unsupported' });
  });
  test('dispose settles in-flight resource jobs and prevents all late publishers/actions', async () => {
    const f = fixture(); f.defer(true); f.owner.update({ tab: 'mcp', active: true }); const old = f.owner.refreshMcp(true); const count = f.publishes.length;
    f.owner.dispose(); expect(await old).toEqual({ status: 'stale' }); f.release(); await Promise.resolve(); await Promise.resolve();
    expect(f.publishes).toHaveLength(count); expect(await f.owner.refreshMcp()).toEqual({ status: 'unsupported' }); expect(await f.owner.toggleMcp('Alpha', true)).toEqual({ status: 'unsupported' });
  });
  test('existing-owner pushed projections fence older in-flight reads and reject hidden/old lanes without GET', async () => {
    const f = fixture(); await f.open('instance');
    const captured = f.makeLane(); f.lane(captured); await f.open('instance');
    f.defer(true); const old = f.owner.refreshInstance();
    const live = { ...update(), updateBusy: true };
    expect(f.owner.projectUpdate(live, captured)).toBe(true); expect(f.owner.projectInstances([row('pushed')], captured)).toBe(true);
    const reads = f.reads.length; f.defer(false); f.release(); expect(await old).toEqual({ status: 'stale' });
    expect(f.owner.snapshot().update.value).toBe(live); expect(f.owner.snapshot().instances.value?.[0].id).toBe('pushed'); expect(f.reads).toHaveLength(reads);
    f.owner.update({ tab: null, active: false }); expect(f.owner.projectUpdate(update(), captured)).toBe(false);
    f.lane(f.makeLane()); await f.open('instance'); expect(f.owner.projectInstances([], captured)).toBe(false);
  });
  test('a refresh during POST cannot satisfy after-ACK verification or overwrite the newer runtime state', async () => {
    let connected = true, deferPost = false, deferGet = false;
    let releasePost!: () => void, releaseGet!: () => void;
    const reads: string[] = [];
    const lane: DesktopHeaderServiceOperation = { current: () => true, request: async (path, method = 'GET') => {
      reads.push(`${method}:${path}`);
      if (method === 'POST') { if (deferPost) await new Promise<void>(resolve => { releasePost = resolve; }); connected = false; return true; }
      if (path.startsWith('/api/config')) return [{ name: 'Alpha' }];
      const data = { data: [{ name: 'Alpha', status: { status: connected ? 'connected' : 'disabled' } }] };
      if (deferGet) await new Promise<void>(resolve => { releaseGet = resolve; });
      return data;
    } };
    const owner = createDesktopHeaderServices({ current: () => true, operation: () => lane, changed() {} });
    owner.update({ tab: 'mcp', active: true }); await owner.refreshMcp(true);
    deferPost = true; const mutation = owner.toggleMcp('Alpha', false);
    deferGet = true; const oldRefresh = owner.refreshMcp();
    deferGet = false; releasePost(); expect(await mutation).toEqual({ status: 'accepted' });
    expect(await oldRefresh).toEqual({ status: 'stale' }); expect(reads.filter(path => path.startsWith('GET:/api/mcp'))).toHaveLength(3);
    releaseGet(); await Promise.resolve(); await Promise.resolve(); expect(owner.snapshot().mcp[0].status?.status).toBe('disabled');
  });
  test('version fallback only uses validated serving-Host projection, never client/OpenCode or arbitrary error text', () => {
    expect(desktopHeaderInstanceVersion({ ...update(), version: '9.9.9' })).toBe('1.2.3');
    const unsupported = { ...update(), hostUpdate: { ...update().hostUpdate, value: null } };
    expect(desktopHeaderInstanceVersion({ ...unsupported, version: '2.3.4' })).toBe('2.3.4');
    expect(desktopHeaderInstanceVersion({ ...unsupported, version: 'https://private.invalid' })).toBeNull();
    expect(desktopHeaderInstanceVersion(null)).toBeNull();
  });
});
