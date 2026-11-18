import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { useI18n } from '@/lib/i18n';
import { cn, formatDirectoryName } from '@/lib/utils';
import type { RemoteProject } from '@/lib/remote-projects/types';
import { supportsRemoteProjects } from '@/queries/remoteProjectQueries';
import { PendingRemoteHostIndicator } from '../RemoteHostIndicator';
import { useRemoteHostDisplayName } from '@/lib/remote-projects/host-names';
import { SessionBusyIndicator } from '../SessionBusyIndicator';
import { SortableProjectItem } from './sortableItems';
import { formatSessionCompactDateLabel, renderHighlightedText } from './utils';
import { TaskUnreadDot } from './TaskCardParts';
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

/** Same row as a resolved project, rendered before a host registry exists; only its host tag differs (loading + status tooltip). */
export function PendingRemoteProjectRow({ project, loading, error, mobile, reorderEnabled }: { project: RemoteProject; loading: boolean; error?: string; mobile: boolean; reorderEnabled?: boolean }) {
  const { t } = useI18n();
  const [menu, setMenu] = React.useState<string | null>(null);
  const noop = () => undefined;
  const status = t(loading ? 'remoteProjects.state.connecting' : supportsRemoteProjects() ? 'remoteProjects.state.offline' : 'remoteProjects.unsupported');
  const hostName = useRemoteHostDisplayName(project.hostId) ?? project.hostId;
  return <SortableProjectItem id={project.id} hostId={project.hostId} remoteState={project.remoteState}
    hostTag={<PendingRemoteHostIndicator hostId={project.hostId} name={hostName} loading={loading} status={status} error={loading ? undefined : error} />}
    projectLabel={project.label || formatDirectoryName(project.path) || project.path} projectDescription={project.path}
    projectIcon={project.icon ?? undefined} projectColor={project.color ?? undefined}
    isCollapsed isActiveProject={false} isRepo={false}
    hideDirectoryControls mobileVariant={mobile} alwaysShowActions={false} reorderEnabled={reorderEnabled}
    showCreateButtons={false} onToggle={noop} onNewSession={noop} onSyncSessions={noop} onRenameStart={noop} onClose={noop}
    openSidebarMenuKey={menu} setOpenSidebarMenuKey={setMenu} />;
}

export function RemoteSummaryRow({ session, active, search, selected, pending, pinDisabled = pending, pinned, unread, status, dragItem, secondaryMeta, subtitleSuffix, leading, card, depth = 1, onSelect, onMultiSelect, onRename, onPin, onUnread, onArchive, onDelete, folders, onFolder }: RemoteSummaryRowProps) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const busy = status === 'busy' || status === 'retry';
  const title = session.title || t('sessions.sidebar.session.untitled');
  const renderItems = (Item: React.ElementType) => <>
    <Item onClick={onMultiSelect}>{t('remoteProjects.selectSession', { title })}</Item>
    <Item disabled={pinDisabled} onClick={onPin}>{t(pinned ? 'remoteProjects.unpin' : 'remoteProjects.pin')}</Item>
    <Item disabled={pending} onClick={onUnread}>{t(unread ? 'remoteProjects.markRead' : 'remoteProjects.markUnread')}</Item>
    <Item disabled={pending} onClick={onRename}>{t('sessions.sidebar.session.menu.rename')}</Item>
    <Item disabled={pending} onClick={onArchive}>{t(session.time.archived ? 'remoteProjects.unarchive' : 'sessions.sidebar.bulkActions.archive')}</Item>
    <Item disabled={pending} onClick={() => onFolder(null)}>{t('remoteProjects.removeFolder')}</Item>
    {folders.map((folder) => <Item key={folder.id} disabled={pending} onClick={() => onFolder(folder.id)}>{folder.name}</Item>)}
    <Item disabled={pending} onClick={onDelete} className="text-destructive focus:text-destructive">{t('sessions.sidebar.dialogs.deleteSession.titleAction')}</Item>
  </>;
  return <DraggableSessionRow sessionId={dragItem.id} sessionDirectory={dragItem.directory} sessionTitle={title}>
    <ContextMenu><ContextMenuTrigger>
    <SessionRowLayout data-remote-session={session.id} data-session-row={session.id} data-session-scope={dragItem.directory} active={active} selected={selected}>
    <SessionRowContent depth={depth}>
      <SessionRowTitle title={title} onClick={(event) => { if (event.metaKey || event.ctrlKey || event.shiftKey) onMultiSelect(); else onSelect(); }} onDoubleClick={onRename}
        className={card ? 'gap-0.5' : 'group-hover:pr-18 group-focus-within:pr-18'}>
        {card ? <>
          <div className="flex h-5 w-full min-w-0 items-center gap-1 overflow-hidden group-hover:pr-18 group-focus-within:pr-18">
            {leading}
            {card.badge}
            {unread > 0 && !busy ? <TaskUnreadDot /> : null}
            <span className={cn('min-w-0 flex-1 truncate text-xs leading-4', active || selected ? 'text-foreground/80' : 'text-muted-foreground')}>{secondaryMeta?.projectLabel}</span>
            <span className={cn('shrink-0 group-hover:invisible group-focus-within:invisible', menuOpen && 'invisible')}>
              {busy
                ? <span className="inline-flex items-center gap-1 text-[10px] font-medium leading-none tabular-nums text-status-info" title={t('sessions.sidebar.session.status.active')}><SessionBusyIndicator size={10} arcColor="var(--status-info)" /></span>
                : <span className={cn('text-[10px] leading-none tabular-nums', active || selected ? 'text-foreground/70' : 'text-muted-foreground/70')}>{formatSessionCompactDateLabel(session.time.updated ?? session.time.created ?? Date.now())}</span>}
            </span>
          </div>
          <div className="flex w-full min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <span className={cn('block min-w-0 flex-1 truncate text-[0.8125rem] text-foreground', unread > 0 && !busy ? 'font-medium' : 'font-normal')}>{renderHighlightedText(title, search)}</span>
          </div>
          <div className={cn('flex h-4 w-full min-w-0 items-center gap-1 overflow-hidden text-[10px] leading-4', active || selected ? 'text-foreground/60' : 'text-muted-foreground/60')}>
            {card.pathLabel ? <>
              <span className="inline-flex size-3.5 shrink-0 items-center justify-center"><Icon name="folder-open" className="size-2.5" /></span>
              <span className="min-w-0 flex-1 truncate">{card.pathLabel}</span>
            </> : <span className="flex-1" />}
            {pinned ? <Icon name="pushpin-2-fill" className="size-2.5 shrink-0" aria-label={t('remoteProjects.unpin')} /> : null}
          </div>
        </> : <>
        <span className="flex w-full min-w-0 items-center gap-1">
          {leading}
          <span className="block min-w-0 flex-1 truncate typography-ui-label font-normal text-foreground">{renderHighlightedText(title, search)}</span>
          {busy || unread > 0 ? (
            <span
              className={cn('inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center group-hover:hidden group-focus-within:hidden', menuOpen && 'hidden')}
              aria-label={t(busy ? 'sessions.sidebar.session.status.active' : 'sessions.sidebar.session.status.unread')}
              title={t(busy ? 'sessions.sidebar.session.status.active' : 'sessions.sidebar.session.status.unread')}
            >
              {busy ? <SessionBusyIndicator /> : <span className="h-2 w-2 rounded-full bg-[var(--status-info)]" />}
            </span>
          ) : null}
        </span>
        {secondaryMeta?.projectLabel || secondaryMeta?.branchLabel || subtitleSuffix ? (
          <span className="flex w-full min-w-0 items-center gap-1.5 overflow-hidden typography-meta text-muted-foreground">
            {secondaryMeta?.projectLabel ? <span className={cn('truncate', subtitleSuffix && 'max-w-[60%] shrink-0')}>{renderHighlightedText(secondaryMeta.projectLabel, search)}</span> : null}
            {secondaryMeta?.branchLabel ? <span className="inline-flex min-w-0 items-center gap-0.5"><Icon name="git-branch" className="h-3 w-3 flex-shrink-0" /><span className="truncate">{renderHighlightedText(secondaryMeta.branchLabel, search)}</span></span> : null}
            {subtitleSuffix}
          </span>
        ) : null}
        </>}
      </SessionRowTitle>
    </SessionRowContent>
    <SessionRowActions visible={menuOpen} className={card ? 'top-1.5 translate-y-0' : undefined}>
    <Button variant="ghost" size="icon" className="h-5 w-5" disabled={pinDisabled} onClick={onPin} aria-label={t(pinned ? 'remoteProjects.unpin' : 'remoteProjects.pin')}><Icon name={pinned ? 'pushpin-2-fill' : 'pushpin-2'} className="size-3.5" /></Button>
    <Button variant="ghost" size="icon" className="h-5 w-5" disabled={pending} onClick={onArchive} aria-label={t(session.time.archived ? 'remoteProjects.unarchive' : 'sessions.sidebar.bulkActions.archive')}><Icon name="archive" className="size-3.5" /></Button>
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-5 w-5" aria-label={t('remoteProjects.actions')}><Icon name="more-2" className="size-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent>
      {renderItems(DropdownMenuItem)}
    </DropdownMenuContent></DropdownMenu>
    </SessionRowActions>
  </SessionRowLayout></ContextMenuTrigger><ContextMenuContent className="min-w-[180px]">{renderItems(ContextMenuItem)}</ContextMenuContent></ContextMenu></DraggableSessionRow>;
}
