/** Synthetic Git only. No git subprocess, filesystem, network or production Host. */
export function createHost(player) {
  const stats = { reads: 0, writes: 0, generations: 0, lastKind: '', lastHost: '', concurrent: 0, maxConcurrent: 0, lastBody: null };
  const indexes = new Map();
  let fail = '', operation = false, hasPR = true, prTitle = 'Synthetic PR', prBody = 'Synthetic PR body', identity = 'Initial identity';
  const pr = () => ({ number: 42, title: prTitle, body: prBody, url: 'https://synthetic.invalid/pull/42', state: 'open', draft: false, base: 'main', head: 'synthetic-b-feature', headSha: 'abcdef1234567', mergeable: true });
  const patch = 'diff --git a/both.ts b/both.ts\n--- a/both.ts\n+++ b/both.ts\n@@ -1 +1 @@\n-before\n+after\n@@ -10 +10 @@\n-old tail\n+new tail\n';
  const integrationState = { repoRoot: '/synthetic/worktree', tempWorktreePath: '/synthetic/temp-integration', sourceBranch: 'synthetic-b-feature', targetBranch: 'main', cleanTargetWorktrees: [], remainingCommits: ['abcdef1234567'], currentCommit: 'abcdef1234567' };
  const integrationDetails = { statusPorcelain: 'UU both.ts', unmergedFiles: ['both.ts'], diff: patch, currentPatchMeta: 'Synthetic integration commit', currentPatch: patch };
  const publish = () => player.hostEvent('desktop-git.stats', { ...stats });
  return { async call(name, input) {
    if (name !== 'runtime.request') throw new Error('Unexpected fixture bridge');
    if (input.path.startsWith('/fixture/control?')) { const mode = input.path.split('mode=')[1]; if (mode === 'merge') operation = true; else if (mode === 'pr-new') hasPR = false; else fail = mode; return { status: 200, body: true }; }
    const host = input.expectedHost?.hostID;
    if (!['synthetic-a', 'synthetic-b'].includes(host) || input.expectedHost.lease !== host + '-lease') throw new Error('Missing captured Host');
    if (!input.path.includes('directory=%2Fsynthetic%2Fworktree')) throw new Error('Missing captured directory');
    const route = input.path.split('?')[0], kind = route.startsWith('/api/git/') ? route.slice('/api/git/'.length) : route.slice('/api/'.length);
    const index = indexes.get(host) ?? true;
    if (input.method !== 'GET' && kind !== 'integrate/conflict-details') {
      stats.writes++; stats.lastKind = kind; stats.lastHost = host; stats.lastBody = input.body; stats.concurrent++; stats.maxConcurrent = Math.max(stats.concurrent, stats.maxConcurrent); publish();
      try {
        if (kind === 'stage') indexes.set(host, true);
        else if (kind === 'unstage' || kind === 'commit') indexes.set(host, false);
        if (fail === 'write') { fail = ''; throw new Error('SYNTHETIC_ACK_LOST'); }
        if (kind === 'set-identity') identity = input.body.profileId === 'global' ? 'Global identity' : 'Fixture identity';
        if (kind === 'small-model/generate' || kind.includes('/generate')) {
          stats.generations++; publish();
          if (fail === 'generation-fallback' && kind === 'small-model/generate') { fail = ''; return { status: 404, body: { error: 'No small model' } }; }
          const generated = input.body.purpose === 'pr' ? { title: 'Generated synthetic PR', body: 'Generated synthetic description' } : { subject: 'feat: generated synthetic change', highlights: ['Synthetic highlight'] };
          return { status: 200, body: kind === 'small-model/generate' ? { text: JSON.stringify(generated) } : { data: { text: JSON.stringify(generated) } } };
        }
        if (kind === 'canonicalize-worktree-state') return { status: 200, body: { worktreeRoot: '/synthetic/worktree', cwd: '/synthetic/worktree', branch: 'synthetic-b-feature', headState: 'branch', worktreeStatus: 'invalid', legacy: false, degraded: true, attentionReason: null } };
        if (kind === 'integrate/plan') return { status: 200, body: { ...input.body, commits: ['abcdef1234567'] } };
        if (kind === 'integrate/run') return { status: 200, body: { kind: 'conflict', state: integrationState, details: integrationDetails } };
        if (kind === 'integrate/continue') return { status: 200, body: { kind: 'success', moved: 1 } };
        if (kind === 'github/pr/create') { hasPR = true; prTitle = input.body.title; prBody = input.body.body; return { status: 200, body: pr() }; }
        if (kind === 'github/pr/update') { prTitle = input.body.title; prBody = input.body.body; return { status: 200, body: pr() }; }
        if (kind === 'github/pr/ready') return { status: 200, body: { ready: true } };
        if (kind === 'github/pr/merge') return { status: 200, body: { merged: true } };
        return { status: 200, body: { success: true } };
      } finally { stats.concurrent--; publish(); }
    }
    stats.reads++; publish();
    if (kind === 'check') return { status: 200, body: { isGitRepository: true } };
    if (kind === 'status') {
      if (fail === 'status') { fail = ''; return { status: 503, body: { error: 'SYNTHETIC_STATUS_OFFLINE' } }; }
      return { status: 200, body: { isClean: false, current: host + '-feature', ahead: 2, behind: 1, tracking: 'origin/main', ...(operation ? { mergeInProgress: { head: 'main', message: 'Synthetic merge' }, conflicted: ['both.ts'] } : {}), files: [{ path: 'both.ts', index: index ? 'M' : ' ', working_dir: 'M' }, { path: 'src/nested.ts', index: index ? 'M' : ' ', working_dir: 'M' }] } };
    }
    if (kind === 'branches') return { status: 200, body: { current: host + '-feature', all: [host + '-feature', 'main'] } };
    if (kind === 'remotes') return { status: 200, body: [{ name: 'origin' }] };
    if (kind === 'stashes') return { status: 200, body: { stashes: [{ ref: 'stash@{0}', hash: 'abc1234', message: 'synthetic saved work' }] } };
    if (kind === 'log') return { status: 200, body: { all: [{ hash: 'abcdef1234567', message: 'synthetic history', author_name: 'Tester', date: '2026-01-01', parents: [] }], total: 1 } };
    if (kind === 'commit-files') return { status: 200, body: { files: [{ path: 'history.ts', changeType: 'M', insertions: 1, deletions: 1 }] } };
    if (kind === 'commit-file-diff') return { status: 200, body: { original: 'HISTORY_BEFORE', modified: 'HISTORY_AFTER', isBinary: false } };
    if (kind === 'diff') return { status: 200, body: { diff: patch } };
    if (kind === 'identities') return { status: 200, body: [{ id: 'fixture-profile', name: 'Fixture identity', userName: 'Fixture identity', userEmail: 'fixture@example.invalid' }] };
    if (kind === 'current-identity') return { status: 200, body: { userName: identity, userEmail: 'fixture@example.invalid', sshCommand: null } };
    if (kind === 'global-identity') return { status: 200, body: { userName: 'Global identity', userEmail: 'global@example.invalid', sshCommand: null } };
    if (kind === 'primary-root') return { status: 200, body: { root: '/synthetic/worktree' } };
    if (kind === 'conflict-details') return { status: 200, body: { operation: 'merge', headInfo: 'Synthetic HEAD', unmergedFiles: ['both.ts'], diff: patch } };
    if (kind === 'magic-prompts') return { status: 200, body: { version: 1, overrides: {} } };
    if (kind === 'github/pr/status') return { status: 200, body: { connected: true, branch: host + '-feature', repo: { owner: 'synthetic', repo: 'synthetic' }, pr: hasPR ? pr() : null, checks: { state: 'failure', total: 1, success: 0, failure: 1, pending: 0 }, canMerge: true, defaultBranch: 'main' } };
    if (kind === 'github/pulls/context') return { status: 200, body: { connected: true, pr: pr(), issueComments: [{ id: 1, body: 'Synthetic review comment', author: { login: 'reviewer' } }], reviewComments: [], files: [{ filename: 'pr-history.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: '@@ -1 +1 @@\n-PR_HISTORY_BEFORE\n+PR_HISTORY_AFTER\n' }], checkRuns: [{ id: 1, name: 'Synthetic CI', status: 'completed', conclusion: 'failure', detailsUrl: 'https://synthetic.invalid/check/1', output: { title: 'Synthetic failure details', summary: 'Synthetic summary', text: 'Synthetic output' }, job: { name: 'Synthetic job', steps: [{ name: 'Synthetic step', status: 'completed', conclusion: 'failure' }] }, annotations: [{ path: 'pr-history.ts', startLine: 1, message: 'Synthetic annotation' }] }], diff: patch } };
    if (kind === 'github/repo/upstream') return { status: 200, body: { connected: true, isFork: true, upstream: { owner: 'synthetic-upstream', repo: 'synthetic', url: 'https://synthetic.invalid/upstream', defaultBranch: 'main', defaultBranchSha: 'abcdef1234567', remoteName: null } } };
    if (kind === 'github/repo/branches') return { status: 200, body: { branches: ['main', 'synthetic-release'] } };
    if (kind === 'integrate/conflict-details') return { status: 200, body: integrationDetails };
    throw new Error('Unexpected synthetic Git path: ' + kind);
  } };
}
