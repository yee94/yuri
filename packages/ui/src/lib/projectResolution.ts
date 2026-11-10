import type { ProjectEntry } from "@/lib/api/types";
import type { WorktreeMetadata } from "@/types/worktree";

import { normalizePath } from "@/lib/pathNormalization";
export const normalizeProjectPath = normalizePath;

export const resolveProjectForDirectory = (
  projects: ProjectEntry[],
  directory: string | null,
): ProjectEntry | null => {
  const nd = normalizeProjectPath(directory);
  if (!nd) return null;
  let best: ProjectEntry | null = null;
  for (const p of projects) {
    const pp = normalizeProjectPath(p.path);
    if (!pp) continue;
    if (nd !== pp && !nd.startsWith(`${pp}/`)) continue;
    if (!best || pp.length > (normalizeProjectPath(best.path)?.length ?? 0)) best = p;
  }
  return best;
};

const resolveProjectFromWorktreeDirectory = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): { project: ProjectEntry; boundary: number } | null => {
  const nd = normalizeProjectPath(directory);
  if (!nd) return null;
  let matchedProject: ProjectEntry | null = null;
  let bestLen = -1;
  const projectsByPath = new Map(projects.map((project) => [normalizeProjectPath(project.path), project]));
  for (const [projectPath, worktrees] of availableWorktreesByProject.entries()) {
    const project = projectsByPath.get(normalizeProjectPath(projectPath));
    if (!project) continue;
    for (const wt of worktrees) {
      const wp = normalizeProjectPath(wt.path);
      if (!wp) continue;
      if (nd !== wp && !nd.startsWith(`${wp}/`)) continue;
      if (wp.length > bestLen || (wp.length === bestLen && project.path.length > (matchedProject?.path.length ?? 0))) {
        bestLen = wp.length;
        matchedProject = project;
      }
    }
  }
  return matchedProject ? { project: matchedProject, boundary: bestLen } : null;
};

export const resolveProjectForSessionDirectory = (
  projects: ProjectEntry[],
  availableWorktreesByProject: Map<string, WorktreeMetadata[]>,
  directory: string | null,
): ProjectEntry | null => {
  const direct = resolveProjectForDirectory(projects, directory);
  const worktree = resolveProjectFromWorktreeDirectory(projects, availableWorktreesByProject, directory);
  // The most specific directory wins; an explicitly opened project wins ties.
  if (direct && (!worktree || (normalizeProjectPath(direct.path)?.length ?? 0) >= worktree.boundary)) return direct;
  return worktree?.project ?? null;
};
