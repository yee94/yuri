import * as React from 'react';
import type { Session } from '@/lib/opencode/v2-types';

import {
  derivePinnedSessions,
  PINNED_SESSION_ORDER_SCOPE,
} from '@/components/session/sidebar/pinnedSessions';
import { useRunningSessionIds } from '@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds';
import { useRunStartTimes } from '@/components/session/sidebar/taskRunElapsed';
import {
  deriveTaskBuckets,
  isTaskViewSession,
} from '@/components/session/sidebar/taskView';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { formatPathForDisplay } from '@/lib/utils';
import { usePinnedSessionIds } from '@/queries/sessionIndexPinQueries';
import { useSettledSessionIds, useTaskIndexMembership } from '@/queries/sessionIndexSettleQueries';
import { useGitRepoStatusMap, useGitStore } from '@/stores/useGitStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useNotificationStore } from '@/sync/notification-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionIdsWithPendingRequests } from '@/sync/sync-context';

import type { MobileTaskNode } from './MobileTaskCard';
import type { PinnedItem } from '@/components/session/sidebar/SidebarPinnedSessions';
import {
  findExactWorktreeMatch,
  formatRelativeShort,
  getSessionDirectory,
  getSessionTimestamp,
  type MobileProjectsHomeModel,
} from './useMobileProjectsHomeModel';

const sameMobileTaskNode = (a: MobileTaskNode, b: MobileTaskNode): boolean => (
  a.id === b.id
  && a.title === b.title
  && a.directory === b.directory
  && a.projectLabel === b.projectLabel
  && a.project === b.project
  && a.branch === b.branch
  && a.branchState === b.branchState
  && a.pathLabel === b.pathLabel
  && a.activityLabel === b.activityLabel
  && a.unread === b.unread
  && a.pinned === b.pinned
  && a.active === b.active
);

const EMPTY_PATHS: string[] = [];

/** Worktree branch wins, then the project's current branch; detached HEAD and a branch named like the project are noise. */
const resolveTaskBranch = (
  worktreeBranch: string | null | undefined,
  rootBranch: string | null | undefined,
  projectLabel: string | undefined,
): string | undefined => {
  const branch = (worktreeBranch ?? rootBranch)?.trim();
  return branch && branch !== 'HEAD' && branch !== projectLabel ? branch : undefined;
};

/** Task view tabs: every open task, only unread open tasks, or Archived. */
export type MobileTaskStatus = 'active' | 'unread' | 'archived';

export type MobileTaskViewModel = {
  /** Rows of the selected tab; Archived is cut to the current page. */
  items: MobileTaskNode[];
  /** Rows matching the selected tab before paging. */
  total: number;
  runStartTimes: ReadonlyMap<string, number>;
  remoteContent?: ReadonlyMap<string, React.ReactNode>;
};

/**
 * Task-view projection of the mobile home model. Bucketing is the shared
 * `deriveTaskBuckets` (same Host settled projection as the desktop sidebar);
 * this only maps the buckets to presentational card nodes.
 */
export function useMobileTaskViewModel(
  model: Pick<MobileProjectsHomeModel, 'allSessions' | 'ownership' | 'projectMetaById'>,
  options: { enabled: boolean; status: MobileTaskStatus; settledLimit: number; remoteTasks?: readonly PinnedItem[] },
): MobileTaskViewModel | null {
  const { enabled, status, settledLimit, remoteTasks } = options;
  const { t } = useI18n();
  const pinnedSessionIds = usePinnedSessionIds();
  const settledIds = useSettledSessionIds();
  const indexMembership = useTaskIndexMembership();
  const runningSessionIds = useRunningSessionIds({ enabled });
  const pendingRequestSessionIds = useSessionIdsWithPendingRequests();
  const unseenBySession = useNotificationStore((state) => state.index.session.unseenCount);
  const pinnedOrder = useSessionFoldersStore((state) => state.sessionOrderByScope[PINNED_SESSION_ORDER_SCOPE]);
  const registryProjects = useProjectsStore((state) => state.projects);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const runStartTimes = useRunStartTimes(runningSessionIds, enabled);
  const previousNodesRef = React.useRef<Map<string, MobileTaskNode>>(new Map());

  // A task shows the branch of the checkout it runs in: its linked worktree
  // branch, or else the project root's current branch. Git status is read from
  // the shared git store and requested on demand while the task view is open.
  const { git } = useRuntimeAPIs();
  const ensureStatus = useGitStore((state) => state.ensureStatus);
  const projectPaths = React.useMemo(
    () => (enabled ? [...model.projectMetaById.values()].map((meta) => meta.path) : EMPTY_PATHS),
    [enabled, model.projectMetaById],
  );
  const gitStatus = useGitRepoStatusMap(projectPaths);
  React.useEffect(() => {
    if (!enabled || !git) return;
    for (const path of projectPaths) void ensureStatus(path, git);
  }, [enabled, ensureStatus, git, projectPaths]);

  return React.useMemo(() => {
    if (!enabled) return null;
    const remoteById = new Map((remoteTasks ?? []).map((item) => [item.node.session.id, item]));
    const unseen = { ...unseenBySession };
    const remoteOpen: Session[] = [];
    const remotePinned: Session[] = [];
    for (const [id, item] of remoteById) {
      unseen[id] = item.remoteStatus?.unread ?? 0;
      (item.pinned ? remotePinned : remoteOpen).push(item.node.session);
    }
    const buckets = deriveTaskBuckets({
      sessions: model.allSessions,
      pinnedSessionIds,
      settledSessionIds: settledIds,
      indexedSessionIds: indexMembership?.indexedIds ?? null,
      settledAtBySessionId: indexMembership?.settledAtById,
      runningSessionIds,
      pendingRequestSessionIds,
      unseenBySession: unseen,
      remoteSessions: remoteOpen,
    });
    const pinnedSessions = derivePinnedSessions([...model.allSessions, ...remotePinned],
      new Set([...pinnedSessionIds, ...remotePinned.map(({ id }) => id)]), pinnedOrder)
      .filter(isTaskViewSession);
    const colorByProjectId = new Map(registryProjects.map((project) => [project.id, project.color ?? undefined]));
    const untitled = t('mobile.sessions.untitled');
    const unassigned = t('sessions.sidebar.task.unassigned');
    const previous = previousNodesRef.current;
    const next = new Map<string, MobileTaskNode>();
    const toNode = (session: Session, pinned: boolean): MobileTaskNode => {
      const remote = remoteById.get(session.id);
      if (remote) return {
        id: session.id, title: session.title?.trim() || untitled,
        projectLabel: remote.secondaryMeta?.projectLabel ?? unassigned, project: null,
        unread: unseen[session.id] > 0, pinned: Boolean(remote.pinned), active: false,
      };
      const owner = model.ownership.bySessionId.get(session.id);
      const meta = owner ? model.projectMetaById.get(owner.projectId) : undefined;
      const worktree = meta && owner?.kind === 'worktree'
        ? findExactWorktreeMatch(meta, owner.scopeDirectory)
        : null;
      const projectGit = meta ? gitStatus.get(meta.path) : undefined;
      const branch = resolveTaskBranch(worktree?.branch, projectGit?.branch, meta?.label);
      const branchState = branch ? null : !meta || projectGit?.isGitRepo === false ? 'no-git' : 'loading';
      const candidate: MobileTaskNode = {
        id: session.id,
        title: session.title?.trim() || untitled,
        directory: getSessionDirectory(session),
        projectLabel: meta?.label || unassigned,
        project: meta
          ? { id: meta.id, icon: meta.icon ?? undefined, color: colorByProjectId.get(meta.id), iconImage: meta.iconImage ?? undefined }
          : null,
        branch,
        branchState,
        pathLabel: branchState === 'no-git' && meta ? formatPathForDisplay(meta.path, homeDirectory) : undefined,
        activityLabel: formatRelativeShort(getSessionTimestamp(session)) || undefined,
        unread: (unseenBySession[session.id] ?? 0) > 0,
        pinned,
        active: currentSessionId === session.id,
      };
      const prior = previous.get(session.id);
      const node = prior && sameMobileTaskNode(prior, candidate) && prior.project?.iconImage === candidate.project?.iconImage
        ? prior
        : candidate;
      next.set(session.id, node);
      return node;
    };
    const isUnread = (session: Session): boolean => (unseen[session.id] ?? 0) > 0;
    const open = [...pinnedSessions, ...buckets.active];
    const scoped = status === 'archived' ? buckets.settled : open;
    const matching = status === 'unread' ? scoped.filter(isUnread) : scoped;
    const visible = status === 'archived' ? matching.slice(0, settledLimit) : matching;
    const result = {
      items: visible.map((session) => toNode(session, pinnedSessionIds.has(session.id))),
      total: matching.length,
      runStartTimes,
      remoteContent: new Map([...remoteById].map(([id, item]) => [id, item.content])),
    };
    previousNodesRef.current = next;
    return result;
  }, [
    currentSessionId,
    enabled,
    gitStatus,
    homeDirectory,
    indexMembership,
    model.allSessions,
    model.ownership,
    model.projectMetaById,
    pendingRequestSessionIds,
    pinnedOrder,
    pinnedSessionIds,
    registryProjects,
    remoteTasks,
    runStartTimes,
    runningSessionIds,
    settledIds,
    settledLimit,
    status,
    t,
    unseenBySession,
  ]);
}
