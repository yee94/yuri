/**
 * Pure helpers for DraftSessionBranchSelector branch Query scope.
 *
 * Branch *lists* are repo-wide and should stay keyed to the project root so
 * switching the selected worktree does not drop a warm list while the
 * worktree's `isGitRepo` probe is still null.
 *
 * Current-branch / checkout still target the selected directory.
 */

export const resolveDraftBranchListDirectory = (
  projectDirectory: string | null | undefined,
  selectedDirectory: string | null | undefined,
): string | null => projectDirectory ?? selectedDirectory ?? null;

/**
 * Enable branch list queries unless we authoritatively know the path is not a
 * git repo. Unknown (`null`) must stay enabled so a worktree switch cannot
 * clear lists while the store probe is still in-flight.
 */
export const canQueryDraftGitBranches = (
  directory: string | null | undefined,
  isGitRepo: boolean | null,
): boolean => Boolean(directory) && isGitRepo !== false;

import { normalizePath } from '@/lib/pathNormalization';
import { sortBranchesByRecency, type BranchRecencySource } from '@/lib/worktrees/branchSearch';
import type { WorktreeMetadata } from '@/types/worktree';
import type { BranchSelectorWorktreeOption } from '@/components/views/git/BranchSelector';

export const normalizeDraftBranchRef = (branch: string): string => (
  branch.replace(/^remotes\//, '').replace(/^refs\/heads\//, '').trim()
);

const candidateBranchNamesForLookup = (
  branch: string,
  remoteNames: readonly string[] = [],
): string[] => {
  const normalized = normalizeDraftBranchRef(branch);
  if (!normalized) return [];
  const candidates = [normalized];
  const knownRemotes = remoteNames.length > 0 ? remoteNames : ['origin'];
  for (const remoteName of knownRemotes) {
    const prefix = `${remoteName}/`;
    if (normalized.startsWith(prefix)) {
      const stripped = normalized.slice(prefix.length).trim();
      if (stripped && !candidates.includes(stripped)) {
        candidates.push(stripped);
      }
    }
  }
  return candidates;
};

export const mergeDraftWorktreeOptions = (
  worktreeOptions: readonly BranchSelectorWorktreeOption[],
  discoveredWorktrees: readonly Pick<WorktreeMetadata, 'path' | 'branch' | 'label'>[],
): BranchSelectorWorktreeOption[] => {
  const merged: BranchSelectorWorktreeOption[] = [];
  const seen = new Set<string>();
  for (const option of worktreeOptions) {
    const key = normalizePath(option.value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push(option);
  }
  for (const worktree of discoveredWorktrees) {
    const key = normalizePath(worktree.path);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    merged.push({
      value: worktree.path,
      label: worktree.branch?.trim() || worktree.label?.trim() || worktree.path,
    });
  }
  return merged;
};

export const collectExistingWorktreeBranchNames = (
  discoveredWorktrees: readonly Pick<WorktreeMetadata, 'path' | 'branch' | 'label'>[],
  worktreeOptions: readonly BranchSelectorWorktreeOption[],
  projectRootOption?: BranchSelectorWorktreeOption | null,
): Set<string> => {
  const branches = new Set<string>();
  for (const worktree of discoveredWorktrees) {
    const branch = normalizeDraftBranchRef(worktree.branch || '');
    if (branch) branches.add(branch);
  }
  for (const option of worktreeOptions) {
    const label = normalizeDraftBranchRef(option.label || '');
    if (label) branches.add(label);
  }
  if (projectRootOption?.label) {
    const rootBranch = normalizeDraftBranchRef(projectRootOption.label);
    if (rootBranch) branches.add(rootBranch);
  }
  return branches;
};

export const findExistingWorktreePathForBranch = ({
  branch,
  discoveredWorktrees,
  worktreeOptions,
  projectRootOption,
  remoteNames = [],
}: {
  branch: string;
  discoveredWorktrees: readonly Pick<WorktreeMetadata, 'path' | 'branch' | 'label'>[];
  worktreeOptions: readonly BranchSelectorWorktreeOption[];
  projectRootOption?: BranchSelectorWorktreeOption | null;
  remoteNames?: readonly string[];
}): string | null => {
  const candidates = candidateBranchNamesForLookup(branch, remoteNames);
  if (candidates.length === 0) return null;

  for (const worktree of discoveredWorktrees) {
    const wtBranch = normalizeDraftBranchRef(worktree.branch || '');
    if (wtBranch && candidates.includes(wtBranch)) {
      return worktree.path;
    }
  }

  for (const option of worktreeOptions) {
    const optionBranch = normalizeDraftBranchRef(option.label || '');
    if (optionBranch && candidates.includes(optionBranch)) {
      return option.value;
    }
  }

  if (projectRootOption) {
    const rootBranch = normalizeDraftBranchRef(projectRootOption.label || '');
    if (rootBranch && candidates.includes(rootBranch)) {
      return projectRootOption.value;
    }
  }

  return null;
};

export const splitGitBranchList = (
  all: string[] | null | undefined,
  options?: {
    currentBranch?: string | null;
    branchRecency?: ReadonlyMap<string, number> | Record<string, BranchRecencySource> | null;
  },
): {
  localBranches: string[];
  remoteBranches: string[];
} => {
  if (!all?.length) {
    return { localBranches: [], remoteBranches: [] };
  }
  const rawLocal = all.filter((branchName) => !branchName.startsWith('remotes/'));
  const rawRemote = all
    .filter((branchName) => branchName.startsWith('remotes/'))
    .map((branchName) => branchName.replace(/^remotes\//, ''));

  if (!options?.branchRecency && !options?.currentBranch) {
    return {
      localBranches: rawLocal.sort(),
      remoteBranches: rawRemote.sort(),
    };
  }

  return {
    localBranches: sortBranchesByRecency({
      branches: rawLocal,
      source: 'local',
      currentBranch: options.currentBranch,
      branchRecency: options.branchRecency,
    }),
    remoteBranches: sortBranchesByRecency({
      branches: rawRemote,
      source: 'remote',
      branchRecency: options.branchRecency,
    }),
  };
};
