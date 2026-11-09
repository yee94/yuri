import { getMutationBlockingReasons, getSessionWorktreeRepairActions } from '../ui/src/sync/session-worktree-contract';
import type { DesktopPanelScope } from './desktop-panel-model';
import { resourcePath } from './resources-model';
import { canonicalFrom, type GitCanonicalWorktree } from './desktop-git-protocol';

export type DesktopGitWorktreeState = Readonly<{
  scopeKey: string;
  attachment: GitCanonicalWorktree | null;
  loading: boolean;
  error: string;
}>;
const scopeKey = (scope: DesktopPanelScope) => JSON.stringify([scope.host.hostID, scope.authorityKey, resourcePath(scope.directory), scope.sessionID ?? null]);

/** Read-only projection for the existing parent authority. No request, fallback
 * directory, path containment, store, stream, canonicalize POST or repair action.
 * Pass undefined only when there is no session attachment (as in Web GitView).
 * A requested-but-unresolved attachment must instead be loading/error/null. */
export function desktopGitWorktreeState(scope: DesktopPanelScope, snapshot: { value: unknown; loading?: boolean; error?: string }): DesktopGitWorktreeState {
  try {
    return { scopeKey: scopeKey(scope), attachment: snapshot.value == null ? null : canonicalFrom(snapshot.value), loading: snapshot.loading === true, error: snapshot.error || '' };
  } catch {
    return { scopeKey: scopeKey(scope), attachment: null, loading: false, error: 'gitView.toast.refreshRepositoryFailed' };
  }
}

export function resolveDesktopGitWorktree(scope: DesktopPanelScope, authority: DesktopGitWorktreeState | undefined, inspected: GitCanonicalWorktree | null = null, authorityRequired = false) {
  const mismatch = !!authority && authority.scopeKey !== scopeKey(scope);
  const attachment = authority ? mismatch ? null : authority.attachment : authorityRequired ? null : inspected;
  const unavailable = !authority && authorityRequired || !!authority && (mismatch || authority.loading || !!authority.error || !authority.attachment);
  const shared = attachment ? { ...attachment, worktreeSource: null } : null;
  return {
    attachment,
    unavailable,
    pending: !mismatch && attachment?.worktreeStatus === 'pending',
    error: mismatch ? 'gitView.toast.refreshRepositoryFailed' : authority?.error || '',
    blockingReasons: getMutationBlockingReasons(shared),
    // GitView.tsx:1848 is text only, despite the helper's historical action name.
    featuresUnavailable: shared ? getSessionWorktreeRepairActions(shared).includes('open-without-worktree-features') : false,
  };
}

/** Local HEAD/index transitions must not start a second operation. Web's branch
 * handlers use getMutationBlockingReasons(attachment), WITHOUT dirty status.
 * HistoryCommitRow/backend Git retain their own dirty/conflict validation.
 * PR create/update/ready/merge are remote GitHub operations: local attention or
 * dirty files are not their mergeability/permission authority. */
const attentionSensitive = new Set([
  'branch', 'rename', 'checkout', 'deleteBranch', 'checkoutCommit', 'cherryPick', 'revertCommit', 'reset',
  'merge', 'rebase', 'pull', 'stashApply', 'stashPop', 'integratePlan', 'integrateRun',
]);
export function desktopGitWorktreeBlock(kind: string, state: ReturnType<typeof resolveDesktopGitWorktree>, operation: 'merge' | 'rebase' | null = null): string | null {
  if (state.pending) return 'gitView.empty.worktreeSetupInProgress';
  if (state.unavailable) return state.error || 'gitView.toast.refreshRepositoryFailed';
  if (state.attachment?.worktreeStatus === 'not-a-repo') return 'gitView.empty.notGitRepository';
  if (state.blockingReasons.some(reason => reason.reason === 'missing' || reason.reason === 'invalid')) return 'gitView.empty.worktreeFeaturesUnavailable';
  if (attentionSensitive.has(kind) && (operation || state.blockingReasons.some(reason => reason.reason === 'attention'))) return 'gitView.operation.resolveConflictsHint';
  return null;
}
