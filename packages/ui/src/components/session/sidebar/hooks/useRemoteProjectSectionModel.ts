import React from 'react';
import { useEvent } from '@reactuses/core';
import type { DragEndEvent } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { useI18n } from '@/lib/i18n';
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';
import type { SessionIndexSession } from '@/lib/session-index-api';
import type { SessionNavigationTarget } from '@/sync/session-navigation';
import { createRemoteProject, readRemoteResponse } from '@/queries/remoteProjectQueries';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { openRemoteProjectSession } from '@/router/openRemoteProjectSession';
import { createUuid } from '@/lib/uuid';
import { toast } from '@/components/ui';
import { visibleRemoteRows, canMoveRemoteFolder, type RemoteDragItem, type RemoteFolderNode } from '../remoteSessionFolders';
import type { RemoteProjectShellProps, RemoteSummaryRowProps, RemoteFolderBranchProps } from '../remoteProjectPresentation';
import type { RemoteSummarySnapshot } from './useRemoteProjectNavigation';
import { useRemoteProjectSectionData } from './useRemoteProjectSectionData';

const writes = new WeakMap<HostRuntimeRegistry, Map<string, Promise<void>>>();
function serializeWrite(registry: HostRuntimeRegistry, hostId: string, action: () => Promise<void>) {
  let hosts = writes.get(registry);
  if (!hosts) writes.set(registry, hosts = new Map());
  const flight = (hosts.get(hostId) ?? Promise.resolve()).catch(() => {}).then(action);
  hosts.set(hostId, flight);
  const finish = () => { if (hosts.get(hostId) === flight) hosts.delete(hostId); };
  void flight.then(finish, finish);
  return flight;
}

export type RemoteProjectSectionOptions = {
  project: RemoteProject; registry: HostRuntimeRegistry; search?: string; mobile?: boolean; reorderEnabled?: boolean;
  onNavigationTargets?: (projectId: string, targets: SessionNavigationTarget[]) => void;
};

/** Owns only one Host's summary snapshot. No local sync-store or local session mutation is used. */
export function useRemoteProjectSectionModel({ project, registry, search = '', mobile = false, reorderEnabled = true, onNavigationTargets }: RemoteProjectSectionOptions) {
  const { t } = useI18n();
  const data = useRemoteProjectSectionData(project, registry, search);
  const { online, query, snapshot, rows, views, directories, refresh } = data;
  const active = useProjectsStore((state) => state.activeProjectId === project.id);
  const selectedSession = useSessionNavigationStore((state) => state.remoteSession?.projectId === project.id ? state.remoteSession.sessionId : null);
  const [selected, setSelected] = React.useState<Map<string, string>>(new Map());
  const [worktreeOpen, setWorktreeOpen] = React.useState(false);
  const [childTargets, setChildTargets] = React.useState<Map<string, Array<{ sessionId: string; directory: string }>>>(new Map());
  const reportChildTargets = useEvent((parentId: string, targets: Array<{ sessionId: string; directory: string }>) => setChildTargets((previous) => {
    const current = previous.get(parentId) ?? [];
    if (current.length === targets.length && current.every((target, index) => target.sessionId === targets[index].sessionId && target.directory === targets[index].directory)) return previous;
    const next = new Map(previous);
    if (targets.length) next.set(parentId, targets); else next.delete(parentId);
    return next;
  }));
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [editor, setEditor] = React.useState<{ kind: 'title' | 'folder' | 'project'; id?: string; directory?: string; folderId?: string; parentId?: string | null; value: string } | null>(null);
  const [projectIcon, setProjectIcon] = React.useState(project.icon ?? '');
  const [projectColor, setProjectColor] = React.useState(project.color ?? '');
  const flightRef = React.useRef(false);
  const mutate = useEvent(async (action: () => Promise<void>) => {
    if (flightRef.current) return;
    flightRef.current = true;
    setPending(true); setError(null);
    try {
      await serializeWrite(registry, project.hostId, async () => { registry.assertCurrent(); await action(); registry.assertCurrent(); });
      await refresh();
    } catch (cause) { const message = cause instanceof Error ? cause.message : String(cause); setError(message); toast.error(message); }
    finally { flightRef.current = false; setPending(false); }
  });
  const entryFor = (directory: string) => registry.resolve({ hubId: registry.hubId, hostId: project.hostId, directory });
  const request = async (directory: string, path: string, method: string, body?: unknown, captured?: HostRuntimeEntry) => {
    const entry = captured ?? entryFor(directory);
    const response = await entry.fetch(path, { method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    if (!response.ok) await readRemoteResponse(response);
    return response;
  };
  const updateRows = (ids: string[], patch: { title?: string; time?: { archived?: number | null } }, directoryHint?: string) => mutate(async () => {
    const failures: string[] = [];
    for (const id of ids) {
      const directory = rows.find(({ session }) => session.id === id)?.directory ?? selected.get(id) ?? directoryHint;
      if (!directory) { failures.push('Missing remote session directory'); continue; }
      try { await entryFor(directory).service().updateSession(id, patch, directory); }
      catch (cause) { failures.push(cause instanceof Error ? cause.message : String(cause)); }
    }
    await refresh();
    if (failures.length) throw new Error(failures.join('\n'));
    setSelected(new Map()); setEditor(null);
  });
  const updateFolder = (directory: string, operation: (snapshot: NonNullable<RemoteSummarySnapshot['folders']>) => void, onConfirmed?: () => void) => online ? mutate(async () => {
    const entry = entryFor(directory);
    const payload = await readRemoteResponse(await entry.fetch('/api/session-folders')) as NonNullable<RemoteSummarySnapshot['folders']>;
    if (registry.resolve(entry.location).connectionGeneration !== entry.connectionGeneration) throw new Error(t('remoteProjects.host-unavailable'));
    if (!payload || !payload.foldersMap || !Array.isArray(payload.collapsedFolderIds)) throw new Error(t('remoteProjects.invalidFolders'));
    operation(payload);
    await request(directory, '/api/session-folders', 'POST', { ...payload, updatedAt: Date.now() }, entry);
    onConfirmed?.();
    setEditor(null);
  }) : Promise.resolve();
  const toggleCollapse = useEvent(() => {
    // Layout is Hub-owned; metadata never goes through the remote mutation endpoint.
    useProjectsStore.getState().setProjectCollapsed(project.id, !project.sidebarCollapsed);
  });
  const syncProject = useEvent(() => {
    void mutate(async () => {
      if (project.remoteState === 'remote-removed') {
        const restored = await createRemoteProject(registry, project.hostId, project.path, project.label);
        useProjectsStore.getState().upsertRemoteProject(restored, registry.hubId);
      } else {
        const response = await registry.requestHost(project.hostId, 'connect', { method: 'POST' });
        if (!response.ok) await readRemoteResponse(response);
      }
      await refresh();
    });
  });
  const saveEditor = () => {
    if (!editor?.value.trim()) return;
    if (editor.kind === 'title' && editor.id) { void updateRows([editor.id], { title: editor.value.trim() }, editor.directory); return; }
    if (editor.kind === 'project') {
      void mutate(async () => { await useProjectsStore.getState().updateProjectMeta(project.id, { label: editor.value.trim(), icon: projectIcon || null, color: projectColor || null }); setEditor(null); });
      return;
    }
    const directories = editor.id ? [editor.id] : selected.size ? [...new Set(selected.values())] : [project.path];
    void updateFolder(directories[0], (payload) => {
      for (const directory of directories) {
        const folders = payload.foldersMap[directory] ?? [];
        if (editor.folderId) {
          const folder = folders.find((folder) => folder.id === editor.folderId);
          if (!folder) throw new Error(t('remoteProjects.folderMissing'));
          folder.name = editor.value.trim();
        } else {
          if (editor.parentId && !folders.some((folder) => folder.id === editor.parentId)) throw new Error(t('remoteProjects.folderMissing'));
          for (const folder of folders) folder.sessionIds = folder.sessionIds.filter((id) => !selected.has(id));
          folders.push({ id: createUuid(), name: editor.value.trim(), createdAt: Date.now(), parentId: editor.parentId ?? null, sessionIds: [...selected].filter(([, scope]) => scope === directory).map(([id]) => id) });
        }
        payload.foldersMap[directory] = folders;
      }
    }, () => { if (!editor.folderId) setSelected(new Map()); });
  };
  const openRow = (session: SessionIndexSession, directory: string) => {
    openRemoteProjectSession(project, registry, session.id, directory, mobile);
    const unread = snapshot?.unread?.sessions[session.id];
    if (unread?.unreadCount) void mutate(async () => { await request(directory, `/api/yuri/session-unread/${encodeURIComponent(session.id)}`, 'PUT', { unread: false, expectedRevision: unread.revision }); });
  };
  const sessionProps = (session: SessionIndexSession, scope: string, depth = 0): RemoteSummaryRowProps => ({
    session, active: selectedSession === session.id, search: query, selected: selected.has(session.id), pending: pending || !online,
    dragItem: { kind: 'session', directory: scope, id: session.id }, reorderable: depth === 0,
    status: online ? (session.metadata as { yuri?: { sessionStatus?: { type?: string } } } | undefined)?.yuri?.sessionStatus?.type : 'unknown',
    pinned: Boolean(snapshot?.pinnedSessionIds.includes(session.id) || session.time.pinned), unread: snapshot?.unread?.sessions[session.id]?.unreadCount ?? 0,
    onSelect: () => openRow(session, scope),
    onMultiSelect: () => setSelected((previous) => { const next = new Map(previous); if (next.has(session.id)) next.delete(session.id); else next.set(session.id, scope); return next; }),
    onRename: () => setEditor({ kind: 'title', id: session.id, directory: scope, value: session.title ?? '' }),
    onPin: () => void mutate(async () => { await request(scope, `/api/yuri/session-index/session/${encodeURIComponent(session.id)}/pin`, snapshot?.pinnedSessionIds.includes(session.id) || session.time.pinned ? 'DELETE' : 'POST'); }),
    onUnread: () => void mutate(async () => { const previous = snapshot?.unread?.sessions[session.id]; await request(scope, `/api/yuri/session-unread/${encodeURIComponent(session.id)}`, 'PUT', { unread: !previous?.unreadCount, expectedRevision: previous?.revision ?? 0 }); }),
    onArchive: () => void updateRows([session.id], { time: { archived: session.time.archived ? null : Date.now() } }, scope),
    folders: snapshot?.folders?.foldersMap[scope] ?? [],
    onFolder: (folderId) => void updateFolder(scope, (payload) => { payload.foldersMap[scope] = (payload.foldersMap[scope] ?? []).map((candidate) => ({ ...candidate, sessionIds: [...candidate.sessionIds.filter((id) => id !== session.id), ...(candidate.id === folderId ? [session.id] : [])] })); }),
  });
  const moveSessions = (directory: string, ids: string[], folderId: string | null, beforeSessionId?: string) => mutate(async () => {
    if (!online) throw new Error(t('remoteProjects.host-unavailable'));
    const entry = entryFor(directory);
    const previous = await readRemoteResponse(await entry.fetch('/api/session-folders')) as NonNullable<RemoteSummarySnapshot['folders']>;
    if (registry.resolve(entry.location).connectionGeneration !== entry.connectionGeneration) throw new Error(t('remoteProjects.host-unavailable'));
    if (!previous?.foldersMap || !Array.isArray(previous.collapsedFolderIds)) throw new Error(t('remoteProjects.invalidFolders'));
    const next = structuredClone(previous);
    const folders = next.foldersMap[directory] ?? [];
    if (folderId && !folders.some((folder) => folder.id === folderId)) throw new Error(t('remoteProjects.folderMissing'));
    const ownerOf = (id: string) => (previous.foldersMap[directory] ?? []).find((folder) => folder.sessionIds.includes(id))?.id ?? null;
    const membershipChanged = ids.some((id) => ownerOf(id) !== folderId);
    for (const folder of folders) folder.sessionIds = folder.sessionIds.filter((id) => !ids.includes(id));
    if (folderId) folders.find((folder) => folder.id === folderId)!.sessionIds.push(...ids);
    next.foldersMap[directory] = folders;
    let folderWritten = false;
    try {
      if (membershipChanged) {
        await request(directory, '/api/session-folders', 'POST', { ...next, updatedAt: Date.now() }, entry);
        folderWritten = true;
      }
      if (beforeSessionId) {
        const view = views.find((item) => item.directory.directory === directory)?.view;
        const saved = snapshot?.order?.sessionOrderByScope[directory] ?? [];
        const allIds = [...new Set([...(view?.orderedRows.map((row) => row.session.id) ?? []), ...saved])];
        const remaining = allIds.filter((id) => !ids.includes(id));
        const target = remaining.indexOf(beforeSessionId);
        const insertion = target < 0 ? remaining.length : !membershipChanged && allIds.indexOf(ids[0]) < allIds.indexOf(beforeSessionId) ? target + 1 : target;
        remaining.splice(insertion, 0, ...ids);
        await request(directory, '/api/session-folders/order', 'POST', { scopeKey: directory, order: remaining,
          activity: Object.fromEntries(rows.filter((row) => row.directory === directory).map(({ session }) => [session.id, session.time.updated ?? session.time.created])) }, entry);
      }
      setSelected(new Map());
    } catch (cause) {
      if (folderWritten) {
        try { await request(directory, '/api/session-folders', 'POST', { ...previous, updatedAt: Date.now() }, entry); }
        catch (rollback) { await refresh(); throw new Error(`${cause instanceof Error ? cause.message : String(cause)}; ${t('remoteProjects.rollbackFailed')}: ${rollback instanceof Error ? rollback.message : String(rollback)}`); }
      }
      throw cause;
    }
  });
  const moveFolder = (directory: string, id: string, parentId: string | null, beforeId?: string) => updateFolder(directory, (payload) => {
    const folders = payload.foldersMap[directory] ?? [];
    if (!canMoveRemoteFolder(folders, id, parentId)) throw new Error(t('remoteProjects.invalidFolderMove'));
    const folder = folders.find((folder) => folder.id === id)!;
    folder.parentId = parentId;
    if (beforeId && beforeId !== id) {
      const from = folders.findIndex((folder) => folder.id === id);
      const to = folders.findIndex((folder) => folder.id === beforeId);
      if (to >= 0) payload.foldersMap[directory] = arrayMove(folders, from, to);
    }
  });
  const handleDragEnd = useEvent(({ active: dragged, over }: DragEndEvent) => {
    if (!over || dragged.id === over.id || !online || pending || query) return;
    const source = dragged.data.current as RemoteDragItem | undefined;
    const target = over.data.current as RemoteDragItem | undefined;
    if (!source || !target || source.directory !== target.directory) return;
    const folders = snapshot?.folders?.foldersMap[source.directory] ?? [];
    if (source.kind === 'folder') {
      const parentId = target.kind === 'folder' ? target.id : target.kind === 'folder-position' ? folders.find((folder) => folder.id === target.id)?.parentId ?? null : target.kind === 'root' ? null : undefined;
      if (parentId !== undefined && canMoveRemoteFolder(folders, source.id, parentId)) void moveFolder(source.directory, source.id, parentId, target.kind === 'folder-position' ? target.id : undefined);
      return;
    }
    if (source.kind !== 'session' || target.kind === 'folder-position') return;
    const folderId = target.kind === 'folder' ? target.id : target.kind === 'session' ? folders.find((folder) => folder.sessionIds.includes(target.id))?.id ?? null : null;
    const ids = selected.has(source.id) ? [...selected].filter(([, directory]) => directory === source.directory).map(([id]) => id) : [source.id];
    if (!ids.includes(target.id)) void moveSessions(source.directory, ids, folderId, target.kind === 'session' ? target.id : undefined);
  });
  const [visibleCount, setVisibleCount] = React.useState(30);
  React.useLayoutEffect(() => {
    if (!onNavigationTargets) return;
    const targets: SessionNavigationTarget[] = [];
    const append = (sessionId: string, directory: string, seen: Set<string>) => {
      if (seen.has(sessionId)) return;
      seen.add(sessionId);
      targets.push({ scope: 'project', projectId: project.id, directory, sessionId });
      for (const child of childTargets.get(sessionId) ?? []) append(child.sessionId, child.directory, seen);
    };
    if (query || !project.sidebarCollapsed) {
      for (const { view } of views) {
        const seen = new Set<string>();
        for (const { session, directory } of visibleRemoteRows(view, new Set(snapshot?.folders?.collapsedFolderIds ?? []), visibleCount, Boolean(query))) append(session.id, directory, seen);
      }
    }
    onNavigationTargets(project.id, targets);
  }, [onNavigationTargets, snapshot, project.id, project.sidebarCollapsed, query, visibleCount, views, childTargets]);
  const folderProps = (node: RemoteFolderNode, scope: string, depth: number): Omit<RemoteFolderBranchProps, 'children' | 'renderRow'> => ({
    node, directory: scope, depth, disabled: !online || pending || Boolean(query), folders: snapshot?.folders?.foldersMap[scope] ?? [], visibleCount,
    collapsed: !query && Boolean(snapshot?.folders?.collapsedFolderIds.includes(node.folder.id)),
    onToggle: () => void updateFolder(scope, (payload) => { payload.collapsedFolderIds = payload.collapsedFolderIds.includes(node.folder.id) ? payload.collapsedFolderIds.filter((id) => id !== node.folder.id) : [...payload.collapsedFolderIds, node.folder.id]; }),
    onRename: (name) => void updateFolder(scope, (payload) => { const folder = payload.foldersMap[scope]?.find((folder) => folder.id === node.folder.id); if (!folder) throw new Error(t('remoteProjects.folderMissing')); folder.name = name; }),
    onRenameStart: () => setEditor({ kind: 'folder', id: scope, folderId: node.folder.id, value: node.folder.name }),
    onDelete: () => void updateFolder(scope, (payload) => {
      const removed = new Set([node.folder.id]);
      const children = new Map<string, string[]>();
      for (const folder of payload.foldersMap[scope] ?? []) { if (folder.parentId) { const ids = children.get(folder.parentId) ?? []; ids.push(folder.id); children.set(folder.parentId, ids); } }
      const visit = (id: string) => { for (const child of children.get(id) ?? []) { if (!removed.has(child)) { removed.add(child); visit(child); } } }; visit(node.folder.id);
      payload.foldersMap[scope] = (payload.foldersMap[scope] ?? []).filter((folder) => !removed.has(folder.id));
      payload.collapsedFolderIds = payload.collapsedFolderIds.filter((id) => !removed.has(id));
    }),
    onNewSession: () => openRemoteProjectSession(project, registry, null, scope, mobile, { targetFolderId: node.folder.id }),
    onNewSubFolder: () => setEditor({ kind: 'folder', id: scope, parentId: node.folder.id, value: '' }),
    onMove: (parentId) => void moveFolder(scope, node.folder.id, parentId),
  });
  const projectProps: Omit<RemoteProjectShellProps, 'children'> = {
    project, registry, sessionCount: rows.length,
    label: `${project.label || project.path}${data.busy ? ` · ${t('remoteProjects.running')}` : ''}`,
    collapsed: !query && Boolean(project.sidebarCollapsed), active, loading: data.loading,
    isRepo: Boolean(snapshot?.worktrees?.projectDirectories[project.path]?.length), reorderEnabled,
    actions: {
      disabled: !online || pending,
      toggle: toggleCollapse,
      newSession: () => openRemoteProjectSession(project, registry, null, project.path, mobile),
      newWorktree: () => { useProjectsStore.getState().setActiveProjectIdOnly(project.id); setWorktreeOpen(true); },
      newFolder: () => setEditor({ kind: 'folder', id: project.path, value: '' }),
      sync: syncProject,
      edit: () => { setProjectIcon(project.icon ?? ''); setProjectColor(project.color ?? ''); setEditor({ kind: 'project', value: project.label || project.path }); },
      close: () => { void mutate(async () => { await useProjectsStore.getState().removeProject(project.id); }); },
    },
  };
  return { data, projectProps, sessionProps, folderProps, handleDragEnd, reportChildTargets, pending, error: error || data.error,
    worktreeOpen, setWorktreeOpen, editor, setEditor, saveEditor, projectIcon, setProjectIcon, projectColor, setProjectColor, visibleCount,
    loadMore: (hasMore: boolean) => { const next = visibleCount + 30; setVisibleCount(next); if (hasMore) data.setPageLimit(next); },
    newFolder: (directory?: string) => setEditor({ kind: 'folder', id: directory, value: '' }),
    bulk: {
      count: selected.size,
      archive: () => void updateRows([...selected.keys()], { time: { archived: Date.now() } }),
      clear: () => setSelected(new Map()),
      folders: selected.size ? directories.flatMap((directory) => (snapshot?.folders?.foldersMap[directory.directory] ?? []).map((folder) => ({
        id: `${directory.directory}:${folder.id}`, name: folder.name,
        move: () => void updateFolder(directory.directory, (payload) => { payload.foldersMap[directory.directory] = payload.foldersMap[directory.directory].map((candidate) => ({ ...candidate, sessionIds: [...candidate.sessionIds.filter((id) => !selected.has(id)), ...(candidate.id === folder.id ? [...selected].filter(([, scope]) => scope === directory.directory).map(([id]) => id) : [])] })); }),
      }))) : [],
    },
  };
}
