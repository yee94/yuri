import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';
import type { SessionIndexSession } from '@/lib/session-index-api';
import { readRemoteResponse } from '@/queries/remoteProjectQueries';
import { queryClient } from '@/lib/queryRuntime';
import { cn } from '@/lib/utils';
import { isVisibleGlobalSession } from '@/stores/globalSessions';
import { projectSession } from '@/lib/opencode/v2-types';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP } from '@/lib/projectMeta';
import { SessionBusyIndicator } from '../SessionBusyIndicator';
import { createSessionNodeComparator } from './sessionSortableOrder';
import { toast } from '@/components/ui';

/** Optional resources stay on leaf observers, separate from the project summary and command lifetimes. */
export function RemoteProjectIcon({ project, registry, className }: { project: RemoteProject; registry: HostRuntimeRegistry; className: string }) {
  const entry = registry.resolve({ hubId: registry.hubId, hostId: project.hostId, directory: project.path });
  const image = useQuery({
    queryKey: [...entry.queryScope, 'project-icon', project.remoteProjectId, project.iconImage?.updatedAt],
    enabled: Boolean(project.iconImage),
    queryFn: async ({ signal }) => {
      const response = await entry.fetch(`/api/projects/${encodeURIComponent(project.remoteProjectId)}/icon`, { signal, headers: { Accept: 'image/*' }, query: { v: project.iconImage?.updatedAt ?? 0 } });
      if (!response.ok) { await readRemoteResponse(response); throw new Error('Remote project icon unavailable'); }
      if (Number(response.headers.get('content-length')) > 5 * 1024 * 1024) throw new Error('Remote project icon exceeds size limit');
      const blob = await response.blob();
      if (blob.size > 5 * 1024 * 1024) throw new Error('Remote project icon exceeds size limit');
      registry.assertCurrent();
      if (registry.resolve(entry.location).connectionGeneration !== entry.connectionGeneration) throw new Error('Remote icon connection changed');
      return blob;
    },
    staleTime: Infinity,
    gcTime: 0,
  });
  const [resource, setResource] = React.useState<{ blob: Blob; url: string } | null>(null);
  const [failedBlob, setFailedBlob] = React.useState<Blob | null>(null);
  React.useEffect(() => {
    if (!image.data || typeof URL.createObjectURL !== 'function') return;
    const url = URL.createObjectURL(image.data);
    setResource({ blob: image.data, url });
    return () => URL.revokeObjectURL(url);
  }, [image.data]);
  const color = project.color ? PROJECT_COLOR_MAP[project.color] : undefined;
  return resource?.blob === image.data && resource?.url && failedBlob !== resource.blob ? <img src={resource.url} alt="" className={cn(className, 'object-contain')} onError={() => setFailedBlob(resource.blob)} /> : <Icon name={project.icon ? PROJECT_ICON_MAP[project.icon] ?? 'folder-open' : 'folder-open'} className={className} style={color ? { color } : undefined} />;
}

export function RemoteChildSessions({ registry, hostId, directory, sessionId, disabled, depth, renderRow, pinnedSessionIds, onVisibleTargets }: {
  registry: HostRuntimeRegistry; hostId: string; directory: string; sessionId: string; disabled: boolean; depth: number;
  renderRow(session: SessionIndexSession, directory: string, depth: number): React.ReactNode;
  pinnedSessionIds?: string[];
  onVisibleTargets(parentId: string, targets: Array<{ sessionId: string; directory: string }>): void;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = React.useState(false);
  const [limit, setLimit] = React.useState(30);
  const entry = registry.resolve({ hubId: registry.hubId, hostId, directory });
  const query = useQuery({
    queryKey: [...entry.queryScope, 'navigation-children', sessionId, limit],
    enabled: expanded && !disabled,
    queryFn: async ({ signal }) => {
      const sessions: SessionIndexSession[] = [];
      let cursor: string | undefined;
      let hasMore = false;
      for (let page = 0; page < Math.ceil(limit / 30); page++) {
        const response = await entry.sdk().session.list({ directory, parentID: sessionId, limit: 30, ...(cursor ? { cursor } : {}) }, { signal });
        registry.assertCurrent();
        if (!Array.isArray(response.data)) throw new Error('Remote child session list returned no data');
        sessions.push(...response.data.map(projectSession).filter((session) => isVisibleGlobalSession(session, { includeChildren: true })).map((session) => ({ ...session, directory: session.directory || directory, time: session.time ?? {} })));
        const next: string | undefined = response.cursor?.next || undefined;
        hasMore = Boolean(next && next !== cursor);
        if (!hasMore) break;
        cursor = next;
      }
      return { sessions, hasMore };
    },
    staleTime: 30_000,
    placeholderData: (previous, previousQuery) => previousQuery?.queryKey[1] === registry.hubId && previousQuery.queryKey[2] === hostId && previousQuery.queryKey[3] === entry.key && previousQuery.queryKey[6] === sessionId ? previous : undefined,
  });
  const sortedChildren = React.useMemo(() => {
    const rows = (query.data?.sessions ?? []).map((session) => ({ session, directory: session.directory || directory }));
    return rows.sort(createSessionNodeComparator(rows, undefined, undefined, new Set(pinnedSessionIds)));
  }, [query.data?.sessions, directory, pinnedSessionIds]);
  const { error, refetch } = query;
  React.useEffect(() => {
    if (error) toast.error(error.message, { id: `remote-children:${entry.key}:${sessionId}`, action: { label: t('remoteProjects.retry'), onClick: () => void refetch() } });
  }, [error, entry.key, sessionId, refetch, t]);
  React.useLayoutEffect(() => { onVisibleTargets(sessionId, expanded ? sortedChildren.map(({ session, directory }) => ({ sessionId: session.id, directory })) : []); }, [onVisibleTargets, sessionId, expanded, sortedChildren]);
  React.useEffect(() => () => onVisibleTargets(sessionId, []), [onVisibleTargets, sessionId]);
  const onEvent = useEvent(({ directory: eventDirectory, payload }: { directory?: string; payload: unknown }) => {
    if (eventDirectory && eventDirectory !== directory) return;
    if (!payload || typeof payload !== 'object' || !('type' in payload) || typeof payload.type !== 'string') return;
    if (/^(session\.(created|updated|deleted|status)|yuri:session-metadata)$/.test(payload.type)) {
      void queryClient.invalidateQueries({ queryKey: [...entry.queryScope, 'navigation-children', sessionId, limit], exact: true });
    }
  });
  React.useEffect(() => {
    if (expanded && !disabled) return registry.subscribeEvents(hostId, onEvent);
  }, [registry, hostId, directory, expanded, disabled, onEvent]);
  return <div className="min-w-0 pl-4">
    <Button size="xs" variant="ghost" disabled={disabled && !query.data} onClick={() => setExpanded((value) => !value)}>{t(expanded ? 'sessions.sidebar.session.subsessions.collapse' : 'sessions.sidebar.session.subsessions.expand')}</Button>
    {expanded ? <>
      {query.isFetching && !query.data ? <SessionBusyIndicator /> : null}
      {sortedChildren.map(({ session, directory }) => <React.Fragment key={session.id}>{renderRow(session, directory, depth)}</React.Fragment>)}
      {query.data?.hasMore ? <Button size="xs" variant="ghost" disabled={disabled || query.isFetching} onClick={() => setLimit((value) => value + 30)}>{t('remoteProjects.showMore')}</Button> : null}
    </> : null}
  </div>;
}
