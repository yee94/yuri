import React from 'react';
import { useQueries, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import type { ProjectEntry } from '@/lib/api/types';
import { projectSession, type Session } from '@/lib/opencode/v2-types';
import { useRemoteProjectRuntime, remoteHostSummariesQueryOptions, refreshRemoteHostSummaries, supportsRemoteProjects } from '@/queries/remoteProjectQueries';
import { getHostRuntimeServices } from '@/lib/remote-projects/runtime';
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { locationSessionKey } from '@/lib/remote-projects/location';
import { resolveRemoteProjectOwner, type RemoteHostSummaries } from '@/lib/remote-projects/summaries';
import { queryClient } from '@/lib/queryRuntime';
import type { GitWorktreeInfo } from '@/lib/api/types';
import { captureProjectScope } from '@/lib/api/project-scope';

export function useRemoteMobileWorktreeDetails(entry: HostRuntimeEntry | undefined, enabled: boolean) {
  return useQuery({
    queryKey: [...(entry?.queryScope ?? ['unavailable']), 'mobile-status', 'worktrees'],
    enabled: enabled && Boolean(entry), staleTime: 30_000,
    queryFn: async ({ signal }): Promise<GitWorktreeInfo[]> => {
      if (!entry) throw new Error('Remote Host unavailable');
      const directory = entry.location.directory;
      const rows = await captureProjectScope(entry).json<GitWorktreeInfo[]>('/api/git/worktrees', { query: { directory }, headers: { 'x-opencode-directory': directory }, signal });
      if (!Array.isArray(rows)) throw new Error('Invalid remote worktree snapshot');
      return rows;
    },
  }, queryClient);
}

export interface RemoteMobileStatusOwner {
  registry: HostRuntimeRegistry;
  entry: HostRuntimeEntry;
  project: ProjectEntry;
  sessionId: string;
  directory: string;
  snapshot: RemoteHostSummaries;
}
export type RemoteMobileStatusSession = Session & { _remote: RemoteMobileStatusOwner };
const combineSummaries = (results: UseQueryResult<RemoteHostSummaries>[]) => ({
  snapshots: results.map((query) => query.data), errors: results.flatMap((query) => query.error ? [query.error] : []),
});
type RemotePage = { hostId: string; directory: string; sessions: Session[]; next?: string };
const combinePages = (results: UseQueryResult<RemotePage>[]) => results.map((query) => ({ data: query.data, isFetching: query.isFetching, error: query.error, refetch: query.refetch }));
const lastDirectoryRequest = (requests: Array<{ hostId: string; directory: string }>, hostId: string | undefined, directory: string) => {
  for (let index = requests.length - 1; index >= 0; index--) if (requests[index].hostId === hostId && requests[index].directory === directory) return index;
  return -1;
};

/** A view projection only. Remote records never enter Hub session/index stores. */
export function useRemoteMobileStatusCatalog(projects: ProjectEntry[], visible: boolean) {
  const remoteProjects = React.useMemo(() => projects.filter((project) => project.hostId), [projects]);
  const enabled = supportsRemoteProjects() && remoteProjects.length > 0 && visible;
  const discovery = useRemoteProjectRuntime(enabled);
  const registry = supportsRemoteProjects() && remoteProjects.length ? discovery.registry : undefined;
  const hostIds = React.useMemo(() => [...new Set(remoteProjects.filter((project) => project.hubId === registry?.hubId).map((project) => project.hostId!))], [remoteProjects, registry]);
  React.useEffect(() => enabled && registry ? getHostRuntimeServices(registry).retain() : undefined, [enabled, registry]);
  const subscribe = React.useMemo(() => (notify: () => void) => {
    const releases = hostIds.map((id) => registry?.subscribeHost(id, notify));
    return () => releases.forEach((release) => release?.());
  }, [registry, hostIds]);
  const read = React.useMemo(() => () => hostIds.map((id) => {
    const project = remoteProjects.find((project) => project.hostId === id);
    const generation = registry && project ? registry.resolve({ hubId: registry.hubId, hostId: id, directory: project.path }).connectionGeneration : 0;
    return `${id}:${registry?.getHost(id)?.state}:${generation}`;
  }).join('|'), [registry, hostIds, remoteProjects]);
  const hostRevision = React.useSyncExternalStore(subscribe, read, read);
  const { snapshots, errors } = useQueries({ queries: hostIds.map((id) => ({ ...remoteHostSummariesQueryOptions(registry, id), enabled: enabled && Boolean(registry) })), combine: combineSummaries }, queryClient);
  const [pageRequests, setPageRequests] = React.useState<Record<string, { hubId: string; hostId: string; directory: string; cursor?: string }>>({});
  const requests = React.useMemo(() => Object.values(pageRequests).filter((request) => request.hubId === registry?.hubId && hostIds.includes(request.hostId)), [pageRequests, registry, hostIds]);
  const pageQueries = useQueries({ queries: requests.map((request) => {
    const entry = registry?.resolve({ hubId: registry.hubId, hostId: request.hostId, directory: request.directory });
    return { queryKey: [...(entry?.queryScope ?? ['unavailable']), 'mobile-status-pages', request.cursor ?? null], enabled: enabled && Boolean(entry), staleTime: Infinity, retry: false,
      queryFn: async ({ signal }: { signal: AbortSignal }) => {
        if (!entry) throw new Error('Remote Host unavailable');
        const response = await entry.sdk().session.list({ directory: request.directory, parentID: null, limit: 30, ...(request.cursor ? { cursor: request.cursor } : {}) }, { signal });
        entry.sdk();
        if (!Array.isArray(response.data)) throw new Error('Invalid remote session page');
        const next = response.cursor?.next || undefined;
        return { hostId: request.hostId, directory: request.directory, sessions: response.data.map(projectSession), next: next !== request.cursor ? next : undefined };
      } };
  }), combine: combinePages }, queryClient);
  const pageData = React.useMemo(() => pageQueries.map((query) => query.data), [pageQueries]);
  const sessions = React.useMemo(() => {
    const result: RemoteMobileStatusSession[] = [];
    if (!registry) return result;
    for (const snapshot of snapshots) {
      if (!snapshot) continue;
      const rawRows = new Map<string, { session: Session | RemoteHostSummaries['directories'][number]['sessions'][number]; directory: string }>();
      for (const bucket of snapshot.directories) for (const session of bucket.sessions) rawRows.set(locationSessionKey({ hubId: registry.hubId, hostId: snapshot.hostId, directory: bucket.directory }, session.id), { session, directory: bucket.directory });
      for (const page of pageData) if (page?.hostId === snapshot.hostId) {
        for (const session of page.sessions) {
          const key = locationSessionKey({ hubId: registry.hubId, hostId: snapshot.hostId, directory: page.directory }, session.id);
          if (!rawRows.has(key)) rawRows.set(key, { session, directory: page.directory });
        }
      }
      const identities = new Map([...rawRows.values()].map(({ session, directory }) => [session.id, locationSessionKey({ hubId: registry.hubId, hostId: snapshot.hostId, directory }, session.id)]));
      for (const { session, directory } of rawRows.values()) {
        const project = resolveRemoteProjectOwner(projects, registry.hubId, snapshot.hostId, directory, snapshot.worktrees);
        if (!project || session.time?.archived) continue;
        const entry = registry.resolve({ hubId: registry.hubId, hostId: snapshot.hostId, directory });
        result.push({ ...session, id: locationSessionKey(entry.location, session.id), parentID: session.parentID ? identities.get(session.parentID) ?? session.parentID : undefined,
          directory, _remote: { registry, entry, project, sessionId: session.id, directory, snapshot } } as RemoteMobileStatusSession);
      }
    }
    return result;
  // Re-resolve fenced entries when a Host reconnects without changing its summary DTO.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects, registry, hostRevision, snapshots, pageData]);
  const refresh = useEvent(async (hostId?: string) => {
    if (!registry) throw new Error('Remote Host unavailable');
    await Promise.all((hostId ? [hostId] : hostIds).map((id) => refreshRemoteHostSummaries(registry, id)));
  });
  const forProject = React.useMemo(() => (project: ProjectEntry) => registry && project.hostId && project.hubId === registry.hubId
    ? { registry, entry: registry.resolve({ hubId: registry.hubId, hostId: project.hostId, directory: project.path }), snapshot: snapshots.find((snapshot) => snapshot?.hostId === project.hostId) } : undefined,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Reconnect invalidates captured entries even if summary DTO identity is unchanged.
    [registry, snapshots, hostRevision]);
  const loadMore = useEvent((project: ProjectEntry, directory: string) => {
    if (!registry || !project.hostId || project.hubId !== registry.hubId) return;
    const index = lastDirectoryRequest(requests, project.hostId, directory);
    const previous = pageQueries[index];
    if (previous?.isFetching) return;
    if (previous?.error) { void previous.refetch(); return; }
    if (previous?.data && !previous.data.next) return;
    const entry = registry.resolve({ hubId: registry.hubId, hostId: project.hostId, directory });
    const cursor = previous?.data?.next;
    setPageRequests((previous) => ({ ...previous, [JSON.stringify([entry.key, cursor])]: { hubId: registry.hubId, hostId: project.hostId!, directory, cursor } }));
  });
  const pagination = (project: ProjectEntry, directory: string) => {
    const index = lastDirectoryRequest(requests, project.hostId, directory);
    const page = pageQueries[index];
    return { hasMore: page?.error ? true : page?.data ? Boolean(page.data.next) : forProject(project)?.snapshot?.directories.find((entry) => entry.directory === directory)?.hasMore ?? false, loadingMore: page?.isFetching ?? false };
  };
  const unavailable = Boolean(remoteProjects.length && (!registry || hostIds.some((id, index) => registry.getHost(id)?.state !== 'connected' || !snapshots[index] || snapshots[index]?.stale)));
  return { registry, sessions, refresh, forProject, loadMore, pagination, unavailable, errors: [...errors, ...pageQueries.flatMap((query) => query.error ? [query.error] : [])], error: discovery.error };
}
