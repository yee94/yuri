import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ChatInputModelFavorites } from '@/components/chat/chatInputSurface';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { useRemoteModelFavorites } from './remoteModelFavoriteQueries';

type Ref = { providerID: string; modelID: string; variant?: string };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const createRegistry = (initial: Ref[], hubId = 'hub') => {
  let remote = initial;
  const requestHost = vi.fn(async (_hostId: string, resource: string, init?: RequestInit) => {
    expect(resource).toBe('model-favorites');
    if (init?.method === 'PUT') remote = (JSON.parse(String(init.body)) as { favoriteModels: Ref[] }).favoriteModels;
    return json({ favoriteModels: remote });
  });
  const registry = { hubId, assertCurrent: () => undefined, requestHost } as unknown as HostRuntimeRegistry;
  return { registry, requestHost, remote: () => remote };
};

const mount = async (registry: HostRuntimeRegistry, hostId: string, onError = vi.fn()) => {
  const box: { current: ChatInputModelFavorites | null } = { current: null };
  const Probe = () => {
    box.current = useRemoteModelFavorites(registry, hostId, true, onError);
    return null;
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return { box, client, onError, unmount: () => act(async () => { root.unmount(); }) };
};

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useRemoteModelFavorites', () => {
  test('reads the favorites of the target machine and never the local list', async () => {
    const { registry } = createRegistry([{ providerID: 'remote', modelID: 'm1', variant: 'high' }]);
    const view = await mount(registry, 'host-a');

    expect(view.box.current?.models).toEqual([{ providerID: 'remote', modelID: 'm1', variant: 'high' }]);
    await view.unmount();
  });

  test('keeps each machine in its own cache entry', async () => {
    const a = createRegistry([{ providerID: 'a', modelID: '1' }]);
    const b = createRegistry([{ providerID: 'b', modelID: '2' }]);
    const first = await mount(a.registry, 'host-a');
    const second = await mount(b.registry, 'host-b');

    expect(first.box.current?.models).toEqual([{ providerID: 'a', modelID: '1' }]);
    expect(second.box.current?.models).toEqual([{ providerID: 'b', modelID: '2' }]);
    await first.unmount();
    await second.unmount();
  });

  test('toggles and reorders optimistically and writes the full list in order', async () => {
    const { registry, remote } = createRegistry([{ providerID: 'p', modelID: 'a' }, { providerID: 'p', modelID: 'b' }]);
    const view = await mount(registry, 'host-a');

    await act(async () => {
      view.box.current?.toggle('p', 'c', 'low');
      view.box.current?.reorder('p', 'b', 'p', 'c');
      view.box.current?.toggle('p', 'a');
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const expected = [{ providerID: 'p', modelID: 'b' }, { providerID: 'p', modelID: 'c', variant: 'low' }];
    expect(view.box.current?.models).toEqual(expected);
    expect(remote()).toEqual(expected);
    expect(view.onError).not.toHaveBeenCalled();
    await view.unmount();
  });

  test('reloads the machine list and reports when a write fails', async () => {
    const { registry, requestHost } = createRegistry([{ providerID: 'p', modelID: 'a' }]);
    const view = await mount(registry, 'host-a');
    requestHost.mockImplementationOnce(async () => json({ code: 'remote_request_failed', error: 'nope' }, 502));

    await act(async () => { view.box.current?.toggle('p', 'z'); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(view.onError).toHaveBeenCalledTimes(1);
    expect(view.box.current?.models).toEqual([{ providerID: 'p', modelID: 'a' }]);
    await view.unmount();
  });

  test('rejects edits before the machine list is loaded', async () => {
    const registry = {
      hubId: 'hub',
      assertCurrent: () => undefined,
      requestHost: vi.fn(async () => json({ code: 'x', error: 'down' }, 502)),
    } as unknown as HostRuntimeRegistry;
    const view = await mount(registry, 'host-a');

    await act(async () => { view.box.current?.toggle('p', 'a'); });

    expect(view.onError).toHaveBeenCalledTimes(1);
    expect(view.box.current?.models).toEqual([]);
    await view.unmount();
  });
});
