import type { Session } from '@/lib/opencode/v2-types';

import { getSessionActivityUpdatedAt } from '@/lib/sessionActivity';

export type SidebarView = 'tasks' | 'projects';

export const DEFAULT_SIDEBAR_VIEW: SidebarView = 'projects';

export const parseSidebarView = (value: unknown): SidebarView => (
  value === 'tasks' || value === 'projects' ? value : DEFAULT_SIDEBAR_VIEW
);

export type TaskBuckets = {
  active: Session[];
  settled: Session[];
};

type TaskBucketInput = {
  sessions: readonly Session[];
  pinnedSessionIds: ReadonlySet<string>;
  /** Host-projected settled membership (override, baseline and cooldown already applied). */
  settledSessionIds: ReadonlySet<string>;
  runningSessionIds: ReadonlySet<string>;
  pendingRequestSessionIds: ReadonlySet<string>;
  unseenBySession: Readonly<Record<string, number>>;
};

/** Rows the Settled shelf renders per page; a shelf can hold hundreds of sessions. */
export const SETTLED_SHELF_PAGE_SIZE = 30;

const isArchived = (session: Session): boolean => {
  const archived = session.time?.archived;
  return typeof archived === 'number' && archived > 0;
};

const isSubtask = (session: Session): boolean => Boolean((session as Session & { parentID?: string | null }).parentID);

/** Archived and subtask rows never appear in the task view. */
export const isTaskViewSession = (session: Session): boolean => !isArchived(session) && !isSubtask(session);

export const taskNeedsAttention = (
  sessionId: string,
  pendingRequestSessionIds: ReadonlySet<string>,
  unseenBySession: Readonly<Record<string, number>>,
): boolean => pendingRequestSessionIds.has(sessionId) || (unseenBySession[sessionId] ?? 0) > 0;

const byActivityDesc = (a: Session, b: Session): number => getSessionActivityUpdatedAt(b) - getSessionActivityUpdatedAt(a);

/**
 * Task-view partition. Precedence: archived/subtask/pinned rows stay out; a live
 * running session or one with a pending request is never settled; otherwise the
 * Host settled projection decides. Running sessions stay in the active list
 * (live state is the only source of "running"), so there is no separate shelf.
 */
export const deriveTaskBuckets = ({
  sessions,
  pinnedSessionIds,
  settledSessionIds,
  runningSessionIds,
  pendingRequestSessionIds,
  unseenBySession,
}: TaskBucketInput): TaskBuckets => {
  const active: Session[] = [];
  const settled: Session[] = [];

  for (const session of sessions) {
    if (!isTaskViewSession(session) || pinnedSessionIds.has(session.id)) continue;
    if (
      !runningSessionIds.has(session.id)
      && !pendingRequestSessionIds.has(session.id)
      && settledSessionIds.has(session.id)
    ) {
      settled.push(session);
    } else {
      active.push(session);
    }
  }

  const attentionRank = (session: Session): number => (
    taskNeedsAttention(session.id, pendingRequestSessionIds, unseenBySession) ? 0 : 1
  );
  active.sort((a, b) => attentionRank(a) - attentionRank(b) || byActivityDesc(a, b));
  settled.sort(byActivityDesc);

  return { active, settled };
};

/**
 * Rows the task view logically shows, top to bottom; a collapsed Settled shelf
 * contributes nothing and an open one stops at its current page limit.
 */
export const listVisibleTaskSessions = (
  buckets: TaskBuckets,
  shelf: { settledOpen: boolean; settledLimit: number },
): Session[] => [
  ...buckets.active,
  ...(shelf.settledOpen ? buckets.settled.slice(0, shelf.settledLimit) : []),
];
