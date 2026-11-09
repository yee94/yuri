import { describe, expect, test, vi } from 'vitest';
import { createDesktopChatHeaderOwner, type DesktopChatHeaderOperation } from './desktop-chat-header-owner';
import type { ChatHeaderMetadata } from './chat-header-metadata';

const target = { kind: 'session' as const, id: 'session-a', title: 'Captured title', directory: '/workspace/retained' };
const metadataPaths = (paths: string[]) => paths.filter(path => !path.startsWith('/api/quota/') && path !== '/api/config/settings');
function fixture(kind: 'session' | 'assistant' = 'session') {
  let authority = true, now = 0, sequence = 0;
  let title = 'Actual title', failMetadata = false, failQuota = '', deferredMetadata = false, deferredQuota = false;
  let providerFailure = false, accountFailure = false, incomplete = false, empty = false;
  const paths: string[] = [], methods: string[] = [], values: ChatHeaderMetadata[] = [];
  const pending: Array<() => void> = [];
  function response(path: string): unknown {
    const quota = path.startsWith('/api/quota/') || path === '/api/config/settings';
    if (quota && failQuota) throw new Error(failQuota);
    if (!quota && failMetadata) throw new Error('metadata unavailable');
    if (path === '/api/config/settings') return { usageDropdownProviders: ['codex'], usageDisplayMode: 'usage' };
    if (path === '/api/quota/providers') return { providers: empty ? [] : ['codex'] };
    if (path.startsWith('/api/quota/magpie?')) return { sources: [], incomplete };
    if (path === '/api/quota/codex') {
      if (providerFailure) throw new Error('Provider unavailable');
      return { providerId: 'codex', providerName: 'Codex', configured: true, ok: true,
        usage: { windows: { weekly: { usedPercent: 25, remainingPercent: 75 } }, accounts: [{ name: 'Account A', ...(accountFailure ? { stale: true, error: 'Account unavailable' } : {}) }] } };
    }
    if (path.includes('/catalog/providers')) return { schemaVersion: 1, providers: [{ id: 'fixture', models: { model: { id: 'model', limit: { context: 1000 } } } }] };
    if (path.includes('/message?')) return { data: [{ id: 'assistant', type: 'assistant', tokens: { input: 120, output: 30 } }, { id: 'user', type: 'user', model: { id: 'model', providerID: 'fixture' } }] };
    if (path.includes('/git/status')) return { current: 'main', files: [] };
    return { data: { id: target.id, title, model: { id: 'model', providerID: 'fixture' } } };
  }
  function createLane(): DesktopChatHeaderOperation & { enabled: boolean; id: number } {
    const lane = { enabled: true, id: ++sequence, current: () => lane.enabled,
      request: async (path: string, method = 'GET') => {
        paths.push(path); methods.push(method);
        const quota = path.startsWith('/api/quota/') || path === '/api/config/settings';
        if (quota ? deferredQuota : deferredMetadata) await new Promise<void>(resolve => pending.push(resolve));
        return response(path);
      },
    };
    return lane;
  }
  let operation: ReturnType<typeof createLane> | null = createLane();
  const owner = createDesktopChatHeaderOwner({ target: { ...target, kind }, current: () => authority,
    operation: () => operation, changed: value => values.push(value), now: () => now });
  return { owner, paths, methods, values, pending,
    get operation() { return operation; },
    set operation(value) { operation = value; },
    createLane,
    title(value: string) { title = value; },
    authority(value: boolean) { authority = value; },
    now(value: number) { now = value; },
    failMetadata(value: boolean) { failMetadata = value; },
    failQuota(value: string) { failQuota = value; },
    deferMetadata(value: boolean) { deferredMetadata = value; },
    deferQuota(value: boolean) { deferredQuota = value; },
    providerFailure(value: boolean) { providerFailure = value; },
    accountFailure(value: boolean) { accountFailure = value; },
    incomplete(value: boolean) { incomplete = value; },
    empty(value: boolean) { empty = value; },
    release() { pending.splice(0).forEach(resolve => resolve()); },
  };
}

describe('retained desktop header metadata owner', () => {
  test('constructs no reader work/timer; 50 unrelated updates do not read or enumerate', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture(); expect(f.paths).toEqual([]); expect(f.values).toEqual([]);
      for (let index = 0; index < 50; index++) f.owner.update({ readDemand: false, busy: false });
      expect(f.paths).toEqual([]); expect(vi.getTimerCount()).toBe(0);
      f.owner.update({ readDemand: true, busy: false }); expect(await f.owner.refresh()).toEqual({ status: 'accepted' });
      expect(f.paths).toHaveLength(4); expect(f.owner.snapshot()).toMatchObject({ title: 'Actual title', tokens: 150, limit: 1000, loading: false, contextStale: false });
      const prior = f.owner.snapshot(), changes = f.values.length;
      for (let index = 0; index < 50; index++) f.owner.update({ readDemand: true, busy: false });
      expect(f.paths).toHaveLength(4); expect(f.owner.snapshot()).toBe(prior); expect(f.values).toHaveLength(changes);
      expect(f.methods.every(method => method === 'GET')).toBe(true); expect(vi.getTimerCount()).toBe(0);
      expect(f.paths.some(path => /session-index|\/session\?|model\/default|directory\/list/.test(path))).toBe(false);
      expect(f.paths.find(path => path.includes('/message?'))).toContain('limit=20&order=desc');
      f.owner.dispose(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  test('only lane, busy→idle and explicit refresh trigger metadata; demand-only reopening is not a polling source', async () => {
    const f = fixture(); f.owner.update({ readDemand: true, busy: true }); expect(f.paths).toHaveLength(0);
    f.owner.update({ busy: false }); await f.owner.refresh(); expect(f.paths).toHaveLength(4);
    f.owner.update({ busy: true }); expect(f.paths).toHaveLength(4);
    f.owner.update({ busy: false }); await f.owner.refresh(); expect(f.paths).toHaveLength(7);
    const snapshot = f.owner.snapshot();
    f.owner.setDemand(false); expect(f.owner.snapshot()).toMatchObject({ tokens: snapshot.tokens, loading: false, contextStale: true });
    f.owner.setDemand(true); expect(f.paths).toHaveLength(7);
    expect(await f.owner.refresh(true)).toEqual({ status: 'accepted' }); expect(f.paths).toHaveLength(11);
    f.now(61_000); f.operation = f.createLane(); f.owner.update({}); await f.owner.refresh(); expect(f.paths).toHaveLength(15);
    expect(f.paths.filter(path => path.includes('/catalog/providers'))).toHaveLength(3);
  });

  test('modal active || syncActive stays demanded and retains the same snapshot, source cache and no extra reads', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh();
    const prior = f.owner.snapshot();
    for (let index = 0; index < 50; index++) {
      const active = index % 2 === 0, syncActive = !active;
      f.owner.update({ readDemand: active || syncActive, busy: false });
    }
    expect(f.owner.snapshot()).toBe(prior); expect(f.paths).toHaveLength(4);
    f.owner.update({ busy: true }); f.owner.update({ busy: false }); await f.owner.refresh();
    expect(f.paths).toHaveLength(7); expect(f.paths.filter(path => path.includes('/catalog/providers'))).toHaveLength(1);
  });

  test('paused lane preserves title/context/quota, revokes loading and resumes without rebuilding catalog or auto-reading quota', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh();
    expect(await f.owner.refreshQuotas()).toEqual({ status: 'accepted' }); const reads = f.paths.length;
    f.operation = null; f.owner.update({});
    expect(f.owner.snapshot()).toMatchObject({ title: 'Actual title', tokens: 150, limit: 1000, contextStale: true, loading: false,
      quota: { loaded: false, loading: false, groups: [{ stale: true, rows: [{ stale: true, window: { usedPercent: 25 } }] }] } });
    expect(await f.owner.refreshQuotas()).toEqual({ status: 'unsupported' });
    f.operation = f.createLane(); f.owner.update({}); expect(await f.owner.refresh()).toEqual({ status: 'accepted' });
    expect(f.paths).toHaveLength(reads + 3);
    expect(f.owner.snapshot().quota).toMatchObject({ loaded: false, groups: [{ stale: true }] });
    expect(f.paths.filter(path => path.includes('/catalog/providers'))).toHaveLength(1);
    expect(await f.owner.refreshQuotas()).toEqual({ status: 'accepted' });
    expect(f.owner.snapshot().quota).toMatchObject({ loaded: true, groups: [{ stale: false }] });
  });

  test('late old metadata cannot overwrite a new lane; revoked result settles before old HTTP finishes', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh();
    f.deferMetadata(true); const old = f.owner.refresh(true); expect(f.pending).toHaveLength(4);
    f.operation = f.createLane(); f.owner.update({ busy: true });
    expect(await old).toEqual({ status: 'stale' }); expect(f.owner.snapshot().loading).toBe(false);
    f.deferMetadata(false); f.title('New lane title');
    f.owner.update({ busy: false }); expect(await f.owner.refresh()).toEqual({ status: 'accepted' });
    const prior = f.owner.snapshot(), changes = f.values.length;
    f.title('Late old completion'); f.release(); await Promise.resolve(); await Promise.resolve();
    expect(f.owner.snapshot()).toBe(prior); expect(f.values).toHaveLength(changes); expect(prior.title).toBe('New lane title');
  });

  test('quota late account responses cannot overwrite same-authority resumed lane; metadata and quota flights remain separate', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh();
    f.deferQuota(true); const old = f.owner.refreshQuotas(); expect(f.pending).toHaveLength(3);
    f.operation = f.createLane(); f.owner.update({}); expect(await old).toEqual({ status: 'stale' });
    await f.owner.refresh(); f.deferQuota(false); f.empty(true);
    expect(await f.owner.refreshQuotas()).toEqual({ status: 'accepted' }); expect(f.owner.snapshot().quota?.groups).toEqual([]);
    const prior = f.owner.snapshot(), changes = f.values.length;
    f.empty(false); f.release(); await Promise.resolve(); await Promise.resolve();
    expect(f.owner.snapshot()).toBe(prior); expect(f.values).toHaveLength(changes);
  });

  test('demand withdrawal cancels and preserves prior; reopening alone never retries a cancelled HTTP', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh();
    f.deferMetadata(true); const flight = f.owner.refresh(); const reads = f.paths.length;
    f.owner.setDemand(false); expect(await flight).toEqual({ status: 'stale' });
    expect(f.owner.snapshot()).toMatchObject({ title: 'Actual title', tokens: 150, contextStale: true, loading: false });
    f.owner.setDemand(true); expect(f.paths).toHaveLength(reads);
    const changes = f.values.length; f.release(); await Promise.resolve(); await Promise.resolve(); expect(f.values).toHaveLength(changes);
    f.deferMetadata(false); expect(await f.owner.refresh()).toEqual({ status: 'accepted' });
  });

  test('actual lane/idle events while undemanded defer one batch, but repeated updates do not repeat it', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh();
    f.owner.setDemand(false); f.owner.update({ busy: true }); f.owner.update({ busy: false });
    expect(f.paths).toHaveLength(4); f.owner.setDemand(true); await f.owner.refresh(); expect(f.paths).toHaveLength(7);
    for (let index = 0; index < 50; index++) f.owner.update({}); expect(f.paths).toHaveLength(7);
  });

  test('concurrent metadata/usage requests each coalesce, without quota patches clearing context staleness', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh();
    f.deferMetadata(true); f.deferQuota(true);
    const metadata = f.owner.refresh(), quota = f.owner.refreshQuotas();
    expect(f.owner.refresh()).toBe(metadata); expect(f.owner.refreshQuotas()).toBe(quota);
    expect(f.pending).toHaveLength(6); expect(f.owner.snapshot().contextStale).toBe(true);
    const start = f.paths.length;
    f.deferMetadata(false); f.deferQuota(false); f.release();
    expect(await metadata).toEqual({ status: 'accepted' }); expect(await quota).toEqual({ status: 'accepted' });
    expect(f.paths.length - start).toBe(1); // Only the configured provider's deferred second stage.
    expect(f.owner.snapshot()).toMatchObject({ contextStale: false, quota: { loaded: true, loading: false } });
  });

  test('metadata failure is failed, keeps prior and has no automatic retry timer/update loop', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh(); f.failMetadata(true);
    expect(await f.owner.refresh(true)).toEqual({ status: 'failed' });
    expect(f.owner.snapshot()).toMatchObject({ tokens: 150, title: 'Actual title', contextStale: true, loading: false });
    const count = f.paths.length; for (let index = 0; index < 50; index++) f.owner.update({}); expect(f.paths).toHaveLength(count);
    f.failMetadata(false); expect(await f.owner.refresh()).toEqual({ status: 'accepted' });
  });

  test('independent metadata/quota failures never clear the other lane failure or retained data', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh(); await f.owner.refreshQuotas();
    f.failMetadata(true); expect(await f.owner.refresh(true)).toEqual({ status: 'failed' });
    const errors = f.owner.snapshot().errors;
    expect(await f.owner.refreshQuotas()).toEqual({ status: 'accepted' });
    expect(f.owner.snapshot().errors).toBe(errors); expect(f.owner.snapshot().contextStale).toBe(true);
    f.failMetadata(false); f.providerFailure(true); expect(await f.owner.refreshQuotas()).toEqual({ status: 'failed' });
    const quota = f.owner.snapshot().quota;
    expect(await f.owner.refresh()).toEqual({ status: 'accepted' }); expect(f.owner.snapshot().quota).toBe(quota);
    expect(f.owner.snapshot().quota?.groups[0]).toMatchObject({ error: 'Provider unavailable', stale: true });
  });

  test('one busy→idle event during an existing read schedules only one following batch; draft-like updates add none', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh();
    f.deferMetadata(true); const first = f.owner.refresh(); expect(f.paths).toHaveLength(7);
    f.owner.update({ busy: true }); f.owner.update({ busy: false });
    for (let index = 0; index < 50; index++) f.owner.update({ readDemand: true, busy: false });
    expect(f.paths).toHaveLength(7); f.deferMetadata(false); f.release();
    expect(await first).toEqual({ status: 'accepted' }); expect(await f.owner.refresh()).toEqual({ status: 'accepted' });
    expect(f.paths).toHaveLength(10); expect(f.paths.filter(path => path.includes('/catalog/providers'))).toHaveLength(1);
    f.owner.update({ busy: true }); f.operation = f.createLane(); f.owner.update({ busy: false }); await f.owner.refresh();
    expect(f.paths).toHaveLength(13); // Coincident actual lane + idle is one batch, not two.
  });

  test('usage is explicit only; failed top-level/provider/account/incomplete results never become accepted void', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh();
    expect(f.paths.some(path => path.includes('/quota/'))).toBe(false);
    expect(await f.owner.refreshQuotas()).toEqual({ status: 'accepted' });
    f.providerFailure(true); expect(await f.owner.refreshQuotas()).toEqual({ status: 'failed' });
    expect(f.owner.snapshot().quota?.errors).toEqual([]); expect(f.owner.snapshot().quota?.groups[0].error).toBe('Provider unavailable');
    expect(f.owner.snapshot().quota?.groups[0].rows[0].window.usedPercent).toBe(25);
    f.providerFailure(false); f.accountFailure(true); expect(await f.owner.refreshQuotas()).toEqual({ status: 'failed' });
    f.accountFailure(false); f.incomplete(true); expect(await f.owner.refreshQuotas()).toEqual({ status: 'failed' });
    f.incomplete(false); f.failQuota('Quota offline'); expect(await f.owner.refreshQuotas()).toEqual({ status: 'failed' });
    expect(f.owner.snapshot().quota?.groups[0].rows[0].window.usedPercent).toBe(25);
    f.failQuota(''); f.empty(true); expect(await f.owner.refreshQuotas()).toEqual({ status: 'accepted' }); expect(f.owner.snapshot().quota?.groups).toEqual([]);
    const count = f.paths.length, before = f.owner.snapshot();
    expect(f.owner.setQuotaMode('remaining')).toEqual({ status: 'unsupported' }); expect(f.owner.snapshot()).toBe(before); expect(f.paths).toHaveLength(count);
  });

  test('authority retirement never revives and disposal settles pending reads without leaking changed', async () => {
    const f = fixture(); f.owner.update({ readDemand: true }); await f.owner.refresh();
    f.deferQuota(true); const quota = f.owner.refreshQuotas(); const count = f.values.length;
    f.authority(false); f.owner.update({}); expect(await quota).toEqual({ status: 'stale' }); expect(f.values).toHaveLength(count);
    f.authority(true); f.operation = f.createLane(); f.owner.update({}); expect(await f.owner.refresh()).toEqual({ status: 'unsupported' });
    const reads = f.paths.length; f.release(); await Promise.resolve(); await Promise.resolve(); expect(f.paths).toHaveLength(reads); expect(f.values).toHaveLength(count);
    const g = fixture(); g.owner.update({ readDemand: true }); await g.owner.refresh(); g.deferMetadata(true); const old = g.owner.refresh();
    const changes = g.values.length; g.owner.dispose(); expect(await old).toEqual({ status: 'stale' });
    expect(await g.owner.refresh()).toEqual({ status: 'unsupported' }); expect(await g.owner.refreshQuotas()).toEqual({ status: 'unsupported' });
    g.release(); await Promise.resolve(); await Promise.resolve(); expect(g.values).toHaveLength(changes);
  });

  test('assistant target never invents session metadata, but explicitly requested quota still uses its real directory', async () => {
    const f = fixture('assistant'); f.owner.update({ readDemand: true }); expect(await f.owner.refresh()).toEqual({ status: 'unsupported' }); expect(f.paths).toEqual([]);
    expect(await f.owner.refreshQuotas()).toEqual({ status: 'accepted' }); expect(metadataPaths(f.paths)).toEqual([]);
    expect(f.paths.some(path => path.includes('directory=%2Fworkspace%2Fretained'))).toBe(true);
  });
});
