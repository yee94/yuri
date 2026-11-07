import { toTodoStatus, type TodoListItem } from '../ui/src/components/chat/todo/todoStatus';
import { record, text, type Message } from './model';

export type NativeTask = TodoListItem & { priority: string };
const rejected = new Set(['error', 'aborted', 'failed', 'cancelled', 'canceled', 'timeout']);

/** Exact Web precedence; fallback arrays convey content only, never live execution. */
export function resolveTaskSources(transcript: readonly NativeTask[] | undefined, live: readonly NativeTask[] | undefined, persisted: readonly NativeTask[] | undefined): readonly NativeTask[] {
  return transcript ?? (live?.length ? live : persisted ?? []);
}

/** Native raw inputs are JSON strings; projected/legacy inputs are already objects. */
function taskInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return undefined; }
}
function normalizeTasks(value: unknown[]): NativeTask[] {
  return value.flatMap(value => {
    const item = record(value);
    if (typeof item.content !== 'string' || typeof item.status !== 'string') return [];
    return [{ content: item.content, status: item.status, priority: typeof item.priority === 'string' ? item.priority : 'medium', ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}) }];
  });
}

/**
 * Matches Web projectLatestTodosFromTranscript, whose module imports browser stores.
 * Main invokes this on tool/revert authority changes, not input edits/text deltas.
 * Only the selected raw input is retained; message arrays and history are not cached.
 */
export function createTasksProjection() {
  let previousInput: unknown, previousTasks: NativeTask[] | undefined;
  return (messages: readonly Message[], revertMessageID?: string): NativeTask[] | undefined => {
    const cut = revertMessageID ? messages.findIndex(message => message.id === revertMessageID) : -1;
    for (let index = (cut >= 0 ? cut : messages.length) - 1; index >= 0; index--) {
      const message = messages[index]!;
      const parts = message.content ?? message.tools;
      for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
        const part = parts[partIndex]!, state = record(part.state);
        if (part.type !== 'tool' || (text(part.name) || text(part.tool)).trim().toLowerCase() !== 'todowrite' || rejected.has(text(state.status).trim().toLowerCase())) continue;
        if (state.input === previousInput && previousTasks !== undefined) return previousTasks;
        const todos = record(taskInput(state.input)).todos;
        if (!Array.isArray(todos)) continue;
        previousInput = state.input; previousTasks = normalizeTasks(todos);
        return previousTasks;
      }
    }
    return undefined;
  };
}

/** Historical tasks describe a plan, never execution. Only liveWorking drives animation. */
export function summarizeTasks(todos: readonly TodoListItem[], liveWorking: boolean) {
  const visible = todos.filter(todo => todo.status !== 'cancelled');
  const completed = visible.filter(todo => todo.status === 'completed').length;
  const active = visible.filter(todo => todo.status === 'in_progress').length;
  const left = visible.filter(todo => todo.status === 'in_progress' || todo.status === 'pending').length;
  const working = visible.findIndex(todo => todo.status === 'in_progress');
  const activeIndex = working >= 0 ? working : visible.findIndex(todo => todo.status === 'pending');
  return { visible, completed, total: visible.length, active, left, activeIndex, show: left > 0, spinning: liveWorking,
    rows: () => visible.map((todo, index) => ({ todo, key: todo.id ? `${todo.id}:${index}` : `${index}:${todo.content}`, current: index === activeIndex,
      status: liveWorking && working < 0 && index === activeIndex && todo.status === 'pending' ? 'in_progress' as const : toTodoStatus(todo.status) })),
  };
}
export type TasksSummary = ReturnType<typeof summarizeTasks>;

export type ChatStatusPopover = 'tasks' | 'changes' | null;
/** Phone StatusRow has exactly one open surface. Changes must consume this same owner. */
export function createChatStatusPopovers(notify: () => void = () => {}) {
  let opened: ChatStatusPopover = null;
  const set = (next: ChatStatusPopover) => { if (opened !== next) { opened = next; notify(); } };
  return { opened: () => opened,
    tasks: (open: boolean) => set(open ? 'tasks' : opened === 'tasks' ? null : opened),
    changes: (open: boolean) => set(open ? 'changes' : opened === 'changes' ? null : opened),
    close: () => set(null),
  };
}
