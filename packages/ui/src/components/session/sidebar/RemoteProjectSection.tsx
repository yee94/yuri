import React from 'react';
import { DndContext, MouseSensor, TouchSensor, KeyboardSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import { HostRuntimeProvider } from '@/contexts/HostRuntimeProvider';
import type { SessionIndexSession } from '@/lib/session-index-api';
import { cn } from '@/lib/utils';
import { NewWorktreeDialog } from '../NewWorktreeDialog';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import { remoteDragId, type RemoteDragItem, type RemoteFolderNode } from './remoteSessionFolders';
import { useRemoteProjectSectionModel, type RemoteProjectSectionOptions } from './hooks/useRemoteProjectSectionModel';
import { RemoteProjectShell, RemoteSummaryRow, RemoteFolderBranch, RemoteRootDrop, RemotePagination } from './RemoteProjectRows';
import { RemoteProjectIcon, RemoteChildSessions } from './RemoteProjectResources';

export const RemoteProjectSection = React.memo(function RemoteProjectSection(props: RemoteProjectSectionOptions) {
  const { project, registry, mobile = false } = props;
  const { t } = useI18n();
  const model = useRemoteProjectSectionModel(props);
  const { data, pending, editor, visibleCount } = model;
  const { online, query, snapshot, views, busy, host } = data;
  const sensors = useSensors(useSensor(MouseSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const renderSessionRow = (session: SessionIndexSession, scope: string, depth = 0): React.ReactNode => <>
    <RemoteSummaryRow {...model.sessionProps(session, scope, depth)} mobile={mobile} />
    {!mobile && (session.hasChildren || depth > 0) ? <RemoteChildSessions registry={registry} hostId={project.hostId} directory={scope} sessionId={session.id} disabled={!online} depth={depth + 1} renderRow={renderSessionRow} pinnedSessionIds={snapshot?.pinnedSessionIds} onVisibleTargets={model.reportChildTargets} /> : null}
  </>;
  if (data.hidden) return null;
  return <RemoteProjectShell {...model.projectProps} mobile={mobile}
    iconSlot={project.iconImage ? <RemoteProjectIcon project={project} registry={registry} className={mobile ? 'size-6' : 'size-4'} /> : undefined}>
    <div className={cn('min-w-0', !mobile && 'pl-4')} data-remote-project={project.id} hidden={model.projectProps.collapsed}>
      {busy ? <span role="status" className="text-xs text-muted-foreground">{t('remoteProjects.running')}</span> : null}
      {!online ? <p className="text-xs text-muted-foreground">{t(`remoteProjects.state.${host?.state ?? 'offline'}`)} · {t('remoteProjects.unknown')}{snapshot?.lastSyncedAt ? ` · ${t('remoteProjects.lastSync', { time: new Date(snapshot.lastSyncedAt).toLocaleString() })}` : ''}</p> : null}
      {model.error ? <p role="alert" className="break-words text-xs text-destructive">{model.error}<Button size="xs" variant="ghost" onClick={() => void data.refresh()}>{t('remoteProjects.retry')}</Button></p> : null}
      {model.bulk.count ? <div className="flex flex-wrap items-center gap-1">
        <Button size="xs" disabled={!online || pending} onClick={model.bulk.archive}>{t('sessions.sidebar.bulkActions.archive')}</Button>
        <Button size="xs" disabled={!online || pending} onClick={() => model.newFolder()}>{t('remoteProjects.newFolder')}</Button>
        {model.bulk.folders.map((folder) => <Button key={folder.id} size="xs" variant="ghost" disabled={!online || pending} onClick={folder.move}>{folder.name}</Button>)}
        <Button size="xs" variant="ghost" onClick={model.bulk.clear}>{t('sessions.sidebar.dialogs.cancel')}</Button>
      </div> : null}
      <DndContext sensors={sensors} collisionDetection={(args) => closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((container) => {
        const source = args.active.data.current as RemoteDragItem | undefined;
        const target = container.data.current as RemoteDragItem | undefined;
        return source?.directory === target?.directory && (source?.kind === 'folder' ? target?.kind !== 'session' : target?.kind !== 'folder-position');
      }) })} onDragEnd={model.handleDragEnd}>
      {views.map(({ directory, view }) => {
        const scope = directory.directory;
        const folders = snapshot?.folders?.foldersMap[scope] ?? [];
        const renderFolder = (node: RemoteFolderNode, depth: number): React.ReactNode => <RemoteFolderBranch key={node.folder.id}
          {...model.folderProps(node, scope, depth)} mobile={mobile} renderRow={(row) => renderSessionRow(row.session, scope)}>
          {node.children.map((child) => renderFolder(child, depth + 1))}
        </RemoteFolderBranch>;
        return <div key={scope}>
          {scope !== project.path ? <div className="truncate typography-micro text-muted-foreground">{scope}</div> : null}
          <SortableContext items={folders.map((folder) => remoteDragId({ kind: 'folder', directory: scope, id: folder.id }))} strategy={verticalListSortingStrategy}>
            {view.folders.map((node) => renderFolder(node, 0))}
          </SortableContext>
          <RemoteRootDrop directory={scope} disabled={!online || pending || Boolean(query)} mobile={mobile}>
            <SortableContext items={view.ungrouped.map(({ session }) => remoteDragId({ kind: 'session', directory: scope, id: session.id }))} strategy={verticalListSortingStrategy}>
              {view.ungrouped.slice(0, visibleCount).map(({ session }) => <React.Fragment key={session.id}>{renderSessionRow(session, scope)}</React.Fragment>)}
            </SortableContext>
          </RemoteRootDrop>
          {view.orderedRows.length > visibleCount || directory.hasMore ? <RemotePagination mobile={mobile} directory={scope}
            disabled={data.loadingMore || (!online && view.orderedRows.length <= visibleCount)} onLoadMore={() => model.loadMore(directory.hasMore)} /> : null}
          {!mobile ? <Button size="xs" variant="ghost" disabled={!online || pending} onClick={() => model.newFolder(scope)}>{t('remoteProjects.newFolder')}</Button> : null}
        </div>;
      })}
      </DndContext>
      {editor ? <Dialog open onOpenChange={(open) => { if (!open && !pending) model.setEditor(null); }}><DialogContent><DialogHeader><DialogTitle>{t(editor.kind === 'title' ? 'sessions.sidebar.session.menu.rename' : editor.kind === 'project' ? 'sessions.sidebar.project.actions.edit' : 'remoteProjects.newFolder')}</DialogTitle></DialogHeader>
        <form onSubmit={(event) => { event.preventDefault(); model.saveEditor(); }}><Input aria-label={t('sessions.sidebar.session.menu.rename')} value={editor.value} onChange={(event) => model.setEditor({ ...editor, value: event.target.value })} autoFocus disabled={pending} />
          {editor.kind === 'project' ? <><Input aria-label={t('remoteProjects.icon')} value={model.projectIcon} onChange={(event) => model.setProjectIcon(event.target.value)} /><Input aria-label={t('remoteProjects.color')} value={model.projectColor} onChange={(event) => model.setProjectColor(event.target.value)} /></> : null}
          <DialogFooter><Button type="submit" disabled={pending || !online || !editor.value.trim()}>{t('sessions.sidebar.session.rename.save')}</Button></DialogFooter></form>
      </DialogContent></Dialog> : null}
    </div>
    {model.worktreeOpen ? <HostRuntimeProvider registry={registry} location={{ hubId: registry.hubId, hostId: project.hostId, directory: project.path }}><NewWorktreeDialog projectId={project.id} open onOpenChange={model.setWorktreeOpen} onWorktreeCreated={() => { if (mobile) useMobileNavigationStore.getState().openRemoteProject(); }} /></HostRuntimeProvider> : null}
  </RemoteProjectShell>;
});
