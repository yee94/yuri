import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from "@/components/icon/Icon";
import type { Session } from '@/lib/opencode/v2-types';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useDeviceInfo } from '@/lib/device';
import { checkIsGitRepository } from '@/lib/gitApi';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import { sessionEvents } from '@/lib/sessionEvents';
import type { WorktreeMetadata } from '@/types/worktree';
import { formatPathForDisplay, cn } from '@/lib/utils';
import { ProjectSettingsSubsection } from '@/components/sections/projects/ProjectSettingsSubsection';
import { useI18n } from '@/lib/i18n';

export interface WorktreeSectionContentProps {
  projectRef?: { id: string; path: string } | null;
  collapsible?: boolean;
}

export const WorktreeSectionContent: React.FC<WorktreeSectionContentProps> = ({ projectRef: projectRefProp = null, collapsible = false }) => {
  const { t } = useI18n();
  const { isMobile, isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  const projectPath = projectRefProp?.path ?? activeProject?.path ?? null;

  const getWorktreeMetadata = useSessionUIStore((s) => s.getWorktreeMetadata);
  const sessions = useSessions();
  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);

  const [isGitRepoLocal, setIsGitRepoLocal] = React.useState<boolean | null>(null);
  const [availableWorktrees, setAvailableWorktrees] = React.useState<WorktreeMetadata[]>([]);
  const [isLoadingWorktrees, setIsLoadingWorktrees] = React.useState(false);

  const projectRef = React.useMemo(() => {
    if (projectRefProp?.id && projectRefProp?.path) {
      return { id: projectRefProp.id, path: projectRefProp.path };
    }
    if (!activeProject?.id || !projectPath) {
      return null;
    }
    return { id: activeProject.id, path: projectPath };
  }, [activeProject?.id, projectPath, projectRefProp?.id, projectRefProp?.path]);

  const refreshWorktrees = React.useCallback(async () => {
    if (!projectRef || isGitRepoLocal === false) return;

    try {
      const worktrees = await listProjectWorktrees(projectRef);
      setAvailableWorktrees(worktrees);
    } catch {
      // Ignore errors
    }
  }, [projectRef, isGitRepoLocal]);

  React.useEffect(() => {
    if (!projectPath) return;

    let cancelled = false;
    setIsGitRepoLocal(null);

    (async () => {
      try {
        const repoStatus = await checkIsGitRepository(projectPath);
        if (cancelled) return;
        setIsGitRepoLocal(repoStatus);
      } catch {
        // Ignore errors
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  React.useEffect(() => {
    if (!projectRef) {
      setAvailableWorktrees([]);
      setIsLoadingWorktrees(false);
      return;
    }

    if (isGitRepoLocal === false) {
      setAvailableWorktrees([]);
      setIsLoadingWorktrees(false);
      return;
    }

    let cancelled = false;
    setIsLoadingWorktrees(true);
    setAvailableWorktrees([]);

    (async () => {
      try {
        const worktrees = await listProjectWorktrees(projectRef);
        if (cancelled) return;
        setAvailableWorktrees(worktrees);
      } catch {
        // ignore
      } finally {
        if (!cancelled) {
          setIsLoadingWorktrees(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [projectRef, isGitRepoLocal]);

  const handleDeleteWorktree = React.useCallback((worktree: WorktreeMetadata) => {
    const normalize = (value: string): string => value.replace(/\\/g, '/').replace(/\/+$/, '');
    const normalizedWorktreePath = normalize(worktree.path);

    const directSessions = sessions.filter((session) => {
      const metadata = getWorktreeMetadata(session.id);
      if (metadata?.path && normalize(metadata.path) === normalizedWorktreePath) {
        return true;
      }

      const sessionDir = (session as { directory?: string }).directory;
      if (sessionDir) {
        const normalizedSessionDir = normalize(sessionDir);
        if (normalizedSessionDir === normalizedWorktreePath) {
          return true;
        }
      }

      return false;
    });

    const directSessionIds = new Set(directSessions.map((s) => s.id));

    const allKnownSessions = [
      ...useGlobalSessionsStore.getState().activeSessions,
      ...useGlobalSessionsStore.getState().archivedSessions,
    ];

    const findSubsessions = (parentIds: Set<string>): Session[] => {
      const subsessions = allKnownSessions.filter((session) => {
        const parentID = (session as Session & { parentID?: string | null }).parentID;
        return parentID && parentIds.has(parentID);
      });
      if (subsessions.length === 0) {
        return [];
      }
      const subsessionIds = new Set(subsessions.map((s) => s.id));
      return [...subsessions, ...findSubsessions(subsessionIds)];
    };

    const allSubsessions = findSubsessions(directSessionIds);

    const seenIds = new Set<string>();
    const allSessions = [...directSessions, ...allSubsessions].filter((session) => {
      if (seenIds.has(session.id)) {
        return false;
      }
      seenIds.add(session.id);
      return true;
    });

    sessionEvents.requestDelete({
      sessions: allSessions,
      mode: 'worktree',
      worktree,
    });
  }, [sessions, getWorktreeMetadata]);

  const sessionsKey = React.useMemo(() => sessions.map(s => s.id).join(','), [sessions]);
  React.useEffect(() => {
    if (isGitRepoLocal && projectPath) {
      refreshWorktrees();
    }
  }, [sessionsKey, isGitRepoLocal, projectPath, refreshWorktrees]);

  if (!projectPath) {
    return (
      <ProjectSettingsSubsection
        title={t('settings.projects.page.section.worktree')}
        settingsItem="projects.worktree"
      >
        <p className="typography-meta text-muted-foreground">
          {t('settings.yuri.worktrees.state.selectProject')}
        </p>
      </ProjectSettingsSubsection>
    );
  }

  if (isGitRepoLocal === false) {
    return (
      <ProjectSettingsSubsection
        title={t('settings.projects.page.section.worktree')}
        settingsItem="projects.worktree"
      >
        <p className="typography-meta text-muted-foreground">
          {t('settings.yuri.worktrees.state.gitOnly')}
        </p>
      </ProjectSettingsSubsection>
    );
  }

  return (
      <ProjectSettingsSubsection
        title={t('settings.yuri.worktrees.list.title')}
        settingsItem="projects.worktree"
        collapsible={collapsible}
        count={isLoadingWorktrees ? undefined : availableWorktrees.length}
      >
        {isLoadingWorktrees ? (
          <p className="typography-meta text-muted-foreground">{t('settings.yuri.worktrees.list.loading')}</p>
        ) : availableWorktrees.length === 0 ? (
          <p className="typography-meta text-muted-foreground/70">
            {t('settings.yuri.worktrees.list.empty')}
          </p>
        ) : (
          <div className="w-full space-y-1">
            {availableWorktrees.map((worktree) => (
              <div
                key={worktree.path}
                className="group flex w-full items-center gap-2 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="typography-meta min-w-0 truncate text-foreground">
                      {worktree.label || worktree.branch || t('settings.yuri.worktrees.list.detachedHead')}
                    </p>
                  </div>
                  <p className="typography-micro truncate text-muted-foreground/60">
                    {formatPathForDisplay(worktree.path, homeDirectory)}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => handleDeleteWorktree(worktree)}
                  className={cn(
                    'text-muted-foreground transition-opacity focus-visible:opacity-100',
                    alwaysShowActions ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                  )}
                  aria-label={t('settings.yuri.worktrees.list.deleteWorktreeAria', { name: worktree.branch || worktree.label || worktree.path })}
                >
                  <Icon name="delete-bin" className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </ProjectSettingsSubsection>
  );
};
