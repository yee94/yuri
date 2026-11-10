export interface WorktreeMetadata {

  /**
   * Worktree origin.
   * - sdk: created/managed by OpenCode SDK worktrees
   */
  source?: 'sdk';

  /** Yuri project working directory in this checkout, including its relative subdirectory. */
  path: string;

  projectDirectory: string;

  branch: string;

  label: string;

  /** SDK worktree name (slug), if available. */
  name?: string;

  kind?: 'pr' | 'standard';

  /**
   * Branch/ref this worktree was created from (intended integration target).
   * For SDK worktrees this is typically the user-selected base branch.
   */
  createdFromBranch?: string;

  /** Project directory relative to the Git checkout root; absent for repository-root projects. */
  relativePath?: string;

  status?: {
    isDirty: boolean;
    ahead?: number;
    behind?: number;
    upstream?: string | null;
  };

  // --- Phase 1: canonical worktree attachment fields ---

  /** Canonical Git checkout root; path may point to a project subdirectory within it. */
  worktreeRoot?: string;

  /** Operational status of this worktree. */
  worktreeStatus?: 'pending' | 'ready' | 'missing' | 'invalid' | 'not-a-repo';

  /** Git HEAD state classification. */
  headState?: 'branch' | 'detached' | 'unborn';

  /** How this worktree was attached to a session. */
  worktreeSource?: 'existing' | 'created-for-session';
}
