import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const WORKSPACE_ID_PREFIX = 'ws_';

export const isWorkspaceId = (value) => (
  typeof value === 'string' && value.startsWith(WORKSPACE_ID_PREFIX) && value.length > WORKSPACE_ID_PREFIX.length
);

export const createWorkspaceId = () => `${WORKSPACE_ID_PREFIX}${crypto.randomBytes(8).toString('hex')}`;

export const sanitizeWorkspaceIdForPath = (workspaceId) => {
  const raw = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  if (!raw || !/^[A-Za-z0-9_-]{3,128}$/.test(raw)) {
    throw Object.assign(new Error('Invalid workspace id'), { code: 'validation_error' });
  }
  return raw;
};

export const resolveBlankWorkspaceDirectory = (yuriDataDir, workspaceId) => {
  const safeId = sanitizeWorkspaceIdForPath(workspaceId);
  return path.join(yuriDataDir, 'workspaces', safeId);
};

export const ensureBlankWorkspaceDirectory = async (yuriDataDir, workspaceId, fsLike = fs) => {
  const directory = resolveBlankWorkspaceDirectory(yuriDataDir, workspaceId);
  await fsLike.mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
};

/**
 * Returns the user-attached directory list for a project/workspace entry:
 * - explicit `paths: []` => 0-path blank workspace
 * - explicit `paths: [...]` => 1..N attached directories (deduped)
 * - omitted `paths` => legacy single-path project (`[project.path]`)
 */
export const getWorkspacePaths = (project) => {
  if (!project || typeof project !== 'object') return [];
  if (Array.isArray(project.paths)) {
    const deduped = [];
    const seen = new Set();
    for (const raw of project.paths) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      deduped.push(trimmed);
    }
    return deduped;
  }
  if (typeof project.path === 'string' && project.path.trim()) {
    return [project.path.trim()];
  }
  return [];
};

export const isBlankWorkspace = (project) => (
  Boolean(project && typeof project === 'object' && Array.isArray(project.paths) && project.paths.length === 0)
);

export const isMultiPathWorkspace = (project) => getWorkspacePaths(project).length > 1;
