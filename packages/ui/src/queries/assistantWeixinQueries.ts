import { useMutation, useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useI18nStore } from '@/lib/i18n/store';

const statuses = ['disconnected', 'waiting', 'scanned', 'verify', 'connected', 'reconnecting', 'expired', 'error', 'unsupported'] as const;
export type AssistantWeixinStatus = {
  status: typeof statuses[number];
  error: string | null;
  qrCode?: string | null;
  expiresAt?: number;
  transferSources?: { assistantID: string; name: string; revision: string }[];
};
type Action = { type: 'login' | 'disconnect' | 'retry' } | { type: 'verify'; code: string }
  | { type: 'transfer'; sourceAssistantID: string; revision: string };

export function parseAssistantWeixinStatus(value: unknown): AssistantWeixinStatus {
  if (!value || typeof value !== 'object' || !('status' in value)
    || !statuses.some((status) => status === value.status)) throw new Error('invalid_response');
  const data = value as Record<string, unknown>;
  let transferSources: AssistantWeixinStatus['transferSources'];
  if (data.transferSources !== undefined) {
    if (!Array.isArray(data.transferSources) || data.transferSources.length > 100) throw new Error('invalid_response');
    transferSources = data.transferSources.map((source: unknown) => {
      if (!source || typeof source !== 'object' || !('assistantID' in source) || !('name' in source) || !('revision' in source)
        || typeof source.assistantID !== 'string' || !source.assistantID || typeof source.name !== 'string'
        || typeof source.revision !== 'string' || !source.revision) throw new Error('invalid_response');
      return { assistantID: source.assistantID, name: source.name, revision: source.revision };
    });
  }
  return {
    status: data.status as AssistantWeixinStatus['status'],
    error: typeof data.error === 'string' ? data.error : null,
    ...(typeof data.qrCode === 'string' && data.qrCode.length <= 8192 ? { qrCode: data.qrCode } : {}),
    ...(typeof data.expiresAt === 'number' ? { expiresAt: data.expiresAt } : {}),
    ...(transferSources ? { transferSources } : {}),
  };
}
const key = (assistantID: string, transport = getRuntimeTransportIdentity()) => [transport, 'assistants', 'weixin', assistantID] as const;
const request = async (assistantID: string, suffix = '', init: RequestInit = {}): Promise<AssistantWeixinStatus> => {
  const response = await runtimeFetch(`/api/yuri/assistants/${encodeURIComponent(assistantID)}/weixin${suffix}`, init);
  if (response.status === 501 || (response.status === 404 && !suffix)) return { status: 'unsupported', error: null };
  const body: unknown = await response.json();
  if (!response.ok) {
    const code = body && typeof body === 'object' && 'error' in body && typeof body.error === 'string' ? body.error : 'channel_error';
    throw new Error(code);
  }
  return parseAssistantWeixinStatus(body);
};
export const assistantWeixinQueryOptions = (assistantID: string, transport = getRuntimeTransportIdentity()) => ({
  queryKey: key(assistantID, transport),
  queryFn: ({ signal }: { signal: AbortSignal }) => request(assistantID, '', { signal }),
  staleTime: 0,
  gcTime: 0,
  retry: 1,
  refetchOnWindowFocus: true,
  refetchIntervalInBackground: false,
  refetchInterval: (query: { state: { data: AssistantWeixinStatus | undefined } }) => {
    const status = query.state.data?.status;
    return status === 'waiting' || status === 'scanned' || status === 'verify' ? 2000
      : status === 'connected' || status === 'reconnecting' ? 15_000 : false;
  },
});
export const ensureAssistantWeixinStatus = (assistantID: string) => queryClient.ensureQueryData(assistantWeixinQueryOptions(assistantID));
export const refreshAssistantWeixinStatus = (assistantID: string) => queryClient.fetchQuery(assistantWeixinQueryOptions(assistantID));

export function useAssistantWeixin(assistantID: string) {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const query = useQuery(assistantWeixinQueryOptions(assistantID, transport));
  const assertCurrent = () => {
    if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) throw new Error('runtime_stale');
  };
  const mutation = useMutation({
    mutationKey: [...key(assistantID, transport), 'change'],
    gcTime: 0,
    mutationFn: async (action: Action) => {
      await queryClient.cancelQueries({ queryKey: [transport, 'assistants', 'weixin'] });
      assertCurrent();
      const result = await request(assistantID, action.type === 'disconnect' ? '' : `/${action.type}`, {
        method: action.type === 'disconnect' ? 'DELETE' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action.type === 'verify' ? { code: action.code }
          : { ...(action.type === 'transfer' ? { sourceAssistantID: action.sourceAssistantID, revision: action.revision } : {}), language: useI18nStore.getState().locale }),
      });
      assertCurrent();
      return result;
    },
    onSuccess: (result) => queryClient.setQueryData(key(assistantID, transport), result),
    onSettled: () => {
      if (transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration()) {
        void queryClient.invalidateQueries({ queryKey: [transport, 'assistants', 'weixin'] });
      }
    },
  });
  return { query, mutation };
}
