import type { Row } from './model';
import { readSettingsCollection, type SettingsRequest, type SettingsRequestLane } from './settings-protocol';
import { findRuntimeMatches, nativePluginRewrite, nativePluginTarget, readNativePluginInventory, readNativePluginRegistry, resolveUpdateFlag, updateNativePlugin, type PluginRuntimeInfo } from './settings-plugin-runtime-core';
import { collectionValuesEqual } from './settings-collection-value';

export type CollectionPluginResult = { id: string; state: 'updated' | 'unknown' | 'failed'; message?: string };
type Receipt = { item: Row; target: string; spec: string | null; version?: string; before: string[] };
const knownSource = (item: Row) => typeof item.sourcePath === 'string' && !!item.sourcePath && (item.scope === 'user' || item.scope === 'project');
/** Per-entry receipts survive a partial batch; an uncertain update is never replayed. */
export function createCollectionPluginUpdates(send: SettingsRequest, current: () => boolean, directory?: string) {
  const results = new Map<string, CollectionPluginResult>();
  const fingerprints = new Map<string, string>();
  const receipts = new Map<string, Receipt>();
  let busy = false;
  const valid = (lane: SettingsRequestLane) => current() && lane.current();
  async function reconcile(lane: SettingsRequestLane = { request: send, current }) {
    if (busy || !valid(lane)) return;
    busy = true;
    try {
      let entries: Promise<Row[]> | undefined, inventory: Promise<PluginRuntimeInfo[]> | undefined;
      for (const [id, receipt] of receipts) {
        if (!valid(lane)) return;
        if (results.get(id)?.state !== 'unknown') continue;
        try {
          let confirmed = false;
          if (receipt.spec) {
            entries ??= readSettingsCollection(lane.request, 'plugins', directory);
            const rows = await entries;
            if (!knownSource(receipt.item)) continue;
            const sameSource = (row: Row) => row.sourcePath === receipt.item.sourcePath && row.scope === receipt.item.scope && !row.file;
            const candidates = rows.filter(row => sameSource(row) && row.spec === receipt.spec && collectionValuesEqual(row.options || {}, receipt.item.options || {}));
            confirmed = candidates.length === 1 && typeof candidates[0].id === 'string' && !rows.some(row => sameSource(row) && row.spec === receipt.target);
          } else {
            if (typeof receipt.item.id !== 'string' || !receipt.item.id.trim() || !knownSource(receipt.item)) continue;
            entries ??= readSettingsCollection(lane.request, 'plugins', directory);
            const rows = await entries;
            if (!rows.some(row => row.id === receipt.item.id && row.spec === receipt.target && row.sourcePath === receipt.item.sourcePath && row.scope === receipt.item.scope && !row.file && collectionValuesEqual(row.options || {}, receipt.item.options || {}))) continue;
            inventory ??= readNativePluginInventory(lane.request, directory);
            const target = nativePluginTarget(receipt.item);
            const matches = target ? findRuntimeMatches(target, await inventory) : [];
            const packages = matches.filter(item => item.source.kind === 'package');
            confirmed = packages.length > 0 && packages.every(item => item.source.kind === 'package' && item.source.target === receipt.target && !item.source.updating && !item.source.outdated && typeof item.source.version === 'string' && (receipt.version ? item.source.version === receipt.version : receipt.before.length > 0 && !receipt.before.includes(item.source.version)));
          }
          if (!valid(lane)) return;
          if (confirmed) { results.set(id, { id, state: 'updated' }); receipts.delete(id); }
        } catch (error) {
          if (!valid(lane)) return;
          results.set(id, { id, state: 'unknown', message: error instanceof Error ? error.message : 'Plugin verification failed' });
        }
      }
    } finally { busy = false; }
  }
  return {
    results: () => [...results.values()],
    reconcile,
    async update(items: readonly Row[], lane: SettingsRequestLane = { request: send, current }) {
      if (busy || !current()) return;
      busy = true;
      try {
        const updatedRuntimeTargets = new Set<string>();
        for (const item of items) {
          if (!current() || !lane.current()) return;
          const id = String(item.id || item.spec || ''), target = nativePluginTarget(item);
          if (!id || target?.kind !== 'package' || results.get(id)?.state === 'unknown') continue;
          if ([...receipts.values()].some(receipt => receipt.spec ? (!knownSource(receipt.item) || receipt.item.sourcePath === item.sourcePath && receipt.item.scope === item.scope) && (receipt.target === target.target || receipt.spec === target.target) : receipt.target === target.target)) continue;
          let attempted = false;
          try {
            const registry = await readNativePluginRegistry(lane.request, target.target, directory);
            if (!current() || !lane.current()) return;
            const fingerprint = JSON.stringify([target.target, registry?.latestVersion]);
            if (results.get(id)?.state === 'updated' && fingerprints.get(id) === fingerprint) continue;
            fingerprints.set(id, fingerprint);
            const spec = nativePluginRewrite(registry);
            if (!spec && updatedRuntimeTargets.has(target.target)) continue;
            let before: string[] = [];
            if (!spec) {
              try {
                const matches = findRuntimeMatches(target, await readNativePluginInventory(lane.request, directory));
                if (resolveUpdateFlag(matches) !== 'available') continue;
                before = matches.flatMap(item => item.source.kind === 'package' && typeof item.source.version === 'string' ? [item.source.version] : []);
              }
              catch { /* The explicit update remains available; missing version authority cannot confirm its later receipt. */ }
              if (!valid(lane)) return;
            }
            receipts.set(id, { item: { id: item.id, spec: item.spec, scope: item.scope, sourcePath: item.sourcePath, options: JSON.parse(JSON.stringify(item.options || {})) }, target: target.target, spec, version: typeof registry?.latestVersion === 'string' ? registry.latestVersion : undefined, before });
            attempted = true; results.set(id, { id, state: 'unknown' });
            const result = await updateNativePlugin(lane.request, target, String(item.id || ''), registry, directory, () => current() && lane.current());
            if (current() && lane.current()) { results.set(id, { id, state: 'updated', message: result.warning }); receipts.delete(id); if (!spec) updatedRuntimeTargets.add(target.target); }
          } catch (error) {
            if (!current()) return;
            results.set(id, { id, state: attempted ? 'unknown' : 'failed', message: error instanceof Error ? error.message : 'Plugin update failed' });
          }
        }
      } finally { busy = false; }
    },
  };
}
