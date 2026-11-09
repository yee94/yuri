import type { IntegratePlan, IntegrateInProgress, IntegrateConflictDetails, IntegrateResult } from '../ui/src/lib/git/integrateWorktreeCommits';
export type { IntegratePlan, IntegrateInProgress, IntegrateConflictDetails, IntegrateResult };
export const gitObject = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const gitString = (value: unknown): string => { if (typeof value !== 'string') throw new Error('Invalid Git text'); return value; };
export const gitStrings = (value: unknown): string[] => { if (!Array.isArray(value)) throw new Error('Invalid Git collection'); return value.map(gitString); };
export type GitIdentity = { userName: string | null; userEmail: string | null };
export type GitProfile = { id: string; name: string; userName: string; userEmail: string };
export const identityFrom = (value: unknown): GitIdentity => { const row = gitObject(value); if (value === null) return { userName: null, userEmail: null }; return { userName: row.userName === null ? null : gitString(row.userName), userEmail: row.userEmail === null ? null : gitString(row.userEmail) }; };
export const profilesFrom = (value: unknown): GitProfile[] => { if (!Array.isArray(value)) throw new Error('Invalid Git profiles'); return value.map(value => { const row = gitObject(value); return { id: gitString(row.id), name: gitString(row.name), userName: gitString(row.userName), userEmail: gitString(row.userEmail) }; }); };
export type GitPR = { number: number; title: string; body: string; url: string; state: string; draft: boolean; base: string; head: string; headSha: string; mergeable: boolean | null };
export type GitPRStatus = { connected: boolean; branch: string; repo: { owner: string; repo: string } | null; pr: GitPR | null; canMerge: boolean; defaultBranch: string; checks: { state: string; total: number; success: number; failure: number; pending: number } | null };
export function prFrom(value: unknown): GitPR {
  const row = gitObject(value);
  if (!Number.isInteger(row.number) || Number(row.number) <= 0 || typeof row.draft !== 'boolean') throw new Error('Invalid pull request');
  return { number: Number(row.number), title: gitString(row.title), body: gitString(row.body), url: gitString(row.url), state: gitString(row.state), draft: row.draft, base: gitString(row.base), head: gitString(row.head), headSha: typeof row.headSha === 'string' ? row.headSha : '', mergeable: typeof row.mergeable === 'boolean' ? row.mergeable : null };
}
export function prStatusFrom(value: unknown): GitPRStatus {
  const row = gitObject(value); if (typeof row.connected !== 'boolean') throw new Error('Invalid pull request status');
  const repo = gitObject(row.repo), checks = gitObject(row.checks);
  return { connected: row.connected, branch: typeof row.branch === 'string' ? row.branch : '', repo: row.repo ? { owner: gitString(repo.owner), repo: gitString(repo.repo) } : null,
    pr: row.pr ? prFrom(row.pr) : null, canMerge: row.canMerge === true, defaultBranch: typeof row.defaultBranch === 'string' ? row.defaultBranch : '',
    checks: row.checks ? { state: gitString(checks.state), total: Number(checks.total), success: Number(checks.success), failure: Number(checks.failure), pending: Number(checks.pending) } : null };
}
export type GitPRFile = { filename: string; status: string; additions: number; deletions: number; changes: number; patch: string | null };
export type GitPRContext = { connected: boolean; pr: GitPR | null; files: GitPRFile[]; comments: { id: string; body: string; author: string; path?: string; line?: number }[]; checks: { id: string; name: string; status: string; conclusion: string; details: string; detailsUrl: string }[]; diff: string };
export function prContextFrom(value: unknown): GitPRContext {
  const row = gitObject(value); if (typeof row.connected !== 'boolean') throw new Error('Invalid pull request context');
  const list = (value: unknown) => { if (value === undefined) return []; if (!Array.isArray(value)) throw new Error('Invalid pull request collection'); return value.map(gitObject); };
  return { connected: row.connected, pr: row.pr ? prFrom(row.pr) : null,
    files: list(row.files).map(file => {
      const count = (value: unknown) => { if (!Number.isInteger(value) || Number(value) < 0) throw new Error('Invalid pull request file count'); return Number(value); };
      return { filename: gitString(file.filename), status: gitString(file.status), additions: count(file.additions), deletions: count(file.deletions), changes: count(file.changes), patch: typeof file.patch === 'string' ? file.patch : null };
    }),
    comments: [...list(row.issueComments), ...list(row.reviewComments)].map(comment => ({ id: String(comment.id), body: gitString(comment.body), author: String(gitObject(comment.author).login || ''), ...(typeof comment.path === 'string' ? { path: comment.path } : {}), ...(typeof comment.line === 'number' ? { line: comment.line } : {}) })),
    checks: list(row.checkRuns).map(check => ({ id: String(check.id), name: gitString(check.name), status: String(check.status || ''), conclusion: String(check.conclusion || ''), detailsUrl: typeof check.detailsUrl === 'string' ? check.detailsUrl : '', details: JSON.stringify({ output: check.output, job: check.job, annotations: check.annotations }, null, 2) })), diff: typeof row.diff === 'string' ? row.diff : '' };
}
export type GitUpstream = { connected: boolean; isFork: boolean; upstream: { owner: string; repo: string; url: string; defaultBranch: string; defaultBranchSha: string | null; remoteName: string | null } | null };
export function upstreamFrom(value: unknown): GitUpstream {
  const row = gitObject(value), upstream = gitObject(row.upstream);
  if (typeof row.connected !== 'boolean' || typeof row.isFork !== 'boolean') throw new Error('Invalid upstream repository');
  return { connected: row.connected, isFork: row.isFork, upstream: row.upstream ? { owner: gitString(upstream.owner), repo: gitString(upstream.repo), url: gitString(upstream.url), defaultBranch: gitString(upstream.defaultBranch), defaultBranchSha: typeof upstream.defaultBranchSha === 'string' && /^[\da-f]{7,40}$/i.test(upstream.defaultBranchSha) ? upstream.defaultBranchSha : null, remoteName: upstream.remoteName === null ? null : gitString(upstream.remoteName) } : null };
}
export type GitCanonicalWorktree = { worktreeRoot: string | null; cwd: string | null; branch: string | null; headState: 'branch' | 'detached' | 'unborn'; worktreeStatus: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo'; legacy: boolean; degraded: boolean; attentionReason: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null };
export function canonicalFrom(value: unknown): GitCanonicalWorktree {
  const row = gitObject(value);
  const headState = row.headState, worktreeStatus = row.worktreeStatus, attentionReason = row.attentionReason ?? null;
  if (typeof row.legacy !== 'boolean' || typeof row.degraded !== 'boolean') throw new Error('Invalid worktree authority flags');
  if (headState !== 'branch' && headState !== 'detached' && headState !== 'unborn') throw new Error('Invalid worktree HEAD');
  if (worktreeStatus !== 'pending' && worktreeStatus !== 'ready' && worktreeStatus !== 'missing' && worktreeStatus !== 'invalid' && worktreeStatus !== 'not-a-repo') throw new Error('Invalid worktree state');
  if (attentionReason !== null && attentionReason !== 'merge' && attentionReason !== 'rebase' && attentionReason !== 'cherry-pick' && attentionReason !== 'revert' && attentionReason !== 'bisect') throw new Error('Invalid worktree attention reason');
  return { worktreeRoot: row.worktreeRoot === null ? null : gitString(row.worktreeRoot), cwd: row.cwd === null ? null : gitString(row.cwd), branch: row.branch === null ? null : gitString(row.branch), headState, worktreeStatus, legacy: row.legacy === true, degraded: row.degraded === true, attentionReason };
}
export function planFrom(value: unknown): IntegratePlan {
  const row = gitObject(value); return { repoRoot: gitString(row.repoRoot), sourceBranch: gitString(row.sourceBranch), targetBranch: gitString(row.targetBranch), commits: gitStrings(row.commits) };
}
export function integrationStateFrom(value: unknown): IntegrateInProgress {
  const row = gitObject(value); return { repoRoot: gitString(row.repoRoot), tempWorktreePath: gitString(row.tempWorktreePath), sourceBranch: gitString(row.sourceBranch), targetBranch: gitString(row.targetBranch), cleanTargetWorktrees: gitStrings(row.cleanTargetWorktrees), remainingCommits: gitStrings(row.remainingCommits), currentCommit: gitString(row.currentCommit) };
}
export function integrationDetailsFrom(value: unknown): IntegrateConflictDetails {
  const row = gitObject(value); return { statusPorcelain: gitString(row.statusPorcelain), unmergedFiles: gitStrings(row.unmergedFiles), diff: gitString(row.diff), currentPatchMeta: gitString(row.currentPatchMeta), currentPatch: gitString(row.currentPatch) };
}
export function integrationResultFrom(value: unknown): IntegrateResult {
  const row = gitObject(value);
  if (row.kind === 'success' && Number.isInteger(row.moved)) return { kind: 'success', moved: Number(row.moved) };
  if (row.kind === 'noop') return { kind: 'noop', reason: gitString(row.reason) };
  if (row.kind === 'conflict') return { kind: 'conflict', state: integrationStateFrom(row.state), details: integrationDetailsFrom(row.details) };
  throw new Error('Invalid worktree integration result');
}
export type GitGenerated = { purpose: 'commit' | 'pr'; subject: string; highlights: string[]; title: string; body: string };
export function generatedFrom(value: unknown, purpose: 'commit' | 'pr'): GitGenerated {
  const response = gitObject(value), text = gitString(response.text ?? gitObject(response.data).text).trim();
  const candidate = (text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1] ?? text).trim();
  const start = candidate.indexOf('{'), end = candidate.lastIndexOf('}');
  const row = gitObject(JSON.parse(candidate.slice(start, end + 1)));
  if (purpose === 'commit') {
    const subject = gitString(row.subject).trim(); if (!subject) throw new Error('Empty generated subject');
    return { purpose, subject, highlights: gitStrings(row.highlights).map(line => line.trim()).filter(Boolean).slice(0, 3), title: '', body: '' };
  }
  const title = gitString(row.title).trim(), body = gitString(row.body); if (!title) throw new Error('Empty generated PR title');
  return { purpose, subject: '', highlights: [], title, body };
}
