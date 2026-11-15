import React from 'react';

/** Compact run time: 45s, 3m, 1h5m. */
export const formatRunElapsed = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h${rest}m` : `${hours}h`;
};

/** Refresh period for a running label: per second for the first minute, then coarse. */
export const runElapsedRefreshMs = (elapsedMs: number): number => (elapsedMs < 60_000 ? 1_000 : 15_000);

/**
 * When this client first saw each session running. The session status carries
 * no start time, so a session already running at app start counts from the
 * moment it was first observed. Membership changes only create a new Map;
 * unchanged membership returns the previous reference. While the sidebar is
 * hidden the live set is empty, so the previous map is kept instead of reset.
 */
export const useRunStartTimes = (
  runningSessionIds: ReadonlySet<string>,
  enabled: boolean,
): ReadonlyMap<string, number> => {
  const ref = React.useRef<ReadonlyMap<string, number>>(new Map());
  return React.useMemo(() => {
    if (!enabled) return ref.current;
    const previous = ref.current;
    const now = Date.now();
    const next = new Map<string, number>();
    let changed = previous.size !== runningSessionIds.size;
    for (const id of runningSessionIds) {
      const known = previous.get(id);
      if (known === undefined) changed = true;
      next.set(id, known ?? now);
    }
    if (!changed) return previous;
    ref.current = next;
    return next;
  }, [enabled, runningSessionIds]);
};
