import React from 'react';
import { TodoCompleteMark, TodoCount, TodoList, TodoProgressMark } from '@/components/chat/todo/TodoList';
import { isTodoFinished } from '@/components/chat/todo/todoStatus';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import type { Todo } from '@/lib/opencode/v2-types';
import { cn } from '@/lib/utils';
import { useTodosPersistStore } from '@/stores/useTodosPersistStore';
import { useDirectorySync, useSessionLatestTodos } from '@/sync/sync-context';
import type { State as DirectorySyncState } from '@/sync/types';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const EMPTY_TODOS: Todo[] = [];

const LocalWorkStatusTodos: React.FC<Props> = ({ sessionId, directory }) => {
  const liveSelector = React.useMemo(() => (
    (state: DirectorySyncState) => (sessionId ? state.todo[sessionId] : undefined) ?? EMPTY_TODOS
  ), [sessionId]);
  const liveTodos = useDirectorySync(liveSelector, directory ?? undefined);
  const workingSelector = React.useMemo(() => (
    (state: DirectorySyncState) => {
      const type = sessionId ? state.session_status?.[sessionId]?.type : undefined;
      return type === 'busy' || type === 'retry';
    }
  ), [sessionId]);
  const isWorking = useDirectorySync(workingSelector, directory ?? undefined);
  const persistedSelector = React.useMemo(() => (
    (state: ReturnType<typeof useTodosPersistStore.getState>) => (sessionId ? state.sessions[sessionId]?.todos : undefined)
  ), [sessionId]);
  const persistedTodos = useTodosPersistStore(persistedSelector);
  const transcriptTodos = useSessionLatestTodos(sessionId ?? '', directory ?? undefined);

  const todos = React.useMemo(() => {
    // The transcript is authoritative (empty list clears). Legacy todo.updated
    // state and the persisted copy only cover sessions with no todowrite loaded.
    const source = transcriptTodos ?? (liveTodos.length > 0 ? liveTodos : persistedTodos ?? EMPTY_TODOS);
    return source.filter((todo) => todo.content.length > 0);
  }, [transcriptTodos, liveTodos, persistedTodos]);
  return <WorkStatusTodoList todos={todos} isWorking={isWorking} />;
};

export const WorkStatusTodos: React.FC<Props & { remote?: { todos: Todo[]; isWorking: boolean } }> = ({ remote, ...props }) => (
  remote ? <WorkStatusTodoList {...remote} /> : <LocalWorkStatusTodos {...props} />
);

const WorkStatusTodoList: React.FC<{ todos: Todo[]; isWorking: boolean }> = ({ todos, isWorking }) => {
  const { t } = useI18n();
  const listId = React.useId();
  const [expanded, setExpanded] = React.useState(true);
  const [settled, setSettled] = React.useState(false);
  React.useEffect(() => { setSettled(true); }, []);
  const doneCount = React.useMemo(() => todos.filter((todo) => todo.status === 'completed').length, [todos]);
  const finishedCount = React.useMemo(() => todos.filter(isTodoFinished).length, [todos]);
  const listRef = React.useRef<HTMLUListElement>(null);

  const inProgressIndex = React.useMemo(() => todos.findIndex((todo) => todo.status === 'in_progress'), [todos]);
  React.useEffect(() => {
    if (inProgressIndex < 0) return;
    listRef.current?.children[inProgressIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [inProgressIndex]);

  if (todos.length === 0) return null;

  const allDone = finishedCount === todos.length;
  const headerSpinning = isWorking && !allDone;

  return (
    <div role="group" aria-label={t('chat.workStatus.todos.title')} className="mt-2 flex min-w-0 flex-col text-[13px]">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="yuri-work-status-action flex w-full min-w-0 items-center justify-start gap-2 px-2 text-left text-[1em] font-normal leading-5 tracking-normal text-muted-foreground [&_svg]:size-3.5"
        aria-expanded={expanded}
        aria-controls={listId}
        onClick={() => setExpanded((value) => !value)}
      >
        <span key={allDone ? 'done' : 'open'} className={cn('inline-flex shrink-0', settled && 'yuri-todo-icon-pop')}>
          {allDone ? (
            <TodoCompleteMark />
          ) : (
            <TodoProgressMark done={doneCount} total={todos.length} spinning={headerSpinning} />
          )}
        </span>
        <span className="min-w-0 flex-1 truncate text-foreground">{t('chat.workStatus.todos.title')}</span>
        <TodoCount done={doneCount} total={todos.length} className="text-[0.92em]" />
      </Button>
      <div
        id={listId}
        aria-hidden={!expanded}
        inert={!expanded}
        className={cn(
          'grid min-w-0 transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none',
          expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        )}
      >
        <TodoList id={undefined} todos={todos} isWorking={isWorking} animate={settled} listRef={listRef} rowClassName="px-2 gap-2 [&_svg]:size-3.5 [&>span:first-child]:w-3.5" className="max-h-[15em] min-h-0 overflow-y-auto pt-[0.125em]" />
      </div>
    </div>
  );
};
