import type { GuiPluginsContextValue } from '@/lib/gui-plugins/react';
import { configEntryRuntimeTarget, type PluginRuntimeTarget } from './pluginLoadState';

/** GUI IDs need not resemble their npm package; match the server's source instead. */
export function findPluginGuiMatches(target: PluginRuntimeTarget | null, inventory: GuiPluginsContextValue['inventory']) {
  if (!target) return [];
  return inventory.filter(({ source }) => {
    if (target.kind === 'package') return source?.type === 'package' && source.target === target.target;
    if (source?.type !== 'local') return false;
    const local = configEntryRuntimeTarget(source.path, undefined);
    return local?.kind === 'local' && (local.path === target.path || local.path.startsWith(`${target.path}/`));
  });
}
