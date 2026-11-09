import { expect, test } from 'vitest';
import { worktreeBranchResults } from './projects-worktree-branches';

const t = (key: string) => key;
test('remote exact relevance leads with canonical value, retaining all other branches', () => {
  const branches = ['noise', 'main', 'feature/main', 'remotes/origin/main', 'remotes/origin/unrelated'];
  const result = worktreeBranchResults(branches, 'origin/main', t);
  expect(result.items[0]).toEqual({ value: 'remotes/origin/main', title: 'origin/main', group: 'session.newWorktree.matchingBranches' });
  expect(result.items.map(item => item.value).sort()).toEqual([...branches].sort());
  expect(result.noMatches).toBe(false);
});
test('fuzzy typo matches Web scoring instead of substring-only filtering', () => {
  const result = worktreeBranchResults(['main', 'remotes/origin/release'], 'origin/releaze', t);
  expect(result.items[0].value).toBe('remotes/origin/release');
  expect(result.items[0].group).toBe('session.newWorktree.matchingBranches');
});
test('no match retains other groups; a successful empty catalog is not a search miss', () => {
  const result = worktreeBranchResults(['main', 'remotes/origin/main'], 'zzzzzzzzzzzz', t);
  expect(result.noMatches).toBe(true);
  expect(result.items.map(item => item.group)).toEqual(['session.newWorktree.otherLocalBranches', 'session.newWorktree.otherRemoteBranches']);
  expect(worktreeBranchResults([], 'zzzzzzzzzzzz', t)).toEqual({ noMatches: false, items: [] });
});
test('unsearched groups sort without mutating the authoritative catalog', () => {
  const branches = ['z', 'a', 'remotes/z/main', 'remotes/a/main'];
  expect(worktreeBranchResults(branches, ' ', t).items.map(item => item.value)).toEqual(['a', 'z', 'remotes/a/main', 'remotes/z/main']);
  expect(branches[0]).toBe('z');
});
