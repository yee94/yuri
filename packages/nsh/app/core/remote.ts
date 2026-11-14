import { signal } from 'nsh';
import { list, record, request, textOf } from './host';
import type { Project, Session } from './store';

/**
 * The Hub's Remote Host catalog and per-host summaries (Web `remoteProjectQueries`
 * + `lib/remote-projects/summaries`). Only identities and session summaries cross
 * this seam: no transcripts, leases or credentials are kept on the phone.
 */

export type HostState = 'idle' | 'connecting' | 'connected' | 'degraded' | 'offline' | 'unauthorized' | 'incompatible';

export type RemoteHost = {
  id: string;
  name: string;
  state: HostState;
  source: string;
  instanceId?: string;
  lastError?: string;
  lastSyncedAt?: number;
};

export type RemoteProject = Project & {
  hostId: string;
  remoteProjectId: string;
  remoteState: 'ok' | 'remote-removed' | 'host-unavailable';
  instanceId?: string;
};

export type RemoteUnread = Record<string, { directory: string; count: number; revision: number }>;

export type RemoteDirectoryBucket = {
  path: string;
  sessions: Session[];
  hasMore: boolean;
  cursor: string | null;
};

export type RemoteHostSnapshot = {
  hostId: string;
  stale: boolean;
  revision: number;
  lastSyncedAt?: number;
  pinned: string[];
  directories: RemoteDirectoryBucket[];
  unread: RemoteUnread;
  order: Record<string, string[]>;
  orderActivity: Record<string, Record<string, number>>;
  worktrees: Record<string, string[]>;
  staleProjects: string[];
};

type Catalog = { supported: boolean; hubId: string; hosts: RemoteHost[]; projects: RemoteProject[]; reason?: string };

const catalog = signal<Catalog | null>(null);
const snapshots = signal<Record<string, RemoteHostSnapshot>>({});
const loading = signal(false);
const issue = signal('');

export const remoteCatalog = () => catalog();
export const remoteHosts = () => catalog()?.hosts ?? [];
export const remoteProjects = () => catalog()?.projects ?? [];
export const remoteSupported = () => catalog()?.supported === true;
export const remoteHubId = () => catalog()?.hubId ?? '';
export const remoteLoading = () => loading();
export const remoteIssue = () => issue();
export const remoteSnapshot = (hostId: string) => snapshots()[hostId] ?? null;

export const hostFor = (hostId: string): RemoteHost | undefined =>
  remoteHosts().find((host) => host.id === hostId);

export const hostName = (hostId: string): string => {
  const name = hostFor(hostId)?.name ?? hostId;
  // Web `RemoteHostIndicator` shortens `user@machine` when the name is compact.
  return /^[^\s@]+@[^\s@]+$/.test(name) ? name.slice(name.indexOf('@') + 1) : name;
};

export const hostAvailable = (hostId: string): boolean => hostFor(hostId)?.state === 'connected';

export const remoteProjectFor = (projectId: string): RemoteProject | undefined =>
  remoteProjects().find((project) => project.id === projectId);

/** One session identity in the phone list: host and session, never a bare remote id. */
export const remoteSessionKey = (hostId: string, sessionID: string) => `${hostId}::${sessionID}`;

export const remotePath = (hostId: string, path: string) =>
  `/api/hosts/${encodeURIComponent(hostId)}${path}`;

const remoteRequest = <T = unknown>(hostId: string, path: string, method = 'GET', body?: unknown) =>
  request<T>(remotePath(hostId, path), method, body);

const normalize = (value?: string | null) => (value ?? '').replace(/\\/g, '/').replace(/\/+$/, '');

const number = (value: unknown, fallback = 0) => (typeof value === 'number' && Number.isFinite(value) ? value : fallback);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(textOf).filter(Boolean) : [];
const entries = (value: unknown): Record<string, unknown> => record(value);

const hostState = (value: string): HostState => {
  const states: HostState[] = ['idle', 'connecting', 'connected', 'degraded', 'offline', 'unauthorized', 'incompatible'];
  return states.find((state) => state === value) ?? 'offline';
};

function parseHost(row: Record<string, unknown>): RemoteHost | null {
  const id = textOf(row.id);
  if (!id) return null;
  return {
    id,
    name: textOf(row.name) || textOf(row.label) || id,
    state: hostState(textOf(row.state)),
    source: textOf(row.source) || 'direct',
    ...(textOf(row.instanceId) ? { instanceId: textOf(row.instanceId) } : {}),
    ...(textOf(record(row.lastError).message) ? { lastError: textOf(record(row.lastError).message) } : {}),
    ...(typeof row.lastSyncedAt === 'number' ? { lastSyncedAt: number(row.lastSyncedAt) } : {}),
  };
}

function parseProject(row: Record<string, unknown>): RemoteProject | null {
  const id = textOf(row.id);
  const hostId = textOf(row.hostId);
  const path = normalize(textOf(row.path));
  if (!id || !hostId || !path) return null;
  const remoteState = textOf(row.remoteState);
  return {
    id,
    hostId,
    path,
    label: textOf(row.label) || textOf(row.name) || path.split('/').filter(Boolean).pop() || path,
    addedAt: number(row.addedAt),
    remoteProjectId: textOf(row.remoteProjectId),
    remoteState: remoteState === 'remote-removed' || remoteState === 'host-unavailable' ? remoteState : 'ok',
    ...(textOf(row.icon) ? { icon: textOf(row.icon) } : {}),
    ...(textOf(row.color) ? { color: textOf(row.color) } : {}),
    ...(textOf(row.iconBackground) ? { iconBackground: textOf(row.iconBackground) } : {}),
    ...(textOf(row.instanceId) ? { instanceId: textOf(row.instanceId) } : {}),
  };
}

function sessionFrom(row: Record<string, unknown>, directory: string): Session | null {
  const id = textOf(row.id);
  if (!id) return null;
  const time = record(row.time);
  const status = textOf(record(record(record(row.metadata).yuri).sessionStatus).type);
  return {
    id,
    title: textOf(row.title) || id,
    directory: normalize(textOf(row.directory) || directory),
    updated: number(time.updated) || number(time.created),
    activity: number(time.updated) || number(time.created),
    created: number(time.created),
    pinned: time.pinned != null && time.pinned !== '',
    archived: number(time.archived) > 0,
    ...(textOf(row.parentID) ? { parentID: textOf(row.parentID) } : {}),
    ...(typeof row.hasChildren === 'boolean' ? { hasChildren: row.hasChildren } : {}),
    ...(status === 'busy' || status === 'retry' ? { remoteStatus: status } : {}),
  } as Session;
}

function parseSnapshot(payload: unknown, hubId: string, hostId: string): RemoteHostSnapshot {
  const value = record(payload);
  if (value.hostId !== hostId || (textOf(value.hubId) && textOf(value.hubId) !== hubId) || !Array.isArray(value.directories)) {
    throw new Error('Remote summary scope mismatch');
  }
  const unread: RemoteUnread = {};
  for (const [id, entry] of Object.entries(record(record(value.unread).sessions))) {
    const row = record(entry);
    unread[id] = {
      directory: normalize(textOf(row.directory)),
      count: number(row.unreadCount),
      revision: number(row.revision),
    };
  }
  const order: Record<string, string[]> = {};
  for (const [scope, ids] of Object.entries(record(record(value.order).sessionOrderByScope))) {
    order[normalize(scope)] = strings(ids);
  }
  const orderActivity: Record<string, Record<string, number>> = {};
  for (const [scope, values] of Object.entries(record(record(value.order).sessionOrderActivityByScope))) {
    const times: Record<string, number> = {};
    for (const [id, at] of Object.entries(entries(values))) times[id] = number(at);
    orderActivity[normalize(scope)] = times;
  }
  const worktrees: Record<string, string[]> = {};
  for (const [root, paths] of Object.entries(record(record(value.worktrees).projectDirectories))) {
    worktrees[normalize(root)] = strings(paths).map(normalize);
  }
  return {
    hostId,
    stale: value.stale === true,
    revision: number(value.revision),
    ...(typeof value.lastSyncedAt === 'number' ? { lastSyncedAt: number(value.lastSyncedAt) } : {}),
    pinned: strings(value.pinnedSessionIds),
    directories: list(value.directories).map((entry) => {
      const directory = normalize(textOf(entry.directory));
      return {
        path: directory,
        hasMore: entry.hasMore === true,
        cursor: typeof entry.cursor === 'string' ? entry.cursor : null,
        sessions: list(entry.sessions)
          .map((row) => sessionFrom(row, directory))
          .filter((row): row is Session => !!row),
      };
    }),
    unread,
    order,
    orderActivity,
    worktrees,
    staleProjects: strings(record(value.worktrees).staleProjectDirectories).map(normalize),
  };
}

function setCatalog(next: Catalog | null) {
  catalog.set(next);
}

export async function refreshRemoteProjects(): Promise<void> {
  loading.set(true);
  try {
    const payload = record(await request('/api/hosts'));
    if (payload.supported !== true) {
      setCatalog(null);
      snapshots.set({});
      issue.set(
        textOf(payload.reason) === 'pc_hub_required' ? textOf(payload.reason) : '',
      );
      return;
    }
    const hosts = list(payload.hosts)
      .map(parseHost)
      .filter((host): host is RemoteHost => !!host);
    const projects = list(payload.projects)
      .map(parseProject)
      .filter((project): project is RemoteProject => !!project);
    const hubId = textOf(payload.hubId);
    setCatalog({ supported: true, hubId, hosts, projects });
    issue.set('');
    const scoped = [...new Set(projects.map((project) => project.hostId))];
    await Promise.all(
      scoped.map(async (hostId) => {
        try {
          adoptSnapshot(parseSnapshot(await request(remotePath(hostId, '/summaries')), hubId, hostId));
        } catch {
          // A host that is offline keeps its last summaries; the machine badge says why.
        }
      }),
    );
  } catch (error) {
    issue.set(error instanceof Error ? error.message : String(error));
  } finally {
    loading.set(false);
  }
}

function adoptSnapshot(snapshot: RemoteHostSnapshot) {
  snapshots.set({ ...snapshots(), [snapshot.hostId]: snapshot });
}

function patchSnapshot(hostId: string, patch: (snapshot: RemoteHostSnapshot) => RemoteHostSnapshot) {
  const current = snapshots()[hostId];
  if (!current) return;
  snapshots.set({ ...snapshots(), [hostId]: patch(current) });
}

/** The project that owns a remote directory; topology from the Host beats a common-parent guess. */
export function remoteOwner(hostId: string, directory: string): RemoteProject | undefined {
  const target = normalize(directory);
  if (!target) return undefined;
  const snapshot = snapshots()[hostId];
  const inside = (candidate: string) =>
    target === candidate || target.startsWith(candidate.endsWith('/') ? candidate : `${candidate}/`);
  const scoped = remoteProjects().filter((project) => project.hostId === hostId && project.remoteState === 'ok');
  const explicit = scoped
    .filter((project) => {
      const root = normalize(project.path);
      return root && inside(root);
    })
    .sort((a, b) => normalize(b.path).length - normalize(a.path).length)[0];
  if (explicit) return explicit;
  let best: RemoteProject | undefined;
  let score = -1;
  let ambiguous = false;
  for (const project of scoped) {
    const root = normalize(project.path);
    if (!root) continue;
    const roots = [root, ...(snapshot?.worktrees[root] ?? []).map(normalize)];
    const match = roots.filter((path) => path && inside(path)).sort((a, b) => b.length - a.length)[0];
    if (!match) continue;
    if (match.length > score) {
      best = project;
      score = match.length;
      ambiguous = false;
    } else if (match.length === score && best !== project) {
      ambiguous = true;
    }
  }
  return ambiguous ? undefined : best;
}

export type RemoteDirectoryView = {
  path: string;
  label: string;
  kind: 'main' | 'worktree';
  sessions: Session[];
  hasMore: boolean;
};

/** A remote project's main workspace and linked worktrees, as its Host reported them. */
export function remoteDirectories(project: RemoteProject, snapshot: RemoteHostSnapshot | null): RemoteDirectoryView[] {
  if (!snapshot) return [{ path: project.path, label: project.path, kind: 'main', sessions: [], hasMore: false }];
  const owned = (path: string) => remoteOwner(project.hostId, path)?.id === project.id;
  const roots = [...new Set([project.path, ...(snapshot.worktrees[project.path] ?? [])])].map(normalize).filter(Boolean);
  const extra = snapshot.directories.map((bucket) => bucket.path).filter((path) => path && owned(path));
  const all = [...new Set([...roots, ...extra])];
  return all.map((path) => {
    const bucket = snapshot.directories.find((entry) => entry.path === path);
    return {
      path,
      label: path === normalize(project.path) ? project.label : path.split('/').filter(Boolean).pop() || path,
      kind: path === normalize(project.path) ? 'main' : 'worktree',
      sessions: bucket?.sessions ?? [],
      hasMore: bucket?.hasMore === true,
    };
  });
}

// --- remote commands, all routed by the machine's coordinate -------------------

export async function remoteTogglePin(hostId: string, sessionID: string, pinned: boolean): Promise<void> {
  await remoteRequest(
    hostId,
    `/api/yuri/session-index/session/${encodeURIComponent(sessionID)}/pin`,
    pinned ? 'DELETE' : 'POST',
  );
  patchSnapshot(hostId, (snapshot) => ({
    ...snapshot,
    pinned: pinned ? snapshot.pinned.filter((id) => id !== sessionID) : [...new Set([...snapshot.pinned, sessionID])],
  }));
}

export async function remoteMarkRead(hostId: string, sessionID: string, unread: boolean): Promise<void> {
  const current = snapshots()[hostId]?.unread[sessionID];
  await remoteRequest(hostId, `/api/yuri/session-unread/${encodeURIComponent(sessionID)}`, 'PUT', {
    unread,
    expectedRevision: current?.revision ?? 0,
  });
  if (unread) {
    const entry = current ?? { directory: '', count: 0, revision: 0 };
    patchSnapshot(hostId, (snapshot) => ({
      ...snapshot,
      unread: { ...snapshot.unread, [sessionID]: { ...entry, count: Math.max(1, entry.count), revision: entry.revision + 1 } },
    }));
    return;
  }
  patchSnapshot(hostId, (snapshot) => {
    const unreadMap = { ...snapshot.unread };
    delete unreadMap[sessionID];
    return { ...snapshot, unread: unreadMap };
  });
}

/** Archive through the Host's own Yuri archive route, the same one local rows use. */
export async function remoteArchive(hostId: string, sessionID: string, directory: string, archived: boolean): Promise<void> {
  await remoteRequest(hostId, `/api/yuri/sessions/${encodeURIComponent(sessionID)}/archive`, 'PUT', {
    archivedAt: archived ? Date.now() : 0,
    directory,
  });
  patchSnapshot(hostId, (snapshot) => ({
    ...snapshot,
    pinned: archived ? snapshot.pinned.filter((id) => id !== sessionID) : snapshot.pinned,
    directories: archived
      ? snapshot.directories.map((bucket) => ({
          ...bucket,
          sessions: bucket.sessions.filter((row) => row.id !== sessionID),
        }))
      : snapshot.directories.map((bucket) =>
          bucket.path === normalize(directory)
            ? { ...bucket, sessions: bucket.sessions.map((row) => (row.id === sessionID ? { ...row, archived: false } : row)) }
            : bucket,
        ),
  }));
}

export async function remoteRename(hostId: string, sessionID: string, directory: string, title: string): Promise<void> {
  const row = remoteSessionRow(hostId, sessionID);
  await remoteRequest(hostId, `/api/yuri/sessions/${encodeURIComponent(sessionID)}/metadata`, 'PUT', {
    directory,
    patch: {
      yuri: {
        titleAuthority: {
          sessionID,
          title,
          revision: `nsh-title-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          source: 'manual',
        },
        titleRefresh: {
          activityUpdatedAt: row?.activity ?? Date.now(),
          isGenerating: null,
          requestedAt: null,
          lastError: null,
          failedAt: null,
        },
      },
    },
  });
  await remoteRequest(hostId, `/api/session/${encodeURIComponent(sessionID)}`, 'PATCH', { title });
  patchSnapshot(hostId, (snapshot) => ({
    ...snapshot,
    directories: snapshot.directories.map((bucket) => ({
      ...bucket,
      sessions: bucket.sessions.map((entry) => (entry.id === sessionID ? { ...entry, title } : entry)),
    })),
  }));
}

export async function remoteDelete(hostId: string, sessionID: string, directory: string): Promise<void> {
  await remoteRequest(hostId, `/api/session/${encodeURIComponent(sessionID)}?directory=${encodeURIComponent(directory)}`, 'DELETE');
}

export async function remoteSyncTranscript(hostId: string, sessionID: string, directory: string): Promise<void> {
  await remoteRequest(
    hostId,
    `/api/session/${encodeURIComponent(sessionID)}/message?directory=${encodeURIComponent(directory)}&limit=20&order=desc`,
  );
}

/** Bounded read of a worktree's root sessions so deleting it archives what it held. */
async function remoteRootSessions(hostId: string, directory: string): Promise<Session[]> {
  const rows: Session[] = [];
  let cursor: string | null = null;
  const seen = new Set<string>();
  for (let page = 0; page < 20; page += 1) {
    const payload = record(
      await remoteRequest(
        hostId,
        `/api/session?directory=${encodeURIComponent(directory)}&parentID=null&limit=50&order=desc${
          cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''
        }`,
      ),
    );
    for (const row of list(payload.data)) {
      const session = sessionFrom(row, directory);
      if (session && !session.parentID) rows.push(session);
    }
    const next = textOf(record(payload.cursor).next) || textOf(payload.cursor) || null;
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  }
  return rows;
}

export async function remoteWorktreeDirty(hostId: string, path: string): Promise<boolean> {
  const status = record(await remoteRequest(hostId, `/api/git/status?directory=${encodeURIComponent(path)}`));
  return status.isClean === false;
}

export async function remoteDeleteWorktree(
  project: RemoteProject,
  tree: { path: string; branch: string },
  options: { deleteLocalBranch: boolean; deleteRemoteBranch: boolean },
): Promise<void> {
  const hostId = project.hostId;
  const sessions = await remoteRootSessions(hostId, tree.path);
  for (const session of sessions) {
    await remoteArchive(hostId, session.id, tree.path, true);
  }
  const result = record(
    await remoteRequest(
      hostId,
      `/api/git/worktrees?directory=${encodeURIComponent(project.path)}`,
      'DELETE',
      { directory: tree.path, deleteLocalBranch: options.deleteLocalBranch && !!tree.branch.trim() },
    ),
  );
  if (result.success !== true) throw new Error('Worktree removal failed');
  if (options.deleteRemoteBranch && tree.branch.trim()) {
    const remote = record(
      await remoteRequest(
        hostId,
        `/api/git/remote-branches?directory=${encodeURIComponent(project.path)}`,
        'DELETE',
        { branch: tree.branch.replace(/^refs\/heads\//, '').trim() },
      ),
    );
    if (remote.success !== true) throw new Error('Remote branch removal failed');
  }
  await refreshRemoteProjects();
}

export function normalizeBranch(value: string): string {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '');
}

export function slugifyWorktree(value: string): string {
  return normalizeBranch(value)
    .split('/')
    .join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export async function remoteCreateWorktree(
  project: RemoteProject,
  input: { mode: 'new' | 'existing'; branch: string; folder: string; source?: string },
): Promise<string> {
  const hostId = project.hostId;
  const body = {
    mode: input.mode,
    ...(input.mode === 'new' ? { branchName: normalizeBranch(input.branch) } : { existingBranch: normalizeBranch(input.branch) }),
    worktreeName: slugifyWorktree(input.folder),
    ...(input.mode === 'new' && input.source?.trim() ? { startRef: input.source.trim() } : {}),
  };
  const directory = encodeURIComponent(project.path);
  const validation = record(await remoteRequest(hostId, `/api/git/worktrees/validate?directory=${directory}`, 'POST', body));
  if (validation.ok !== true) {
    const detail = list(validation.errors)
      .map((row) => textOf(row.message))
      .filter(Boolean)
      .join('\n');
    throw new Error(detail || 'Failed to create worktree');
  }
  const created = record(await remoteRequest(hostId, `/api/git/worktrees?directory=${directory}`, 'POST', body));
  if (!textOf(created.path)) throw new Error('Invalid created worktree');
  await refreshRemoteProjects();
  return textOf(created.path);
}

export async function remoteProjectMeta(
  project: RemoteProject,
  meta: { label?: string; icon?: string | null; color?: string | null },
): Promise<void> {
  await request(
    `/api/hosts/${encodeURIComponent(project.hostId)}/projects/${encodeURIComponent(project.id)}`,
    'PATCH',
    meta,
  );
  await refreshRemoteProjects();
}

export async function remoteRemoveProject(project: RemoteProject): Promise<void> {
  await request(`/api/hosts/${encodeURIComponent(project.hostId)}/projects/${encodeURIComponent(project.id)}`, 'DELETE');
  await refreshRemoteProjects();
}

export async function remoteSyncProject(project: RemoteProject): Promise<void> {
  if (project.remoteState === 'remote-removed') {
    await request(`/api/hosts/${encodeURIComponent(project.hostId)}/projects`, 'POST', {
      path: project.path,
      label: project.label,
    });
  } else {
    await request(`/api/hosts/${encodeURIComponent(project.hostId)}/connect`, 'POST');
  }
  await refreshRemoteProjects();
}

export function remoteSessionRow(hostId: string, sessionID: string): Session | undefined {
  const snapshot = snapshots()[hostId];
  if (!snapshot) return undefined;
  for (const bucket of snapshot.directories) {
    const row = bucket.sessions.find((session) => session.id === sessionID);
    if (row) return row;
  }
  return undefined;
}

export function remoteUnreadCount(hostId: string, sessionID: string): number {
  return snapshots()[hostId]?.unread[sessionID]?.count ?? 0;
}

export function remoteOrder(hostId: string): { byScope: Record<string, string[]>; activity: Record<string, Record<string, number>> } {
  const snapshot = snapshots()[hostId];
  return { byScope: snapshot?.order ?? {}, activity: snapshot?.orderActivity ?? {} };
}

/** Mirrors Web `sessionNodeComparator`: saved order first, new or advanced rows float up. */
export function remoteSessionOrder(hostId: string, directory: string, rows: Session[]): Session[] {
  const snapshot = snapshots()[hostId];
  if (!snapshot) return [...rows].sort((a, b) => b.activity - a.activity);
  const scope = normalize(directory);
  const savedOrder = snapshot.order[scope];
  const savedActivity = snapshot.orderActivity[scope];
  const activity: Record<string, number> = {};
  for (const row of rows) activity[row.id] = row.activity;
  if (!savedOrder?.length || !savedActivity) return [...rows].sort((a, b) => b.activity - a.activity);
  const members = new Set(rows.map((row) => row.id));
  const ordered = new Set(savedOrder);
  const base = [...savedOrder.filter((id) => members.has(id)), ...rows.map((row) => row.id).filter((id) => !ordered.has(id))];
  const bumped: string[] = [];
  const stable: string[] = [];
  for (const id of base) {
    const saved = savedActivity[id];
    if ((saved === undefined && !ordered.has(id)) || (saved !== undefined && (activity[id] ?? 0) > saved)) bumped.push(id);
    else stable.push(id);
  }
  const ids = bumped.length
    ? [...bumped.sort((left, right) => (activity[right] ?? 0) - (activity[left] ?? 0)), ...stable]
    : base;
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
}

export async function remoteSaveSessionOrder(hostId: string, scope: string, order: string[], activity: Record<string, number>): Promise<void> {
  const snapshot = snapshots()[hostId];
  await remoteRequest(hostId, '/api/session-folders/order', 'POST', {
    scopeKey: normalize(scope),
    order,
    activity,
    onlyIfAbsent: false,
  });
  if (snapshot) {
    patchSnapshot(hostId, (current) => ({
      ...current,
      order: { ...current.order, [normalize(scope)]: order },
      orderActivity: { ...current.orderActivity, [normalize(scope)]: activity },
    }));
  }
}

/** Title search on one machine; the result carries its own directory authority. */
export async function remoteSearchSessions(hostId: string, query: string): Promise<Session[]> {
  const search = query.trim();
  if (!search) return [];
  const payload = record(
    await remoteRequest(
      hostId,
      `/api/session?search=${encodeURIComponent(search)}&parentID=null&limit=30&order=desc`,
    ),
  );
  if (!Array.isArray(payload.data)) throw new Error('Remote session search returned no data');
  return list(payload.data)
    .map((row) => sessionFrom(row, ''))
    .filter((row): row is Session => !!row);
}

/** One more remote page into the summary bucket (Web `navigation-pages`), bounded by its cursor. */
export async function remoteLoadMore(hostId: string, directory: string): Promise<void> {
  const snapshot = snapshots()[hostId];
  const bucket = snapshot?.directories.find((entry) => entry.path === normalize(directory));
  if (!snapshot || !bucket?.hasMore) return;
  const payload = record(
    await remoteRequest(
      hostId,
      `/api/session?directory=${encodeURIComponent(directory)}&parentID=null&limit=20&order=desc${
        bucket.cursor ? `&cursor=${encodeURIComponent(bucket.cursor)}` : ''
      }`,
    ),
  );
  const rows = list(payload.data)
    .map((row) => sessionFrom(row, directory))
    .filter((row): row is Session => !!row);
  const next = textOf(record(payload.cursor).next) || textOf(payload.cursor) || null;
  patchSnapshot(hostId, (current) => ({
    ...current,
    directories: current.directories.map((entry) => {
      if (entry.path !== normalize(directory)) return entry;
      const byId = new Map(entry.sessions.map((row) => [row.id, row]));
      for (const row of rows) byId.set(row.id, row);
      return {
        ...entry,
        sessions: [...byId.values()].sort((a, b) => b.activity - a.activity),
        hasMore: Boolean(next && next !== bucket.cursor),
        cursor: next && next !== bucket.cursor ? next : null,
      };
    }),
  }));
}

export async function remoteRequestSmartTitle(
  hostId: string,
  sessionID: string,
  directory: string,
  activity: number,
): Promise<void> {
  await remoteRequest(hostId, `/api/yuri/sessions/${encodeURIComponent(sessionID)}/metadata`, 'PUT', {
    directory,
    patch: {
      yuri: {
        titleRefresh: {
          requestedAt: Date.now(),
          isGenerating: null,
          lastError: null,
          failedAt: null,
          activityUpdatedAt: activity,
        },
      },
    },
  });
  await refreshRemoteProjects();
}
