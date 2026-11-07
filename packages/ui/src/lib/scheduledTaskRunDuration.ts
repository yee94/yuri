type RunDurationSource = { status: string; startedAt: number; finishedAt?: number | null; durationMs?: number | null };

/** Prefer wall-clock span when finished; live elapsed while running. */
export const resolveRunDurationMs = (run: RunDurationSource, nowMs: number): number | null => {
  if (run.status === 'running') {
    return Math.max(0, nowMs - run.startedAt);
  }
  if (typeof run.finishedAt === 'number' && Number.isFinite(run.finishedAt)) {
    const wallMs = Math.max(0, run.finishedAt - run.startedAt);
    if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0) {
      // Prefer the longer span so a short dispatch sample never under-reports
      // a later finishAt from state/history convergence.
      return Math.max(run.durationMs, wallMs);
    }
    return wallMs;
  }
  if (typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0) {
    return run.durationMs;
  }
  return null;
};

/**
 * Compact wall-clock duration beside status (e.g. 12s, 2m 50s, 1h 2m).
 * Units are symbols shared with goal-strip duration; no prose labels.
 */
export const formatCompactRunDuration = (durationMs: number | null): string | null => {
  if (durationMs === null || !Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 1_000) return '<1s';
  const totalSeconds = Math.floor(durationMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
};
