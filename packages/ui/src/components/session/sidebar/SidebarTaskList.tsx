import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { SIDEBAR_MUTED_HINT_CLASS } from './utils';
import { SidebarSectionHeader } from './SidebarSectionHeader';
import type { PinnedItem } from './SidebarPinnedSessions';
import { SETTLED_SHELF_PAGE_SIZE } from './taskView';
import { SessionFolderDndScope } from './sessionFolderDnd';
import { TasksAllDoneIllustration } from './TasksAllDoneIllustration';

export type TaskListItems = {
  active: PinnedItem[];
  /** Only the rows the Settled shelf currently shows (empty while collapsed). */
  settled: PinnedItem[];
  /** Full Settled count, independent of how many rows are built. */
  settledTotal: number;
};

const ShelfCount = ({ count }: { count: number }) => (
  <span className="mr-2 typography-micro tabular-nums text-muted-foreground/70">{count}</span>
);

type TaskListProps = {
  items: TaskListItems;
  renderTaskRow: (item: PinnedItem) => React.ReactNode;
  /** Drag within the active list; the caller keeps the result in memory only. */
  onSessionsReordered?: (activeSessionId: string, overSessionId: string) => void;
};

/**
 * Scrolling part of the task view: one flat list. Running tasks sit in it with
 * their status word; rows are the shared session rows, so context menus,
 * selection and Mod+number hints behave exactly like the project tree.
 */
export function SidebarTaskList({ items, renderTaskRow, onSessionsReordered }: TaskListProps): React.ReactNode {
  const { t } = useI18n();
  const sessionIds = React.useMemo(() => items.active.map((item) => item.node.session.id), [items.active]);
  const folderIdBySessionId = React.useMemo(() => new Map(sessionIds.map((id) => [id, null])), [sessionIds]);
  if (items.active.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 pt-6 pb-2">
        <TasksAllDoneIllustration className="size-20" />
        <div className={`${SIDEBAR_MUTED_HINT_CLASS} !text-center`}>{t('sessions.sidebar.task.empty')}</div>
      </div>
    );
  }
  const rows = items.active.map(renderTaskRow);
  return (
    <div className="-ml-1 space-y-0.5">
      {onSessionsReordered && items.active.length > 1 ? (
        <SessionFolderDndScope
          scopeKey="task-active"
          sessionIds={sessionIds}
          folderIdBySessionId={folderIdBySessionId}
          onSessionDroppedOnFolder={noopDrop}
          onSessionsReordered={onSessionsReordered}
        >
          {rows}
        </SessionFolderDndScope>
      ) : rows}
    </div>
  );
}

const noopDrop = (): void => {};

type SettledShelfProps = {
  items: TaskListItems;
  open: boolean;
  onToggle: () => void;
  onShowMore: () => void;
  renderTaskRow: (item: PinnedItem) => React.ReactNode;
};

/**
 * Settled shelf, pinned to the bottom of the sidebar (outside the scroll
 * area). Collapsed it is one header row; open, its rows scroll inside a capped
 * region and are paged so a shelf of hundreds stays cheap to expand.
 */
export function SidebarSettledShelf({ items, open, onToggle, onShowMore, renderTaskRow }: SettledShelfProps): React.ReactNode {
  const { t } = useI18n();
  if (items.settledTotal === 0) return null;
  const remaining = items.settledTotal - items.settled.length;
  const nextPage = Math.min(SETTLED_SHELF_PAGE_SIZE, remaining);
  return (
    <div className="shrink-0 px-3 pb-1">
      <SidebarSectionHeader
        title={t('sessions.sidebar.task.shelf.settled')}
        onToggle={onToggle}
        expanded={open}
        className="pt-2 pb-1"
        leadingIcon={<Icon name="archive" className="-ml-1 mr-0.5 size-3.5 shrink-0 text-foreground/55" />}
        accessory={<ShelfCount count={items.settledTotal} />}
      />
      {open ? (
        <div className="-ml-1 -mr-2 max-h-[40vh] space-y-px overflow-y-auto overscroll-contain">
          {items.settled.map(renderTaskRow)}
          {remaining > 0 ? (
            <button
              type="button"
              onClick={onShowMore}
              className={`${SIDEBAR_MUTED_HINT_CLASS} rounded-md hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50`}
            >
              {t(nextPage === 1 ? 'sessions.sidebar.group.showMoreSingle' : 'sessions.sidebar.group.showMorePlural', { count: nextPage })}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
