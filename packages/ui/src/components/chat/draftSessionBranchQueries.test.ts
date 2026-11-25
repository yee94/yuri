import { describe, expect, test } from 'bun:test';
import {
  canQueryDraftGitBranches,
  collectExistingWorktreeBranchNames,
  findExistingWorktreePathForBranch,
  mergeDraftWorktreeOptions,
  resolveDraftBranchListDirectory,
  splitGitBranchList,
} from './draftSessionBranchQueries';

describe('resolveDraftBranchListDirectory', () => {
  test('prefers the project root so worktree selection keeps the shared list scope', () => {
    expect(resolveDraftBranchListDirectory(
      '/repo',
      '/repo/.worktrees/feat-a',
    )).toBe('/repo');
  });

  test('falls back to the selected directory when project root is unknown', () => {
    expect(resolveDraftBranchListDirectory(null, '/repo/.worktrees/feat-a'))
      .toBe('/repo/.worktrees/feat-a');
  });
});

describe('canQueryDraftGitBranches', () => {
  test('stays enabled while the repo probe is still null (worktree switch race)', () => {
    // Regression: DraftSessionBranchSelector used `isGitRepo === true`, which
    // disabled the Query after selecting a worktree and painted empty lists.
    expect(canQueryDraftGitBranches('/repo/.worktrees/feat-a', null)).toBe(true);
    expect(canQueryDraftGitBranches('/repo', null)).toBe(true);
  });

  test('enables known git directories and disables non-git directories', () => {
    expect(canQueryDraftGitBranches('/repo', true)).toBe(true);
    expect(canQueryDraftGitBranches('/not-git', false)).toBe(false);
  });

  test('disables empty directories', () => {
    expect(canQueryDraftGitBranches(null, null)).toBe(false);
    expect(canQueryDraftGitBranches('', true)).toBe(false);
  });
});

describe('splitGitBranchList', () => {
  test('splits and sorts local vs remote refs', () => {
    expect(splitGitBranchList([
      'main',
      'feat/a',
      'remotes/origin/main',
      'remotes/origin/feat/a',
    ])).toEqual({
      localBranches: ['feat/a', 'main'],
      remoteBranches: ['origin/feat/a', 'origin/main'],
    });
  });

  test('returns empty lists when the authoritative payload is missing', () => {
    expect(splitGitBranchList(undefined)).toEqual({ localBranches: [], remoteBranches: [] });
    expect(splitGitBranchList([])).toEqual({ localBranches: [], remoteBranches: [] });
  });

  test('sorts local and remote branches by recency when branchRecency is provided', () => {
    const now = Date.now();
    const branchRecency = new Map<string, number>([
      ['feat/recent', now - 1_000],
      ['remotes/origin/feat/remote-recent', now - 2_000],
    ]);
    expect(splitGitBranchList([
      'main',
      'feat/old',
      'feat/recent',
      'remotes/origin/a-old',
      'remotes/origin/feat/remote-recent',
    ], {
      currentBranch: 'main',
      branchRecency,
    })).toEqual({
      localBranches: ['main', 'feat/recent', 'feat/old'],
      remoteBranches: ['origin/feat/remote-recent', 'origin/a-old'],
    });
  });
});

describe('existing worktree discovery helpers', () => {
  test('matches local and remote branch refs to discovered worktrees without colliding on slash tails', () => {
    const discoveredWorktrees = [
      { path: '/wt/feat-sidebar', branch: 'feat/sidebar', label: 'feat-sidebar' },
    ];
    expect(findExistingWorktreePathForBranch({
      branch: 'feat/sidebar',
      discoveredWorktrees,
      worktreeOptions: [],
    })).toBe('/wt/feat-sidebar');
    expect(findExistingWorktreePathForBranch({
      branch: 'origin/feat/sidebar',
      discoveredWorktrees,
      worktreeOptions: [],
      remoteNames: ['origin'],
    })).toBe('/wt/feat-sidebar');
    // Must not falsely match fix/sidebar to feat/sidebar.
    expect(findExistingWorktreePathForBranch({
      branch: 'fix/sidebar',
      discoveredWorktrees,
      worktreeOptions: [],
    })).toBeNull();
  });

  test('matches projectRootOption when switching back to the root checkout branch', () => {
    expect(findExistingWorktreePathForBranch({
      branch: 'main',
      discoveredWorktrees: [],
      worktreeOptions: [],
      projectRootOption: { value: '/repo', label: 'main' },
    })).toBe('/repo');
  });

  test('merges worktree options without duplicating normalized paths and collects branch badges', () => {
    const merged = mergeDraftWorktreeOptions(
      [{ value: '/wt/a/', label: 'feat/a', pending: true }],
      [
        { path: '/wt/a', branch: 'feat/a', label: 'a' },
        { path: '/wt/b', branch: 'feat/b', label: 'b' },
      ],
    );
    expect(merged).toEqual([
      { value: '/wt/a/', label: 'feat/a', pending: true },
      { value: '/wt/b', label: 'feat/b' },
    ]);

    const badges = collectExistingWorktreeBranchNames(
      [{ path: '/wt/b', branch: 'feat/b', label: 'b' }],
      [{ value: '/wt/a', label: 'feat/a' }],
      { value: '/repo', label: 'main' },
    );
    expect([...badges].sort()).toEqual(['feat/a', 'feat/b', 'main']);
  });
});
