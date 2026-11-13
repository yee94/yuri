import React from 'react';
import { useI18n } from '@/lib/i18n';
import { MobileProjectGroups, type MobileProjectHomeItem } from '@/mobile/projects/MobileProjectsHome';
import { MobileSessionRow } from '@/mobile/projects/MobileSessionRow';
import { listProjectAreaRootSessions } from '@/mobile/projects/useMobileProjectsHomeModel';
import { getMobileSessionDefaultVisibleCount, getMobileSessionShowMoreIncrement } from '@/apps/mobileSessionPagination';
import { useMobileSessionTreeStore } from '@/stores/useMobileSessionTreeStore';
import { createSessionNodeComparator } from './sessionSortableOrder';
import { selectVisibleSessions } from './sessionNavigationModel';
import { DraggableSessionRow, SessionFolderDndScope } from './sessionFolderDnd';
import { MobileRemoteSummaryRow } from './RemoteProjectMobileViews';
import type { useRemoteProjectSectionModel } from './hooks/useRemoteProjectSectionModel';
import type { RemoteProject } from '@/lib/remote-projects/types';

const noAction = () => {};

/** Host data adapter for the same mobile workspace groups, rows and drag surface. */
export function RemoteMobileSessionGroups({ model, project }: { model: ReturnType<typeof useRemoteProjectSectionModel>; project: RemoteProject }) {
  const { t } = useI18n();
  const { data } = model;
  const expanded = useMobileSessionTreeStore((state) => state.worktreeExpanded);
  const setExpanded = useMobileSessionTreeStore((state) => state.setWorktreeExpanded);
  const [limits, setLimits] = React.useState<Record<string, number>>({});
  const defaultLimit = getMobileSessionDefaultVisibleCount();
  const alwaysVisible = new Set(data.rows.filter(({ session }) => {
    const props = model.sessionProps(session, session.directory || project.path);
    return props.active || props.status === 'busy' || props.status === 'retry';
  }).map(({ session }) => session.id));
  const buckets = data.groups.map((group) => {
    const scope = group.directory || project.path;
    const nodes = group.sessions;
    const roots = listProjectAreaRootSessions(nodes.map((node) => node.session), data.pinnedIds).map((session) => ({ session }));
    roots.sort(createSessionNodeComparator(roots, data.snapshot?.order?.sessionOrderByScope[scope], data.snapshot?.order?.sessionOrderActivityByScope[scope], data.pinnedIds));
    const sessions = selectVisibleSessions(roots.map(({ session }) => session), limits[scope] ?? defaultLimit, alwaysVisible);
    return { group, scope, roots, sessions };
  });
  const view: MobileProjectHomeItem = { id: project.id, name: model.projectProps.label, path: project.path,
    expanded: !model.projectProps.collapsed, sessionCount: data.rows.length,
    worktrees: buckets.map(({ group, scope, sessions, roots }) => ({ id: group.id, name: group.label, path: scope,
      kind: group.isMain ? 'main' : 'worktree', expanded: expanded[`${project.id}::${scope}`] ?? false,
      sessionCount: roots.length, sessions: sessions.map((session) => ({ id: session.id, title: session.title || t('mobile.sessions.untitled') })) })) };
  return <MobileProjectGroups project={view}
    onToggleWorktree={(_, worktree) => setExpanded(`${project.id}::${worktree.path}`, !worktree.expanded)}
    onNewWorktreeSession={(_, worktree) => { if (data.online && !model.pending) model.openDraft(worktree.path); }}
    renderSessions={(worktree) => {
      const bucket = buckets.find(({ group }) => group.id === worktree.id)!;
      const ids = bucket.sessions.map((session) => session.id);
      const folderIds = new Map(ids.map((id) => [id, data.snapshot?.folders?.foldersMap[bucket.scope]?.find((folder) => folder.sessionIds.includes(id))?.id ?? null]));
      const hasMore = data.directories.some((entry) => entry.directory === bucket.scope && entry.hasMore);
      const count = limits[bucket.scope] ?? defaultLimit;
      return <SessionFolderDndScope scopeKey={data.online && !model.pending ? bucket.scope : null} sessionIds={ids} folderIdBySessionId={folderIds}
        onSessionDroppedOnFolder={(id, folderId) => { void model.moveSessions(bucket.scope, [id], folderId); }}
        onSessionsReordered={(id, overId) => { void model.moveSessions(bucket.scope, [id], folderIds.get(overId) ?? null, overId); }}>
        {bucket.sessions.map((session) => {
          const scope = session.directory || bucket.scope;
          return <DraggableSessionRow key={session.id} sessionId={session.id} sessionDirectory={scope} sessionTitle={session.title || ''}>
            <MobileRemoteSummaryRow {...model.sessionProps({ ...session, time: session.time ?? {} }, scope)} />
          </DraggableSessionRow>;
        })}
        {count > defaultLimit && bucket.roots.length > defaultLimit ? <MobileSessionRow session={{ id: `fewer:${bucket.scope}`, kind: 'pagination', title: t('sessions.sidebar.group.showFewer') }}
          onPin={noAction} onArchive={noAction} onOpenActions={noAction} onSelect={() => setLimits((previous) => ({ ...previous, [bucket.scope]: defaultLimit }))} /> : null}
        {bucket.roots.length > bucket.sessions.length || hasMore ? <MobileSessionRow session={{ id: `more:${bucket.scope}`, kind: 'pagination', title: t('sessions.sidebar.group.showMore') }}
          onPin={noAction} onArchive={noAction} onOpenActions={noAction} onSelect={() => { const next = count + getMobileSessionShowMoreIncrement(); setLimits((previous) => ({ ...previous, [bucket.scope]: next })); if (hasMore && data.online) data.setPageLimit((previous) => Math.max(next, previous + 30)); }} /> : null}
      </SessionFolderDndScope>;
    }} />;
}
