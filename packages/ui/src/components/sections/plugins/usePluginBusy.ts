import { usePluginPackageUpdateState, usePluginReloadPending } from '@/queries/pluginMutations';
import type { PluginRuntimeTarget } from './pluginLoadState';
import { usePluginRuntimeStatus } from './usePluginRuntimeStatus';

export type PluginBusy = 'updating' | 'reloading' | null;

/**
 * What is happening to one plugin right now. An update of this plugin wins over
 * the page-wide reload, since it is the more specific thing to tell the reader.
 */
export function usePluginBusy(target: PluginRuntimeTarget | null, entryId?: string): PluginBusy {
  const reloading = usePluginReloadPending();
  const { status } = usePluginRuntimeStatus(target);
  const packageUpdate = usePluginPackageUpdateState(target?.kind === 'package' ? target.target : null, entryId);
  if (packageUpdate.kind === 'pending' || (status.kind === 'known' && status.update === 'updating')) return 'updating';
  return reloading ? 'reloading' : null;
}
