import type { GitAPI } from './api/types';
import type { HostRuntimeEntry } from './remote-projects/registry';
import { captureProjectScope } from './api/project-scope';

/** Explicit transport, no global runtime bridge or directory-only discovery cache. */
export const createProjectGitAPI = (entry: HostRuntimeEntry): GitAPI => {
  const scope = captureProjectScope(entry);
  const get = <T>(route: string, directory: string, query: Record<string, string | number | undefined> = {}, signal?: AbortSignal) =>
    scope.json<T>(`/api/git/${route}`, { query: { directory, ...query }, headers: { 'x-opencode-directory': directory }, signal });
  const write = <T>(route: string, directory: string, body: unknown, method = 'POST') =>
    scope.json<T>(`/api/git/${route}`, { method, query: { directory },
      headers: { 'Content-Type': 'application/json', 'x-opencode-directory': directory }, body: JSON.stringify(body) });
  const stage = async (directory: string, paths: string[], unstage = false) => {
    await write(unstage ? 'unstage' : 'stage', directory, { paths });
  };
  const hunk = async (directory: string, path: string, patch: string, action: 'stage' | 'unstage' | 'discard') => {
    await write('apply-hunk', directory, { path, patch, action });
  };
  const readOnlyIdentity = async (): Promise<never> => {
    throw new Error('Remote machine configuration is read-only. Switch to that instance to modify Git identities.');
  };
  return {
    checkIsGitRepository: async (directory) => (await get<{ isGitRepository: boolean }>('check', directory)).isGitRepository,
    getGitStatus: (directory, options) => get('status', directory, { mode: options?.mode }),
    getGitDiff: (directory, options) => get('diff', directory, { path: options.path, staged: options.staged ? 'true' : undefined, context: options.contextLines }),
    getGitFileDiff: (directory, options) => get('file-diff', directory, { path: options.path, staged: options.staged ? 'true' : undefined }),
    getGitBranches: (directory, options) => get('branches', directory, {}, options?.signal),
    getRemotes: (directory, options) => get('remotes', directory, {}, options?.signal),
    listGitWorktrees: (directory) => get('worktrees', directory),
    isLinkedWorktree: async (directory) => (await get<{ linked: boolean }>('worktree-type', directory)).linked,
    stageGitFile: (directory, path) => stage(directory, [path]),
    stageGitFiles: (directory, paths) => stage(directory, paths),
    unstageGitFile: (directory, path) => stage(directory, [path], true),
    unstageGitFiles: (directory, paths) => stage(directory, paths, true),
    revertGitFile: async (directory, path, options) => { await write('revert', directory, { path, ...options }); },
    createGitCommit: (directory, message, options) => write('commit', directory, { message, ...options }),
    gitPush: (directory, options = {}) => write('push', directory, options),
    gitPull: (directory, options = {}) => write('pull', directory, options),
    gitFetch: (directory, options = {}) => write('fetch', directory, options),
    checkoutBranch: (directory, branch) => write('checkout', directory, { branch }),
    createBranch: (directory, name, startPoint) => write('branches', directory, { name, startPoint }),
    deleteGitBranch: (directory, payload) => write('branches', directory, payload, 'DELETE'),
    getGitLog: (directory, options = {}) => get('log', directory, { ...options, all: options.all ? 'true' : undefined }),
    getCommitFiles: (directory, hash) => get('commit-files', directory, { hash }),
    stageGitHunk: (directory, path, patch) => hunk(directory, path, patch, 'stage'),
    unstageGitHunk: (directory, path, patch) => hunk(directory, path, patch, 'unstage'),
    revertGitHunk: (directory, path, patch) => hunk(directory, path, patch, 'discard'),
    deleteRemoteBranch: (directory, payload) => write('remote-branches', directory, payload, 'DELETE'),
    removeRemote: (directory, payload) => write('remotes', directory, payload, 'DELETE'),
    generateCommitMessage: (directory, files, options) => {
      const { signal, ...selection } = options ?? {};
      return scope.json('/api/git/commit-message', { method: 'POST', query: { directory }, signal,
        headers: { 'Content-Type': 'application/json', 'x-opencode-directory': directory }, body: JSON.stringify({ files, ...selection }) });
    },
    generatePullRequestDescription: (directory, payload) => {
      const { signal, ...body } = payload;
      return scope.json('/api/git/pr-description', { method: 'POST', query: { directory }, signal,
        headers: { 'Content-Type': 'application/json', 'x-opencode-directory': directory }, body: JSON.stringify(body) });
    },
    validateGitWorktree: (directory, payload) => write('worktrees/validate', directory, payload),
    getGitWorktreeBootstrapStatus: (directory) => get('worktrees/bootstrap-status', directory),
    previewGitWorktree: (directory, payload) => write('worktrees/preview', directory, payload),
    createGitWorktree: (directory, payload) => write('worktrees', directory, payload),
    deleteGitWorktree: (directory, payload) => write('worktrees', directory, payload, 'DELETE'),
    listGitStashes: (directory) => get('stashes', directory),
    countGitStashFiles: (directory, refs) => write('stashes/file-counts', directory, { refs }),
    stashGitChanges: (directory, options = {}) => write('stash', directory, options),
    applyGitStash: (directory, options) => write('stash/apply', directory, options),
    popGitStash: (directory, options) => write('stash/pop', directory, options),
    dropGitStash: (directory, options) => write('stash/drop', directory, options),
    renameBranch: (directory, oldName, newName) => write('branches/rename', directory, { oldName, newName }),
    getCommitFileDiff: (directory, hash, path, isBinary) => get('commit-file-diff', directory, { hash, path, binary: isBinary ? 'true' : undefined }),
    getCurrentGitIdentity: (directory) => get('current-identity', directory),
    hasLocalIdentity: async (directory) => (await get<{ hasLocalIdentity: boolean }>('has-local-identity', directory)).hasLocalIdentity,
    getGitIdentities: () => get('identities', entry.location.directory),
    getGlobalGitIdentity: () => get('global-identity', entry.location.directory),
    setGitIdentity: readOnlyIdentity,
    createGitIdentity: readOnlyIdentity,
    updateGitIdentity: readOnlyIdentity,
    deleteGitIdentity: readOnlyIdentity,
    getRemoteUrl: async (directory, remote) => (await get<{ url: string | null }>('remote-url', directory, { remote })).url,
    rebase: (directory, options) => write('rebase', directory, options),
    abortRebase: (directory) => write('rebase/abort', directory, {}),
    continueRebase: (directory) => write('rebase/continue', directory, {}),
    merge: (directory, options) => write('merge', directory, options),
    abortMerge: (directory) => write('merge/abort', directory, {}),
    continueMerge: (directory) => write('merge/continue', directory, {}),
    checkoutCommit: (directory, hash) => write('checkout-commit', directory, { hash }),
    cherryPick: (directory, hash) => write('cherry-pick', directory, { hash }),
    revertCommit: (directory, hash) => write('revert-commit', directory, { hash }),
    resetToCommit: (directory, hash, mode, force) => write('reset-to-commit', directory, { hash, mode, force }),
    stash: async (directory, options) => { await write('stash', directory, options ?? {}); return { success: true }; },
    stashPop: async (directory) => { await write('stash/pop', directory, { ref: 'stash@{0}' }); return { success: true }; },
    getConflictDetails: (directory) => get('conflict-details', directory),
    validateWorktreeDirectory: (directory, worktreeRoot) => write('validate-directory', directory, { directory, worktreeRoot }),
    canonicalizeWorktreeState: (directory) => write('canonicalize-worktree-state', directory, { directory }),
  };
};
