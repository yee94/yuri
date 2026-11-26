import React from 'react';
import { useEvent } from '@reactuses/core';
import { useQuery } from '@tanstack/react-query';
import { isDesktopLocalOriginActive, isElectronShell } from '@/lib/desktop';
import {
  desktopSshStatus,
  listenDesktopSshStatus,
  type DesktopSshBackgroundUpdate,
  type DesktopSshInstanceStatus,
} from '@/lib/desktopSsh';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeApiBaseUrl, getRuntimeKey } from '@/lib/runtime-switch';

export type SshBackgroundUpdate = DesktopSshBackgroundUpdate & { hostId: string };

const sameOrigin = (left: string | undefined, right: string) => {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

/** The SSH instance serving this window: bound host id first, then its forwarded endpoint. */
const isCurrentSshHost = (status: DesktopSshInstanceStatus) =>
  getRuntimeKey() === `host:${status.id}` || sameOrigin(status.localUrl, getRuntimeApiBaseUrl());

const toUpdate = (status: DesktopSshInstanceStatus | undefined): SshBackgroundUpdate | null =>
  status?.backgroundUpdate ? { ...status.backgroundUpdate, hostId: status.id } : null;

export const sshBackgroundUpdateQueryOptions = (transport: string) => ({
  queryKey: [transport, 'ssh-background-update'] as const,
  queryFn: async (): Promise<SshBackgroundUpdate | null> => toUpdate((await desktopSshStatus()).find(isCurrentSshHost)),
  staleTime: Infinity,
  retry: false,
});

/**
 * Background update of the managed SSH Host behind this window. Status events
 * keep the snapshot live; `onFailed` fires once per observed running→failed transition.
 * Scoped per window: local windows never observe it, and other windows ignore
 * updates of SSH Hosts they are not bound to.
 */
export function useSshBackgroundUpdate(transport: string, onFailed: (update: SshBackgroundUpdate) => void) {
  const enabled = isElectronShell() && !isDesktopLocalOriginActive();
  const query = useQuery({ ...sshBackgroundUpdateQueryOptions(transport), enabled });
  const handleFailed = useEvent(onFailed);
  React.useEffect(() => {
    if (!enabled) return;
    const queryKey = sshBackgroundUpdateQueryOptions(transport).queryKey;
    let disposed = false;
    let unlisten: (() => Promise<void>) | null = null;
    void listenDesktopSshStatus((status) => {
      if (!isCurrentSshHost(status)) return;
      const previous = queryClient.getQueryData<SshBackgroundUpdate | null>(queryKey);
      const next = toUpdate(status);
      queryClient.setQueryData(queryKey, next);
      if (next?.state === 'failed' && previous?.state === 'running') handleFailed(next);
    }).then((stop) => {
      if (disposed) void stop();
      else unlisten = stop;
    });
    return () => {
      disposed = true;
      if (unlisten) void unlisten();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- enabled and transport own the subscription; handleFailed is useEvent-stable.
  }, [enabled, transport]);
  return query.data ?? null;
}
