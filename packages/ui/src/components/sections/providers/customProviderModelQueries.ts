import { queryOptions } from '@tanstack/react-query';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import type { DiscoveredProviderModel } from '../../../../../web/server/lib/opencode/custom-provider-models';

export const customProviderModelQueryOptions = (input: {
  draftId: string; revision: number; directory: string | undefined;
  package: string; baseURL: string; apiKey: string;
}) => queryOptions({
  // Keys and retained data never contain the draft credential. Zero GC releases the request closure on exit.
  queryKey: [getRuntimeTransportIdentity(), getRuntimeGeneration(), 'custom-provider-models', input.directory ?? null, input.draftId, input.revision, input.package, input.baseURL],
  gcTime: 0,
  retry: false,
  refetchOnWindowFocus: false,
  queryFn: async ({ signal }): Promise<DiscoveredProviderModel[]> => {
    const response = await runtimeFetch('/api/config/providers/custom/models', {
      method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ package: input.package, baseURL: input.baseURL, apiKey: input.apiKey }),
    });
    if (!response.ok) throw new Error('Provider model discovery failed');
    const payload = await response.json() as { models?: DiscoveredProviderModel[] };
    if (!Array.isArray(payload.models) || payload.models.some((model) => typeof model?.id !== 'string' || typeof model?.name !== 'string')) {
      throw new Error('Invalid provider model listing');
    }
    return payload.models;
  },
});
