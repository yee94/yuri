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
  /**
   * Host-index membership. When known, a session the index does not hold (older
   * rows pulled in by browsing the project view) never joins the active list
   * unless it is live. `null` means the snapshot is unavailable: do not filter.
   */
  indexedSessionIds?: ReadonlySet<string> | null;
  /** Host settle timestamps, used to order the archived shelf. */
  settledAtBySessionId?: ReadonlyMap<string, number>;
  runningSessionIds: ReadonlySet<string>;
  pendingRequestSessionIds: ReadonlySet<string>;
  unseenBySession: Readonly<Record<string, number>>;
  /**
   * Unpinned rows from remote Hosts. Each remote Host's own snapshot is the
   * membership authority, so the local index and settle projection never filter them.
   */
  remoteSessions?: readonly Session[];
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
  indexedSessionIds = null,
  settledAtBySessionId,
  runningSessionIds,
  pendingRequestSessionIds,
  unseenBySession,
  remoteSessions,
}: TaskBucketInput): TaskBuckets => {
  const active: Session[] = [];
  const settled: Session[] = [];

  for (const session of sessions) {
    if (isSubtask(session)) continue;
    // A project-view archive is an archive here too: it joins the shelf and never the active list.
    if (isArchived(session)) {
      settled.push(session);
      continue;
    }
    if (pinnedSessionIds.has(session.id)) continue;
    const live = runningSessionIds.has(session.id) || pendingRequestSessionIds.has(session.id);
    if (!live && indexedSessionIds && !indexedSessionIds.has(session.id)) continue;
    if (!live && settledSessionIds.has(session.id)) {
      settled.push(session);
    } else {
      active.push(session);
    }
  }

  if (remoteSessions) active.push(...remoteSessions);

  const attentionRank = (session: Session): number => (
    taskNeedsAttention(session.id, pendingRequestSessionIds, unseenBySession) ? 0 : 1
  );
  active.sort((a, b) => attentionRank(a) - attentionRank(b) || byActivityDesc(a, b));
  // Newest archive first: real archive time, else the Host settle time.
  const archivedAtOf = (session: Session): number => (
    isArchived(session) ? session.time?.archived ?? 0 : settledAtBySessionId?.get(session.id) ?? 0
  );
  settled.sort((a, b) => archivedAtOf(b) - archivedAtOf(a) || byActivityDesc(a, b));

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
