import { expect, test } from 'vitest';
import { createDesktopGit } from './desktop-git-model';
import type { DesktopPanelScope } from './desktop-panel-model';
import type { RawNativeResponse } from './runtime';

let identity = 0;
const scope = (): DesktopPanelScope => ({ host: { hostID: 'synthetic', lease: `git-test-${++identity}` }, authorityKey: `synthetic-authority-${identity}`, sessionID: 'session', directory: '/synthetic/worktree' });
const status = { isClean: false, current: 'feature', files: [{ path: 'both.ts', index: 'M', working_dir: 'M' }] };
const ok = (body: unknown): RawNativeResponse => ({ status: 200, body });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { resolve, promise }; }
function synthetic() {
  const requests: { path: string; method: string; body: unknown }[] = [];
  let nextStatus: () => Promise<RawNativeResponse> = async () => ok(status);
  let nextWrite: () => Promise<RawNativeResponse> = async () => ok({ success: true });
  const raw = async (path: string, method = 'GET', body?: unknown) => {
    requests.push({ path, method, body });
    if (method !== 'GET') return await nextWrite();
    if (path.includes('/check?')) return ok({ isGitRepository: true });
    if (path.includes('/status?')) return await nextStatus();
    if (path.includes('/branches?')) return ok({ current: 'feature', all: ['feature', 'main'] });
    if (path.includes('/remotes?')) return ok([{ name: 'origin' }]);
    if (path.includes('/stashes?')) return ok({ stashes: [] });
    if (path.includes('/log?')) return ok({ all: [], total: 0 });
    throw new Error(`Unexpected synthetic read ${path}`);
  };
  return { raw, requests, setStatus: (next: typeof nextStatus) => { nextStatus = next; }, setWrite: (next: typeof nextWrite) => { nextWrite = next; } };
}

test('status failure retains prior, explicit successful empty clears and paths always capture directory', async () => {
  const host = synthetic(), captured = scope(), git = createDesktopGit(captured, host.raw, () => true);
  await git.refresh(); const prior = git.resource('status').value;
  host.setStatus(async () => ({ status: 503, body: { error: 'offline' } })); await git.refreshStatus();
  expect(git.resource('status').value).toBe(prior); expect(git.resource('status').error).toContain('offline');
  host.setStatus(async () => ok({ isClean: true, files: [] })); await git.refreshStatus();
  expect(git.resource('status').value?.files).toEqual([]); expect(git.resource('status').error).toBe('');
  expect(host.requests.every(request => request.path.includes('directory=%2Fsynthetic%2Fworktree'))).toBe(true);
  git.dispose();
});

test('scope visibility cancellation fences old reads and queued writes; independent current scope survives', async () => {
  const host = synthetic(), slow = deferred<RawNativeResponse>(); let current = true;
  const git = createDesktopGit(scope(), host.raw, () => current); await git.refreshStatus(); const prior = git.resource('status').value;
  host.setStatus(() => slow.promise); const reading = git.refreshStatus();
  current = false; git.cancel(); slow.resolve(ok({ isClean: true, files: [] })); await reading;
  expect(git.resource('status').value).toBe(prior);
  expect(await git.mutate({ kind: 'stage', paths: ['both.ts'] })).toBe(false);
  expect(host.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
  git.dispose();
});

test('index writes serialize across controllers/sessions sharing actual Host+directory', async () => {
  const host = synthetic(), gate = deferred<RawNativeResponse>(), captured = scope();
  const first = createDesktopGit(captured, host.raw, () => true), second = createDesktopGit({ ...captured, sessionID: 'another' }, host.raw, () => true);
  await first.refresh(); await second.refresh();
  let writes = 0; host.setWrite(async () => ++writes === 1 ? gate.promise : ok({ success: true }));
  const staging = first.mutate({ kind: 'stage', paths: ['both.ts'] }), unstaging = second.mutate({ kind: 'unstage', paths: ['both.ts'] });
  await Promise.resolve(); expect(writes).toBe(1);
  gate.resolve(ok({ success: true })); expect(await staging).toBe(true); expect(await unstaging).toBe(true);
  expect(host.requests.filter(request => request.method === 'POST').map(request => [request.path.split('?')[0], request.body])).toEqual([
    ['/api/git/stage', { paths: ['both.ts'] }], ['/api/git/unstage', { paths: ['both.ts'] }],
  ]);
  first.dispose(); second.dispose();
});

test('lost write acknowledgement blocks queued/reopened actions; failed read cannot unlock; review never replays', async () => {
  const host = synthetic(), captured = scope();
  const git = createDesktopGit(captured, host.raw, () => true); await git.refresh();
  host.setWrite(async () => { throw new Error('lost acknowledgement'); });
  host.setStatus(async () => ({ status: 503, body: { error: 'offline' } }));
  const writing = git.mutate({ kind: 'commit', message: 'synthetic commit' });
  const queued = git.mutate({ kind: 'stage', paths: ['both.ts'] });
  expect(await writing).toBe(false); expect(await queued).toBe(false); expect(git.unknown()).toBe('commit');
  expect(git.acknowledgeUnknown()).toBe(false); git.dispose();
  const reopened = createDesktopGit(captured, host.raw, () => true);
  expect(reopened.unknown()).toBe('commit'); expect(await reopened.mutate({ kind: 'commit', message: 'do not repeat' })).toBe(false);
  host.setStatus(async () => ok({ isClean: true, files: [] })); await reopened.refresh();
  expect(reopened.unknown()).toBe('commit'); expect(reopened.acknowledgeUnknown()).toBe(true);
  expect(host.requests.filter(request => request.method !== 'GET')).toHaveLength(1); reopened.dispose();
});

test('5xx and malformed 2xx are uncertain; 4xx rejection is not replayed and preserves snapshots', async () => {
  for (const response of [{ status: 500, body: { error: 'partial' } }, { status: 408, body: { error: 'timeout' } }, ok({}), { status: 409, body: { error: 'stale' } }]) {
    const host = synthetic(), git = createDesktopGit(scope(), host.raw, () => true); await git.refresh();
    host.setWrite(async () => response);
    expect(await git.mutate({ kind: 'stage', paths: ['both.ts'] })).toBe(false);
    expect(!!git.unknown()).toBe(response.status !== 409);
    expect(git.resource('status').value?.files).toHaveLength(1);
    expect(host.requests.filter(request => request.method !== 'GET')).toHaveLength(1);
    if (git.unknown()) expect(git.acknowledgeUnknown()).toBe(true);
    git.dispose();
  }
});

test('commit validation, explicit restore confirmation and path confinement do not perform writes', async () => {
  const host = synthetic(), git = createDesktopGit(scope(), host.raw, () => true); await git.refresh();
  expect(await git.mutate({ kind: 'commit', message: '  ' })).toBe(false);
  expect(git.mutationError()).toBe('gitView.toast.enterCommitMessage');
  expect(await git.mutate({ kind: 'stage', paths: ['../../outside'] })).toBe(false);
  expect(await git.mutate({ kind: 'restore', path: 'both.ts', scope: 'all', confirmed: false } as never)).toBe(false);
  expect(host.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
  host.setStatus(async () => ok({ isClean: false, files: [{ path: 'new.ts', index: '?', working_dir: '?' }] })); await git.refreshStatus();
  expect(await git.mutate({ kind: 'commit', message: 'not staged' })).toBe(false);
  expect(git.mutationError()).toBe('gitView.toast.stageFileToCommit'); git.dispose();
});

test('write cancelled while in-flight cannot publish status into retired scope and next scope only reads', async () => {
  const host = synthetic(), gate = deferred<RawNativeResponse>(); let visible = true;
  const git = createDesktopGit(scope(), host.raw, () => visible); await git.refresh();
  const prior = git.resource('status').value; host.setWrite(() => gate.promise);
  const writing = git.mutate({ kind: 'stash', message: '' }); await Promise.resolve();
  visible = false; git.cancel(); const reads = host.requests.length; gate.resolve(ok({ success: true })); await writing;
  expect(git.resource('status').value).toBe(prior); expect(host.requests).toHaveLength(reads);
  const next = createDesktopGit(scope(), host.raw, () => true); await next.refreshStatus(); expect(next.unknown()).toBe(null);
  git.dispose(); next.dispose();
});

test('same-repo pending lane survives disposing one owner; normalized directories cannot bypass it', async () => {
  const host = synthetic(), captured = scope(), gate = deferred<RawNativeResponse>();
  const first = createDesktopGit(captured, host.raw, () => true), second = createDesktopGit({ ...captured, directory: captured.directory + '/' }, host.raw, () => true);
  await first.refresh(); await second.refresh(); first.dispose();
  host.setWrite(() => gate.promise);
  const writing = second.mutate({ kind: 'stage', paths: ['both.ts'] }); await Promise.resolve();
  const third = createDesktopGit(captured, host.raw, () => true); await third.refresh();
  const queued = third.mutate({ kind: 'unstage', paths: ['both.ts'] }); await Promise.resolve();
  expect(host.requests.filter(row => row.method === 'POST')).toHaveLength(1);
  gate.resolve(ok({ success: true })); expect(await writing).toBe(true); expect(await queued).toBe(true);
  second.dispose(); third.dispose();
});

test('unknown stash requires new stash authority; reads during in-flight write are not post-write evidence', async () => {
  const host = synthetic(), captured = scope(), gate = deferred<RawNativeResponse>(); let firstCurrent = true;
  const first = createDesktopGit(captured, host.raw, () => firstCurrent), second = createDesktopGit(captured, host.raw, () => true);
  await first.refresh(); await second.refresh(); host.setWrite(() => gate.promise);
  const writing = first.mutate({ kind: 'stash', message: '' }); await Promise.resolve(); await second.refresh();
  firstCurrent = false; first.cancel(); gate.resolve({ status: 500, body: { error: 'unknown stash' } }); await writing;
  expect(second.unknown()).toBe('stash'); expect(second.acknowledgeUnknown()).toBe(false);
  await second.refresh(); expect(second.canAcknowledgeUnknown()).toBe(true);
  expect(second.resource('stashes').value).toEqual([]); expect(second.acknowledgeUnknown()).toBe(true);
  expect(host.requests.filter(row => row.method === 'POST')).toHaveLength(1); first.dispose(); second.dispose();
});

test('confirmed mutation followed by failed read never becomes a retry of the acknowledged write', async () => {
  const host = synthetic(), git = createDesktopGit(scope(), host.raw, () => true); await git.refresh();
  host.setStatus(async () => ({ status: 503, body: { error: 'read unavailable after ACK' } }));
  expect(await git.mutate({ kind: 'commit', message: 'confirmed once' })).toBe(true);
  expect(git.unknown()).toBe(null); expect(git.resource('status').error).toContain('read unavailable');
  await git.refresh(); expect(host.requests.filter(row => row.method === 'POST')).toHaveLength(1); git.dispose();
});

test('late pre-write status cannot replace reconciled snapshot and explicit empty history remains distinct from failure', async () => {
  const host = synthetic(), git = createDesktopGit(scope(), host.raw, () => true), gate = deferred<RawNativeResponse>();
  await git.refresh(); host.setStatus(() => gate.promise); const old = git.refreshStatus();
  host.setStatus(async () => ok({ isClean: true, files: [] }));
  expect(await git.mutate({ kind: 'stage', paths: ['both.ts'] })).toBe(true);
  const authoritative = git.resource('status').value;
  gate.resolve(ok(status)); await old; expect(git.resource('status').value).toBe(authoritative);
  await git.refreshLog(); const previous = git.resource('log').value;
  expect(previous).toEqual({ all: [], total: 0 }); git.cancel(); expect(git.resource('log').value).toBe(previous); git.dispose();
});

test('actual directory switch captures request directory and late prior-scope results never enter the new owner', async () => {
  const captured = scope(), gate = deferred<RawNativeResponse>(); let oldCurrent = true;
  const requests: string[] = [];
  const raw = async (path: string) => { requests.push(path); return path.includes('directory=%2Fsynthetic%2Fworktree') ? gate.promise : ok({ isClean: true, current: 'next-worktree', files: [] }); };
  const old = createDesktopGit(captured, raw, () => oldCurrent); const pending = old.refreshStatus();
  oldCurrent = false; old.cancel();
  const next = createDesktopGit({ ...captured, directory: '/synthetic/next' }, raw, () => true); await next.refreshStatus();
  const nextSnapshot = next.resource('status').value;
  gate.resolve(ok(status)); await pending;
  expect(old.resource('status').value).toBe(null); expect(next.resource('status').value).toBe(nextSnapshot);
  expect(nextSnapshot?.current).toBe('next-worktree'); expect(requests).toEqual(['/api/git/status?directory=%2Fsynthetic%2Fworktree', '/api/git/status?directory=%2Fsynthetic%2Fnext']);
  old.dispose(); next.dispose();
});

test('Git operation mutations preserve exact Host route bodies and conflict acknowledgement is not empty success', async () => {
  const host = synthetic(), git = createDesktopGit(scope(), host.raw, () => true); await git.refresh();
  await git.mutate({ kind: 'restore', path: 'both.ts', scope: 'working', confirmed: true });
  await git.mutate({ kind: 'rebase', branch: 'main', confirmed: true });
  await git.mutate({ kind: 'mergeContinue' });
  await git.mutate({ kind: 'rename', oldName: 'feature', newName: 'renamed' });
  expect(host.requests.filter(row => row.method !== 'GET').map(row => [row.path.split('?')[0], row.method, row.body])).toEqual([
    ['/api/git/revert', 'POST', { path: 'both.ts', scope: 'working' }], ['/api/git/rebase', 'POST', { onto: 'main' }],
    ['/api/git/merge/continue', 'POST', {}], ['/api/git/branches/rename', 'PUT', { oldName: 'feature', newName: 'renamed' }],
  ]);
  host.setWrite(async () => ok({ success: false, conflict: true, conflictFiles: ['both.ts'] }));
  expect(await git.mutate({ kind: 'merge', branch: 'main', confirmed: true })).toBe(false);
  expect(git.mutationError()).toBe('gitView.history.actions.conflictToastTitle'); expect(git.unknown()).toBe(null); git.dispose();
});

test('same-ID different origin/authorization never shares writes or unknown receipts; lease renewal retains the same-authority ledger', async () => {
  const host = synthetic(), captured = scope(), first = createDesktopGit(captured, host.raw, () => true);
  await first.refresh(); host.setWrite(async () => { throw new Error('lost old-origin acknowledgement'); });
  await first.mutate({ kind: 'stage', paths: ['both.ts'] }); expect(first.unknown()).toBe('stage');
  const renewed = createDesktopGit({ ...captured, host: { ...captured.host, lease: 'renewed-lease' } }, host.raw, () => true);
  expect(renewed.unknown()).toBe('stage');
  const reauthorized = createDesktopGit({ ...captured, authorityKey: JSON.stringify(['same-id', 'https://synthetic.invalid/changed', 'new-authorization']) }, host.raw, () => true);
  await reauthorized.refresh(); expect(reauthorized.unknown()).toBe(null); host.setWrite(async () => ok({ success: true }));
  expect(await reauthorized.mutate({ kind: 'stage', paths: ['both.ts'] })).toBe(true);
  expect(first.unknown()).toBe('stage'); expect(renewed.unknown()).toBe('stage');
  await first.refresh(); expect(first.acknowledgeUnknown()).toBe(true); first.dispose(); renewed.dispose(); reauthorized.dispose();
});
