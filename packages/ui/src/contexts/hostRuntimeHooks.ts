import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useEvent } from '@reactuses/core';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { getHostRuntimeServices } from '@/lib/remote-projects/runtime';
import { HostRuntimeContext, type HostRuntimeContextValue } from './hostRuntimeContext';

export const useHostRuntime = (): HostRuntimeContextValue | null => useContext(HostRuntimeContext);

/** Subscribe to one host, never the complete catalog; unrelated events do no selector work. */
export const useRemoteHost = (registry: HostRuntimeRegistry, hostId: string) => {
  const subscribe = useMemo(() => (listener: () => void) => {
    const unsubscribe = registry.subscribeHost(hostId, listener);
    const release = getHostRuntimeServices(registry).retain();
    return () => { unsubscribe(); release(); };
  }, [registry, hostId]);
  const getSnapshot = useMemo(() => () => registry.getHost(hostId), [registry, hostId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
};

export function useRemoteSessionDemand(sessionId: string | null, refresh: () => void | Promise<void>, error: (error: unknown) => void): void {
  const context = useHostRuntime();
  const onRefresh = useEvent(refresh);
  const onError = useEvent(error);
  const demand = context?.demand;
  const location = context?.entry.location;
  useEffect(() => {
    if (!demand || !location?.hostId || !sessionId) return;
    return demand.retain(location, sessionId, { refresh: onRefresh, error: onError });
  }, [demand, location, sessionId, onRefresh, onError]);
}
