import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { createHost } from './desktop-git-fixture-host.js';
import { createDesktopGit } from './desktop-git-model';
import { splitPatchIntoHunks, extractHunkPatch } from './desktop-git-patch';
import { desktopGitmojis, insertDesktopGitmoji } from './desktop-git-gitmoji';
import { buildChangesTree, flattenChangesTree } from '../ui/src/components/views/git/changesTree';
import type { DesktopPanelScope } from './desktop-panel-model';
import type { RawNativeResponse } from './runtime';
import { desktopGitWorktreeState, type DesktopGitWorktreeState } from './desktop-git-worktree-state';

let serial = 0;
function fixture() {
  const captured: DesktopPanelScope = { host: { hostID: 'synthetic-b', lease: 'synthetic-b-lease' }, authorityKey: `git-extra-${++serial}`, sessionID: 'session', directory: '/synthetic/worktree' };
  const host = createHost({ hostEvent() {} });
  const requests: { path: string; method: string; body: unknown }[] = [];
  let intercept: ((path: string, method: string, body?: unknown) => Promise<RawNativeResponse | undefined>) | null = null;
  const raw = async (path: string, method = 'GET', body?: unknown): Promise<RawNativeResponse> => {
    requests.push({ path, method, body });
    const override = await intercept?.(path, method, body);
    return override || await host.call('runtime.request', { path, method, body, expectedHost: captured.host });
  };
  return { captured, raw, requests, intercept: (handler: NonNullable<typeof intercept>) => { intercept = handler; }, control: (mode: string) => host.call('runtime.request', { path: '/fixture/control?mode=' + mode }) };
}
const writes = (requests: ReturnType<typeof fixture>['requests']) => requests.filter(request => request.method !== 'GET');

test('native hunk helpers are the exact Web exports, preserving headers and no-newline markers', () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const web = readFileSync(path.join(directory, '../ui/src/lib/diff/patchFileDiff.ts'), 'utf8');
  const native = readFileSync(path.join(directory, 'desktop-git-patch.ts'), 'utf8');
  const exportStart = 'export const splitPatchIntoHunks';
  expect(native.slice(native.indexOf(exportStart)).trim()).toBe(web.slice(web.indexOf(exportStart)).trim());
  const patch = 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n@@ -5 +5 @@\n-c\n+d\n';
  expect(splitPatchIntoHunks(patch)).toHaveLength(2);
  expect(extractHunkPatch(patch, 0)).toContain('\\ No newline');
  expect(extractHunkPatch(patch, 1)).not.toContain('@@ -1 +1 @@');
  expect(extractHunkPatch(patch, -1)).toBe(null);
});

test('folder inventory and staged/working selection keep exact child path scopes', () => {
  const files = [{ path: 'src/a.ts', index: 'M', working_dir: 'M' }, { path: 'src/sub/b.ts', index: 'A', working_dir: ' ' }, { path: 'other/c.ts', index: ' ', working_dir: 'M' }];
  const root = buildChangesTree(files), folder = root.children.get('src')!;
  expect(folder.files.map(file => file.path)).toEqual(['src/a.ts', 'src/sub/b.ts']);
  expect(flattenChangesTree(root, new Set(['src'])).map(row => row.key)).toContain('dir:src/sub');
  expect(flattenChangesTree(root, new Set(['src', 'src/sub'])).filter(row => row.kind === 'file').map(row => row.file.path)).toEqual(['src/sub/b.ts', 'src/a.ts']);
});

test('hunk writes use one exact verified snapshot and Host apply-hunk body; discard is confirmed and stale patches cannot write', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh();
  await git.refreshPatch('both.ts', false); const source = git.resource('patch').value!;
  expect(await git.mutate({ kind: 'hunk', path: 'both.ts', staged: false, index: 0, patch: source.hunks[0], action: 'discard' })).toBe(false);
  expect(writes(host.requests)).toHaveLength(0);
  expect(await git.mutate({ kind: 'hunk', path: 'both.ts', staged: false, index: 0, patch: 'unverified', action: 'stage' })).toBe(false);
  expect(await git.mutate({ kind: 'hunk', path: 'both.ts', staged: false, index: 1, patch: source.hunks[1], action: 'stage' })).toBe(true);
  expect(writes(host.requests)[0]).toEqual({ path: '/api/git/apply-hunk?directory=%2Fsynthetic%2Fworktree', method: 'POST', body: { path: 'both.ts', patch: source.hunks[1], action: 'stage' } });
  expect(writes(host.requests)[0].body).not.toHaveProperty('addAll'); git.dispose();
});

test('explicit AI generation consumes captured diffs and Host prompt overrides; no commit or paid request on mount', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh();
  expect(writes(host.requests)).toHaveLength(0);
  host.intercept(async path => path.startsWith('/api/magic-prompts?') ? { status: 200, body: { overrides: { 'git.commit.generate.visible': 'Synthetic override only' } } } : undefined);
  expect(await git.generate('commit')).toBe(true);
  expect(git.resource('generated').value).toMatchObject({ subject: 'feat: generated synthetic change', highlights: ['Synthetic highlight'] });
  expect(writes(host.requests)).toHaveLength(1);
  expect(writes(host.requests)[0]).toMatchObject({ path: '/api/small-model/generate?directory=%2Fsynthetic%2Fworktree', body: { directory: '/synthetic/worktree', purpose: 'commit', system: 'Synthetic override only' } });
  expect(JSON.stringify(writes(host.requests)[0].body)).toContain('Diff budget: included');
  expect(host.requests.some(request => request.path.startsWith('/api/git/commit?'))).toBe(false); git.dispose();
});

test('small-model 404 alone can use exact session.generate fallback, never create/session prompt', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await host.control('generation-fallback');
  expect(await git.generate('commit')).toBe(true);
  expect(writes(host.requests).map(request => request.path.split('?')[0])).toEqual(['/api/small-model/generate', '/api/session/session/generate']);
  expect(Object.keys(writes(host.requests)[1].body as object)).toEqual(['prompt']); expect(git.unknown()).toBe(null); git.dispose();
});

test('failed diff preflight makes zero paid requests and lost generation response never automatically repeats', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh();
  host.intercept(async path => path.startsWith('/api/git/diff?') ? { status: 503, body: { error: 'diff unavailable' } } : undefined);
  expect(await git.generate('commit')).toBe(false); expect(writes(host.requests)).toHaveLength(0);
  host.intercept(async path => { if (path.startsWith('/api/small-model/generate?')) throw new Error('synthetic response lost'); return undefined; });
  expect(await git.generate('commit')).toBe(false); expect(git.unknown()).toBe('generateCommit'); await git.refresh();
  expect(git.acknowledgeUnknown()).toBe(false); expect(await git.generate('commit')).toBe(false);
  expect(writes(host.requests)).toHaveLength(1);
  expect(await git.mutate({ kind: 'stage', paths: ['both.ts'] })).toBe(true);
  expect(git.unknown()).toBe('generateCommit'); expect(writes(host.requests)).toHaveLength(2); git.dispose();
});

test('a known malformed model answer preserves prior generation but is not a lost-result receipt', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await git.generate('commit');
  const prior = git.resource('generated').value;
  host.intercept(async path => path.startsWith('/api/small-model/generate?') ? { status: 200, body: { text: 'not valid JSON' } } : undefined);
  expect(await git.generate('commit')).toBe(false); expect(git.resource('generated').value).toBe(prior); expect(git.unknown()).toBe(null); git.dispose();
});

test('identity switch is serialized explicit set-identity, then current identity readback; no secret fields enter snapshots', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await git.refreshIdentities();
  expect(writes(host.requests)).toHaveLength(0);
  expect(await git.mutate({ kind: 'identity', profileId: 'fixture-profile' })).toBe(true);
  expect(git.resource('identity').value?.userName).toBe('Fixture identity');
  expect(git.resource('profiles').value?.[0]).not.toHaveProperty('sshKey');
  expect(writes(host.requests)).toEqual([{ path: '/api/git/set-identity?directory=%2Fsynthetic%2Fworktree', method: 'POST', body: { profileId: 'fixture-profile' } }]); git.dispose();
});

test('PR status/details, create/update/ready/merge use actual Host contracts without automatic publication', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await git.refreshPR(); await git.refreshPRContext();
  expect(git.resource('prContext').value?.comments[0].body).toBe('Synthetic review comment'); expect(writes(host.requests)).toHaveLength(0);
  expect(git.resource('prContext').value?.files[0]).toMatchObject({ filename: 'pr-history.ts', additions: 1, deletions: 1, patch: expect.stringContaining('PR_HISTORY_AFTER') });
  expect(git.resource('prContext').value?.checks[0]).toMatchObject({ detailsUrl: 'https://synthetic.invalid/check/1', details: expect.stringContaining('Synthetic step') });
  expect(await git.mutate({ kind: 'prUpdate', number: 42, title: 'Edited title', body: 'Edited body' })).toBe(true);
  expect(git.resource('pr').value?.pr?.title).toBe('Edited title');
  expect(await git.mutate({ kind: 'prReady', number: 42 })).toBe(true);
  expect(await git.mutate({ kind: 'prMerge', number: 42, method: 'squash', confirmed: true })).toBe(true);
  await host.control('pr-new'); await git.refreshPR();
  expect(await git.mutate({ kind: 'prCreate', title: 'New PR', body: 'New body', base: 'main', draft: true, confirmed: true })).toBe(true);
  expect(writes(host.requests).map(request => request.path.split('?')[0])).toEqual(['/api/github/pr/update', '/api/github/pr/ready', '/api/github/pr/merge', '/api/github/pr/create']);
  expect(writes(host.requests)[3].body).toMatchObject({ directory: '/synthetic/worktree', head: 'synthetic-b-feature', base: 'main', draft: true }); git.dispose();
});

test('fork discovery is read-only, branches use exact owner/repo and only an authoritative target can be published', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await host.control('pr-new'); await git.refreshPR();
  const targetRepo = { owner: 'synthetic-upstream', repo: 'synthetic' };
  const action = { kind: 'prCreate' as const, title: 'Fork change', body: 'Fork body', base: 'main', draft: true, headRemote: 'origin', targetRepo, confirmed: true as const };
  expect(await git.mutate(action)).toBe(false); expect(writes(host.requests)).toHaveLength(0);
  await git.refreshUpstream(); await git.refreshPRBranches(targetRepo);
  expect(git.resource('prBranches').value).toMatchObject({ ...targetRepo, branches: ['main', 'synthetic-release'] });
  expect(host.requests.at(-1)?.path).toBe('/api/github/repo/branches?owner=synthetic-upstream&repo=synthetic&directory=%2Fsynthetic%2Fworktree');
  expect(writes(host.requests)).toHaveLength(0); expect(await git.mutate(action)).toBe(true);
  expect(writes(host.requests)[0].body).toMatchObject({ targetRepo, headRemote: 'origin', head: 'synthetic-b-feature', base: 'main' }); git.dispose();
});

test('PR context rejects wrong identity, preserves prior on failure and clears on successful no-PR or changed head', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await git.refreshPR(); await git.refreshPRContext();
  const prior = git.resource('prContext').value;
  host.intercept(async path => path.includes('/pulls/context?') ? { status: 200, body: { connected: false } } : undefined);
  expect(await git.refreshPRContext()).toBe(false); expect(git.resource('prContext').value).toBe(prior); expect(git.resource('prContext').error).not.toBe('');
  host.intercept(async path => path.includes('/pr/status?') ? { status: 200, body: { ...git.resource('pr').value, pr: { ...git.resource('pr').value!.pr, headSha: '1234567' } } } : undefined);
  await git.refreshPR(); expect(git.resource('prContext').value).toBe(null);
  host.intercept(async () => undefined); await host.control('pr-new'); await git.refreshPR(); expect(git.resource('pr').value?.pr).toBe(null); expect(git.resource('prContext').value).toBe(null); git.dispose();
});

test('failed identity and PR reads preserve prior but cannot authorize further writes', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await git.refreshIdentities(); await git.refreshPR();
  const identity = git.resource('identity').value, pr = git.resource('pr').value;
  host.intercept(async path => /current-identity|pr\/status/.test(path) ? { status: 503, body: { error: 'Synthetic unavailable' } } : undefined);
  await git.refreshIdentities(); await git.refreshPR(); expect(git.resource('identity').value).toBe(identity); expect(git.resource('pr').value).toBe(pr);
  expect(await git.mutate({ kind: 'identity', profileId: 'fixture-profile' })).toBe(false);
  expect(await git.mutate({ kind: 'prUpdate', number: 42, title: 'No stale write', body: '' })).toBe(false); expect(writes(host.requests)).toHaveLength(0); git.dispose();
});

test('queued stale hunk is rejected at dispatch after the earlier index write changes its snapshot', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await git.refreshPatch('both.ts', false);
  const patch = git.resource('patch').value!.hunks[0]; let changed = false;
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  host.intercept(async (path, method) => {
    if (path.includes('/git/stage?') && method === 'POST') { await gate; changed = true; }
    if (path.includes('/git/diff?') && changed) return { status: 200, body: { diff: '' } };
    return undefined;
  });
  const first = git.mutate({ kind: 'stage', paths: ['both.ts'] });
  const second = git.mutate({ kind: 'hunk', path: 'both.ts', staged: false, index: 0, patch, action: 'stage' });
  release(); expect(await first).toBe(true); expect(await second).toBe(false);
  expect(writes(host.requests).map(request => request.path.split('?')[0])).toEqual(['/api/git/stage']); git.dispose();
});

test('queued PR creation cannot silently retarget the branch selected before checkout', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await host.control('pr-new'); await git.refreshPR();
  let switched = false;
  host.intercept(async (path, method) => {
    if (path.includes('/git/checkout?') && method === 'POST') switched = true;
    if (path.includes('/git/status?') && switched) return { status: 200, body: { current: 'main', isClean: true, files: [] } };
    return undefined;
  });
  const checkout = git.mutate({ kind: 'checkout', branch: 'main' });
  const create = git.mutate({ kind: 'prCreate', title: 'Captured feature', body: '', base: 'main', draft: true, confirmed: true });
  expect(await checkout).toBe(true); expect(await create).toBe(false); expect(writes(host.requests).map(request => request.path.split('?')[0])).toEqual(['/api/git/checkout']); git.dispose();
});

test('queued ordinary index write is not dispatched after post-write status reconciliation fails', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); let written = false;
  host.intercept(async (path, method) => {
    if (path.includes('/git/stage?') && method === 'POST') written = true;
    if (path.includes('/git/status?') && written) return { status: 503, body: { error: 'Synthetic readback failed' } };
    return undefined;
  });
  const first = git.mutate({ kind: 'stage', paths: ['both.ts'] }), second = git.mutate({ kind: 'unstage', paths: ['both.ts'] });
  expect(await first).toBe(true); expect(await second).toBe(false); expect(writes(host.requests)).toHaveLength(1); git.dispose();
});

test('queued generation lost response blocks only further generation, across remount and lease renewal', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh();
  host.intercept(async path => { if (path.includes('/small-model/generate?')) throw new Error('Synthetic generation lost'); return undefined; });
  const action = { kind: 'generateCommit' as const, system: 'Synthetic system', prompt: 'Synthetic prompt' };
  const first = git.mutate(action), second = git.mutate(action);
  expect(await first).toBe(false); expect(await second).toBe(false); expect(writes(host.requests)).toHaveLength(1); git.dispose();
  const reopened = createDesktopGit({ ...host.captured, host: { ...host.captured.host, lease: 'renewed' } }, host.raw, () => true); await reopened.refresh();
  expect(reopened.generationUnknown()).toBe('generateCommit'); expect(reopened.writeUnknown()).toBe(null); expect(await reopened.generate('commit')).toBe(false);
  expect(await reopened.mutate({ kind: 'stage', paths: ['both.ts'] })).toBe(true); expect(writes(host.requests)).toHaveLength(2); reopened.dispose();
  const other = createDesktopGit({ ...host.captured, authorityKey: host.captured.authorityKey + '-reauthorized' }, host.raw, () => true);
  expect(other.generationUnknown()).toBe(null); other.dispose();
});

test('generation preflight losing its scope never makes a paid request', async () => {
  const host = fixture(); let current = true;
  const git = createDesktopGit(host.captured, host.raw, () => current); await git.refresh();
  host.intercept(async path => { if (path.includes('/magic-prompts?')) current = false; return undefined; });
  expect(await git.generate('commit')).toBe(false); expect(writes(host.requests)).toHaveLength(0); git.dispose();
});

test('a paid response from a canceled generation cannot replace the prior answer after visibility resumes', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await git.generate('commit');
  const prior = git.resource('generated').value;
  let release!: (value: RawNativeResponse) => void, begin!: () => void;
  const gate = new Promise<RawNativeResponse>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { begin = resolve; });
  host.intercept(async path => { if (path.includes('/small-model/generate?')) { begin(); return await gate; } return undefined; });
  const pending = git.generate('commit'); await started; git.cancel();
  release({ status: 200, body: { text: JSON.stringify({ subject: 'Retired answer', highlights: [] }) } });
  expect(await pending).toBe(false); expect(git.resource('generated').value).toBe(prior); expect(git.unknown()).toBe(null); git.dispose();
});

test('a canceled small-model 404 cannot admit a new paid session fallback after visibility resumes', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh();
  let release!: (value: RawNativeResponse) => void, begin!: () => void;
  const gate = new Promise<RawNativeResponse>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { begin = resolve; });
  host.intercept(async path => { if (path.includes('/small-model/generate?')) { begin(); return await gate; } return undefined; });
  const pending = git.generate('commit'); await started; git.cancel(); release({ status: 404, body: { error: 'Synthetic absent model' } });
  expect(await pending).toBe(false); expect(writes(host.requests)).toHaveLength(1); expect(git.unknown()).toBe(null); git.dispose();
});

test('upstream generation compares the authoritative upstream SHA, not an unrelated same-named local base', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await git.refreshUpstream();
  expect(await git.generate('pr', 'main', '', null)).toBe(false); expect(writes(host.requests)).toHaveLength(0);
  expect(await git.generate('pr', 'main', '', git.resource('upstream').value!.upstream!.defaultBranchSha)).toBe(true);
  expect(host.requests.some(request => request.path.includes('/log?from=abcdef1234567&to=synthetic-b-feature'))).toBe(true); expect(writes(host.requests)).toHaveLength(1); git.dispose();
});

test('unchanged authoritative status revisions retain the exact snapshot through 50 refreshes', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); let revision = 'synthetic-v1';
  host.intercept(async path => path.includes('/git/status?') ? { status: 200, body: { revision, isClean: false, current: 'synthetic-b-feature', files: [{ path: 'both.ts', index: 'M', working_dir: 'M' }] } } : undefined);
  await git.refreshStatus(); const prior = git.resource('status').value;
  for (let index = 0; index < 50; index++) { await git.refreshStatus(); expect(git.resource('status').value).toBe(prior); }
  revision = 'synthetic-v2'; await git.refreshStatus(); expect(git.resource('status').value).not.toBe(prior); git.dispose();
});

test('integration preview/canonicalization require explicit confirmation; confirmed conflict survives remount and continues once', async () => {
  const host = fixture(); let canonical: DesktopGitWorktreeState | undefined;
  const git = createDesktopGit(host.captured, host.raw, () => true, () => {}, () => canonical); await git.refresh(); await git.refreshPrimaryRoot();
  expect(writes(host.requests)).toHaveLength(0);
  expect(await git.mutate({ kind: 'worktreeInspect', confirmed: false } as never)).toBe(false);
  expect(await git.mutate({ kind: 'worktreeInspect', confirmed: true })).toBe(true); expect(git.resource('worktree').value?.worktreeStatus).toBe('invalid');
  expect(await git.mutate({ kind: 'integratePlan', targetBranch: 'main', confirmed: true })).toBe(false);
  expect(writes(host.requests)).toHaveLength(1);
  canonical = desktopGitWorktreeState(host.captured, { value: { ...git.resource('worktree').value, worktreeStatus: 'ready', degraded: false } });
  expect(await git.mutate({ kind: 'integratePlan', targetBranch: 'main', confirmed: true })).toBe(true);
  expect(await git.mutate({ kind: 'integrateRun', confirmed: true })).toBe(true); expect(git.resource('integration').value?.kind).toBe('conflict'); git.dispose();
  const reopened = createDesktopGit(host.captured, host.raw, () => true, () => {}, () => canonical); await reopened.refresh();
  expect(reopened.resource('integration').value?.kind).toBe('conflict'); await reopened.refreshIntegration();
  expect(await reopened.mutate({ kind: 'integrateContinue', confirmed: true })).toBe(true); expect(reopened.resource('integration').value).toEqual({ kind: 'success', moved: 1 });
  expect(writes(host.requests).filter(request => request.path.includes('/integrate/run?'))).toHaveLength(1); reopened.dispose();
});

test('partial integrate errors are uncertain even on HTTP 400 and clean status is never permission to replay them', async () => {
  const host = fixture(), git = createDesktopGit(host.captured, host.raw, () => true); await git.refresh(); await git.refreshPrimaryRoot();
  host.intercept(async path => path.includes('/integrate/plan?') ? { status: 400, body: { error: 'synthetic partial branch creation' } } : undefined);
  expect(await git.mutate({ kind: 'integratePlan', targetBranch: 'main', confirmed: true })).toBe(false);
  await git.refresh(); expect(git.unknown()).toBe('integratePlan'); expect(git.acknowledgeUnknown()).toBe(false);
  expect(await git.mutate({ kind: 'integratePlan', targetBranch: 'main', confirmed: true })).toBe(false);
  expect(writes(host.requests)).toHaveLength(1); git.dispose();
});

test('Gitmoji insertion is offline, searchable, deduplicated and does not rewrite existing draft', () => {
  const entry = desktopGitmojis.find(item => item.code === ':sparkles:')!;
  expect(desktopGitmojis.length).toBeGreaterThan(70); expect(new Set(desktopGitmojis.map(item => item.code)).size).toBe(desktopGitmojis.length);
  expect(insertDesktopGitmoji('feat: native Git', entry)).toBe(':sparkles: feat: native Git');
  expect(insertDesktopGitmoji(':sparkles: feat: native Git', entry)).toBe(':sparkles: feat: native Git');
  expect(insertDesktopGitmoji('✨ feat: native Git', entry)).toBe('✨ feat: native Git');
});
