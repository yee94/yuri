import { describe, expect, test, vi } from 'vitest';
import { createHeaderQuotas, headerQuotaGroup, headerQuotaReset, headerQuotaValue, type HeaderQuotaSnapshot } from './chat-header-quota';
import { QUOTA_PROVIDERS } from '../ui/src/lib/quota/providers';

const quota = (id = 'magpie:neutral:cursor', sourceId: string | null = 'neutral') => ({
  providerId: id, providerName: 'Neutral provider', configured: true, ok: true, fetchedAt: 100,
  ...(sourceId ? { source: 'magpie', sourceId, upstreamProviderId: 'cursor' } : {}),
  usage: {
    windows: { 'Account Alpha · Weekly': { label: 'Weekly', usedPercent: 8, remainingPercent: 92, resetAt: 2000 }, 'Account Beta · Weekly': { label: 'Weekly', usedPercent: 16, remainingPercent: 84, resetAt: 2000 } },
    accounts: [{ name: 'Account Alpha', user: 'not-for-render', stale: false }, { name: 'Account Beta', stale: false }],
  },
});
const source = () => ({ sources: [{ id: 'neutral', name: 'Neutral', results: [quota()] }] });

describe('Native header quotas use Host provider/aggregate contracts', () => {
  test('account headings and authoritative usage/remaining/reset labels match mobile grouping', () => {
    const group = headerQuotaGroup(quota(), {}, 1000)!;
    expect(group.rows.map(row => row.accountHeading)).toEqual(['Account Alpha', 'Account Beta']);
    expect(headerQuotaValue(group.rows[0], 'usage')).toBe('8%');
    expect(headerQuotaValue(group.rows[0], 'remaining')).toBe('92%');
    expect(group.rows[0].window.resetAt).toBe(2000);
    expect(JSON.stringify(group)).not.toContain('not-for-render');
    expect(group.stale).toBe(false);
  });
  test('missing/unlimited/failed/stale/expired data never fabricates zero or a new quota window', () => {
    const value = quota();
    const group = headerQuotaGroup({ ...value, ok: false, error: 'Upstream unavailable', usage: { ...value.usage, windows: { missing: {}, unlimited: { valueLabel: '∞' }, expired: { usedPercent: 63, resetAt: 500 } } } }, {}, 1000)!;
    expect(headerQuotaValue(group.rows[0], 'usage')).toBe('—');
    expect(headerQuotaValue(group.rows[0], 'remaining')).toBe('—');
    expect(headerQuotaValue(group.rows[1], 'usage')).toBe('∞');
    expect(group.rows[2]).toMatchObject({ stale: true, window: { usedPercent: 63, resetAt: 500 } });
    expect(group.error).toBe('Upstream unavailable');
    expect(group.stale).toBe(true);
    expect(headerQuotaReset({ ...group.rows[0].window, resetAfterFormatted: 'Later' }, 'auto')).toBe('Later');
    expect(headerQuotaGroup({ providerId: 'codex', configured: false, ok: true })).toBeNull();
  });
  test('selected model filters apply to model windows, not unrelated account windows', () => {
    const value = quota();
    const group = headerQuotaGroup({ ...value, usage: { ...value.usage, models: { 'gemini/model-a': { windows: { weekly: { usedPercent: 23 } } }, 'model-b': { windows: { weekly: { usedPercent: 57 } } } } } }, { [value.providerId]: ['gemini/model-a'] }, 1000)!;
    expect(group.rows).toHaveLength(3);
    expect(group.rows[2]).toMatchObject({ subtitle: 'model-a', window: { usedPercent: 23 } });
  });
  test('desktop metadata preserves exact model/window identity, family order, whitelist and the unchanged mobile order', () => {
    const window = { usedPercent: 23, remainingPercent: 77, disablePace: true, windowSeconds: 604800, resetAt: 604801000, credential: 'never-retain', user: { private: 'never-retain' } };
    const value = { providerId: 'google', configured: true, ok: true, usage: { windows: { weekly: window }, models: {
      'unmatched/model': { windows: { first: window, ignored: { usedPercent: 99 } } },
      'antigravity/same-name': { windows: { week: window } }, 'gemini/same-name': { windows: { week: window } },
      'gemini/excluded': { windows: { week: window } },
    }, accounts: [{ name: 'Account', user: 'never-retain', plan: 'never-retain', secret: 'never-retain' }] } };
    const group = headerQuotaGroup(value, { google: ['unmatched/model', 'antigravity/same-name', 'gemini/same-name'] }, 1000)!;
    expect(group.rows.map(row => row.key)).toEqual(['weekly', 'model:unmatched/model:first', 'model:antigravity/same-name:week', 'model:gemini/same-name:week']);
    expect(group.desktop?.entries.map(row => row.key)).toEqual(['weekly']);
    expect(group.desktop?.families.map(family => family.id)).toEqual(['gemini-auth', 'antigravity-auth', null]);
    expect(group.desktop?.families[0].models[0]).toMatchObject({ modelKey: 'gemini/same-name', windowKey: 'week', row: { subtitle: 'same-name', window: { disablePace: true } } });
    expect(group.desktop?.families[1].models[0].row).toBe(group.rows[2]);
    expect(JSON.stringify(group)).not.toMatch(/never-retain|credential|private|excluded|ignored/);
    const all = headerQuotaGroup(value, { google: [] }, 1000)!;
    expect(all.rows).toHaveLength(5);
    const dynamic = headerQuotaGroup({ ...value, providerId: 'magpie:source:google', upstreamProviderId: 'google' }, {}, 1000)!;
    expect(dynamic.desktop?.families.map(family => family.id)).toEqual([null]);
    expect(dynamic.desktop?.families[0].models).toHaveLength(4);
  });
  test('desktop account headings only span aggregate entries without changing legacy rows', () => {
    const group = headerQuotaGroup({ providerId: 'google', configured: true, ok: true, usage: {
      windows: { weekly: { accountName: 'A', usedPercent: 2 } }, models: { model: { windows: { daily: { accountName: 'B', usedPercent: 3 } } } },
    } }, {}, 1000)!;
    expect(group.rows.map(row => row.accountHeading)).toEqual(['A', 'B']);
    expect(group.desktop?.entries[0].accountHeading).toBeUndefined();
  });
  test('reset formatting obeys UI locale instead of silently inheriting an English system locale', () => {
    const reset = new Date(2030, 0, 2, 13, 5).getTime(), now = new Date(2030, 0, 1, 12).getTime();
    const window = { usedPercent: null, remainingPercent: null, resetAt: reset, resetAfterSeconds: null, resetAtFormatted: null, resetAfterFormatted: null, windowSeconds: null };
    expect(headerQuotaReset(window, '24h', now, 'zh-CN')).toContain('月');
    expect(headerQuotaReset(window, '24h', now, 'zh-CN')).not.toMatch(/Jan|Wed/);
    expect(headerQuotaReset(window, '24h', now, 'en-US')).toContain('Jan');
  });
  test('one aggregate GET, configured-provider-only reads, settings filters, and explicit refresh bypass', async () => {
    let latest: HeaderQuotaSnapshot | undefined;
    const read = vi.fn(async (path: string) => {
      if (path === '/api/config/settings') return { usageDropdownProviders: ['codex'], usageDisplayMode: 'remaining', timeFormatPreference: '24h' };
      if (path === '/api/quota/providers') return { providers: ['codex', 'claude', 'unsupported'] };
      if (path === '/api/quota/codex') return quota('codex', null);
      if (path.startsWith('/api/quota/magpie?')) return source();
      throw new Error('Unexpected route');
    });
    const controller = createHeaderQuotas({ directory: '/workspace/a b', read, current: () => true, now: () => 1000, changed: value => { latest = value; } });
    await Promise.all([controller.refresh(), controller.refresh()]);
    expect(read).toHaveBeenCalledTimes(4);
    expect(read.mock.calls.some(([path]) => path === '/api/quota/claude')).toBe(false);
    expect(latest).toMatchObject({ displayMode: 'remaining', timeFormat: '24h', errors: [], loaded: true, loading: false });
    expect(latest?.groups).toHaveLength(2);
    await controller.refresh(true);
    expect(read.mock.calls.some(([path]) => path === '/api/quota/magpie?directory=%2Fworkspace%2Fa%20b&refresh=1')).toBe(true);
  });
  test('mobile dropdown/hidden-provider contract yields Cursor Magpie then Codex Magpie, not raw configured providers', async () => {
    let latest: HeaderQuotaSnapshot | undefined;
    const read = vi.fn(async (path: string) => {
      if (path === '/api/config/settings') return { usageDropdownProviders: [], magpieHiddenProviders: ['magpie:neutral:zcode', 'magpie:neutral:workbuddy'] };
      if (path === '/api/quota/providers') return { providers: ['xai', 'codex'] };
      if (path.startsWith('/api/quota/magpie?')) return { sources: [{ id: 'neutral', name: 'Neutral', results: ['cursor', 'codex', 'zcode', 'workbuddy'].map(id => ({ ...quota(`magpie:neutral:${id}`), upstreamProviderId: id })) }] };
      throw new Error('A filtered provider must not be requested');
    });
    const controller = createHeaderQuotas({ directory: '/workspace', current: () => true, now: () => 1000, read, changed: value => { latest = value; } });
    await controller.refresh();
    expect(latest?.groups.map(group => group.id)).toEqual(['magpie:neutral:cursor', 'magpie:neutral:codex']);
    expect(read).toHaveBeenCalledTimes(3);
    expect(latest?.errors).toEqual([]);
  });
  test('transient aggregate failure retains last complete accounts; successful empty clears them', async () => {
    let phase = 0, latest: HeaderQuotaSnapshot | undefined;
    const controller = createHeaderQuotas({ directory: '/workspace', current: () => true, now: () => 1000, changed: value => { latest = value; }, read: async path => {
      if (path === '/api/config/settings') return {};
      if (path === '/api/quota/providers') return { providers: [] };
      if (phase === 1) throw new Error('offline');
      return phase === 2 ? { sources: [] } : source();
    } });
    await controller.refresh();
    phase = 1; await controller.refresh();
    expect(latest?.groups[0]).toMatchObject({ stale: true, rows: [{ window: { usedPercent: 8 } }, { window: { usedPercent: 16 } }] });
    expect(latest?.errors).toEqual(['offline']);
    phase = 2; await controller.refresh();
    expect(latest?.groups).toEqual([]);
    expect(latest?.errors).toEqual([]);
  });
  test('source failure, malformed source result and incomplete discovery preserve prior source identity', async () => {
    let phase = 0, latest: HeaderQuotaSnapshot | undefined;
    const controller = createHeaderQuotas({ directory: '/workspace', current: () => true, now: () => 1000, changed: value => { latest = value; }, read: async path => {
      if (path === '/api/config/settings') return {};
      if (path === '/api/quota/providers') return { providers: [] };
      if (phase === 1) return { sources: [{ id: 'neutral', name: 'Neutral', results: [], error: 'source offline' }] };
      if (phase === 2) return { sources: [{ id: 'neutral', name: 'Neutral', results: [{ wrong: true }] }] };
      if (phase === 3) return { sources: [], incomplete: true };
      return source();
    } });
    await controller.refresh();
    for (phase = 1; phase <= 3; phase++) {
      await controller.refresh();
      expect(latest?.groups).toHaveLength(1);
      expect(latest?.groups[0].rows).toHaveLength(2);
      expect(latest?.groups[0].stale).toBe(true);
    }
  });
  test('hidden dynamic providers stay hidden and a failing native provider does not remove the aggregate', async () => {
    let hidden = false, latest: HeaderQuotaSnapshot | undefined;
    const controller = createHeaderQuotas({ directory: '/workspace', current: () => true, now: () => 1000, changed: value => { latest = value; }, read: async path => {
      if (path === '/api/config/settings') return { magpieHiddenProviders: hidden ? ['magpie:neutral:cursor'] : [] };
      if (path === '/api/quota/providers') return { providers: ['codex'] };
      if (path === '/api/quota/codex') throw new Error('provider offline');
      return source();
    } });
    await controller.refresh();
    expect(latest?.groups.find(group => group.id === 'codex')).toMatchObject({ error: 'provider offline', rows: [] });
    expect(latest?.groups.find(group => group.sourceId === 'neutral')?.rows).toHaveLength(2);
    hidden = true; await controller.refresh();
    expect(latest?.groups.some(group => group.sourceId === 'neutral')).toBe(false);
  });
  test('credential expiry explicitly clears prior account data but surfaces the Host failure', async () => {
    let expired = false, latest: HeaderQuotaSnapshot | undefined;
    const controller = createHeaderQuotas({ directory: '/workspace', current: () => true, now: () => 1000, changed: value => { latest = value; }, read: async path => {
      if (path === '/api/config/settings') return {};
      if (path === '/api/quota/providers') return { providers: [] };
      return expired ? { sources: [{ id: 'neutral', name: 'Neutral', results: [], clearPrevious: true, error: 'Magpie quota access denied' }] } : source();
    } });
    await controller.refresh();
    expired = true; await controller.refresh();
    expect(latest?.groups).toEqual([]);
    expect(latest?.errors).toEqual(['Magpie quota access denied']);
  });
  test('Host/page fence discards late account-bearing responses, and disposal prevents all later reads', async () => {
    let current = true;
    const pending: ((value: unknown) => void)[] = [], changed = vi.fn();
    const read = vi.fn(() => new Promise(done => pending.push(done)));
    const controller = createHeaderQuotas({ directory: '/workspace', current: () => current, read, changed });
    const flight = controller.refresh();
    current = false; controller.dispose();
    pending.forEach(done => done(source()));
    await flight;
    await controller.refresh();
    expect(read).toHaveBeenCalledTimes(3);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed.mock.calls[0][0].groups).toEqual([]);
  });
  test('showPredValues is strict; lastUpdated is successful-result time, not fetchedAt, and all failure preserves it', async () => {
    let phase = 0, now = 1000, latest: HeaderQuotaSnapshot | undefined;
    const owner = createHeaderQuotas({ directory: '/fixture', current: () => true, now: () => now, changed: value => { latest = value; }, read: async path => {
      if (phase === 2) throw new Error('offline');
      if (path === '/api/config/settings') return { usageShowPredValues: phase === 0 ? 'true' : true };
      if (path === '/api/quota/providers') return { providers: [] };
      if (phase === 3) return { sources: [] };
      return source();
    } });
    await owner.refresh(); expect(latest).toMatchObject({ showPredValues: false, lastUpdated: 1000 });
    now = 2000; phase = 1; await owner.refresh(); expect(latest).toMatchObject({ showPredValues: true, lastUpdated: 2000 });
    const desktop = latest!.groups[0].desktop;
    now = 3000; phase = 2; await owner.refresh(); expect(latest).toMatchObject({ showPredValues: true, lastUpdated: 2000 });
    expect(latest!.groups[0].desktop).toBe(desktop); expect(latest!.groups[0].stale).toBe(true);
    phase = 3; await owner.refresh(); expect(latest!.groups).toEqual([]); expect(latest!.lastUpdated).toBe(2000);
  });
  test('partial dynamic failure preserves desktop metadata of valid siblings and retires late results', async () => {
    let partial = false, latest: HeaderQuotaSnapshot | undefined, current = true;
    let release: (() => void) | undefined;
    const owner = createHeaderQuotas({ directory: '/fixture', current: () => current, changed: value => { latest = value; }, read: async path => {
      if (path === '/api/config/settings') return {};
      if (path === '/api/quota/providers') return { providers: [] };
      if (release) await new Promise<void>(done => { release = done; });
      return { sources: [{ id: 'neutral', results: partial ? [{ invalid: true }, { ...quota('magpie:neutral:other'), usage: { windows: { fresh: { usedPercent: 8 } } } }] : [quota()] }] };
    } });
    await owner.refresh(); const prior = latest!.groups[0].desktop;
    partial = true; await owner.refresh();
    expect(latest!.groups.find(group => group.id === 'magpie:neutral:cursor')).toMatchObject({ stale: true, desktop: prior });
    expect(latest!.groups.find(group => group.id === 'magpie:neutral:other')?.desktop?.entries[0].key).toBe('fresh');
    release = () => {}; const flight = owner.refresh(); await Promise.resolve();
    const before = latest; current = false; owner.cancel(); release?.(); await flight;
    expect(latest).toBe(before);
  });
  test('provider reads remain configured-only four-wide and bounded; construction does no IO', async () => {
    const ids = QUOTA_PROVIDERS.slice(0, 7).map(provider => provider.id);
    expect(ids).toHaveLength(7);
    let concurrent = 0, peak = 0, latest: HeaderQuotaSnapshot | undefined;
    const read = vi.fn(async (path: string) => {
      if (path === '/api/config/settings') return {};
      if (path === '/api/quota/providers') return { providers: [...ids, 'unsupported'] };
      if (path.startsWith('/api/quota/magpie?')) return { sources: [] };
      concurrent++; peak = Math.max(peak, concurrent); await Promise.resolve(); concurrent--;
      const id = path.slice('/api/quota/'.length); expect(ids).toContain(id); return quota(id, null);
    });
    const owner = createHeaderQuotas({ directory: '/fixture', read, current: () => true, changed: value => { latest = value; } });
    expect(read).not.toHaveBeenCalled(); await owner.refresh(); expect(peak).toBe(4); expect(latest!.groups).toHaveLength(ids.length); expect(read).toHaveBeenCalledTimes(ids.length + 3);
  });
});
