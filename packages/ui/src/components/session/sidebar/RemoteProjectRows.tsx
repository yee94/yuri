import React from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SessionBusyIndicator } from '../SessionBusyIndicator';
import { SessionFolderItem } from '../SessionFolderItem';
import { SortableProjectItem } from './sortableItems';
import { SessionRowDragContext } from './sessionDragState';
import { SIDEBAR_ROW_ACTIVE_CLASS, SIDEBAR_ROW_HOVER_CLASS, renderHighlightedText } from './utils';
import { canMoveRemoteFolder, remoteDragId, type RemoteDragItem } from './remoteSessionFolders';
import type { RemoteProjectShellProps, RemoteFolderBranchProps, RemoteSummaryRowProps } from './remoteProjectPresentation';
import { MobileRemoteProjectShell, MobileRemoteFolderBranch, MobileRemoteSummaryRow, MobileRemotePagination } from './RemoteProjectMobileViews';

export function RemoteProjectShell({ mobile, ...props }: RemoteProjectShellProps & { mobile: boolean }) {
  return mobile ? <MobileRemoteProjectShell {...props} /> : <DesktopRemoteProjectShell {...props} />;
}

function DesktopRemoteProjectShell({ project, registry, label, collapsed, active, loading, isRepo, reorderEnabled, iconSlot, actions, children }: RemoteProjectShellProps) {
  const [menu, setMenu] = React.useState<string | null>(null);
  return <SortableProjectItem id={project.id} hostId={project.hostId} remoteState={project.remoteState} hostRegistry={registry}
    projectLabel={label} projectDescription={project.path} projectIcon={project.icon ?? undefined} projectColor={project.color ?? undefined}
    projectIconSlot={iconSlot} isCollapsed={collapsed} isActiveProject={active} isSessionsLoading={loading} isRepo={isRepo} worktreeActionAvailable
    hideDirectoryControls={false} mobileVariant={false} alwaysShowActions={false} reorderEnabled={reorderEnabled} onToggle={actions.toggle} onNewSession={actions.newSession}
    onNewWorktreeSession={actions.newWorktree} onSyncSessions={actions.sync} onRenameStart={actions.edit} onClose={actions.close}
    openSidebarMenuKey={menu} setOpenSidebarMenuKey={setMenu}>{children}</SortableProjectItem>;
}

export function RemoteFolderBranch({ mobile, ...props }: RemoteFolderBranchProps & { mobile: boolean }) {
  const { node, directory, depth, collapsed, disabled, folders, visibleCount, children, renderRow, onToggle, onRename, onDelete, onNewSession, onNewSubFolder, onMove } = props;
  const { t } = useI18n();
  const data: RemoteDragItem = { kind: 'folder', directory, id: node.folder.id };
  const sortable = useSortable({ id: remoteDragId(data), data, disabled });
  const beforeData: RemoteDragItem = { ...data, kind: 'folder-position' };
  const before = useDroppable({ id: remoteDragId(beforeData), data: beforeData, disabled });
  const visible = node.rows.slice(0, visibleCount);
  const items = node.rows.map(({ session }) => remoteDragId({ kind: 'session', directory, id: session.id }));
  const style = { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition };
  if (mobile) return <div data-remote-folder={node.folder.id} ref={sortable.setNodeRef} style={style} className={depth > 0 ? 'pl-3' : undefined}
    onTouchStart={(event) => { if (!(event.target as HTMLElement).closest('button[aria-label]')) { event.stopPropagation(); sortable.listeners?.onTouchStart?.(event); } }}>
    <SortableContext items={items} strategy={verticalListSortingStrategy}><MobileRemoteFolderBranch {...props} /></SortableContext>
  </div>;
  return <div data-remote-folder={node.folder.id} style={style}>
    <div ref={before.setNodeRef} className={cn('h-1 rounded-md', before.isOver && 'bg-interactive-selection')} />
    <SortableContext items={items} strategy={verticalListSortingStrategy}>
      <SessionFolderItem folder={node.folder} sessions={visible} depth={depth} isCollapsed={collapsed} subFolderItems={node.children.length ? children : undefined}
        droppableRef={sortable.setNodeRef} isDropTarget={sortable.isOver} actionsDisabled={disabled} allowNestedSubfolders
        onToggle={onToggle} onRename={onRename} onDelete={onDelete} onNewSession={onNewSession} onNewSubFolder={onNewSubFolder}
        renderSessionNode={(row) => <div key={row.session.id} style={{ paddingLeft: (depth + 1) * 12 }}>{renderRow(row)}</div>}
        headerActions={<span className="inline-flex items-center" onClick={(event) => event.stopPropagation()}>
          <button type="button" disabled={disabled} className="touch-none text-muted-foreground" aria-label={t('remoteProjects.reorder')} {...sortable.attributes} {...sortable.listeners}><Icon name="draggable" className="size-3" /></button>
          <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="xs" disabled={disabled} aria-label={t('sessions.sidebar.folders.moveToFolder')}><Icon name="more-2" className="size-3" /></Button></DropdownMenuTrigger><DropdownMenuContent>
            <DropdownMenuItem disabled={disabled || !node.folder.parentId} onClick={() => onMove(null)}>{t('remoteProjects.removeFolder')}</DropdownMenuItem>
            {folders.filter((folder) => canMoveRemoteFolder(folders, node.folder.id, folder.id)).map((folder) => <DropdownMenuItem key={folder.id} disabled={disabled || node.folder.parentId === folder.id} onClick={() => onMove(folder.id)}>{folder.name}</DropdownMenuItem>)}
          </DropdownMenuContent></DropdownMenu>
        </span>} />
    </SortableContext>
  </div>;
}

export function RemoteSummaryRow({ mobile, ...props }: RemoteSummaryRowProps & { mobile: boolean }) {
  const { session, active, search, selected, pending, pinned, unread, status, dragItem, reorderable = true, onSelect, onMultiSelect, onRename, onPin, onUnread, onArchive, folders, onFolder } = props;
  const { t } = useI18n();
  const sortable = useSortable({ id: remoteDragId(dragItem), data: dragItem, disabled: pending || Boolean(search) || !reorderable });
  const style = { transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition };
  if (mobile) return <div data-remote-session={session.id} ref={sortable.setNodeRef} style={style}
    onTouchStart={(event) => { if (!(event.target as HTMLElement).closest('[data-session-drag-ignore], button[aria-label]')) { event.stopPropagation(); sortable.listeners?.onTouchStart?.(event); } }}>
    <SessionRowDragContext.Provider value={sortable.isDragging}><MobileRemoteSummaryRow {...props} /></SessionRowDragContext.Provider>
  </div>;
  return <div data-remote-session={session.id} ref={sortable.setNodeRef} style={style} className={cn('group flex min-w-0 items-center gap-1 rounded-md', active || selected ? SIDEBAR_ROW_ACTIVE_CLASS : SIDEBAR_ROW_HOVER_CLASS)}>
    {reorderable ? <button type="button" className="touch-none text-muted-foreground" aria-label={t('remoteProjects.reorder')} {...sortable.attributes} {...sortable.listeners}><Icon name="draggable" className="size-3" /></button> : null}
    <input type="checkbox" aria-label={t('remoteProjects.selectSession', { title: session.title })} checked={selected} onChange={onMultiSelect} />
    {status === 'busy' || status === 'retry' ? <span role="status" aria-label={t('remoteProjects.running')}><SessionBusyIndicator /></span> : status === 'unknown' ? <span role="status" aria-label={t('remoteProjects.unknown')} className="text-xs text-muted-foreground">?</span> : null}
    <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start truncate font-normal" onClick={onSelect}>{pinned ? <Icon name="pushpin" className="size-3 shrink-0" /> : null}<span className="truncate">{renderHighlightedText(session.title ?? t('mobile.sessions.untitled'), search)}</span>{unread ? <span className="text-xs text-muted-foreground">{unread}</span> : null}</Button>
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" aria-label={t('remoteProjects.actions')}><Icon name="more-2" className="size-4" /></Button></DropdownMenuTrigger><DropdownMenuContent>
      <DropdownMenuItem disabled={pending} onClick={onPin}>{t(pinned ? 'remoteProjects.unpin' : 'remoteProjects.pin')}</DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={onUnread}>{t(unread ? 'remoteProjects.markRead' : 'remoteProjects.markUnread')}</DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={onRename}>{t('sessions.sidebar.session.menu.rename')}</DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={onArchive}>{t(session.time.archived ? 'remoteProjects.unarchive' : 'sessions.sidebar.bulkActions.archive')}</DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={() => onFolder(null)}>{t('remoteProjects.removeFolder')}</DropdownMenuItem>
      {folders.map((folder) => <DropdownMenuItem key={folder.id} disabled={pending} onClick={() => onFolder(folder.id)}>{folder.name}</DropdownMenuItem>)}
    </DropdownMenuContent></DropdownMenu>
  </div>;
}

export function RemoteRootDrop({ directory, disabled, children, mobile }: { directory: string; disabled: boolean; children: React.ReactNode; mobile: boolean }) {
  const data: RemoteDragItem = { kind: 'root', directory, id: '' };
  const drop = useDroppable({ id: remoteDragId(data), data, disabled });
  return <div ref={drop.setNodeRef} data-remote-folder-root={directory} className={cn(mobile ? 'yuri-mobile-labeled-surface-group' : 'min-h-3', drop.isOver && 'bg-interactive-hover rounded-md')}>{children}</div>;
}

export function RemotePagination({ mobile, ...props }: { mobile: boolean; directory: string; disabled: boolean; onLoadMore(): void }) {
  const { t } = useI18n();
  return mobile ? <MobileRemotePagination {...props} /> : <Button size="xs" variant="ghost" disabled={props.disabled} onClick={props.onLoadMore}>{t('remoteProjects.showMore')}</Button>;
}
