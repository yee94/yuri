import React from 'react';
import { SessionGroupSection } from './SessionGroupSection';
import type { SessionGroup, SessionNode, GroupSearchData } from './types';
import type { useRemoteProjectSectionModel } from './hooks/useRemoteProjectSectionModel';
import { RemoteSummaryRow } from './RemoteProjectRows';
import { RemoteChildSessions } from './RemoteProjectResources';
import type { RemoteProject } from '@/lib/remote-projects/types';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { getDefaultProjectGroupVisibleCount } from './sessionNavigationModel';

/** Adapts Host-owned data and commands to the existing sidebar group renderer. */
export function RemoteSessionGroups({ model, project, registry }: {
  model: ReturnType<typeof useRemoteProjectSectionModel>; project: RemoteProject; registry: HostRuntimeRegistry;
}) {
  const { data } = model;
  const { groups, query, snapshot, pinnedIds, online } = data;
  const { filterSessionNodesForSearch, buildGroupSearchText } = data.grouping;
  const [collapsed, setCollapsed] = React.useState(() => new Set<string>());
  const [limits, setLimits] = React.useState<Record<string, number>>({});
  const [renamingFolderId, setRenamingFolderId] = React.useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = React.useState('');
  const emptySet = React.useMemo(() => new Set<string>(), []);
  const alwaysVisible = React.useMemo(() => new Set(model.selectedSession ? [model.selectedSession] : []), [model.selectedSession]);
  const liveSessions = React.useMemo(() => new Map(data.rows.map(({ session }) => [session.id, session])), [data.rows]);
  const searchData = React.useMemo(() => {
    const result = new WeakMap<SessionGroup, GroupSearchData>();
    for (const group of groups) {
      const filteredNodes = filterSessionNodesForSearch(group.sessions, query);
      const groupMatches = buildGroupSearchText(group).includes(query);
      result.set(group, { filteredNodes, groupMatches, matchedSessionCount: filteredNodes.length, folderNameMatchCount: 0, hasMatch: groupMatches || filteredNodes.length > 0 });
    }
    return result;
  }, [groups, query, filterSessionNodesForSearch, buildGroupSearchText]);
  const renderRow = (node: SessionNode, depth = 1, directory?: string | null): React.ReactNode => {
    const scope = node.session.directory || directory || project.path;
    const session = liveSessions.get(node.session.id) ?? { ...node.session, time: node.session.time ?? {} };
    return <React.Fragment key={node.session.id}>
      <RemoteSummaryRow {...model.sessionProps(session, scope)} depth={depth} />
      {'hasChildren' in session && session.hasChildren ? <RemoteChildSessions registry={registry} hostId={project.hostId} directory={scope} sessionId={node.session.id}
        disabled={!online} depth={depth + 1} pinnedSessionIds={snapshot?.pinnedSessionIds} onVisibleTargets={model.reportChildTargets}
        renderRow={(session, childScope, childDepth) => renderRow({ session, children: [], worktree: null }, childDepth, childScope)} /> : null}
    </React.Fragment>;
  };
  const folders = snapshot?.folders;
  const folderCommand = (scope: string, id: string) => {
    const folder = folders?.foldersMap[scope]?.find((candidate) => candidate.id === id);
    return folder ? model.folderProps(folder, scope) : null;
  };
  return <>{groups.filter((group) => !query || searchData.get(group)?.hasMatch).map((group) => {
    const key = `${project.id}:${group.id}`;
    const scope = group.folderScopeKey || group.directory || project.path;
    const source = { folders: folders?.foldersMap[scope] ?? [], actionsDisabled: !online || model.pending,
      pagination: { hasMore: data.directories.find((entry) => entry.directory === group.directory)?.hasMore ?? false, loadingMore: data.loadingMore } };
    return <SessionGroupSection key={key} group={group} groupKey={key} projectId={project.id} projectLabel={model.projectProps.label}
      onVisibleSessions={model.reportGroupTargets}
      source={source} hideGroupLabel={group.isMain} hasSessionSearchQuery={Boolean(query)} normalizedSessionSearchQuery={query} groupSearchDataByGroup={searchData}
      visibleSessionCount={limits[key]} collapsedGroups={collapsed} collapsedFolderIds={new Set(folders?.collapsedFolderIds ?? [])}
      toggleFolderCollapse={(id) => folderCommand(scope, id)?.onToggle()} renameFolder={(directory, id, name) => folderCommand(directory, id)?.onRename(name)}
      deleteFolder={(directory, id) => folderCommand(directory, id)?.onDelete()} showDeletionDialog={false} setDeleteFolderConfirm={() => {}}
      renderSessionNode={renderRow} projectRepoStatus={new Map([[project.id, model.projectProps.isRepo]])} lastRepoStatus={false}
      showMoreGroupSessions={(_, groupKey, count) => { const next = count + getDefaultProjectGroupVisibleCount(); setLimits((previous) => ({ ...previous, [groupKey]: next })); if (source.pagination.hasMore) data.setPageLimit((previous) => Math.max(next, previous + 30)); }}
      resetGroupSessionLimit={(groupKey) => setLimits((previous) => ({ ...previous, [groupKey]: getDefaultProjectGroupVisibleCount() }))}
      mobileVariant={false} alwaysShowActions={false} activeProjectId={model.projectProps.active ? project.id : null}
      setActiveProjectIdOnly={() => {}} setActiveMainTab={() => {}} setSessionSwitcherOpen={() => {}}
      openNewSessionDraft={(options) => { if (online && !model.pending) model.openDraft(options?.directoryOverride || group.directory || project.path, options?.targetFolderId); }}
      addSessionToFolder={(directory, folderId, sessionId) => { void model.moveSessions(directory, [sessionId], folderId); }}
      createFolderAndStartRename={(directory, parentId) => { model.setEditor({ kind: 'folder', id: directory, parentId, value: '' }); return null; }}
      renamingFolderId={renamingFolderId} renameFolderDraft={renameFolderDraft} setRenameFolderDraft={setRenameFolderDraft} setRenamingFolderId={setRenamingFolderId}
      pinnedSessionIds={pinnedIds} expandedParents={emptySet} sessionOrderByScope={snapshot?.order?.sessionOrderByScope ?? {}}
      sessionOrderActivityByScope={snapshot?.order?.sessionOrderActivityByScope ?? {}}
      onReorderSessions={(_, __, activeId, overId) => { const folderId = source.folders.find((folder) => folder.sessionIds.includes(overId))?.id ?? null; void model.moveSessions(scope, [activeId], folderId, overId); }}
      currentSessionId={model.selectedSession} editingId={null} editTitle="" openSidebarMenuKey={null} liveSessionById={liveSessions} alwaysVisibleSessionIds={alwaysVisible}
      onToggleCollapsedGroup={(_, groupKey) => setCollapsed((previous) => { const next = new Set(previous); if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey); return next; })} />;
  })}</>;
}
