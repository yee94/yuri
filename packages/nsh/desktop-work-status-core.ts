import type { TranscriptSubagentFace, WorkStatusSubagent } from '../ui/src/components/chat/work-status/workStatusSubagents';
import * as sharedHelpers from './desktop-work-status-helpers.generated';
import { isTodoFinished, toTodoStatus } from '../ui/src/components/chat/todo/todoStatus';
import { summarizeTasks, type NativeTask } from './chat-tasks-model';
import type { PageOperation } from './page-operations';
import type { RuntimeScope } from './runtime-scope';

const { mergeWorkStatusSubagents, projectTranscriptSubagents, transcriptSubagentsEqual } = sharedHelpers as typeof import('../ui/src/components/chat/work-status/workStatusSubagents');

export const desktopWorkStatusGeometry = Object.freeze({ inlineWidth: 196, scrollbarLane: 14, overlayWidth: 264, inlineTop: 8, overlayTop: 12, overlayPadding: 8, breakpoint: 1440, todoMaxHeight: 195, rowHeight: 32 });
export type DesktopWorkStatusScope = Readonly<{ host: RuntimeScope; authorityKey: string; sessionID: string | null; directory: string | null }>;
export type WorkStatusAvailability<T> = Readonly<{ phase: 'ready'; value: T } | { phase: 'unknown' | 'unavailable' | 'failed'; value?: T }>;
export type DesktopWorkStatusChild = Readonly<{ id: string; parentID: string; directory: string; title?: string; activity: 'working' | 'idle' | 'unknown' }>;
export type DesktopWorkStatusChat = Readonly<{
  tasks: readonly NativeTask[];
  activity: 'working' | 'idle' | 'unknown';
  taskFaces: readonly TranscriptSubagentFace[];
  /** Exact live task part ids, never reconstructed from stored pending/running states. */
  liveTaskPartIDs: ReadonlySet<string>;
  /** Missing live aggregate stays unavailable/unknown, never a synthetic zero. */
  backgroundShell: WorkStatusAvailability<number>;
}>;
export type DesktopWorkStatusLocation = Readonly<{
  project: { label: string; path: string } | null;
  /** Already resolved against real project/worktree authority, not an inferred attachment. */
  secondaryWorktree: { label: string; path: string; pending?: boolean } | null;
  git: WorkStatusAvailability<{ branch: string | null; changedFiles: number | null; additions: number | null; deletions: number | null }> | Readonly<{ phase: 'not-repository'; value?: never }>;
}>;
export type DesktopWorkStatusAgent = Omit<WorkStatusSubagent, 'phase'> & { phase: 'working' | 'done' | 'unknown' };
export type DesktopWorkStatusChildRead = (operation: PageOperation, scope: DesktopWorkStatusScope) => Promise<readonly DesktopWorkStatusChild[]>;

/** Invoke from the original transcript's tool/revert commit, never from draft/text delta. */
export function createDesktopWorkStatusTaskProjection() {
  let previous: readonly TranscriptSubagentFace[] = [];
  return (data: Parameters<typeof projectTranscriptSubagents>[0]) => {
    const next = projectTranscriptSubagents(data);
    if (!transcriptSubagentsEqual(previous, next)) previous = next;
    return previous;
  };
}

export function desktopWorkStatusTodos(tasks: readonly NativeTask[], activity: DesktopWorkStatusChat['activity']) {
  const visible = tasks.filter(task => task.content.length > 0);
  const summary = summarizeTasks(visible, activity === 'working');
  // The phone pill's show/total intentionally excludes cancelled. Web WorkStatus does not.
  const completed = summary.completed, total = visible.length;
  const allDone = total > 0 && visible.every(isTodoFinished);
  const statuses = new Map(summary.rows().map(row => [row.todo, row.status]));
  return { completed, total, allDone, spinning: activity === 'working' && !allDone,
    inProgressIndex: visible.findIndex(task => task.status === 'in_progress'),
    rows: visible.map((task, index) => ({ task, key: `${task.id ?? index}:${index}`, status: statuses.get(task) ?? toTodoStatus(task.status) })) };
}

export function desktopWorkStatusAgents(chat: DesktopWorkStatusChat, children: readonly DesktopWorkStatusChild[]): DesktopWorkStatusAgent[] {
  const known = new Map(children.map(child => [child.id, child]));
  const safe = chat.taskFaces.map(face => ({ ...face, running: chat.liveTaskPartIDs.has(face.id) }));
  const merged = mergeWorkStatusSubagents(safe, children.map(child => ({ id: child.id, title: child.title, busy: child.activity === 'working' })));
  const unfinishedKeys = new Set(chat.taskFaces.filter(face => face.running).map(face => face.sessionID || face.id));
  return merged.map(agent => {
    if (agent.phase === 'working') return agent;
    const child = agent.sessionID ? known.get(agent.sessionID) : undefined;
    const unfinished = unfinishedKeys.has(agent.sessionID || agent.key);
    return child?.activity === 'unknown' || (!child && unfinished) ? { ...agent, phase: 'unknown' } : agent;
  });
}

const emptyChat: DesktopWorkStatusChat = { tasks: [], activity: 'unknown', taskFaces: [], liveTaskPartIDs: new Set(), backgroundShell: { phase: 'unavailable' } };
const emptyLocation: DesktopWorkStatusLocation = { project: null, secondaryWorktree: null, git: { phase: 'unknown' } };

/** Bounded to one captured Chat. No Chat, stream, global catalog, timer or network source is created. */
export function createDesktopWorkStatusProjection(options: { scope: DesktopWorkStatusScope; current: () => boolean; changed?: () => void }) {
  const scope = Object.freeze({ ...options.scope, host: Object.freeze({ ...options.scope.host }) });
  let alive = true, retired = false, serial = 0;
  let chat = emptyChat, location = emptyLocation;
  let children: WorkStatusAvailability<readonly DesktopWorkStatusChild[]> = { phase: 'unknown' };
  let todos = desktopWorkStatusTodos(chat.tasks, chat.activity), agents: DesktopWorkStatusAgent[] = [];
  let pending: { token: number; operation: PageOperation; promise: Promise<void> } | null = null;
  const current = () => { if (!options.current()) retired = true; return alive && !retired; };
  const notify = () => options.changed?.();
  const reproject = () => { agents = desktopWorkStatusAgents(chat, children.value ?? []); };
  const validChildren = (rows: readonly DesktopWorkStatusChild[]) => {
    if (!Array.isArray(rows) || rows.some(child => !child.id || child.parentID !== scope.sessionID || child.directory !== scope.directory || !['working', 'idle', 'unknown'].includes(child.activity))) throw new Error('work_status_child_scope');
    if (new Set(rows.map(child => child.id)).size !== rows.length) throw new Error('work_status_duplicate_child');
  };
  function retireLane() { serial++; pending = null; notify(); }
  return { scope, current,
    state: () => ({ chat, location, children, todos, agents, readingChildren: pending !== null }),
    commitChat(next: DesktopWorkStatusChat) {
      if (!current() || next === chat) return false;
      const planChanged = next.tasks !== chat.tasks || next.activity !== chat.activity;
      const facesChanged = next.taskFaces !== chat.taskFaces || next.liveTaskPartIDs !== chat.liveTaskPartIDs;
      if (!planChanged && !facesChanged && next.backgroundShell === chat.backgroundShell) return false;
      chat = next;
      if (planChanged) todos = desktopWorkStatusTodos(chat.tasks, chat.activity);
      if (facesChanged) reproject();
      notify(); return true;
    },
    commitLocation(next: DesktopWorkStatusLocation) {
      if (!current() || next === location) return false;
      // Unknown/new authority must be explicit. A failed refresh cannot erase its prior snapshot.
      location = next.git.phase === 'failed' && !next.git.value && location.git.value
        ? { ...next, git: { phase: 'failed', value: location.git.value } } : next;
      notify(); return true;
    },
    commitChildren(next: WorkStatusAvailability<readonly DesktopWorkStatusChild[]>) {
      if (!current() || next === children) return false;
      if (next.phase === 'ready' && !Array.isArray(next.value)) throw new Error('work_status_missing_children');
      if (next.value) validChildren(next.value);
      children = next.phase === 'failed' && !next.value ? { phase: 'failed', value: children.value } : next;
      serial++; pending = null; reproject(); notify(); return true;
    },
    async readChildren(operation: PageOperation, read: DesktopWorkStatusChildRead): Promise<void> {
      if (!current() || !operation.current() || !scope.sessionID || !scope.directory
        || operation.scope?.hostID !== scope.host.hostID || operation.scope?.lease !== scope.host.lease) return;
      if (pending?.operation === operation) return pending.promise;
      const token = ++serial;
      const valid = () => current() && operation.current() && token === serial;
      const promise = Promise.resolve().then(async () => {
        try {
          if (!valid()) return;
          const rows = await read(operation, scope);
          if (!valid()) return;
          validChildren(rows); children = { phase: 'ready', value: rows }; reproject();
        } catch { if (valid()) children = { phase: 'failed', value: children.value }; }
        finally { if (valid()) { pending = null; notify(); } }
      });
      pending = { token, operation, promise }; notify(); return promise;
    },
    retireLane,
    dispose() { alive = false; serial++; pending = null; },
  };
}
export type DesktopWorkStatusProjection = ReturnType<typeof createDesktopWorkStatusProjection>;

export type DesktopWorkStatusLayoutInput = Readonly<{ windowWidth: number; desktop: boolean; active: boolean; expandedInput: boolean; hasSession: boolean; draftConversation: boolean; previewOpen: boolean; rightSidebarOpen: boolean }>;
export function desktopWorkStatusLayout(input: DesktopWorkStatusLayoutInput, state: { enabled: boolean; overlayOpen: boolean }) {
  const mountable = input.desktop && input.active && !input.expandedInput && (input.hasSession || input.draftConversation);
  const fits = input.desktop && input.windowWidth >= desktopWorkStatusGeometry.breakpoint && !input.previewOpen && !input.rightSidebarOpen;
  const inline = mountable && state.enabled && fits;
  return { mountable, fits, inline, overlay: mountable && !inline && state.overlayOpen, selected: (state.enabled && fits) || state.overlayOpen,
    reserve: inline ? desktopWorkStatusGeometry.inlineWidth + desktopWorkStatusGeometry.scrollbarLane : 0 };
}
/** Root/window UI preference only; modal admission must not recreate this owner. */
export function createDesktopWorkStatusWindowOwner(changed: () => void = () => {}) {
  let enabled = true, overlayOpen = false;
  return { state: () => ({ enabled, overlayOpen }),
    toggle(fits: boolean) { if (fits) { enabled = !enabled; overlayOpen = false; } else { enabled = true; overlayOpen = !overlayOpen; } changed(); },
    closeOverlay() { if (overlayOpen) { overlayOpen = false; changed(); } },
    setEnabled(next: boolean) { enabled = next; overlayOpen = false; changed(); },
  };
}
