import { QueryObserver } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { HostRuntimeRegistry } from './registry';
import { getHostRuntimeServices } from './runtime';
import { remoteHostSummariesKey } from './summaries';

const events = vi.hoisted(() => ({ listeners: new Set<(event: unknown) => void>(), subscriptions: vi.fn() }));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: (listener: (event: unknown) => void) => {
  events.subscriptions(); events.listeners.add(listener); return () => events.listeners.delete(listener);
} }));

it('multiplexes five Hosts and five token streams without refetching unrelated Host summaries', async () => {
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true,
    fetch: vi.fn(), sdk: () => { throw new Error('No content demanded'); } });
  const hosts = Array.from({ length: 5 }, (_, index) => ({ id: `host-${index}`, name: `Host ${index}`, source: 'direct' as const, state: 'connected' as const, generation: 'wire' }));
  registry.applyCatalog({ supported: true, hubId: 'hub', hosts, projects: [] });
  const fetches = hosts.map(() => vi.fn(async () => ({ revision: 2 })));
  const observers = hosts.map((host, index) => new QueryObserver(queryClient, {
    queryKey: remoteHostSummariesKey(getRuntimeTransportIdentity(), 'hub', host.id),
    queryFn: fetches[index], staleTime: Infinity, gcTime: Infinity,
  }));
  const releases = observers.map((observer) => observer.subscribe(() => {}));
  const services = getHostRuntimeServices(registry);
  const stop = services.retain(); const stopSecondPane = services.retain();
  const emit = (hostId: string, type: string, hubId = 'hub') => {
    for (const listener of events.listeners) listener({ type: 'remote-host-event', envelope: {
      type: 'yuri:host-event', properties: { hubId, hostId, generation: 'wire', directory: '/same/path', payload: { type, properties: {} } },
    } });
  };
  try {
    await vi.waitFor(() => observers.forEach((observer) => expect(observer.getCurrentResult().data).toEqual({ revision: 2 })));
    fetches.forEach((fetch) => expect(fetch).toHaveBeenCalledTimes(1));
    const unaffected = observers.slice(1).map((observer) => observer.getCurrentResult().data);
    for (let token = 0; token < 100; token += 1) for (const host of hosts) emit(host.id, 'message.part.delta');
    await Promise.resolve();
    fetches.forEach((fetch) => expect(fetch).toHaveBeenCalledTimes(1));
    emit('host-0', 'yuri:session-index-changed', 'other-hub');
    await Promise.resolve();
    expect(fetches[0]).toHaveBeenCalledTimes(1);
    emit('host-0', 'yuri:session-index-changed');
    await vi.waitFor(() => expect(fetches[0]).toHaveBeenCalledTimes(2));
    emit('host-0', 'yuri:worktree-topology-changed', 'other-hub');
    await Promise.resolve();
    expect(fetches[0]).toHaveBeenCalledTimes(2);
    emit('host-0', 'yuri:worktree-topology-changed');
    await vi.waitFor(() => expect(fetches[0]).toHaveBeenCalledTimes(3));
    for (let token = 0; token < 100; token += 1) for (const host of hosts) emit(host.id, 'message.part.delta');
    await Promise.resolve();
    expect(fetches[0]).toHaveBeenCalledTimes(3);
    fetches.slice(1).forEach((fetch, index) => {
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(observers[index + 1].getCurrentResult().data).toBe(unaffected[index]);
    });
    expect(events.subscriptions).toHaveBeenCalledTimes(1);
  } finally {
    releases.forEach((release) => release()); observers.forEach((observer) => observer.destroy());
    stop(); stopSecondPane(); await Promise.resolve(); registry.dispose(); queryClient.clear();
  }
  expect(events.listeners.size).toBe(0);
});
