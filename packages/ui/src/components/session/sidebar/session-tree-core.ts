/** Runtime-free attachment over an already-ranked catalog. No orphan promotion. */
export type SessionForestNode<T, W = null> = { session: T; children: SessionForestNode<T, W>[]; worktree: W };
export function buildSessionForest<T extends { id: string; parentID?: string | null }, W = null>(sessions: readonly T[], options: {
  archived: (session: T) => boolean;
  pinnedSessionIds?: ReadonlySet<string>;
  omitPinnedSessions?: boolean;
  getWorktree?: (session: T) => W;
}): SessionForestNode<T, W>[] {
  const pinned = options.pinnedSessionIds ?? new Set<string>();
  const ranked = [...new Map(sessions.map(session => [session.id, session])).values()];
  const parentID = (session: T) => typeof session.parentID === 'string' && session.parentID.trim() ? session.parentID : null;
  const byID = new Map(ranked.map(session => [session.id, session]));
  const children = new Map<string, T[]>();
  for (const session of ranked) {
    const parentKey = parentID(session), parent = parentKey ? byID.get(parentKey) : undefined;
    if (!parent || options.archived(parent) !== options.archived(session) || options.omitPinnedSessions && pinned.has(parent.id)) continue;
    const rows = children.get(parent.id) ?? []; rows.push(session); children.set(parent.id, rows);
  }
  const build = (session: T, ancestors: ReadonlySet<string>): SessionForestNode<T, W> => {
    const next = new Set(ancestors); next.add(session.id);
    return { session, worktree: options.getWorktree ? options.getWorktree(session) : null as W,
      children: (children.get(session.id) ?? []).filter(child => !next.has(child.id) && !(options.omitPinnedSessions && pinned.has(child.id))).map(child => build(child, next)) };
  };
  return ranked.filter(session => !parentID(session) && !(options.omitPinnedSessions && pinned.has(session.id))).map(session => build(session, new Set()));
}
