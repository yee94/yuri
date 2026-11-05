import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasTourPlugin, saveRecommendedPlugins, saveTourPlugins, tourPlugins } from './tourPlugins';
import { listPluginRuntime } from '@/lib/opencode/plugins';
import { queryClient } from '@/lib/queryRuntime';
import type { PluginEntry } from '@/stores/usePluginsStore';

const fixture = vi.hoisted(() => ({ create: vi.fn(async () => ({ ok: true })) }));
vi.mock('@/stores/usePluginsStore', () => ({ usePluginsStore: { getState: () => ({ createEntry: fixture.create }) } }));
vi.mock('@/queries/pluginQueries', () => ({ pluginsListQueryOptions: () => ({}) }));
vi.mock('@/lib/opencode/plugins', () => ({ listPluginRuntime: vi.fn() }));
vi.mock('@/lib/queryRuntime', () => ({ queryClient: { fetchQuery: vi.fn(async () => ({ entries: [] })) } }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeGeneration: () => 1, getRuntimeTransportIdentity: () => 'test-host' }));

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

it('only saves user-scope config, without native activation reads or timers', async () => {
  vi.useFakeTimers();
  expect(await saveRecommendedPlugins(['one'], '/workspace', new AbortController().signal)).toEqual({ failed: [] });
  expect(fixture.create).toHaveBeenCalledWith({ spec: 'one', scope: 'user' });
  expect(listPluginRuntime).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not write if the tour closes while its config snapshot is loading', async () => {
  let release!: (value: { entries: PluginEntry[] }) => void;
  vi.mocked(queryClient.fetchQuery).mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  const controller = new AbortController();
  const result = saveRecommendedPlugins(['one'], '/workspace', controller.signal);
  const rejected = expect(result).rejects.toThrow('Runtime changed');
  controller.abort();
  release({ entries: [] });
  await rejected;
  expect(fixture.create).not.toHaveBeenCalled();
  expect(listPluginRuntime).not.toHaveBeenCalled();
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
      current: () => true,
    };
    expect(await saveTourPlugins(specs, deps)).toEqual({ failed: [specs[2]] });
    expect(await saveTourPlugins(specs, deps)).toEqual({ failed: [] });
    expect(create.mock.calls.map(([spec]) => spec)).toEqual([specs[1], specs[2], specs[2]]);
    expect(existing[0].options).toEqual({ gateway: 'existing' });
    expect(existing).toHaveLength(3);
  });

  it('does not treat a failed inventory read as an empty configuration to overwrite', async () => {
    const create = vi.fn();
    const result = await saveTourPlugins(['one'], {
      list: async () => { throw new Error('offline'); }, create, current: () => true,
    });
    expect(result).toEqual({ failed: ['one'] });
    expect(create).not.toHaveBeenCalled();
  });

  it('stops before a write if the runtime changed during its inventory read', async () => {
    let current = true;
    const create = vi.fn();
    await expect(saveTourPlugins(['one', 'two'], {
      list: async () => { current = false; return []; }, create, current: () => current,
    })).rejects.toThrow('Runtime changed');
    expect(create).not.toHaveBeenCalled();
  });

  it('matches packages exactly, including scopes, without mistaking a local path or similarly named package', () => {
    expect(hasTourPlugin([entry('@eficy/opencode2-plugin@0.5.9')], '@eficy/opencode2-plugin')).toBe(true);
    expect(hasTourPlugin([entry('opencode-magpie-plugin-extra')], 'opencode-magpie-plugin')).toBe(false);
    expect(hasTourPlugin([{ ...entry('opencode-magpie-plugin'), parsedKind: 'path' }], 'opencode-magpie-plugin')).toBe(false);
  });
});
