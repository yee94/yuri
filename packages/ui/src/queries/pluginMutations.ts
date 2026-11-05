import React from 'react';
import { useMutation, useMutationState, useQueryClient } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import {
  pluginOperationErrorMessage,
  updatePluginPackage,
} from '@/lib/opencode/plugins';
import { reloadOpenCodeLocations } from '@/stores/useAgentsStore';
import { usePluginsStore, type PluginEntry } from '@/stores/usePluginsStore';
import {
  refreshPluginRuntimeQuery,
  usePluginConfigDirectory,
  resolveConfigQueryDirectory,
  pluginsListQueryOptions,
  type PluginsList,
} from './pluginQueries';

const PACKAGE_UPDATE_KEY = ['plugins', 'package-update'] as const;

const reloadMutationKey = (directory: string | null) => [getRuntimeTransportIdentity(), 'plugins', 'reload', directory ?? ''] as const;

export type PluginOperationState =
  | { kind: 'idle' }
  | { kind: 'pending'; entry?: PackageUpdateVariables['entry'] }
  | { kind: 'error'; error: string; entry?: PackageUpdateVariables['entry'] };

type PackageUpdateVariables = {
  target: string;
  name: string;
  directory: string | null;
  transport: string;
  entry?: { id: string; spec: string; original?: PluginEntry };
};

const sameUpdate = (variables: PackageUpdateVariables | undefined, directory: string | null, target: string | null, transport: string, entryId?: string) =>
  Boolean(variables && variables.directory === directory && variables.transport === transport
    && (variables.target === target || variables.entry?.spec === target || (entryId && variables.entry?.id === entryId)));

/** Latest state of one in-place package update, shared by every component that shows it. */
export function usePluginPackageUpdateState(target: string | null, entryId?: string): PluginOperationState {
  const directory = usePluginConfigDirectory();
  const transport = getRuntimeTransportIdentity();
  const states = useMutationState({
    filters: { mutationKey: PACKAGE_UPDATE_KEY },
    select: (mutation) => ({
      variables: mutation.state.variables as PackageUpdateVariables | undefined,
      status: mutation.state.status,
      error: mutation.state.error,
      submittedAt: mutation.state.submittedAt,
    }),
  });
  if (!target && !entryId) return { kind: 'idle' };
  const latest = states
    .filter((item) => sameUpdate(item.variables, directory, target, transport, entryId))
    .reduce<(typeof states)[number] | null>((best, item) => (!best || item.submittedAt >= best.submittedAt ? item : best), null);
  if (!latest) return { kind: 'idle' };
  if (latest.status === 'pending') return { kind: 'pending', entry: latest.variables?.entry };
  if (latest.status === 'error') return { kind: 'error', error: pluginOperationErrorMessage(latest.error), entry: latest.variables?.entry };
  return { kind: 'idle' };
}

/** Targets with an update in flight, for list rows that must not offer a second one. */
export function usePendingPluginUpdateTargets(): ReadonlySet<string> {
  const directory = usePluginConfigDirectory();
  const transport = getRuntimeTransportIdentity();
  const pending = useMutationState({
    filters: { mutationKey: PACKAGE_UPDATE_KEY, status: 'pending' },
    select: (mutation) => mutation.state.variables as PackageUpdateVariables | undefined,
  });
  return React.useMemo(() => {
    const targets = new Set<string>();
    for (const variables of pending) {
      if (variables && variables.directory === directory && variables.transport === transport) {
        targets.add(variables.target);
        if (variables.entry) targets.add(variables.entry.spec);
      }
    }
    return targets;
  }, [directory, pending, transport]);
}

/**
 * Reinstalls an unpinned target, or rewrites an explicitly selected config
 * entry to a newer release. Both paths share per-target pending/error state.
 */
export function useUpdatePluginPackage() {
  const { t } = useI18n();
  const client = useQueryClient();
  const directory = usePluginConfigDirectory();
  const mutation = useMutation<void, Error, PackageUpdateVariables>({
    mutationKey: PACKAGE_UPDATE_KEY,
    mutationFn: async ({ target, directory: dir, transport, entry }) => {
      if (getRuntimeTransportIdentity() !== transport) throw new Error('Plugin runtime changed');
      if (entry) {
        if (resolveConfigQueryDirectory() !== dir) throw new Error('Plugin directory changed');
        const result = await usePluginsStore.getState().updateEntry(entry.id, { spec: entry.spec });
        if (!result.ok || result.reloadFailed) {
          throw new Error(result.warning || result.message || 'Plugin update failed');
        }
      } else {
        await updatePluginPackage(dir, target);
      }
      await refreshPluginRuntimeQuery(client, dir, transport).catch(() => undefined);
    },
    onSuccess: (_data, { name, directory: dir, transport }) => {
      if (getRuntimeTransportIdentity() !== transport) return;
      toast.success(t('settings.plugins.update.toast.done', { name }));
      void client.invalidateQueries({ queryKey: [transport, 'plugins', 'registry', dir] });
    },
    onError: (_error, { name, transport }) => {
      if (getRuntimeTransportIdentity() !== transport) return;
      toast.error(t('settings.plugins.update.toast.failed', { name }));
    },
  });
  return useEvent((target: string, name: string, entry?: PackageUpdateVariables['entry']) => {
    const transport = getRuntimeTransportIdentity();
    const pending = client.getMutationCache().findAll({ mutationKey: PACKAGE_UPDATE_KEY, status: 'pending' });
    if (pending.some((item) => sameUpdate(item.state.variables as PackageUpdateVariables | undefined, directory, target, transport, entry?.id))) return;
    const original = entry ? client.getQueryData<PluginsList>(pluginsListQueryOptions(directory, transport).queryKey)?.entries.find((item) => item.id === entry.id) : undefined;
    return mutation.mutateAsync({ target, name, directory, transport, entry: entry ? { ...entry, original } : undefined }).catch(() => undefined);
  });
}

/** Reloads OpenCode in place, then re-reads which plugins loaded. */
export function useReloadPlugins() {
  const { t } = useI18n();
  const client = useQueryClient();
  const directory = usePluginConfigDirectory();
  return useMutation<void, Error, void>({
    mutationKey: reloadMutationKey(directory),
    mutationFn: async () => {
      const transport = getRuntimeTransportIdentity();
      await reloadOpenCodeLocations();
      await refreshPluginRuntimeQuery(client, directory, transport);
    },
    onSuccess: () => {
      toast.success(t('settings.plugins.page.toast.reloaded'));
    },
    onError: (error) => {
      toast.error(error.message || t('settings.plugins.toast.reloadFailed'));
    },
  });
}

/** True while any component's whole-OpenCode reload is in flight, so every plugin row can show it. */
export function usePluginReloadPending(): boolean {
  const directory = usePluginConfigDirectory();
  return useMutationState({
    filters: { mutationKey: reloadMutationKey(directory), status: 'pending' },
    select: () => true,
  }).length > 0;
}
