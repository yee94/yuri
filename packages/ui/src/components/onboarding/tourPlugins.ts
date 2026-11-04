import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { listPluginRuntime, type PluginRuntimeInfo } from '@/lib/opencode/plugins';
import { pluginsListQueryOptions, pluginRuntimeQueryOptions } from '@/queries/pluginQueries';
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

type InstallDependencies = {
  list: () => Promise<PluginEntry[]>;
  create: (spec: string) => Promise<{ ok: boolean }>;
  active: (specs: readonly string[]) => Promise<string[]>;
  current: () => boolean;
};

/** Writes are idempotent across partial batches; activation remains a separate read. */
export async function installTourPlugins(specs: readonly string[], dependencies: InstallDependencies) {
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
  const applied = specs.filter((spec) => !failed.includes(spec));
  const active = applied.length ? await dependencies.active(applied) : [];
  if (!dependencies.current()) throw new Error('Runtime changed');
  return { failed, pending: specs.filter((spec) => !failed.includes(spec) && !active.includes(spec)) };
}

export function installRecommendedPlugins(specs: readonly string[], directory: string | null, signal: AbortSignal) {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const current = () => !signal.aborted && generation === getRuntimeGeneration() && transport === getRuntimeTransportIdentity();
  return installTourPlugins(specs, {
    current,
    list: async () => (await queryClient.fetchQuery({ ...pluginsListQueryOptions(directory, transport), staleTime: 0 })).entries,
    create: (spec) => usePluginsStore.getState().createEntry({ spec, scope: 'user' }),
    active: async (applied) => {
      let inventory: PluginRuntimeInfo[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        if (!current()) throw new Error('Runtime changed');
        inventory = await listPluginRuntime(directory, signal);
        if (!current()) throw new Error('Runtime changed');
        queryClient.setQueryData(pluginRuntimeQueryOptions(directory, transport).queryKey, inventory);
        const settled = applied.every((spec) => inventory.some((plugin) => plugin.source.kind === 'package'
          && splitPluginSpec(plugin.source.target).name === spec));
        if (settled || attempt === 19) break;
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(new Error('Runtime changed')); };
          const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 750);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        });
      }
      return inventory.flatMap((plugin) => plugin.source.kind === 'package' && plugin.state.kind === 'active'
        ? [splitPluginSpec(plugin.source.target).name] : []);
    },
  });
}
