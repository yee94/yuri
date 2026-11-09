import { expect, test } from 'vitest';
import { normalizeBranchName, slugifyWorktreeName } from './worktreeNames';

test.each([
  [' refs/heads/feature/my branch/ ', 'feature/my-branch', 'feature-my-branch'],
  ['heads/topic//nested', 'topic//nested', 'topic-nested'],
  ['remotes/origin/release', 'remotes/origin/release', 'remotes-origin-release'],
  [' /中文 feature/_name.v2/ ', '中文-feature/_name.v2', 'feature-_name.v2'],
  ['', '', ''],
])('shared worktree input normalization: %s', (input, branch, directory) => {
  expect(normalizeBranchName(input)).toBe(branch);
  expect(slugifyWorktreeName(input)).toBe(directory);
});
test('directory slugs retain the existing eighty-character bound without truncating branch names', () => {
  expect(slugifyWorktreeName('a'.repeat(100))).toHaveLength(80);
  expect(normalizeBranchName('a'.repeat(100))).toHaveLength(100);
});
