/** Import-free navigation contracts/rules shared by Web and native sidebars.
 * Keep stores, React, SDK transport and global publishers outside this boundary. */
export type SessionFocusScope = 'pinned' | 'project';
export type SessionFocusIdentity = Readonly<{
  scope: SessionFocusScope;
  sessionId: string;
  projectId: string | null;
}>;
export type SessionNavigationTarget = Readonly<{
  scope: SessionFocusScope;
  sessionId: string;
  projectId: string | null;
  directory: string | null;
  groupKey?: string | null;
  folderAncestorIds?: readonly string[];
  visibleIndex?: number;
}>;

export const findCurrentNavigationTargetIndex = (
  targets: readonly SessionNavigationTarget[],
  rootSessionId: string | null,
  focus: SessionFocusIdentity | null,
): number => {
  if (!rootSessionId) return -1;
  // Duplicate session IDs can exist across pinned and project rows in the
  // published snapshot. Prefer the exact focus surface, then the owning
  // project, so wrap/cross-section jumps land on the row the user came from.
  if (focus?.scope) {
    const scopedMatch = targets.findIndex((target) => (
      target.scope === focus.scope
      && target.sessionId === rootSessionId
      && (focus.projectId ? target.projectId === focus.projectId : true)
    ));
    if (scopedMatch >= 0) return scopedMatch;
  }
  if (focus?.projectId) {
    const projectMatch = targets.findIndex((target) => (
      target.sessionId === rootSessionId && target.projectId === focus.projectId
    ));
    if (projectMatch >= 0) return projectMatch;
  }
  return targets.findIndex((target) => target.sessionId === rootSessionId);
};

/** Callers with a richer visual identity may resolve its exact index without
 * dropping other visible rows; Web retains its existing scope/project lookup. */
export const cycleNavigationTargets = <T extends SessionNavigationTarget>(
  targets: readonly T[],
  direction: -1 | 1,
  rootSessionId: string | null,
  focus: SessionFocusIdentity | null,
  currentIndex = findCurrentNavigationTargetIndex(targets, rootSessionId, focus),
): T | null => {
  if (targets.length === 0) return null;
  if (currentIndex < 0) return direction > 0 ? targets[0] ?? null : targets[targets.length - 1] ?? null;
  const nextIndex = (currentIndex + direction + targets.length) % targets.length;
  return targets[nextIndex] ?? null;
};
