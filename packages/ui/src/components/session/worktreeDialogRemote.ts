import type { GitHubAPI, GitHubAuthStatus, GitHubIssue, GitHubPullRequestSummary } from '@/lib/api/types';
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { captureProjectScope } from '@/lib/api/project-scope';
import { getDefaultMagicPromptTemplate, type MagicPromptId } from '@/lib/magicPrompts';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { githubAuthQueryOptions } from '@/queries/githubAuthQueries';
import { queryClient } from '@/lib/queryRuntime';
import { getRemoteChatOwner } from '@/sync/remote-chat-context';
import { ascendingId } from '@/sync/message-id';

/** Only the read capabilities used by the shared worktree/linked-context form. */
export type WorktreeGitHubReads = Pick<GitHubAPI, 'authStatus' | 'issuesList' | 'prsList' | 'issueGet' | 'issueComments' | 'prContext'>;

export function createWorktreeGitHubReads(entry: HostRuntimeEntry): WorktreeGitHubReads {
  const scope = captureProjectScope(entry);
  const get = <T>(route: string, query: Record<string, string | number | undefined> = {}) => scope.json<T>(`/api/github/${route}`, { query });
  const repo = (source?: { owner: string; repo: string } | null) => source ? { owner: source.owner, repo: source.repo } : {};
  return {
    authStatus: () => get<GitHubAuthStatus>('auth/status'),
    issuesList: (directory, options) => get('issues/list', { directory, page: options?.page, query: options?.query }),
    prsList: (directory, options) => get('pulls/list', { directory, page: options?.page, query: options?.query }),
    issueGet: (directory, number, options) => get('issues/get', { directory, number, ...repo(options?.sourceRepo) }),
    issueComments: (directory, number, options) => get('issues/comments', { directory, number, ...repo(options?.sourceRepo) }),
    prContext: (directory, number, options) => get('pulls/context', { directory, number, ...repo(options?.sourceRepo),
      diff: options?.includeDiff ? '1' : undefined, checkDetails: options?.includeCheckDetails ? '1' : undefined }),
  };
}

const worktreeGitHubAuthOptions = (entry: HostRuntimeEntry) => ({
  queryKey: [...entry.queryScope, 'worktree-dialog', 'github-auth'],
  queryFn: ({ signal }: { signal: AbortSignal }) => captureProjectScope(entry).json<GitHubAuthStatus>('/api/github/auth/status', { signal }),
  staleTime: 30_000,
  gcTime: Infinity,
});

export function useWorktreeGitHub(entry: HostRuntimeEntry | undefined, open: boolean) {
  const runtime = useRuntimeAPIs();
  const localGitHub = entry ? undefined : runtime.github;
  const github = useMemo(() => entry ? createWorktreeGitHubReads(entry) : localGitHub, [entry, localGitHub]);
  const auth = useQuery<GitHubAuthStatus>({ ...(entry ? worktreeGitHubAuthOptions(entry) : githubAuthQueryOptions(runtime.github)), enabled: open }, queryClient);
  return { github, auth };
}

export async function renderRemoteWorktreePrompt(entry: HostRuntimeEntry, id: MagicPromptId, variables: Record<string, string> = {}) {
  const payload = await captureProjectScope(entry).json<{ overrides?: Record<string, string> }>('/api/magic-prompts');
  const template = typeof payload.overrides?.[id] === 'string' ? payload.overrides[id] : getDefaultMagicPromptTemplate(id);
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_match, key: string) => Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] ?? '' : '');
}

export async function sendRemoteWorktreeContext(registry: HostRuntimeRegistry, source: HostRuntimeEntry, directory: string, sessionID: string,
  linked: { issue: GitHubIssue | null; pr: GitHubPullRequestSummary | null; includeDiff: boolean }, failureMessage: string) {
  const github = createWorktreeGitHubReads(source);
  const issue = linked.issue;
  const pr = linked.pr;
  if (!issue && !pr) return;
  const kind = issue ? 'issue' : 'pr';
  const number = issue?.number ?? pr!.number;
  const visible = await renderRemoteWorktreePrompt(source, `github.${kind}.review.visible`, { [`${kind}_number`]: String(number) });
  const instructions = await renderRemoteWorktreePrompt(source, `github.${kind}.review.instructions`);
  let context: string;
  if (issue) {
    const data = await github.issueGet(source.location.directory, number, { sourceRepo: issue.sourceRepo });
    const comments = await github.issueComments(source.location.directory, number, { sourceRepo: issue.sourceRepo });
    if (data.connected === false || !data.issue || comments.connected === false) throw new Error(failureMessage);
    context = `GitHub issue context (JSON)\n${JSON.stringify({ repo: data.repo ?? null, issue: data.issue, comments: comments.comments ?? [] }, null, 2)}`;
  } else {
    const data = await github.prContext(source.location.directory, number, { sourceRepo: pr!.sourceRepo, includeDiff: linked.includeDiff, includeCheckDetails: false });
    if (data.connected === false || !data.pr) throw new Error(failureMessage);
    context = `GitHub pull request context (JSON)\n${JSON.stringify(data, null, 2)}`;
  }
  source.sdk();
  const entry = registry.resolve({ ...source.location, directory });
  await getRemoteChatOwner(registry, entry).state.send({ sessionID, messageID: ascendingId('msg'), text: [visible, instructions, context].join('\n\n') });
}
