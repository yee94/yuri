import React from 'react';
import { useEvent } from '@reactuses/core';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { getHostRuntimeRegistry, useRemoteProjectRuntime, useRemoteHostSummaries, supportsRemoteProjects } from '@/queries/remoteProjectQueries';
import { getRemoteChatOwner } from '@/sync/remote-chat-context';
import { locationKey } from '@/lib/remote-projects/location';

/** App-level scope is explicit: a descendant ChatContainer cannot provide it upwards. */
export function useRemoteMobileSession() {
  const project = useProjectsStore((state) => state.projects.find((item) => item.id === state.activeProjectId));
  const selected = useSessionNavigationStore((state) => state.remoteSession);
  const enabled = Boolean(project?.hostId);
  const platformSupported = supportsRemoteProjects();
  const discovery = useRemoteProjectRuntime(enabled && platformSupported);
  const supported = platformSupported && discovery.catalog?.supported !== false;
  const fallback = React.useMemo(() => project?.hubId && project.hostId ? {
    supported: true, hubId: project.hubId, projects: [],
    hosts: [{ id: project.hostId, name: project.hostId, source: 'direct' as const, state: 'offline' as const }],
  } : undefined, [project?.hubId, project?.hostId]);
  const registry = enabled && supported ? discovery.registry ?? (fallback ? getHostRuntimeRegistry(fallback) : undefined) : undefined;
  const hostId = project?.hostId;
  const subscribe = React.useMemo(() => (notify: () => void) => registry && hostId ? registry.subscribeHost(hostId, notify) : () => {}, [registry, hostId]);
  const readHost = React.useMemo(() => () => registry && hostId ? registry.getHost(hostId) : undefined, [registry, hostId]);
  const host = React.useSyncExternalStore(subscribe, readHost, readHost);
  const matches = selected?.projectId === project?.id && selected?.location.hostId === hostId
    && selected?.location.hubId === (project?.hubId ?? registry?.hubId);
  const location = React.useMemo(() => registry && hostId && project && (!project.hubId || registry.hubId === project.hubId)
    ? { hubId: registry.hubId, hostId, directory: matches && selected ? selected.location.directory : project.path } : undefined,
  [registry, hostId, project, matches, selected]);
  const entry = location && registry ? registry.resolve(location) : undefined;
  // Registry resolution is generation-aware; token events do not notify this subscription.
  const [retained, setRetained] = React.useState<{ entry: NonNullable<typeof entry>; owner: ReturnType<typeof getRemoteChatOwner> }>();
  React.useEffect(() => {
    if (!registry || !entry) return;
    const owner = getRemoteChatOwner(registry, entry);
    const release = owner.retain();
    setRetained({ entry, owner });
    return release;
  }, [registry, entry]);
  const owner = retained?.entry === entry ? retained?.owner : undefined;
  const sessionId = matches ? selected?.sessionId ?? null : null;
  const subscribeSession = React.useMemo(() => (notify: () => void) => owner ? owner.state.subscribeSnapshot(notify) : () => {}, [owner]);
  const readSession = React.useMemo(() => () => owner && sessionId ? owner.state.getSnapshot(sessionId).session : undefined, [owner, sessionId]);
  const liveSession = React.useSyncExternalStore(subscribeSession, readSession, readSession);
  const summaries = useRemoteHostSummaries(registry, hostId, enabled && supported);
  const session = liveSession ?? summaries.data?.directories.find((item) => item.directory === location?.directory)?.sessions.find((item) => item.id === sessionId);
  const openSession = useEvent((id: string | null) => {
    if (!project?.hostId || !location) throw new Error('Remote Host scope unavailable');
    useSessionNavigationStore.getState().openRemoteSession(project, location, id);
  });
  const refresh = useEvent(async () => {
    if (!owner || !sessionId) throw new Error('Remote session unavailable');
    await owner.state.repository.refreshFromAuthority(owner.state.scope(sessionId));
  });
  return { enabled, supported, project, registry, entry, owner, sessionId, session, host, openSession, refresh,
    key: location ? locationKey(location) : project?.id ?? '', error: discovery.error };
}

export type RemoteMobileSession = ReturnType<typeof useRemoteMobileSession>;
