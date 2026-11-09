import type { Session } from '@/lib/opencode/v2-types';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionNode } from './types';
import { compareSessionsByPinnedAndTime, dedupeSessionsById } from './utils';
import { buildSessionForest } from './session-tree-core';
export { buildSessionForest } from './session-tree-core';

const isArchivedSession = (session: Session): boolean => Boolean(session.time?.archived);

export type BuildSessionTreeOptions = {
  pinnedSessionIds?: ReadonlySet<string>;
  /**
   * When true, omit pinned sessions from the returned forest (project area).
   * Tree structure is still built with pinned parents present so children attach.
   */
  omitPinnedSessions?: boolean;
  getWorktree?: (session: Session) => WorktreeMetadata | null;
};

/**
 * Build a parent/child session forest.
 *
 * Pinned filtering happens after attachment. Project callers omit pinned roots
 * from the visible forest; children of those roots stay hidden only while the
 * parent is pinned (flat pin rows). Unpinning rebuilds the normal parent/child tree.
 *
 * Sessions with a parentID are never promoted to roots. If the parent is missing
 * from this list, archived differently, or pinned-and-omitted, the child stays
 * out of the forest entirely (subagents load only on expand).
 */
export const buildSessionTree = (
  sessions: Session[],
  options: BuildSessionTreeOptions = {},
): SessionNode[] => {
  const pinnedSessionIds = options.pinnedSessionIds ?? new Set<string>();
  const omitPinnedSessions = options.omitPinnedSessions === true;
  const getWorktree = options.getWorktree ?? (() => null);

  const sortedSessions = dedupeSessionsById(sessions)
    .sort((a, b) => compareSessionsByPinnedAndTime(a, b, pinnedSessionIds));

  return buildSessionForest(sortedSessions, { archived: isArchivedSession, pinnedSessionIds, omitPinnedSessions, getWorktree });
};
