import { eventSessionID, type RuntimeEvent, type Session } from './model';
import { createProjectsBlocking, isProjectsBlockingEvent, isProjectsBlockingRefreshEvent, projectsBlockingSessionID, type ProjectsAttentionRequest, type ProjectsBlockingSnapshot } from './projects-attention-blocking';

export type ProjectsAttentionSnapshot = { unseenBySession: Readonly<Record<string, number>>; currentSessionID: string | null; blockingByDirectory: ProjectsBlockingSnapshot };
const emptySnapshot: ProjectsAttentionSnapshot = { unseenBySession: {}, currentSessionID: null, blockingByDirectory: {} };
const attentionEventTypes = new Set(['session.execution.started', 'session.status', 'session.execution.succeeded', 'session.idle', 'session.execution.failed', 'session.error']);
export function isProjectsAttentionEvent(event: RuntimeEvent) {
  return event.key === 'global' && (attentionEventTypes.has(event.type) || isProjectsBlockingEvent(event) || isProjectsBlockingRefreshEvent(event));
}
/** Root owner must set the actually viewed Chat, including cover/background/back. */
export function createProjectsAttention() {
  let activeKey: string | null = null;
  type Scope = { snapshot: ProjectsAttentionSnapshot; settled: Set<string>; events: Set<string>; listeners: Set<() => void>; retired: boolean; blocking: ReturnType<typeof createProjectsBlocking> };
  const scopes = new Map<string, Scope>();
  function scope(key: string) {
    let value = scopes.get(key);
    if (!value) {
      const blocking = createProjectsBlocking(blockingByDirectory => {
        const live = scopes.get(key); if (!live || live.retired) return;
        live.snapshot = { ...live.snapshot, blockingByDirectory }; live.listeners.forEach(listener => listener());
      });
      value = { snapshot: emptySnapshot, settled: new Set(), events: new Set(), listeners: new Set(), retired: false, blocking }; scopes.set(key, value);
    }
    return value;
  }
  function retire(key: string) {
    if (activeKey === key) activeKey = null;
    const value = scopes.get(key); if (!value || value.retired) return;
    value.retired = true; value.blocking.dispose(); value.snapshot = emptySnapshot; value.settled.clear(); value.events.clear();
    value.listeners.forEach(listener => listener());
    if (!value.listeners.size) scopes.delete(key);
  }
  function activate(key: string) {
    if (activeKey === key) return;
    if (activeKey) retire(activeKey);
    activeKey = key;
    const value = scope(key); value.retired = false;
  }
  function markSessionViewed(key: string, id: string) {
    if (activeKey !== key) return;
    const value = scope(key);
    if (!value.snapshot.unseenBySession[id]) return;
    const unseenBySession = { ...value.snapshot.unseenBySession }; delete unseenBySession[id];
    value.snapshot = { ...value.snapshot, unseenBySession }; value.listeners.forEach(listener => listener());
  }
  function setViewedSession(key: string, id: string | null) {
    if (activeKey !== key) return;
    const value = scope(key);
    if (value.snapshot.currentSessionID !== id) { value.snapshot = { ...value.snapshot, currentSessionID: id }; value.listeners.forEach(listener => listener()); }
    if (id) markSessionViewed(key, id);
  }
  function ingest(key: string, event: RuntimeEvent, session: Pick<Session, 'id' | 'parentID'> | undefined) {
    if (activeKey !== key || !isProjectsAttentionEvent(event) || !session || session.parentID || eventSessionID(event) !== session.id) return;
    const value = scope(key), id = session.id;
    if (event.id) {
      if (value.events.has(event.id)) return;
      value.events.add(event.id); if (value.events.size > 1000) value.events.delete(value.events.values().next().value!);
    }
    const status = event.body.status && typeof event.body.status === 'object' ? (event.body.status as { type?: string }).type : undefined;
    if (event.type === 'session.execution.started' || event.type === 'session.status' && (status === 'busy' || status === 'running' || status === 'retry')) { value.settled.delete(id); return; }
    if (!['session.execution.succeeded', 'session.idle', 'session.execution.failed', 'session.error'].includes(event.type)) return;
    // Native failed + legacy error/idle (including events without IDs) are one terminal turn.
    if (value.settled.has(id)) return;
    value.settled.add(id);
    if (value.snapshot.currentSessionID === id) return;
    value.snapshot = { ...value.snapshot, unseenBySession: { ...value.snapshot.unseenBySession, [id]: (value.snapshot.unseenBySession[id] ?? 0) + 1 } };
    value.listeners.forEach(listener => listener());
  }
  return {
    snapshot: (key: string) => scopes.get(key)?.snapshot ?? emptySnapshot,
    observe(key: string, listener: () => void) {
      const value = scope(key); value.listeners.add(listener);
      return () => { value.listeners.delete(listener); if (!value.listeners.size && (value.retired || activeKey !== key) && scopes.get(key) === value) scopes.delete(key); };
    },
    activate, retire, markSessionViewed, setViewedSession, ingest,
    ingestBlocking(key: string, event: RuntimeEvent, directory?: string) { if (activeKey === key) scopes.get(key)?.blocking.accept(event, directory); },
    refreshBlocking(key: string, send: ProjectsAttentionRequest, current: () => boolean) {
      if (activeKey !== key) return Promise.resolve();
      const value = scopes.get(key);
      return value?.blocking.refresh(send, () => activeKey === key && scopes.get(key) === value && !value.retired && current()) ?? Promise.resolve();
    },
    pauseBlocking(key: string) { scopes.get(key)?.blocking.pause(); },
    retainedScopeCount: () => scopes.size,
  };
}
export const projectsAttention = createProjectsAttention();

/** One root event consumer; token/draft paths cannot read or rebuild this identity index. */
export function createProjectsAttentionSource(input: { attention: ReturnType<typeof createProjectsAttention>; sessions: () => readonly Session[]; request?: ProjectsAttentionRequest; current?: (key: string) => boolean }) {
  let indexedScope: string | undefined, rows: readonly Session[] | undefined;
  let activeScope: string | undefined;
  const identities = new Map<string, Session>();
  function dispose() { if (activeScope) input.attention.pauseBlocking(activeScope); activeScope = undefined; indexedScope = undefined; rows = undefined; identities.clear(); }
  function refresh(key: string) { if (input.request && activeScope === key) void input.attention.refreshBlocking(key, input.request, () => activeScope === key && (input.current?.(key) ?? true)); }
  return {
    setActive(key: string | undefined, active: boolean) {
      const next = active ? key : undefined;
      if (activeScope === next) return;
      if (activeScope) input.attention.pauseBlocking(activeScope);
      activeScope = next;
      if (next) refresh(next);
    },
    accept(key: string, event: RuntimeEvent) {
      if (!isProjectsAttentionEvent(event)) return;
      if (input.request && activeScope !== key) return;
      if (isProjectsBlockingRefreshEvent(event)) { refresh(key); return; }
      const blocking = isProjectsBlockingEvent(event);
      const id = blocking ? projectsBlockingSessionID(event) : eventSessionID(event);
      if (!id) { if (blocking) input.attention.ingestBlocking(key, event); return; }
      const next = input.sessions();
      if (indexedScope !== key || rows !== next) {
        identities.clear(); for (const row of next) identities.set(row.id, row);
        indexedScope = key; rows = next;
      }
      const session = identities.get(id);
      if (isProjectsBlockingEvent(event)) { input.attention.ingestBlocking(key, event, session?.directory); return; }
      if (session) input.attention.ingest(key, event, session);
    },
    dispose,
  };
}

export function projectsInProgress<T extends { id: string; parentID?: string; archived?: boolean; updated: number; activity?: number }>(rows: T[], pins: string[], running: string[], unseen: Readonly<Record<string, number>>) {
  const pinned = new Set(pins), live = new Set(running);
  return rows.filter(row => !row.parentID && !row.archived && !pinned.has(row.id) && (live.has(row.id) || (unseen[row.id] ?? 0) > 0)).sort((a, b) => (b.activity ?? b.updated) - (a.activity ?? a.updated));
}
