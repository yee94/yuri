import React from 'react';

import { useSessionUIStore } from '@/sync/session-ui-store';
import { useActiveSessionTreeIds } from '@/sync/sync-context';

/** Running ∪ optional current viewing session. */
export function mergeAlwaysVisibleSessionIds(
  runningSessionIds: ReadonlySet<string>,
  currentSessionId: string | null | undefined,
): ReadonlySet<string> {
  if (!currentSessionId) return runningSessionIds;
  if (runningSessionIds.has(currentSessionId)) return runningSessionIds;
  const ids = new Set(runningSessionIds);
  ids.add(currentSessionId);
  return ids;
}

type RunningOptions = {
  enabled?: boolean;
};

type AlwaysVisibleOptions = RunningOptions & {
  /** Include the current viewing session (default true). */
  includeCurrentSession?: boolean;
};

export function useRunningSessionIds(options?: RunningOptions): ReadonlySet<string> {
  return useActiveSessionTreeIds(options?.enabled ?? true);
}

/**
 * Viewing + running sessions stay in the visible window of already-loaded
 * lists (does not fetch more sessions from the server).
 */
const hasSameMembers = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const id of left) {
    if (!right.has(id)) return false;
  }
  return true;
};

export function useAlwaysVisibleSessionIds(options?: AlwaysVisibleOptions): ReadonlySet<string> {
  const includeCurrentSession = options?.includeCurrentSession ?? true;
  const runningSessionIds = useRunningSessionIds(options);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  // The viewed session finishing its turn leaves the merged membership as-is
  // ({viewing} either way) but rebuilds the set; keep the previous reference so
  // every sidebar section consuming it does not re-render for nothing.
  const previousRef = React.useRef<ReadonlySet<string> | null>(null);

  return React.useMemo(() => {
    const next = includeCurrentSession
      ? mergeAlwaysVisibleSessionIds(runningSessionIds, currentSessionId)
      : runningSessionIds;
    const previous = previousRef.current;
    if (previous && hasSameMembers(previous, next)) return previous;
    previousRef.current = next;
    return next;
  }, [currentSessionId, includeCurrentSession, runningSessionIds]);
}
