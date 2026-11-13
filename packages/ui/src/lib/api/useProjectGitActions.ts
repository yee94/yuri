import { useMemo } from 'react';
import * as local from '@/lib/gitApi';
import { useProjectRuntimeAPIs } from './useProjectRuntimeAPIs';
import { captureProjectScope } from './project-scope';

export function useProjectGitActions() {
  const { git, projectScope } = useProjectRuntimeAPIs();
  return useMemo(() => {
    if (!projectScope) return local;
    const scope = captureProjectScope(projectScope);
    return { ...local, ...git,
      getCommitFileDiff: git.getCommitFileDiff!,
      getGitWorktreeBootstrapStatus: git.getGitWorktreeBootstrapStatus!,
      getGitCommitSummaries: async (directory: string, shas: string[]) => {
        const result = await scope.json<{ commits: Array<{ sha: string; short: string; subject: string }> }>('/api/git/commit-summaries', {
          method: 'POST', query: { directory }, headers: { 'Content-Type': 'application/json', 'x-opencode-directory': directory },
          body: JSON.stringify({ shas }),
        });
        return result.commits;
      },
    };
  }, [git, projectScope]);
}
