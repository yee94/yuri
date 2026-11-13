import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useEvent } from '@reactuses/core';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { HostLocation } from '@/lib/remote-projects/location';
import { getHostRuntimeServices } from '@/lib/remote-projects/runtime';
import { HostRuntimeContext } from './hostRuntimeContext';

function RemoteHostLifecycle({ services }: { services: ReturnType<typeof getHostRuntimeServices> }) {
  useEffect(() => services.retain(), [services]);
  return null;
}

/** A scoped capability boundary, not an endpoint switch. Local siblings keep their runtime. */
export function HostRuntimeProvider({ registry, location, children }: {
  registry: HostRuntimeRegistry;
  location: HostLocation;
  children: React.ReactNode;
}) {
  const hostId = location.hostId ?? '';
  const subscribe = useMemo(() => hostId
    ? (listener: () => void) => registry.subscribeHost(hostId, listener)
    : (_listener: () => void) => () => {}, [registry, hostId]);
  const snapshot = useMemo(() => () => hostId ? registry.getHost(hostId) : undefined, [registry, hostId]);
  const host = useSyncExternalStore(subscribe, snapshot, snapshot);
  const [connectionError, setConnectionError] = useState<Error | null>(null);
  const reconnect = useEvent(async () => {
    if (!hostId) return;
    setConnectionError(null);
    try { await registry.connectHost(hostId); }
    catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      setConnectionError(failure);
      throw failure;
    }
  });
  useEffect(() => {
    if (!hostId) return;
    let active = true;
    setConnectionError(null);
    void registry.connectHost(hostId).catch((error: unknown) => {
      if (active) setConnectionError(error instanceof Error ? error : new Error(String(error)));
    });
    return () => { active = false; };
  }, [registry, hostId]);
  const entry = registry.resolve(location);
  const services = useMemo(() => getHostRuntimeServices(registry), [registry]);
  const demand = services.demand;
  const visibleError = host?.state === 'connected' ? null : connectionError;
  const value = useMemo(() => ({ registry, entry, demand, connectionError: visibleError, reconnect }), [registry, entry, demand, visibleError, reconnect]);
  return <HostRuntimeContext.Provider value={value}>
    {entry.location.hostId ? <RemoteHostLifecycle services={services} /> : null}
    {children}
  </HostRuntimeContext.Provider>;
}
