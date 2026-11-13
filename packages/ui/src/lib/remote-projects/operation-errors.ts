import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { useEvent } from '@reactuses/core';
import type { HostRuntimeRegistry } from './registry';

type OperationError = { message: string; retry: () => void | Promise<void> };
const channels = new WeakMap<HostRuntimeRegistry, Map<string, ReturnType<typeof createChannel>>>();

function createChannel() {
  const errors = new Map<symbol, OperationError>();
  const listeners = new Set<() => void>();
  let snapshot: readonly OperationError[] = [];
  const notify = () => {
    snapshot = [...errors.values()];
    listeners.forEach((listener) => listener());
  };
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => snapshot,
    report(error: OperationError) {
      const owner = Symbol();
      errors.set(owner, error);
      notify();
      return () => { if (errors.delete(owner)) notify(); };
    },
  };
}

function getChannel(registry: HostRuntimeRegistry, hostId: string) {
  let hosts = channels.get(registry);
  if (!hosts) channels.set(registry, hosts = new Map());
  let channel = hosts.get(hostId);
  if (!channel) hosts.set(hostId, channel = createChannel());
  return channel;
}

export function useRemoteOperationError(registry: HostRuntimeRegistry, hostId: string, message: string | null | undefined, onRetry: () => void | Promise<void>) {
  const retry = useEvent(onRetry);
  useEffect(() => {
    if (message) return getChannel(registry, hostId).report({ message, retry });
  }, [registry, hostId, message, retry]);
}

export function useRemoteOperationErrors(registry: HostRuntimeRegistry, hostId: string) {
  const channel = useMemo(() => getChannel(registry, hostId), [registry, hostId]);
  return useSyncExternalStore(channel.subscribe, channel.getSnapshot, channel.getSnapshot);
}
