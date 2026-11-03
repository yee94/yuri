import { useMutation, useQuery } from '@tanstack/react-query';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useI18nStore } from '@/lib/i18n/store';

export const assistantChannelProviders = ['wecom', 'feishu', 'dingtalk'] as const;
export type AssistantChannelProvider = typeof assistantChannelProviders[number];

const serverStatuses = ['disabled', 'disconnected', 'connecting', 'connected', 'reconnecting', 'error'] as const;
type AssistantChannelServerStatus = typeof serverStatuses[number];

/**
 * GET, PUT, POST /retry and DELETE all return the same snapshot shape.
 * `unsupported` is client-local: it only represents an older host that does not
 * expose this route, and is never fabricated as a disconnected success.
 */
export type AssistantChannelStatus = {
  provider: AssistantChannelProvider;
  status: AssistantChannelServerStatus | 'unsupported';
  error: string | null;
  configured: boolean;
  clientID?: string;
  ownerID?: string;
  hasSecret: boolean;
  transport: 'websocket';
  transferSources?: { assistantID: string; name: string; revision: string; clientID: string }[];
};

type AssistantChannelSaveInput = {
  clientID: string;
  clientSecret?: string;
  ownerID?: string;
};

export type AssistantChannelAction =
  | ({ type: 'save' } & AssistantChannelSaveInput)
  | { type: 'retry' }
  | { type: 'transfer'; sourceAssistantID: string; revision: string }
  | { type: 'disconnect' };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const optionalString = (value: unknown, max: number): string | undefined => {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) throw new Error('invalid_response');
  return value;
};

export function parseAssistantChannelStatus(value: unknown, expectedProvider: AssistantChannelProvider): AssistantChannelStatus {
  if (!isRecord(value)) throw new Error('invalid_response');
  if (value.provider !== expectedProvider) throw new Error('invalid_response');
  if (!serverStatuses.some((status) => status === value.status)) throw new Error('invalid_response');
  if (value.error !== null && typeof value.error !== 'string') throw new Error('invalid_response');
  if (typeof value.configured !== 'boolean' || typeof value.hasSecret !== 'boolean' || value.transport !== 'websocket') {
    throw new Error('invalid_response');
  }
  const clientID = optionalString(value.clientID, 512);
  const ownerID = optionalString(value.ownerID, 512);
  let transferSources: AssistantChannelStatus['transferSources'];
  if (value.transferSources !== undefined) {
    if (!Array.isArray(value.transferSources)) throw new Error('invalid_response');
    transferSources = value.transferSources.map((source: unknown) => {
      if (!isRecord(source)) throw new Error('invalid_response');
      const assistantID = optionalString(source.assistantID, 512);
      const name = optionalString(source.name, 8192);
      const revision = optionalString(source.revision, 512);
      const clientID = optionalString(source.clientID, 512);
      if (!assistantID || name === undefined || !revision || !clientID) throw new Error('invalid_response');
      return { assistantID, name, revision, clientID };
    });
  }
  return {
    provider: expectedProvider,
    status: value.status as AssistantChannelServerStatus,
    error: typeof value.error === 'string' ? value.error : null,
    configured: value.configured,
    ...(clientID !== undefined ? { clientID } : {}),
    ...(ownerID !== undefined ? { ownerID } : {}),
    hasSecret: value.hasSecret,
    transport: 'websocket',
    ...(transferSources ? { transferSources } : {}),
  };
}

const unsupportedSnapshot = (provider: AssistantChannelProvider): AssistantChannelStatus => ({
  provider,
  status: 'unsupported',
  error: null,
  configured: false,
  hasSecret: false,
  transport: 'websocket',
});

const errorCode = (body: unknown) => body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
  ? body.error
  : 'channel_error';

const request = async (
  assistantID: string,
  provider: AssistantChannelProvider,
  suffix = '',
  init: RequestInit = {},
): Promise<AssistantChannelStatus | null> => {
  const response = await runtimeFetch(
    `/api/yuri/assistants/${encodeURIComponent(assistantID)}/channels/${provider}${suffix}`,
    init,
  );
  if (response.status === 501 || (response.status === 404 && !suffix)) return unsupportedSnapshot(provider);
  if (response.status === 204) return null;
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(errorCode(body));
  return parseAssistantChannelStatus(body, provider);
};

const key = (assistantID: string, provider: AssistantChannelProvider, transport = getRuntimeTransportIdentity()) =>
  [transport, 'assistants', 'channels', assistantID, provider] as const;

export const assistantChannelQueryOptions = (
  assistantID: string,
  provider: AssistantChannelProvider,
  transport = getRuntimeTransportIdentity(),
) => ({
  queryKey: key(assistantID, provider, transport),
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const result = await request(assistantID, provider, '', { signal });
    if (!result) throw new Error('invalid_response');
    return result;
  },
  staleTime: 0,
  gcTime: 0,
  retry: 1,
  refetchOnWindowFocus: true,
  refetchIntervalInBackground: false,
  refetchInterval: (query: { state: { data: AssistantChannelStatus | undefined } }) => {
    const status = query.state.data?.status;
    return status === 'connecting' ? 2000
      : status === 'connected' || status === 'reconnecting' ? 15_000 : false;
  },
});

export function useAssistantChannel(assistantID: string, provider: AssistantChannelProvider) {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const query = useQuery(assistantChannelQueryOptions(assistantID, provider, transport));
  const assertCurrent = () => {
    if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration()) throw new Error('runtime_stale');
  };
  const mutation = useMutation({
    mutationKey: [...key(assistantID, provider, transport), 'change'],
    gcTime: 0,
    mutationFn: async (action: AssistantChannelAction) => {
      await queryClient.cancelQueries({ queryKey: key(assistantID, provider, transport) });
      if (action.type === 'transfer') await queryClient.cancelQueries({ queryKey: key(action.sourceAssistantID, provider, transport) });
      assertCurrent();
      const result = await request(assistantID, provider, action.type === 'retry' ? '/retry' : action.type === 'transfer' ? '/transfer' : '',
        action.type === 'transfer' ? {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sourceAssistantID: action.sourceAssistantID, revision: action.revision }),
        } : action.type === 'save' ? {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            clientID: action.clientID,
            ownerID: action.ownerID,
            ...(action.clientSecret ? { clientSecret: action.clientSecret } : {}),
            language: useI18nStore.getState().locale,
          }),
        } : { method: action.type === 'disconnect' ? 'DELETE' : 'POST' },
      );
      assertCurrent();
      return result;
    },
    onSuccess: (result) => {
      if (result) queryClient.setQueryData(key(assistantID, provider, transport), result);
    },
    onSettled: (_result, _error, action) => {
      if (transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration()) {
        void queryClient.invalidateQueries({ queryKey: key(assistantID, provider, transport) });
        if (action.type === 'transfer') void queryClient.invalidateQueries({ queryKey: key(action.sourceAssistantID, provider, transport) });
      }
    },
  });
  return { query, mutation };
}
