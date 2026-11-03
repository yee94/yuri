import type { QueryClient } from '@tanstack/react-query';
import type { Session } from '@/lib/opencode/v2-types';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { sessionIdentityQueryOptions } from '@/queries/sessionIdentityQueries';
import type { ChildStoreManager } from './child-store';
import { useGlobalSessionStatusStore } from './global-session-status';
import { stripSessionDiffSnapshots } from './sanitize';
import { getSessionShellActivity } from './session-shell-activity';

/** Recover only live sessions' missing ancestry, never their transcripts or a full catalog. */
export function mountSessionActivityIdentitySync(
  children: ChildStoreManager,
  options: {
    client?: QueryClient;
    loadSession?: (id: string, signal: AbortSignal) => Promise<Session>;
  } = {},
): () => void {
  const client = options.client ?? queryClient;
  const shells = getSessionShellActivity(children);
  const pending = new Set<string>();
  const failedUntil = new Map<string, number>();
  let disposed = false;
  let scheduled = false;
  let identitiesDirty = true;
  let statusesDirty = true;
  const known = new Map<string, Session>();
  const executing = new Set<string>();

  const schedule = () => {
    if (disposed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!disposed) drain();
    });
  };

  const drain = () => {
    if (identitiesDirty) {
      known.clear();
      for (const session of useGlobalSessionsStore.getState().activeSessions) known.set(session.id, session);
      for (const store of children.children.values()) for (const session of store.getState().session) known.set(session.id, session);
      identitiesDirty = false;
    }
    if (statusesDirty) {
      executing.clear();
      for (const id of useGlobalSessionStatusStore.getState().statusById.keys()) executing.add(id);
      for (const store of children.children.values()) for (const [id, status] of Object.entries(store.getState().session_status)) {
        if (status.type === 'busy' || status.type === 'retry') executing.add(id);
      }
      statusesDirty = false;
    }
    const active = new Set(executing);
    for (const { sessionID } of shells.read().values()) active.add(sessionID);
    const needed = new Set<string>();
    for (const id of active) {
      const visited = new Set<string>();
      let current: string | undefined = id;
      while (current && !visited.has(current)) {
        visited.add(current);
        const session = known.get(current);
        if (!session) { needed.add(current); break; }
        current = session.parentID;
      }
    }
    for (const id of failedUntil.keys()) if (!needed.has(id)) failedUntil.delete(id);
    for (const id of needed) {
      if (pending.size >= 2) break;
      if (pending.has(id) || (failedUntil.get(id) ?? 0) > Date.now()) continue;
      pending.add(id);
      const transport = getRuntimeTransportIdentity();
      const generation = getRuntimeGeneration();
      const current = () => !disposed && transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration();
      void client.fetchQuery(sessionIdentityQueryOptions(id, options.loadSession)).then((session) => {
        const directory = session.directory;
        if (!current() || !directory) return;
        // A live move/create in another directory supersedes this missing-identity read.
        for (const store of children.children.values()) {
          if (store.getState().session.some((item) => item.id === id)) return;
        }
        const store = children.ensureChild(directory, { bootstrap: false });
        store.setState((state) => {
          // A newer live identity may have arrived while GET was pending.
          if (state.session.some((item) => item.id === id)) return state;
          return { session: [...state.session, stripSessionDiffSnapshots(session)].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0) };
        });
      }).catch(() => {
        // Preserve live status on failure; a later lifecycle/catalog change can retry.
        if (current()) failedUntil.set(id, Date.now() + 30_000);
      }).finally(() => {
        pending.delete(id);
        schedule();
      });
    }
  };

  const scheduleStatus = () => { statusesDirty = true; schedule(); };
  const scheduleIdentity = () => { identitiesDirty = true; schedule(); };
  const unsubscribes = [
    children.subscribeAllSelected((state) => state.session_status, scheduleStatus),
    children.subscribeAllSelected((state) => state.session, scheduleIdentity),
    useGlobalSessionStatusStore.subscribe(scheduleStatus),
    shells.subscribe(schedule),
    useGlobalSessionsStore.subscribe((state, previous) => {
      if (state.activeSessions !== previous.activeSessions) scheduleIdentity();
    }),
  ];
  schedule();
  return () => {
    disposed = true;
    unsubscribes.forEach((unsubscribe) => unsubscribe());
  };
}
