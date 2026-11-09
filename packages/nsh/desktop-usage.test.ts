import { describe, expect, it } from 'vitest';
import { desktopUsageReadFailed, desktopUsageRows } from './desktop-usage-core';
import { createSettingsUsage, usageAccountRows, usageModelGroups } from './settings-usage-core';
import { usageFixtureResult, usageResult, usageWindow } from './settings-usage-fixture-data';

describe('desktop usage presentation projection', () => {
  it('retains source account/window order, real model identity, and complete collapsed families', () => {
    const result = usageFixtureResult(), accounts = usageAccountRows(result), groups = usageModelGroups(result);
    const rows = desktopUsageRows(accounts, groups, {});
    expect(rows.slice(0, 6).map(row => row.id)).toEqual(['account:z-account', 'z-account:credits_balance', 'z-account:monthly', 'z-account:unknown', 'account:a-account', 'a-account:daily']);
    expect(rows.find(row => row.kind === 'window' && row.id === 'z-account:credits_balance')).toMatchObject({ window: { valueLabel: '$19.25' } });
    expect(rows.filter(row => row.kind === 'model').map(row => row.id)).toContain('other/real-id');
    const hidden = desktopUsageRows(accounts, groups, Object.fromEntries(groups.map(group => [group.id, true])));
    expect(hidden.filter(row => row.kind === 'model')).toHaveLength(0);
    expect(hidden.filter(row => row.kind === 'family')).toHaveLength(groups.length);
  });
  it('retains every large account window and model as metadata instead of one giant realized account row', () => {
    const result = usageFixtureResult();
    result.usage!.accounts![0].windows = Object.fromEntries(Array.from({ length: 2000 }, (_, index) => [`window-${index}`, usageWindow()]));
    result.usage!.models = Object.fromEntries(Array.from({ length: 3000 }, (_, index) => [`other/model-${index}`, { windows: { daily: usageWindow() } }]));
    const rows = desktopUsageRows(usageAccountRows(result), usageModelGroups(result), {});
    expect(rows.filter(row => row.kind === 'window')).toHaveLength(2001);
    expect(rows.filter(row => row.kind === 'model')).toHaveLength(3000);
    expect(rows.at(-1)?.id).toBe('other/model-2999');
  });
  it('distinguishes builtin/source/aggregate read failure from successful empty', () => {
    const result = usageResult({ providerId: 'magpie:fixture', source: 'magpie', sourceId: 'fixture' });
    expect(desktopUsageReadFailed(undefined, { google: true }, 'google')).toBe(true);
    expect(desktopUsageReadFailed(result, { fixture: true }, result.providerId)).toBe(true);
    expect(desktopUsageReadFailed(result, { magpie: true }, result.providerId)).toBe(true);
    expect(desktopUsageReadFailed(result, { google: true }, result.providerId)).toBe(false);
    expect(desktopUsageReadFailed({ ...result, ok: false }, {}, result.providerId)).toBe(true);
    expect(desktopUsageReadFailed(undefined, {}, 'google')).toBe(false);
  });
  it('inline provider selection reuses the original write lane for missing defaults, never quota-refreshes or replays an explicit empty', async () => {
    let settings: Record<string, unknown> = { usageSelectedModels: { google: [] } };
    const calls: Array<{ path: string; method: string }> = [];
    const owner = createSettingsUsage({ current: () => true, defaultsEnabled: true, providers: ['google', 'claude'], selectedProviderId: 'google', async send(path, method = 'GET', body) {
      calls.push({ path, method });
      if (path === '/api/config/settings') { if (method === 'PUT') settings = { ...settings, ...body as object }; return settings; }
      if (path === '/api/quota/magpie?refresh=1') return { sources: [], incomplete: false };
      return usageResult({ providerId: path.endsWith('claude') ? 'claude' : 'google', usage: { windows: {}, models: { 'claude-sonnet-4': { windows: { daily: usageWindow() } } } } });
    } });
    owner.setActive(true); await owner.refresh();
    const count = calls.length;
    owner.selectProvider('claude', true);
    await viWait(() => !owner.state().writing);
    expect(calls.slice(count).map(call => `${call.method} ${call.path}`)).toEqual(['GET /api/config/settings', 'PUT /api/config/settings', 'GET /api/config/settings']);
    const after = calls.length;
    owner.selectProvider('google', true); await Promise.resolve();
    expect(calls).toHaveLength(after);
    expect((settings.usageSelectedModels as Record<string, string[]>).google).toEqual([]);
    owner.setActive(false); owner.selectProvider('claude', true);
    expect(owner.state().selectedProviderId).toBe('google');
    owner.dispose();
  });
  it('a provider picked during a confirmed preference flight applies its defaults in the same serial owner afterwards', async () => {
    let settings: Record<string, unknown> = { usageSelectedModels: { google: [] } }, writes = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const calls: string[] = [];
    const owner = createSettingsUsage({ current: () => true, defaultsEnabled: true, providers: ['google', 'claude'], selectedProviderId: 'google', async send(path, method = 'GET', body) {
      calls.push(`${method} ${path}`);
      if (path === '/api/config/settings') {
        if (method === 'PUT') { settings = { ...settings, ...body as object }; if (++writes === 1) await blocked; }
        return settings;
      }
      if (path === '/api/quota/magpie?refresh=1') return { sources: [], incomplete: false };
      return usageResult({ providerId: path.endsWith('claude') ? 'claude' : 'google', usage: { windows: {}, models: { 'claude-sonnet-4': { windows: { daily: usageWindow() } } } } });
    } });
    owner.setActive(true); await owner.refresh();
    const before = calls.length, flight = owner.selectHeader('google', false);
    await viWait(() => writes === 1); owner.selectProvider('claude', true); release(); await flight;
    await viWait(() => writes === 2 && !owner.state().writing);
    expect(calls.slice(before)).toEqual(Array.from({ length: 2 }, () => ['GET /api/config/settings', 'PUT /api/config/settings', 'GET /api/config/settings']).flat());
    expect((settings.usageSelectedModels as Record<string, string[]>).claude).toEqual(['claude-sonnet-4']);
    expect((settings.usageSelectedModels as Record<string, string[]>).google).toEqual([]);
    owner.dispose();
  });
});

async function viWait(ready: () => boolean) {
  for (let count = 0; count < 30 && !ready(); count++) await Promise.resolve();
  expect(ready()).toBe(true);
}
