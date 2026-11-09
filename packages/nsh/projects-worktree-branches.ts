import { rankBranchesForQuery } from '../ui/src/lib/worktrees/branchSearch';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';

/** Web owns relevance and canonical remote values; Native only adapts group labels. */
export function worktreeBranchResults(branches: readonly string[], query: string, translate: (key: I18nKey) => string) {
  const localBranches = branches.filter(value => !value.startsWith('remotes/')).sort();
  const remoteBranches = branches.filter(value => value.startsWith('remotes/')).map(value => value.replace(/^remotes\//, '')).sort();
  const ranked = rankBranchesForQuery({ localBranches, remoteBranches, query });
  const searched = !!query.trim();
  return {
    noMatches: searched && ranked.matching.length === 0 && branches.length > 0,
    items: [
      ...ranked.matching.map(item => ({ value: item.value, title: item.label, group: translate('session.newWorktree.matchingBranches') })),
      ...ranked.otherLocal.map(value => ({ value, title: value, group: translate(searched ? 'session.newWorktree.otherLocalBranches' : 'session.newWorktree.localBranches') })),
      ...ranked.otherRemote.map(value => ({ value: `remotes/${value}`, title: value, group: translate(searched ? 'session.newWorktree.otherRemoteBranches' : 'session.newWorktree.remoteBranches') })),
    ],
  };
}
