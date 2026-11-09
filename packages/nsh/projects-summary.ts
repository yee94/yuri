import { createSessionOwnershipIndex } from '../ui/src/components/session/sidebar/sessionOwnership';
import { normalizePath } from '../ui/src/lib/pathNormalization';

type Project = { id: string; path: string };
type Session = { id: string; directory: string; updated: number };
export type ProjectHomeSummary = { count: number; latest: number; partial: boolean };

/** Visible root catalog only; paging completeness stays with each directory's original owner. */
export function nativeProjectHomeSummaries(projects: readonly Project[], sessions: Session[], worktrees: Readonly<Record<string, readonly { path: string }[]>>, buckets: Readonly<Record<string, { hasMore: boolean }>>, issues?: { failedDirectories: readonly string[]; pendingDirectories: readonly string[] }): Map<string, ProjectHomeSummary> {
  const trees = new Map(Object.entries(worktrees).map(([root, rows]) => [root, [...rows]]));
  const pathsByRoot = new Map([...trees].map(([root, rows]) => [normalizePath(root), rows.map(tree => tree.path)]));
  const ownership = createSessionOwnershipIndex(sessions, projects.map(project => ({ id: project.id, normalizedPath: project.path })), trees, false);
  const pages = new Map(Object.entries(buckets).map(([directory, value]) => [normalizePath(directory), value]));
  const incomplete = new Set([...(issues?.failedDirectories ?? []), ...(issues?.pendingDirectories ?? [])].map(normalizePath));
  const result = new Map<string, ProjectHomeSummary>();
  for (const project of projects) {
    const rows = ownership.sessionsByProject.get(project.id) ?? [];
    let latest = 0;
    for (const row of rows) if (Number.isFinite(row.updated) && row.updated > latest) latest = row.updated;
    const paths = [project.path, ...(pathsByRoot.get(normalizePath(project.path)) ?? [])];
    result.set(project.id, { count: rows.length, latest, partial: paths.some(path => pages.get(normalizePath(path))?.hasMore === true || incomplete.has(normalizePath(path))) });
  }
  return result;
}
