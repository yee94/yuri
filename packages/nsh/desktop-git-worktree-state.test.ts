import { expect, test } from 'vitest';
import { createHost } from './desktop-git-fixture-host.js';
import { createDesktopGit, type DesktopGitAction } from './desktop-git-model';
import { desktopGitWorktreeState, resolveDesktopGitWorktree, type DesktopGitWorktreeState } from './desktop-git-worktree-state';
import type { GitCanonicalWorktree } from './desktop-git-protocol';
import type { DesktopPanelScope } from './desktop-panel-model';
import type { RawNativeResponse } from './runtime';

let serial = 0;
const canonical = (patch: Partial<GitCanonicalWorktree> = {}): GitCanonicalWorktree => ({ worktreeRoot: '/synthetic/opencode-data/worktree/project-id', cwd: '/synthetic/worktree', branch: 'synthetic-b-feature', headState: 'branch', worktreeStatus: 'ready', legacy: false, degraded: false, attentionReason: null, ...patch });
function setup() {
  const scope: DesktopPanelScope = { host: { hostID: 'synthetic-b', lease: 'synthetic-b-lease' }, authorityKey: `worktree-state-${++serial}`, sessionID: 'session', directory: '/synthetic/worktree' };
  const host = createHost({ hostEvent() {} }), requests: { path: string; method: string; body?: unknown }[] = [];
  let authority: DesktopGitWorktreeState | undefined, intercept: ((path: string, method: string) => Promise<RawNativeResponse | undefined>) | undefined;
  const raw = async (path: string, method = 'GET', body?: unknown): Promise<RawNativeResponse> => { requests.push({ path, method, body }); return await intercept?.(path, method) || await host.call('runtime.request', { path, method, body, expectedHost: scope.host }); };
  const create = () => createDesktopGit(scope, raw, () => true, () => {}, () => authority);
  return { scope, requests, create, raw, set: (value: DesktopGitWorktreeState | undefined) => { authority = value; }, intercept: (handler: NonNullable<typeof intercept>) => { intercept = handler; } };
}
const writes = (fixture: ReturnType<typeof setup>) => fixture.requests.filter(request => request.method !== 'GET');
const actions: DesktopGitAction[] = [
  { kind: 'stage', paths: ['both.ts'] }, { kind: 'unstage', paths: ['both.ts'] }, { kind: 'restore', path: 'both.ts', scope: 'working', confirmed: true },
  { kind: 'hunk', path: 'both.ts', staged: false, patch: 'unused', index: 0, action: 'stage' }, { kind: 'commit', message: 'Synthetic' },
  { kind: 'branch', name: 'feature/new' }, { kind: 'rename', oldName: 'feature', newName: 'renamed' }, { kind: 'checkout', branch: 'main' }, { kind: 'deleteBranch', branch: 'feature/old', confirmed: true },
  { kind: 'cherryPick', hash: 'abcdef1234567', confirmed: true }, { kind: 'revertCommit', hash: 'abcdef1234567', confirmed: true }, { kind: 'checkoutCommit', hash: 'abcdef1234567', confirmed: true }, { kind: 'reset', hash: 'abcdef1234567', mode: 'hard', confirmed: true },
  { kind: 'merge', branch: 'main', confirmed: true }, { kind: 'rebase', branch: 'main', confirmed: true }, { kind: 'mergeContinue' }, { kind: 'mergeAbort', confirmed: true }, { kind: 'rebaseContinue' }, { kind: 'rebaseAbort', confirmed: true },
  { kind: 'pull' }, { kind: 'push' }, { kind: 'fetch' }, { kind: 'stash', message: 'Synthetic' }, { kind: 'stashApply', ref: 'stash@{0}' }, { kind: 'stashPop', ref: 'stash@{0}' }, { kind: 'stashDrop', ref: 'stash@{0}', confirmed: true },
  { kind: 'identity', profileId: 'global' }, { kind: 'prCreate', title: 'Synthetic', body: '', base: 'main', draft: true, confirmed: true }, { kind: 'prUpdate', number: 42, title: 'Synthetic', body: '' }, { kind: 'prReady', number: 42 }, { kind: 'prMerge', number: 42, method: 'squash', confirmed: true },
  { kind: 'integratePlan', targetBranch: 'main', confirmed: true }, { kind: 'integrateRun', confirmed: true }, { kind: 'integrateContinue', confirmed: true }, { kind: 'integrateAbort', confirmed: true }, { kind: 'generateCommit', system: 'Synthetic', prompt: 'Synthetic' }, { kind: 'generatePR', system: 'Synthetic', prompt: 'Synthetic' },
];

test('readonly canonical projection preserves server fields without cwd/root containment heuristics or a ready default', () => {
  const host = setup(), value = canonical({ headState: 'detached', branch: 'abcdef1', legacy: true, degraded: true });
  const descriptor = desktopGitWorktreeState(host.scope, { value });
  expect(descriptor.attachment).toEqual(value); expect(host.requests).toHaveLength(0);
  expect(resolveDesktopGitWorktree(host.scope, descriptor).attachment).toEqual(value);
  expect(resolveDesktopGitWorktree(host.scope, undefined).attachment).toBe(null);
  expect(resolveDesktopGitWorktree(host.scope, desktopGitWorktreeState(host.scope, { value: null })).unavailable).toBe(true);
  expect(desktopGitWorktreeState(host.scope, { value: { cwd: host.scope.directory } })).toMatchObject({ attachment: null, error: 'gitView.toast.refreshRepositoryFailed' });
});

test('descriptor fences same-ID authorization/origin, directory and session changes but permits a stable-authority lease renewal', () => {
  const host = setup(), descriptor = desktopGitWorktreeState(host.scope, { value: canonical() });
  for (const scope of [{ ...host.scope, authorityKey: host.scope.authorityKey + '-new-origin-auth' }, { ...host.scope, directory: '/synthetic/other' }, { ...host.scope, sessionID: 'other' }, { ...host.scope, host: { ...host.scope.host, hostID: 'other' } }]) {
    expect(resolveDesktopGitWorktree(scope, descriptor, canonical()).unavailable).toBe(true); expect(resolveDesktopGitWorktree(scope, descriptor).attachment).toBe(null);
  }
  expect(resolveDesktopGitWorktree({ ...host.scope, host: { ...host.scope.host, lease: 'renewed' } }, descriptor).unavailable).toBe(false);
});

test('pending/missing/invalid/not-a-repo canonical states block every scoped writer, including PR merge and paid copy; reads remain available', async () => {
  for (const status of ['pending', 'missing', 'invalid', 'not-a-repo'] as const) {
    const host = setup(); host.set(desktopGitWorktreeState(host.scope, { value: canonical({ worktreeStatus: status }) }));
    const git = host.create(); await git.refresh(); expect(await git.refreshLog()).toBe(true);
    for (const action of actions) { expect(git.blockingReason(action.kind), `${status}:${action.kind}`).not.toBe(null); expect(await git.mutate(action), `${status}:${action.kind}`).toBe(false); }
    if (status === 'missing' || status === 'invalid') expect(git.worktreeState().blockingReasons).toContainEqual({ reason: status });
    expect(writes(host)).toHaveLength(0); git.dispose();
  }
});

test('loading, failed, stale and malformed canonical authority cannot fall back to a previously inspected ready snapshot', async () => {
  const host = setup(), git = host.create(); await git.refresh();
  host.intercept(async path => path.includes('/canonicalize-worktree-state?') ? { status: 200, body: canonical() } : undefined);
  expect(await git.mutate({ kind: 'worktreeInspect', confirmed: true })).toBe(true);
  const writesBefore = writes(host).length;
  for (const state of [desktopGitWorktreeState(host.scope, { value: canonical(), loading: true }), desktopGitWorktreeState(host.scope, { value: canonical(), error: 'Synthetic read failure' }), desktopGitWorktreeState({ ...host.scope, sessionID: 'stale' }, { value: canonical() }), desktopGitWorktreeState(host.scope, { value: null }), undefined]) {
    host.set(state); expect(await git.mutate({ kind: 'branch', name: 'blocked' })).toBe(false);
  }
  expect(writes(host)).toHaveLength(writesBefore); git.dispose();
});

test('failed canonical reads with an old not-a-repo snapshot are unavailable, not authoritative not-a-repo; pending setup remains distinct', async () => {
  const host = setup(), git = host.create(); await git.refresh();
  host.set(desktopGitWorktreeState(host.scope, { value: canonical({ worktreeStatus: 'not-a-repo' }), error: 'Synthetic canonical GET failure' }));
  expect(git.repositoryState()).toBe('unavailable'); expect(await git.mutate({ kind: 'stage', paths: ['both.ts'] })).toBe(false);
  host.intercept(async path => path.includes('/git/check?') ? { status: 200, body: { isGitRepository: false } } : undefined);
  await git.refreshRepository(); host.set(desktopGitWorktreeState(host.scope, { value: canonical({ worktreeStatus: 'pending' }) }));
  expect(git.repositoryState()).toBe('pending'); expect(await git.mutate({ kind: 'stage', paths: ['both.ts'] })).toBe(false); expect(writes(host)).toHaveLength(0); git.dispose();
});

test('shared attention reasons protect branch/checkout/history/integration transitions but do not ban remote PR merge, recovery or index resolution', async () => {
  const host = setup(); host.set(desktopGitWorktreeState(host.scope, { value: canonical({ attentionReason: 'merge' }) }));
  const git = host.create(); await git.refresh(); await git.refreshPR();
  expect(git.worktreeState().blockingReasons).toContainEqual({ reason: 'attention', attentionReason: 'merge' });
  for (const kind of ['branch', 'rename', 'checkout', 'deleteBranch', 'checkoutCommit', 'cherryPick', 'revertCommit', 'reset', 'merge', 'rebase', 'pull', 'stashApply', 'stashPop', 'integratePlan', 'integrateRun']) {
    const action = actions.find(action => action.kind === kind)!; expect(await git.mutate(action), kind).toBe(false);
  }
  expect(writes(host)).toHaveLength(0);
  for (const kind of ['stage', 'unstage', 'restore', 'mergeContinue', 'mergeAbort', 'rebaseContinue', 'rebaseAbort', 'prMerge', 'fetch', 'push']) expect(await git.mutate(actions.find(action => action.kind === kind)!), kind).toBe(true);
  expect(git.worktreeState().attachment?.attentionReason).toBe('merge'); git.dispose();
});

test('dirty files alone are not Web branch/remote-PR blocking reasons; degraded/legacy flags are not a fake repair permission', async () => {
  const host = setup(); host.set(desktopGitWorktreeState(host.scope, { value: canonical({ legacy: true, degraded: true }) }));
  const git = host.create(); await git.refresh(); await git.refreshPR(); expect(git.resource('status').value?.isClean).toBe(false);
  expect(git.worktreeState().blockingReasons).toEqual([]); expect(git.blockingReason('branch')).toBe(null); expect(await git.mutate({ kind: 'branch', name: 'valid-dirty' })).toBe(true);
  expect(await git.mutate({ kind: 'prMerge', number: 42, method: 'merge', confirmed: true })).toBe(true); git.dispose();
});

test('failed or malformed repository checks and status keep prior but never become not-a-repo or admit writes', async () => {
  const host = setup(), git = host.create(); expect(git.repositoryState()).toBe('unavailable');
  expect(await git.mutate({ kind: 'stage', paths: ['both.ts'] })).toBe(false); expect(host.requests).toHaveLength(0);
  await git.refresh(); expect(git.repositoryState()).toBe('ready');
  host.intercept(async path => path.includes('/git/check?') ? { status: 503, body: { error: 'Synthetic check offline' } } : undefined);
  expect(await git.refreshRepository()).toBe(false); expect(git.resource('repository').value).toBe(true); expect(git.repositoryState()).toBe('unavailable');
  expect(await git.mutate({ kind: 'branch', name: 'blocked' })).toBe(false);
  host.intercept(async path => path.includes('/git/check?') ? { status: 200, body: { isGitRepository: false } } : undefined);
  await git.refreshRepository(); expect(git.repositoryState()).toBe('not-a-repo');
  host.intercept(async path => path.includes('/git/check?') ? { status: 200, body: {} } : undefined);
  expect(await git.refreshRepository()).toBe(false); expect(git.resource('repository').value).toBe(false); expect(git.repositoryState()).toBe('unavailable');
  host.intercept(async path => path.includes('/git/status?') ? { status: 503, body: { error: 'Synthetic status offline' } } : undefined);
  await git.refreshRepository(); expect(await git.refreshStatus()).toBe(false); expect(git.repositoryState()).toBe('unavailable'); expect(writes(host)).toHaveLength(0); git.dispose();
});

test('queued writers recheck the live canonical authority at dispatch, without replaying the earlier acknowledged write', async () => {
  const host = setup(); host.set(desktopGitWorktreeState(host.scope, { value: canonical() })); const git = host.create(); await git.refresh();
  let begin!: () => void, release!: () => void; const started = new Promise<void>(resolve => { begin = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  host.intercept(async path => { if (path.includes('/git/stage?')) { begin(); await gate; } return undefined; });
  const first = git.mutate({ kind: 'stage', paths: ['both.ts'] }), second = git.mutate({ kind: 'branch', name: 'queued' });
  await started; host.set(desktopGitWorktreeState(host.scope, { value: canonical({ worktreeStatus: 'pending' }) })); release();
  expect(await first).toBe(true); expect(await second).toBe(false); expect(writes(host).map(request => request.path.split('?')[0])).toEqual(['/api/git/stage']); git.dispose();
});

test('an explicitly inspected invalid state survives rail remount and cannot be forgotten to unlock the same-authority writer', async () => {
  const host = setup(), git = host.create(); await git.refresh(); expect(await git.mutate({ kind: 'worktreeInspect', confirmed: true })).toBe(true);
  expect(git.worktreeState().attachment?.worktreeStatus).toBe('invalid'); git.dispose(); const reopened = host.create(); await reopened.refresh();
  expect(reopened.worktreeState().attachment?.worktreeStatus).toBe('invalid'); expect(await reopened.mutate({ kind: 'branch', name: 'blocked' })).toBe(false);
  expect(writes(host)).toHaveLength(1); reopened.dispose();
});
