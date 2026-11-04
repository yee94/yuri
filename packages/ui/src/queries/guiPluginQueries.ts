import { CancelledError, queryOptions, type Query, type QueryClient } from '@tanstack/react-query';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

let activeBundles = 0;
const pendingBundles: Array<() => void> = [];

const acquireBundleSlot = (signal: AbortSignal): Promise<() => void> => new Promise((resolve, reject) => {
  const abort = () => {
    const index = pendingBundles.indexOf(start);
    if (index !== -1) pendingBundles.splice(index, 1);
    reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  };
  const start = () => {
    signal.removeEventListener('abort', abort);
    if (signal.aborted) { abort(); return; }
    activeBundles++;
    resolve(() => {
      activeBundles--;
      pendingBundles.shift()?.();
    });
  };
  if (signal.aborted) { abort(); return; }
  if (activeBundles < 2) start();
  else {
    pendingBundles.push(start);
    signal.addEventListener('abort', abort, { once: true });
  }
});

export const guiInventoryOptions = (transport: string, client?: OpenCodeClient) => queryOptions({
  queryKey: [transport, 'plugins', 'gui', null, 'inventory'],
  queryFn: async ({ signal }) => {
    const generation = getRuntimeGeneration();
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) {
        throw new DOMException('Plugin runtime ended', 'AbortError');
      }
    };
    assertCurrent();
    const api = client ?? (await import('@/lib/opencode/gui')).createGuiClient(signal);
    assertCurrent();
    const result = await api.plugin.list(undefined, { signal });
    assertCurrent();
    return result.data;
  },
  staleTime: 5_000,
  retry: 1,
});

export const guiBundleOptions = (transport: string, id: string, client?: OpenCodeClient) => queryOptions({
  queryKey: [transport, 'plugins', 'gui', null, 'bundle', id],
  queryFn: async ({ signal, client: cache, queryKey }) => {
    const identity = getRuntimeTransportIdentity();
    const generation = getRuntimeGeneration();
    const runtime = getRuntimeKey();
    const assertCurrent = () => {
      signal.throwIfAborted();
      if (identity !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration() || runtime !== getRuntimeKey()) {
        throw new DOMException('Plugin runtime ended', 'AbortError');
      }
    };
    const api = client ?? (await import('@/lib/opencode/gui')).createGuiClient(signal);
    assertCurrent();
    const release = await acquireBundleSlot(signal);
    try {
      assertCurrent();
      const result = await api.plugin.gui({ id }, { signal }).catch(async (error: unknown) => {
        if (!error || typeof error !== 'object' || !('_tag' in error) || error._tag !== 'PluginNotFoundError'
          || !('pluginID' in error) || error.pluginID !== id) throw error;
        const inventory = await cache.fetchQuery({ ...guiInventoryOptions(transport, client), staleTime: 0 });
        assertCurrent();
        if (inventory.some((plugin) => plugin.id === id && plugin.features.gui && plugin.state.status === 'active')) throw error;
        await cache.cancelQueries({ queryKey, exact: true });
        throw new CancelledError({ revert: true });
      });
      assertCurrent();
      return result.data;
    } finally { release(); }
  },
  staleTime: Infinity,
  retry: 1,
});

/** Called after inventory settles; removed owners cancel, surviving owners may refresh. */
export async function refreshGuiBundles(
  cache: Pick<QueryClient, 'getQueryState' | 'invalidateQueries' | 'cancelQueries' | 'refetchQueries'>,
  transport: string,
  changed: boolean,
  current: () => boolean,
): Promise<void> {
  if (!current()) return;
  type Inventory = Awaited<ReturnType<OpenCodeClient['plugin']['list']>>['data'];
  const inventory = cache.getQueryState<Inventory>(guiInventoryOptions(transport).queryKey);
  if (!inventory || inventory.status !== 'success' || inventory.isInvalidated || !inventory.data) return;
  const active = new Set(inventory.data.filter((plugin) => plugin.features.gui && plugin.state.status === 'active').map((plugin) => plugin.id));
  const bundle = (query: Query) => query.queryKey[0] === transport && query.queryKey[1] === 'plugins'
    && query.queryKey[2] === 'gui' && query.queryKey[4] === 'bundle';
  await cache.cancelQueries({ predicate: (query) => bundle(query) && !active.has(query.queryKey[5] as string) });
  if (!current()) return;
  await cache.invalidateQueries({ predicate: (query) => bundle(query) && (changed || query.state.data === undefined), refetchType: 'none' });
  if (!current()) return;
  await cache.refetchQueries({ predicate: (query) => bundle(query) && active.has(query.queryKey[5] as string)
    && (changed || query.state.data === undefined), type: 'active' }, { cancelRefetch: changed });
}
