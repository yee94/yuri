import { changesSnapshot, type ChangesSnapshot } from './chat-changes-model';
import { desktopPanelFilePath, type DesktopPanelScope } from './desktop-panel-model';
import type { RawNativeResponse } from './runtime';
import type { GitLogEntry } from '../ui/src/lib/api/types';
import { resourcePath } from './resources-model';
import { runtimeScopeFrom } from './runtime-scope';
import { splitPatchIntoHunks, extractHunkPatch } from './desktop-git-patch';
import { nativeMagicDefaults } from './settings-magic-defaults';
import { desktopGitWorktreeBlock, resolveDesktopGitWorktree, type DesktopGitWorktreeState } from './desktop-git-worktree-state';
import { identityFrom, profilesFrom, prFrom, prStatusFrom, prContextFrom, upstreamFrom, canonicalFrom, planFrom, integrationResultFrom, integrationDetailsFrom, generatedFrom,
  type GitIdentity, type GitProfile, type GitPRStatus, type GitPRContext, type GitUpstream, type GitCanonicalWorktree, type IntegratePlan, type IntegrateResult, type GitGenerated } from './desktop-git-protocol';

type RawRequest = (path: string, method?: string, body?: unknown) => Promise<RawNativeResponse>;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const failure = (error: unknown) => error instanceof Error ? error.message : String(error);
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('Invalid Git collection');
  return value;
}
type DesktopGitStatus = ChangesSnapshot & { isGitRepository: boolean | null; revision: string | null; oversized: boolean; operation: 'merge' | 'rebase' | null; operationDetail: string; conflicted: string[] };
export type DesktopGitCommit = GitLogEntry;
export type DesktopGitFile = { path: string; isBinary: boolean; changeType: string; insertions: number; deletions: number };
type DesktopGitStash = { ref: string; hash: string; message: string };
type Resources = {
  status: DesktopGitStatus;
  branches: { current: string; all: string[] };
  remotes: { name: string }[];
  stashes: DesktopGitStash[];
  log: { all: DesktopGitCommit[]; total: number };
  conflicts: { operation: string; headInfo: string; diff: string; unmergedFiles: string[] };
  repository: boolean;
  patch: { path: string; staged: boolean; patch: string; hunks: string[] };
  identity: GitIdentity;
  globalIdentity: GitIdentity;
  profiles: GitProfile[];
  pr: GitPRStatus;
  prContext: GitPRContext;
  upstream: GitUpstream;
  prBranches: { owner: string; repo: string; branches: string[] };
  worktree: GitCanonicalWorktree;
  primaryRoot: string;
  integrationPlan: IntegratePlan;
  integration: IntegrateResult;
  generated: GitGenerated;
};
type Resource = keyof Resources;
type GitResource<T> = { value: T | null; loading: boolean; error: string };
export type DesktopGitMutation =
  | { kind: 'stage' | 'unstage'; paths: string[] }
  | { kind: 'restore'; path: string; scope: 'all' | 'working'; confirmed: true }
  | { kind: 'commit'; message: string }
  | { kind: 'checkout'; branch: string }
  | { kind: 'branch'; name: string; startPoint?: string }
  | { kind: 'rename'; oldName: string; newName: string }
  | { kind: 'deleteBranch'; branch: string; confirmed: true }
  | { kind: 'fetch' | 'pull' | 'push'; remote?: string }
  | { kind: 'stash'; message: string }
  | { kind: 'stashApply' | 'stashPop'; ref: string }
  | { kind: 'stashDrop'; ref: string; confirmed: true }
  | { kind: 'merge' | 'rebase'; branch: string; confirmed: true }
  | { kind: 'mergeContinue' | 'rebaseContinue' }
  | { kind: 'mergeAbort' | 'rebaseAbort'; confirmed: true }
  | { kind: 'checkoutCommit' | 'cherryPick' | 'revertCommit'; hash: string; confirmed: true }
  | { kind: 'reset'; hash: string; mode: 'soft' | 'mixed' | 'hard'; confirmed: true };
export type DesktopGitExtendedMutation =
  | { kind: 'hunk'; path: string; staged: boolean; index: number; patch: string; action: 'stage' | 'unstage' | 'discard'; confirmed?: true }
  | { kind: 'identity'; profileId: string }
  | { kind: 'prCreate'; title: string; body: string; base: string; draft: boolean; remote?: string; headRemote?: string; targetRepo?: { owner: string; repo: string }; confirmed: true }
  | { kind: 'prUpdate'; number: number; title: string; body: string }
  | { kind: 'prReady'; number: number }
  | { kind: 'prMerge'; number: number; method: 'merge' | 'squash' | 'rebase'; confirmed: true }
  | { kind: 'integratePlan'; targetBranch: string; confirmed: true }
  | { kind: 'worktreeInspect'; confirmed: true }
  | { kind: 'integrateRun' | 'integrateContinue' | 'integrateAbort'; confirmed: true }
  | { kind: 'generateCommit' | 'generatePR'; system: string; prompt: string; expectedRevision?: number };
export type DesktopGitAction = DesktopGitMutation | DesktopGitExtendedMutation;

function statusFrom(value: unknown): DesktopGitStatus {
  const body = object(value), snapshot = changesSnapshot(value);
  const operation = body.rebaseInProgress ? 'rebase' : body.mergeInProgress ? 'merge' : null;
  const detail = object(operation === 'rebase' ? body.rebaseInProgress : body.mergeInProgress);
  return { ...snapshot, isGitRepository: typeof body.isGitRepository === 'boolean' ? body.isGitRepository : null, revision: typeof body.revision === 'string' ? body.revision : null, oversized: body.oversized === true, operation,
    operationDetail: [detail.headName, detail.onto, detail.head, detail.message].filter(part => typeof part === 'string').join(' · '),
    conflicted: Array.isArray(body.conflicted) ? strings(body.conflicted) : snapshot.files.filter(file => /U/.test(file.index + file.working_dir) || ['AA', 'DD'].includes(file.index + file.working_dir)).map(file => file.path) };
}
function commitsFrom(value: unknown): Resources['log'] {
  const body = object(value);
  if (!Array.isArray(body.all) || typeof body.total !== 'number') throw new Error('Invalid Git history');
  return { total: body.total, all: body.all.map(value => {
    const row = object(value);
    if (typeof row.hash !== 'string' || typeof row.message !== 'string') throw new Error('Invalid Git commit');
    return { hash: row.hash, message: row.message, date: String(row.date ?? ''), author_name: String(row.author_name ?? ''), refs: String(row.refs ?? ''), parents: Array.isArray(row.parents) ? strings(row.parents) : typeof row.parents === 'string' ? row.parents.split(' ').filter(Boolean) : [], body: String(row.body ?? ''), author_email: String(row.author_email ?? ''), filesChanged: Number(row.filesChanged ?? 0), insertions: Number(row.insertions ?? 0), deletions: Number(row.deletions ?? 0) };
  }) };
}

// The index is shared by every session in this Host+directory. Keep the lane
// through unmounts: an in-flight write/unknown receipt must not be bypassed by
// closing/reopening the rail. No request, credential or automatic retry lives here.
type Lane = { tail: Promise<unknown>; pending: number; unknown: string | null; generationUnknown?: string; revision: number; owners: number; listeners: Set<() => void>; integration?: IntegrateResult; worktree?: GitCanonicalWorktree };
const lanes = new Map<string, Lane>();
function laneFor(scope: DesktopPanelScope) {
  const key = JSON.stringify([scope.host.hostID, scope.authorityKey, scope.directory]);
  let lane = lanes.get(key);
  if (!lane) { lane = { tail: Promise.resolve(), pending: 0, unknown: null, revision: 0, owners: 0, listeners: new Set() }; lanes.set(key, lane); }
  lane.owners++;
  return { key, lane };
}

/** Page-owned pull snapshots. Authentication/Host fencing stay in bindRawRequest.
 * Every write is explicitly admitted by a user handler; errors never become empty
 * success and a lost/5xx acknowledgement blocks further writes until read+review. */
export function createDesktopGit(scope: DesktopPanelScope, raw: RawRequest, current: () => boolean, notify: () => void = () => {}, worktreeAttachment: () => DesktopGitWorktreeState | undefined = () => undefined) {
  const host = runtimeScopeFrom(scope.host);
  if (!host || !scope.authorityKey?.trim()) throw new Error('scope_required');
  const captured = { ...scope, directory: resourcePath(scope.directory), host }, { key, lane } = laneFor(captured);
  lane.listeners.add(notify);
  const notifyLane = () => { for (const listener of lane.listeners) listener(); };
  const suffix = `directory=${encodeURIComponent(captured.directory)}`;
  let alive = true, generation = 0, localPending = 0, mutationError = '', logCount = 25, logAll = false;
  const valid = () => alive && current();
  const resources: { [K in Resource]: GitResource<Resources[K]> } = {
    status: { value: null, loading: false, error: '' }, branches: { value: null, loading: false, error: '' }, remotes: { value: null, loading: false, error: '' },
    stashes: { value: null, loading: false, error: '' }, log: { value: null, loading: false, error: '' }, conflicts: { value: null, loading: false, error: '' },
    repository: { value: null, loading: false, error: '' },
    patch: { value: null, loading: false, error: '' }, identity: { value: null, loading: false, error: '' }, globalIdentity: { value: null, loading: false, error: '' }, profiles: { value: null, loading: false, error: '' },
    pr: { value: null, loading: false, error: '' }, prContext: { value: null, loading: false, error: '' }, worktree: { value: lane.worktree ?? null, loading: false, error: '' }, primaryRoot: { value: null, loading: false, error: '' },
    upstream: { value: null, loading: false, error: '' }, prBranches: { value: null, loading: false, error: '' },
    integrationPlan: { value: null, loading: false, error: '' }, integration: { value: lane.integration ?? null, loading: false, error: '' }, generated: { value: null, loading: false, error: '' },
  };
  const serials: Record<Resource, number> = { status: 0, branches: 0, remotes: 0, stashes: 0, log: 0, conflicts: 0, repository: 0, patch: 0, identity: 0, globalIdentity: 0, profiles: 0, pr: 0, prContext: 0, upstream: 0, prBranches: 0, worktree: 0, primaryRoot: 0, integrationPlan: 0, integration: 0, generated: 0 };
  const verified: Partial<Record<Resource, number>> = {};
  const route = (path: string) => `${path.startsWith('/api/') ? path : '/api/git/' + path}${path.includes('?') ? '&' : '?'}${suffix}`;
  async function read(path: string, method = 'GET', body?: unknown) {
    if (!valid()) throw new Error('Git scope superseded');
    const response = await raw(route(path), method, body);
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}: ${String(object(response.body).error || object(response.body).message || '')}`);
    return response.body;
  }
  async function load<K extends Resource>(resource: K, path: string, parse: (value: unknown) => Resources[K], method = 'GET', body?: unknown): Promise<boolean> {
    if (!valid()) return false;
    const serial = ++serials[resource], epoch = generation, writeRevision = lane.revision;
    resources[resource].loading = true; notify();
    try {
      const value = parse(await read(path, method, body));
      if (!valid() || serial !== serials[resource] || epoch !== generation || writeRevision !== lane.revision) return false;
      const priorOperation = resources.status.value?.operation, priorBranch = resources.status.value?.current, priorPR = resources.pr.value;
      const unchangedStatus = resource === 'status' && resources.status.value?.revision && object(value).revision === resources.status.value.revision;
      Object.assign(resources[resource], { value: unchangedStatus ? resources.status.value : value, loading: false, error: '' });
      if (resource === 'status') {
        const status = resources.status.value;
        if (status && status.current !== priorBranch) {
          for (const key of ['pr', 'prContext', 'prBranches', 'integrationPlan'] as const) { serials[key]++; Object.assign(resources[key], { value: null, error: '', loading: false }); }
        }
        if (status && (!status.operation && !status.conflicted.length || status.operation !== priorOperation)) {
          serials.conflicts++;
          Object.assign(resources.conflicts, { value: null, error: '', loading: false });
        }
      }
      if (resource === 'pr' && (resources.pr.value?.pr?.number !== priorPR?.pr?.number || resources.pr.value?.pr?.headSha !== priorPR?.pr?.headSha || resources.pr.value?.repo?.owner !== priorPR?.repo?.owner || resources.pr.value?.repo?.repo !== priorPR?.repo?.repo)) { serials.prContext++; Object.assign(resources.prContext, { value: null, error: '', loading: false }); }
      verified[resource] = writeRevision;
      return true;
    } catch (cause) {
      if (valid() && serial === serials[resource] && epoch === generation) resources[resource].error = failure(cause);
      return false;
    } finally {
      if (valid() && serial === serials[resource] && epoch === generation) { resources[resource].loading = false; notify(); }
    }
  }
  const refreshStatus = () => load('status', 'status', statusFrom);
  const refreshRepository = () => load('repository', 'check', value => {
    const body = object(value); if (typeof body.isGitRepository !== 'boolean') throw new Error('Invalid Git repository'); return body.isGitRepository;
  });
  const refreshBranches = () => load('branches', 'branches', value => {
    const body = object(value);
    if (typeof body.current !== 'string') throw new Error('Invalid Git branches');
    return { current: body.current, all: strings(body.all) };
  });
  const refreshRemotes = () => load('remotes', 'remotes', value => {
    if (!Array.isArray(value)) throw new Error('Invalid Git remotes');
    return value.map(value => { const row = object(value); if (typeof row.name !== 'string') throw new Error('Invalid Git remote'); return { name: row.name }; });
  });
  const refreshStashes = () => load('stashes', 'stashes', value => {
    const body = object(value);
    if (!Array.isArray(body.stashes)) throw new Error('Invalid Git stashes');
    return body.stashes.map(value => { const row = object(value); if (typeof row.ref !== 'string' || typeof row.message !== 'string') throw new Error('Invalid Git stash'); return { ref: row.ref, message: row.message, hash: String(row.hash ?? '') }; });
  });
  const refreshLog = (maxCount = logCount, all = logAll) => {
    logCount = Math.max(1, Math.trunc(maxCount)); logAll = all;
    return load('log', `log?maxCount=${logCount}&all=${logAll}`, commitsFrom);
  };
  const refreshConflicts = () => load('conflicts', 'conflict-details', value => {
    const body = object(value);
    if (typeof body.operation !== 'string' || typeof body.headInfo !== 'string' || typeof body.diff !== 'string') throw new Error('Invalid Git conflicts');
    return { operation: body.operation, headInfo: body.headInfo, diff: body.diff, unmergedFiles: strings(body.unmergedFiles) };
  });
  let selectedPatch: { path: string; staged: boolean } | null = null, prRemote = 'origin';
  const refreshPatch = (path = selectedPatch?.path ?? '', staged = selectedPatch?.staged ?? false) => {
    desktopPanelFilePath(captured.directory, path);
    if (selectedPatch?.path !== path || selectedPatch.staged !== staged) resources.patch.value = null;
    selectedPatch = { path, staged };
    return load('patch', `diff?path=${encodeURIComponent(path)}&staged=${staged}`, value => {
      const patch = object(value).diff; if (typeof patch !== 'string') throw new Error('Invalid Git patch');
      return { path, staged, patch, hunks: splitPatchIntoHunks(patch) };
    });
  };
  const refreshIdentities = () => Promise.all([
    load('identity', 'current-identity', identityFrom), load('profiles', 'identities', profilesFrom), load('globalIdentity', 'global-identity', identityFrom),
  ]);
  const refreshPrimaryRoot = () => load('primaryRoot', 'primary-root', value => resourcePath(String(object(value).root || '')));
  const refreshPR = (remote = prRemote) => {
    const branch = resources.status.value?.current;
    if (!branch) return Promise.resolve(false);
    if (prRemote !== remote) { resources.pr.value = null; resources.prContext.value = null; serials.prContext++; }
    prRemote = remote;
    return load('pr', `/api/github/pr/status?branch=${encodeURIComponent(branch)}&remote=${encodeURIComponent(remote)}&force=true`, value => {
      const result = prStatusFrom(value);
      if (resources.status.value?.current !== branch || result.branch && result.branch !== branch) throw new Error('Pull request branch superseded');
      return result;
    });
  };
  const refreshPRContext = () => {
    const snapshot = resources.pr.value, pr = snapshot?.pr;
    if (!pr) return Promise.resolve(false);
    const repo = snapshot?.repo;
    return load('prContext', `/api/github/pulls/context?number=${pr.number}&diff=true&checkDetails=true${repo ? '&owner=' + encodeURIComponent(repo.owner) + '&repo=' + encodeURIComponent(repo.repo) : ''}`, value => {
      const result = prContextFrom(value);
      if (!result.connected || !result.pr || result.pr.number !== pr.number || result.pr.head !== pr.head || result.pr.headSha !== pr.headSha) throw new Error('Pull request context superseded');
      return result;
    });
  };
  const refreshUpstream = () => load('upstream', '/api/github/repo/upstream', upstreamFrom);
  const refreshPRBranches = (repo: { owner: string; repo: string }) => {
    if (resources.prBranches.value?.owner !== repo.owner || resources.prBranches.value?.repo !== repo.repo) resources.prBranches.value = null;
    return load('prBranches', `/api/github/repo/branches?owner=${encodeURIComponent(repo.owner)}&repo=${encodeURIComponent(repo.repo)}`, value => ({ owner: repo.owner, repo: repo.repo, branches: strings(object(value).branches) }));
  };
  async function refreshIntegration() {
    const state = lane.integration?.kind === 'conflict' ? lane.integration.state : null;
    if (!state) return false;
    return load('integration', 'integrate/conflict-details', value => ({ kind: 'conflict', state, details: integrationDetailsFrom(value) }), 'POST', { tempWorktreePath: state.tempWorktreePath });
  }
  function cancel() { generation++; for (const resource of Object.keys(resources) as Resource[]) { serials[resource]++; resources[resource].loading = false; } notify(); }
  async function refresh() {
    return await Promise.all([refreshRepository(), refreshStatus(), refreshBranches(), refreshRemotes(),
      ...(resources.stashes.value !== null || lane.unknown?.startsWith('stash') ? [refreshStashes()] : []),
      ...(resources.log.value !== null || ['commit', 'cherryPick', 'revertCommit', 'reset'].includes(lane.unknown ?? '') ? [refreshLog()] : []),
      ...(resources.identity.value !== null || lane.unknown === 'identity' ? [refreshIdentities().then(results => results.every(Boolean))] : []),
      ...(resources.pr.value !== null || lane.unknown?.startsWith('pr') ? [refreshPR()] : []),
    ]);
  }
  function canAcknowledgeUnknown() {
    if (!valid() || lane.pending || !lane.unknown) return false;
    // No operation receipt/list endpoint can identify a lost temporary worktree
    // or reconstruct a paid generation result. Reading a clean status is not proof.
    if (lane.unknown.startsWith('integrate') || lane.unknown.startsWith('generate') || lane.unknown === 'worktreeInspect') return false;
    const required: Resource[] = ['repository', 'status', 'branches'];
    if (lane.unknown.startsWith('stash')) required.push('stashes');
    if (lane.unknown === 'commit' || ['cherryPick', 'revertCommit', 'reset'].includes(lane.unknown)) required.push('log');
    if (lane.unknown === 'identity') required.push('identity');
    if (lane.unknown.startsWith('pr')) required.push('pr');
    return resources.repository.value === true && required.every(key => verified[key] === lane.revision && !resources[key].error);
  }
  let attachmentRequired = false;
  const worktreeState = () => {
    const authority = worktreeAttachment();
    if (authority) attachmentRequired = true;
    return resolveDesktopGitWorktree(captured, authority, lane.worktree ?? resources.worktree.value, attachmentRequired);
  };
  const keepLane = () => lane.pending || lane.unknown || lane.generationUnknown || lane.owners || lane.integration?.kind === 'conflict' || lane.worktree && lane.worktree.worktreeStatus !== 'ready';
  function repositoryState(): 'unavailable' | 'pending' | 'not-a-repo' | 'ready' {
    if (resources.repository.error || resources.status.error || resources.repository.value === null || !resources.status.value) return 'unavailable';
    const state = worktreeState();
    if (state.pending) return 'pending';
    if (state.unavailable) return 'unavailable';
    if (resources.repository.value === false || resources.status.value.isGitRepository === false || state.attachment?.worktreeStatus === 'not-a-repo') return 'not-a-repo';
    return 'ready';
  }
  function blockingReason(kind: DesktopGitAction['kind']): string | null {
    if (kind === 'worktreeInspect') return null;
    // A failed check/status never becomes an authoritative not-a-repo screen.
    if (resources.repository.error || resources.status.error || resources.repository.value === null || !resources.status.value) return 'gitView.toast.refreshRepositoryFailed';
    const state = worktreeState();
    if (state.pending) return 'gitView.empty.worktreeSetupInProgress';
    if (resources.repository.value === false || resources.status.value.isGitRepository === false) return 'gitView.empty.notGitRepository';
    return desktopGitWorktreeBlock(kind, state, resources.status.value.operation);
  }
  function descriptor(action: DesktopGitAction): { path: string; method?: string; body: Record<string, unknown> } {
    const blocked = blockingReason(action.kind); if (blocked) throw new Error(blocked);
    const named = (value: string) => { const name = value.trim(); if (!name || name.startsWith('-') || /[\x00-\x1f]/.test(name)) throw new Error('Invalid Git reference'); return name; };
    if (['restore', 'deleteBranch', 'stashDrop', 'merge', 'rebase', 'mergeAbort', 'rebaseAbort', 'checkoutCommit', 'cherryPick', 'revertCommit', 'reset', 'prCreate', 'prMerge', 'integratePlan', 'integrateRun', 'integrateContinue', 'integrateAbort', 'worktreeInspect'].includes(action.kind) && (!('confirmed' in action) || action.confirmed !== true)) throw new Error('Confirmation required');
    switch (action.kind) {
      case 'stage': case 'unstage': {
        if (!action.paths.length) throw new Error('No Git paths');
        const paths = [...new Set(action.paths)]; paths.forEach(path => desktopPanelFilePath(captured.directory, path));
        return { path: action.kind, body: { paths } };
      }
      case 'restore': desktopPanelFilePath(captured.directory, action.path); return { path: 'revert', body: { path: action.path, scope: action.scope } };
      case 'hunk': {
        const source = resources.patch.value;
        if (!source || resources.patch.error || verified.patch !== lane.revision || source.path !== action.path || source.staged !== action.staged || extractHunkPatch(source.patch, action.index) !== action.patch || !action.patch.trim()) throw new Error('diffView.hunk.unavailable');
        if (action.action === 'discard' && action.confirmed !== true) throw new Error('Confirmation required');
        if (action.staged ? action.action !== 'unstage' : action.action === 'unstage') throw new Error('Invalid hunk scope');
        desktopPanelFilePath(captured.directory, action.path);
        return { path: 'apply-hunk', body: { path: action.path, patch: action.patch, action: action.action } };
      }
      case 'identity':
        if (resources.identity.error || resources.profiles.error || resources.globalIdentity.error) throw new Error('gitView.toast.refreshRepositoryFailed');
        if (action.profileId === 'global' ? !resources.globalIdentity.value?.userName || !resources.globalIdentity.value?.userEmail : !resources.profiles.value?.some(profile => profile.id === action.profileId)) throw new Error('Unknown Git identity');
        return { path: 'set-identity', body: { profileId: action.profileId } };
      case 'worktreeInspect': return { path: 'canonicalize-worktree-state', body: { directory: captured.directory } };
      case 'integratePlan': {
        const repoRoot = resources.primaryRoot.value, sourceBranch = resources.status.value?.current;
        if (!repoRoot || !sourceBranch || sourceBranch === action.targetBranch || action.targetBranch === 'HEAD') throw new Error('Invalid integration target');
        if (!resources.branches.value?.all.includes(action.targetBranch)) throw new Error('Unknown integration branch');
        return { path: 'integrate/plan', body: { repoRoot, sourceBranch, targetBranch: named(action.targetBranch) } };
      }
      case 'integrateRun': {
        const plan = resources.integrationPlan.value;
        if (!plan || plan.repoRoot !== resources.primaryRoot.value || plan.sourceBranch !== resources.status.value?.current || !plan.commits.length) throw new Error('Integration plan superseded');
        return { path: 'integrate/run', body: { plan } };
      }
      case 'integrateContinue': case 'integrateAbort': {
        const result = lane.integration;
        if (result?.kind !== 'conflict') throw new Error('No integration in progress');
        return { path: action.kind === 'integrateContinue' ? 'integrate/continue' : 'integrate/abort', body: { state: result.state } };
      }
      case 'prCreate': {
        if (resources.pr.error) throw new Error('gitView.pr.statusUnavailable');
        const head = resources.status.value?.current;
        if (!action.title.trim()) throw new Error('gitView.pr.toast.titleRequired');
        if (!head || !action.base.trim()) throw new Error('gitView.pr.toast.baseBranchRequired');
        if (head === action.base.trim() && (!action.targetRepo || action.targetRepo.owner === resources.pr.value?.repo?.owner && action.targetRepo.repo === resources.pr.value?.repo?.repo)) throw new Error('gitView.pr.toast.baseMustDifferFromHead');
        if (!resources.pr.value?.connected || resources.pr.value.pr) throw new Error('Pull request state unavailable');
        if (action.targetRepo) {
          const upstream = resources.upstream.value?.upstream;
          if (resources.upstream.error || !resources.upstream.value?.connected || !upstream || upstream.owner !== action.targetRepo.owner || upstream.repo !== action.targetRepo.repo) throw new Error('Unknown pull request target');
        }
        return { path: '/api/github/pr/create', body: { directory: captured.directory, title: action.title.trim(), body: action.body, head, base: action.base.trim(), draft: action.draft, remote: action.remote || prRemote, ...(action.headRemote ? { headRemote: action.headRemote } : {}), ...(action.targetRepo ? { targetRepo: action.targetRepo } : {}) } };
      }
      case 'prUpdate': case 'prReady': case 'prMerge': {
        if (resources.pr.error) throw new Error('gitView.pr.statusUnavailable');
        const pr = resources.pr.value?.pr;
        if (!pr || pr.number !== action.number) throw new Error('Pull request selection superseded');
        if (action.kind === 'prMerge' && (!resources.pr.value?.canMerge || pr.draft || pr.mergeable === false)) throw new Error('gitView.pr.noMergePermission');
        if (action.kind === 'prUpdate' && !action.title.trim()) throw new Error('gitView.pr.toast.titleRequired');
        return { path: '/api/github/pr/' + ({ prUpdate: 'update', prReady: 'ready', prMerge: 'merge' } as const)[action.kind], body: { directory: captured.directory, number: action.number, ...(action.kind === 'prUpdate' ? { title: action.title.trim(), body: action.body } : {}), ...(action.kind === 'prMerge' ? { method: action.method } : {}) } };
      }
      case 'generateCommit': case 'generatePR':
        if (action.expectedRevision !== undefined && action.expectedRevision !== lane.revision) throw new Error('Generation material superseded');
        return { path: '/api/small-model/generate', body: { directory: captured.directory, purpose: action.kind === 'generateCommit' ? 'commit' : 'pr', system: action.system, prompt: action.prompt } };
      case 'commit':
        if (!action.message.trim()) throw new Error('gitView.toast.enterCommitMessage');
        if (!resources.status.value?.files.some(file => !!file.index.trim() && !['?', '!'].includes(file.index.trim()))) throw new Error('gitView.toast.stageFileToCommit');
        return { path: 'commit', body: { message: action.message.trim(), addAll: false } };
      case 'checkout': return { path: 'checkout', body: { branch: named(action.branch) } };
      case 'branch': return { path: 'branches', body: { name: named(action.name), ...(action.startPoint ? { startPoint: named(action.startPoint) } : {}) } };
      case 'rename': return { path: 'branches/rename', method: 'PUT', body: { oldName: named(action.oldName), newName: named(action.newName) } };
      case 'deleteBranch': return { path: 'branches', method: 'DELETE', body: { branch: named(action.branch), force: false } };
      case 'fetch': case 'pull': case 'push': return { path: action.kind, body: action.remote ? { remote: named(action.remote) } : {} };
      case 'stash': return { path: 'stash', body: { message: action.message.trim() } };
      case 'stashApply': case 'stashPop': case 'stashDrop': return { path: `stash/${{ stashApply: 'apply', stashPop: 'pop', stashDrop: 'drop' }[action.kind]}`, body: { ref: named(action.ref) } };
      case 'merge': return { path: 'merge', body: { branch: named(action.branch) } };
      case 'rebase': return { path: 'rebase', body: { onto: named(action.branch) } };
      case 'mergeContinue': case 'mergeAbort': case 'rebaseContinue': case 'rebaseAbort': return { path: action.kind.replace(/(Continue|Abort)$/, part => '/' + part.toLowerCase()), body: {} };
      case 'checkoutCommit': case 'cherryPick': case 'revertCommit': case 'reset': {
        if (!/^[\da-fA-F]{7,40}$/.test(action.hash)) throw new Error('Invalid commit hash');
        return { path: { checkoutCommit: 'checkout-commit', cherryPick: 'cherry-pick', revertCommit: 'revert-commit', reset: 'reset-to-commit' }[action.kind], body: { hash: action.hash, ...(action.kind === 'reset' ? { mode: action.mode, force: action.mode === 'hard' } : {}) } };
      }
    }
  }
  async function mutate(action: DesktopGitAction): Promise<boolean> {
    if (!valid() || lane.unknown || action.kind.startsWith('generate') && lane.generationUnknown) return false;
    let request: ReturnType<typeof descriptor>;
    try { request = descriptor(action); } catch (cause) { mutationError = failure(cause); notify(); return false; }
    const epoch = generation;
    localPending++; lane.pending++; notifyLane();
    const task = lane.tail.then(async () => {
      if (!valid() || generation !== epoch || lane.unknown || action.kind.startsWith('generate') && lane.generationUnknown) return false;
      if (action.kind !== 'worktreeInspect' && verified.status !== lane.revision && !await refreshStatus()) return false;
      if (!valid() || generation !== epoch) return false;
      // A queued checkout/index/PR action may have replaced the authority used
      // at click time. Revalidate before dispatch, not after a second mutation.
      try { const latest = descriptor(action); if (JSON.stringify(latest) !== JSON.stringify(request)) throw new Error('Git action superseded'); }
      catch (cause) { if (valid()) { mutationError = failure(cause); notify(); } return false; }
      lane.revision++;
      for (const resource of Object.keys(resources) as Resource[]) { serials[resource]++; resources[resource].loading = false; }
      mutationError = ''; notify();
      let acknowledged = false;
      try {
        let response = await raw(route(request.path), request.method ?? 'POST', request.body);
        if (response.status === 404 && (action.kind === 'generateCommit' || action.kind === 'generatePR') && captured.sessionID && valid() && generation === epoch) {
          // Exact official session.generate payload; no session creation/prompt/history mutation.
          response = await raw(`/api/session/${encodeURIComponent(captured.sessionID)}/generate?${suffix}`, 'POST', { prompt: ['This is an auxiliary structured generation request (git copy). Do not call tools or take actions. Answer with the required JSON only.', action.system, action.prompt].join('\n\n') });
        }
        // 5xx can follow a partial Git mutation. Even a well-formed error is not
        // proof that nothing happened; never turn it into a retryable command.
        if (response.status >= 500 || response.status === 408 || response.status === 499) throw new Error(`HTTP ${response.status}: ${String(object(response.body).error || object(response.body).message || '')}`);
        if (response.status < 200 || response.status >= 300) {
          acknowledged = !action.kind.startsWith('integrate') && action.kind !== 'worktreeInspect';
          throw new Error(`HTTP ${response.status}: ${String(object(response.body).error || object(response.body).message || '')}`);
        }
        const body = object(response.body);
        if (action.kind === 'generateCommit' || action.kind === 'generatePR') {
          if (typeof (body.text ?? object(body.data).text) === 'string') acknowledged = true;
          const generated = generatedFrom(body, action.kind === 'generateCommit' ? 'commit' : 'pr');
          if (valid() && generation === epoch) resources.generated.value = generated;
          acknowledged = true; return true;
        }
        if (action.kind === 'worktreeInspect') { const state = canonicalFrom(body); lane.worktree = state; if (valid() && generation === epoch) resources.worktree.value = state; acknowledged = true; return true; }
        if (action.kind === 'integratePlan') {
          const plan = planFrom(body);
          if (plan.repoRoot !== request.body.repoRoot || plan.sourceBranch !== request.body.sourceBranch || plan.targetBranch !== action.targetBranch.replace(/^remotes\/[^/]+\//, '')) throw new Error('Integration plan identity mismatch');
          if (valid() && generation === epoch) resources.integrationPlan.value = plan; acknowledged = true; return true;
        }
        if (action.kind === 'integrateRun' || action.kind === 'integrateContinue') {
          const result = integrationResultFrom(body), origin = object(request.body.plan ?? request.body.state);
          if (result.kind === 'conflict' && (result.state.repoRoot !== origin.repoRoot || result.state.sourceBranch !== origin.sourceBranch || result.state.targetBranch !== origin.targetBranch)) throw new Error('Integration result identity mismatch');
          lane.integration = result; if (valid() && generation === epoch) resources.integration.value = result; acknowledged = true; return true;
        }
        if (action.kind === 'integrateAbort' && body.success === true) { lane.integration = undefined; if (valid() && generation === epoch) resources.integration.value = null; acknowledged = true; return true; }
        if (action.kind === 'prCreate' || action.kind === 'prUpdate') { prFrom(body); acknowledged = true; return true; }
        if (action.kind === 'prReady' && body.ready === true) { acknowledged = true; return true; }
        if (action.kind === 'prMerge' && typeof body.merged === 'boolean') { acknowledged = true; if (!body.merged) mutationError = 'gitView.pr.toast.prNotMerged'; return body.merged; }
        if (body.conflict === true) { acknowledged = true; mutationError = 'gitView.history.actions.conflictToastTitle'; return false; }
        if (body.success !== true) throw new Error(String(body.error || 'Git operation not confirmed'));
        acknowledged = true;
        return true;
      } catch (cause) {
        if (!acknowledged) {
          if (action.kind.startsWith('generate')) lane.generationUnknown = action.kind;
          else lane.unknown = action.kind;
          notifyLane();
        }
        if (valid() && generation === epoch) mutationError = failure(cause);
        return false;
      } finally {
        // A read started while Git was still writing is not post-write evidence.
        lane.revision++;
        // Keep the shared lane occupied through authoritative reconciliation.
        if (valid()) {
          await refresh();
          if (resources.stashes.value === null && action.kind.startsWith('stash') && !lane.unknown) await refreshStashes();
          if (resources.log.value === null && action.kind === 'commit' && !lane.unknown) await refreshLog();
          if (resources.status.value?.operation || resources.status.value?.conflicted.length) await refreshConflicts();
          if (selectedPatch && !action.kind.startsWith('generate')) await refreshPatch();
          if (action.kind === 'identity') await refreshIdentities();
          if (action.kind.startsWith('pr')) await refreshPR();
        }
      }
    });
    lane.tail = task.catch(() => false);
    try { return await task; }
    finally { localPending--; lane.pending--; notifyLane(); if (!keepLane()) lanes.delete(key); }
  }
  async function promptTemplates() {
    const value = object(await read('/api/magic-prompts')), overrides = object(value.overrides);
    return (id: string, variables: Record<string, string> = {}) => {
      const template = typeof overrides[id] === 'string' ? overrides[id] : nativeMagicDefaults[id];
      if (typeof template !== 'string') throw new Error('Unknown magic prompt');
      return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => variables[name] ?? match);
    };
  }
  async function generate(purpose: 'commit' | 'pr', base = '', context = '', comparisonRef: string | null = base) {
    if (!valid() || lane.pending || lane.unknown || lane.generationUnknown || resources.generated.loading) return false;
    const epoch = generation, writeRevision = lane.revision;
    resources.generated.loading = true; resources.generated.error = ''; notify();
    try {
      const render = await promptTemplates();
      let material = '', system = '';
      if (purpose === 'commit') {
        const paths = resources.status.value?.files.filter(file => !!file.index.trim() && !['?', '!'].includes(file.index.trim())).map(file => file.path) ?? [];
        if (!paths.length) throw new Error('gitView.toast.stageFileToDescribe');
        const chunks: string[] = []; let included = 0, characters = 0;
        for (const path of paths.slice(0, 30)) {
          const diffs = await Promise.all([true, false].map(staged => read(`diff?path=${encodeURIComponent(path)}&staged=${staged}`)));
          const chunk = diffs.map(value => { const diff = object(value).diff; if (typeof diff !== 'string') throw new Error('Invalid generation diff'); return diff; }).filter(Boolean).join('\n') || `--- ${path} (no textual diff available)`;
          if (characters + chunk.length > 120_000) break;
          chunks.push(chunk); characters += chunk.length; included++;
          if (!valid() || epoch !== generation || writeRevision !== lane.revision) return false;
        }
        system = render('git.commit.generate.visible');
        material = [render('git.commit.generate.instructions', { selected_files: paths.map(path => '- ' + path).join('\n') }), `Diff budget: included ${included} of ${paths.length} selected files; fileLimit=30; charLimit=120000; omittedFiles=${paths.length - included}. Materials may be partial; do not invent omitted diffs.`, ...chunks].join('\n\n');
      } else {
        const head = resources.status.value?.current; if (!head || !base.trim() || !comparisonRef?.trim() || head === comparisonRef.trim()) throw new Error('gitView.pr.toast.baseBranchRequired');
        const log = commitsFrom(await read(`log?from=${encodeURIComponent(comparisonRef)}&to=${encodeURIComponent(head)}&maxCount=50`));
        if (!log.all.length) throw new Error('gitView.history.noCommits');
        const files = new Set<string>();
        for (const commit of log.all) {
          const entries = object(await read(`commit-files?hash=${encodeURIComponent(commit.hash)}`)).files;
          if (!Array.isArray(entries)) throw new Error('Invalid generation commit files');
          for (const entry of entries) { const path = object(entry).path; if (typeof path !== 'string') throw new Error('Invalid generation file'); files.add(path); }
        }
        system = render('git.pr.generate.visible');
        material = render('git.pr.generate.instructions', { base_branch: base, head_branch: head, commits: log.all.map(commit => `- ${commit.hash.slice(0, 7)} ${commit.message}\n${commit.body.slice(0, 2000)}`).join('\n'), changed_files: [...files].sort().slice(0, 300).map(path => '- ' + path).join('\n'), additional_context_block: context.trim() ? '\nAdditional context:\n' + context.trim() : '' });
      }
      if (!valid() || epoch !== generation || writeRevision !== lane.revision) return false;
      const result = await mutate({ kind: purpose === 'commit' ? 'generateCommit' : 'generatePR', system, prompt: material, expectedRevision: writeRevision });
      return result && valid() && generation === epoch;
    } catch (cause) { if (valid() && epoch === generation) resources.generated.error = failure(cause); return false; }
    finally { if (valid()) { resources.generated.loading = false; notify(); } }
  }
  return {
    scope: captured, resource: <K extends Resource>(key: K) => resources[key], worktreeState, repositoryState, blockingReason,
    pending: () => localPending > 0 || lane.pending > 0, unknown: () => lane.unknown || lane.generationUnknown || null, writeUnknown: () => lane.unknown, generationUnknown: () => lane.generationUnknown || null, mutationError: () => mutationError,
    refresh, refreshStatus, refreshRepository, refreshBranches, refreshRemotes, refreshStashes, refreshLog, refreshConflicts, refreshPatch, refreshIdentities, refreshPrimaryRoot, refreshPR, refreshPRContext, refreshUpstream, refreshPRBranches, refreshIntegration, generate, mutate, cancel, canAcknowledgeUnknown,
    async agentPrompt(prefix: string, variables: Record<string, string> = {}) {
      const epoch = generation, render = await promptTemplates();
      if (!valid() || epoch !== generation) throw new Error('Git scope superseded');
      return { visibleText: render(prefix + '.visible', variables), instructionsText: render(prefix + '.instructions', variables) };
    },
    // Explicit review does not replay anything. A failed read cannot unlock writes.
    acknowledgeUnknown() { if (!canAcknowledgeUnknown()) return false; lane.unknown = null; mutationError = ''; notifyLane(); return true; },
    async commitFiles(hash: string): Promise<DesktopGitFile[]> {
      const epoch = generation;
      const body = object(await read(`commit-files?hash=${encodeURIComponent(hash)}`));
      if (!valid() || epoch !== generation) throw new Error('Git scope superseded');
      if (!Array.isArray(body.files)) throw new Error('Invalid Git commit files');
      return body.files.map(value => {
        const row = object(value); if (typeof row.path !== 'string') throw new Error('Invalid Git commit file');
        return { path: row.path, isBinary: row.isBinary === true, changeType: String(row.changeType ?? ''), insertions: Number(row.insertions ?? 0), deletions: Number(row.deletions ?? 0) };
      });
    },
    async commitDiff(hash: string, file: DesktopGitFile) {
      const epoch = generation;
      const body = object(await read(`commit-file-diff?hash=${encodeURIComponent(hash)}&path=${encodeURIComponent(file.path)}&binary=${file.isBinary}`));
      if (!valid() || epoch !== generation) throw new Error('Git scope superseded');
      if (typeof body.original !== 'string' || typeof body.modified !== 'string') throw new Error('Invalid Git commit diff');
      return { path: file.path, before: body.original, after: body.modified, isBinary: body.isBinary === true };
    },
    dispose() { if (!alive) return; alive = false; lane.owners--; lane.listeners.delete(notify); cancel(); if (!keepLane()) lanes.delete(key); },
  };
}
export type DesktopGitOwner = ReturnType<typeof createDesktopGit>;
