import React from 'react';
import { useRunningSessionShells } from '@/sync/sync-context';
import { useBlockingShellIds } from './useBlockingShellIds';
import { useSettledKeys } from './useSettledKeys';
import type { WorkStatusShell } from './workStatusShells';

const NO_SHELLS: WorkStatusShell[] = [];

/** Shells already detached into the background for a session; blocking foreground shells are excluded. */
export const useWorkStatusShells = (sessionId: string | null, directory: string | null): WorkStatusShell[] => {
  const runningShells = useRunningSessionShells();
  const blockingShellIds = useBlockingShellIds(sessionId, directory);
  const candidates = React.useMemo<WorkStatusShell[]>(() => {
    if (!sessionId) return NO_SHELLS;
    return [...runningShells]
      .filter(([id, owner]) => owner.sessionID === sessionId && !blockingShellIds.includes(id))
      .map(([id, owner]) => ({ id, directory: owner.directory, startedAt: owner.startedAt }))
      .sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }, [blockingShellIds, runningShells, sessionId]);
  const candidateIds = React.useMemo(() => candidates.map((shell) => shell.id), [candidates]);
  // A foreground shell can briefly look detached between its call settling and its exit event.
  const settledIds = useSettledKeys(candidateIds);
  return React.useMemo(
    () => candidates.length === 0 ? NO_SHELLS : candidates.filter((shell) => settledIds.has(shell.id)),
    [candidates, settledIds],
  );
};
