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

export const WORKSPACE_INSTRUCTION_KEY = 'yuri.workspace';

export const resolveWorkspaceForSession = (projects, { workspaceId = null, directory = null } = {}) => {
  if (!Array.isArray(projects) || projects.length === 0) return null;
  const trimmedId = typeof workspaceId === 'string' ? workspaceId.trim() : '';
  if (trimmedId) {
    const byId = projects.find((entry) => entry && entry.id === trimmedId);
    if (byId) return byId;
  }
  const normalizedDir = typeof directory === 'string' ? directory.trim().replace(/\\/g, '/').replace(/\/+$/, '') : '';
  if (!normalizedDir) return null;
  // Exact primary match on explicit multi-path/blank workspace only if no dedicated single-path project claims it.
  const normalizedOf = (value) => (typeof value === 'string' ? value.trim().replace(/\\/g, '/').replace(/\/+$/, '') : '');
  const exactSingle = projects.find((entry) => (
    entry && !isWorkspaceId(entry.id) && (!Array.isArray(entry.paths) || entry.paths.length === 1)
    && normalizedOf(entry.path) === normalizedDir
  ));
  if (exactSingle) return exactSingle;
  return projects.find((entry) => (
    entry && (normalizedOf(entry.path) === normalizedDir || getWorkspacePaths(entry).some((p) => normalizedOf(p) === normalizedDir))
  )) || null;
};

export const installWorkspaceSessionInstruction = async ({
  client,
  sessionID,
  workspaceId = null,
  directory = null,
  readSettings,
  sanitizeProjects,
}) => {
  if (!sessionID || typeof client?.session?.instructions?.entry?.put !== 'function') return false;
  if (typeof readSettings !== 'function' || typeof sanitizeProjects !== 'function') return false;
  const settings = await readSettings();
  const projects = sanitizeProjects(settings?.projects) || [];
  const workspace = resolveWorkspaceForSession(projects, { workspaceId, directory });
  const value = buildWorkspaceSystemInstruction(workspace, directory);
  if (!value) return false;
  await client.session.instructions.entry.put({
    sessionID,
    key: WORKSPACE_INSTRUCTION_KEY,
    value,
  });
  return true;
};

/**
 * Build OpenCode v2 `session.instructions.entry` text for multi-path or 0-path
 * workspaces. Returns null for ordinary single-path projects so existing
 * prompts remain untouched.
 */
export const buildWorkspaceSystemInstruction = (workspace, activeDirectory = null) => {
  if (!workspace || typeof workspace !== 'object') return null;
  const attached = getWorkspacePaths(workspace);
  const label = typeof workspace.label === 'string' && workspace.label.trim()
    ? workspace.label.trim()
    : (attached[0] ? path.basename(attached[0]) : workspace.id || 'Workspace');

  if (attached.length === 0) {
    return [
      `Yuri workspace context: "${label}" (workspaceId: ${workspace.id}).`,
      'This workspace has no attached project directories yet. Treat it as a general workspace without assuming a Git repository or codebase root unless the user attaches paths or specifies an explicit path.',
    ].join('\n');
  }

  if (attached.length <= 1) {
    return null;
  }

  const primary = attached[0];
  const cwd = typeof activeDirectory === 'string' && activeDirectory.trim() ? activeDirectory.trim() : primary;
  const lines = [
    `Yuri multi-path workspace context: "${label}" (workspaceId: ${workspace.id}).`,
    `Active session working directory (primary cwd): ${cwd}`,
    'Attached workspace directories:',
    ...attached.map((dir, index) => `- [${index === 0 ? 'primary' : 'additional'}] ${path.basename(dir) || dir}: ${dir}`),
    'Guidelines:',
    '- Shell commands default to the active session working directory above. When reading, editing, or running git/build/test commands for another attached directory, always pass its explicit absolute path or change directory explicitly.',
    '- Keep project-specific conventions (package manager, build scripts, git branch/worktree state) scoped to each directory.',
    '- When this workspace spans multiple independent Git repositories, Yuri displays branches read-only; perform git checkout, commit, or worktree adjustments directly on the target repository path when the user requests them.',
  ];
  return lines.join('\n');
};
