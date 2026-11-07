import { describe, expect, it, vi } from 'vitest';
import { sanitizeUsageSelectedModels, defaultUsageSelectedModels } from '../ui/src/lib/quota/model-selection-core.js';
import { createSettingsUsage, usageProviderChoice } from './settings-usage-core';
import { usageFixtureResult, usageResult } from './settings-usage-fixture-data';
import { usageSemanticPalette } from './settings-usage-palette';
import { appearanceFromSettings } from './appearance-core';
import dark from '../ui/src/lib/theme/themes/yuri-2-dark.json';

function fixture(options: { settings?: Record<string, unknown>; selected?: string; failSettings?: boolean } = {}) {
  let settings = options.settings ?? {}, failed = options.failSettings ?? false, ackFailed = false, readbackFailed = false, afterWrite = false;
  const providerFailures = new Set<string>();
  const send = vi.fn(async (path: string, method = 'GET', body?: unknown): Promise<unknown> => {
    if (path === '/api/config/settings') {
      if (method === 'PUT') { settings = { ...settings, ...body as Record<string, unknown> }; afterWrite = true; if (ackFailed) throw new Error('Synthetic ACK failure'); return { success: true }; }
      if (failed || afterWrite && readbackFailed) throw new Error('Synthetic settings failure'); return structuredClone(settings);
    }
    if (path.includes('/magpie?')) return { sources: [] };
    if (providerFailures.has(path)) throw new Error('Synthetic provider failure');
    return path.endsWith('/google') ? usageFixtureResult() : usageResult({ providerId: 'claude', providerName: 'Claude', configured: false, usage: null });
  });
  const owner = createSettingsUsage({ send, current: () => true, providers: ['claude', 'google'], selectedProviderId: options.selected ?? 'google', defaultsEnabled: true });
  return { owner, send, providerFailures, fail: (value: boolean) => { failed = value; }, failAck: (value: boolean) => { ackFailed = value; }, failReadback: (value: boolean) => { readbackFailed = value; }, settings: () => settings, replaceSettings: (value: Record<string, unknown>) => { settings = value; } };
}
describe('Usage completion contracts', () => {
  it('explicit empty arrays survive shared sanitization, and only missing provider keys receive defaults', () => {
    expect(sanitizeUsageSelectedModels({ google: [], claude: ['real-id'] })).toEqual({ google: [], claude: ['real-id'] });
    expect(sanitizeUsageSelectedModels(undefined)).toBeUndefined(); expect(sanitizeUsageSelectedModels({ google: [null] })).toBeUndefined();
    expect(sanitizeUsageSelectedModels({})).toBeUndefined();
    expect(defaultUsageSelectedModels({ google: [] }, 'google', ['default'])).toBeNull();
    expect(defaultUsageSelectedModels({}, 'google', [])).toBeNull();
    expect(defaultUsageSelectedModels({}, 'google', ['default'])).toEqual({ usageSelectedModels: { google: ['default'] } });
  });
  it('persists defaults only for visible selected provider after successful authority/model reads, once', async () => {
    const f = fixture(); f.owner.setActive(true); await f.owner.refresh();
    expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
    expect(f.settings()).toMatchObject({ usageSelectedModels: { google: ['antigravity/claude-sonnet'] } });
    await f.owner.refresh(); expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1); f.owner.dispose();
  });
  it('never writes defaults after initial settings failure or for explicitly empty profile choices', async () => {
    for (const options of [{ failSettings: true }, { settings: { usageSelectedModels: { google: [] } } }]) {
      const f = fixture(options); f.owner.setActive(true); await f.owner.refresh(); expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); f.owner.dispose();
    }
  });
  it('restores selected provider identity without storing invented Host preferences', async () => {
    const f = fixture({ selected: 'claude' }); f.owner.setActive(true); await f.owner.refresh();
    expect(f.owner.state().selectedProviderId).toBe('claude'); expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); f.owner.dispose();
  });
  it('uses one visibility-owned timer; automatic refresh obeys exact interval and performs quotas-only reads', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ settings: { usageAutoRefresh: true, usageRefreshIntervalMs: 60000, usageSelectedModels: { google: [] } } });
      f.owner.setActive(true); await f.owner.refresh(); f.send.mockClear(); expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(59999); expect(f.send).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1); expect(f.send).toHaveBeenCalledTimes(3); expect(f.send.mock.calls.some(([path]) => path === '/api/config/settings')).toBe(false);
      f.owner.setActive(false); expect(vi.getTimerCount()).toBe(0); f.send.mockClear(); await vi.advanceTimersByTimeAsync(300000); expect(f.send).not.toHaveBeenCalled(); f.owner.dispose();
    } finally { vi.useRealTimers(); }
  });
  it('warning is the current custom Host semantic palette, with no default-theme or foreground fallback', async () => {
    const custom = structuredClone(dark); custom.metadata.id = 'usage-custom-dark'; custom.colors.status.warning = '#aabbcc';
    const appearance = await appearanceFromSettings({ themeVariant: 'dark', darkThemeId: custom.metadata.id }, async () => ({ themes: [custom] }));
    expect(usageSemanticPalette(appearance, 'dark').warning).toBe('#aabbcc');
    expect(usageSemanticPalette(appearance, 'light').warning).toBe('#aabbcc');
    expect(usageSemanticPalette(null, 'dark')).toEqual({ safe: undefined, warning: undefined, critical: undefined });
  });
  it('clearing the last model is confirmed by authoritative [], remains empty after reopen, and never reapplies defaults', async () => {
    const f = fixture({ settings: { usageSelectedModels: { google: ['antigravity/claude-sonnet'] } } });
    f.owner.setActive(true); await f.owner.refresh(); f.send.mockClear(); await f.owner.selectModel('google', 'antigravity/claude-sonnet', false);
    expect(f.send.mock.calls.map(([, method]) => method ?? 'GET')).toEqual(['GET', 'PUT', 'GET']);
    expect(f.owner.state().settings?.usageSelectedModels?.google).toEqual([]); expect(f.owner.state().draft).toBeNull(); f.owner.dispose();
    const reopened = fixture({ settings: f.settings() }); reopened.owner.setActive(true); await reopened.owner.refresh();
    expect(reopened.owner.state().settings?.usageSelectedModels?.google).toEqual([]); expect(reopened.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); reopened.owner.dispose();
  });
  it('failed default ACK/readback keeps prior and default draft; every later refresh reconciles without replay', async () => {
    const f = fixture(); f.failAck(true); f.failReadback(true); f.owner.setActive(true); await f.owner.refresh();
    expect(f.owner.state()).toMatchObject({ settings: {}, draft: { usageSelectedModels: { google: ['antigravity/claude-sonnet'] } }, preferenceFailed: true, recovery: true });
    await f.owner.refresh(); f.owner.setActive(false); f.owner.setActive(true); await f.owner.refresh();
    expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1);
    f.failReadback(false); await f.owner.refresh(); expect(f.owner.state().draft).toBeNull(); expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1); f.owner.dispose();
  });
  it('fresh preflight preference wins a default race; it never overwrites another client explicit empty choice', async () => {
    const f = fixture(); const original = f.send.getMockImplementation()!; let settingsReads = 0;
    f.send.mockImplementation(async (path, method, body) => { if (path === '/api/config/settings' && method !== 'PUT' && ++settingsReads === 2) f.replaceSettings({ usageSelectedModels: { google: [] } }); return original(path, method, body); });
    f.owner.setActive(true); await f.owner.refresh(); expect(f.owner.state().settings?.usageSelectedModels?.google).toEqual([]);
    expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); f.owner.dispose();
  });
  it('an authoritative reset-to-missing preference can receive defaults again, but no default candidates cause no PUT', async () => {
    const f = fixture(); f.owner.setActive(true); await f.owner.refresh(); f.replaceSettings({}); await f.owner.refresh();
    expect(f.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(2); f.owner.dispose();
    const empty = fixture(); const original = empty.send.getMockImplementation()!;
    empty.send.mockImplementation(async (path, method, body) => path === '/api/quota/google' ? usageResult() : original(path, method, body));
    empty.owner.setActive(true); await empty.owner.refresh(); expect(empty.send.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); empty.owner.dispose();
  });
  it('provider fallback uses authoritative order/configuration, preserves known built-ins and removes vanished Magpie identities', () => {
    const results = [usageResult({ providerId: 'claude', configured: false }), usageResult({ providerId: 'google' }), usageResult({ providerId: 'magpie:z:quota', source: 'magpie' })];
    expect(usageProviderChoice(null, results)).toBe('google'); expect(usageProviderChoice('claude', results)).toBe('claude');
    expect(usageProviderChoice('magpie:z:quota', results)).toBe('magpie:z:quota');
    expect(usageProviderChoice('magpie:old:quota', results)).toBe('google'); expect(usageProviderChoice(null, results.map(result => ({ ...result, configured: false })))).toBe('claude');
  });
  it('interval changes restart the same timer, failed automatic provider reads retain prior, and disabling stops polling', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ settings: { usageAutoRefresh: true, usageRefreshIntervalMs: 60000, usageSelectedModels: { google: [] } } });
      f.owner.setActive(true); await f.owner.refresh(); const prior = f.owner.state().results.find(result => result.providerId === 'google');
      await f.owner.setPreference({ usageRefreshIntervalMs: 30000 }); f.send.mockClear(); f.providerFailures.add('/api/quota/google');
      await vi.advanceTimersByTimeAsync(30000); expect(f.send).toHaveBeenCalledTimes(3); expect(f.owner.state().results.find(result => result.providerId === 'google')).toBe(prior); expect(f.owner.state().errors.google).toBe(true); expect(vi.getTimerCount()).toBe(1);
      await f.owner.setPreference({ usageAutoRefresh: false }); f.send.mockClear(); await vi.advanceTimersByTimeAsync(300000); expect(f.send).not.toHaveBeenCalled();
      f.owner.dispose(); expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it('foreground return updates the shared countdown clock immediately, never replays missed background ticks', async () => {
    vi.useFakeTimers();
    try {
      const f = fixture({ settings: { usageAutoRefresh: true, usageRefreshIntervalMs: 60000, usageSelectedModels: { google: [] } } });
      f.owner.setActive(true); await f.owner.refresh(); f.owner.setActive(false); f.send.mockClear();
      await vi.advanceTimersByTimeAsync(600000); expect(f.send).not.toHaveBeenCalled();
      f.owner.setActive(true); expect(f.owner.state().now).toBe(Date.now()); await f.owner.refresh();
      expect(f.send).toHaveBeenCalledTimes(4); f.send.mockClear(); await vi.advanceTimersByTimeAsync(59999); expect(f.send).not.toHaveBeenCalled(); f.owner.dispose();
    } finally { vi.useRealTimers(); }
  });
  it('a slow/failed provider cannot block a completed unrelated provider from publication', async () => {
    const f = fixture({ settings: { usageSelectedModels: { google: [] } } }), original = f.send.getMockImplementation()!;
    let rejectSlow!: (reason: Error) => void;
    f.send.mockImplementation(async (path, method, body) => path === '/api/quota/claude' ? new Promise((_, reject) => { rejectSlow = reject; }) : original(path, method, body));
    f.owner.setActive(true); const pending = f.owner.refresh();
    await vi.waitFor(() => expect(f.owner.state().results.some(result => result.providerId === 'google')).toBe(true));
    rejectSlow(new Error('Synthetic timeout')); await pending; expect(f.owner.state().errors.claude).toBe(true); f.owner.dispose();
  });
  it('Magpie saves validate core URL rules and perform only one aggregate after write/readback, including lost ACK', async () => {
    const f = fixture({ settings: { usageSelectedModels: { google: [] } } }); f.owner.setActive(true); await f.owner.refresh(); f.send.mockClear();
    await f.owner.setPreference({ magpieUsageUrl: 'https://user:credential@example.test/v1' }); expect(f.send).not.toHaveBeenCalled(); expect(f.owner.state().preferenceFailed).toBe(true);
    f.failAck(true); await f.owner.setPreference({ magpieUsageUrl: 'https://quota.example.test/v1' });
    expect(f.send.mock.calls.map(([path, method]) => [path, method ?? 'GET'])).toEqual([['/api/config/settings', 'GET'], ['/api/config/settings', 'PUT'], ['/api/config/settings', 'GET'], ['/api/quota/magpie?refresh=1', 'GET']]);
    expect(f.owner.state().settings?.magpieUsageUrl).toBe('https://quota.example.test/v1'); expect(f.owner.state().draft).toBeNull(); f.owner.dispose();
  });
  it('rounds/clamps interval changes exactly as Host semantics before comparing authoritative readback', async () => {
    const f = fixture({ settings: { usageSelectedModels: { google: [] } } }); f.owner.setActive(true); await f.owner.refresh();
    for (const [input, expected] of [[1, 30000], [45000.6, 45001], [900000, 300000]]) {
      await f.owner.setPreference({ usageRefreshIntervalMs: input }); expect(f.owner.state().settings?.usageRefreshIntervalMs).toBe(expected); expect(f.owner.state().draft).toBeNull();
    }
    f.owner.dispose();
  });
  it('malformed Magpie source preserves only its prior while independent complete sources still publish', async () => {
    const f = fixture({ settings: { usageSelectedModels: { google: [] } } }), original = f.send.getMockImplementation()!;
    const old = usageResult({ providerId: 'magpie:z:quota', source: 'magpie', sourceId: 'z' }), fresh = usageResult({ providerId: 'magpie:a:quota', source: 'magpie', sourceId: 'a' });
    let aggregate: unknown = { sources: [{ id: 'z', results: [old] }] };
    f.send.mockImplementation(async (path, method, body) => path.includes('/magpie?') ? aggregate : original(path, method, body));
    f.owner.setActive(true); await f.owner.refresh();
    aggregate = { sources: [{ id: 'z', identified: true, results: [{ providerId: 'invalid' }] }, { id: 'a', results: [fresh] }] };
    await f.owner.refresh(); expect(f.owner.state().results).toContain(old); expect(f.owner.state().results).toContain(fresh); expect(f.owner.state().errors.z).toBe(true);
    expect(f.owner.state().results.filter(result => result.source === 'magpie').map(result => result.providerId)).toEqual(['magpie:z:quota', 'magpie:a:quota']); f.owner.dispose();
  });
});
