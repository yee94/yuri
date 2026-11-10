import { substituteCommandVariables } from '@/lib/yuriConfig';
import type { WorktreeMetadata } from '@/types/worktree';
import {
  deleteRemoteBranch,
  git,
  resolveGitPrimaryRoot,
} from '@/lib/gitApi';
import {
  clearWorktreeBootstrapState,
  getWorktreeBootstrapState,
  markWorktreeBootstrapPending,
  setWorktreeBootstrapState,
  startWorktreeBootstrapWatcher,
} from '@/lib/worktrees/worktreeBootstrap';
import { invalidateResolvedProjectRootCache } from '@/lib/worktrees/worktreeStatus';
import type {
  CreateGitWorktreePayload,
  GitWorktreeBootstrapStatus,
  GitWorktreeValidationResult,
} from '@/lib/api/types';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionWorktreeStore } from '@/sync/session-worktree-store';
import { getRuntimeGeneration, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { scopeProjectWorktrees } from './projectWorktreeScope';
import { invalidateGitWorktreesCache } from '@/lib/gitApiHttp';

type WorktreeListEntry = {
  path?: string;
  branch?: string;
  head?: string;
  name?: string;
};

const deriveHeadStateFromWorktreeEntry = (entry: WorktreeListEntry): 'branch' | 'detached' | 'unborn' => {
  const branch = (entry.branch || '').trim();
  const head = (entry.head || '').trim();
  if (!branch) {
    if (!head) return 'unborn';
    return 'detached';
  }
  return 'branch';
};

const deriveCanonicalWorktreeFields = (
  entry: WorktreeListEntry,
  worktreePath: string,
): Pick<WorktreeMetadata, 'worktreeRoot' | 'worktreeStatus' | 'headState' | 'worktreeSource'> => {
  return {
    worktreeRoot: worktreePath,
    worktreeStatus: 'ready',
    headState: deriveHeadStateFromWorktreeEntry(entry),
    worktreeSource: 'existing',
  };
};

export type ProjectRef = { id: string; path: string };
export type WorktreeCatalogRefreshResult = { worktrees: WorktreeMetadata[]; addedDirectories: string[]; removedDirectories: string[]; repositoryDirectory?: string };

const normalizePath = (value: string): string => {
  const replaced = value.replace(/\\/g, '/');
  if (replaced === '/') {
    return '/';
  }
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

const slugifyWorktreeName = (value: string): string => {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '')
    .split('/').join('-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
};

const normalizeBranchName = (value: string): string => {
  return value
    .trim()
    .replace(/^refs\/heads\//, '')
    .replace(/^heads\//, '')
    .replace(/\s+/g, '-')
    .replace(/^\/+|\/+$/g, '');
};

const setStoredWorktreeStatus = (directory: string, status: NonNullable<WorktreeMetadata['worktreeStatus']>): void => {
  const target = normalizePath(directory);
  if (!target) {
    return;
  }

  useSessionUIStore.setState((state) => {
    let changed = false;

    const applyStatus = (metadata: WorktreeMetadata): WorktreeMetadata => {
      if ((normalizePath(metadata.path) !== target && normalizePath(metadata.worktreeRoot ?? metadata.path) !== target)
        || metadata.worktreeStatus === status) {
        return metadata;
      }
      changed = true;
      return { ...metadata, worktreeStatus: status };
    };

    let availableWorktrees = state.availableWorktrees;
    let availableWorktreesChanged = false;
    const nextAvailableWorktrees = state.availableWorktrees.map((metadata) => {
      const next = applyStatus(metadata);
      if (next !== metadata) {
        availableWorktreesChanged = true;
      }
      return next;
    });
    if (availableWorktreesChanged) {
      availableWorktrees = nextAvailableWorktrees;
    }
    let availableWorktreesByProject = state.availableWorktreesByProject;
    for (const [projectKey, entries] of state.availableWorktreesByProject) {
      let projectChanged = false;
      const nextEntries = entries.map((metadata) => {
        const next = applyStatus(metadata);
        if (next !== metadata) {
          projectChanged = true;
        }
        return next;
      });
      if (projectChanged) {
        if (availableWorktreesByProject === state.availableWorktreesByProject) {
          availableWorktreesByProject = new Map(state.availableWorktreesByProject);
        }
        availableWorktreesByProject.set(projectKey, nextEntries);
      }
    }

    let worktreeMetadata = state.worktreeMetadata;
    for (const [sessionId, metadata] of state.worktreeMetadata) {
      const next = applyStatus(metadata);
      if (next !== metadata) {
        if (worktreeMetadata === state.worktreeMetadata) {
          worktreeMetadata = new Map(state.worktreeMetadata);
        }
        worktreeMetadata.set(sessionId, next);
      }
    }

    if (!changed) {
      return {};
    }

    return {
      availableWorktrees,
      availableWorktreesByProject,
      worktreeMetadata,
    };
  });
};

const getWorktreeStatusFromBootstrap = (status?: GitWorktreeBootstrapStatus): WorktreeMetadata['worktreeStatus'] => {
  if (status?.status === 'pending') {
    return 'pending';
  }
  return status?.status === 'failed' ? 'invalid' : 'ready';
};

const deriveSdkWorktreeNameFromDirectory = (directory: string): string => {
  const normalized = normalizePath(directory);
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
};

const buildSdkStartCommand = (args: {
  projectDirectory: string;
  setupCommands: string[];
}): string | undefined => {
  const commands: string[] = [];

  for (const raw of args.setupCommands) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    commands.push(
      substituteCommandVariables(trimmed, { rootWorktreePath: args.projectDirectory })
    );
  }

  const joined = commands.filter(Boolean).join(' && ');
  return joined.trim().length > 0 ? joined : undefined;
};

const toCreatePayload = (args: {
  preferredName?: string;
  setupCommands?: string[];
  mode?: 'new' | 'existing';
  worktreeName?: string;
  branchName?: string;
  existingBranch?: string;
  startRef?: string;
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  returnAfterDirectoryCreated?: boolean;
}, projectDirectory: string): CreateGitWorktreePayload => {
  const mode = args.mode === 'existing' ? 'existing' : 'new';

  const worktreeNameSeed = args.worktreeName ?? args.preferredName ?? '';
  const worktreeName = slugifyWorktreeName(worktreeNameSeed);

  const branchNameSeed = args.branchName ?? (mode === 'new' ? args.preferredName : undefined) ?? '';
  const branchName = normalizeBranchName(branchNameSeed);

  const existingBranch = normalizeBranchName(args.existingBranch ?? args.branchName ?? '');
  const startRef = (args.startRef || '').trim();

  const commands = Array.isArray(args.setupCommands) ? args.setupCommands : [];
  const startCommand = buildSdkStartCommand({
    projectDirectory,
    setupCommands: commands,
  });

  return {
    mode,
    ...(worktreeName ? { worktreeName } : {}),
    ...(branchName ? { branchName } : {}),
    ...(existingBranch ? { existingBranch } : {}),
    ...(startRef ? { startRef } : {}),
    ...(startCommand ? { startCommand } : {}),
    ...(args.setUpstream ? { setUpstream: true } : {}),
    ...(args.upstreamRemote ? { upstreamRemote: args.upstreamRemote } : {}),
    ...(args.upstreamBranch ? { upstreamBranch: args.upstreamBranch } : {}),
    ...(args.ensureRemoteName ? { ensureRemoteName: args.ensureRemoteName } : {}),
    ...(args.ensureRemoteUrl ? { ensureRemoteUrl: args.ensureRemoteUrl } : {}),
    ...(args.returnAfterDirectoryCreated ? { returnAfterDirectoryCreated: true } : {}),
  };
};

/**
 * Compare two worktree-by-project maps for equality.
 * Compares discovery-owned metadata (not reference equality)
 * because readStableProjectWorktrees creates new object instances on
 * each call, making reference checks always report changed.
 *
 * `branch` is included so an external `git checkout` between
 * discoveries — which changes `branch` (and the derived `label`
 * and `headState`) while leaving `path` unchanged — still triggers
 * a store update. Without this, the branch label in the sidebar
 * could go stale until the next worktree create/remove or project
 * switch, since there is no periodic worktree-list refresh.
 *
 * Status changes (`worktreeStatus`) are not compared here: those
 * flow through `setStoredWorktreeStatus`, which writes a new Map
 * reference that the persist subscriber picks up directly.
 *
 */
export const worktreeMapsEqual = (
  a: Map<string, WorktreeMetadata[]>,
  b: Map<string, WorktreeMetadata[]>,
): boolean => {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) {
    const existing = b.get(key);
    if (!existing || existing.length !== value.length) return false;
    for (let i = 0; i < value.length; i++) {
      const next = value[i];
      const current = existing[i];
      if (next.path !== current.path
        || next.branch !== current.branch
        || next.name !== current.name
        || next.label !== current.label
        || next.projectDirectory !== current.projectDirectory
        || next.worktreeRoot !== current.worktreeRoot
        || next.headState !== current.headState
        || next.worktreeSource !== current.worktreeSource
        || next.source !== current.source) return false;
    }
  }
  return true;
};

// Cache worktree listings to avoid repeated git worktree list + rev-parse calls
const _worktreeListCache = new Map<string, { value: WorktreeMetadata[]; at: number }>();
const _worktreeListInflight = new Map<string, Promise<WorktreeMetadata[]>>();
const _worktreeListGeneration = new Map<string, number>();
const _worktreeRepositories = new Map<string, string>();
const repositoryGenerations = new Map<string, number>();
const refreshListings = new WeakMap<object, Map<string, { generation: number; value: Promise<WorktreeListEntry[]> }>>();
const WORKTREE_LIST_CACHE_TTL = 30_000; // 30 seconds
let cacheRuntime = '';
const worktreeRuntimeIdentity = (): string => {
  const identity = `${getRuntimeGeneration()}\u0000${getRuntimeTransportIdentity()}`;
  if (identity !== cacheRuntime) {
    cacheRuntime = identity;
    _worktreeListCache.clear();
    _worktreeListInflight.clear();
    _worktreeListGeneration.clear();
    _worktreeRepositories.clear();
    repositoryGenerations.clear();
  }
  return identity;
};
const worktreeCacheKey = (projectDirectory: string): string => `${worktreeRuntimeIdentity()}\u0000${normalizePath(projectDirectory)}`;

const getWorktreeListGeneration = (projectDirectory: string, cacheKey = worktreeCacheKey(projectDirectory)): number => {
  return _worktreeListGeneration.get(cacheKey) ?? 0;
};

const invalidateProjectWorktreeCatalog = (projectDirectory: string): void => {
  const key = worktreeCacheKey(projectDirectory);
  const repository = _worktreeRepositories.get(key) ?? normalizePath(projectDirectory);
  const repositoryKey = worktreeCacheKey(repository);
  repositoryGenerations.set(repositoryKey, (repositoryGenerations.get(repositoryKey) ?? 0) + 1);
  const keys = new Set([key, repositoryKey]);
  for (const [candidate, root] of _worktreeRepositories) {
    if (candidate.startsWith(`${worktreeRuntimeIdentity()}\u0000`) && root === repository) keys.add(candidate);
  }
  for (const candidate of keys) {
    _worktreeListGeneration.set(candidate, (_worktreeListGeneration.get(candidate) ?? 0) + 1);
    _worktreeListCache.delete(candidate);
  }
  invalidateGitWorktreesCache(repository);
  if (normalizePath(projectDirectory) !== repository) invalidateGitWorktreesCache(projectDirectory);
};

const readProjectWorktrees = async (projectDirectory: string, identity: string, refreshBatch?: object): Promise<WorktreeMetadata[]> => {
  const metadataProjectDirectory = normalizePath(await resolveGitPrimaryRoot(projectDirectory));
  const normalizedProjectDirectory = normalizePath(projectDirectory);

  const repositoryKey = `${identity}\u0000${metadataProjectDirectory}`;
  let listings = refreshBatch && refreshListings.get(refreshBatch);
  if (refreshBatch && !listings) {
    listings = new Map();
    refreshListings.set(refreshBatch, listings);
  }
  if (refreshBatch && !listings?.has(repositoryKey) && identity === worktreeRuntimeIdentity()) {
    invalidateProjectWorktreeCatalog(metadataProjectDirectory);
  }
  const generation = repositoryGenerations.get(repositoryKey) ?? 0;
  let listing = listings?.get(repositoryKey);
  if (!listing || listing.generation !== generation) {
    if (refreshBatch && listing) invalidateGitWorktreesCache(metadataProjectDirectory);
    listing = { generation, value: git.worktree.list(metadataProjectDirectory) };
    listings?.set(repositoryKey, listing);
  }
  const worktrees = await listing.value;
  if (identity === worktreeRuntimeIdentity()) _worktreeRepositories.set(`${identity}\u0000${projectDirectory}`, metadataProjectDirectory);
  const results: WorktreeMetadata[] = worktrees
    .filter((entry): entry is WorktreeListEntry & { path: string } => typeof entry.path === 'string' && entry.path.trim().length > 0)
    .map((entry) => {
      const worktreePath = normalizePath(entry.path);
      const branch = (entry.branch || '').replace(/^refs\/heads\//, '').trim();
      const name = (entry.name || '').trim();

      // Derive canonical worktree metadata from worktree list entry
      const canonical = deriveCanonicalWorktreeFields(entry, worktreePath);

      return {
        source: 'sdk' as const,
        name: name || deriveSdkWorktreeNameFromDirectory(worktreePath),
        path: worktreePath,
        projectDirectory: metadataProjectDirectory,
        branch: branch,
        label: branch || name || deriveSdkWorktreeNameFromDirectory(worktreePath),
        worktreeRoot: canonical.worktreeRoot,
        worktreeStatus: canonical.worktreeStatus,
        headState: canonical.headState,
        worktreeSource: canonical.worktreeSource,
      };
    });

  return scopeProjectWorktrees(normalizedProjectDirectory, results).sort((a, b) => {
    const aLabel = (a.label || a.branch || a.path).toLowerCase();
    const bLabel = (b.label || b.branch || b.path).toLowerCase();
    return aLabel.localeCompare(bLabel);
  });
};

const readStableProjectWorktrees = async (projectDirectory: string, cacheKey: string, identity: string, refreshBatch?: object): Promise<WorktreeMetadata[]> => {
  while (true) {
    const generation = getWorktreeListGeneration(projectDirectory, cacheKey);
    const worktrees = await readProjectWorktrees(projectDirectory, identity, refreshBatch);
    if (identity !== worktreeRuntimeIdentity()) return worktrees;

    if (generation === getWorktreeListGeneration(projectDirectory, cacheKey)) {
      _worktreeListCache.set(cacheKey, { value: worktrees, at: Date.now() });
      return worktrees;
    }
  }
};

export async function listProjectWorktrees(project: ProjectRef, refreshBatch?: object): Promise<WorktreeMetadata[]> {
  const projectDirectory = normalizePath(project.path);
  const identity = worktreeRuntimeIdentity();

  // Return cached if fresh
  const cacheKey = `${identity}\u0000${projectDirectory}`;
  const cached = _worktreeListCache.get(cacheKey);
  if (cached && Date.now() - cached.at < WORKTREE_LIST_CACHE_TTL) {
    return cached.value;
  }

  // Dedup in-flight requests
  const inflight = _worktreeListInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = readStableProjectWorktrees(projectDirectory, cacheKey, identity, refreshBatch).finally(() => {
    if (_worktreeListInflight.get(cacheKey) === promise) {
      _worktreeListInflight.delete(cacheKey);
    }
  });

  _worktreeListInflight.set(cacheKey, promise);
  return promise;
}

const preserveOperationalStatus = (worktree: WorktreeMetadata, existing?: WorktreeMetadata): WorktreeMetadata => {
  const bootstrap = getWorktreeBootstrapState(worktree.worktreeRoot ?? worktree.path);
  const status = bootstrap?.status === 'pending' ? 'pending' : bootstrap?.status === 'failed' ? 'invalid' : existing?.worktreeStatus;
  return status && status !== worktree.worktreeStatus ? { ...worktree, worktreeStatus: status } : worktree;
};

const cleanupRemovedWorktreeDirectories = (directories: Iterable<string>): void => {
  const removed = new Set([...directories].map(normalizePath));
  if (removed.size === 0) return;
  const currentMetadata = useSessionUIStore.getState().worktreeMetadata;
  const worktreeMetadata = new Map(currentMetadata);
  for (const [sessionId, metadata] of currentMetadata) {
    if (removed.has(normalizePath(metadata.path))) worktreeMetadata.delete(sessionId);
  }
  for (const [sessionId, attachment] of useSessionWorktreeStore.getState().attachments) {
    const root = typeof attachment.worktreeRoot === 'string' && attachment.worktreeRoot.trim() ? normalizePath(attachment.worktreeRoot) : '';
    const cwd = typeof attachment.cwd === 'string' && attachment.cwd.trim() ? normalizePath(attachment.cwd) : '';
    if ((root && removed.has(root)) || (cwd && removed.has(cwd))) {
      useSessionWorktreeStore.getState().clearAttachment(sessionId);
    }
  }
  if (worktreeMetadata.size !== currentMetadata.size) useSessionUIStore.setState({ worktreeMetadata });
};

export async function forceRefreshProjectWorktreeCatalog(
  project: ProjectRef,
  options: { isCurrent?: () => boolean; refreshBatch?: object } = {},
): Promise<WorktreeCatalogRefreshResult> {
  const projectDirectory = normalizePath(project.path);
  const key = worktreeCacheKey(projectDirectory);
  _worktreeListGeneration.set(key, getWorktreeListGeneration(projectDirectory) + 1);
  _worktreeListCache.delete(key);
  _worktreeListInflight.delete(key);
  const worktrees = await listProjectWorktrees({ ...project, path: projectDirectory }, options.refreshBatch ?? {});
  const repositoryDirectory = _worktreeRepositories.get(key);
  if (options.isCurrent && !options.isCurrent()) {
    return { worktrees, addedDirectories: [], removedDirectories: [], repositoryDirectory };
  }
  let finalWorktrees: WorktreeMetadata[] = worktrees;
  let addedDirectories: string[] = [];
  let removedDirectories: string[] = [];
  useSessionUIStore.setState((state) => {
    const current = state.availableWorktreesByProject;
    const currentEntries = scopeProjectWorktrees(projectDirectory, current.get(projectDirectory) ?? []);
    const previousByPath = new Map(currentEntries.map((entry) => [normalizePath(entry.path), entry]));
    const next = worktrees.map((entry) => preserveOperationalStatus(entry, previousByPath.get(normalizePath(entry.path))));
    const nextPaths = new Set(next.map((entry) => normalizePath(entry.path)));
    addedDirectories = next.filter((entry) => !previousByPath.has(normalizePath(entry.path))).map((entry) => entry.path);
    removedDirectories = currentEntries.filter((entry) => !nextPaths.has(normalizePath(entry.path))).map((entry) => entry.path);
    finalWorktrees = next;
    const unchanged = currentEntries.length === next.length && currentEntries.every((entry, index) => {
      const candidate = next[index];
      return candidate
        && entry.path === candidate.path && entry.branch === candidate.branch && entry.name === candidate.name
        && entry.label === candidate.label && entry.projectDirectory === candidate.projectDirectory
        && entry.worktreeRoot === candidate.worktreeRoot && entry.headState === candidate.headState
        && entry.worktreeSource === candidate.worktreeSource && entry.source === candidate.source
        && entry.worktreeStatus === candidate.worktreeStatus;
    });
    if (unchanged && currentEntries.every((entry, index) => entry === current.get(projectDirectory)?.[index])
      && currentEntries.length === (current.get(projectDirectory)?.length ?? 0)) return {};
    const byProject = new Map(current);
    byProject.set(projectDirectory, next);
    const availableWorktrees = [...byProject.values()].flat();
    return { availableWorktreesByProject: byProject, availableWorktrees };
  });
  cleanupRemovedWorktreeDirectories(removedDirectories);
  return { worktrees: finalWorktrees, addedDirectories, removedDirectories, repositoryDirectory };
}

export type CreateWorktreeArgs = {
  preferredName?: string;
  setupCommands?: string[];
  mode?: 'new' | 'existing';
  worktreeName?: string;
  branchName?: string;
  existingBranch?: string;
  startRef?: string;
  setUpstream?: boolean;
  upstreamRemote?: string;
  upstreamBranch?: string;
  ensureRemoteName?: string;
  ensureRemoteUrl?: string;
  returnAfterDirectoryCreated?: boolean;
};

export async function createWorktree(project: ProjectRef, args: CreateWorktreeArgs): Promise<WorktreeMetadata> {
  const projectDirectory = normalizePath(project.path);
  const metadataProjectDirectory = normalizePath(await resolveGitPrimaryRoot(projectDirectory));
  _worktreeRepositories.set(worktreeCacheKey(projectDirectory), metadataProjectDirectory);
  const checkoutEntries = projectDirectory === normalizePath(metadataProjectDirectory)
    ? [] : await git.worktree.list(metadataProjectDirectory);
  const payload = toCreatePayload(args, projectDirectory);

  const created = await git.worktree.create(projectDirectory, payload);
  const returnedName = typeof created?.name === 'string' ? created.name : '';
  const returnedBranch = typeof created?.branch === 'string' ? created.branch : '';
  const returnedPath = typeof created?.path === 'string' ? created.path : '';

  if (!returnedName || !returnedPath) {
    throw new Error('Worktree create missing name/path');
  }

  const createdMetadata: WorktreeMetadata = {
    source: 'sdk',
    name: returnedName,
    path: normalizePath(returnedPath),
    projectDirectory: metadataProjectDirectory,
    branch: returnedBranch,
    label: returnedBranch || returnedName,
    worktreeRoot: normalizePath(returnedPath),
    worktreeStatus: getWorktreeStatusFromBootstrap(created?.bootstrapStatus),
    headState: returnedBranch ? 'branch' : 'unborn',
    worktreeSource: 'created-for-session',
  };
  const metadata = scopeProjectWorktrees(projectDirectory, [
    ...checkoutEntries.filter((entry) => Boolean(entry.path)).map((entry) => ({
      path: entry.path!, worktreeRoot: entry.path!, projectDirectory: metadataProjectDirectory,
      branch: entry.branch ?? '', label: entry.branch ?? '',
    })),
    createdMetadata,
  ]).find((entry) => entry.worktreeRoot === createdMetadata.worktreeRoot) ?? createdMetadata;
  const worktreeRoot = metadata.worktreeRoot ?? metadata.path;

  if (created?.bootstrapStatus) {
    setWorktreeBootstrapState(worktreeRoot, created.bootstrapStatus);
  } else {
    markWorktreeBootstrapPending(worktreeRoot);
  }
  startWorktreeBootstrapWatcher(worktreeRoot, {
    onFailed: () => setStoredWorktreeStatus(worktreeRoot, 'invalid'),
    onReady: () => setStoredWorktreeStatus(worktreeRoot, 'ready'),
  });

  invalidateProjectWorktreeCatalog(projectDirectory);
  // The new worktree changes the repo's worktree topology; drop cached root
  // resolutions so root-branch lookups re-resolve against the new layout.
  invalidateResolvedProjectRootCache();

  // Update sidebar store so new worktree appears immediately
  const sidebarProjectKey = projectDirectory;
  useSessionUIStore.setState((state) => {
    const byProject = new Map(state.availableWorktreesByProject);
    const existing = byProject.get(sidebarProjectKey) ?? [];
    byProject.set(sidebarProjectKey, [...existing.filter((entry) => normalizePath(entry.path) !== metadata.path), metadata]);
    return { availableWorktreesByProject: byProject, availableWorktrees: [...byProject.values()].flat() };
  });

  return metadata;
}

export async function validateWorktreeCreate(project: ProjectRef, args: CreateWorktreeArgs): Promise<GitWorktreeValidationResult> {
  const projectDirectory = project.path;
  const payload = toCreatePayload(args, projectDirectory);
  return git.worktree.validate(projectDirectory, payload);
}

export async function removeProjectWorktree(project: ProjectRef, worktree: WorktreeMetadata, options?: {
  deleteRemoteBranch?: boolean;
  deleteLocalBranch?: boolean;
  remoteName?: string;
}): Promise<void> {
  const projectDirectory = normalizePath(project.path);

  const deleteRemote = Boolean(options?.deleteRemoteBranch);
  const deleteLocalBranch = options?.deleteLocalBranch === true;
  const remoteName = options?.remoteName;
  const raw = await git.worktree.remove(projectDirectory, {
    directory: worktree.worktreeRoot ?? worktree.path,
    deleteLocalBranch,
  });
  if (!raw?.success) {
    throw new Error('Worktree removal failed');
  }

  clearWorktreeBootstrapState(worktree.worktreeRoot ?? worktree.path);

  invalidateProjectWorktreeCatalog(normalizePath(project.path));
  // Removing a worktree changes the repo's worktree topology; drop cached root
  // resolutions so root-branch lookups re-resolve against the new layout.
  invalidateResolvedProjectRootCache();

  // Update sidebar store so removed worktree disappears immediately
  const normalizedWorktreePath = normalizePath(worktree.worktreeRoot ?? worktree.path);
  const currentByProject = useSessionUIStore.getState().availableWorktreesByProject;
  const updatedByProject = new Map(currentByProject);
  const removedDirectories = new Set([normalizedWorktreePath, normalizePath(worktree.path)]);
  for (const [projectKey, entries] of currentByProject) {
    const next = entries.filter((entry) => {
      if (normalizePath(entry.worktreeRoot ?? entry.path) !== normalizedWorktreePath) return true;
      removedDirectories.add(normalizePath(entry.path));
      return false;
    });
    if (next.length === entries.length) continue;
    updatedByProject.set(projectKey, next);
    invalidateProjectWorktreeCatalog(projectKey);
  }

  cleanupRemovedWorktreeDirectories(removedDirectories);

  useSessionUIStore.setState({
    availableWorktreesByProject: updatedByProject,
    availableWorktrees: useSessionUIStore.getState().availableWorktrees.filter(
      (w) => normalizePath(w.worktreeRoot ?? w.path) !== normalizedWorktreePath,
    ),
  });

  const branchName = (worktree.branch || '').replace(/^refs\/heads\//, '').trim();
  if (deleteRemote && branchName) {
    await deleteRemoteBranch(projectDirectory, { branch: branchName, remote: remoteName }).catch(() => undefined);
  }
}
