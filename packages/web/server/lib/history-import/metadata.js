import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { extractCodexGitOriginUrl } from './events.js';
import { readCodexStateMetadata } from './sqlite.js';

const MAX_META_FILE_BYTES = 32 * 1024 * 1024;
const CODEX_PROJECTLESS_RE = /^(.+?[/\\]Documents[/\\]Codex)[/\\]\d{4}-\d{2}-\d{2}[/\\][^/\\]+(?:[/\\].*)?$/;

export function defaultCursorUserDir(home = os.homedir(), env = process.env, platform = process.platform) {
  return platform === 'darwin' ? path.join(home, 'Library/Application Support/Cursor/User')
    : platform === 'win32' ? path.join(env.APPDATA || path.join(home, 'AppData/Roaming'), 'Cursor/User')
      : path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Cursor/User');
}

export function codexHomeFor(file) {
  const parts = path.resolve(file).split(path.sep);
  const index = parts.findLastIndex((part) => part === 'sessions' || part === 'archived_sessions');
  return index > 0 ? parts.slice(0, index).join(path.sep) || path.sep : null;
}

const isWithin = (candidate, root) => candidate === root || candidate.startsWith(`${root}${path.sep}`);

const normalizeAbsolute = (value) => typeof value === 'string' && path.isAbsolute(value) ? path.resolve(value) : '';

const readBoundedText = async (file, maxBytes = MAX_META_FILE_BYTES) => {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) return null;
  return fs.readFile(file, 'utf8');
};

export async function resolveGitWorktreeRoot(directory, cache = new Map()) {
  const normalized = normalizeAbsolute(directory);
  if (!normalized) return directory || '';
  const key = `worktree:${normalized}`;
  if (cache.has(key)) return cache.get(key);
  let resolved = normalized;
  try {
    const dotGit = path.join(normalized, '.git');
    const stat = await fs.lstat(dotGit);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096) {
      const content = await fs.readFile(dotGit, 'utf8');
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (match) {
        const gitDir = path.resolve(normalized, match[1].trim());
        const worktreesDir = path.dirname(gitDir);
        const commonGitDir = path.dirname(worktreesDir);
        if (path.basename(worktreesDir) === 'worktrees' && path.basename(commonGitDir) === '.git') {
          const mainRepo = path.dirname(commonGitDir);
          if ((await fs.stat(mainRepo)).isDirectory()) resolved = mainRepo;
        }
      }
    }
  } catch {
    // Missing or inaccessible .git keeps the original directory.
  }
  cache.set(key, resolved);
  return resolved;
}

async function loadCodexMetadata(codexHome, cache) {
  const key = `codex:${codexHome}`;
  if (cache.has(key)) return cache.get(key);
  const titles = new Map();
  const projectRootsById = new Map();
  const threadProjectId = new Map();
  const legacyThreadProjectRoot = new Map();
  const definedRootsSet = new Set();
  const projectless = new Set();
  const rootHints = new Map();
  const threadOrigins = new Map();
  let stateThreads = new Map();

  // 1. Read highest-numbered state_<N>.sqlite via safe copy-only snapshot.
  try {
    const entries = await fs.readdir(codexHome, { withFileTypes: true });
    let latestState;
    for (const entry of entries) {
      if (!entry.isFile() || entry.isSymbolicLink()) continue;
      const match = entry.name.match(/^state_(\d+)\.sqlite$/);
      if (!match) continue;
      const version = Number(match[1]);
      if (!latestState || version > latestState.version) latestState = { version, path: path.join(codexHome, entry.name) };
    }
    if (latestState) {
      const state = await readCodexStateMetadata(latestState.path);
      for (const [projectId, roots] of state.projectRootsById) projectRootsById.set(projectId, roots);
      for (const root of state.definedRoots) definedRootsSet.add(root);
      stateThreads = state.threads;
      for (const [id, thread] of state.threads) {
        if (thread.name) titles.set(id, thread.name);
        if (thread.projectID) threadProjectId.set(id, thread.projectID);
        if (thread.gitOriginUrl) threadOrigins.set(id, thread.gitOriginUrl);
      }
    }
  } catch {
    // Optional metadata: transcript import still works without state SQLite.
  }

  // 2. Read session_index.jsonl for summarized thread names.
  try {
    const raw = await readBoundedText(path.join(codexHome, 'session_index.jsonl'));
    if (raw) {
      const indexTitles = new Map();
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const row = JSON.parse(line);
          if (typeof row?.id === 'string' && row.id && typeof row.thread_name === 'string' && row.thread_name.trim()) {
            indexTitles.set(row.id, row.thread_name.trim());
          }
        } catch {
          // Ignore malformed index lines.
        }
      }
      for (const [id, name] of indexTitles) if (!titles.has(id)) titles.set(id, name);
    }
  } catch {
    // Optional metadata.
  }

  // 3. Read .codex-global-state.json for local project definitions, worktree hints, and projectless threads.
  try {
    const raw = await readBoundedText(path.join(codexHome, '.codex-global-state.json'));
    if (raw) {
      const state = JSON.parse(raw);
      const localProjectRoots = new Map();
      if (state && typeof state['local-projects'] === 'object' && state['local-projects']) {
        for (const [projectId, project] of Object.entries(state['local-projects'])) {
          const roots = Array.isArray(project?.rootPaths) ? project.rootPaths.map(normalizeAbsolute).filter(Boolean) : [];
          if (!roots.length) continue;
          localProjectRoots.set(projectId, roots);
          for (const root of roots) definedRootsSet.add(root);
        }
      }
      if (state && typeof state['thread-project-assignments'] === 'object' && state['thread-project-assignments']) {
        for (const [threadId, assignment] of Object.entries(state['thread-project-assignments'])) {
          const roots = typeof assignment?.projectId === 'string' ? localProjectRoots.get(assignment.projectId) : null;
          if (roots?.[0]) legacyThreadProjectRoot.set(threadId, roots[0]);
        }
      }
      if (Array.isArray(state?.['projectless-thread-ids'])) {
        for (const id of state['projectless-thread-ids']) if (typeof id === 'string' && id) projectless.add(id);
      }
      if (state && typeof state === 'object') {
        for (const [entryKey, value] of Object.entries(state)) {
          if ((entryKey === 'thread-workspace-root-hints'
            || entryKey.startsWith('electron-owner-value:thread-workspace-root-hints:')) && value && typeof value === 'object') {
            for (const [threadId, hint] of Object.entries(value)) {
              const normalized = normalizeAbsolute(hint);
              if (normalized && !rootHints.has(threadId)) rootHints.set(threadId, normalized);
            }
          } else if ((entryKey === 'electron-saved-workspace-roots'
            || entryKey === 'active-workspace-roots'
            || entryKey.startsWith('electron-owner-value:electron-saved-workspace-roots:')
            || entryKey.startsWith('electron-owner-value:active-workspace-roots:')) && Array.isArray(value)) {
            for (const root of value) {
              const normalized = normalizeAbsolute(root);
              if (normalized) definedRootsSet.add(normalized);
            }
          }
        }
      }
    }
  } catch {
    // Optional metadata.
  }

  const definedRoots = [...definedRootsSet].sort((a, b) => b.length - a.length);
  const matchDefinedRoot = (candidate) => {
    const normalized = normalizeAbsolute(candidate);
    if (!normalized) return '';
    return definedRoots.find((root) => isWithin(normalized, root)) ?? '';
  };

  // Build unambiguous git_origin_url -> defined Codex project root mapping.
  const originToRoot = new Map();
  for (const thread of stateThreads.values()) {
    if (!thread.gitOriginUrl || !thread.cwd) continue;
    const matched = matchDefinedRoot(thread.cwd);
    if (!matched) continue;
    if (!originToRoot.has(thread.gitOriginUrl)) originToRoot.set(thread.gitOriginUrl, matched);
    else if (originToRoot.get(thread.gitOriginUrl) !== matched) originToRoot.set(thread.gitOriginUrl, null);
  }

  const basenameToRoot = new Map();
  for (const root of definedRoots) {
    const base = path.basename(root);
    if (!base) continue;
    if (!basenameToRoot.has(base)) basenameToRoot.set(base, root);
    else if (basenameToRoot.get(base) !== root) basenameToRoot.set(base, null);
  }

  const result = {
    titles, projectRootsById, threadProjectId, legacyThreadProjectRoot,
    definedRoots, matchDefinedRoot, originToRoot, basenameToRoot,
    projectless, rootHints, threadOrigins,
  };
  cache.set(key, result);
  return result;
}

async function resolveCodexDirectory(session, meta, codexHome, gitOriginUrl, cache) {
  const id = session.id;
  const rawCwd = normalizeAbsolute(session.directory);
  const projectID = meta.threadProjectId.get(id);
  const assignedRoot = (projectID && meta.projectRootsById.get(projectID)?.[0]) || meta.legacyThreadProjectRoot.get(id);
  if (assignedRoot) return assignedRoot;

  const directMatch = meta.matchDefinedRoot(rawCwd);
  if (directMatch) return directMatch;

  const hint = meta.rootHints.get(id);
  const hintMatch = meta.matchDefinedRoot(hint);
  if (hintMatch) return hintMatch;

  const worktreeMain = rawCwd ? await resolveGitWorktreeRoot(rawCwd, cache) : '';
  if (worktreeMain && worktreeMain !== rawCwd) {
    return meta.matchDefinedRoot(worktreeMain) || worktreeMain;
  }

  const effectiveOrigin = meta.threadOrigins.get(id) || gitOriginUrl;
  const originMatch = effectiveOrigin ? meta.originToRoot.get(effectiveOrigin) : '';
  if (originMatch) return originMatch;

  const codexWorktrees = path.join(codexHome, 'worktrees');
  if (rawCwd && isWithin(rawCwd, codexWorktrees)) {
    const byName = meta.basenameToRoot.get(path.basename(rawCwd));
    if (byName) return byName;
  }

  if (rawCwd) {
    if (meta.projectless.has(id) && hint && isWithin(rawCwd, hint)) return hint;
    const dated = rawCwd.match(CODEX_PROJECTLESS_RE);
    if (dated) return path.resolve(dated[1]);
  }

  return worktreeMain || session.directory || '';
}

const encodeCursorSlug = (directory) => directory
  .replace(/^\/+/, '')
  .replace(/[^A-Za-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

const cursorSlugFor = (file) => {
  const parts = path.resolve(file).split(path.sep);
  const transcripts = parts.lastIndexOf('agent-transcripts');
  const projects = transcripts > 1 ? parts.lastIndexOf('projects', transcripts - 1) : -1;
  if (projects < 0 || transcripts - projects !== 2) return '';
  return parts[projects + 1] ?? '';
};

async function loadCursorWorkspaces(cursorUserDir, cache) {
  const key = `cursor-ws:${cursorUserDir}`;
  if (cache.has(key)) return cache.get(key);
  const slugToPath = new Map();
  const basenameToPath = new Map();
  const workspaceStorage = path.join(cursorUserDir, 'workspaceStorage');
  try {
    const entries = await fs.readdir(workspaceStorage, { withFileTypes: true });
    for (const entry of entries.slice(0, 1000)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const raw = await readBoundedText(path.join(workspaceStorage, entry.name, 'workspace.json'), 1024 * 1024).catch(() => null);
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw);
        if (typeof parsed?.folder !== 'string' || !parsed.folder.startsWith('file:')) continue;
        const folder = path.resolve(fileURLToPath(parsed.folder));
        const slug = encodeCursorSlug(folder);
        if (!slug) continue;
        const exists = await fs.stat(folder).then((stat) => stat.isDirectory()).catch(() => false);
        const existing = slugToPath.get(slug);
        if (!existing || exists) slugToPath.set(slug, folder);
        if (exists && !folder.includes(`${path.sep}.cursor${path.sep}worktrees${path.sep}`)
          && !folder.includes(`${path.sep}worktree${path.sep}`)) {
          const base = path.basename(folder);
          if (base) {
            if (!basenameToPath.has(base)) basenameToPath.set(base, folder);
            else if (basenameToPath.get(base) !== folder) basenameToPath.set(base, null);
          }
        }
      } catch {
        // Ignore malformed workspace.json.
      }
    }
  } catch {
    // Missing workspaceStorage is fine.
  }
  const result = { slugToPath, basenameToPath };
  cache.set(key, result);
  return result;
}

async function resolveCursorSlugOnFs(slug, cache) {
  const key = `cursor-fs:${slug}`;
  if (cache.has(key)) return cache.get(key);
  const parts = slug.split('-').filter(Boolean);
  let budget = 256;
  const search = async (dir, index) => {
    if (index === parts.length) return dir;
    if (--budget < 0) return '';
    let entries;
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return ''; }
    const candidates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const encoded = encodeCursorSlug(entry.name);
      if (!encoded) continue;
      const segments = encoded.split('-');
      if (index + segments.length <= parts.length && segments.every((segment, offset) => segment === parts[index + offset])) {
        candidates.push({ name: entry.name, length: segments.length });
      }
    }
    candidates.sort((a, b) => b.length - a.length);
    for (const candidate of candidates) {
      const matched = await search(path.join(dir, candidate.name), index + candidate.length);
      if (matched) return matched;
    }
    return '';
  };
  const resolved = parts.length ? await search(path.parse(process.cwd()).root, 0) : '';
  const filtered = resolved && !resolved.includes(`.app${path.sep}Contents${path.sep}`) ? resolved : '';
  cache.set(key, filtered);
  return filtered;
}

async function resolveCursorDirectory(descriptor, session, cache) {
  if (session.directory) return resolveGitWorktreeRoot(session.directory, cache);
  const slug = cursorSlugFor(descriptor.path);
  if (!slug || slug === 'empty-window') return '';

  const defaultCursorProjects = path.resolve(process.env.CURSOR_DATA_DIR || path.join(os.homedir(), '.cursor'), 'projects');
  const resolvedFile = path.resolve(descriptor.path);
  const isDefaultCursor = isWithin(resolvedFile, defaultCursorProjects);
  const cursorUserDir = descriptor.cursorUserDir ?? cache.get('cursorUserDir') ?? (isDefaultCursor ? defaultCursorUserDir() : '');
  const workspaces = cursorUserDir ? await loadCursorWorkspaces(cursorUserDir, cache) : { slugToPath: new Map(), basenameToPath: new Map() };

  const collapseCursorWorktree = async (candidate) => {
    const worktreeRoot = await resolveGitWorktreeRoot(candidate, cache);
    if (worktreeRoot !== candidate) return worktreeRoot;
    const worktreeMatch = candidate.match(/[/\\]\.cursor[/\\]worktrees[/\\]([^/\\]+)[/\\][^/\\]+$/);
    if (worktreeMatch) {
      const byName = workspaces.basenameToPath.get(worktreeMatch[1]);
      if (byName) return byName;
    }
    return candidate;
  };

  const fromWorkspace = workspaces.slugToPath.get(slug);
  if (fromWorkspace) return collapseCursorWorktree(fromWorkspace);

  const fromFs = await resolveCursorSlugOnFs(slug, cache);
  if (fromFs) return collapseCursorWorktree(fromFs);

  const slugWorktreeMatch = slug.match(/-cursor-worktrees-(.+)-[^-]+$/);
  if (slugWorktreeMatch) {
    const byName = workspaces.basenameToPath.get(slugWorktreeMatch[1]);
    if (byName) return byName;
  }
  return '';
}

export async function enrichSessionMetadata(descriptor, session, entries = [], cache = new Map()) {
  if (descriptor.source === 'codex') {
    const codexHome = codexHomeFor(descriptor.path);
    if (codexHome) {
      const meta = await loadCodexMetadata(codexHome, cache);
      const summarizedTitle = meta.titles.get(session.id);
      if (summarizedTitle) session.title = summarizedTitle.slice(0, 200);
      const gitOriginUrl = extractCodexGitOriginUrl(entries);
      session.directory = await resolveCodexDirectory(session, meta, codexHome, gitOriginUrl, cache);
      return session;
    }
  } else if (descriptor.source === 'cursor') {
    session.directory = await resolveCursorDirectory(descriptor, session, cache);
    return session;
  }

  if (session.directory) {
    session.directory = await resolveGitWorktreeRoot(session.directory, cache);
  }
  return session;
}
