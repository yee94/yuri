import type { Session } from '@/lib/opencode/v2-types';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import type { ChildStoreManager } from './child-store';
import { useGlobalSessionStatusStore } from './global-session-status';
import { aggregateLiveSessionStatuses } from './live-aggregate';
import { getSessionShellActivity } from './session-shell-activity';

export function collectRunningSessionIds(
  liveStatuses: Record<string, { type: string }>,
  fallbackStatusById: ReadonlyMap<string, unknown>,
): Set<string> {
  const ids = new Set<string>();
  for (const [id, status] of Object.entries(liveStatuses)) {
    if (status.type === 'busy' || status.type === 'retry') ids.add(id);
  }
  for (const id of fallbackStatusById.keys()) {
    if (liveStatuses[id] === undefined) ids.add(id);
  }
  return ids;
}

// Presentation only: never write descendant activity into execution/send/queue status.
function createSessionActivityReader(children: ChildStoreManager) {
  let snapshot: ReadonlySet<string> = new Set();
  let backgroundCounts = new Map<string, number>();
  let dirty = true;
  let structureDirty = true;
  let statusDirty = true;
  const sessions = new Map<string, Session>();
  let active = new Set<string>();
  const shells = getSessionShellActivity(children);
  let cleanup: (() => void) | undefined;
  const listeners = new Set<() => void>();

  const read = (): ReadonlySet<string> => {
    if (!dirty && cleanup) return snapshot;
    dirty = false;
    if (structureDirty || statusDirty || !cleanup) {
      const states = Array.from(children.children.values(), (store) => store.getState());
      if (structureDirty || !cleanup) {
        sessions.clear();
        for (const session of useGlobalSessionsStore.getState().activeSessions) sessions.set(session.id, session);
        for (const state of states) for (const session of state.session) {
          const current = sessions.get(session.id);
          if (!current || (session.time?.updated ?? 0) >= (current.time?.updated ?? 0)) sessions.set(session.id, session);
        }
        structureDirty = false;
      }
      if (statusDirty || !cleanup) {
        active = collectRunningSessionIds(aggregateLiveSessionStatuses(states), useGlobalSessionStatusStore.getState().statusById);
        statusDirty = false;
      }
    }
    const next = new Set<string>();
    const nextCounts = new Map<string, number>();
    for (const id of active) {
      const visited = new Set<string>();
      let ancestor: string | undefined = id;
      while (ancestor && !visited.has(ancestor)) {
        visited.add(ancestor);
        next.add(ancestor);
        if (ancestor !== id) nextCounts.set(ancestor, (nextCounts.get(ancestor) ?? 0) + 1);
        ancestor = sessions.get(ancestor)?.parentID;
      }
    }
    for (const { sessionID } of shells.read().values()) {
      const visited = new Set<string>();
      let ancestor: string | undefined = sessionID;
      while (ancestor && !visited.has(ancestor)) {
        visited.add(ancestor);
        next.add(ancestor);
        nextCounts.set(ancestor, (nextCounts.get(ancestor) ?? 0) + 1);
        ancestor = sessions.get(ancestor)?.parentID;
      }
    }
    if (nextCounts.size !== backgroundCounts.size
      || [...nextCounts].some(([id, count]) => backgroundCounts.get(id) !== count)) backgroundCounts = nextCounts;
    if (next.size !== snapshot.size || [...next].some((id) => !snapshot.has(id))) snapshot = next;
    return snapshot;
  };

  const invalidate = () => {
    dirty = true;
    const before = snapshot;
    const countsBefore = backgroundCounts;
    if (read() !== before || backgroundCounts !== countsBefore) for (const listener of listeners) listener();
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    if (!cleanup) {
      const invalidateStatus = () => { statusDirty = true; invalidate(); };
      const invalidateStructure = () => { structureDirty = true; invalidate(); };
      const unsubscribeStatus = children.subscribeAllSelected((state) => state.session_status, invalidateStatus);
      const unsubscribeSessions = children.subscribeAllSelected((state) => state.session, invalidateStructure);
      const unsubscribeFallback = useGlobalSessionStatusStore.subscribe(invalidateStatus);
      const unsubscribeShells = shells.subscribe(invalidate);
      const unsubscribeCatalog = useGlobalSessionsStore.subscribe((state, previous) => {
        if (state.activeSessions !== previous.activeSessions) invalidateStructure();
      });
      cleanup = () => {
        unsubscribeStatus();
        unsubscribeSessions();
        unsubscribeFallback();
        unsubscribeShells();
        unsubscribeCatalog();
      };
      structureDirty = statusDirty = true;
      invalidate();
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        cleanup?.();
        cleanup = undefined;
        dirty = true;
      }
    };
  };
  const readBackgroundCount = (sessionID: string) => {
    read();
    return backgroundCounts.get(sessionID) ?? 0;
  };
  return { read, readBackgroundCount, subscribe };
}

// One projection per runtime's child-store manager, not one tree scan per row.
const readers = new WeakMap<ChildStoreManager, ReturnType<typeof createSessionActivityReader>>();
export function getSessionActivityReader(children: ChildStoreManager) {
  let reader = readers.get(children);
  if (!reader) {
    reader = createSessionActivityReader(children);
    readers.set(children, reader);
  }
  return reader;
}
