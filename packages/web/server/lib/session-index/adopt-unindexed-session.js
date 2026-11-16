/**
 * Brings a session back into the index when the user writes to it while the
 * index does not hold it (an old session outside the newest-20 window, or one
 * resumed from history). `touchActivity` only updates existing rows, so without
 * this the session never regains task-view membership or recency ordering.
 *
 * @param {object} deps
 * @param {object} deps.service session-index service
 * @param {(input: { sessionID: string, directory: string | null }) => Promise<object | null>} deps.fetchSession
 * @param {(session: object) => object | null | undefined} deps.projectSession
 *   Host authority projection; `null` means Host metadata is unavailable.
 * @param {() => void} deps.onChanged
 * @param {(message: string, error?: unknown) => void} [deps.warn]
 */
export const createUnindexedSessionAdopter = ({
  service,
  fetchSession,
  projectSession,
  onChanged,
  warn = console.warn,
}) => {
  const inFlight = new Set();

  return (sessionID, directory, activityAt) => {
    if (inFlight.has(sessionID)) return;
    inFlight.add(sessionID);
    void (async () => {
      try {
        const upstream = await fetchSession({ sessionID, directory: directory || null });
        if (!upstream || service.findBySessionId(sessionID)) return;
        const projected = projectSession(upstream);
        if (projected == null) return;
        // The user message is newer than a possibly stale upstream clock; without
        // this the newest-20 retention bound would refuse the row.
        const time = { ...projected.time, updated: Math.max(Number(projected.time?.updated) || 0, activityAt) };
        const upserted = service.upsertAndReportChange({ ...projected, time }, Date.now());
        const touched = service.touchActivity(sessionID, activityAt);
        if (upserted || touched) onChanged();
      } catch (error) {
        warn('[session-index] adopting an unindexed session failed:', error?.message ?? error);
      } finally {
        inFlight.delete(sessionID);
      }
    })();
  };
};
