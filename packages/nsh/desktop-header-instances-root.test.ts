import { describe, expect, test, vi } from 'vitest';
import { createDesktopHeaderInstancesRootController, desktopHeaderRemoteState, type DesktopHeaderCommittedConnections, type DesktopHeaderRemoteProjection } from './desktop-header-instances-root-core';
import { createDesktopHeaderServices, desktopHeaderInstanceDisplay } from './desktop-header-services';
import type { Connection } from './model';
import type { DesktopRemoteConnectionsState, DesktopSshInstance, DesktopSshStatus } from './desktop-remote-connections-core';

const connection = (id: string, url = 'https://example.invalid', label = id): Connection => ({ id, url, label, lastUsedAt: 0, authorizationID: `public-${id}` });
const instance = (id = 'ssh-a'): DesktopSshInstance => ({ id, label: id, host: 'ssh.example.invalid', user: 'fixture', port: 22, remotePort: 3210, localPort: 0, managed: true });
const status = (id: string, connectionID: string | null, phase: DesktopSshStatus['phase'] = 'ready'): DesktopSshStatus => ({ id, attempt: 1, requestID: 'request', phase, error: null, retry: 0, running: false, connectionID });
const sshState = (instances = [instance()], statuses: DesktopSshStatus[] = []): DesktopRemoteConnectionsState => ({ snapshot: { revision: 1, saving: false, instances, statuses, receipts: [] }, ready: true, reading: false, busy: false, failed: false, unknown: null, sync: null, preview: null, history: null });
function fixture() {
  let alive = true, visible = true, failed = false, enumerate = 0;
  let committed: DesktopHeaderCommittedConnections | null = { connections: [connection('a'), connection('b')], connection: connection('a'), online: true };
  let remote: DesktopHeaderRemoteProjection = { owner: null, state: null, available: false, connectAvailable: false };
  const localListeners = new Set<() => void>(), remoteListeners = new Set<() => void>();
  const read = vi.fn(() => { if (failed) throw new Error('unavailable'); return committed; });
  const projection = vi.fn(() => remote), switchAction = vi.fn(async (_target, intent) => ({ status: intent.current() ? 'accepted' as const : 'stale' as const })), addAction = vi.fn(async intent => ({ status: intent.current() ? 'accepted' as const : 'stale' as const }));
  const connect = vi.fn(async (_target, intent) => ({ status: intent.current() ? 'accepted' as const : 'stale' as const }));
  const owner = createDesktopHeaderInstancesRootController({ current: () => alive,
    committed: { read, subscribe(listener) { localListeners.add(listener); return () => { localListeners.delete(listener); }; } },
    remote: { projection, connect, subscribe(listener) { remoteListeners.add(listener); return () => { remoteListeners.delete(listener); }; } },
    switch: { available: () => true, run: switchAction }, add: { available: () => true, run: addAction },
  });
  const intent = { current: () => visible && alive };
  return { owner, intent, read, projection, switchAction, addAction, connect,
    alive: (value: boolean) => { alive = value; }, visible: (value: boolean) => { visible = value; }, fail: (value: boolean) => { failed = value; },
    committed: (value: DesktopHeaderCommittedConnections | null) => { committed = value; },
    remote: (value: DesktopHeaderRemoteProjection) => { remote = value; },
    notifyLocal: () => localListeners.forEach(listener => listener()), notifyRemote: () => remoteListeners.forEach(listener => listener()),
    counts: () => ({ local: localListeners.size, remote: remoteListeners.size, enumerate }),
    registry(value: DesktopRemoteConnectionsState) {
      const rows = value.snapshot!.instances;
      value = { ...value, snapshot: { ...value.snapshot!, instances: new Proxy(rows, { get(target, key, receiver) { if (key === Symbol.iterator) enumerate++; return Reflect.get(target, key, receiver); } }) } };
      remote = { owner: {}, state: desktopHeaderRemoteState(value), available: true, connectAvailable: true };
    },
  };
}
describe('Instance root ports over actual committed/unique SSH projections', () => {
  test('remote publication is a closed metadata projection, not a controller/receipt/sync payload export', () => {
    const source = sshState(); const value = desktopHeaderRemoteState(source);
    expect(Object.keys(value).sort()).toEqual(['busy', 'failed', 'ready', 'snapshot', 'syncUnknown', 'unknown']);
    expect(Object.keys(value.snapshot!).sort()).toEqual(['instances', 'revision', 'saving', 'statuses']);
    expect(value.snapshot!.instances).toBe(source.snapshot!.instances); expect(value.snapshot!.statuses).toBe(source.snapshot!.statuses);
    expect('receipts' in value.snapshot!).toBe(false); expect('preview' in value).toBe(false); expect('history' in value).toBe(false);
  });
  test('constructor/hidden do not read/subscribe or create anything; unknown is not LAN/local/Relay inferred from URL/label', async () => {
    const f = fixture(); expect(f.read).not.toHaveBeenCalled(); expect(f.projection).not.toHaveBeenCalled(); expect(f.counts()).toMatchObject({ local: 0, remote: 0 });
    const values = [connection('loopback', 'http://127.0.0.1:3210', 'Local SSH Relay'), connection('relay', 'relay://example', 'Local'), connection('http', 'https://example.invalid')];
    f.committed({ connections: values, connection: values[0], online: true });
    const rows = await f.owner.read(f.intent); expect(rows.map(row => row.transport)).toEqual(['unknown', 'unknown', 'unknown']); expect(rows.every(row => !row.isDefault && !row.display.probe && !row.display.currentTransportIsRelay)).toBe(true);
    expect(f.owner.available('switch', 'connection:loopback')).toBe(true); expect(f.owner.available('connect', 'connection:loopback')).toBe(false);
    expect(f.owner.available('default', 'connection:http')).toBe(false); expect(f.owner.available('new-window', 'connection:http')).toBe(false);
  });
  test('only native ready connectionID association supplies SSH kind; registry order retained and no duplicate bound row', async () => {
    const f = fixture(); f.registry(sshState([instance('one'), instance('two')], [status('one', 'b')]));
    const rows = await f.owner.read(f.intent);
    expect(rows.map(row => [row.id, row.transport])).toEqual([['connection:a', 'unknown'], ['connection:b', 'ssh'], ['ssh:two', 'ssh']]);
    expect(f.owner.available('switch', 'connection:b')).toBe(true); expect(f.owner.available('switch', 'ssh:two')).toBe(false); expect(f.owner.available('connect', 'ssh:two')).toBe(true);
    expect(rows[1].display.sshPhase).toBe('ready'); expect(rows[2].display.isActive).toBe(false);
  });
  test('duplicate bindings/uncommitted connectionID never choose first match, invent selection or merge by origin', async () => {
    const f = fixture(); f.registry(sshState([instance('one'), instance('two')], [status('one', 'a'), status('two', 'a')]));
    let rows = await f.owner.read(f.intent); expect(rows[0].transport).toBe('unknown'); expect(rows.map(row => row.id)).toEqual(['connection:a', 'connection:b', 'ssh:one', 'ssh:two']);
    f.registry(sshState([instance()], [status('ssh-a', 'not-committed')])); rows = await f.owner.read(f.intent);
    expect(rows.every(row => row.id !== 'connection:not-committed')).toBe(true); expect(f.owner.available('switch', 'ssh:ssh-a')).toBe(false);
  });
  test('source failures preserve prior and revoke actions; successful empty is authoritative and malformed selection is not empty', async () => {
    const f = fixture(); const prior = await f.owner.read(f.intent); f.fail(true); await expect(f.owner.read(f.intent)).rejects.toThrow(); expect(f.owner.snapshot()).toBe(prior); expect(f.owner.available('switch', 'connection:b')).toBe(false);
    f.fail(false); f.committed({ connections: [], connection: connection('missing'), online: false }); await expect(f.owner.read(f.intent)).rejects.toThrow('instances_uncommitted_selection'); expect(f.owner.snapshot()).toBe(prior);
    f.committed({ connections: [], connection: null, online: false }); expect(await f.owner.read(f.intent)).toEqual([]);
  });
  test('remote failed/unknown/pending/readiness keeps typed prior but cannot claim live status or Connect availability', async () => {
    const f = fixture(); const state = sshState([instance()], [status('ssh-a', null, 'idle')]);
    for (const patch of [{ failed: true }, { unknown: 'request' }, { busy: true }, { sync: { runID: 'run', phase: 'unknown' as const } }]) {
      f.remote({ owner: {}, state: desktopHeaderRemoteState({ ...state, ...patch }), available: true, connectAvailable: true });
      const rows = await f.owner.read(f.intent); expect(rows.some(row => row.id === 'ssh:ssh-a')).toBe(true); expect(f.owner.available('connect', 'ssh:ssh-a')).toBe(false);
    }
    f.remote({ owner: {}, state: desktopHeaderRemoteState(state), available: false, connectAvailable: false }); const rows = await f.owner.read(f.intent); expect(desktopHeaderInstanceDisplay(rows[2]).statusKind).toBeNull();
  });
  test('read caches by source identities; 50 input-like availability reads and unchanged projections enumerate zero registries', async () => {
    const f = fixture(); f.registry(sshState()); const prior = await f.owner.read(f.intent); const count = f.counts().enumerate, reads = f.read.mock.calls.length;
    for (let i = 0; i < 50; i++) { f.owner.available('switch', 'connection:b'); f.owner.available('connect', 'ssh:ssh-a'); }
    expect(f.read).toHaveBeenCalledTimes(reads); expect(f.counts().enumerate).toBe(count);
    for (let i = 0; i < 50; i++) expect(await f.owner.read(f.intent)).toBe(prior);
    expect(f.counts().enumerate).toBe(count); expect(f.connect).not.toHaveBeenCalled();
  });
  test('switch/add get exact frozen target/from and guarding callbacks; no bare switch or default/new-window producer', async () => {
    const f = fixture(); await f.owner.read(f.intent);
    expect(await f.owner.run('switch', 'connection:b', f.intent)).toEqual({ status: 'accepted' });
    expect(f.switchAction.mock.calls[0][0]).toEqual({ id: 'b', url: 'https://example.invalid', authorizationID: 'public-b' }); expect(Object.isFrozen(f.switchAction.mock.calls[0][0])).toBe(true);
    expect(f.switchAction.mock.calls[0][1].from).toEqual({ id: 'a', url: 'https://example.invalid', authorizationID: 'public-a' });
    expect(await f.owner.run('add', undefined, f.intent)).toEqual({ status: 'accepted' }); expect(f.addAction).toHaveBeenCalledTimes(1);
    expect(await f.owner.run('default', 'connection:b', f.intent)).toEqual({ status: 'unsupported' });
  });
  test('late target URL/auth/source changes fence guarded callback before main commit, while rename does not substitute identity', async () => {
    const f = fixture(); await f.owner.read(f.intent);
    let release!: () => void, committed = 0;
    f.switchAction.mockImplementationOnce(async (_target, intent) => { await new Promise<void>(resolve => { release = resolve; }); if (intent.current()) committed++; return { status: intent.current() ? 'accepted' : 'stale' }; });
    const flight = f.owner.run('switch', 'connection:b', f.intent);
    f.committed({ connections: [connection('a'), { ...connection('b'), authorizationID: 'new-public-auth' }], connection: connection('a'), online: true }); release();
    expect(await flight).toEqual({ status: 'stale' }); expect(committed).toBe(0);
    await f.owner.read(f.intent); const old = f.switchAction.mock.calls[0][1]; expect(old.current()).toBe(false);
  });
  test('same-id SSH edits/owner replacement during original confirmation revoke exact connect target', async () => {
    const f = fixture(); f.registry(sshState()); await f.owner.read(f.intent);
    let release!: () => void;
    f.connect.mockImplementationOnce(async (_target, intent) => { await new Promise<void>(resolve => { release = resolve; }); return { status: intent.current() ? 'accepted' : 'stale' }; });
    const flight = f.owner.run('connect', 'ssh:ssh-a', f.intent);
    f.registry(sshState([{ ...instance(), remotePort: 4321 }])); release(); expect(await flight).toEqual({ status: 'stale' });
    expect(f.connect).toHaveBeenCalledTimes(1);
  });
  test('visible-only subscription drops stale/hidden callbacks and retirement/disposal never resurrects source', async () => {
    const f = fixture(), changed = vi.fn(); await f.owner.read(f.intent);
    const stop = f.owner.subscribe!(f.intent, changed); expect(f.counts()).toMatchObject({ local: 1, remote: 1 });
    f.notifyLocal(); expect(changed).toHaveBeenCalledTimes(1); expect(f.owner.available('switch', 'connection:b')).toBe(false);
    await f.owner.read(f.intent); f.visible(false); f.notifyRemote(); expect(changed).toHaveBeenCalledTimes(1); expect(f.owner.available('switch', 'connection:b')).toBe(false);
    stop(); expect(f.counts()).toMatchObject({ local: 0, remote: 0 });
    f.alive(false); await expect(f.owner.read(f.intent)).rejects.toThrow(); f.alive(true); f.visible(true); await expect(f.owner.read(f.intent)).rejects.toThrow(); f.owner.dispose();
  });
  test('services consumes subscriptions only for visible Instance, not MCP/Usage/modal; push supersedes prior read', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); const lane = { current: () => true, request: async () => { throw new Error('No runtime HTTP permitted'); } };
      const services = createDesktopHeaderServices({ current: () => true, operation: () => lane, instances: f.owner, changed() {} });
      services.update({ tab: 'usage', active: true }); expect(f.counts().local).toBe(0);
      services.update({ tab: 'instance', active: true }); await services.refreshInstance(); expect(f.counts().local).toBe(1);
      f.committed({ connections: [connection('a'), connection('new')], connection: connection('a'), online: true }); f.notifyLocal();
      await services.refreshInstance(); expect(services.snapshot().instances.value?.map(row => row.id)).toEqual(['connection:a', 'connection:new']);
      const reads = f.read.mock.calls.length;
      for (let i = 0; i < 50; i++) services.update({ tab: 'instance', active: true }); expect(f.read).toHaveBeenCalledTimes(reads);
      services.update({ tab: 'instance', active: false }); expect(f.counts().local).toBe(0);
      f.notifyLocal(); await vi.advanceTimersByTimeAsync(30_000); expect(f.read).toHaveBeenCalledTimes(reads); expect(vi.getTimerCount()).toBe(0);
      services.dispose();
    } finally { vi.useRealTimers(); }
  });
  test('visible source push supersedes delayed older projection and never restarts unrelated resources', async () => {
    const f = fixture(); let hold = true, release!: () => void;
    const instances = { ...f.owner, async read(intent) {
      const rows = await f.owner.read(intent);
      if (hold) { hold = false; await new Promise<void>(resolve => { release = resolve; }); }
      return rows;
    } };
    const lane = { current: () => true, request: vi.fn(async () => { throw new Error('No GET'); }) };
    const services = createDesktopHeaderServices({ current: () => true, operation: () => lane, instances, changed() {} });
    services.update({ tab: 'instance', active: true }); await Promise.resolve();
    f.committed({ connections: [connection('a'), connection('new')], connection: connection('a'), online: true }); f.notifyLocal();
    await services.refreshInstance(); const prior = services.snapshot(); expect(prior.instances.value?.[1].id).toBe('connection:new');
    release(); await Promise.resolve(); await Promise.resolve(); expect(services.snapshot()).toBe(prior); expect(lane.request).not.toHaveBeenCalled(); services.dispose();
  });
  test('a void callback cannot become an accepted native action receipt', async () => {
    const f = fixture(); await f.owner.read(f.intent);
    f.addAction.mockImplementationOnce(async () => undefined as never);
    expect(await f.owner.run('add', undefined, f.intent)).toEqual({ status: 'unknown' });
  });
});
