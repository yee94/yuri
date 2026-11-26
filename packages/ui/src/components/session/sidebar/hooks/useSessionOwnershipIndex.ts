import React from 'react';
import type { Session } from '@/lib/opencode/v2-types';
import { useOpenCodeProjectRootsQuery } from '@/queries/openCodeProjectQueries';
import { createSessionOwnershipIndex, type SessionOwnershipIndex } from '../sessionOwnership';

type OwnershipArgs = Parameters<typeof createSessionOwnershipIndex>;

/**
 * Session ownership plus the OpenCode project fallback for sessions no
 * metadata or known directory claims. The project catalog is read only while
 * such sessions exist, and the index is rebuilt only when it resolves one.
 */
export const useSessionOwnershipIndex = (
  sessions: Session[],
  projects: OwnershipArgs[1],
  availableWorktreesByProject: OwnershipArgs[2],
  isVSCode: boolean,
  archivedSessions?: Session[],
): SessionOwnershipIndex => {
  const base = React.useMemo(
    () => createSessionOwnershipIndex(sessions, projects, availableWorktreesByProject, isVSCode, archivedSessions),
    [archivedSessions, availableWorktreesByProject, isVSCode, projects, sessions],
  );
  const projectRoots = useOpenCodeProjectRootsQuery(base.unresolvedOpenCodeProjectIds, !isVSCode);
  const hasKnownRoot = base.unresolvedOpenCodeProjectIds.some((projectId) => projectRoots.has(projectId));
  return React.useMemo(
    () => hasKnownRoot
      ? createSessionOwnershipIndex(sessions, projects, availableWorktreesByProject, isVSCode, archivedSessions, projectRoots)
      : base,
    [archivedSessions, availableWorktreesByProject, base, hasKnownRoot, isVSCode, projectRoots, projects, sessions],
  );
};
