import React from 'react';
import { usePluginRegistryQuery, usePluginRuntimeQuery, usePluginsQuery } from '@/queries/pluginQueries';
import { configEntryRuntimeTarget, findRuntimeMatches, resolveUpdateFlag } from './pluginLoadState';

/** A known update in either authoritative inventory is enough for the navigation dot. */
export function usePluginUpdates(): boolean {
  const plugins = usePluginsQuery();
  const entries = plugins.data?.entries;
  const specs = React.useMemo(() => entries?.map((entry) => entry.spec) ?? [], [entries]);
  const registry = usePluginRegistryQuery(specs);
  const runtime = usePluginRuntimeQuery();

  return (entries ?? []).some((entry) => {
    const info = registry.data?.[entry.spec];
    if (info?.kind === 'npm-ok' && info.hasUpdate) return true;
    const target = configEntryRuntimeTarget(entry.spec, entry.sourcePath);
    return target?.kind === 'package' && runtime.data !== undefined
      && resolveUpdateFlag(findRuntimeMatches(target, runtime.data)) === 'available';
  });
}
