import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { RemoteProjectsBootstrap } from './RemoteProjectsBootstrap';

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), reconcile: vi.fn() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mocks.fetch }));
vi.mock('@/stores/useProjectsStore', () => {
  const state = { projects: [], reconcileRemoteProjects: mocks.reconcile };
  return { useProjectsStore: Object.assign((selector: (state: unknown) => unknown) => selector(state), { getState: () => state }) };
});
vi.mock('@/lib/desktop', async (original) => ({ ...await original<typeof import('@/lib/desktop')>(), isDesktopShell: () => true, isVSCodeRuntime: () => false }));

afterEach(() => { queryClient.clear(); vi.clearAllMocks(); vi.useRealTimers(); });

it('adds no catalog query, HTTP request or pending timer for a local-only bootstrap', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const key = [getRuntimeTransportIdentity(), 'settings', 'bootstrap'];
  queryClient.setQueryData(key, { schemaVersion: 1, hasRemoteProjects: false });
  vi.useFakeTimers();
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectsBootstrap /></QueryClientProvider>));
    expect(queryClient.getQueryCache().findAll({ queryKey: [getRuntimeTransportIdentity(), 'remote-projects'] })).toHaveLength(0);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { await act(async () => root.unmount()); container.remove(); }
});

it('discovers existing Hub references from the existing bootstrap hint, with zero local-only IO', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const transport = getRuntimeTransportIdentity();
  const key = [transport, 'settings', 'bootstrap'];
  queryClient.setQueryData(key, { schemaVersion: 1, hasRemoteProjects: false });
  mocks.fetch.mockResolvedValue(Response.json({ supported: true, hubId: 'hub', hosts: [], projects: [
    { id: 'reference', hostId: 'host', path: '/raw/project', remoteProjectId: 'remote-project', remoteState: 'ok' },
  ] }));
  const container = document.createElement('div'); document.body.append(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectsBootstrap /></QueryClientProvider>));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    await act(async () => {
      queryClient.setQueryData(key, { schemaVersion: 1, hasRemoteProjects: true });
      await vi.advanceTimersByTimeAsync(1);
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(mocks.reconcile).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'reference', hubId: 'hub', hostId: 'host', path: '/raw/project' }),
    ], 'hub');
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][0]).toBe('/api/hosts');
  } finally { await act(async () => root.unmount()); container.remove(); }
});
