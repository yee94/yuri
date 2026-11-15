import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { SessionBusyIndicator } from '@/components/session/SessionBusyIndicator';
import { TaskProjectBadge, TaskRunElapsed, TaskUnreadDot, type TaskProjectMark } from '@/components/session/sidebar/TaskCardParts';
import { Button } from '@/components/ui/button';
import { MobileSwipeActionRail } from '@/components/ui/MobileSwipeActionRail';
import { useMobileSwipeActions } from '@/components/ui/useMobileSwipeActions';
import {
  createMobileLongPressController,
  type MobileLongPressController,
} from '@/components/ui/mobileLongPress';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionReadMenuAction } from '@/mobile/useSessionReadMenuAction';
import {
  useSessionActivity,
  useSessionPermissions,
  useSessionQuestions,
} from '@/sync/sync-context';

import { resolveMobileSessionIndicator } from './mobileSessionIndicator';

export type MobileTaskNode = {
  id: string;
  title: string;
  directory?: string;
  projectLabel: string;
  project: TaskProjectMark | null;
  branch?: string;
  branchState?: 'loading' | 'no-git' | null;
  pathLabel?: string;
  activityLabel?: string;
  unread: boolean;
  pinned: boolean;
  active: boolean;
};

type TaskCardProps = {
  task: MobileTaskNode;
  runStartedAt: number | null;
  onSelect: (sessionId: string) => void;
  onOpenActions: (sessionId: string) => void;
  onPin: (sessionId: string) => void;
  onArchive: (sessionId: string) => void;
  /** Archived rows keep the card but swipe to Unarchive instead of Pin / Archive. */
  archived?: boolean;
  onRestore?: (sessionId: string) => void;
};

function MobileTaskCardImpl({ task, runStartedAt, onSelect, onOpenActions, onPin, onArchive, archived, onRestore }: TaskCardProps) {
  const { t } = useI18n();
  const running = useSessionActivity(task.id);
  const { unread, onToggleRead } = useSessionReadMenuAction(task, undefined, running);
  const permissions = useSessionPermissions(task.id, task.directory, { bootstrap: false });
  const questions = useSessionQuestions(task.id, task.directory, { bootstrap: false });
  const indicator = resolveMobileSessionIndicator({
    hasPendingQuestion: questions.length > 0,
    hasPendingPermission: permissions.length > 0,
    running,
    unread,
  });
  const longPressRef = React.useRef<MobileLongPressController | null>(null);
  const handleArchive = () => {
    if (!running && !archived) onArchive(task.id);
  };
  const swipe = useMobileSwipeActions(task.id, () => onSelect(task.id), false, !running && !archived ? handleArchive : undefined);
  if (!longPressRef.current) longPressRef.current = createMobileLongPressController();
  React.useEffect(() => () => longPressRef.current?.reset(), []);

  const handleOpenActions = useEvent(() => {
    swipe.handlePointerCancel();
    swipe.closeActions();
    onOpenActions(task.id);
  });
  const handleClick = () => {
    if (longPressRef.current?.consumeClick(task.id)) return;
    swipe.handleSelect();
  };
  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || event.button !== 0) return;
    swipe.handlePointerDown(event);
    longPressRef.current?.start({
      pointerId: event.pointerId,
      key: task.id,
      clientX: event.clientX,
      clientY: event.clientY,
      onTrigger: handleOpenActions,
    });
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.move(event.pointerId, event.clientX, event.clientY);
    swipe.handlePointerMove(event);
    if (event.isDefaultPrevented()) longPressRef.current?.cancel(event.pointerId);
  };
  const handlePointerEnd = (event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.end(event.pointerId);
    swipe.finishGesture(event);
  };
  const handlePointerCancel = (event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.cancel(event.pointerId);
    swipe.handlePointerCancel();
  };
  const handleContextMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    longPressRef.current?.openFromContextMenu(task.id, handleOpenActions);
  };

  const waitingLabel = indicator === 'question'
    ? t('sessions.sidebar.session.status.questionRequired')
    : indicator === 'permission'
      ? t('sessions.sidebar.session.status.permissionRequired')
      : null;
  const statusSlot = waitingLabel ? (
    <span
      className="yuri-mobile-task-meta inline-flex min-w-0 max-w-[55%] items-center gap-1 font-medium text-status-warning"
      aria-label={waitingLabel}
    >
      <Icon name={indicator === 'question' ? 'question' : 'shield'} className="size-3 shrink-0" />
      <span className="truncate">{waitingLabel}</span>
    </span>
  ) : indicator === 'running' ? (
    <span
      className="yuri-mobile-task-meta inline-flex shrink-0 items-center gap-1 font-medium tabular-nums text-foreground"
      title={t('sessions.sidebar.session.status.active')}
    >
      <SessionBusyIndicator size={11} arcColor="var(--status-info)" className="motion-reduce:[&_svg]:animate-none" />
      {runStartedAt !== null ? <TaskRunElapsed startedAt={runStartedAt} /> : null}
    </span>
  ) : task.activityLabel ? (
    <span className="yuri-mobile-task-meta shrink-0 tabular-nums text-muted-foreground">{task.activityLabel}</span>
  ) : null;

  return (
    <div className="yuri-mobile-task-card relative isolate overflow-hidden">
      <MobileSwipeActionRail swipe={swipe} actions={[
        ...(onToggleRead ? [{
          label: t(unread ? 'sessions.sidebar.session.swipe.markRead' : 'sessions.sidebar.session.swipe.markUnread'),
          ariaLabel: t(unread ? 'sessions.sidebar.session.menu.markRead' : 'sessions.sidebar.session.menu.markUnread'),
          icon: unread ? 'mail-open' as const : 'mail' as const,
          variant: 'default' as const,
          onClick: onToggleRead,
        }] : []),
        ...(archived ? [
          {
            label: t('sessions.sidebar.session.menu.unsettle'),
            icon: 'undo-2' as const,
            onClick: () => onRestore?.(task.id),
          },
        ] : [
          {
            label: t(task.pinned ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin'),
            icon: task.pinned ? 'unpin' as const : 'pushpin' as const,
            onClick: () => onPin(task.id),
          },
          ...(!running ? [{
            label: t('sessions.sidebar.bulkActions.archive'),
            icon: 'inbox-archive' as const,
            destructive: true,
            variant: 'destructiveSolid' as const,
            fullSwipe: true,
            onClick: handleArchive,
          }] : []),
        ]),
      ]} />
      <div
        className={cn(
          'yuri-mobile-task-content relative z-10 min-w-0 ease-out motion-reduce:transition-none',
          swipe.dragging ? 'transition-none' : 'transition-transform duration-150',
        )}
        style={{
          transform: `translate3d(${swipe.offset}px, 0, 0)`,
          willChange: swipe.offset === 0 ? undefined : 'transform',
        }}
      >
        <button
          type="button"
          data-mobile-press-feedback="soft"
          data-mobile-session-id={task.id}
          className="yuri-mobile-task-select relative block w-full min-w-0 py-3.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
          style={{ touchAction: 'pan-y' }}
          onClick={handleClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerCancel}
          onContextMenu={handleContextMenu}
        >
          <span className="yuri-mobile-task-avatar" aria-hidden="true">
            <TaskProjectBadge project={task.project} />
          </span>
          <span className="flex h-4 items-center gap-1.5 pr-9">
            {indicator === 'completed-unread' ? <TaskUnreadDot /> : null}
            <span className="yuri-mobile-task-project min-w-0 flex-1 truncate text-muted-foreground">{task.projectLabel}</span>
            {statusSlot}
          </span>
          <span
            className={cn(
              'yuri-mobile-entity-title mt-1 line-clamp-2 break-words text-foreground',
              unread ? 'font-medium' : 'font-normal',
            )}
          >
            {task.title}
          </span>
          <span className="yuri-mobile-task-branch yuri-mobile-task-meta mt-1.5 flex h-3.5 items-center gap-1 text-muted-foreground">
            {task.branch || task.branchState === 'loading' ? (
              <>
                <Icon name="git-branch" className="size-3 shrink-0" />
                <span
                  className={cn('min-w-0 flex-1 truncate', !task.branch && 'opacity-60')}
                  aria-busy={!task.branch && task.branchState === 'loading' ? true : undefined}
                >
                  {task.branch || t('common.loading')}
                </span>
              </>
            ) : task.pathLabel ? (
              <>
                <Icon name="folder-open" className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{task.pathLabel}</span>
              </>
            ) : <span className="flex-1" />}
            {task.pinned ? (
              <span className="yuri-mobile-task-pin inline-flex shrink-0 items-center justify-center">
                <Icon name="pushpin-2-fill" className="size-3 shrink-0" aria-label={t('sessions.sidebar.session.actions.pinned')} />
              </span>
            ) : null}
          </span>
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="yuri-mobile-task-more absolute top-1 min-h-9 min-w-9 rounded-full text-muted-foreground"
          aria-label={t('sessions.sidebar.session.menu.label')}
          onClick={handleOpenActions}
        >
          <Icon name="more-2" className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

export const MobileTaskCard = React.memo(MobileTaskCardImpl);
