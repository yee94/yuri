import type { ProjectEntry } from '@/lib/api/types';
import type { Session } from '@/lib/opencode/v2-types';
import { normalizePath } from '@/lib/pathNormalization';
import { wrapSystemReminder } from '@/lib/systemReminder';

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

const basenameOf = (dir: string): string => dir.split('/').filter(Boolean).at(-1) || dir;

/**
 * Hidden context for the first user message of a new Session in a multi-path
 * or 0-path workspace, as one `<system-reminder>` block that user bubbles,
 * composer restoration, titles and search strip. Null for single-path projects.
 */
export const buildWorkspacePromptContext = (
  project: Pick<ProjectEntry, 'id' | 'path' | 'paths' | 'label'> | null | undefined,
  activeDirectory: string | null | undefined,
): string | null => {
  if (!project) return null;
  const attached = getWorkspacePaths(project);
  const label = getWorkspaceDisplayLabel(project);
  if (attached.length === 0 && isBlankWorkspace(project)) {
    return wrapSystemReminder([
      `Yuri workspace context: "${label}" (workspaceId: ${project.id}).`,
      'This workspace has no attached project directories yet. Treat it as a general workspace without assuming a Git repository or codebase root unless the user attaches paths or specifies an explicit path.',
    ].join('\n'));
  }
  if (attached.length <= 1) return null;
  const cwd = normalizeWorkspacePath(activeDirectory) || attached[0];
  return wrapSystemReminder([
    `This session works in the Yuri workspace "${label}" (workspaceId: ${project.id}), which consists of ${attached.length} directories together:`,
    ...attached.map((dir) => `- ${basenameOf(dir)}: ${dir}`),
    'Rules for the whole session, not only this message:',
    `- "This project", "the workspace", "your working directory", "pwd" and similar wording always mean all ${attached.length} directories above as one unit. Never describe the scope as a single directory.`,
    '- When the user asks about the scope, structure, or contents of the project, or to look at / review / search the project, cover every directory above, each by its absolute path.',
    `- Shell commands start in ${cwd} only as a technical default. For any other directory, pass its absolute path or change directory explicitly.`,
    '- Keep per-directory conventions (package manager, build scripts, Git branch/worktree state) scoped to their own directory; a directory may not be a Git repository.',
    '- Yuri shows branches read-only; run git checkout, commit or worktree changes directly in the target directory when the user asks.',
  ].join('\n'));
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
