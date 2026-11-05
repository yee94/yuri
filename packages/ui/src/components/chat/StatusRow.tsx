import React from "react";
import { useEvent } from '@reactuses/core';
import { useSessionUIStore } from '@/sync/session-ui-store';
import type { State as DirectorySyncState } from '@/sync/types';
import { cn } from "@/lib/utils";
import { useDirectorySync, useSessionLatestTodos } from "@/sync/sync-context";
import type { Todo } from '@/lib/opencode/v2-types';
import { TodoCompleteMark, TodoCount, TodoList, TodoProgressMark } from "./todo/TodoList";
import { PendingChangesBar } from "./PendingChangesBar";

// Compat aliases for old TodoItem shape
type TodoItem = Todo & { id?: string };
import { useUIStore } from "@/stores/useUIStore";
import { useTodosPersistStore } from "@/stores/useTodosPersistStore";
import { WorkingPlaceholder } from "./message/parts/WorkingPlaceholder";
import { getToolRowBlockClass } from "./message/parts/toolRowChrome";
import { isVSCodeRuntime } from "@/lib/desktop";
import { Icon } from "@/components/icon/Icon";
import { useI18n } from "@/lib/i18n";
import { useSessionSurface } from "./SessionSurfaceContext";
import {
  statusBarPopoverClassName,
  statusBarPopoverStyle,
  statusBarComposerPopoverStyle,
  statusBarTriggerClassName,
  statusBarTriggerIconClassName,
  statusBarTriggerLabelClassName,
  statusBarTriggerMetaClassName,
} from "./statusBarPopover";

const STATUS_ROW_CONTAINER_STYLE = { containerType: "inline-size" as const, containerName: "status-row" };

const EMPTY_TODOS: TodoItem[] = [];

interface StatusRowProps {
  // Working state
  isWorking?: boolean;
  statusText?: string | null;
  isGenericStatus?: boolean;
  isWaitingForPermission?: boolean;
  wasAborted?: boolean;
  abortActive?: boolean;
  retryInfo?: { attempt?: number; next?: number; message?: string } | null;
  turnStartedAt?: number;
  /** Authoritative turn settle — drop the working-hint slot immediately. */
  isTurnSettled?: boolean;
  // Abort status display
  showAbortStatus?: boolean;
  /** First Esc armed: show "press Esc again to abort" until window expires. */
  showAbortPrompt?: boolean;
  showAssistantStatus?: boolean;
  showTodos?: boolean;
  agentName?: string;
  showPendingChanges?: boolean;
  /** Mounted inside the composer's `chat-input-column`; must not add another column. */
  insideInputColumn?: boolean;
  className?: string;
}

export const StatusRow: React.FC<StatusRowProps> = ({
  isWorking = false,
  statusText = null,
  isGenericStatus,
  isWaitingForPermission,
  wasAborted,
  abortActive,
  retryInfo,
  turnStartedAt,
  isTurnSettled = false,
  showAbortStatus,
  showAbortPrompt = false,
  showAssistantStatus = true,
  showTodos = true,
  agentName,
  showPendingChanges = false,
  insideInputColumn = false,
  className,
}) => {
  const { t } = useI18n();
  const [expandedPopovers, setExpandedPopovers] = React.useState({ todos: false, changes: false });
  const isExpanded = expandedPopovers.todos;
  const sessionSurface = useSessionSurface();
  const primarySessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionId = sessionSurface.sessionId ?? primarySessionId;
  const liveTodosSelector = React.useMemo(() => (
    state: DirectorySyncState
  ) => {
    if (!showTodos || !currentSessionId) return EMPTY_TODOS;
    return state.todo[currentSessionId] ?? EMPTY_TODOS;
  }, [currentSessionId, showTodos]);
  const liveTodos = useDirectorySync(
    liveTodosSelector,
    sessionSurface.directory ?? undefined,
  );
  const persistedTodosSelector = React.useMemo(() => (
    state: ReturnType<typeof useTodosPersistStore.getState>
  ) => (showTodos && currentSessionId ? state.sessions[currentSessionId]?.todos : undefined), [currentSessionId, showTodos]);
  const persistedSessionTodos = useTodosPersistStore(
    persistedTodosSelector,
  );
  const transcriptTodos = useSessionLatestTodos(
    showTodos && currentSessionId ? currentSessionId : '',
    sessionSurface.directory ?? undefined,
  );
  const todos: TodoItem[] = React.useMemo(() => {
    if (!currentSessionId) return EMPTY_TODOS;
    if (transcriptTodos) return transcriptTodos;
    if (liveTodos.length > 0) return liveTodos;
    return persistedSessionTodos ?? EMPTY_TODOS;
  }, [transcriptTodos, liveTodos, persistedSessionTodos, currentSessionId]);
  const isMobile = useUIStore((state) => state.isMobile);
  const isCompact = isMobile || isVSCodeRuntime();
  const changesExpanded = expandedPopovers.changes && (!isMobile || !isExpanded);

  // Filter out cancelled todos for display and keep original order.
  // This prevents items from jumping around when status changes.
  const visibleTodos = React.useMemo(() => {
    return todos.filter((todo) => todo.status !== "cancelled");
  }, [todos]);

  // Find the current active todo (first in_progress, or first pending)
  const activeTodo = React.useMemo(() => {
    return (
      visibleTodos.find((t) => t.status === "in_progress") ||
      visibleTodos.find((t) => t.status === "pending") ||
      null
    );
  }, [visibleTodos]);

  // Calculate progress
  const progress = React.useMemo(() => {
    const total = todos.filter((t) => t.status !== "cancelled").length;
    const completed = todos.filter((t) => t.status === "completed").length;
    return { completed, total };
  }, [todos]);

  const statusSummary = React.useMemo(() => {
    const active = visibleTodos.filter((t) => t.status === "in_progress").length;
    const left = visibleTodos.filter((t) => t.status === "in_progress" || t.status === "pending").length;
    return { active, left };
  }, [visibleTodos]);

  const hasTodoContent = showTodos && statusSummary.left > 0;
  const hasAbortPrompt = Boolean(showAbortPrompt);
  // Keep the assistant status slot mounted briefly after isWorking drops so
  // WorkingPlaceholder can linger (~600ms) across step gaps without collapsing
  // the row (scrollHeight ±28px chase). Skip that linger once the turn is
  // authoritatively settled — otherwise the hint flashes after Changes chrome.
  const [assistantStatusLinger, setAssistantStatusLinger] = React.useState(false);
  React.useEffect(() => {
    if (isTurnSettled) {
      setAssistantStatusLinger(false);
      return;
    }
    if (isWorking) {
      setAssistantStatusLinger(true);
      return;
    }
    if (!assistantStatusLinger) return;
    const timer = window.setTimeout(() => setAssistantStatusLinger(false), 600);
    return () => window.clearTimeout(timer);
  }, [isWorking, assistantStatusLinger, isTurnSettled]);
  const hasAssistantContent = showAssistantStatus && (
    (!isTurnSettled && (isWorking || assistantStatusLinger)) ||
    Boolean(wasAborted) ||
    Boolean(showAbortStatus)
  );
  const isEmbedded = showPendingChanges || insideInputColumn;
  // Original logic from ChatInput
  const shouldRenderPlaceholder = !showAbortStatus && !hasAbortPrompt && (wasAborted || !abortActive);

  const hasContent = hasAbortPrompt || hasAssistantContent || hasTodoContent || showPendingChanges;

  // Close popover when clicking outside
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const todoPopoverRef = React.useRef<HTMLDivElement>(null);
  const changesPopoverRef = React.useRef<HTMLDivElement>(null);
  const todoListRef = React.useRef<HTMLUListElement>(null);
  React.useLayoutEffect(() => {
    const list = todoListRef.current;
    const activeItem = list?.querySelector<HTMLElement>('[aria-current="step"]') ?? null;
    if (!isExpanded || !list || !activeItem) return;

    const centeredScrollTop = activeItem.offsetTop - list.offsetTop - (list.clientHeight - activeItem.offsetHeight) / 2;
    const maxScrollTop = list.scrollHeight - list.clientHeight;
    list.scrollTop = Math.min(maxScrollTop, Math.max(0, centeredScrollTop));
  }, [isExpanded]);

  React.useEffect(() => {
    if (!isExpanded && !changesExpanded) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (isMobile) {
        if (popoverRef.current && !popoverRef.current.contains(target)) {
          setExpandedPopovers({ todos: false, changes: false });
        }
        return;
      }
      const closeTodos = isExpanded && todoPopoverRef.current && !todoPopoverRef.current.contains(target);
      const closeChanges = changesExpanded && changesPopoverRef.current && !changesPopoverRef.current.contains(target);
      if (!closeTodos && !closeChanges) return;
      setExpandedPopovers((current) => ({
        todos: closeTodos ? false : current.todos,
        changes: closeChanges ? false : current.changes,
      }));
    };

    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [isExpanded, changesExpanded, isMobile]);

  const toggleExpanded = useEvent(() => setExpandedPopovers((current) => ({
    todos: !current.todos,
    changes: isMobile && !current.todos ? false : current.changes,
  })));
  const handleChangesExpandedChange = useEvent((expanded: boolean) => setExpandedPopovers((current) => ({
    todos: isMobile && expanded ? false : current.todos,
    changes: expanded,
  })));
  const todoSummaryLabel = t('chat.statusRow.summary.activeLeft', {
    active: statusSummary.active,
    left: statusSummary.left,
  });

  // Todo trigger button
  const todoTrigger = hasTodoContent ? (
    <button
      type="button"
      onClick={toggleExpanded}
      className={cn(statusBarTriggerClassName, "yuri-status-row-trigger shrink-0")}
      aria-label={todoSummaryLabel}
      title={todoSummaryLabel}
      aria-expanded={isExpanded}
    >
      {statusSummary.left === 0 ? (
        <TodoCompleteMark />
      ) : (
        <TodoProgressMark done={progress.completed} total={progress.total} spinning={isWorking} />
      )}
      {/* Desktop: show task text; Mobile/VSCode: just "Tasks" */}
      {!isCompact && activeTodo ? (
        <span className={cn("status-row__active-todo max-w-[200px]", statusBarTriggerLabelClassName)}>
          {activeTodo.content}
        </span>
      ) : (
        <span className={cn(statusBarTriggerLabelClassName, "text-muted-foreground")}>{t('chat.statusRow.tasksTitle')}</span>
      )}
      <TodoCount done={progress.completed} total={progress.total} className={statusBarTriggerMetaClassName} animate={false} />
      {isExpanded ? (
        <Icon name="arrow-up-s" className={statusBarTriggerIconClassName} />
      ) : (
        <Icon name="arrow-down-s" className={statusBarTriggerIconClassName} />
      )}
    </button>
  ) : null;

  // Don't render if nothing to show
  if (!hasContent) {
    return null;
  }

  return (
    <div ref={popoverRef} className={cn("mb-1", isMobile && "relative", !isEmbedded && "chat-column -mt-1", !isEmbedded && getToolRowBlockClass(isMobile), className)} style={STATUS_ROW_CONTAINER_STYLE}>
      {/*
        When showPendingChanges is set (ChatInput pending-changes row), the parent is
        already `chat-input-column`. Use the same horizontal inset as the composer
        textarea (`px-3`) so the status triggers align with input content.
      */}
      <div className={cn("flex items-center justify-between py-0.5 gap-2", isEmbedded && "px-3")}>
        {/* Left: Abort prompt | Abort status | Working placeholder | Changes */}
        <div ref={changesPopoverRef} className={cn("flex-1 flex items-center min-w-0 gap-2", !isEmbedded && "overflow-x-hidden")}>
          {hasAbortPrompt ? (
            <div
              className="flex min-w-0 items-center text-muted-foreground"
              role="status"
              aria-live="polite"
              aria-label={t('chat.statusRow.abortPrompt')}
            >
              <span className={cn("flex min-w-0 items-center typography-ui-label", isMobile ? "gap-1" : "gap-1.5")}>
                <span className={cn("inline-flex flex-none items-center justify-center", isMobile ? "h-5 w-4" : "h-6 w-3.5")}>
                  <Icon name="error-warning" className="size-3.5" aria-hidden="true" />
                </span>
                <span className="animate-text-shimmer truncate whitespace-nowrap">
                  {t('chat.statusRow.abortPrompt')}
                </span>
              </span>
            </div>
          ) : showAssistantStatus && showAbortStatus ? (
            <div className="flex h-full items-center text-[var(--status-error)]">
              <span className={cn("flex items-center typography-ui-label", isMobile ? "gap-1" : "gap-1.5")}>
                <span className={cn("inline-flex flex-none items-center justify-center", isMobile ? "h-5 w-4" : "h-6 w-3.5")}>
                  <Icon name="close-circle" className="size-3.5" aria-hidden="true" />
                </span>
                {t('chat.statusRow.aborted')}
              </span>
            </div>
          ) : showAssistantStatus && shouldRenderPlaceholder ? (
            <WorkingPlaceholder
              key={currentSessionId ?? "no-session"}
              isWorking={isWorking}
              isMobile={isMobile}
              statusText={statusText}
              isGenericStatus={isGenericStatus}
              isWaitingForPermission={isWaitingForPermission}
              retryInfo={retryInfo}
              turnStartedAt={turnStartedAt}
              isTurnSettled={isTurnSettled}
              agentName={agentName}
            />
          ) : showPendingChanges ? (
            <PendingChangesBar isExpanded={changesExpanded} onExpandedChange={handleChangesExpandedChange} />
          ) : null}
        </div>

        {/* Right: Todo */}
        <div ref={todoPopoverRef} className={cn("flex items-center gap-2 flex-shrink-0", !isMobile && "relative", !isEmbedded && "-mr-3")}>
          {todoTrigger}

          {/* Popover dropdown */}
          {isExpanded && hasTodoContent && (
            <div
              style={isMobile ? statusBarComposerPopoverStyle : statusBarPopoverStyle}
              className={cn(
                statusBarPopoverClassName,
                "absolute right-0 bottom-full mb-1 z-50",
                "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                "duration-150 p-[0.5em] pb-[0.875em]",
                isMobile ? "text-xs leading-4 md:text-[0.8125rem] md:leading-5" : "text-base"
              )}
            >
              {/* Header */}
              <div className="flex items-center gap-[0.6em] px-[0.5em] pt-[0.25em] pb-[0.5em]">
                {progress.completed === progress.total ? (
                  <TodoCompleteMark />
                ) : (
                  <TodoProgressMark done={progress.completed} total={progress.total} spinning={isWorking} />
                )}
                <span className={cn("min-w-0 flex-1 truncate leading-[1.5] text-foreground", !isMobile && "text-[0.88em]")}>{t('chat.workStatus.todos.title')}</span>
                <TodoCount done={progress.completed} total={progress.total} className={cn("text-muted-foreground", !isMobile && "text-[0.88em]")} />
              </div>

              {/* Todo list */}
              <TodoList
                todos={visibleTodos}
                isWorking={isWorking}
                animate
                listRef={todoListRef}
                className={cn("max-h-[min(22rem,50vh)] overflow-y-auto text-inherit", isMobile && "[&_[dir=auto]]:text-[1em]")}
                rowClassName="gap-[0.6em] px-[0.5em] py-[0.4em]"
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
