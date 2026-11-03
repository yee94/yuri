import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ transport: 'host-a', generation: 1, response: { status: 'disconnected', error: null }, fetch: vi.fn() }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => state.transport,
  getRuntimeGeneration: () => state.generation,
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: (...args: unknown[]) => state.fetch(...args) }));
vi.mock('@/lib/queryRuntime', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  return { queryClient: new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }) };
});
import { queryClient } from '@/lib/queryRuntime';
import { assistantWeixinQueryOptions, ensureAssistantWeixinStatus, refreshAssistantWeixinStatus, parseAssistantWeixinStatus, useAssistantWeixin } from './assistantWeixinQueries';

let root: Root | null = null;
let element: HTMLDivElement | null = null;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = null;
  element?.remove();
  element = null;
  queryClient.clear();
  state.transport = 'host-a'; state.generation = 1;
  state.fetch.mockReset();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });
});

describe('assistant WeChat query boundary', () => {
  it('keys by host and bot, passes cancellation, and rejects malformed success', async () => {
    const a = assistantWeixinQueryOptions('bot-a');
    state.transport = 'host-b';
    expect(a.queryKey).not.toEqual(assistantWeixinQueryOptions('bot-a').queryKey);
    expect(a.queryKey).not.toEqual(assistantWeixinQueryOptions('bot-b', 'host-a').queryKey);
    const signal = new AbortController().signal;
    state.fetch.mockResolvedValue(Response.json({ status: 'waiting', qrCode: 'https://example.com/scan', bot_token: 'not-public' }));
    const result = await a.queryFn({ signal });
    expect(state.fetch).toHaveBeenCalledWith('/api/yuri/assistants/bot-a/weixin', { signal });
    expect(result).not.toHaveProperty('bot_token');
    expect(() => parseAssistantWeixinStatus({})).toThrow('invalid_response');
  });

  it('keeps stale data when a refresh fails; treats unsupported distinctly from disconnected', async () => {
    state.fetch.mockImplementation(async () => Response.json({ status: 'connected', error: null }));
    await ensureAssistantWeixinStatus('bot');
    const options = assistantWeixinQueryOptions('bot');
    state.fetch.mockImplementation(async () => Response.json({ error: 'network_error' }, { status: 502 }));
    await expect(refreshAssistantWeixinStatus('bot')).rejects.toThrow('network_error');
    expect(queryClient.getQueryData(options.queryKey)).toMatchObject({ status: 'connected' });
    state.fetch.mockImplementation(async () => Response.json({ error: 'weixin_unsupported' }, { status: 501 }));
    expect(await refreshAssistantWeixinStatus('bot')).toMatchObject({ status: 'unsupported' });
  });

  it('polls only pending login/connected state and does not retain an unmounted QR cache', () => {
    const options = assistantWeixinQueryOptions('bot');
    expect(options.gcTime).toBe(0);
    expect(options.refetchIntervalInBackground).toBe(false);
    expect(options.refetchInterval({ state: { data: { status: 'waiting', error: null } } })).toBe(2000);
    expect(options.refetchInterval({ state: { data: { status: 'connected', error: null } } })).toBe(15_000);
    for (const status of ['disconnected', 'expired', 'error', 'unsupported', 'disabled'] as const) {
      expect(options.refetchInterval({ state: { data: { status, error: null } } })).toBe(false);
    }
  });

  it('recognizes a disabled channel instead of treating it as disconnected or unsupported', () => {
    expect(parseAssistantWeixinStatus({ status: 'disabled', error: null })).toEqual({ status: 'disabled', error: null });
  });

  it('only exposes validated source identity/name/revision, never source credentials', () => {
    const result = parseAssistantWeixinStatus({ status: 'disconnected', transferSources: [{ assistantID: 'old', name: 'Old bot', revision: 'r1', token: 'private' }] });
    expect(result.transferSources).toEqual([{ assistantID: 'old', name: 'Old bot', revision: 'r1' }]);
    expect(() => parseAssistantWeixinStatus({ status: 'disconnected', transferSources: [{ assistantID: 'old' }] })).toThrow('invalid_response');
  });

  it('sends explicit move identity/revision and invalidates other bots on the same host only', async () => {
    state.fetch.mockImplementation(async () => Response.json({ status: 'connected', error: null }));
    let hooks: ReturnType<typeof useAssistantWeixin>;
    function Consumer() { hooks = useAssistantWeixin('new'); return null; }
    element = document.createElement('div'); document.body.append(element); root = createRoot(element);
    await act(async () => root?.render(<QueryClientProvider client={queryClient}><Consumer /></QueryClientProvider>));
    const oldKey = assistantWeixinQueryOptions('old').queryKey;
    const remoteKey = assistantWeixinQueryOptions('old', 'host-b').queryKey;
    queryClient.setQueryData(oldKey, { status: 'connected', error: null });
    queryClient.setQueryData(remoteKey, { status: 'connected', error: null });
    await act(async () => { await hooks!.mutation.mutateAsync({ type: 'transfer', sourceAssistantID: 'old', revision: 'r1' }); });
    const call = state.fetch.mock.calls.find(([path]) => path.endsWith('/transfer'))!;
    expect(call[0]).toBe('/api/yuri/assistants/new/weixin/transfer');
    expect(call[1].method).toBe('POST');
    expect(JSON.parse(call[1].body)).toMatchObject({ sourceAssistantID: 'old', revision: 'r1' });
    expect(queryClient.getQueryState(oldKey)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(remoteKey)?.isInvalidated).toBe(false);
  });

  it('fences a mutation that finishes after switching runtimes', async () => {
    let finish: ((response: Response) => void) | undefined;
    state.fetch.mockImplementation(async (_path: string, init: RequestInit) => init?.method === 'POST'
      ? new Promise<Response>((resolve) => { finish = resolve; })
      : Response.json({ status: 'disconnected', error: null }));
    let hooks: ReturnType<typeof useAssistantWeixin>;
    function Consumer() { hooks = useAssistantWeixin('bot'); return null; }
    element = document.createElement('div'); document.body.append(element); root = createRoot(element);
    await act(async () => root?.render(<QueryClientProvider client={queryClient}><Consumer /></QueryClientProvider>));
    let pending: Promise<unknown>;
    await act(async () => {
      pending = hooks!.mutation.mutateAsync({ type: 'login' }).catch((error: Error) => error);
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    state.transport = 'host-b'; state.generation++;
    finish!(Response.json({ status: 'waiting', qrCode: 'old-host-qr', error: null }));
    let result: unknown;
    await act(async () => { result = await pending!; });
    expect(result).toMatchObject({ message: 'runtime_stale' });
    expect(queryClient.getQueryData<{ qrCode?: string }>(assistantWeixinQueryOptions('bot', 'host-b').queryKey)?.qrCode).not.toBe('old-host-qr');
    expect(queryClient.getQueryData<{ qrCode?: string }>(assistantWeixinQueryOptions('bot', 'host-a').queryKey)?.qrCode).not.toBe('old-host-qr');
  });
});
