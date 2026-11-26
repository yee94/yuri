import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu';
import { dropdownMenuPopupClass, dropdownMenuSubTriggerClass } from '@/components/ui/dropdown-menu.styles';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn, formatDirectoryName } from '@/lib/utils';
import type { RemoteProject } from '@/lib/remote-projects/types';
import { getWorkspacePaths } from '@/lib/workspacePaths';
import { supportsRemoteProjects } from '@/queries/remoteProjectQueries';
import { PendingRemoteHostIndicator } from '../RemoteHostIndicator';
import { useRemoteHostDisplayName } from '@/lib/remote-projects/host-names';
import { SessionBusyIndicator } from '../SessionBusyIndicator';
import { SortableProjectItem } from './sortableItems';
import { formatSessionCompactDateLabel, renderHighlightedText } from './utils';
import { TaskRunningStatus, TaskUnreadDot } from './TaskCardParts';
import { readRemoteTaskRunStartedAt } from '@/lib/remote-projects/summaries';
import { SessionHoverDetails } from './SessionHoverDetails';
import { DraggableSessionRow } from './sessionFolderDnd';
import { SessionRowLayout, SessionRowContent, SessionRowTitle, SessionRowActions } from './SessionRowLayout';
import type { RemoteProjectShellProps, RemoteSummaryRowProps } from './remoteProjectPresentation';
import { MobileRemoteProjectShell } from './RemoteProjectMobileViews';

/** Multi-path workspace members on the project's own Host, matching local workspace rows. */
const remoteWorkspacePaths = (project: RemoteProject): string[] | undefined => {
  const paths = getWorkspacePaths(project);
  return paths.length > 1 ? paths : undefined;
};

export function RemoteProjectShell({ mobile, ...props }: RemoteProjectShellProps & { mobile: boolean }) {
  return mobile ? <MobileRemoteProjectShell {...props} /> : <DesktopRemoteProjectShell {...props} />;
}

function DesktopRemoteProjectShell({ project, registry, label, collapsed, active, loading, isRepo, reorderEnabled, iconSlot, actions, children }: RemoteProjectShellProps) {
  const [menu, setMenu] = React.useState<string | null>(null);
  return <SortableProjectItem id={project.id} hostId={project.hostId} remoteState={project.remoteState} hostRegistry={registry}
    projectLabel={label} projectDescription={project.path} projectIcon={project.icon ?? undefined} projectColor={project.color ?? undefined}
    workspacePaths={remoteWorkspacePaths(project)} projectIconSlot={iconSlot} isCollapsed={collapsed} isActiveProject={active} isSessionsLoading={loading} isRepo={isRepo} worktreeActionAvailable
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
    projectIcon={project.icon ?? undefined} projectColor={project.color ?? undefined} workspacePaths={remoteWorkspacePaths(project)}
    isCollapsed isActiveProject={false} isRepo={false}
    hideDirectoryControls mobileVariant={mobile} alwaysShowActions={false} reorderEnabled={reorderEnabled}
    showCreateButtons={false} onToggle={noop} onNewSession={noop} onSyncSessions={noop} onRenameStart={noop} onClose={noop}
    openSidebarMenuKey={menu} setOpenSidebarMenuKey={setMenu} />;
}

export function RemoteSummaryRow({ session, active, search, selected, pending, pinDisabled = pending, pinned, unread, status, dragItem, secondaryMeta, worktreeLabel, subtitleSuffix, leading, card, depth = 1, onSelect, onMultiSelect, onRename, onPin, onUnread, onArchive, onDelete, folders, onFolder }: RemoteSummaryRowProps) {
  const { t } = useI18n();
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [hoverOpen, setHoverOpen] = React.useState(false);
  const renameAfterMenu = React.useRef(false);
  const busy = status === 'busy' || status === 'retry';
  const title = session.title || t('sessions.sidebar.session.untitled');
  const time = card ? formatSessionCompactDateLabel(session.time.updated ?? session.time.created ?? Date.now()) : '';
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
  const titleButton = (
      <SessionRowTitle title={card ? undefined : title} onClick={(event) => { if (!card && (event.metaKey || event.ctrlKey || event.shiftKey)) onMultiSelect(); else onSelect(); }} onDoubleClick={card ? undefined : onRename}
        className={card ? 'gap-0.5' : 'group-hover:pr-18 group-focus-within:pr-18'}>
        {card ? <>
          <div className="flex h-5 w-full min-w-0 items-center gap-1 overflow-hidden group-hover:pr-12 group-focus-within:pr-12">
            {leading}
            {card.badge}
            {unread > 0 && !busy ? <TaskUnreadDot /> : null}
            <span className={cn('min-w-0 flex-1 truncate text-xs leading-4', active || selected ? 'text-foreground/80' : 'text-muted-foreground')}>{secondaryMeta?.projectLabel}</span>
            <span className={cn('shrink-0 group-hover:invisible group-focus-within:invisible', menuOpen && 'invisible')}>
              {busy
                ? <TaskRunningStatus startedAt={readRemoteTaskRunStartedAt(session)} />
                : <span className={cn('text-[10px] leading-none tabular-nums', active || selected ? 'text-foreground/70' : 'text-muted-foreground/70')}>{time}</span>}
            </span>
          </div>
          <div className="flex w-full min-w-0 flex-1 items-center gap-1 overflow-hidden">
            <span className={cn('block min-w-0 flex-1 truncate text-[0.8125rem] text-foreground', unread > 0 && !busy ? 'font-medium' : 'font-normal')}>{renderHighlightedText(title, search)}</span>
          </div>
          <div className={cn('flex h-4 w-full min-w-0 items-center gap-1 overflow-hidden text-[10px] leading-4', active || selected ? 'text-foreground/60' : 'text-muted-foreground/60')}>
            {secondaryMeta?.branchLabel ? <>
              <span className="inline-flex size-3.5 shrink-0 items-center justify-center"><Icon name="git-branch" className="size-2.5" /></span>
              <span className="min-w-0 flex-1 truncate">{secondaryMeta.branchLabel}</span>
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
        ) : worktreeLabel ? (
          <span
            data-session-worktree-footer
            className="mt-0.5 flex w-full min-w-0 items-center gap-1 overflow-hidden text-[10px] leading-3.5 text-muted-foreground/70"
            title={worktreeLabel}
          >
            <Icon name="git-branch" className="size-2.5 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate">{renderHighlightedText(worktreeLabel, search)}</span>
          </span>
        ) : null}
        </>}
      </SessionRowTitle>
  );
  const row = <SessionRowLayout data-remote-session={session.id} data-session-row={session.id} data-session-scope={dragItem.directory} active={active} selected={selected}>
    <SessionRowContent depth={depth}>
      {card ? <Tooltip open={hoverOpen && !menuOpen} onOpenChange={(open) => setHoverOpen(open && !menuOpen)}>
        <TooltipTrigger asChild>{titleButton}</TooltipTrigger>
        <TooltipContent side="right" align="start" sideOffset={8} className="w-64 max-w-[min(16rem,calc(100vw-2rem))] px-3 py-2.5 text-left shadow-md">
          {hoverOpen && !menuOpen ? <SessionHoverDetails session={session} title={title} time={time} projectLabel={secondaryMeta?.projectLabel}
            branch={secondaryMeta?.branchLabel} remote={{ hostLabel: card.hostLabel, projectBadge: card.badge }} /> : null}
        </TooltipContent>
      </Tooltip> : titleButton}
    </SessionRowContent>
    <SessionRowActions visible={menuOpen} className={card ? 'top-1.5 translate-y-0' : undefined}>
    <Button variant="ghost" size="icon" className="h-5 w-5" disabled={pinDisabled} onClick={onPin} aria-label={t(pinned ? 'remoteProjects.unpin' : 'remoteProjects.pin')}><Icon name={pinned ? 'pushpin-2-fill' : 'pushpin-2'} className="size-3.5" /></Button>
    <Button variant="ghost" size="icon" className="h-5 w-5" disabled={pending} onClick={onArchive} aria-label={t(session.time.archived ? 'remoteProjects.unarchive' : 'sessions.sidebar.bulkActions.archive')}><Icon name="archive" className="size-3.5" /></Button>
    {!card ? <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-5 w-5" aria-label={t('remoteProjects.actions')}><Icon name="more-2" className="size-3.5" /></Button></DropdownMenuTrigger><DropdownMenuContent>
      {renderItems(DropdownMenuItem)}
    </DropdownMenuContent></DropdownMenu> : null}
    </SessionRowActions>
  </SessionRowLayout>;
  return <DraggableSessionRow sessionId={dragItem.id} sessionDirectory={dragItem.directory} sessionTitle={title}>
    {card ? <ContextMenu open={menuOpen} onOpenChange={(open) => { setMenuOpen(open); if (open) setHoverOpen(false); }}
      onOpenChangeComplete={(open) => { if (!open && renameAfterMenu.current) { renameAfterMenu.current = false; onRename(); } }}>
      <ContextMenuTrigger render={row} />
      <ContextMenuContent className="yuri-session-context-menu min-w-[180px]" finalFocus={() => !renameAfterMenu.current}>
        <ContextMenuItem disabled={pinDisabled} onClick={onPin}><Icon name={pinned ? 'unpin' : 'pushpin'} className="mr-1 size-4" />{t(pinned ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin')}</ContextMenuItem>
        <ContextMenuItem disabled={pending} onClick={onUnread}><Icon name={unread ? 'mail-open' : 'mail'} className="mr-1 size-4" />{t(unread ? 'sessions.sidebar.session.menu.markRead' : 'sessions.sidebar.session.menu.markUnread')}</ContextMenuItem>
        <ContextMenuItem disabled={pending} onClick={() => { renameAfterMenu.current = true; }}><Icon name="pencil-ai" className="mr-1 size-4" />{t('sessions.sidebar.session.menu.rename')}</ContextMenuItem>
        <ContextMenuSeparator />
        <BaseContextMenu.SubmenuRoot>
          <BaseContextMenu.SubmenuTrigger disabled={pending} className={dropdownMenuSubTriggerClass}><Icon name="folder" className="mr-1 size-4" />{t('sessions.sidebar.folders.moveToFolder')}<Icon name="arrow-right-s" className="ml-auto size-3.5" /></BaseContextMenu.SubmenuTrigger>
          <BaseContextMenu.Portal><BaseContextMenu.Positioner className="app-region-no-drag z-50">
            <BaseContextMenu.Popup data-slot="dropdown-menu-sub-content" className={cn(dropdownMenuPopupClass, 'yuri-session-context-menu min-w-[180px]')}>
              {folders.length ? folders.map((folder) => (
                <ContextMenuItem key={folder.id} onClick={() => onFolder(folder.id === card.folderId ? null : folder.id)}>
                  <span className="flex-1 truncate">{folder.name}</span>
                  {folder.id === card.folderId ? <Icon name="check" className="ml-2 size-3.5 shrink-0 text-primary" /> : null}
                </ContextMenuItem>
              )) : <ContextMenuItem disabled>{t('sessions.sidebar.folders.none')}</ContextMenuItem>}
              {card.folderId ? <><ContextMenuSeparator /><ContextMenuItem onClick={() => onFolder(null)} className="text-destructive focus:text-destructive"><Icon name="close" className="mr-1 size-4" />{t('sessions.sidebar.folders.removeFromFolder')}</ContextMenuItem></> : null}
            </BaseContextMenu.Popup>
          </BaseContextMenu.Positioner></BaseContextMenu.Portal>
        </BaseContextMenu.SubmenuRoot>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={pending} onClick={onArchive}><Icon name="inbox-archive" className="mr-1 size-4" />{t('sessions.sidebar.bulkActions.archive')}</ContextMenuItem>
        <ContextMenuItem disabled={pending} onClick={onDelete} className="text-destructive/80 focus:text-destructive/80"><Icon name="delete-bin" className="mr-1 size-4 text-inherit" />{t('sessions.sidebar.bulkActions.delete')}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu> : <ContextMenu><ContextMenuTrigger>{row}</ContextMenuTrigger><ContextMenuContent className="min-w-[180px]">{renderItems(ContextMenuItem)}</ContextMenuContent></ContextMenu>}
  </DraggableSessionRow>;
}
