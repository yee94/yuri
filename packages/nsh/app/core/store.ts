import { batch, Clipboard, Storage, signal } from 'nsh';
import { formatSessionChangeCounts, readSessionChangeSummary } from '../../../ui/src/lib/sessionChangeSummary';
import { formatRelativeShort } from '../../../ui/src/lib/time-format-core';
import { dismissToast, showToast } from './toast';
import { t } from './i18n';
import { refreshRemoteProjects } from './remote';
import {
  connect,
  currentScope,
  list,
  native,
  query,
  readConnections,
  record,
  removeConnection as removeConnectionNative,
  request,
  selectConnection,
  startStream,
  textOf,
  unwrap,
  type ConnectInput,
  type Connection,
  type ConnectionSnapshot,
  type RuntimeEvent,
  type RuntimeScope,
} from './host';

export type { Connection };
export { formatRelativeShort };

export type Project = {
  id: string;
  label: string;
  path: string;
  addedAt: number;
  /** Web project identity fields (`PROJECT_ICONS` / `PROJECT_COLORS` keys). */
  icon?: string;
  color?: string;
  iconBackground?: string;
  hostId?: string;
};
export type Worktree = { path: string; name: string; branch: string };
export type Session = {
  id: string;
  title: string;
  directory: string;
  updated: number;
  activity: number;
  created: number;
  pinned: boolean;
  archived: boolean;
  parentID?: string;
  hasChildren?: boolean;
  changes?: string;
  share?: string;
  /** A Remote Host reports status in the summary; local rows read the live event stream. */
  remoteStatus?: 'busy' | 'retry';
};
export type SessionStatus = { type: 'busy' | 'retry' | 'idle' };
export type Pagination = { cursor: string | null; hasMore: boolean; loading: boolean };
export type CatalogIssues = { failed: string[]; pending: string[] };
export type SessionOrder = {
  revision: number;
  byScope: Record<string, string[]>;
  activity: Record<string, Record<string, number>>;
};
type Pending = { permissions: number; questions: number };

export const normalizePath = (value?: string | null): string =>
  (value ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

export const projectLabel = (path: string, label?: string | null): string => {
  if (label && label.trim()) return label.trim();
  const parts = normalizePath(path).split('/').filter(Boolean);
  return parts[parts.length - 1] || normalizePath(path);
};

const state = {
  connections: signal<Connection[]>([]),
  connection: signal<Connection | null>(null),
  scope: signal<RuntimeScope | null>(null),
  online: signal(false),
  loading: signal(false),
  error: signal(''),
  connecting: signal(false),
  projects: signal<Project[]>([]),
  activeProjectId: signal<string | null>(null),
  viewingSessionId: signal<string | null>(null),
  sessions: signal<Map<string, Session[]>>(new Map()),
  pinned: signal<ReadonlySet<string>>(new Set()),
  unread: signal<Record<string, number>>({}),
  status: signal<Map<string, SessionStatus>>(new Map()),
  pending: signal<Map<string, Pending>>(new Map()),
  issues: signal<CatalogIssues | null>(null),
  order: signal<SessionOrder>({ revision: -1, byScope: {}, activity: {} }),
  worktrees: signal<Map<string, Worktree[]>>(new Map()),
  pagination: signal<Map<string, Pagination>>(new Map()),
  hidden: signal<ReadonlySet<string>>(new Set()),
  projectOrder: signal<string[]>([]),
  repos: signal<ReadonlySet<string>>(new Set()),
};

export const connection = () => state.connection();
export const connections = () => state.connections();
export const online = () => state.online();
export const loading = () => state.loading();
export const appError = () => state.error();
export const connecting = () => state.connecting();
export const projects = () => state.projects();
export const activeProjectId = () => state.activeProjectId();
export const viewingSessionId = () => state.viewingSessionId();
export const setActiveProject = (id: string | null) => state.activeProjectId.set(id);
export const setViewingSession = (id: string | null) => state.viewingSessionId.set(id);
export const sessionsByDirectory = () => state.sessions();
export const pinnedSessionIds = () => state.pinned();
export const unreadCount = (id: string) => state.unread()[id] ?? 0;
export const liveStatus = (id: string): SessionStatus | null => state.status().get(id) ?? null;
export const pendingFor = (id: string): Pending => state.pending().get(id) ?? { permissions: 0, questions: 0 };
export const catalogIssues = () => state.issues();
export const sessionOrder = () => state.order();
export const worktreesFor = (path: string) => state.worktrees().get(normalizePath(path)) ?? [];
export const paginationFor = (path: string) =>
  state.pagination().get(normalizePath(path)) ?? { cursor: null, hasMore: false, loading: false };
/** A row hidden by an undo window (`deleteSessionWithUndo`) stays where Undo can bring it back. */
export const isSessionHidden = (id: string) => state.hidden().has(id);
export const projectOrderIds = () => state.projectOrder();
/** Web `useGitStore` repository check: only a git project offers worktree actions. */
export const isRepository = (path: string) => state.repos().has(normalizePath(path));

export const sessionsFor = (directory: string): Session[] =>
  state.sessions().get(normalizePath(directory)) ?? [];

export const sessionById = (id: string): Session | undefined => {
  for (const rows of state.sessions().values()) {
    const row = rows.find((session) => session.id === id);
    if (row) return row;
  }
  return undefined;
};

export const run = (error: unknown) => {
  state.error.set(error instanceof Error ? error.message : String(error));
};
export const clearError = () => state.error.set('');

function sessionFrom(row: Record<string, unknown>, directory: string): Session | null {
  const time = record(row.time);
  const id = textOf(row.id);
  if (!id) return null;
  const location = record(row.location);
  const updated = Number(time.updated) || Number(time.created) || 0;
  const activity = Number(record(record(record(row.metadata).yuri).titleRefresh).activityUpdatedAt) || updated;
  const changes = formatSessionChangeCounts(readSessionChangeSummary(row)) ?? undefined;
  return {
    id,
    title: textOf(row.title) || id,
    directory: normalizePath(textOf(row.directory) || textOf(location.directory) || directory),
    updated,
    activity,
    created: Number(time.created) || 0,
    pinned: time.pinned != null && time.pinned !== '',
    archived: Number(time.archived) > 0,
    ...(textOf(row.parentID) ? { parentID: textOf(row.parentID) } : {}),
    ...(typeof row.hasChildren === 'boolean' ? { hasChildren: row.hasChildren } : {}),
    ...(changes ? { changes } : {}),
    ...(textOf(record(row.share).url) ? { share: textOf(record(row.share).url) } : {}),
  };
}

const paths = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(textOf).map(normalizePath).filter(Boolean) : [];

/** Adopts one authoritative index snapshot; failed or pending directories keep what they showed. */
function adoptIndex(payload: unknown) {
  const value = record(payload);
  if (value.available !== true || !Array.isArray(value.directories)) throw new Error('Session index unavailable');
  const sync = record(value.sync);
  const failed = new Set(paths(sync.failedDirectories));
  const pending = new Set(paths(sync.pendingDirectories));
  const completed = new Set(paths(sync.completedDirectories));
  const incomplete =
    value.partial === true ||
    value.complete === false ||
    sync.active === true ||
    (typeof sync.completed === 'number' && typeof sync.total === 'number' && sync.completed < sync.total);
  const previous = state.sessions();
  const next = new Map(previous);
  const seen = new Set<string>();
  const pinned = new Set<string>(paths(value.pinnedSessionIds));
  for (const item of list(value.directories)) {
    const directory = normalizePath(textOf(item.directory));
    if (!directory || seen.has(directory)) continue;
    seen.add(directory);
    const raw = item.sessions;
    if (!Array.isArray(raw) || raw.some((row) => !textOf(record(row).id))) {
      failed.add(directory);
      continue;
    }
    const rows = raw
      .map((row) => sessionFrom(record(row), directory))
      .filter((row): row is Session => !!row)
      .sort((a, b) => b.activity - a.activity);
    for (const row of rows) if (row.pinned) pinned.add(row.id);
    const known = !failed.has(directory) && !pending.has(directory) && (!incomplete || completed.has(directory));
    if (!known) {
      const retained = new Map((previous.get(directory) ?? []).map((row) => [row.id, row]));
      for (const row of rows) retained.set(row.id, row);
      next.set(directory, [...retained.values()]);
      continue;
    }
    const boundary = rows.length ? Math.min(...rows.map((row) => row.updated)) : 0;
    const ids = new Set(rows.map((row) => row.id));
    const tail =
      item.hasMore === true
        ? (previous.get(directory) ?? []).filter((row) => !ids.has(row.id) && (!rows.length || row.updated < boundary))
        : [];
    next.set(directory, [...rows, ...tail].sort((a, b) => b.activity - a.activity));
  }
  const complete = !incomplete && !failed.size && !pending.size;
  if (!complete) {
    for (const [directory, rows] of previous) {
      if (!next.has(directory)) next.set(directory, rows);
    }
  }
  batch(() => {
    state.sessions.set(next);
    state.pinned.set(pinned);
    state.issues.set(complete ? null : { failed: [...failed], pending: [...pending] });
  });
}

function adoptProjects(payload: unknown) {
  const value = record(unwrap(payload));
  if (!Array.isArray(value.projects)) throw new Error('Invalid project catalog');
  const projects = list(value.projects)
    .filter((row) => !textOf(row.hostId))
    .map((row) => ({
      id: textOf(row.id),
      path: normalizePath(textOf(row.path)),
      label: projectLabel(textOf(row.path), textOf(row.label) || textOf(row.name)),
      addedAt: Number(row.addedAt) || 0,
      ...(textOf(row.icon) ? { icon: textOf(row.icon) } : {}),
      ...(textOf(row.color) ? { color: textOf(row.color) } : {}),
      ...(textOf(row.iconBackground) ? { iconBackground: textOf(row.iconBackground) } : {}),
    }))
    .filter((project) => project.id && project.path);
  state.projects.set(projects);
  const active = textOf(value.activeProjectId);
  if (active) state.activeProjectId.set(active);
}

function adoptUnread(payload: unknown) {
  const value = record(unwrap(payload));
  const sessions = record(value.sessions);
  const next: Record<string, number> = {};
  for (const [id, entry] of Object.entries(sessions)) {
    const count = Number(record(entry).unreadCount) || 0;
    if (count > 0) next[id] = count;
  }
  state.unread.set(next);
}

function adoptOrder(payload: unknown) {
  const value = record(unwrap(payload));
  if (!Number.isFinite(value.revision) || !value.sessionOrderByScope || !value.sessionOrderActivityByScope) return;
  const byScope = record(value.sessionOrderByScope);
  const activity = record(value.sessionOrderActivityByScope);
  const orders: Record<string, string[]> = {};
  for (const [scope, ids] of Object.entries(byScope)) {
    if (Array.isArray(ids)) orders[normalizePath(scope)] = ids.filter((id): id is string => typeof id === 'string');
  }
  const activities: Record<string, Record<string, number>> = {};
  for (const [scope, entries] of Object.entries(activity)) {
    const times: Record<string, number> = {};
    for (const [id, at] of Object.entries(record(entries))) if (typeof at === 'number') times[id] = at;
    activities[normalizePath(scope)] = times;
  }
  state.order.set({ revision: Number(value.revision) || 0, byScope: orders, activity: activities });
}

function adoptWorktrees(projectPath: string, payload: unknown) {
  if (!Array.isArray(payload)) return;
  const path = normalizePath(projectPath);
  const rows = list(payload)
    .map((row) => ({
      path: normalizePath(textOf(row.path)),
      name: textOf(row.name) || projectLabel(textOf(row.path)),
      branch: textOf(row.branch),
    }))
    .filter((row) => row.path && row.path !== path);
  const next = new Map(state.worktrees());
  next.set(path, rows);
  state.worktrees.set(next);
}

function adoptActive(payload: unknown) {
  const value = unwrap(payload);
  const running = new Set(Object.keys(record(value)));
  const next = new Map(state.status());
  for (const [id, status] of next) {
    if (status.type !== 'idle' && !running.has(id)) next.delete(id);
  }
  for (const id of running) if (!next.has(id)) next.set(id, { type: 'busy' });
  state.status.set(next);
}

function setStatus(id: string, type: 'busy' | 'retry' | 'idle') {
  const current = state.status().get(id);
  if (current?.type === type) return;
  const next = new Map(state.status());
  if (type === 'idle') next.delete(id);
  else next.set(id, { type });
  state.status.set(next);
}

function setPendingCount(id: string, kind: 'permissions' | 'questions', count: number) {
  const current = state.pending().get(id) ?? { permissions: 0, questions: 0 };
  if (current[kind] === count) return;
  const next = new Map(state.pending());
  const value = { ...current, [kind]: count };
  if (value.permissions === 0 && value.questions === 0) next.delete(id);
  else next.set(id, value);
  state.pending.set(next);
}

async function refreshBlocking(directories: string[]) {
  await Promise.all(
    directories.map(async (directory) => {
      const permissions = new Map<string, number>();
      const questions = new Map<string, number>();
      const read = async (path: string, target: Map<string, number>) => {
        try {
          const rows = list(unwrap(await request(path)));
          for (const row of rows) {
            const sessionID = textOf(record(row.form ?? row).sessionID) || textOf(record(row.form ?? row).sessionId);
            if (sessionID) target.set(sessionID, (target.get(sessionID) ?? 0) + 1);
          }
        } catch {
          // Blocking counts are an indicator; a failed read leaves what the events showed.
        }
      };
      const location = `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
      await Promise.all([
        read(`/api/permission/request?${location}`, permissions),
        read(`/api/form?${location}`, questions),
      ]);
      const ids = new Set([...permissions.keys(), ...questions.keys()]);
      for (const id of ids) {
        setPendingCount(id, 'permissions', permissions.get(id) ?? 0);
        setPendingCount(id, 'questions', questions.get(id) ?? 0);
      }
    }),
  );
}

let refreshFlight: Promise<void> | undefined;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;

export async function refreshCatalog(): Promise<void> {
  if (!state.connection() || !currentScope()) return;
  if (refreshFlight) return refreshFlight;
  state.loading.set(true);
  const flight = (async () => {
    const results = await Promise.allSettled([
      request('/api/config/settings').then(adoptProjects),
      request('/api/yuri/session-index').then(adoptIndex),
      request('/api/yuri/session-unread').then(adoptUnread),
      request('/api/session-folders/order').then(adoptOrder),
      request('/api/session/active').then(adoptActive),
      refreshRemoteProjects(),
    ]);
    const failed = results.find((result) => result.status === 'rejected');
    state.online.set(results.some((result) => result.status === 'fulfilled'));
    state.error.set(failed?.status === 'rejected' ? errorMessage(failed.reason) : '');
    const directories = [...state.sessions().keys()];
    const pathsOfProjects = state.projects().map((project) => project.path);
    await Promise.all(
      [...new Set([...pathsOfProjects, ...directories])].map(async (path) => {
        try {
          adoptWorktrees(path, await request(`/api/git/worktrees?${query(path)}`));
        } catch {
          // Not a git repository, or git unavailable: the project still lists its main sessions.
        }
        try {
          const check = record(await request(`/api/git/check?${query(path)}`));
          const next = new Set(state.repos());
          if (check.isGitRepository === true) next.add(normalizePath(path));
          else next.delete(normalizePath(path));
          state.repos.set(next);
        } catch {
          // A failed check leaves the previous answer.
        }
      }),
    );
    await refreshBlocking([...new Set([...directories, ...pathsOfProjects, ...state.worktrees().keys()])]);
  })();
  refreshFlight = flight;
  try {
    await flight;
  } finally {
    if (refreshFlight === flight) refreshFlight = undefined;
    state.loading.set(false);
  }
}

function scheduleRefresh(delay = 120) {
  if (refreshTimer !== undefined) return;
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined;
    void refreshCatalog();
  }, delay);
}

async function refreshUnread() {
  try {
    adoptUnread(await request('/api/yuri/session-unread'));
  } catch {
    // Keep the previous unread projection.
  }
}

const blockingEvents = new Set([
  'form.created',
  'form.replied',
  'form.cancelled',
  'question.asked',
  'question.replied',
  'question.rejected',
  'permission.asked',
  'permission.replied',
]);

function eventSessionID(event: RuntimeEvent): string {
  const body = record(event.body.form ?? event.body);
  return (
    textOf(body.sessionID) ||
    textOf(body.sessionId) ||
    textOf(record(event.body.info).sessionID) ||
    textOf(record(event.body.part).sessionID)
  );
}

function eventBusy(event: RuntimeEvent): 'busy' | 'retry' | 'idle' | undefined {
  if (event.type === 'session.execution.started' || event.type === 'session.step.started') return 'busy';
  if (event.type === 'session.retry.scheduled') return 'retry';
  if (
    event.type === 'session.execution.interrupted' ||
    event.type === 'session.execution.succeeded' ||
    event.type === 'session.execution.failed' ||
    event.type === 'session.idle' ||
    event.type === 'session.error'
  )
    return 'idle';
  if (event.type === 'session.status' || event.type === 'yuri:session-status') {
    const status =
      textOf(record(event.body.status).type) || textOf(event.body.status) || textOf(record(event.body.info).type);
    if (status === 'busy' || status === 'running') return 'busy';
    if (status === 'retry') return 'retry';
    if (status === 'idle') return 'idle';
  }
  return undefined;
}

function handleEvent(event: RuntimeEvent) {
  if (event.key !== 'global') return;
  if (event.type === 'reconnected' || event.type === 'server.connected') {
    scheduleRefresh(0);
    return;
  }
  if (event.type === 'yuri:session-index-changed') return scheduleRefresh();
  if (event.type === 'yuri:project-order-changed' || event.type === 'yuri:worktree-topology-changed')
    return scheduleRefresh();
  if (event.type === 'yuri:host-status' || event.type === 'yuri:projects-changed') return scheduleRefresh();
  if (event.type === 'yuri:session-unread-changed') {
    void refreshUnread();
    return;
  }
  const busy = eventBusy(event);
  const id = eventSessionID(event);
  if (busy !== undefined && id) setStatus(id, busy);
  if (blockingEvents.has(event.type) && id) {
    const question = event.type.startsWith('form') || event.type.startsWith('question');
    const resolved = event.type.endsWith('.replied') || event.type.endsWith('.rejected') || event.type.endsWith('.cancelled');
    const kind = question ? 'questions' : 'permissions';
    const current = pendingFor(id)[kind];
    setPendingCount(id, kind, resolved ? Math.max(0, current - 1) : current + 1);
  }
}

let stopStream: (() => void) | undefined;

function enter(snapshot: ConnectionSnapshot) {
  batch(() => {
    state.connections.set(snapshot.connections);
    state.scope.set(snapshot.runtimeScope);
    state.connection.set(snapshot.connections.find((entry) => entry.id === snapshot.selected) ?? null);
    if (!snapshot.selected) {
      state.sessions.set(new Map());
      state.projects.set([]);
      state.pinned.set(new Set());
      state.unread.set({});
      state.status.set(new Map());
      state.worktrees.set(new Map());
    }
  });
  if (!snapshot.selected) {
    stopStream?.();
    stopStream = undefined;
    return;
  }
  stopStream?.();
  stopStream = startStream({
    path: '/api/yuri/events',
    onEvent: handleEvent,
    onStatus: (status) => state.online.set(status === 'live'),
  });
  scheduleRefresh(0);
}

export async function loadConnections(): Promise<ConnectionSnapshot> {
  const snapshot = await readConnections();
  enter(snapshot);
  return snapshot;
}

export async function switchConnection(id: string) {
  if (state.connection()?.id === id) return;
  const snapshot = await selectConnection(id);
  enter(snapshot);
}

export async function removeConnection(id: string) {
  const snapshot = await removeConnectionNative(id);
  enter(snapshot);
}

export async function addConnection(input: ConnectInput) {
  state.connecting.set(true);
  try {
    const snapshot = await connect(input);
    enter(snapshot);
    return snapshot;
  } finally {
    state.connecting.set(false);
  }
}

export async function scanPairingLink(): Promise<string> {
  const value = await native<string>('camera.scan');
  return textOf(value);
}

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

function updateSessions(mutate: (rows: Map<string, Session[]>) => void) {
  const next = new Map(state.sessions());
  for (const [directory, rows] of next) next.set(directory, [...rows]);
  mutate(next);
  state.sessions.set(next);
}

export async function togglePin(id: string) {
  const pinned = state.pinned().has(id);
  try {
    await request(
      `/api/yuri/session-index/session/${encodeURIComponent(id)}/pin`,
      pinned ? 'DELETE' : 'POST',
    );
    const next = new Set(state.pinned());
    if (pinned) next.delete(id);
    else next.add(id);
    state.pinned.set(next);
    updateSessions((rows) => {
      for (const [directory, list] of rows) rows.set(directory, list.map((row) => (row.id === id ? { ...row, pinned: !pinned } : row)));
    });
  } catch (error) {
    run(error);
  }
}

export async function markRead(id: string, unread: boolean) {
  const previous = state.unread();
  const next = { ...previous };
  if (unread) next[id] = Math.max(1, next[id] ?? 0);
  else delete next[id];
  state.unread.set(next);
  try {
    await request(`/api/yuri/session-unread/${encodeURIComponent(id)}`, 'PUT', { unread });
  } catch (error) {
    state.unread.set(previous);
    run(error);
  }
}

export async function archiveSession(id: string, archived = true) {
  const session = sessionById(id);
  if (!session) return;
  try {
    await request(`/api/yuri/sessions/${encodeURIComponent(id)}/archive`, 'PUT', {
      archivedAt: archived ? Date.now() : 0,
      directory: session.directory,
    });
    updateSessions((rows) => {
      const list = rows.get(session.directory) ?? [];
      rows.set(
        session.directory,
        archived ? list.filter((row) => row.id !== id) : list.map((row) => (row.id === id ? { ...row, archived: false } : row)),
      );
    });
    if (archived) {
      const next = new Set(state.pinned());
      next.delete(id);
      state.pinned.set(next);
    }
  } catch (error) {
    run(error);
  }
}

export async function deleteSession(id: string) {
  const session = sessionById(id);
  if (!session) return;
  try {
    await request(`/api/session/${encodeURIComponent(id)}?${query(session.directory)}`, 'DELETE');
    updateSessions((rows) => {
      const list = rows.get(session.directory) ?? [];
      rows.set(session.directory, list.filter((row) => row.id !== id));
    });
  } catch (error) {
    run(error);
  }
}

export async function renameSession(id: string, title: string) {
  const session = sessionById(id);
  const value = title.trim();
  if (!session || !value) return;
  try {
    await request(`/api/yuri/sessions/${encodeURIComponent(id)}/metadata`, 'PUT', {
      directory: session.directory,
      patch: {
        yuri: {
          titleAuthority: {
            sessionID: id,
            title: value,
            revision: `nsh-title-${Date.now()}-${Math.random().toString(36).slice(2)}`,
            source: 'manual',
          },
          titleRefresh: {
            activityUpdatedAt: session.activity,
            isGenerating: null,
            requestedAt: null,
            lastError: null,
            failedAt: null,
          },
        },
      },
    });
    await request(`/api/session/${encodeURIComponent(id)}`, 'PATCH', { title: value });
    updateSessions((rows) => {
      for (const [directory, list] of rows)
        rows.set(directory, list.map((row) => (row.id === id ? { ...row, title: value } : row)));
    });
  } catch (error) {
    run(error);
  }
}

export async function requestSmartTitle(id: string) {
  const session = sessionById(id);
  if (!session) return;
  try {
    await request(`/api/yuri/sessions/${encodeURIComponent(id)}/metadata`, 'PUT', {
      directory: session.directory,
      patch: {
        yuri: {
          titleRefresh: {
            ...(session.title.trim() ? { lastAutoTitle: session.title.trim() } : {}),
            requestedAt: Date.now(),
            isGenerating: null,
            lastError: null,
            failedAt: null,
          },
        },
      },
    });
  } catch (error) {
    run(error);
  }
}

export async function loadMore(directory: string) {
  const path = normalizePath(directory);
  const pagination = state.pagination().get(path);
  if (pagination?.loading) return;
  const cursor = pagination?.cursor ?? null;
  const setPagination = (value: Pagination) => {
    const next = new Map(state.pagination());
    next.set(path, value);
    state.pagination.set(next);
  };
  setPagination({ cursor, hasMore: pagination?.hasMore ?? true, loading: true });
  try {
    const page = record(
      await request(
        `/api/session?${query(path)}&parentID=null&limit=20&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
      ),
    );
    const rows = list(Array.isArray(page.data) ? page.data : page.sessions)
      .map((row) => sessionFrom(row, path))
      .filter((row): row is Session => !!row);
    const nextCursor = textOf(record(page.cursor).next) || textOf(page.cursor) || null;
    updateSessions((all) => {
      const existing = all.get(path) ?? [];
      const byId = new Map(existing.map((row) => [row.id, row]));
      for (const row of rows) byId.set(row.id, { ...row, pinned: byId.get(row.id)?.pinned ?? row.pinned });
      all.set(path, [...byId.values()].sort((a, b) => b.activity - a.activity));
    });
    setPagination({ cursor: nextCursor, hasMore: !!nextCursor, loading: false });
  } catch (error) {
    setPagination({ cursor, hasMore: pagination?.hasMore ?? false, loading: false });
    run(error);
  }
}

export async function syncProject(project: Project) {
  try {
    const worktrees = worktreesFor(project.path);
    await request('/api/yuri/session-index/sync', 'POST', {
      directories: [...new Set([project.path, ...worktrees.map((tree) => tree.path)])],
    });
    await refreshCatalog();
  } catch (error) {
    run(error);
  }
}

export async function saveProjectOrder(order: string[]) {
  const current = state.projects();
  const byId = new Map(current.map((project) => [project.id, project]));
  const next = order.map((id) => byId.get(id)).filter((project): project is Project => !!project);
  if (next.length !== current.length) return;
  state.projects.set(next);
  try {
    const rows = await request('/api/config/settings');
    const settings = record(unwrap(rows));
    const projects = list(settings.projects);
    const reordered = next.map((project) => projects.find((row) => textOf(row.id) === project.id)).filter(Boolean);
    const activeProjectId = next[0]?.id;
    const saved = record(unwrap(await request('/api/config/settings', 'PUT', { projects: reordered, ...(activeProjectId ? { activeProjectId } : {}) })));
    if (Array.isArray(saved.projects)) adoptProjects(saved);
  } catch (error) {
    run(error);
    await refreshCatalog();
  }
}

export async function addProject(path: string): Promise<Project | null> {
  const normalized = normalizePath(path);
  if (!normalized) return null;
  try {
    const snapshot = record(unwrap(await request('/api/config/settings')));
    if (!Array.isArray(snapshot.projects)) throw new Error('Invalid project catalog');
    const existing = list(snapshot.projects).find((row) => normalizePath(textOf(row.path)) === normalized);
    if (existing) return projectFromRow(existing);
    const entry = {
      id: `nsh-${Date.now().toString(36)}`,
      path: normalized,
      label: projectLabel(normalized),
      addedAt: Date.now(),
      lastOpenedAt: Date.now(),
    };
    const saved = record(
      unwrap(await request('/api/config/settings', 'PUT', { projects: [entry, ...list(snapshot.projects)], activeProjectId: entry.id })),
    );
    if (Array.isArray(saved.projects)) adoptProjects(saved);
    else await refreshCatalog();
    return projectFromRow(entry);
  } catch (error) {
    run(error);
    return null;
  }
}

function projectFromRow(row: Record<string, unknown>): Project {
  return {
    id: textOf(row.id),
    path: normalizePath(textOf(row.path)),
    label: projectLabel(textOf(row.path), textOf(row.label) || textOf(row.name)),
    addedAt: Number(row.addedAt) || 0,
    ...(textOf(row.icon) ? { icon: textOf(row.icon) } : {}),
    ...(textOf(row.color) ? { color: textOf(row.color) } : {}),
    ...(textOf(row.iconBackground) ? { iconBackground: textOf(row.iconBackground) } : {}),
  };
}

export async function removeProject(id: string) {
  const project = state.projects().find((entry) => entry.id === id);
  if (!project) return;
  try {
    const snapshot = record(unwrap(await request('/api/config/settings')));
    const rows = list(snapshot.projects).filter((row) => textOf(row.id) !== id);
    const activeProjectId = rows.some((row) => textOf(row.id) === snapshot.activeProjectId) ? snapshot.activeProjectId : textOf(rows[0]?.id);
    const saved = record(unwrap(await request('/api/config/settings', 'PUT', { projects: rows, ...(activeProjectId ? { activeProjectId } : {}) })));
    if (Array.isArray(saved.projects)) adoptProjects(saved);
    else state.projects.set(state.projects().filter((entry) => entry.id !== id));
  } catch (error) {
    run(error);
  }
}

/** One drag on a session list; `scope` is `__pinned__` or a directory. */
export async function reorderSessions(scope: string, ids: string[], activeId: string, overId: string) {
  const from = ids.indexOf(activeId);
  const to = ids.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return;
  const order = [...ids];
  order.splice(from, 1);
  order.splice(to, 0, activeId);
  const path = scope === '__pinned__' ? scope : normalizePath(scope);
  const activity: Record<string, number> = {};
  if (path !== '__pinned__') for (const row of sessionsFor(path)) activity[row.id] = row.activity;
  const previous = state.order();
  state.order.set({
    ...previous,
    byScope: { ...previous.byScope, [path]: order },
    activity: { ...previous.activity, ...(path === '__pinned__' ? {} : { [path]: activity }) },
  });
  try {
    const snapshot = await request('/api/session-folders/order', 'POST', {
      scopeKey: path,
      order,
      activity,
      onlyIfAbsent: false,
    });
    adoptOrder(snapshot);
  } catch (error) {
    state.order.set(previous);
    run(error);
  }
}

// --- one-round session commands: undo windows, transcript refresh, identity ---

/** Web `SESSION_DELETE_UNDO_MS`; rows stay visible-in-place through the window. */
export const SESSION_UNDO_MS = 5000;

export const allSessions = (): Session[] => [...state.sessions().values()].flat();

/** A root and every descendant the buckets know (Web `collectSessionTrees`, bounded). */
export function sessionsUnder(id: string): Session[] {
  const rows = allSessions();
  if (!rows.some((row) => row.id === id)) return [];
  const found = new Map<string, Session>([[id, rows.find((row) => row.id === id)!]]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parentID && found.has(row.parentID) && !found.has(row.id)) {
        found.set(row.id, row);
        grew = true;
      }
    }
  }
  return [...found.values()];
}

export async function unarchiveSession(id: string, known?: Session) {
  const row = sessionById(id) ?? known;
  if (!row) return;
  await request(`/api/yuri/sessions/${encodeURIComponent(id)}/archive`, 'PUT', {
    archivedAt: 0,
    directory: row.directory,
  });
  updateSessions((rows) => {
    const list = rows.get(row.directory) ?? [];
    if (!list.some((entry) => entry.id === id)) rows.set(row.directory, [{ ...row, archived: false }, ...list]);
    else rows.set(row.directory, list.map((entry) => (entry.id === id ? { ...entry, archived: false } : entry)));
  });
}

/** Archives one root row and offers Web's undo toast; Undo restores it in place. */
export async function archiveSessionWithUndo(id: string) {
  const row = sessionById(id);
  if (!row) return;
  try {
    await request(`/api/yuri/sessions/${encodeURIComponent(id)}/archive`, 'PUT', {
      archivedAt: Date.now(),
      directory: row.directory,
    });
    updateSessions((rows) => {
      const list = rows.get(row.directory) ?? [];
      rows.set(row.directory, list.filter((entry) => entry.id !== id));
    });
    const pinned = new Set(state.pinned());
    pinned.delete(id);
    state.pinned.set(pinned);
    const toast = showToast({
      message: t('sessions.sidebar.session.archive.success'),
      actionLabel: t('sessions.sidebar.undo'),
      onAction: () => {
        void unarchiveSession(id, row).catch(run);
        dismissToast(toast);
      },
    });
  } catch (error) {
    run(error);
  }
}

/** Hides a session tree now and deletes it after the undo window (Web `deleteSessionsWithUndo`). */
export async function deleteSessionWithUndo(id: string) {
  const targets = sessionsUnder(id);
  if (!targets.length) return;
  const previousHidden = state.hidden();
  const hidden = new Set(previousHidden);
  for (const row of targets) hidden.add(row.id);
  state.hidden.set(hidden);
  const previousPinned = state.pinned();
  const pinned = new Set(previousPinned);
  for (const row of targets) pinned.delete(row.id);
  state.pinned.set(pinned);
  const toast = showToast({
    message: targets.length === 1 ? t('sessions.sidebar.session.delete.success') : t('sessions.sidebar.bulkActions.deletedPlural', { count: targets.length }),
    actionLabel: t('sessions.sidebar.undo'),
    onAction: () => {
      clearTimeout(timer);
      state.hidden.set(previousHidden);
      state.pinned.set(previousPinned);
      dismissToast(toast);
    },
  });
  const timer = setTimeout(() => {
    void (async () => {
      const failed: string[] = [];
      for (const row of targets) {
        try {
          await request(`/api/session/${encodeURIComponent(row.id)}?${query(row.directory)}`, 'DELETE');
        } catch {
          failed.push(row.id);
        }
      }
      updateSessions((rows) => {
        for (const row of targets) {
          if (failed.includes(row.id)) continue;
          const list = rows.get(row.directory) ?? [];
          rows.set(row.directory, list.filter((entry) => entry.id !== row.id));
        }
      });
      const next = new Set(state.hidden());
      for (const row of targets) if (!failed.includes(row.id)) next.delete(row.id);
      state.hidden.set(next);
      if (failed.length) showToast({ message: t('sessions.sidebar.session.delete.error') });
    })();
  }, SESSION_UNDO_MS);
}

/** Web `session.menu.refreshTranscript`: re-reads messages, refuses while the session runs. */
export async function refreshSessionRecord(id: string) {
  const row = sessionById(id);
  if (!row) return;
  const active = record(await request('/api/session/active'));
  if (active[row.id]) {
    showToast({ message: t('sessions.sidebar.session.status.active') });
    return;
  }
  await request(
    `/api/session/${encodeURIComponent(id)}/message?${query(row.directory)}&limit=20&order=desc`,
  );
  showToast({ message: t('sessions.sidebar.session.menu.refreshTranscriptSuccess') });
}

/** Web `session.menu.copyLink`; only a session that already has a share URL offers it. */
export async function copySessionLink(url?: string) {
  if (!url) return false;
  await Clipboard.writeText(url);
  showToast({ message: t('sessions.sidebar.session.menu.copied') });
  return true;
}

const PROJECT_ORDER_KEY = 'projects:manualOrder-v1';

export async function loadProjectOrder() {
  try {
    const raw = await Storage.getItem(PROJECT_ORDER_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string')) {
      state.projectOrder.set(parsed as string[]);
    }
  } catch {
    // A missing or unreadable order keeps the Hub's catalog order.
  }
}

/** One project drag: local order is written to the Hub too; remote ids only live on this device. */
export async function saveProjectOrderIds(ids: string[]) {
  state.projectOrder.set(ids);
  try {
    await Storage.setItem(PROJECT_ORDER_KEY, JSON.stringify(ids));
  } catch {
    // Device storage is a convenience; the server write below still applies.
  }
  const local = ids.filter((id) => state.projects().some((project) => project.id === id));
  if (local.length && local.length === state.projects().length) await saveProjectOrder(local);
}

export async function updateProjectMeta(
  id: string,
  meta: { label?: string; icon?: string | null; color?: string | null },
) {
  try {
    const snapshot = record(unwrap(await request('/api/config/settings')));
    if (!Array.isArray(snapshot.projects)) throw new Error('Invalid project catalog');
    const rows = list(snapshot.projects).map((row) => {
      if (textOf(row.id) !== id) return row;
      const next: Record<string, unknown> = { ...row };
      const label = meta.label?.trim();
      if (label) next.label = label;
      if (meta.icon !== undefined) next.icon = meta.icon;
      if (meta.color !== undefined) next.color = meta.color;
      return next;
    });
    const activeProjectId = textOf(snapshot.activeProjectId);
    const saved = record(
      unwrap(await request('/api/config/settings', 'PUT', { projects: rows, ...(activeProjectId ? { activeProjectId } : {}) })),
    );
    if (Array.isArray(saved.projects)) adoptProjects(saved);
    else await refreshCatalog();
  } catch (error) {
    run(error);
  }
}

/** Official title search (`session.list?search=`), bounded like the Web palette. */
export async function searchSessionsByTitle(query: string): Promise<Session[]> {
  const search = query.trim();
  if (!search) return [];
  const page = record(
    await request(`/api/session?search=${encodeURIComponent(search)}&parentID=null&limit=30&order=desc`),
  );
  if (!Array.isArray(page.data)) throw new Error('Session search returned no data');
  return list(page.data)
    .map((row) => sessionFrom(row, ''))
    .filter((row): row is Session => !!row);
}

export type SessionContentHit = {
  sessionID: string;
  title: string;
  directory: string;
  snippet: string;
  createdAt: number;
};

/** Host-owned global message search (`/api/yuri/content-search`). */
export async function searchSessionContent(query: string): Promise<SessionContentHit[]> {
  const search = query.trim();
  if (!search) return [];
  const payload = record(await request(`/api/yuri/content-search?q=${encodeURIComponent(search)}&limit=30`));
  if (!Array.isArray(payload.hits)) throw new Error('Session content search returned no hits');
  const hits: SessionContentHit[] = [];
  for (const row of payload.hits) {
    const value = record(row);
    if (!textOf(value.sessionID) || !textOf(value.snippet)) continue;
    hits.push({
      sessionID: textOf(value.sessionID),
      title: textOf(value.title),
      directory: textOf(value.directory),
      snippet: textOf(value.snippet),
      createdAt: Number(value.createdAt) || 0,
    });
  }
  return hits;
}
