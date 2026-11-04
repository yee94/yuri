import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTourPlugin, installRecommendedPlugins, installTourPlugins, tourPlugins } from './tourPlugins';
import { listPluginRuntime } from '@/lib/opencode/plugins';
import type { PluginEntry } from '@/stores/usePluginsStore';

vi.mock('@/stores/usePluginsStore', () => ({ usePluginsStore: { getState: () => ({ createEntry: async () => ({ ok: true }) }) } }));
vi.mock('@/queries/pluginQueries', () => ({ pluginsListQueryOptions: () => ({}), pluginRuntimeQueryOptions: () => ({ queryKey: ['runtime'] }) }));
vi.mock('@/lib/opencode/plugins', () => ({ listPluginRuntime: vi.fn() }));
vi.mock('@/lib/queryRuntime', () => ({ queryClient: { fetchQuery: async () => ({ entries: [] }), setQueryData: vi.fn() } }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => 1, getRuntimeTransportIdentity: () => 'test-host' }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('waits for native activation, with a bounded number of reads', async () => {
  vi.useFakeTimers();
  vi.mocked(listPluginRuntime).mockResolvedValue([]);
  const result = installRecommendedPlugins(['one'], '/workspace', new AbortController().signal);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ failed: [], pending: ['one'] });
  expect(listPluginRuntime).toHaveBeenCalledTimes(20);
  expect(vi.getTimerCount()).toBe(0);
});

it('cancels the activation delay on unmount without another inventory read', async () => {
  vi.useFakeTimers();
  vi.mocked(listPluginRuntime).mockResolvedValue([]);
  const controller = new AbortController();
  const result = installRecommendedPlugins(['one'], '/workspace', controller.signal);
  const rejected = expect(result).rejects.toThrow('Runtime changed');
  await vi.advanceTimersByTimeAsync(0);
  expect(listPluginRuntime).toHaveBeenCalledTimes(1);
  controller.abort();
  await rejected;
  await vi.runAllTimersAsync();
  expect(listPluginRuntime).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops polling when native activation arrives', async () => {
  vi.useFakeTimers();
  vi.mocked(listPluginRuntime).mockResolvedValueOnce([]).mockResolvedValueOnce([
    { source: { kind: 'package', target: 'one@1.0.0', version: '1.0.0', outdated: false, updating: false }, state: { kind: 'active' } },
  ]);
  const result = installRecommendedPlugins(['one'], '/workspace', new AbortController().signal);
  await vi.runAllTimersAsync();
  expect(await result).toEqual({ failed: [], pending: [] });
  expect(listPluginRuntime).toHaveBeenCalledTimes(2);
});

const entry = (spec: string): PluginEntry => ({ id: spec, spec, scope: 'user', kind: 'config', parsedKind: 'npm' });

describe('recommended plugin application', () => {
  it('keeps existing pinned versions and options, and retries a partially successful batch without duplicates', async () => {
    const specs = tourPlugins.map((plugin) => plugin.spec);
    const existing: PluginEntry[] = [{ ...entry(`${specs[0]}@0.5.1`), options: { gateway: 'existing' } }];
    let writes = 0;
    const create = vi.fn(async (spec: string) => {
      writes += 1;
      if (spec === specs[2] && writes === 2) return { ok: false };
      existing.push(entry(spec)); return { ok: true };
    });
    const deps = {
      list: async () => existing,
      create,
      active: async () => existing.map((item) => item.spec.replace(/@\d.*$/, '')),
      current: () => true,
    };
    expect(await installTourPlugins(specs, deps)).toEqual({ failed: [specs[2]], pending: [] });
    expect(await installTourPlugins(specs, deps)).toEqual({ failed: [], pending: [] });
    expect(create.mock.calls.map(([spec]) => spec)).toEqual([specs[1], specs[2], specs[2]]);
    expect(existing[0].options).toEqual({ gateway: 'existing' });
    expect(existing).toHaveLength(3);
  });

  it('does not treat a failed inventory read as an empty configuration to overwrite', async () => {
    const create = vi.fn();
    const result = await installTourPlugins(['one'], {
      list: async () => { throw new Error('offline'); }, create, active: async () => [], current: () => true,
    });
    expect(result).toEqual({ failed: ['one'], pending: [] });
    expect(create).not.toHaveBeenCalled();
  });

  it('does not certify activation from a successful config write', async () => {
    const result = await installTourPlugins(['one'], {
      list: async () => [], create: async () => ({ ok: true }), active: async () => [], current: () => true,
    });
    expect(result).toEqual({ failed: [], pending: ['one'] });
  });

  it('stops before a write if the runtime changed during its inventory read', async () => {
    let current = true;
    const create = vi.fn();
    await expect(installTourPlugins(['one', 'two'], {
      list: async () => { current = false; return []; }, create, active: async () => [], current: () => current,
    })).rejects.toThrow('Runtime changed');
    expect(create).not.toHaveBeenCalled();
  });

  it('matches packages exactly, including scopes, without mistaking a local path or similarly named package', () => {
    expect(hasTourPlugin([entry('@eficy/opencode2-plugin@0.5.9')], '@eficy/opencode2-plugin')).toBe(true);
    expect(hasTourPlugin([entry('opencode-magpie-plugin-extra')], 'opencode-magpie-plugin')).toBe(false);
    expect(hasTourPlugin([{ ...entry('opencode-magpie-plugin'), parsedKind: 'path' }], 'opencode-magpie-plugin')).toBe(false);
  });
});
