import { arePathsEquivalent, normalizeDirectoryKey } from '../ui/src/lib/pathNormalization';
import type { ChatTarget, Project, Session } from './model';

export const DESKTOP_SIDEBAR_INITIAL_COUNT = 3;
export const DESKTOP_SIDEBAR_PAGE_INCREMENT = 7;

export type DesktopSidebarTree = { path: string; name: string; branch: string };
export type DesktopSidebarGroup<T> = { directory: string; label: string; tree?: DesktopSidebarTree; rows: readonly T[] };
export type DesktopSidebarProject<T> = { project: Project; groups: DesktopSidebarGroup<T>[] };

/** Identity only: authorization and generation changes must retire all old menu callbacks. */
export function desktopSidebarScope(connection: { id: string; url: string; authorizationID?: string | null } | null, generation: number) {
  return connection ? JSON.stringify([connection.id, connection.url, connection.authorizationID ?? null, generation]) : null;
}

export function desktopSidebarSelected(row: Pick<Session, 'id' | 'directory'>, selected: ChatTarget | null | undefined) {
  return selected?.kind === 'session' && selected.id === row.id && arePathsEquivalent(selected.directory, row.directory);
}

/** Controller supplies ranks; this projection never re-sorts projects, worktrees or sessions. */
export function desktopSidebarProjects<T>(
  projects: readonly Project[],
  directories: ReadonlyMap<string, readonly T[]>,
  worktrees: (project: Project) => readonly DesktopSidebarTree[],
): DesktopSidebarProject<T>[] {
  const byDirectory = new Map<string, readonly T[]>();
  for (const [path, rows] of directories) byDirectory.set(normalizeDirectoryKey(path), rows);
  return projects.map(project => {
    const root = normalizeDirectoryKey(project.path), seen = new Set([root]);
    const groups: DesktopSidebarGroup<T>[] = [{ directory: project.path, label: project.name, rows: byDirectory.get(root) ?? [] }];
    for (const tree of worktrees(project)) {
      const key = normalizeDirectoryKey(tree.path);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      groups.push({ directory: tree.path, label: tree.branch || tree.name || tree.path, tree, rows: byDirectory.get(key) ?? [] });
    }
    return { project, groups };
  });
}

/** Same compact desktop policy: pinned roots live above projects; live/current rows escape the fold. */
export function desktopSidebarWindow<T extends Pick<Session, 'id' | 'directory'>>(
  rows: readonly T[], count: number, pinned: ReadonlySet<string>, running: ReadonlySet<string>, selected: ChatTarget | null | undefined,
) {
  const candidates = rows.filter(row => !pinned.has(row.id));
  const boundary = Math.max(0, Math.floor(count));
  const visible = candidates.filter((row, index) => index < boundary || running.has(row.id) || desktopSidebarSelected(row, selected));
  return { rows: visible, hidden: candidates.length - visible.length };
}
