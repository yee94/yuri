import type { WorktreeMetadata } from '@/types/worktree';
import { normalizePath } from '@/lib/pathNormalization';

// Git owns checkout roots; Yuri projects may be subdirectories of a checkout.
export const scopeProjectWorktrees = (
  projectDirectory: string,
  worktrees: WorktreeMetadata[],
): WorktreeMetadata[] => {
  const project = normalizePath(projectDirectory);
  if (!project) return [];
  let checkout: string | null = null;
  for (const entry of worktrees) {
    for (const candidate of [entry.worktreeRoot ?? entry.path, entry.projectDirectory]) {
      const root = normalizePath(candidate);
      if (!root || (project !== root && !project.startsWith(`${root}/`))) continue;
      // Already scoped metadata names the Yuri project, not a Git checkout.
      if (candidate === entry.projectDirectory && entry.relativePath) continue;
      if (!checkout || root.length > checkout.length) checkout = root;
    }
  }
  const relativePath = checkout ? project.slice(checkout.length).replace(/^\//, '') : '';
  return worktrees.flatMap((entry) => {
    const root = normalizePath(entry.worktreeRoot ?? entry.path);
    if (!root) return [];
    const suffix = entry.relativePath ?? relativePath;
    const directory = suffix ? `${root}/${suffix}` : root;
    if (directory === project) return [];
    if (entry.path === directory && (!suffix || (entry.projectDirectory === project && entry.relativePath === suffix))) return [entry];
    return [{ ...entry, path: directory, worktreeRoot: root, projectDirectory: suffix ? project : entry.projectDirectory, relativePath: suffix || undefined }];
  });
};
