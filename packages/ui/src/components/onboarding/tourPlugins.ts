import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { pluginsListQueryOptions } from '@/queries/pluginQueries';
import { usePluginsStore, type PluginEntry } from '@/stores/usePluginsStore';
import { splitPluginSpec } from '@/components/sections/plugins/pluginPresentation';

export const tourPlugins = [
  { name: 'Magpie', spec: 'opencode-magpie-plugin' },
  { name: 'Eficy', spec: '@eficy/opencode2-plugin' },
  { name: 'yee-profile', spec: '@yee94/opencode-profile' },
] as const;

export function hasTourPlugin(entries: readonly PluginEntry[], spec: string): boolean {
  return entries.some((entry) => entry.parsedKind === 'npm' && splitPluginSpec(entry.spec).name === spec);
}

type SaveDependencies = {
  list: () => Promise<PluginEntry[]>;
  create: (spec: string) => Promise<{ ok: boolean }>;
  current: () => boolean;
};

/** Configuration writes are idempotent across partial batches; OpenCode owns activation. */
export async function saveTourPlugins(specs: readonly string[], dependencies: SaveDependencies) {
  const failed: string[] = [];
  for (const spec of new Set(specs)) {
    if (!dependencies.current()) throw new Error('Runtime changed');
    try {
      const entries = await dependencies.list();
      if (!dependencies.current()) throw new Error('Runtime changed');
      if (!hasTourPlugin(entries, spec)) {
        const result = await dependencies.create(spec);
        if (!result.ok) failed.push(spec);
      }
    } catch {
      failed.push(spec);
    }
  }
  if (!dependencies.current()) throw new Error('Runtime changed');
  return { failed };
}

export function saveRecommendedPlugins(specs: readonly string[], directory: string | null, signal: AbortSignal) {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const current = () => !signal.aborted && generation === getRuntimeGeneration() && transport === getRuntimeTransportIdentity();
  return saveTourPlugins(specs, {
    current,
    list: async () => (await queryClient.fetchQuery({ ...pluginsListQueryOptions(directory, transport), staleTime: 0 })).entries,
    create: (spec) => usePluginsStore.getState().createEntry({ spec, scope: 'user' }),
  });
}
