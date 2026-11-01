import React from 'react';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

import { toTodoStatus, type TodoListItem, type TodoStatus } from './todoStatus';

const statusLabelKey = {
  in_progress: 'chat.statusRow.todo.status.inProgress',
  pending: 'chat.statusRow.todo.status.pending',
  completed: 'chat.statusRow.todo.status.completed',
  cancelled: 'chat.statusRow.todo.status.cancelled',
} as const;

const glyphClassName: Record<TodoStatus, string> = {
  in_progress: 'text-foreground',
  pending: 'text-muted-foreground/60',
  completed: 'text-muted-foreground',
  cancelled: 'text-muted-foreground/60',
};

const textClassName: Record<TodoStatus, string> = {
  in_progress: 'text-foreground',
  pending: 'text-muted-foreground',
  completed: 'text-muted-foreground/60 line-through decoration-1',
  cancelled: 'text-muted-foreground/60 line-through decoration-1',
};

// Dashes: 12 segments on the ring, between the old chunky look and a too-fine one.
const DASH_STROKE_WIDTH = 1.2;
const DASH_PATH_LENGTH = 24;
const DASH_PATTERN = '1 1';

// Same glyph set as OpenCode's native to-do pill: ring, half-filled, check, slash.
// Sized in em so it follows the surrounding font size.
export const TodoGlyph: React.FC<{ status: TodoStatus; className?: string }> = ({ status, className }) => {
  const { t } = useI18n();
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      role="img"
      aria-label={t(statusLabelKey[status])}
      className={cn('size-[1em] shrink-0 transition-colors duration-300', glyphClassName[status], className)}
    >
      <circle
        cx="8"
        cy="8"
        r="6.5"
        stroke="currentColor"
        strokeWidth={status === 'pending' ? DASH_STROKE_WIDTH : undefined}
        pathLength={status === 'pending' ? DASH_PATH_LENGTH : undefined}
        strokeDasharray={status === 'pending' ? DASH_PATTERN : undefined}
      />
      {status === 'in_progress' ? <path d="M4.8 8h6.4M8.6 5.4 11.2 8l-2.6 2.6" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {status === 'completed' ? <path d="M5 8 7.5 11 11 5.5" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /> : null}
      {status === 'cancelled' ? <path d="M3.5 12.5 12.5 3.5" stroke="currentColor" /> : null}
    </svg>
  );
};

const PIE_RADIUS = 3.2;

const piePath = (fraction: number): string => {
  const angle = Math.PI * 2 * fraction;
  const x = 8 + PIE_RADIUS * Math.sin(angle);
  const y = 8 - PIE_RADIUS * Math.cos(angle);
  return `M8 8 L8 ${8 - PIE_RADIUS} A${PIE_RADIUS} ${PIE_RADIUS} 0 ${fraction > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
};

// Header mark while work remains: dashed ring (spins when busy) around a pie of the completed share.
export const TodoProgressMark: React.FC<{ done?: number; total?: number; spinning?: boolean; className?: string }> = ({ done = 0, total = 0, spinning = false, className }) => {
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className={cn('size-[1.15em] shrink-0 text-foreground', className)}>
      <circle
        cx="8"
        cy="8"
        r="6.5"
        stroke="currentColor"
        strokeWidth={DASH_STROKE_WIDTH}
        pathLength={DASH_PATH_LENGTH}
        strokeDasharray={DASH_PATTERN}
        className={spinning ? 'yuri-todo-spin' : undefined}
        style={{ transformBox: 'fill-box', transformOrigin: 'center' }}
      />
      {fraction > 0 ? <path d={piePath(fraction)} fill="currentColor" className="transition-opacity duration-300" /> : null}
    </svg>
  );
};

// done/total counter; the done digit rolls in when it changes (never on first paint).
export const TodoCount: React.FC<{ done: number; total: number; className?: string; animate?: boolean }> = ({ done, total, className, animate = true }) => {
  const previous = React.useRef(done);
  const changed = animate && previous.current !== done;
  React.useEffect(() => {
    previous.current = done;
  }, [done]);
  return (
    <span className={cn('shrink-0 tabular-nums', className)}>
      <span key={done} className={cn(changed && 'yuri-todo-count-tick')}>{done}</span>
      {`/${total}`}
    </span>
  );
};

// All-complete header mark: green disc with a check, matching the sidebar.
export const TodoCompleteMark: React.FC<{ className?: string }> = ({ className }) => (
  <span data-todo-complete className={cn('flex size-[1.15em] shrink-0 items-center justify-center rounded-full bg-[var(--status-success)] text-[var(--status-success-foreground)]', className)}>
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="size-[70%]">
      <path d="M4.5 8.2 7 10.8 11.5 5.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  </span>
);

type TodoListProps = {
  todos: readonly TodoListItem[];
  isWorking?: boolean;
  animate?: boolean;
  className?: string;
  rowClassName?: string;
  listRef?: React.Ref<HTMLUListElement>;
  id?: string;
};

// Font size comes from the host: rows use `em`/inherit and never set px sizes.
export const TodoList: React.FC<TodoListProps> = ({ todos, isWorking = false, animate = false, className, rowClassName, listRef, id }) => {
  const { t } = useI18n();
  const activeIndex = React.useMemo(() => {
    const inProgress = todos.findIndex((todo) => todo.status === 'in_progress');
    return inProgress >= 0 ? inProgress : todos.findIndex((todo) => todo.status === 'pending');
  }, [todos]);
  // While the session works and the agent marked nothing in progress, the first pending item is the one in hand.
  const hasInProgress = React.useMemo(() => todos.some((todo) => todo.status === 'in_progress'), [todos]);

  return (
    <ul id={id} ref={listRef} className={cn('m-0 flex min-w-0 list-none flex-col gap-[0.125em] p-0', className)}>
      {todos.map((todo, index) => {
        const rawStatus = toTodoStatus(todo.status);
        const status: TodoStatus = isWorking && !hasInProgress && index === activeIndex && rawStatus === 'pending' ? 'in_progress' : rawStatus;
        return (
          <li
            key={todo.id ?? `${index}:${todo.content}`}
            data-status={status}
            aria-current={index === activeIndex ? 'step' : undefined}
            className={cn('grid min-w-0 shrink-0 grid-cols-[auto_minmax(0,1fr)] items-start py-[0.25em]', rowClassName ?? 'gap-[0.6em] px-[0.5em]', animate && 'yuri-todo-row-in')}
          >
            <span key={status} className={cn('flex h-[1.32em] items-center', animate && 'yuri-todo-icon-pop')} title={t(statusLabelKey[status])}>
              <TodoGlyph status={status} />
            </span>
            <span dir="auto" title={todo.content} className={cn('line-clamp-3 min-w-0 whitespace-normal text-[0.88em] break-words leading-[1.5] transition-colors duration-300', textClassName[status])}>
              <span className={cn(status === 'in_progress' && 'animate-text-shimmer')}>{todo.content}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
};
