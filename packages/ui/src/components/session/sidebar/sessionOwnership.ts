import type { Session } from '@/lib/opencode/v2-types';
import { normalizePath } from '@/lib/pathNormalization';
import { readSessionWorktreeMetadata } from '@/lib/worktrees/sessionWorktreeMetadata';
import { getWorkspacePaths, isWorkspaceId, readSessionWorkspaceId } from '@/lib/workspacePaths';

type Project = {
  id: string;
  normalizedPath: string;
  paths?: string[];
};

type Worktree = {
  path: string;
};

export type DirectoryOwner = {
  projectId: string;
  projectRoot: string;
  scopeDirectory: string;
  kind: 'project' | 'worktree';
};

export type SessionOwnershipIndex = {
  bySessionId: Map<string, DirectoryOwner>;
  sessionsByProject: Map<string, Session[]>;
  archivedSessionsByProject: Map<string, Session[]>;
  sessionsByScope: Map<string, Set<string>>;
  directoryResolutions: number;
  /**
   * OpenCode project IDs of sessions that neither metadata nor the known
   * project/worktree directories claim. Independent of `openCodeProjectRoots`,
   * so callers can key the project lookup on it without feedback loops.
   */
  unresolvedOpenCodeProjectIds: string[];
};

const EMPTY_PROJECT_ROOTS: ReadonlyMap<string, string> = new Map();

const readOpenCodeProjectId = (session: Session): string | null => {
  const projectID = (session as { projectID?: unknown }).projectID;
  return typeof projectID === 'string' && projectID.trim() ? projectID.trim() : null;
};

const shouldReplaceOwner = (existing: DirectoryOwner | undefined, candidate: DirectoryOwner): boolean => {
  if (!existing) return true;
  if (candidate.kind !== existing.kind) {
    return candidate.kind === 'project';
  }
  if (candidate.projectRoot.length !== existing.projectRoot.length) {
    return candidate.projectRoot.length > existing.projectRoot.length;
  }
  return candidate.projectId.localeCompare(existing.projectId) < 0;
};

const setOwner = (owners: Map<string, DirectoryOwner>, directory: string, candidate: DirectoryOwner): void => {
  if (shouldReplaceOwner(owners.get(directory), candidate)) {
    owners.set(directory, candidate);
  }
};

const resolveSessionDirectory = (session: Session): string | null => {
  const record = session as Session & {
    directory?: string | null;
    project?: { worktree?: string | null } | null;
  };
  return normalizePath(record.directory) ?? normalizePath(record.project?.worktree);
};

const getParentDirectory = (directory: string): string | null => {
  if (directory === '/' || /^[A-Z]:$/.test(directory)) {
    return null;
  }
  const separator = directory.lastIndexOf('/');
  if (separator < 0) return null;
  if (separator === 0) return '/';
  if (separator === 2 && /^[A-Z]:\//.test(directory)) return directory.slice(0, 2);
  return directory.slice(0, separator);
};

export const createSessionOwnershipIndex = (
  sessions: Session[],
  projects: Project[],
  availableWorktreesByProject: Map<string, Worktree[]>,
  isVSCode: boolean,
  archivedSessions: Session[] = [],
  /** OpenCode project ID → normalized canonical checkout (`project.list()`). */
  openCodeProjectRoots: ReadonlyMap<string, string> = EMPTY_PROJECT_ROOTS,
): SessionOwnershipIndex => {
  const ownerByDirectory = new Map<string, DirectoryOwner>();
  const projectByRoot = new Map<string, Project>();
  const projectById = new Map<string, Project>();

  for (const project of projects) {
    const projectRoot = normalizePath(project.normalizedPath);
    if (!projectRoot) continue;
    const normalizedProject: Project = { ...project, normalizedPath: projectRoot };
    projectById.set(project.id, normalizedProject);
    const isMultiOrBlank = isWorkspaceId(project.id) || (Array.isArray(project.paths) && project.paths.length !== 1);
    const existingProject = projectByRoot.get(projectRoot);
    const existingIsMultiOrBlank = existingProject
      ? (isWorkspaceId(existingProject.id) || (Array.isArray(existingProject.paths) && existingProject.paths.length !== 1))
      : false;
    // Prefer a dedicated single-path project over a multi-path workspace for legacy directory-only sessions.
    if (
      !existingProject
      || (!isMultiOrBlank && existingIsMultiOrBlank)
      || (isMultiOrBlank === existingIsMultiOrBlank && project.id.localeCompare(existingProject.id) < 0)
    ) {
      projectByRoot.set(projectRoot, normalizedProject);
    }
    if (!isMultiOrBlank) {
      setOwner(ownerByDirectory, projectRoot, {
        projectId: project.id,
        projectRoot,
        scopeDirectory: projectRoot,
        kind: 'project',
      });
    }
  }

  // Register multi-path / blank workspace roots as fallback directory owners so
  // legacy sessions without metadata.yuri.workspaceId still resolve when no
  // dedicated single-path project claims that directory.
  for (const project of projects) {
    const projectRoot = normalizePath(project.normalizedPath);
    if (!projectRoot) continue;
    const isMultiOrBlank = isWorkspaceId(project.id) || (Array.isArray(project.paths) && project.paths.length !== 1);
    if (!isMultiOrBlank) continue;
    const candidateDirs = [projectRoot, ...getWorkspacePaths({ path: projectRoot, paths: project.paths })];
    for (const dir of candidateDirs) {
      const normalizedDir = normalizePath(dir);
      if (!normalizedDir || ownerByDirectory.has(normalizedDir)) continue;
      ownerByDirectory.set(normalizedDir, {
        projectId: project.id,
        projectRoot,
        scopeDirectory: normalizedDir,
        kind: 'project',
      });
    }
  }

  if (!isVSCode) {
    for (const [projectPath, worktrees] of availableWorktreesByProject) {
      const projectRoot = normalizePath(projectPath);
      const project = projectRoot ? projectByRoot.get(projectRoot) : undefined;
      if (!project || !projectRoot) continue;
      for (const worktree of worktrees) {
        const directory = normalizePath(worktree.path);
        if (!directory) continue;
        setOwner(ownerByDirectory, directory, {
          projectId: project.id,
          projectRoot,
          scopeDirectory: directory,
          kind: 'worktree',
        });
      }
    }
  }

  const resolvedOwners = new Map<string, DirectoryOwner | null>();
  const bySessionId = new Map<string, DirectoryOwner>();
  const sessionsByProject = new Map<string, Session[]>();
  const archivedSessionsByProject = new Map<string, Session[]>();
  const sessionsByScope = new Map<string, Set<string>>();

  const resolveOwner = (directory: string | null): DirectoryOwner | null => {
    if (!directory) return null;
    if (resolvedOwners.has(directory)) {
      return resolvedOwners.get(directory) ?? null;
    }

    if (isVSCode) {
      const owner = ownerByDirectory.get(directory) ?? null;
      resolvedOwners.set(directory, owner);
      return owner;
    }

    const visited: string[] = [];
    let current: string | null = directory;
    let owner: DirectoryOwner | null = null;
    while (current) {
      if (resolvedOwners.has(current)) {
        owner = resolvedOwners.get(current) ?? null;
        break;
      }
      visited.push(current);
      owner = ownerByDirectory.get(current) ?? null;
      if (owner) break;
      current = getParentDirectory(current);
    }
    for (const visitedDirectory of visited) {
      resolvedOwners.set(visitedDirectory, owner);
    }
    return owner;
  };

  const resolveExplicitWorkspaceOwner = (session: Session): DirectoryOwner | null => {
    const workspaceId = readSessionWorkspaceId(session);
    if (!workspaceId) return null;
    const project = projectById.get(workspaceId);
    if (!project) return null;
    const projectRoot = normalizePath(project.normalizedPath);
    if (!projectRoot) return null;
    const sessionDir = resolveSessionDirectory(session);
    const attached = getWorkspacePaths({ path: projectRoot, paths: project.paths });
    const isMemberDir = Boolean(sessionDir && (sessionDir === projectRoot || attached.includes(sessionDir)));
    return {
      projectId: project.id,
      projectRoot,
      scopeDirectory: sessionDir ?? projectRoot,
      kind: isMemberDir || !sessionDir ? 'project' : 'worktree',
    };
  };

  const resolveExplicitWorktreeOwner = (session: Session): DirectoryOwner | null => {
    if (isVSCode) return null;
    const worktreeMeta = readSessionWorktreeMetadata(session);
    if (!worktreeMeta) return null;
    const project = (worktreeMeta.projectId ? projectById.get(worktreeMeta.projectId) : undefined)
      ?? projectByRoot.get(worktreeMeta.projectDirectory);
    if (!project) return null;
    const projectRoot = normalizePath(project.normalizedPath);
    if (!projectRoot) return null;
    const scopeDirectory = resolveSessionDirectory(session) ?? worktreeMeta.path;
    return {
      projectId: project.id,
      projectRoot,
      scopeDirectory,
      kind: scopeDirectory === projectRoot ? 'project' : 'worktree',
    };
  };

  // Sessions without ownership metadata (OpenCode TUI, imports, sessions that
  // OpenCode moved into a worktree) can live outside every project path, but
  // OpenCode still records their repository as `session.projectID`. Its
  // canonical checkout selects the Yuri directories of that repository:
  // the repository root, a multi-path member, or a monorepo subdirectory
  // project whose relative path the session directory repeats.
  const candidatesByCanonical = new Map<string, Array<{ relative: string; owner: DirectoryOwner }>>();
  const candidatesForCanonical = (canonical: string) => {
    const cached = candidatesByCanonical.get(canonical);
    if (cached) return cached;
    const candidates: Array<{ relative: string; owner: DirectoryOwner }> = [];
    for (const [directory, owner] of ownerByDirectory) {
      if (owner.kind !== 'project') continue;
      if (directory === canonical) candidates.push({ relative: '', owner });
      else if (directory.startsWith(canonical === '/' ? '/' : `${canonical}/`)) {
        candidates.push({ relative: directory.slice(canonical === '/' ? 1 : canonical.length + 1), owner });
      }
    }
    candidates.sort((a, b) => b.relative.length - a.relative.length);
    candidatesByCanonical.set(canonical, candidates);
    return candidates;
  };
  const resolveOpenCodeProjectOwner = (session: Session, directory: string | null): DirectoryOwner | null => {
    if (isVSCode) return null;
    const openCodeProjectId = readOpenCodeProjectId(session);
    const canonical = openCodeProjectId ? normalizePath(openCodeProjectRoots.get(openCodeProjectId)) : null;
    if (!canonical) return null;
    const match = candidatesForCanonical(canonical).find(({ relative }) => !relative
      || (directory !== null && (directory.endsWith(`/${relative}`) || directory.includes(`/${relative}/`))));
    if (!match) return null;
    return {
      ...match.owner,
      scopeDirectory: directory ?? match.owner.scopeDirectory,
      kind: directory && directory !== match.owner.scopeDirectory ? 'worktree' : 'project',
    };
  };

  const unresolvedOpenCodeProjectIds = new Set<string>();

  const bucket = (
    input: Session[],
    target: Map<string, Session[]>,
    scopeTarget?: Map<string, Set<string>>,
  ): void => {
    for (const session of input) {
      let owner = resolveExplicitWorkspaceOwner(session) ?? resolveExplicitWorktreeOwner(session);
      if (!owner) {
        const directory = resolveSessionDirectory(session);
        owner = resolveOwner(directory);
        if (!owner) {
          const openCodeProjectId = readOpenCodeProjectId(session);
          if (openCodeProjectId) unresolvedOpenCodeProjectIds.add(openCodeProjectId);
          owner = resolveOpenCodeProjectOwner(session, directory);
        }
      }
      if (!owner) continue;
      bySessionId.set(session.id, owner);
      const projectSessions = target.get(owner.projectId);
      if (projectSessions) {
        projectSessions.push(session);
      } else {
        target.set(owner.projectId, [session]);
      }
      if (!scopeTarget) continue;
      const scopeSessions = scopeTarget.get(owner.scopeDirectory);
      if (scopeSessions) {
        scopeSessions.add(session.id);
      } else {
        scopeTarget.set(owner.scopeDirectory, new Set([session.id]));
      }
    }
  };

  bucket(sessions, sessionsByProject, sessionsByScope);
  bucket(archivedSessions, archivedSessionsByProject);

  return {
    bySessionId,
    sessionsByProject,
    archivedSessionsByProject,
    sessionsByScope,
    directoryResolutions: resolvedOwners.size,
    unresolvedOpenCodeProjectIds: [...unresolvedOpenCodeProjectIds].sort(),
  };
};
