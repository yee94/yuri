import { queryOptions } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import type { ProviderSources } from '../../../../../web/server/lib/opencode/provider-sources';

export const providerSourceQueryOptions = (directory = opencodeClient.getDirectory()) => queryOptions({
  queryKey: [getRuntimeTransportIdentity(), getRuntimeGeneration(), 'provider-sources', directory ?? null],
  queryFn: async ({ signal }) => {
    const response = await runtimeFetch('/api/config/providers/sources', { signal, query: directory ? { directory } : undefined });
    if (!response.ok) throw new Error('Unable to read provider sources');
    return await response.json() as Record<string, ProviderSources>;
  },
  staleTime: 30_000,
});
