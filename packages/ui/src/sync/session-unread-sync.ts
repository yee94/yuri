import { QueryObserver } from '@tanstack/react-query';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { subscribeYuriEvents } from '@/lib/yuriEvents';
import { sessionUnreadQueryOptions, saveSessionUnread, type SessionUnreadSnapshot } from '@/queries/sessionUnreadQueries';
import { applySessionUnreadSnapshot, installSessionReadSync, resetSessionUnreadProjection } from './notification-store';

export function mountSessionUnreadSync(isViewed: (directory: string, sessionId: string) => boolean): () => void {
  // Standalone extension connects directly to OpenCode, without a Yuri Host.
  if (getRegisteredRuntimeAPIs()?.runtime.isVSCode) return () => {};
  let stopObserver: (() => void) | undefined;
  let observer: { destroy: () => void } | undefined;
  let snapshot: SessionUnreadSnapshot | undefined;
  let transport = getRuntimeTransportIdentity();
  let generation = getRuntimeGeneration();
  let disposed = false;
  let refresh = () => {};
  const reads = new Map<string, Promise<void>>();
  const pendingOpens = new Set<string>();
  const alive = (scope: string, epoch: number) => !disposed && scope === getRuntimeTransportIdentity() && epoch === getRuntimeGeneration();
  const read = (id: string) => {
    if (!snapshot) { pendingOpens.add(id); return; }
    const row = snapshot?.sessions[id];
    if (!row?.unreadCount) return;
    const scope = transport;
    const epoch = generation;
    const key = `${scope}:${epoch}:${id}:${row.revision}`;
    if (reads.has(key)) return;
    const flight = saveSessionUnread(id, false, row.revision).then(() => {}).catch(() => {
      // Keep the authoritative dot on failure; focus/reconnect can retry.
      if (alive(scope, epoch)) console.warn('[session-unread] mark read failed');
    }).finally(() => { reads.delete(key); });
    reads.set(key, flight);
  };
  const start = () => {
    stopObserver?.();
    observer?.destroy();
    snapshot = undefined;
    pendingOpens.clear();
    transport = getRuntimeTransportIdentity();
    generation = getRuntimeGeneration();
    resetSessionUnreadProjection();
    const scope = transport;
    const epoch = generation;
    const nextObserver = new QueryObserver(queryClient, sessionUnreadQueryOptions(scope));
    observer = nextObserver;
    let refreshAgain = false;
    refresh = () => {
      if (!alive(scope, epoch)) return;
      const current = nextObserver.getCurrentResult();
      if (current.isFetching && !current.data) { refreshAgain = true; return; }
      void nextObserver.refetch();
    };
    stopObserver = nextObserver.subscribe(result => {
      if (!alive(scope, epoch)) return;
      if (!result.isFetching && refreshAgain) {
        refreshAgain = false;
        queueMicrotask(() => { if (alive(scope, epoch)) refresh(); });
      }
      if (!result.data) return;
      snapshot = result.data;
      applySessionUnreadSnapshot(snapshot.sessions);
      for (const id of pendingOpens) {
        const row = snapshot.sessions[id];
        if (row && isViewed(row.directory, id)) read(id);
      }
      pendingOpens.clear();
      for (const [id, row] of Object.entries(snapshot.sessions)) {
        // An explicit reminder stays unread until the user opens/refocuses it.
        if (row.unreadCount > 0 && !row.manual && isViewed(row.directory, id)) read(id);
      }
    });
  };
  const uninstall = installSessionReadSync({
    read,
    unread: async id => { pendingOpens.delete(id); await saveSessionUnread(id, true); },
  });
  const unsubscribeEvents = subscribeYuriEvents(event => {
    if (event.type === 'session-unread-changed' || event.type === 'event-stream-ready') {
      refresh();
    }
  });
  const unsubscribeRuntime = subscribeRuntimeEndpointChanged(start);
  start();
  return () => {
    disposed = true;
    stopObserver?.(); observer?.destroy();
    unsubscribeEvents(); unsubscribeRuntime(); uninstall();
    resetSessionUnreadProjection();
  };
}
