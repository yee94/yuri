import type { PluginRuntimeInfo } from '../ui/src/lib/opencode/plugin-runtime-types';
import { configEntryRuntimeTarget, pluginFileRuntimeTarget, type PluginRuntimeTarget } from '../ui/src/components/sections/plugins/pluginLoadState';
import type { Row } from './model';
import { scopedSettingsPath, settingsObject, settingsRows, type SettingsRequest } from './settings-protocol';

export { findRuntimeMatches, resolveEffectivePluginVersion, resolveLoadState, resolveUpdateFlag } from '../ui/src/components/sections/plugins/pluginLoadState';
export type { PluginRuntimeInfo };
const nativePluginLocation = (path: string, directory?: string) => directory?.trim() ? `${path}?location%5Bdirectory%5D=${encodeURIComponent(directory.trim())}` : path;
export function nativePluginTarget(item: Row): PluginRuntimeTarget | null {
  return item.file ? pluginFileRuntimeTarget(typeof item.absolutePath === 'string' ? item.absolutePath : undefined) : configEntryRuntimeTarget(String(item.spec || ''), typeof item.sourcePath === 'string' ? item.sourcePath : undefined);
}

/** Validate the installed generated client's PluginInfo shape, then use Web's pure matching. */
export function nativePluginInventory(payload: unknown): PluginRuntimeInfo[] {
  return settingsRows(settingsObject(payload).data).map(item => {
    const source = settingsObject(item.source), state = settingsObject(item.state);
    let mapped: PluginRuntimeInfo['source'];
    if (source.type === 'package' && typeof source.target === 'string' && (source.version == null || typeof source.version === 'string')) mapped = { kind: 'package', target: source.target, version: source.version as string | null ?? null, outdated: source.outdated === true, updating: source.updating === true };
    else if (source.type === 'local' && typeof source.path === 'string') mapped = { kind: 'local', path: source.path };
    else if (source.type === 'builtin' || source.type === 'sdk') mapped = { kind: 'builtin' };
    else throw new Error('Invalid plugin source');
    if (state.status === 'active') return { source: mapped, state: { kind: 'active' } };
    if (state.status === 'failed' && typeof state.error === 'string' && (state.ref == null || typeof state.ref === 'string')) return { source: mapped, state: { kind: 'failed', error: state.error, ref: state.ref as string | null ?? null } };
    throw new Error('Invalid plugin state');
  });
}

export async function readNativePluginInventory(send: SettingsRequest, directory?: string, check = false) {
  return nativePluginInventory(await send(nativePluginLocation(check ? '/api/plugin/check' : '/api/plugin', directory), check ? 'POST' : 'GET', check ? {} : undefined));
}
export async function reloadNativePlugins(send: SettingsRequest, current: () => boolean) {
  if (!current()) throw new Error('Runtime changed');
  const result = await send('/api/location/reload', 'POST');
  if (!current()) throw new Error('Runtime changed');
  if (result != null && result !== true) settingsObject(result);
}
export async function readNativePluginRegistry(send: SettingsRequest, spec: string, directory?: string): Promise<Row | null> {
  const payload = settingsObject(await send(scopedSettingsPath(`/api/config/plugins/registry?specs=${encodeURIComponent(spec)}`, directory)));
  return settingsRows(payload.results).find(item => item.spec === spec) || null;
}
export function nativePluginRewrite(registry: Row | null): string | null {
  return registry?.kind === 'npm-ok' && registry.hasUpdate === true && typeof registry.name === 'string' && typeof registry.latestVersion === 'string' && registry.latestVersion ? `${registry.name}@${registry.latestVersion}` : null;
}
/** A registry-selected new version rewrites only spec; mutable targets use plugin.update. */
export async function updateNativePlugin(send: SettingsRequest, target: PluginRuntimeTarget, entryID: string, registry: Row | null, directory: string | undefined, current: () => boolean): Promise<{ warning?: string }> {
  if (!current() || target.kind !== 'package' || !target.target.trim()) throw new Error('Plugin package target required');
  const spec = registry?.spec === target.target ? nativePluginRewrite(registry) : null;
  const result = spec && entryID
    ? await send(scopedSettingsPath(`/api/config/plugins/entry/${encodeURIComponent(entryID)}`, directory), 'PATCH', { spec })
    : await send(nativePluginLocation('/api/plugin/update', directory), 'POST', { targets: [target.target] });
  if (!current()) throw new Error('Runtime changed');
  if (result != null && result !== true) {
    const body = settingsObject(result);
    if (body.reloadFailed) return { warning: String(body.warning || body.message || 'Plugin reload failed after update') };
  }
  return {};
}
