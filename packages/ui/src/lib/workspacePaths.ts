import type { ProjectEntry } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/v2-types';
import { normalizePath } from '@/lib/pathNormalization';

export const WORKSPACE_ID_PREFIX = 'ws_';

export const isWorkspaceId = (id: string | null | undefined): boolean => (
  typeof id === 'string' && id.startsWith(WORKSPACE_ID_PREFIX) && id.length > WORKSPACE_ID_PREFIX.length
);

export const normalizeWorkspacePath = (value: string | null | undefined): string => {
  return normalizePath(value ?? null) ?? '';
};

/**
 * Returns the user-attached directories for a project/workspace:
 * - `paths: []` => blank 0-path workspace
 * - `paths: [...]` => explicit 1..N attached paths (primary first)
 * - `paths === undefined` => legacy single-path project (`[project.path]`)
 */
type WorkspacePathLike = {
  path?: string | null;
  normalizedPath?: string | null;
  paths?: string[];
};

export const getWorkspacePaths = (project: WorkspacePathLike | null | undefined): string[] => {
  if (!project) return [];
  if (Array.isArray(project.paths)) {
    const deduped: string[] = [];
    const seen = new Set<string>();
    for (const raw of project.paths) {
      const normalized = normalizeWorkspacePath(raw);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      deduped.push(normalized);
    }
    return deduped;
  }
  const single = normalizeWorkspacePath(project.path ?? project.normalizedPath);
  return single ? [single] : [];
};

export const isBlankWorkspace = (project: WorkspacePathLike | null | undefined): boolean => (
  Boolean(project && Array.isArray(project.paths) && project.paths.length === 0)
);

export const isMultiPathWorkspace = (project: WorkspacePathLike | null | undefined): boolean => (
  getWorkspacePaths(project).length > 1
);

export const getWorkspacePrimaryPath = (project: WorkspacePathLike | null | undefined): string => {
  if (!project) return '';
  const attached = getWorkspacePaths(project);
  if (attached.length > 0) return attached[0];
  return normalizeWorkspacePath(project.path ?? project.normalizedPath);
};

export const getWorkspaceDisplayLabel = (project: Pick<ProjectEntry, 'id' | 'path' | 'paths' | 'label'> | null | undefined): string => {
  if (!project) return '';
  const label = typeof project.label === 'string' ? project.label.trim() : '';
  if (label) return label;
  const primary = getWorkspacePrimaryPath(project);
  if (!primary || primary === '/') return 'Workspace';
  const segments = primary.split('/').filter(Boolean);
  return segments[segments.length - 1] || primary;
};

export const readSessionWorkspaceId = (session: Session | null | undefined): string | null => {
  if (!session || !session.metadata || typeof session.metadata !== 'object' || Array.isArray(session.metadata)) {
    return null;
  }
  const yuri = (session.metadata as Record<string, unknown>).yuri;
  if (!yuri || typeof yuri !== 'object' || Array.isArray(yuri)) {
    return null;
  }
  const workspaceId = (yuri as Record<string, unknown>).workspaceId;
  if (typeof workspaceId !== 'string') return null;
  const trimmed = workspaceId.trim();
  return trimmed.length > 0 ? trimmed : null;
};

export const buildSessionWorkspaceMetadataPatch = (
  workspaceId: string | null | undefined,
): Record<string, unknown> | undefined => {
  const trimmed = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  if (!trimmed) return undefined;
  return {
    yuri: {
      workspaceId: trimmed,
    },
  };
};
