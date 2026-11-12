import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { useRemoteHost } from '@/contexts/HostRuntimeProvider';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';
import { resolveRemoteProjectOwner } from '@/lib/remote-projects/summaries';
import { queryClient } from '@/lib/queryRuntime';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { isVisibleGlobalSession } from '@/stores/globalSessions';
import { projectSession, type Session } from '@/lib/opencode/v2-types';
import { buildRemoteFolderView } from '../remoteSessionFolders';
import { remoteSummaryOptions, useRemoteSummaries } from './useRemoteProjectNavigation';

/** Host-scoped reads and one projection for rendering, keyboard navigation and drag order. */
export function useRemoteProjectSectionData(project: RemoteProject, registry: HostRuntimeRegistry, search: string) {
  const host = useRemoteHost(registry, project.hostId);
  const summaries = useRemoteSummaries(registry, project.hostId);
  const online = host?.state === 'connected' && project.remoteState === 'ok';
  const query = search.trim().toLocaleLowerCase();
  const snapshot = summaries.data;
  const registeredProjects = useProjectsStore((state) => state.projects);
  const ownsDirectory = React.useMemo(() => (directory: string) => {
    return resolveRemoteProjectOwner(registeredProjects, registry.hubId, project.hostId, directory, snapshot?.worktrees)?.id === project.id;
  }, [registeredProjects, registry.hubId, project.id, project.hostId, snapshot?.worktrees]);
  const [pageLimit, setPageLimit] = React.useState(0);
  const directoryPaths = (snapshot?.directories ?? []).map((directory) => directory.directory).filter(ownsDirectory);
  const moreSessions = useQuery({
    queryKey: [...registry.resolve({ hubId: registry.hubId, hostId: project.hostId, directory: project.path }).queryScope, 'navigation-pages', pageLimit, directoryPaths],
    enabled: online && pageLimit > 0,
    queryFn: async ({ signal }) => {
      const pages: Array<{ directory: string; sessions: Session[]; hasMore: boolean }> = [];
      // User-driven bounded pages, serial across directories: one slow Host cannot fan out a project-sized request burst.
      for (const directory of directoryPaths) {
        const entry = registry.resolve({ hubId: registry.hubId, hostId: project.hostId, directory });
        const sessions: Session[] = [];
        let cursor: string | undefined;
        let hasMore = false;
        for (let pageIndex = 0; pageIndex < Math.ceil(pageLimit / 30); pageIndex++) {
          const response = await entry.sdk().session.list({ directory, parentID: null, limit: 30, ...(cursor ? { cursor } : {}) }, { signal });
          registry.assertCurrent();
          if (!Array.isArray(response.data)) throw new Error('Remote session list returned no data');
          sessions.push(...response.data.map(projectSession).filter((session) => isVisibleGlobalSession(session)).map((session) => ({ ...session, directory: session.directory || directory })));
          const next: string | undefined = response.cursor?.next || undefined;
          hasMore = Boolean(next && next !== cursor);
          if (!hasMore) break;
          cursor = next;
        }
        pages.push({ directory, sessions, hasMore });
      }
      return pages;
    },
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === registry.hubId && previousQuery.queryKey[2] === project.hostId ? previous : undefined,
    staleTime: 30_000,
  });
  const titleSearch = useQuery({
    queryKey: [...remoteSummaryOptions(registry, project.hostId).queryKey, 'title-search', query],
    enabled: online && Boolean(query),
    queryFn: ({ signal }) => registry.resolve({ hubId: registry.hubId, hostId: project.hostId, directory: '/' }).service().searchSessionsByTitle({ search: query, limit: 1000, signal }),
    staleTime: 30_000,
  });
  const directories = React.useMemo(() => {
    const entries = (snapshot?.directories ?? []).filter((entry) => ownsDirectory(entry.directory));
    if ((!query || !titleSearch.data) && !moreSessions.data) return entries;
    const merged = new Map(entries.map((entry) => [entry.directory, { ...entry, sessions: [...entry.sessions] }]));
    for (const page of moreSessions.data ?? []) {
      const existing = merged.get(page.directory);
      if (existing) existing.hasMore = page.hasMore;
    }
    for (const session of [...(query ? titleSearch.data ?? [] : []), ...(moreSessions.data?.flatMap((page) => page.sessions) ?? [])]) {
      if (!isVisibleGlobalSession(session)) continue;
      if (!session.directory || !ownsDirectory(session.directory)) continue;
      let directory = merged.get(session.directory);
      if (!directory) { directory = { directory: session.directory, sessions: [], hasMore: false, cursor: null, lastSyncedAt: 0 }; merged.set(session.directory, directory); }
      const index = directory.sessions.findIndex((candidate) => candidate.id === session.id);
      if (index < 0) directory.sessions.push({ ...session, time: session.time ?? {} });
      else if ((session.time?.updated ?? 0) > (directory.sessions[index].time.updated ?? 0)) directory.sessions[index] = { ...directory.sessions[index], ...session, time: session.time ?? directory.sessions[index].time };
    }
    return [...merged.values()];
  }, [snapshot, titleSearch.data, moreSessions.data, query, ownsDirectory]);
  const rows = React.useMemo(() => directories.flatMap((directory) => directory.sessions.map((session) => ({ session, directory: directory.directory }))), [directories]);
  const matching = React.useMemo(() => query ? rows.filter(({ session }) => (session.title ?? '').toLocaleLowerCase().includes(query)) : rows, [query, rows]);
  const views = React.useMemo(() => {
    const pinned = new Set(snapshot?.pinnedSessionIds ?? []);
    return directories.map((directory) => ({ directory, view: buildRemoteFolderView(matching.filter((row) => row.directory === directory.directory),
      snapshot?.folders?.foldersMap[directory.directory] ?? [], snapshot?.order?.sessionOrderByScope[directory.directory] ?? [], pinned) }));
  }, [directories, matching, snapshot]);
  const busy = online && rows.some(({ session }) => {
    const status = (session.metadata as { yuri?: { sessionStatus?: { type?: string } } } | undefined)?.yuri?.sessionStatus?.type;
    return status === 'busy' || status === 'retry';
  });
  const refresh = useEvent(async () => {
    await queryClient.invalidateQueries({ queryKey: remoteSummaryOptions(registry, project.hostId).queryKey, exact: true });
    const locations = new Set(directoryPaths.map((directory) => registry.resolve({ hubId: registry.hubId, hostId: project.hostId, directory }).key));
    await queryClient.invalidateQueries({ predicate: (query) => query.queryKey[1] === registry.hubId && query.queryKey[2] === project.hostId && locations.has(String(query.queryKey[3])) && query.queryKey[5] === 'navigation-children' });
    if (pageLimit && online) await moreSessions.refetch({ throwOnError: true });
    if (query && online) await titleSearch.refetch({ throwOnError: true });
  });
  return { host, online, query, snapshot, directories, rows, views, busy, refresh, setPageLimit,
    hidden: Boolean(query && matching.length === 0 && snapshot),
    loading: summaries.isPending, loadingMore: moreSessions.isFetching,
    error: summaries.error?.message || titleSearch.error?.message || moreSessions.error?.message };
}
