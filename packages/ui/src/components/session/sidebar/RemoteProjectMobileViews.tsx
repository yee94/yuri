import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { PROJECT_ICON_MAP } from '@/lib/projectMeta';
import { MobileProjectCard } from '@/mobile/projects/MobileProjectCard';
import { MobileSessionRow } from '@/mobile/projects/MobileSessionRow';
import { MobileActionSheet } from '@/mobile/projects/MobileRowActionsSheet';
import { MobileFloatingSurface, MobileLabeledSurfaceGroup } from '@/mobile/MobileSurface';
import { canMoveRemoteFolder, remoteDragId } from './remoteSessionFolders';
import { formatSessionCompactDateLabel } from './utils';
import type { RemoteProjectShellProps, RemoteFolderBranchProps, RemoteSummaryRowProps } from './remoteProjectPresentation';

/** Mobile adapters only translate presentation and user intent; remote IO belongs to the model. */
export function MobileRemoteProjectShell({ project, registry, label, collapsed, sessionCount, iconSlot, actions, children }: RemoteProjectShellProps) {
  const { t } = useI18n();
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const disabled = actions.disabled;
  return <MobileFloatingSurface asChild><section className="yuri-mobile-project-shell" aria-label={label}>
    <MobileProjectCard embedded hostRegistry={registry} expanded={!collapsed}
      project={{ id: project.id, name: label, path: project.path, hostId: project.hostId,
        remoteState: project.remoteState, sessionCount, icon: project.icon ? PROJECT_ICON_MAP[project.icon] : undefined }}
      iconSlot={iconSlot} onToggle={actions.toggle} onOpenActions={() => setActionsOpen(true)} />
    <div className={collapsed ? undefined : 'yuri-mobile-project-groups'}>{children}</div>
    {actionsOpen ? <MobileActionSheet id={`remote-project-actions:${project.id}`} title={label} open onOpenChange={setActionsOpen} projectMenu items={[
      { id: 'newSession', icon: 'add', label: t('sessions.sidebar.project.actions.newSession'), onClick: actions.newSession, disabled },
      { id: 'newWorktree', icon: 'git-branch', label: t('sessions.sidebar.project.actions.newWorktree'), onClick: actions.newWorktree, disabled },
      { id: 'newFolder', icon: 'folder-add', label: t('remoteProjects.newFolder'), onClick: actions.newFolder, disabled },
      { id: 'sync', icon: 'refresh', label: t('sessions.sidebar.project.actions.syncSessions'), onClick: actions.sync },
      { id: 'edit', icon: 'pencil-ai', label: t('sessions.sidebar.project.actions.edit'), onClick: actions.edit, disabled },
      { id: 'close', icon: 'close', label: t('sessions.sidebar.project.actions.closeProject'), onClick: actions.close, destructive: true, separated: true },
    ]} /> : null}
  </section></MobileFloatingSurface>;
}

export function MobileRemoteFolderBranch({ node, directory, collapsed, disabled, folders, visibleCount, children, renderRow, onToggle, onRenameStart, onDelete, onNewSession, onNewSubFolder, onMove }: RemoteFolderBranchProps) {
  const { t } = useI18n();
  const [actionsOpen, setActionsOpen] = React.useState(false);
  return <>
    <MobileLabeledSurfaceGroup ariaLabel={node.folder.name} label={<div className="flex min-w-0 items-center gap-1">
      <Button variant="ghost" className="min-w-0 flex-1 justify-start text-muted-foreground" onClick={onToggle} disabled={disabled} aria-expanded={!collapsed}>
        <Icon name="arrow-down-s" className={cn('size-4', collapsed && '-rotate-90')} /><span className="truncate">{node.folder.name}</span>
      </Button>
      <Button variant="ghost" size="icon" aria-label={t('remoteProjects.actions')} onClick={() => setActionsOpen(true)}><Icon name="more-2" className="size-4" /></Button>
    </div>}>
      {!collapsed ? <>{children}{node.rows.slice(0, visibleCount).map((row) => <React.Fragment key={row.session.id}>{renderRow(row)}</React.Fragment>)}</> : null}
    </MobileLabeledSurfaceGroup>
    {actionsOpen ? <MobileActionSheet id={`remote-folder-actions:${directory}:${node.folder.id}`} title={node.folder.name} open onOpenChange={setActionsOpen} items={[
      { id: 'newSession', icon: 'add', label: t('sessions.sidebar.project.actions.newSession'), onClick: onNewSession, disabled },
      { id: 'newFolder', icon: 'folder-add', label: t('remoteProjects.newFolder'), onClick: onNewSubFolder, disabled },
      { id: 'rename', icon: 'pencil-ai', label: t('sessions.sidebar.folderItem.renameAria', { folderName: node.folder.name }), onClick: onRenameStart, disabled },
      { id: 'unfolder', icon: 'folder-open', label: t('remoteProjects.removeFolder'), onClick: () => onMove(null), disabled: disabled || !node.folder.parentId },
      ...folders.filter((folder) => canMoveRemoteFolder(folders, node.folder.id, folder.id)).map((folder) => ({ id: `folder:${folder.id}`, icon: 'folder-open' as const, label: folder.name, onClick: () => onMove(folder.id), disabled: disabled || node.folder.parentId === folder.id })),
      { id: 'delete', icon: 'delete-bin', label: t('sessions.sidebar.folderItem.deleteFolderAria', { folderName: node.folder.name }), onClick: onDelete, disabled, destructive: true, separated: true },
    ]} /> : null}
  </>;
}

export function MobileRemoteSummaryRow({ session, active, search, pending, pinned, unread, status, dragItem, onSelect, onRename, onPin, onUnread, onArchive, folders, onFolder }: RemoteSummaryRowProps) {
  const { t } = useI18n();
  const [actionsOpen, setActionsOpen] = React.useState(false);
  const title = session.title ?? t('mobile.sessions.untitled');
  const activityTime = session.time.updated || session.time.created;
  return <>
    <MobileSessionRow session={{ id: session.id, title, active, pinned, unread: Boolean(unread), archived: Boolean(session.time.archived),
      activityLabel: activityTime ? formatSessionCompactDateLabel(activityTime) : undefined,
      subtitle: status === 'unknown' ? t('remoteProjects.unknown') : undefined }} highlightQuery={search}
      indicator={status === 'busy' || status === 'retry' ? 'running' : unread ? 'completed-unread' : 'idle'}
      onSelect={onSelect} onPin={() => { if (!pending) onPin(); }} onArchive={() => { if (!pending) onArchive(); }} onOpenActions={() => setActionsOpen(true)} />
    {actionsOpen ? <MobileActionSheet id={`remote-session-actions:${remoteDragId(dragItem)}`} title={title} open onOpenChange={setActionsOpen} items={[
      { id: 'pin', icon: 'pushpin', label: t(pinned ? 'remoteProjects.unpin' : 'remoteProjects.pin'), onClick: onPin, disabled: pending },
      { id: 'unread', icon: 'check', label: t(unread ? 'remoteProjects.markRead' : 'remoteProjects.markUnread'), onClick: onUnread, disabled: pending },
      { id: 'rename', icon: 'pencil-ai', label: t('sessions.sidebar.session.menu.rename'), onClick: onRename, disabled: pending },
      { id: 'archive', icon: 'archive', label: t(session.time.archived ? 'remoteProjects.unarchive' : 'sessions.sidebar.bulkActions.archive'), onClick: onArchive, disabled: pending },
      { id: 'unfolder', icon: 'folder-open', label: t('remoteProjects.removeFolder'), onClick: () => onFolder(null), disabled: pending },
      ...folders.map((folder) => ({ id: `folder:${folder.id}`, icon: 'folder-open' as const, label: folder.name, onClick: () => onFolder(folder.id), disabled: pending })),
    ]} /> : null}
  </>;
}

export function MobileRemotePagination({ directory, disabled, onLoadMore }: { directory: string; disabled: boolean; onLoadMore(): void }) {
  const { t } = useI18n();
  return <MobileSessionRow session={{ id: `more:${directory}`, kind: 'pagination', title: t('remoteProjects.showMore') }}
    onSelect={() => { if (!disabled) onLoadMore(); }} onPin={() => {}} onArchive={() => {}} onOpenActions={() => {}} />;
}
