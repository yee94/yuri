import { queryOptions } from '@tanstack/react-query';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';

export type QuotaCredentialProvider = 'opencode-go' | 'ollama-cloud' | 'cursor';
export type QuotaCredentialStatus = { configured: boolean; workspaceId?: string };

export function projectQuotaCredentialStatus(value: unknown): QuotaCredentialStatus {
  if (!value || typeof value !== 'object' || !('configured' in value) || typeof value.configured !== 'boolean') {
    throw new Error('Invalid credential status');
  }
  return { configured: value.configured,
    ...('workspaceId' in value && typeof value.workspaceId === 'string' ? { workspaceId: value.workspaceId } : {}) };
}

export const quotaCredentialQueryOptions = (providerId: QuotaCredentialProvider) => queryOptions({
  queryKey: [getRuntimeTransportIdentity(), getRuntimeGeneration(), 'quota-credentials', providerId],
  queryFn: async ({ signal }) => {
    const response = await runtimeFetch(`/api/quota/credentials/${providerId}`, { signal });
    if (!response.ok) throw new Error('Unable to read credential status');
    return projectQuotaCredentialStatus(await response.json());
  },
  staleTime: 30_000,
});
