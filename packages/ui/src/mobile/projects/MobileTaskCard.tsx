import * as React from 'react';
import { useEvent } from '@reactuses/core';

import { Icon } from '@/components/icon/Icon';
import { SessionBusyIndicator } from '@/components/session/SessionBusyIndicator';
import { TaskProjectBadge, TaskRunElapsed, type TaskProjectMark } from '@/components/session/sidebar/TaskCardParts';
import { Button } from '@/components/ui/button';
import {
  createMobileLongPressController,
  type MobileLongPressController,
} from '@/components/ui/mobileLongPress';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
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
};

function MobileTaskCardImpl({ task, runStartedAt, onSelect, onOpenActions }: TaskCardProps) {
  const { t } = useI18n();
  const running = useSessionActivity(task.id);
  const permissions = useSessionPermissions(task.id, task.directory, { bootstrap: false });
  const questions = useSessionQuestions(task.id, task.directory, { bootstrap: false });
  const indicator = resolveMobileSessionIndicator({
    hasPendingQuestion: questions.length > 0,
    hasPendingPermission: permissions.length > 0,
    running,
    unread: task.unread,
  });
  const longPressRef = React.useRef<MobileLongPressController | null>(null);
  if (!longPressRef.current) longPressRef.current = createMobileLongPressController();
  React.useEffect(() => () => longPressRef.current?.reset(), []);

  const handleOpenActions = useEvent(() => onOpenActions(task.id));
  const handleClick = useEvent(() => {
    if (longPressRef.current?.consumeClick(task.id)) return;
    onSelect(task.id);
  });
  const handlePointerDown = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    if ((event.pointerType !== 'touch' && event.pointerType !== 'pen') || event.button !== 0) return;
    longPressRef.current?.start({
      pointerId: event.pointerId,
      key: task.id,
      clientX: event.clientX,
      clientY: event.clientY,
      onTrigger: () => onOpenActions(task.id),
    });
  });
  const handlePointerMove = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.move(event.pointerId, event.clientX, event.clientY);
  });
  const handlePointerEnd = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.end(event.pointerId);
  });
  const handlePointerCancel = useEvent((event: React.PointerEvent<HTMLButtonElement>) => {
    longPressRef.current?.cancel(event.pointerId);
  });
  const handleContextMenu = useEvent((event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    longPressRef.current?.openFromContextMenu(task.id, () => onOpenActions(task.id));
  });

  const waitingLabel = indicator === 'question'
    ? t('sessions.sidebar.session.status.questionRequired')
    : indicator === 'permission'
      ? t('sessions.sidebar.session.status.permissionRequired')
      : null;
  const statusSlot = waitingLabel ? (
    <span
      className="inline-flex shrink-0 items-center gap-1 typography-micro font-medium leading-none text-status-warning"
      aria-label={waitingLabel}
    >
      <Icon name={indicator === 'question' ? 'question' : 'shield'} className="size-3" />
      {waitingLabel}
    </span>
  ) : indicator === 'running' ? (
    <span
      className="inline-flex shrink-0 items-center gap-1 typography-micro font-medium leading-none tabular-nums text-status-info"
      title={t('sessions.sidebar.session.status.active')}
    >
      <SessionBusyIndicator size={11} arcColor="var(--status-info)" className="motion-reduce:[&_svg]:animate-none" />
      {runStartedAt !== null ? <TaskRunElapsed startedAt={runStartedAt} /> : null}
    </span>
  ) : task.activityLabel ? (
    <span className="shrink-0 typography-micro leading-none tabular-nums text-muted-foreground">{task.activityLabel}</span>
  ) : null;
  const receding = indicator === 'running' && !task.active;

  return (
    <div className="yuri-mobile-floating-surface relative overflow-hidden rounded-[var(--yuri-mobile-surface-radius)]">
      <button
        type="button"
        data-mobile-press-feedback="soft"
        className={cn(
          'block w-full min-w-0 px-4 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]',
          task.active && 'bg-interactive-selection',
        )}
        style={{ touchAction: 'pan-y' }}
        onClick={handleClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerCancel}
        onContextMenu={handleContextMenu}
      >
        <span className="flex h-6 items-center gap-1.5 pr-9">
          <TaskProjectBadge project={task.project} />
          <span className="min-w-0 flex-1 truncate typography-small font-medium text-muted-foreground">{task.projectLabel}</span>
          {statusSlot}
        </span>
        <span
          className={cn(
            'yuri-mobile-entity-title mt-0.5 line-clamp-2 block text-foreground',
            task.unread ? 'font-semibold' : 'font-medium',
            receding && 'text-foreground/70',
          )}
        >
          {task.title}
        </span>
        {task.branch || task.pinned ? (
          <span className="mt-1 flex h-4 items-center gap-1 typography-micro text-muted-foreground/70">
            {task.branch ? (
              <>
                <Icon name="git-branch" className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{task.branch}</span>
              </>
            ) : <span className="flex-1" />}
            {task.pinned ? (
              <Icon name="pushpin-2-fill" className="size-3 shrink-0" aria-label={t('sessions.sidebar.session.actions.pinned')} />
            ) : null}
          </span>
        ) : null}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-1.5 top-1.5 min-h-9 min-w-9 rounded-full text-muted-foreground"
        aria-label={t('sessions.sidebar.session.menu.label')}
        onClick={handleOpenActions}
      >
        <Icon name="more-2" className="size-3.5" />
      </Button>
    </div>
  );
}

export const MobileTaskCard = React.memo(MobileTaskCardImpl);

type SettledLineProps = {
  task: MobileTaskNode;
  onSelect: (sessionId: string) => void;
  onRestore: (sessionId: string) => void;
};

function MobileSettledLineImpl({ task, onSelect, onRestore }: SettledLineProps) {
  const { t } = useI18n();
  const handleSelect = useEvent(() => onSelect(task.id));
  const handleRestore = useEvent(() => onRestore(task.id));
  return (
    <div className="flex min-h-12 items-center gap-1 pl-4 pr-2 [&:not(:last-child)]:shadow-[inset_0_-1px_0_var(--yuri-mobile-divider)]">
      <button
        type="button"
        data-mobile-press-feedback="soft"
        className="flex min-w-0 flex-1 items-center gap-2 py-3 text-left outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
        onClick={handleSelect}
      >
        <TaskProjectBadge project={task.project} />
        <span className="min-w-0 flex-1 truncate typography-ui-label text-muted-foreground">{task.title}</span>
        {task.activityLabel ? (
          <span className="shrink-0 typography-micro tabular-nums text-muted-foreground/70">{task.activityLabel}</span>
        ) : null}
      </button>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="min-h-9 min-w-9 shrink-0 rounded-full text-muted-foreground"
        aria-label={t('sessions.sidebar.session.menu.unsettle')}
        onClick={handleRestore}
      >
        <Icon name="restart" className="size-4" />
      </Button>
    </div>
  );
}

export const MobileSettledLine = React.memo(MobileSettledLineImpl);
