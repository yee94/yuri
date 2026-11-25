import React from 'react';
import type { Session } from '@/lib/opencode/v2-types';
import type { WorktreeMetadata } from '@/types/worktree';
import type { SessionGroup, SessionNode } from '../types';
import {
  getArchivedScopeKey,
  normalizePath,
} from '../utils';
import { formatPathForDisplay } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { buildSessionTree } from '../sessionTree';
import { formatWorktreeFooterLabel, sessionWorktreeToMetadata } from '@/lib/worktrees/sessionWorktreeMetadata';

type Args = {
  homeDirectory: string | null;
  worktreeMetadata: Map<string, WorktreeMetadata>;
  pinnedSessionIds: ReadonlySet<string>;
  gitBranches: Map<string, string | null>;
  isVSCode: boolean;
};

export const useSessionGrouping = (args: Args) => {
  const { t } = useI18n();
  const buildGroupSearchText = React.useMemo(
    () => (group: SessionGroup): string => {
      return [group.label, group.branch ?? '', group.description ?? '', group.directory ?? ''].join(' ').toLowerCase();
    },
    [],
  );

  const buildSessionSearchText = React.useMemo(
    () => (session: Session, worktree?: WorktreeMetadata | null): string => {
      const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null) ?? '';
      const sessionTitle = (session.title || t('sessions.sidebar.session.untitled')).trim();
      const worktreeText = worktree
        ? [worktree.branch ?? '', worktree.name ?? '', worktree.label ?? '', formatWorktreeFooterLabel(worktree) ?? ''].join(' ')
        : '';
      return `${sessionTitle} ${sessionDirectory} ${worktreeText}`.toLowerCase();
    },
    [t],
  );

  const filterSessionNodesForSearch = React.useMemo(() => {
    const filterNodes = (nodes: SessionNode[], query: string): SessionNode[] => {
      if (!query) {
        return nodes;
      }

      return nodes.flatMap((node) => {
        const nodeMatches = buildSessionSearchText(node.session, node.worktree).includes(query);
        if (nodeMatches) {
          return [node];
        }

        const filteredChildren = filterNodes(node.children, query);
        if (filteredChildren.length === 0) {
          return [];
        }

        return [{ ...node, children: filteredChildren }];
      });
    };
    return filterNodes;
  }, [buildSessionSearchText]);

  const buildGroupedSessions = React.useMemo(
    () => (
      projectSessions: Session[],
      projectRoot: string | null,
      availableWorktrees: WorktreeMetadata[],
      projectRootBranch: string | null,
      projectIsRepo: boolean,
    ) => {
      const normalizedProjectRoot = normalizePath(projectRoot ?? null);

      const worktreeByPath = new Map<string, WorktreeMetadata>();
      availableWorktrees.forEach((meta) => {
        if (meta.path) {
          const normalized = normalizePath(meta.path) ?? meta.path;
          worktreeByPath.set(normalized, meta);
        }
      });

      const getSessionWorktree = (session: Session): WorktreeMetadata | null => {
        if (args.isVSCode) return null;
        const sessionDirectory = normalizePath((session as Session & { directory?: string | null }).directory ?? null);
        const candidate = args.worktreeMetadata.get(session.id)
          ?? sessionWorktreeToMetadata(session)
          ?? (sessionDirectory ? worktreeByPath.get(sessionDirectory) ?? null : null);
        if (!candidate) return null;
        const candidatePath = normalizePath(candidate.path);
        if (candidatePath && normalizedProjectRoot && candidatePath === normalizedProjectRoot) {
          return null;
        }
        const liveBranch = candidatePath ? args.gitBranches.get(candidatePath)?.trim() || null : null;
        if (liveBranch && liveBranch !== 'HEAD' && liveBranch !== candidate.branch) {
          return { ...candidate, branch: liveBranch };
        }
        return candidate;
      };

      // Keep the full parent/child forest in the project area even when a
      // session also appears in the flat pinned section.
      const forestRoots = buildSessionTree(projectSessions, {
        pinnedSessionIds: args.pinnedSessionIds,
        omitPinnedSessions: false,
        getWorktree: getSessionWorktree,
      });

      const activeNodes: SessionNode[] = [];
      const archivedNodes: SessionNode[] = [];

      forestRoots.forEach((node) => {
        if (node.session.time?.archived) {
          archivedNodes.push(node);
        } else {
          activeNodes.push(node);
        }
      });

      // Flat project sidebar: all active sessions (project root + linked
      // worktrees) list directly under the project's single root group.
      // Per-session worktree identity renders on each session's compact footer.
      const groups: SessionGroup[] = [
        {
          id: 'root',
          label: (projectIsRepo && projectRootBranch && projectRootBranch !== 'HEAD')
            ? t('sessions.sidebar.grouping.projectRootWithBranch', { branch: projectRootBranch })
            : t('sessions.sidebar.grouping.projectRoot'),
          branch: projectRootBranch ?? null,
          description: normalizedProjectRoot ? formatPathForDisplay(normalizedProjectRoot, args.homeDirectory) : null,
          isMain: true,
          isArchivedBucket: false,
          worktree: null,
          directory: normalizedProjectRoot,
          folderScopeKey: normalizedProjectRoot,
          sessions: activeNodes,
        },
        // Keep an empty archived bucket available so opening it can trigger the
        // first lazy archived-session request for this project.
        {
          id: 'archived',
          label: t('sessions.sidebar.grouping.archived'),
          branch: null,
          description: t('sessions.sidebar.grouping.archivedDescription'),
          isMain: false,
          isArchivedBucket: true,
          worktree: null,
          directory: null,
          folderScopeKey: !args.isVSCode && normalizedProjectRoot ? getArchivedScopeKey(normalizedProjectRoot) : null,
          sessions: archivedNodes,
        },
      ];

      return groups;
    },
    [args.homeDirectory, args.worktreeMetadata, args.pinnedSessionIds, args.gitBranches, args.isVSCode, t],
  );

  return {
    buildGroupSearchText,
    buildSessionSearchText,
    filterSessionNodesForSearch,
    buildGroupedSessions,
  };
};
