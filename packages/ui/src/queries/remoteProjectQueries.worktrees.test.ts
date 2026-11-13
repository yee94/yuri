import { expect, it, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { getHostRuntimeServices } from '@/lib/remote-projects/runtime';
import { remoteHostSummariesQueryOptions } from './remoteProjectQueries';

it('a real summary Query retries a visible worktree 404 without polling, and malformed refresh retains topology', async () => {
  let subscribed = false;
  let malformed = false;
  const topology = { projectDirectories: { '/repo': ['/repo', '/external checkout'] }, staleProjectDirectories: [] };
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (path.endsWith('/summaries')) return Response.json({ hostId: 'host', stale: false, directories: [], worktrees: malformed ? { ...topology, projectDirectories: { '/repo': null } } : topology });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    if (!subscribed) { subscribed = true; return new Response(null, { status: 404 }); }
    return Response.json({ id: 'recovered-lease', channelId: 'channel', readyGeneration: 'ready' });
  });
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true,
    fetch, sdk: () => { throw new Error('No SDK request expected'); } });
  const services = getHostRuntimeServices(registry);
  const observer = { refresh: vi.fn(), error: vi.fn() };
  const release = services.demand.retain({ hubId: 'hub', hostId: 'host', directory: '/external checkout' }, 'raw-session', observer);
  const options = { ...remoteHostSummariesQueryOptions(registry, 'host'), retry: false, staleTime: 0 };
  try {
    await vi.waitFor(() => expect(observer.error).toHaveBeenCalledTimes(1));
    const snapshot = await queryClient.fetchQuery(options);
    await vi.waitFor(() => expect(observer.refresh).toHaveBeenCalledTimes(1));
    expect(snapshot.worktrees).toEqual(topology);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
    expect(JSON.parse(String([...fetch.mock.calls].reverse().find(([, init]) => init?.method === 'POST')?.[1]?.body))).toEqual({ directory: '/external checkout', sessionId: 'raw-session' });
    malformed = true;
    await expect(queryClient.fetchQuery(options)).rejects.toThrow('Invalid remote worktree directories');
    expect(queryClient.getQueryData(options.queryKey)).toBe(snapshot);
    expect(fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
  } finally {
    release(); services.demand.dispose(); registry.dispose(); queryClient.removeQueries({ queryKey: options.queryKey, exact: true });
  }
});
