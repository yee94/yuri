import React from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { SIDEBAR_ROW_HOVER_CLASS } from './utils';
import { RemoteHostIndicator } from '../RemoteHostIndicator';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';

export interface SortableProjectItemProps {
  id: string;
  hostId?: string;
  remoteState?: RemoteProject['remoteState'];
  hostRegistry?: HostRuntimeRegistry;
  disabled?: boolean;
  projectLabel: string;
  projectDescription: string;
  projectIcon?: string;
  projectColor?: string;
  projectIconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  projectIconSlot?: React.ReactNode;
  isCollapsed: boolean;
  isActiveProject: boolean;
  /** True while this project's session directories are still fetching. */
  isSessionsLoading?: boolean;
  isRepo: boolean;
  worktreeActionAvailable?: boolean;
  hideDirectoryControls: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  onToggle: () => void;
  onNewSession: () => void;
  onNewWorktreeSession?: () => void;
  onSyncSessions: () => void;
  onRenameStart: () => void;
  onClose: () => void;
  children?: React.ReactNode;
  showCreateButtons?: boolean;
  hideHeader?: boolean;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  reorderEnabled?: boolean;
}

export type SortableDragHandleProps = {
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
};

export const SortableProjectItem = React.memo(function SortableProjectItem({
  id,
  hostId,
  remoteState,
  hostRegistry,
  disabled = false,
  projectLabel,
  projectDescription,
  projectIcon,
  projectColor,
  projectIconImage,
  projectIconSlot,
  isCollapsed,
  isActiveProject,
  isSessionsLoading = false,
  isRepo,
  worktreeActionAvailable = isRepo,
  hideDirectoryControls,
  alwaysShowActions,
  onToggle,
  onNewSession,
  onNewWorktreeSession,
  onSyncSessions,
  onRenameStart,
  onClose,
  children,
  showCreateButtons = true,
  hideHeader = false,
  openSidebarMenuKey,
  setOpenSidebarMenuKey,
  reorderEnabled = true,
}: SortableProjectItemProps) {
  const { t } = useI18n();
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: disabled || !reorderEnabled });

  const suppressNextToggleRef = React.useRef(false);
  const menuInstanceKey = `project:${id}`;
  const isMenuOpen = openSidebarMenuKey === menuInstanceKey;
  const [isContextMenuOpen, setIsContextMenuOpen] = React.useState(false);
  const projectIconName = projectIcon ? PROJECT_ICON_MAP[projectIcon] : null;
  const projectIconColor = projectColor ? PROJECT_COLOR_MAP[projectColor] : undefined;
  const projectIconFallback = <Icon name={projectIconName ?? 'folder-open'} className="h-4 w-4" style={projectIconColor ? { color: projectIconColor } : undefined} />;

  const handleMenuOpenChange = React.useCallback((open: boolean) => {
    if (open) setIsContextMenuOpen(false);
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  }, [menuInstanceKey, setOpenSidebarMenuKey]);

  const renderProjectMenuItems = (Item: React.ElementType, Separator: React.ElementType) => (
    <>
      {showCreateButtons && !isRepo && !hideDirectoryControls && onNewSession && (
        <Item onClick={onNewSession}>
          <Icon name="add" className="mr-1.5 h-4 w-4 text-inherit" />
          {t('sessions.sidebar.project.actions.newSession')}
        </Item>
      )}
      <Item onClick={onSyncSessions}>
        <Icon name="refresh" className="mr-1.5 h-4 w-4 text-inherit" />
        {t('sessions.sidebar.project.actions.syncSessions')}
      </Item>
      <Item onClick={onRenameStart}>
        <Icon name="pencil-ai" className="mr-1.5 h-4 w-4 text-inherit" />
        {t('sessions.sidebar.project.actions.edit')}
      </Item>
      <Separator />
      <Item onClick={onClose} className="text-destructive focus:text-destructive">
        <Icon name="close" className="mr-1.5 h-4 w-4 text-inherit" />
        {t('sessions.sidebar.project.actions.closeProject')}
      </Item>
    </>
  );

  const handleMenuTriggerClick = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerPointerDown = React.useCallback((event: React.PointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleMenuTriggerMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
  }, []);

  const handleToggleMouseDown = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey)) {
      suppressNextToggleRef.current = true;
    }
  }, []);

  const handleToggleClick = React.useCallback(() => {
    if (suppressNextToggleRef.current) {
      suppressNextToggleRef.current = false;
      return;
    }
    onToggle();
  }, [onToggle]);

  const remoteActionCount = Number(!hideDirectoryControls)
    + Number(showCreateButtons && Boolean(onNewSession))
    + Number(showCreateButtons && worktreeActionAvailable && !hideDirectoryControls && Boolean(onNewWorktreeSession));

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={cn('relative', isDragging && 'opacity-30')}
    >
      {!hideHeader ? (
        <>
          <ContextMenu open={isContextMenuOpen} onOpenChange={setIsContextMenuOpen}>
            <ContextMenuTrigger
              render={
                <div
                  className={cn('w-full text-left group/project select-none')}
                  onContextMenu={(event) => {
                    // VS Code hides project actions entirely (hideDirectoryControls).
                    if (hideDirectoryControls) return;
                    event.preventDefault();
                    setIsContextMenuOpen(true);
                  }}
                />
              }
            >
            <div data-sidebar-project-header={id} className={cn('relative flex items-center gap-1.5 rounded-lg px-2 py-1.5', SIDEBAR_ROW_HOVER_CLASS)} {...attributes}>
                    <button
                      type="button"
                      onMouseDown={handleToggleMouseDown}
                      onClick={handleToggleClick}
                       {...(reorderEnabled ? listeners : {})}
                       style={hostId && hostRegistry ? { '--project-actions-clip': `${remoteActionCount * 1.75 + 0.25}rem` } as React.CSSProperties : undefined}
                      className={cn(
                        'flex-1 min-w-0 flex items-center gap-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 rounded-md transition-[padding]',
                        reorderEnabled ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
                        hostId && hostRegistry
                          ? [
                            'pr-0 [--project-title-mask:linear-gradient(to_right,#000_calc(100%-var(--project-actions-clip)-8px),transparent_calc(100%-var(--project-actions-clip)))]',
                            remoteActionCount > 0 && (alwaysShowActions || isMenuOpen
                              ? '[mask-image:var(--project-title-mask)] [clip-path:inset(0_var(--project-actions-clip)_0_0)]'
                              : 'group-hover/project:[mask-image:var(--project-title-mask)] group-hover/project:[clip-path:inset(0_var(--project-actions-clip)_0_0)] group-has-[:focus-visible]/project:[mask-image:var(--project-title-mask)] group-has-[:focus-visible]/project:[clip-path:inset(0_var(--project-actions-clip)_0_0)]'),
                          ]
                          : isRepo && !hideDirectoryControls
                            ? (alwaysShowActions ? 'pr-20' : 'pr-7 group-hover/project:pr-20 group-has-[:focus-visible]/project:pr-20')
                            : (alwaysShowActions ? 'pr-14' : 'pr-7 group-hover/project:pr-14 group-has-[:focus-visible]/project:pr-14'),
                      )}
                    >
                    <Tooltip>
                    <TooltipTrigger asChild>
                    <span className={cn('flex min-w-0 items-center gap-1.5', hostId && hostRegistry && 'max-w-[60%] shrink-0')}>
                    <span
                      className="inline-flex h-4 w-4 flex-shrink-0 items-center justify-center overflow-hidden text-foreground"
                    >
                      {isSessionsLoading ? (
                        <Icon
                          name="loader-4"
                          className="h-4 w-4 animate-spin"
                          aria-label={t('sessions.sidebar.project.loadingSessions')}
                        />
                      ) : (
                        <>
                          <span className={cn(
                            'h-4 w-4 items-center justify-center',
                            alwaysShowActions ? 'inline-flex' : 'hidden group-hover/project:inline-flex group-has-[:focus-visible]/project:inline-flex',
                          )}>
                            {isCollapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
                          </span>
                          <span className={cn(hostId && hostRegistry ? 'inline-flex items-center' : 'relative top-px', alwaysShowActions ? 'hidden' : 'group-hover/project:hidden group-has-[:focus-visible]/project:hidden')}>
                            {projectIconSlot ?? (projectIconImage ? (
                              <ProjectIconImage
                                project={{ id, iconImage: projectIconImage }}
                                className="size-full object-contain"
                                fallback={projectIconFallback}
                              />
                            ) : projectIconFallback)}
                          </span>
                        </>
                      )}
                    </span>
                    <span className={cn(
                      'text-[14px] font-normal truncate lowercase',
                      hostId && hostRegistry && 'leading-5',
                      isActiveProject ? 'text-foreground' : 'text-foreground group-hover/project:text-foreground',
                    )}>
                      {projectLabel}
                    </span>
                    </span>
                </TooltipTrigger>
                <TooltipContent side="right" sideOffset={8}>
                  {projectDescription}
                </TooltipContent>
              </Tooltip>
                    {hostId && hostRegistry ? <RemoteHostIndicator registry={hostRegistry} hostId={hostId} remoteState={remoteState} compactName /> : null}
                  </button>

              <div className={cn(hostId && hostRegistry ? [
                'absolute right-0.5 top-1/2 z-10 flex h-8 -translate-y-1/2 items-center gap-1 rounded-r-lg pl-3 pr-0.5',
                alwaysShowActions || isMenuOpen ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-has-[:focus-visible]/project:opacity-100 group-has-[:focus-visible]/project:pointer-events-auto',
              ] : 'contents')}>
              <div className={cn(
                hostId && hostRegistry ? 'contents' : ['absolute top-1/2 z-10 flex -translate-y-1/2 items-center gap-1', showCreateButtons ? 'right-7' : 'right-0.5'],
              )}>
                {showCreateButtons && worktreeActionAvailable && !hideDirectoryControls && onNewWorktreeSession ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewWorktreeSession();
                        }}
                        className={cn(
                        'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground transition-opacity',
                          alwaysShowActions || (hostId && hostRegistry && isMenuOpen) ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-has-[:focus-visible]/project:opacity-100 group-has-[:focus-visible]/project:pointer-events-auto',
                        )}
                        aria-label={t('sessions.sidebar.project.actions.newWorktree')}
                      >
                        <Icon name="node-tree" className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{t('sessions.sidebar.project.actions.newWorktreeEllipsis')}</p>
                    </TooltipContent>
                  </Tooltip>
                ) : null}

                {!hideDirectoryControls ? (
                <DropdownMenu
                  open={isMenuOpen}
                  onOpenChange={handleMenuOpenChange}
                >
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 hover:text-foreground',
                          isMenuOpen
                            ? 'opacity-100 pointer-events-auto'
                            : alwaysShowActions
                              ? 'opacity-100'
                              : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-has-[:focus-visible]/project:opacity-100 group-has-[:focus-visible]/project:pointer-events-auto',
                        )}
                        aria-label={t('sessions.sidebar.project.actions.projectMenu')}
                        onPointerDown={handleMenuTriggerPointerDown}
                        onMouseDown={handleMenuTriggerMouseDown}
                        onClick={handleMenuTriggerClick}
                      >
                        <Icon name="more-2" className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="min-w-[180px]">
                      {renderProjectMenuItems(DropdownMenuItem, DropdownMenuSeparator)}
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : null}
              </div>

              {showCreateButtons && onNewSession ? (
                <div className={cn(!(hostId && hostRegistry) && 'absolute right-0.5 top-1/2 z-10 -translate-y-1/2')}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onNewSession();
                        }}
                        className={cn(
                          'inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 transition-opacity',
                          alwaysShowActions || (hostId && hostRegistry && isMenuOpen) ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/project:opacity-100 group-hover/project:pointer-events-auto group-has-[:focus-visible]/project:opacity-100 group-has-[:focus-visible]/project:pointer-events-auto',
                        )}
                        aria-label={isRepo
                          ? t('sessions.sidebar.project.actions.newDraftSession')
                          : t('sessions.sidebar.project.actions.newSession')}
                      >
                        <Icon name="add" className="h-4 w-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" sideOffset={4}>
                      <p>{isRepo
                        ? t('sessions.sidebar.project.actions.newDraftSession')
                        : t('sessions.sidebar.project.actions.newSession')}</p>
                    </TooltipContent>
                  </Tooltip>
                </div>
              ) : null}
              </div>
            </div>
            </ContextMenuTrigger>
            <ContextMenuContent className="min-w-[180px]">
              {renderProjectMenuItems(ContextMenuItem, ContextMenuSeparator)}
            </ContextMenuContent>
          </ContextMenu>
        </>
      ) : null}

      {children}
    </div>
  );
});

const SortableGroupItemBase: React.FC<{
  id: string;
  disabled?: boolean;
  children: React.ReactNode | ((dragHandleProps: SortableDragHandleProps) => React.ReactNode);
}> = ({ id, disabled = false, children }) => {
  const {
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const dragHandleProps = React.useMemo<SortableDragHandleProps>(() => ({
    listeners,
    setActivatorNodeRef,
  }), [listeners, setActivatorNodeRef]);

  return (
    <div
      ref={setNodeRef}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
      }}
      className={cn(
        'space-y-0.5 rounded-md',
        isDragging && 'opacity-50',
      )}
    >
      {typeof children === 'function' ? children(dragHandleProps) : children}
    </div>
  );
};

export const SortableGroupItem = React.memo(SortableGroupItemBase);
