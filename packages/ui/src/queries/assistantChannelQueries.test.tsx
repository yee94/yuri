import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  transport: 'host-a',
  generation: 1,
  locale: 'en',
  response: { provider: 'feishu', status: 'connected', error: null, configured: true, hasSecret: true, transport: 'websocket' as const },
  fetch: vi.fn(),
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => state.transport,
  getRuntimeGeneration: () => state.generation,
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => state.fetch(...args) }));
vi.mock('@/lib/i18n/store', () => ({ useI18nStore: { getState: () => ({ locale: state.locale }) } }));
vi.mock('@/lib/queryRuntime', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }) };
});
import { queryClient } from '@/lib/queryRuntime';
import {
  assistantChannelQueryOptions,
  parseAssistantChannelStatus,
  useAssistantChannel,
  type AssistantChannelProvider,
} from './assistantChannelQueries';

let root: Root | null = null;
let element: HTMLDivElement | null = null;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  element?.remove();
  element = null;
  queryClient.clear();
  state.transport = 'host-a';
  state.generation = 1;
  state.locale = 'en';
  state.fetch.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});

const hookFor = async (provider: AssistantChannelProvider, assistantID = 'bot') => {
  let hooks: ReturnType<typeof useAssistantChannel>;
  function Consumer() { hooks = useAssistantChannel(assistantID, provider); return null; }
  element = document.createElement('div'); document.body.append(element); root = createRoot(element);
  await act(async () => root?.render(<QueryClientProvider client={queryClient}><Consumer /></QueryClientProvider>));
  return hooks!;
};

describe('assistant platform channel query boundary', () => {
  it('discovers through an abortable scoped POST without changing saved query data', async () => {
    state.fetch.mockImplementation(async (path: string) => Response.json(path.endsWith('/discover') ? { ownerID: 'ou_user', ignored: 'private' } : state.response));
    const hooks = await hookFor('feishu');
    const controller = new AbortController();
    let result;
    await act(async () => { result = await hooks.discovery.mutateAsync({ clientID: 'app', clientSecret: 'secret', signal: controller.signal }); });
    expect(result).toEqual({ ownerID: 'ou_user' });
    const [path, init] = state.fetch.mock.calls.find(([path]) => path.endsWith('/discover'))!;
    expect(path).toBe('/api/yuri/assistants/bot/channels/feishu/discover');
    expect(init.signal).toBe(controller.signal);
    expect(JSON.parse(init.body)).toEqual({ clientID: 'app', clientSecret: 'secret' });
    expect(queryClient.getQueryData(assistantChannelQueryOptions('bot', 'feishu').queryKey)).toMatchObject({ configured: true });
  });

  it('rejects malformed, aborted and stale discovery responses', async () => {
    state.fetch.mockImplementation(async (path: string) => Response.json(path.endsWith('/discover') ? { ownerID: '' } : state.response));
    const hooks = await hookFor('feishu');
    const controller = new AbortController();
    await act(async () => {
      await expect(hooks.discovery.mutateAsync({ clientID: 'app', signal: controller.signal })).rejects.toThrow('invalid_response');
    });
    state.fetch.mockImplementation(async () => { controller.abort(); return Response.json({ ownerID: 'stale' }); });
    await act(async () => {
      await expect(hooks.discovery.mutateAsync({ clientID: 'app', signal: controller.signal })).rejects.toThrow('cancelled');
    });
    state.transport = 'other-host';
    state.fetch.mockClear();
    await act(async () => {
      await expect(hooks.discovery.mutateAsync({ clientID: 'app', signal: new AbortController().signal })).rejects.toThrow('runtime_stale');
    });
    expect(state.fetch.mock.calls.filter(([path]) => path.endsWith('/discover'))).toHaveLength(0);
  });

  it('keys by host, Bot and provider, passes cancellation, and never exposes unlisted fields', async () => {
    const options = assistantChannelQueryOptions('bot', 'feishu');
    state.transport = 'host-b';
    expect(options.queryKey).not.toEqual(assistantChannelQueryOptions('bot', 'feishu').queryKey);
    expect(options.queryKey).not.toEqual(assistantChannelQueryOptions('bot', 'dingtalk', 'host-a').queryKey);
    expect(options.queryKey).not.toContain('secret');
    const signal = new AbortController().signal;
    state.fetch.mockResolvedValue(Response.json({ ...state.response, clientSecret: 'must-not-return' }));
    const result = await options.queryFn({ signal });
    expect(state.fetch).toHaveBeenCalledWith('/api/yuri/assistants/bot/channels/feishu', { signal });
    expect(result).not.toHaveProperty('clientSecret');
    expect(result).toMatchObject({ provider: 'feishu', status: 'connected', hasSecret: true, transport: 'websocket' });
    expect(() => parseAssistantChannelStatus({}, 'feishu')).toThrow('invalid_response');
  });

  it('treats an older host as unsupported and validates provider, status and secret flags', async () => {
    state.fetch.mockResolvedValue(Response.json({ error: 'unsupported' }, { status: 501 }));
    const options = assistantChannelQueryOptions('bot', 'wecom');
    expect(await options.queryFn({ signal: new AbortController().signal })).toMatchObject({ provider: 'wecom', status: 'unsupported' });
    expect(() => parseAssistantChannelStatus({ ...state.response, provider: 'wecom' }, 'feishu')).toThrow('invalid_response');
    expect(() => parseAssistantChannelStatus({ ...state.response, status: 'waiting' }, 'feishu')).toThrow('invalid_response');
    expect(() => parseAssistantChannelStatus({ ...state.response, hasSecret: 'yes' }, 'feishu')).toThrow('invalid_response');
    expect(() => parseAssistantChannelStatus({ ...state.response, transport: 'streamable-http' }, 'feishu')).toThrow('invalid_response');
  });

  it('parses safe transfer sources and refreshes both Bot scopes after confirmed transfer', async () => {
    const source = { assistantID: 'old', name: 'Old bot', revision: 'r1', clientID: 'account', clientSecret: 'must-not-return' };
    const parsed = parseAssistantChannelStatus({ ...state.response, transferSources: [source] }, 'feishu');
    expect(parsed.transferSources?.[0]).toEqual({ assistantID: 'old', name: 'Old bot', revision: 'r1', clientID: 'account' });
    expect(() => parseAssistantChannelStatus({ ...state.response, transferSources: [{ name: 'bad' }] }, 'feishu')).toThrow('invalid_response');
    state.fetch.mockImplementation(async () => Response.json(state.response));
    const hooks = await hookFor('feishu');
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    await act(async () => { await hooks.mutation.mutateAsync({ type: 'transfer', sourceAssistantID: 'old', revision: 'r1' }); });
    const call = state.fetch.mock.calls.find(([path]) => path.endsWith('/transfer'))!;
    expect(call[1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(call[1].body)).toEqual({ sourceAssistantID: 'old', revision: 'r1' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: assistantChannelQueryOptions('old', 'feishu', 'host-a').queryKey });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: assistantChannelQueryOptions('bot', 'feishu', 'host-a').queryKey });
    invalidate.mockRestore();
  });

  it('polls only while the dialog-mounted channel is connecting or connected', () => {
    const options = assistantChannelQueryOptions('bot', 'dingtalk');
    expect(options.gcTime).toBe(0);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchInterval({ state: { data: { ...state.response, provider: 'dingtalk', status: 'connecting' } } })).toBe(2000);
    expect(options.refetchInterval({ state: { data: { ...state.response, provider: 'dingtalk', status: 'connected' } } })).toBe(15_000);
    expect(options.refetchInterval({ state: { data: { ...state.response, provider: 'dingtalk', status: 'reconnecting' } } })).toBe(15_000);
    for (const status of ['disconnected', 'error', 'disabled', 'unsupported'] as const) {
      expect(options.refetchInterval({ state: { data: { ...state.response, provider: 'dingtalk', status } } })).toBe(false);
    }
  });

  it('saves with the single owner and omits an empty secret, then reconnects or disconnects without replay state', async () => {
    state.fetch.mockImplementation(async (_path: string, init?: RequestInit) => Response.json({
      ...state.response,
      provider: 'feishu',
      status: init?.method === 'PUT' ? 'connecting' : 'connected',
    }));
    const hooks = await hookFor('feishu');
    await act(async () => { await hooks.mutation.mutateAsync({ type: 'save', clientID: ' cli_1 ', ownerID: ' ou_1 ', clientSecret: 'shh' }); });
    const save = state.fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    expect(save[0]).toBe('/api/yuri/assistants/bot/channels/feishu');
    expect(JSON.parse((save[1] as RequestInit).body as string)).toEqual({
      clientID: ' cli_1 ',
      ownerID: ' ou_1 ',
      clientSecret: 'shh',
      language: 'en',
    });

    await act(async () => { await hooks.mutation.mutateAsync({ type: 'save', clientID: 'cli_1', ownerID: 'ou_1' }); });
    const saves = state.fetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
    expect(JSON.parse((saves.at(-1)![1] as RequestInit).body as string)).not.toHaveProperty('clientSecret');

    await act(async () => { await hooks.mutation.mutateAsync({ type: 'retry' }); });
    const retry = state.fetch.mock.calls.find(([path]) => path.endsWith('/retry'))!;
    expect(retry[1]).toMatchObject({ method: 'POST' });
    expect((retry[1] as RequestInit).body).toBeUndefined();

    await act(async () => { await hooks.mutation.mutateAsync({ type: 'disconnect' }); });
    const remove = state.fetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE')!;
    expect(remove[0]).toBe('/api/yuri/assistants/bot/channels/feishu');
  });

  it('rejects a mutation that finishes after switching runtimes without writing another host cache', async () => {
    let finish: ((response: Response) => void) | undefined;
    state.fetch.mockImplementation(async (_path: string, init?: RequestInit) => init?.method === 'PUT'
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Response.json(state.response));
    const hooks = await hookFor('feishu');
    const hostAKey = assistantChannelQueryOptions('bot', 'feishu', 'host-a').queryKey;
    queryClient.setQueryData(hostAKey, { ...state.response, status: 'connected' });
    let pending: Promise<unknown>;
    await act(async () => {
      pending = hooks.mutation.mutateAsync({ type: 'save', clientID: 'cli_1', ownerID: 'ou_1' }).catch((error: Error) => error);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    state.transport = 'host-b'; state.generation++;
    finish!(Response.json({ ...state.response, status: 'connected' }));
    let result: unknown;
    await act(async () => { result = await pending!; });
    expect(result).toMatchObject({ message: 'runtime_stale' });
    expect(queryClient.getQueryData(assistantChannelQueryOptions('bot', 'feishu', 'host-a').queryKey)).toMatchObject({ status: 'connected' });
  });
});
