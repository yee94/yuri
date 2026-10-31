import React from 'react';
import { usePluginRuntimeQuery, usePluginsQuery } from '@/queries/pluginQueries';
import {
  configEntryRuntimeTarget,
  findRuntimeMatches,
  pluginFileRuntimeTarget,
  resolveLoadState,
} from './pluginLoadState';

export interface PluginIssue {
  /** Settings row id, so the plugins page can focus the plugin. */
  id: string;
  label: string;
  error: string;
}

/**
 * Plugins OpenCode reports as failed to load, joined to the Settings rows that
 * declare them. Unknown or still-loading runtime status yields no issues: a
 * failed read is not evidence of a failed plugin.
 */
export function usePluginIssues(): PluginIssue[] {
  const pluginsQuery = usePluginsQuery();
  const runtimeQuery = usePluginRuntimeQuery();
  const entries = pluginsQuery.data?.entries;
  const files = pluginsQuery.data?.files;
  const inventory = runtimeQuery.data;

  return React.useMemo(() => {
    if (!inventory) return [];
    const issues: PluginIssue[] = [];
    const check = (id: string, label: string, target: ReturnType<typeof configEntryRuntimeTarget>) => {
      if (!target) return;
      const load = resolveLoadState(findRuntimeMatches(target, inventory));
      if (load.kind === 'failed') issues.push({ id, label, error: load.error });
    };
    for (const entry of entries ?? []) check(entry.id, entry.spec, configEntryRuntimeTarget(entry.spec, entry.sourcePath));
    for (const file of files ?? []) check(file.id, file.fileName, pluginFileRuntimeTarget(file.absolutePath));
    return issues;
  }, [entries, files, inventory]);
}
