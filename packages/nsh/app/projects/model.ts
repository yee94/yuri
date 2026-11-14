import { signal } from 'nsh';
import { t } from '../core/i18n';
import {
  activeProjectId,
  catalogIssues,
  formatRelativeShort,
  isRepository,
  isSessionHidden,
  liveStatus,
  normalizePath,
  paginationFor,
  pinnedSessionIds,
  projectLabel,
  projectOrderIds,
  projects,
  sessionById,
  sessionOrder,
  sessionsByDirectory,
  unreadCount,
  viewingSessionId,
  worktreesFor,
  type CatalogIssues,
  type Project,
  type Session,
  type Worktree,
} from '../core/store';
import {
  hostFor,
  hostName,
  remoteDirectories,
  remoteOwner,
  remoteProjects as remoteProjectCatalog,
  remoteSessionKey,
  remoteSessionOrder,
  remoteSnapshot,
  remoteUnreadCount,
  type RemoteHost,
  type RemoteProject,
} from '../core/remote';

export type NodeRemote = {
  hostId: string;
  hostName: string;
  sessionID: string;
  directory: string;
  projectId: string;
};

export type Node = {
  id: string;
  kind: 'session' | 'pagination';
  title: string;
  subtitle?: string;
  changes?: string;
  activityLabel?: string;
  unread: boolean;
  pinned: boolean;
  archived: boolean;
  active: boolean;
  directory: string;
  /** Present on rows that live on a Remote Host; commands route with this coordinate. */
  remote?: NodeRemote;
  /** The machine tag Web renders after the subtitle (`RemoteHostIndicator compactName`). */
  machine?: string;
  activity?: number;
  /** Web `session.share.url`; sharing itself is unavailable in this OpenCode cut. */
  share?: string;
};

export type WorktreeGroup = {
  id: string;
  name: string;
  path: string;
  kind: 'main' | 'worktree';
  active: boolean;
  expanded: boolean;
  sessionCount: number;
  sessions: Node[];
  catalogSessions: Node[];
};

export type ProjectRemote = {
  hostId: string;
  hostName: string;
  state: RemoteHost['state'];
  remoteState: RemoteProject['remoteState'];
  lastError?: string;
  instanceId?: string;
  remoteProjectId: string;
};

export type ProjectItem = {
  id: string;
  name: string;
  path: string;
  sessionCount: number;
  sessionCountPartial: boolean;
  activityLabel?: string;
  active: boolean;
  expanded: boolean;
  worktrees: WorktreeGroup[];
  icon?: string;
  color?: string;
  iconBackground?: string;
  /** A Remote Project reuses this card with a machine tag and routed commands. */
  remote?: ProjectRemote;
  /** Web offers worktree actions only on a git repository. */
  git: boolean;
};

const DEFAULT_VISIBLE = 3; // Web `getMobileSessionDefaultVisibleCount`
const SHOW_MORE_STEP = 7; // Web `getMobileSessionShowMoreIncrement`
export const SHOW_MORE_PREFIX = '__show_more__:';
export const SHOW_FEWER_PREFIX = '__show_fewer__:';

export const isPaginationId = (id: string) => id.startsWith(SHOW_MORE_PREFIX) || id.startsWith(SHOW_FEWER_PREFIX);

export const parsePaginationId = (
  id: string,
): { kind: 'more' | 'fewer'; projectId: string; bucketKey: string } | null => {
  const prefix = id.startsWith(SHOW_MORE_PREFIX)
    ? SHOW_MORE_PREFIX
    : id.startsWith(SHOW_FEWER_PREFIX)
      ? SHOW_FEWER_PREFIX
      : null;
  if (!prefix) return null;
  const rest = id.slice(prefix.length);
  const separator = rest.indexOf('::');
  if (separator <= 0) return null;
  return {
    kind: prefix === SHOW_MORE_PREFIX ? 'more' : 'fewer',
    projectId: rest.slice(0, separator),
    bucketKey: rest.slice(separator + 2),
  };
};

// --- expansion (Web `useMobileSessionTreeStore` + per-bucket slice) ---

const expandedProjects = signal<Record<string, boolean>>({});
const expandedWorktrees = signal<Record<string, boolean>>({});
const visibleCounts = signal<Record<string, number>>({});

export const toggleProjectExpanded = (id: string) => {
  const current = expandedProjects();
  expandedProjects.set({ ...current, [id]: !(current[id] ?? true) });
};
export const toggleWorktreeExpanded = (key: string) => {
  const current = expandedWorktrees();
  expandedWorktrees.set({ ...current, [key]: !(current[key] ?? false) });
};
const bucketVisibleCount = (key: string) => visibleCounts()[key] ?? DEFAULT_VISIBLE;
export const showMoreSessions = (projectId: string, bucketKey: string) => {
  const key = `${projectId}::${bucketKey}`;
  const current = visibleCounts();
  visibleCounts.set({
    ...current,
    [key]: Math.max(DEFAULT_VISIBLE, current[key] ?? DEFAULT_VISIBLE) + SHOW_MORE_STEP,
  });
};
export const showFewerSessions = (projectId: string, bucketKey: string) => {
  const key = `${projectId}::${bucketKey}`;
  const next = { ...visibleCounts() };
  delete next[key];
  visibleCounts.set(next);
};
/** Web `resetBucketVisibleCount` after a drag reorders the visible slice. */
export const resetBucketVisibleCounts = () => visibleCounts.set({});

// --- ordering (Web `sessionSortableOrder` / `pinnedSessions`) ---

const activityMatches = (next: Record<string, number>, saved: Record<string, number>): boolean => {
  const keys = new Set([...Object.keys(next), ...Object.keys(saved)]);
  for (const key of keys) if ((next[key] ?? 0) !== (saved[key] ?? 0)) return false;
  return true;
};

function effectiveOrder(
  memberIds: string[],
  savedOrder: string[] | undefined,
  activity: Record<string, number>,
  savedActivity: Record<string, number> | undefined,
): string[] {
  if (!savedOrder || savedOrder.length === 0 || !savedActivity) return [];
  const members = new Set(memberIds);
  const ordered = new Set(savedOrder);
  const base = [...savedOrder.filter((id) => members.has(id)), ...memberIds.filter((id) => !ordered.has(id))];
  if (base.length === 0) return [];
  if (activityMatches(activity, savedActivity)) return base;
  const bumped: string[] = [];
  const stable: string[] = [];
  for (const id of base) {
    const saved = savedActivity[id];
    const isNew = saved === undefined && !ordered.has(id);
    const advanced = saved !== undefined && (activity[id] ?? 0) > saved;
    if (isNew || advanced) bumped.push(id);
    else stable.push(id);
  }
  if (bumped.length === 0) return base;
  const baseIndex = new Map(base.map((id, index) => [id, index]));
  bumped.sort(
    (left, right) =>
      (activity[right] ?? 0) - (activity[left] ?? 0) || (baseIndex.get(left) ?? 0) - (baseIndex.get(right) ?? 0),
  );
  return [...bumped, ...stable];
}

function orderedSessions(rows: Session[], scope: string): Session[] {
  const order = sessionOrder();
  const activity: Record<string, number> = {};
  for (const row of rows) activity[row.id] = row.activity;
  const ids = effectiveOrder(rows.map((row) => row.id), order.byScope[scope], activity, order.activity[scope]);
  if (ids.length === 0) return [...rows].sort((a, b) => b.activity - a.activity);
  const rank = new Map(ids.map((id, index) => [id, index]));
  return [...rows].sort((a, b) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length));
}

function rankPinned(rows: Session[], manualOrder: string[]): Session[] {
  const rank = new Map(manualOrder.map((id, index) => [id, index]));
  return [...rows].sort(
    (a, b) =>
      (rank.get(a.id) ?? manualOrder.length) - (rank.get(b.id) ?? manualOrder.length) || b.created - a.created,
  );
}

// --- ownership (Web `createSessionOwnershipIndex`) ---

type Owner = { projectId: string; scopeDirectory: string; kind: 'project' | 'worktree' };

const parentDirectory = (directory: string): string | null => {
  if (directory === '/' || /^[A-Z]:$/.test(directory)) return null;
  const at = directory.lastIndexOf('/');
  if (at < 0) return null;
  if (at === 0) return '/';
  if (at === 2 && /^[A-Z]:\//.test(directory)) return directory.slice(0, 2);
  return directory.slice(0, at);
};

function ownershipIndex(list: Project[], worktrees: Map<string, Worktree[]>) {
  const owners = new Map<string, Owner>();
  const projectsByRoot = new Map<string, Project>();
  for (const project of list) {
    const root = normalizePath(project.path);
    if (!root) continue;
    projectsByRoot.set(root, project);
    owners.set(root, { projectId: project.id, scopeDirectory: root, kind: 'project' });
  }
  for (const [projectPath, trees] of worktrees) {
    const root = normalizePath(projectPath);
    const project = projectsByRoot.get(root);
    if (!project) continue;
    for (const tree of trees) {
      const directory = normalizePath(tree.path);
      if (directory) owners.set(directory, { projectId: project.id, scopeDirectory: directory, kind: 'worktree' });
    }
  }
  const resolved = new Map<string, Owner | null>();
  const resolve = (directory: string): Owner | null => {
    if (resolved.has(directory)) return resolved.get(directory) ?? null;
    const visited: string[] = [];
    let current: string | null = directory;
    let owner: Owner | null = null;
    while (current) {
      if (resolved.has(current)) {
        owner = resolved.get(current) ?? null;
        break;
      }
      visited.push(current);
      owner = owners.get(current) ?? null;
      if (owner) break;
      current = parentDirectory(current);
    }
    for (const path of visited) resolved.set(path, owner);
    return owner;
  };
  const bySessionId = new Map<string, Owner>();
  for (const [directory, rows] of sessionsByDirectory()) {
    const owner = resolve(directory);
    if (!owner) continue;
    for (const row of rows) bySessionId.set(row.id, owner);
  }
  return bySessionId;
}

/** Every root session of a bucket (subagents never show on the phone home). */
const bucketRoots = (rows: Session[]): Session[] => {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (row.parentID || seen.has(row.id)) return false;
    seen.add(row.id);
    return true;
  });
};

const relativeLabel = (time: number): string | undefined => formatRelativeShort(time) || undefined;

function sessionNode(
  session: Session,
  options: { directory: string; subtitle?: string; pinned: boolean },
): Node {
  return {
    id: session.id,
    kind: 'session',
    title: session.title.trim() || t('mobile.sessions.untitled'),
    ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    ...(session.changes ? { changes: session.changes } : {}),
    ...(session.share ? { share: session.share } : {}),
    activityLabel: relativeLabel(session.activity),
    unread: unreadCount(session.id) > 0,
    pinned: options.pinned,
    archived: session.archived,
    active: viewingSessionId() === session.id,
    directory: options.directory,
    activity: session.activity,
  };
}

function remoteSessionNode(
  hostId: string,
  project: RemoteProject,
  session: Session,
  options: { directory: string; subtitle?: string; pinned: boolean; machine?: boolean },
): Node {
  const name = hostName(hostId);
  return {
    id: remoteSessionKey(hostId, session.id),
    kind: 'session',
    title: session.title.trim() || t('mobile.sessions.untitled'),
    ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    ...(session.share ? { share: session.share } : {}),
    activityLabel: relativeLabel(session.activity),
    unread: remoteUnreadCount(hostId, session.id) > 0,
    pinned: options.pinned,
    archived: session.archived,
    active: viewingSessionId() === remoteSessionKey(hostId, session.id),
    directory: options.directory,
    remote: { hostId, hostName: name, sessionID: session.id, directory: options.directory, projectId: project.id },
    ...(options.machine === false ? {} : { machine: name }),
    activity: session.activity,
  };
}

export type HomeModel = {
  projects: ProjectItem[];
  pinned: Node[];
  inProgress: Node[];
  issues: CatalogIssues | null;
};

const remoteRemoteInfo = (project: RemoteProject): ProjectRemote => {
  const host = hostFor(project.hostId);
  return {
    hostId: project.hostId,
    hostName: hostName(project.hostId),
    state: host?.state ?? 'offline',
    remoteState: project.remoteState,
    ...(host?.lastError ? { lastError: host.lastError } : {}),
    ...(project.instanceId ?? host?.instanceId ? { instanceId: project.instanceId ?? host?.instanceId } : {}),
    remoteProjectId: project.remoteProjectId,
  };
};

function remoteGroups(project: RemoteProject): { groups: WorktreeGroup[]; total: number; partial: boolean; latest: number } {
  const snapshot = remoteSnapshot(project.hostId);
  const directories = remoteDirectories(project, snapshot);
  const pinned = new Set(snapshot?.pinned ?? []);
  let total = 0;
  let partial = false;
  let latest = 0;
  const groups = directories.map((directory) => {
    const rows = bucketRoots(
      directory.sessions.filter((row) => !row.archived && remoteOwner(project.hostId, row.directory || directory.path)?.id === project.id),
    );
    const roots = remoteSessionOrder(project.hostId, directory.path, rows);
    total += roots.length;
    for (const row of roots) latest = Math.max(latest, row.activity);
    if (directory.hasMore) partial = true;
    const key = `${project.id}::${directory.path}`;
    const visibleCount = bucketVisibleCount(key);
    const visible = roots.slice(0, Math.max(0, visibleCount));
    for (let index = visibleCount; index < roots.length; index += 1) {
      const row = roots[index];
      if (row && (row.remoteStatus === 'busy' || row.remoteStatus === 'retry')) visible.push(row);
    }
    const nodes = visible.map((session) =>
      remoteSessionNode(project.hostId, project, session, {
        directory: directory.path,
        pinned: pinned.has(session.id),
        machine: false,
      }),
    );
    const remaining = roots.length - nodes.length;
    if (roots.length > DEFAULT_VISIBLE && visibleCount > DEFAULT_VISIBLE) {
      nodes.push({
        id: `${SHOW_FEWER_PREFIX}${project.id}::${directory.path}`,
        kind: 'pagination',
        title: t('sessions.sidebar.group.showFewer'),
        unread: false,
        pinned: false,
        archived: false,
        active: false,
        directory: directory.path,
      });
    }
    if (remaining > 0 || directory.hasMore) {
      nodes.push({
        id: `${SHOW_MORE_PREFIX}${project.id}::${directory.path}`,
        kind: 'pagination',
        title: t('sessions.sidebar.group.showMore'),
        unread: false,
        pinned: false,
        archived: false,
        active: false,
        directory: directory.path,
      });
    }
    return {
      id: directory.path,
      name: directory.kind === 'worktree' ? directory.label : t('mobile.sessions.mainWorkspace'),
      path: directory.path,
      kind: directory.kind,
      active: false,
      expanded: directory.kind === 'worktree' ? (expandedWorktrees()[key] ?? false) : true,
      sessionCount: roots.length,
      sessions: nodes,
      catalogSessions: roots.map((session) =>
        remoteSessionNode(project.hostId, project, session, {
          directory: directory.path,
          pinned: pinned.has(session.id),
          machine: false,
        }),
      ),
    };
  });
  return { groups, total, partial, latest };
}

const byManualOrder = <T extends { id: string }>(items: T[]): T[] => {
  const order = projectOrderIds();
  if (!order.length) return items;
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...items].sort(
    (left, right) => (rank.get(left.id) ?? order.length) - (rank.get(right.id) ?? order.length),
  );
};

export function homeModel(): HomeModel {
  const projectList = projects();
  const byDirectory = sessionsByDirectory();
  const pinnedIds = pinnedSessionIds();
  const order = sessionOrder();
  const currentProjectId = activeProjectId();
  const currentSession = viewingSessionId() ? sessionById(viewingSessionId()!) : undefined;
  const currentDirectory = normalizePath(currentSession?.directory);
  const worktreeMap = new Map<string, Worktree[]>();
  for (const project of projectList) worktreeMap.set(normalizePath(project.path), worktreesFor(project.path));
  const owners = ownershipIndex(projectList, worktreeMap);
  const allSessions = [...byDirectory.values()].flat().filter((session) => !isSessionHidden(session.id));
  const running = new Set(
    allSessions
      .filter((session) => {
        const status = liveStatus(session.id);
        return status?.type === 'busy' || status?.type === 'retry';
      })
      .map((session) => session.id),
  );

  const projectById = new Map(projectList.map((project) => [project.id, project]));
  const subtitleFor = (session: Session): string | undefined => {
    const owner = owners.get(session.id);
    const project = owner ? projectById.get(owner.projectId) : undefined;
    if (!project) return undefined;
    const branch =
      owner?.kind === 'worktree'
        ? worktreeMap
            .get(normalizePath(project.path))
            ?.find((tree) => normalizePath(tree.path) === owner.scopeDirectory)?.branch
        : null;
    return branch?.trim() ? `${project.label} · ${branch.trim()}` : project.label;
  };

  const pinned: Node[] = rankPinned(
    allSessions.filter((session) => pinnedIds.has(session.id)),
    order.byScope['__pinned__'] ?? [],
  ).map((session) =>
    sessionNode(session, { directory: session.directory, subtitle: subtitleFor(session), pinned: true }),
  );

  const inProgress: Node[] = allSessions
    .filter(
      (session) =>
        !pinnedIds.has(session.id) &&
        !session.archived &&
        !session.parentID &&
        (running.has(session.id) || unreadCount(session.id) > 0),
    )
    .sort((a, b) => b.activity - a.activity)
    .map((session) =>
      sessionNode(session, { directory: session.directory, subtitle: subtitleFor(session), pinned: false }),
    );

  const items: ProjectItem[] = projectList.map((project) => {
    const root = normalizePath(project.path);
    const trees = worktreeMap.get(root) ?? [];
    const buckets = [
      { key: root, label: t('mobile.sessions.mainWorkspace'), path: root, worktree: null as Worktree | null },
      ...trees.map((tree) => ({
        key: normalizePath(tree.path),
        label: tree.branch || tree.name || projectLabel(tree.path),
        path: normalizePath(tree.path),
        worktree: tree as Worktree | null,
      })),
    ];
    let projectSessions = 0;
    let partial = false;
    const worktrees: WorktreeGroup[] = buckets.map((bucket) => {
      const rows = (byDirectory.get(bucket.path) ?? []).filter(
        (row) => owners.get(row.id)?.scopeDirectory === bucket.path && !isSessionHidden(row.id),
      );
      const roots = orderedSessions(bucketRoots(rows), bucket.path);
      projectSessions += roots.length;
      const pagination = paginationFor(bucket.path);
      if (pagination.hasMore) partial = true;
      const expandKey = `${project.id}::${bucket.key}`;
      const visibleCount = bucketVisibleCount(expandKey);
      const visible = roots.slice(0, Math.max(0, visibleCount));
      for (let index = visibleCount; index < roots.length; index += 1) {
        const row = roots[index];
        if (row && running.has(row.id)) visible.push(row);
      }
      const nodes = visible.map((session) =>
        sessionNode(session, { directory: bucket.path, pinned: pinnedIds.has(session.id) }),
      );
      const remaining = roots.length - nodes.length;
      if (roots.length > DEFAULT_VISIBLE && visibleCount > DEFAULT_VISIBLE) {
        nodes.push({
          id: `${SHOW_FEWER_PREFIX}${project.id}::${bucket.key}`,
          kind: 'pagination',
          title: t('sessions.sidebar.group.showFewer'),
          unread: false,
          pinned: false,
          archived: false,
          active: false,
          directory: bucket.path,
        });
      }
      if (remaining > 0 || pagination.hasMore) {
        nodes.push({
          id: `${SHOW_MORE_PREFIX}${project.id}::${bucket.key}`,
          kind: 'pagination',
          title: t('sessions.sidebar.group.showMore'),
          ...(pagination.loading ? { subtitle: '\u2026' } : {}),
          unread: false,
          pinned: false,
          archived: false,
          active: false,
          directory: bucket.path,
        });
      }
      return {
        id: bucket.key,
        name: bucket.worktree ? bucket.label : t('mobile.sessions.mainWorkspace'),
        path: bucket.path,
        kind: bucket.worktree ? ('worktree' as const) : ('main' as const),
        active: Boolean(
          currentDirectory && (currentDirectory === bucket.path || currentDirectory.startsWith(`${bucket.path}/`)),
        ),
        expanded: bucket.worktree ? (expandedWorktrees()[expandKey] ?? false) : true,
        sessionCount: roots.length,
        sessions: nodes,
        catalogSessions: roots.map((session) =>
          sessionNode(session, { directory: bucket.path, pinned: pinnedIds.has(session.id) }),
        ),
      };
    });
    const latest = worktrees.reduce((value, group) => {
      const rows = byDirectory.get(group.path) ?? [];
      return Math.max(value, rows.reduce((at, row) => Math.max(at, row.activity), 0));
    }, 0);
    return {
      id: project.id,
      name: project.label,
      path: project.path,
      sessionCount: projectSessions,
      sessionCountPartial: partial,
      ...(latest > 0 ? { activityLabel: relativeLabel(latest) } : {}),
      active: project.id === currentProjectId,
      expanded: expandedProjects()[project.id] ?? true,
      worktrees,
      ...(project.icon ? { icon: project.icon } : {}),
      ...(project.color ? { color: project.color } : {}),
      ...(project.iconBackground ? { iconBackground: project.iconBackground } : {}),
      git: trees.length > 0 || isRepository(project.path),
    };
  });

  // Remote Projects: same card, same rows, one machine tag; commands carry the host coordinate.
  for (const remote of remoteProjectCatalog()) {
    const host = hostFor(remote.hostId);
    const snapshot = remoteSnapshot(remote.hostId);
    const build = remoteGroups(remote);
    const pinnedIdsForHost = new Set(snapshot?.pinned ?? []);
    const remotePinned = (snapshot?.directories ?? []).flatMap((bucket) =>
      bucket.sessions
        .filter(
          (session) =>
            pinnedIdsForHost.has(session.id) &&
            !session.archived &&
            !session.parentID &&
            remoteOwner(remote.hostId, session.directory || bucket.path)?.id === remote.id,
        )
        .map((session) => ({ session, directory: session.directory || bucket.path })),
    );
    const rankedRemote = rankPinned(
      remotePinned.map((row) => row.session),
      snapshot?.order['__pinned__'] ?? [],
    );
    for (const session of rankedRemote) {
      const entry = remotePinned.find((row) => row.session.id === session.id);
      if (!entry) continue;
      const group = build.groups.find((candidate) => candidate.path === normalizePath(entry.directory));
      const branch = group && group.kind === 'worktree' ? group.name : undefined;
      pinned.push(
        remoteSessionNode(remote.hostId, remote, session, {
          directory: entry.directory,
          subtitle: branch?.trim() ? `${remote.label} · ${branch.trim()}` : remote.label,
          pinned: true,
        }),
      );
    }
    const attention = (snapshot?.directories ?? []).flatMap((bucket) =>
      bucket.sessions
        .filter((session) => {
          if (pinnedIdsForHost.has(session.id) || session.archived || session.parentID) return false;
          if (remoteOwner(remote.hostId, session.directory || bucket.path)?.id !== remote.id) return false;
          return session.remoteStatus === 'busy' || session.remoteStatus === 'retry' || remoteUnreadCount(remote.hostId, session.id) > 0;
        })
        .map((session) => ({ session, directory: session.directory || bucket.path })),
    );
    const labelFor = (directory: string) => {
      const group = build.groups.find((candidate) => candidate.path === normalizePath(directory));
      return group && group.kind === 'worktree' ? `${remote.label} · ${group.name}` : remote.label;
    };
    for (const { session, directory } of attention.sort((a, b) => b.session.activity - a.session.activity)) {
      inProgress.push(
        remoteSessionNode(remote.hostId, remote, session, {
          directory,
          subtitle: labelFor(directory),
          pinned: false,
        }),
      );
    }
    items.push({
      id: remote.id,
      name: remote.label,
      path: remote.path,
      sessionCount: build.total,
      sessionCountPartial: build.partial,
      ...(build.latest > 0 ? { activityLabel: relativeLabel(build.latest) } : {}),
      active: remote.id === currentProjectId,
      expanded: expandedProjects()[remote.id] ?? true,
      worktrees: build.groups,
      remote: remoteRemoteInfo(remote),
      ...(remote.icon ? { icon: remote.icon } : {}),
      ...(remote.color ? { color: remote.color } : {}),
      ...(remote.iconBackground ? { iconBackground: remote.iconBackground } : {}),
      git: Boolean(snapshot?.worktrees[normalizePath(remote.path)]?.length),
    });
  }

  return {
    projects: byManualOrder(items),
    pinned,
    inProgress: inProgress.sort((a, b) => (b.activity ?? 0) - (a.activity ?? 0)),
    issues: catalogIssues(),
  };
}

/** Web `filterMobileProjectsForSearch`: one bounded pass over the unpaginated catalog. */
export function filterProjects(items: ProjectItem[], rawQuery: string): ProjectItem[] {
  const query = rawQuery.trim().toLowerCase();
  if (!query) return items;
  const matches = (...values: (string | undefined)[]) =>
    values.some((value) => value?.toLowerCase().includes(query));
  return items.flatMap((project) => {
    if (matches(project.name, project.path, project.remote?.hostName)) return [{ ...project, worktrees: [] }];
    const worktrees = project.worktrees.flatMap((group) => {
      if (matches(group.name, group.path)) {
        return [{ ...group, sessions: group.catalogSessions.filter((node) => node.kind === 'session') }];
      }
      const sessions = group.catalogSessions.filter(
        (node) => node.kind === 'session' && matches(node.title, node.subtitle, node.id),
      );
      return sessions.length ? [{ ...group, sessions }] : [];
    });
    return worktrees.length ? [{ ...project, worktrees }] : [];
  });
}

/** Session search (title/content) rows always carry the machine that owns the session. */
export function searchSessionNode(session: Session, directory: string, remote?: NodeRemote): Node {
  if (remote) {
    return {
      id: remoteSessionKey(remote.hostId, session.id),
      kind: 'session',
      title: session.title.trim() || t('mobile.sessions.untitled'),
      activityLabel: relativeLabel(session.activity),
      unread: remoteUnreadCount(remote.hostId, session.id) > 0,
      pinned: false,
      archived: session.archived,
      active: viewingSessionId() === remoteSessionKey(remote.hostId, session.id),
      directory,
      remote,
      machine: remote.hostName,
      activity: session.activity,
    };
  }
  return {
    id: session.id,
    kind: 'session',
    title: session.title.trim() || t('mobile.sessions.untitled'),
    activityLabel: relativeLabel(session.activity),
    unread: unreadCount(session.id) > 0,
    pinned: pinnedSessionIds().has(session.id),
    archived: session.archived,
    active: viewingSessionId() === session.id,
    directory,
    activity: session.activity,
  };
}

/** Local sessions known to the index, matching a title fragment (Web's fallback title search). */
export function localSearchNodes(lower: string): Node[] {
  const rows = [...sessionsByDirectory().entries()].flatMap(([directory, list]) =>
    list.filter((session) => !session.parentID && !isSessionHidden(session.id)),
  );
  const seen = new Set<string>();
  return rows
    .filter((session) => {
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      return session.title.toLowerCase().includes(lower);
    })
    .sort((a, b) => b.activity - a.activity)
    .map((session) => searchSessionNode(session, session.directory));
}

/** Web `RemoteHostIndicator`: the machine badge's small exclamation and its message. */
export function remoteProblem(remote?: ProjectRemote): string | undefined {
  if (!remote) return undefined;
  if (remote.lastError) return remote.lastError;
  if (remote.remoteState === 'remote-removed') return t('remoteProjects.remote-removed');
  if (remote.remoteState === 'host-unavailable') return t('remoteProjects.host-unavailable');
  if (remote.state === 'connected') return undefined;
  if (remote.state === 'idle') return t('remoteProjects.state.idle');
  if (remote.state === 'connecting') return t('remoteProjects.state.connecting');
  if (remote.state === 'degraded') return t('remoteProjects.state.degraded');
  if (remote.state === 'unauthorized') return t('remoteProjects.state.unauthorized');
  if (remote.state === 'incompatible') return t('remoteProjects.state.incompatible');
  return t('remoteProjects.state.offline');
}
