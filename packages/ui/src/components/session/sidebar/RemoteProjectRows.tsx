import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { SessionBusyIndicator } from '../SessionBusyIndicator';
import { SortableProjectItem } from './sortableItems';
import { renderHighlightedText } from './utils';
import { DraggableSessionRow } from './sessionFolderDnd';
import { SessionRowLayout, SessionRowContent, SessionRowTitle, SessionRowActions } from './SessionRowLayout';
import type { RemoteProjectShellProps, RemoteSummaryRowProps } from './remoteProjectPresentation';
import { MobileRemoteProjectShell } from './RemoteProjectMobileViews';

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

export function RemoteSummaryRow({ session, active, search, selected, pending, pinned, unread, status, dragItem, depth = 1, onSelect, onMultiSelect, onRename, onPin, onUnread, onArchive, onDelete, folders, onFolder }: RemoteSummaryRowProps) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const title = session.title || t('sessions.sidebar.session.untitled');
  return <DraggableSessionRow sessionId={session.id} sessionDirectory={dragItem.directory} sessionTitle={title}>
    <SessionRowLayout data-remote-session={session.id} data-session-row={session.id} data-session-scope={dragItem.directory} active={active} selected={selected}>
    <SessionRowContent depth={depth}>
      <SessionRowTitle title={title} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey) onMultiSelect(); else onSelect(); }} onDoubleClick={onRename}
        className="group-hover:pr-18 group-focus-within:pr-18">
        <span className="flex w-full min-w-0 items-center gap-1">
          <span className="block min-w-0 flex-1 truncate typography-ui-label font-normal text-foreground">{renderHighlightedText(title, search)}</span>
          <span className={cn('inline-flex shrink-0 items-center text-muted-foreground group-hover:hidden group-focus-within:hidden', menuOpen && 'hidden')}>
            {status === 'busy' || status === 'retry' ? <SessionBusyIndicator /> : unread > 0 ? <span className="size-1.5 rounded-full bg-current" aria-label={t('remoteProjects.markUnread')} /> : null}
          </span>
        </span>
      </SessionRowTitle>
    </SessionRowContent>
    <SessionRowActions visible={menuOpen}>
    <Button variant="ghost" size="icon" className="h-5 w-5" disabled={pending} onClick={onPin} aria-label={t(pinned ? 'remoteProjects.unpin' : 'remoteProjects.pin')}><Icon name={pinned ? 'pushpin-2-fill' : 'pushpin-2'} className="size-3.5" /></Button>
    <Button variant="ghost" size="icon" className="h-5 w-5" disabled={pending} onClick={onArchive} aria-label={t(session.time.archived ? 'remoteProjects.unarchive' : 'sessions.sidebar.bulkActions.archive')}><Icon name="archive" className="size-3.5" /></Button>
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-5 w-5" aria-label={t('remoteProjects.actions')}><Icon name="more-2" className="size-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent>
      <DropdownMenuItem onClick={onMultiSelect}>{t('remoteProjects.selectSession', { title })}</DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={onPin}>{t(pinned ? 'remoteProjects.unpin' : 'remoteProjects.pin')}</DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={onUnread}>{t(unread ? 'remoteProjects.markRead' : 'remoteProjects.markUnread')}</DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={onRename}>{t('sessions.sidebar.session.menu.rename')}</DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={onArchive}>{t(session.time.archived ? 'remoteProjects.unarchive' : 'sessions.sidebar.bulkActions.archive')}</DropdownMenuItem>
      <DropdownMenuItem disabled={pending} onClick={() => onFolder(null)}>{t('remoteProjects.removeFolder')}</DropdownMenuItem>
      {folders.map((folder) => <DropdownMenuItem key={folder.id} disabled={pending} onClick={() => onFolder(folder.id)}>{folder.name}</DropdownMenuItem>)}
      <DropdownMenuItem disabled={pending} onClick={onDelete} className="text-destructive focus:text-destructive">{t('sessions.sidebar.dialogs.deleteSession.titleAction')}</DropdownMenuItem>
    </DropdownMenuContent></DropdownMenu>
    </SessionRowActions>
  </SessionRowLayout></DraggableSessionRow>;
}
