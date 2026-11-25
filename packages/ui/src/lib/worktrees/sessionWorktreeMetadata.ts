import type { Session } from '@/lib/opencode/v2-types';
import { normalizePath } from '@/lib/pathNormalization';
import type { WorktreeMetadata } from '@/types/worktree';

export type SessionYuriWorktreeMetadata = {
  projectId?: string;
  projectDirectory: string;
  worktreeRoot: string;
  path: string;
  branch?: string;
  name?: string;
  relativePath?: string;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const asTrimmedString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const getPathBasename = (value?: string | null): string | undefined => {
  const normalized = normalizePath(value);
  if (!normalized || normalized === '/') return undefined;
  const segments = normalized.split('/').filter(Boolean);
  return segments[segments.length - 1];
};

const normalizeBranchLabel = (value?: string | null): string | undefined => {
  const trimmed = asTrimmedString(value);
  if (!trimmed || trimmed === 'HEAD') return undefined;
  return trimmed.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
};

export const readSessionWorktreeMetadata = (
  session: Session | null | undefined,
): SessionYuriWorktreeMetadata | null => {
  if (!session || !isPlainObject(session.metadata)) return null;
  const yuri = session.metadata.yuri;
  if (!isPlainObject(yuri)) return null;
  const raw = yuri.worktree;
  if (!isPlainObject(raw)) return null;

  const projectDirectory = normalizePath(asTrimmedString(raw.projectDirectory));
  const path = normalizePath(asTrimmedString(raw.path));
  if (!projectDirectory || !path) return null;

  const worktreeRoot = normalizePath(asTrimmedString(raw.worktreeRoot)) ?? path;
  const projectId = asTrimmedString(raw.projectId);
  const branch = normalizeBranchLabel(asTrimmedString(raw.branch));
  const name = asTrimmedString(raw.name);
  const relativePath = asTrimmedString(raw.relativePath)?.replace(/^\/+|\/+$/g, '') || undefined;

  return {
    ...(projectId ? { projectId } : {}),
    projectDirectory,
    worktreeRoot,
    path,
    ...(branch ? { branch } : {}),
    ...(name ? { name } : {}),
    ...(relativePath ? { relativePath } : {}),
  };
};

export const buildSessionWorktreeMetadataPatch = (
  worktree: WorktreeMetadata | null | undefined,
  project?: { id?: string | null; path?: string | null } | null,
): Record<string, unknown> | undefined => {
  if (!worktree) return undefined;
  const path = normalizePath(worktree.path);
  const projectDirectory = normalizePath(project?.path ?? worktree.projectDirectory);
  if (!path || !projectDirectory || path === projectDirectory) return undefined;

  const worktreeRoot = normalizePath(worktree.worktreeRoot ?? worktree.path) ?? path;
  const projectId = asTrimmedString(project?.id);
  const branch = normalizeBranchLabel(worktree.branch);
  const name = asTrimmedString(worktree.name) ?? getPathBasename(worktreeRoot) ?? getPathBasename(path);
  const relativePath = asTrimmedString(worktree.relativePath)?.replace(/^\/+|\/+$/g, '') || undefined;

  return {
    yuri: {
      worktree: {
        ...(projectId ? { projectId } : {}),
        projectDirectory,
        worktreeRoot,
        path,
        ...(branch ? { branch } : {}),
        ...(name ? { name } : {}),
        ...(relativePath ? { relativePath } : {}),
      },
    },
  };
};

export const sessionWorktreeToMetadata = (
  session: Session | null | undefined,
): WorktreeMetadata | null => {
  const worktree = readSessionWorktreeMetadata(session);
  if (!worktree) return null;
  const name = worktree.name ?? getPathBasename(worktree.worktreeRoot) ?? getPathBasename(worktree.path) ?? '';
  const branch = worktree.branch ?? '';
  return {
    source: 'sdk',
    name,
    path: worktree.path,
    projectDirectory: worktree.projectDirectory,
    branch,
    label: branch || name || worktree.path,
    worktreeRoot: worktree.worktreeRoot,
    ...(worktree.relativePath ? { relativePath: worktree.relativePath } : {}),
    worktreeStatus: 'ready',
    headState: branch ? 'branch' : undefined,
  };
};

export const formatWorktreeFooterLabel = (
  worktree: Pick<WorktreeMetadata, 'branch' | 'name' | 'label' | 'path' | 'worktreeRoot'> | null | undefined,
  options?: { liveBranch?: string | null },
): string | null => {
  if (!worktree) return null;
  const branch = normalizeBranchLabel(options?.liveBranch) ?? normalizeBranchLabel(worktree.branch);
  const name = asTrimmedString(worktree.name)
    ?? getPathBasename(worktree.worktreeRoot ?? worktree.path)
    ?? asTrimmedString(worktree.label);

  if (branch && name) {
    if (branch.toLowerCase() === name.toLowerCase()) {
      return branch;
    }
    return `${branch} · ${name}`;
  }
  return branch ?? name ?? null;
};
