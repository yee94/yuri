import { useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import type { ChatInputModelFavorites } from '@/components/chat/chatInputSurface';
import { reorderModelFavorite, toggleModelFavorite, type ModelFavorite } from '@/lib/model-favorites';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { readRemoteResponse } from './remoteProjectQueries';

const MAX_FAVORITES = 64;
const NO_FAVORITES: readonly ModelFavorite[] = Object.freeze([]);

const parseFavorites = (payload: unknown): ModelFavorite[] => {
  const value = payload && typeof payload === 'object' ? (payload as { favoriteModels?: unknown }).favoriteModels : undefined;
  if (!Array.isArray(value)) throw new Error('Invalid remote favorite models');
  return value.flatMap((item): ModelFavorite[] => {
    if (!item || typeof item !== 'object') return [];
    const { providerID, modelID, variant } = item as Record<string, unknown>;
    if (typeof providerID !== 'string' || typeof modelID !== 'string') return [];
    return [typeof variant === 'string' ? { providerID, modelID, variant } : { providerID, modelID }];
  });
};

export const remoteModelFavoritesQueryOptions = (registry: HostRuntimeRegistry, hostId: string) => ({
  queryKey: [getRuntimeTransportIdentity(), 'remote-projects', 'model-favorites', registry.hubId, hostId] as const,
  staleTime: 30_000,
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ModelFavorite[]> => {
    const favorites = parseFavorites(await readRemoteResponse(await registry.requestHost(hostId, 'model-favorites', { signal })));
    registry.assertCurrent();
    return favorites;
  },
});

/**
 * Favorites that live in the target machine's own settings. Edits apply optimistically and are
 * written in order; a failed write reloads the machine's list instead of keeping a guess.
 */
export const useRemoteModelFavorites = (
  registry: HostRuntimeRegistry,
  hostId: string,
  enabled: boolean,
  onError: (error: unknown) => void,
): ChatInputModelFavorites => {
  const client = useQueryClient();
  const options = remoteModelFavoritesQueryOptions(registry, hostId);
  const query = useQuery({ ...options, enabled });
  const writes = useRef<Promise<void>>(Promise.resolve());

  const edit = useEvent((compute: (current: readonly ModelFavorite[]) => readonly ModelFavorite[]) => {
    const { queryKey } = remoteModelFavoritesQueryOptions(registry, hostId);
    const current = client.getQueryData<ModelFavorite[]>(queryKey);
    if (!current) {
      onError(new Error('Remote favorite models are not loaded yet'));
      return;
    }
    const computed = compute(current);
    if (computed === current) return;
    const next = computed.slice(0, MAX_FAVORITES);
    client.setQueryData(queryKey, next);
    writes.current = writes.current.then(async () => {
      try {
        parseFavorites(await readRemoteResponse(await registry.requestHost(hostId, 'model-favorites', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ favoriteModels: next }),
        })));
        registry.assertCurrent();
      } catch (error) {
        void client.invalidateQueries({ queryKey, exact: true });
        onError(error);
      }
    });
  });
  const toggle = useEvent((providerID: string, modelID: string, variant?: string) => {
    edit((current) => toggleModelFavorite(current, providerID, modelID, variant));
  });
  const reorder = useEvent((activeProviderID: string, activeModelID: string, overProviderID: string, overModelID: string) => {
    edit((current) => reorderModelFavorite(current, activeProviderID, activeModelID, overProviderID, overModelID));
  });

  const models = query.data ?? NO_FAVORITES;
  return useMemo(() => ({ models, toggle, reorder }), [models, toggle, reorder]);
};
