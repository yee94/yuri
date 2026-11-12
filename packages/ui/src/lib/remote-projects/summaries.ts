import type { SessionIndexSession } from '@/lib/session-index-api';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';

export interface RemoteWorktreeTopology {
  projectDirectories: Record<string, string[]>;
  staleProjectDirectories: string[];
}

export interface RemoteHostSummaries {
  hubId: string;
  hostId: string;
  stale: boolean;
  revision: number;
  lastSyncedAt?: number;
  pinnedSessionIds: string[];
  directories: Array<{ directory: string; sessions: SessionIndexSession[]; hasMore: boolean; cursor: number | null; lastSyncedAt: number }>;
  unread?: { revision: number; sessions: Record<string, { directory: string; unreadCount: number; hasError: boolean; manual: boolean; revision: number }> };
  folders?: { version: number; updatedAt: number; collapsedFolderIds: string[]; foldersMap: Record<string, Array<{ id: string; name: string; sessionIds: string[]; createdAt: number; parentId: string | null }>> };
  order?: { revision: number; sessionOrderByScope: Record<string, string[]>; sessionOrderActivityByScope: Record<string, Record<string, number>> };
  worktrees?: RemoteWorktreeTopology;
}

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid remote summary snapshot');
  return value as Record<string, unknown>;
};
const text = (value: unknown): string => {
  if (typeof value !== 'string' || !value || value.length > 16_384) throw new Error('Invalid remote summary identity');
  return value;
};
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const ids = (value: unknown): string[] => Array.isArray(value) ? value.map(text) : [];
const entries = <T>(value: unknown, parse: (value: unknown) => T): Record<string, T> => Object.fromEntries(
  Object.entries(object(value)).map(([key, row]) => [key, parse(row)]),
);

/** Only summary fields cross this seam; never retain response bodies or credentials. */
export const parseRemoteHostSummaries = (input: unknown, hubId: string, hostId: string): RemoteHostSummaries => {
  const value = object(input);
  if (value.hostId !== hostId || (value.hubId !== undefined && value.hubId !== hubId) || !Array.isArray(value.directories) || typeof value.stale !== 'boolean') {
    throw new Error('Remote summary scope mismatch');
  }
  const result: RemoteHostSummaries = {
    hubId, hostId, stale: value.stale, revision: number(value.revision),
    pinnedSessionIds: ids(value.pinnedSessionIds),
    ...(typeof value.lastSyncedAt === 'number' ? { lastSyncedAt: number(value.lastSyncedAt) } : {}),
    directories: value.directories.map((input) => {
      const row = object(input);
      if (!Array.isArray(row.sessions)) throw new Error('Invalid remote summary directory');
      const directory = text(row.directory);
      return {
        directory, hasMore: row.hasMore === true, cursor: typeof row.cursor === 'number' ? row.cursor : null,
        lastSyncedAt: number(row.lastSyncedAt),
        sessions: row.sessions.map((input) => {
          const session = object(input);
          const time = object(session.time);
          const metadata = session.metadata ? object(session.metadata) : undefined;
          const yuri = metadata?.yuri ? object(metadata.yuri) : undefined;
          const status = yuri?.sessionStatus ? object(yuri.sessionStatus) : undefined;
          return {
            id: text(session.id), directory, title: typeof session.title === 'string' ? session.title : '',
            ...(typeof session.parentID === 'string' ? { parentID: session.parentID } : {}),
            ...(typeof session.projectID === 'string' ? { projectID: session.projectID } : {}),
            ...(typeof session.slug === 'string' ? { slug: session.slug } : {}),
            ...(typeof session.version === 'string' ? { version: session.version } : {}),
            hasChildren: session.hasChildren === true,
            time: { created: number(time.created), updated: number(time.updated),
              ...(typeof time.archived === 'number' ? { archived: time.archived } : {}),
              ...(typeof time.pinned === 'string' || typeof time.pinned === 'number' ? { pinned: time.pinned } : {}),
            },
            ...(status && typeof status.type === 'string' ? { metadata: { yuri: { sessionStatus: {
              type: value.stale ? 'unknown' : status.type,
              ...(typeof status.lastKnown === 'string' ? { lastKnown: status.lastKnown } : value.stale ? { lastKnown: status.type } : {}),
            } } } } : {}),
          } as SessionIndexSession;
        }),
      };
    }),
  };
  if (value.unread) {
    const unread = object(value.unread);
    result.unread = { revision: number(unread.revision), sessions: entries(unread.sessions ?? {}, (input) => {
      const row = object(input);
      return { directory: text(row.directory), unreadCount: number(row.unreadCount), hasError: row.hasError === true, manual: row.manual === true, revision: number(row.revision) };
    }) };
  }
  if (value.folders) {
    const folders = object(value.folders);
    result.folders = { version: number(folders.version), updatedAt: number(folders.updatedAt), collapsedFolderIds: ids(folders.collapsedFolderIds), foldersMap: entries(folders.foldersMap ?? {}, (input) => {
      if (!Array.isArray(input)) throw new Error('Invalid remote folders snapshot');
      return input.map((input) => {
        const row = object(input);
        return { id: text(row.id), name: text(row.name), sessionIds: ids(row.sessionIds), createdAt: number(row.createdAt), parentId: typeof row.parentId === 'string' ? row.parentId : null };
      });
    }) };
  }
  if (value.order) {
    const order = object(value.order);
    result.order = { revision: number(order.revision), sessionOrderByScope: entries(order.sessionOrderByScope ?? {}, ids), sessionOrderActivityByScope: entries(order.sessionOrderActivityByScope ?? {}, (input) => entries(input, number)) };
  }
  if (value.worktrees !== undefined) {
    const worktrees = object(value.worktrees);
    if (!Array.isArray(worktrees.staleProjectDirectories)) throw new Error('Invalid remote worktree topology');
    result.worktrees = {
      projectDirectories: entries(worktrees.projectDirectories, (paths) => {
        if (!Array.isArray(paths)) throw new Error('Invalid remote worktree directories');
        return paths.map(text);
      }),
      staleProjectDirectories: worktrees.staleProjectDirectories.map(text),
    };
  }
  return result;
};

const within = (directory: string, root: string): boolean => directory === root || directory.startsWith(root.endsWith('/') ? root : `${root}/`);

/** Topology is Host authority, not a common-parent heuristic or filesystem cwd rewrite. */
export function resolveRemoteProjectOwner<T extends { path: string; hubId?: string; hostId?: string }>(
  projects: readonly T[], hubId: string, hostId: string, directory: string, topology?: RemoteWorktreeTopology,
): T | undefined {
  const target = normalizeDirectoryKey(directory);
  if (!target) return undefined;
  const scoped = projects.filter((project) => project.hostId === hostId && (!project.hubId || project.hubId === hubId));
  const explicit = scoped.filter((project) => { const root = normalizeDirectoryKey(project.path); return root && within(target, root); })
    .sort((a, b) => normalizeDirectoryKey(b.path).length - normalizeDirectoryKey(a.path).length)[0];
  if (explicit) return explicit;
  let owner: T | undefined;
  let best = -1;
  let ambiguous = false;
  const catalogs = new Map(Object.entries(topology?.projectDirectories ?? {}).map(([path, paths]) => [normalizeDirectoryKey(path), paths]));
  for (const project of scoped) {
    const root = normalizeDirectoryKey(project.path);
    if (!root) continue;
    const catalog = catalogs.get(root);
    const roots = [root, ...(catalog?.map(normalizeDirectoryKey).filter(Boolean) ?? [])];
    const match = roots.filter((path) => within(target, path)).sort((a, b) => b.length - a.length)[0];
    if (!match) continue;
    const score = match.length;
    if (score > best) { owner = project; best = score; ambiguous = false; }
    else if (score === best && owner !== project) ambiguous = true;
  }
  return ambiguous ? undefined : owner;
}

export const remoteHostSummariesKey = (transport: string, hubId: string, hostId: string) => [transport, 'remote-projects', 'summaries', hubId, hostId] as const;
