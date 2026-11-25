import { describe, expect, test } from 'vitest';

import {
  rankBranchesForQuery,
  sortBranchesByRecency,
} from './branchSearch';

describe('rankBranchesForQuery', () => {
  test('ranks exact origin/master first instead of alphabetical noise', () => {
    const result = rankBranchesForQuery({
      localBranches: [
        'backup/feat-effect-refactor-pre-master-1e558c6c-20260625-183700',
        'codex/master-update-review-20260702',
        'compare/master-features',
        'master',
      ],
      remoteBranches: [
        'origin/backup_mbizwxaaigent_a2a_phase_1',
        'origin/codex/master-update-review-20260702',
        'origin/d14-eval',
        'origin/master',
      ],
      query: 'origin/master',
    });

    expect(result.matching[0]).toEqual({
      label: 'origin/master',
      value: 'remotes/origin/master',
      source: 'remote',
    });
  });

  test('prefers local exact match over remote when both match equally', () => {
    const result = rankBranchesForQuery({
      localBranches: ['main'],
      remoteBranches: ['origin/main'],
      query: 'main',
    });

    expect(result.matching.map((branch) => branch.value)).toEqual([
      'main',
      'remotes/origin/main',
    ]);
  });

  test('keeps non-matching branches in other groups when query is active', () => {
    const result = rankBranchesForQuery({
      localBranches: ['main', 'feature/foo'],
      remoteBranches: ['origin/main', 'origin/bar'],
      query: 'main',
    });

    expect(result.matching.map((branch) => branch.label)).toEqual(['main', 'origin/main']);
    expect(result.otherLocal).toEqual(['feature/foo']);
    expect(result.otherRemote).toEqual(['origin/bar']);
  });

  test('returns full local/remote lists when query is empty', () => {
    const result = rankBranchesForQuery({
      localBranches: ['main', 'dev'],
      remoteBranches: ['origin/main'],
      query: '   ',
    });

    expect(result.matching).toEqual([]);
    expect(result.otherLocal).toEqual(['main', 'dev']);
    expect(result.otherRemote).toEqual(['origin/main']);
  });

  test('boosts recently used branches above older equally matching branches', () => {
    const now = Date.now();
    const recency = new Map<string, number>([
      ['feat/sidebar-legacy', now - 120 * 24 * 60 * 60 * 1000],
      ['feat/sidebar-recent', now - 5 * 60 * 1000],
      ['feat/sidebar-medium', now - 3 * 24 * 60 * 60 * 1000],
    ]);

    const result = rankBranchesForQuery({
      localBranches: ['feat/sidebar-legacy', 'feat/sidebar-medium', 'feat/sidebar-recent'],
      remoteBranches: [],
      query: 'sidebar',
      branchRecency: recency,
    });

    expect(result.matching.map((branch) => branch.label)).toEqual([
      'feat/sidebar-recent',
      'feat/sidebar-medium',
      'feat/sidebar-legacy',
    ]);
  });

  test('supports multi-token and subsequence queries across large branch catalogs', () => {
    const now = Date.now();
    const localBranches = Array.from({ length: 2500 }, (_, i) => `archive/branch-${i}`);
    localBranches.push('feat/flat-sidebar-worktree', 'feat/sidebar-flat-picker');
    const recency = new Map<string, number>([
      ['feat/sidebar-flat-picker', now - 60_000],
      ['feat/flat-sidebar-worktree', now - 10 * 24 * 60 * 60 * 1000],
    ]);

    const multiToken = rankBranchesForQuery({
      localBranches,
      remoteBranches: ['origin/feat/flat-sidebar-worktree'],
      query: 'feat sidebar',
      branchRecency: recency,
    });
    expect(multiToken.matching[0]?.label).toBe('feat/sidebar-flat-picker');
    expect(multiToken.matching.some((entry) => entry.label === 'feat/flat-sidebar-worktree')).toBe(true);

    const subsequence = rankBranchesForQuery({
      localBranches,
      remoteBranches: [],
      query: 'fsw',
      branchRecency: recency,
    });
    expect(subsequence.matching.some((entry) => entry.label === 'feat/flat-sidebar-worktree')).toBe(true);
  });

  test('sortBranchesByRecency places current branch first, then most recently used, then alphabetical', () => {
    const now = Date.now();
    const recency = new Map<string, number>([
      ['feat/b', now - 1_000],
      ['feat/a', now - 60_000],
    ]);

    expect(
      sortBranchesByRecency({
        branches: ['z-branch', 'feat/a', 'main', 'feat/b', 'a-branch'],
        currentBranch: 'main',
        branchRecency: recency,
      }),
    ).toEqual(['main', 'feat/b', 'feat/a', 'a-branch', 'z-branch']);
  });
});
