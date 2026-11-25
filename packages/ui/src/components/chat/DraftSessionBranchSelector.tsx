import React from 'react';
import { useEvent, useEventListener } from '@reactuses/core';
import {
  BranchSelector,
  type BranchSelectorFollowUpStep,
  type BranchSelectorWorktreeOption,
} from '@/components/views/git/BranchSelector';
import { Icon } from '@/components/icon/Icon';
import { SELECTOR_CHIP_HOVER_CLASS } from '@/components/chat/message/parts/toolRowChrome';
import { toast } from '@/components/ui';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import type { GitRemote } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import { cn } from '@/lib/utils';
import { createWorktreeDraftForBranch } from '@/lib/worktreeSessionCreator';
import { listProjectWorktrees } from '@/lib/worktrees/worktreeManager';
import type { WorktreeMetadata } from '@/types/worktree';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStore, useIsGitRepo } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { refreshGitBranchesQuery, useGitBranchesQuery, useGitRemotesQuery } from '@/queries/gitBranchQueries';
import { isDirectoryBasenameLabel } from './draftSessionBranchLabel';
import { recordRecentBranchUsage, resolveBranchRecencyMap } from '@/lib/worktrees/branchRecency';
import {
  canQueryDraftGitBranches,
  collectExistingWorktreeBranchNames,
  findExistingWorktreePathForBranch,
  mergeDraftWorktreeOptions,
  normalizeDraftBranchRef,
  resolveDraftBranchListDirectory,
  splitGitBranchList,
} from './draftSessionBranchQueries';

export type DraftSessionBranchSelectorProps = {
  directory: string | null;
  projectDirectory: string | null;
  label: string | null;
  projectRootOption: BranchSelectorWorktreeOption | null;
  worktreeOptions: BranchSelectorWorktreeOption[];
  onSelectDirectory: (directory: string) => void;
  onNavigatePrevPicker?: () => void;
  finalFocus?: React.ComponentProps<typeof BranchSelector>['finalFocus'];
  className?: string;
  maxWidthClassName?: string;
  presentation?: 'dropdown' | 'mobile-sheet';
};

const branchShortName = (branch: string): string => {
  const normalized = normalizeDraftBranchRef(branch);
  const slash = normalized.lastIndexOf('/');
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
};

export const DraftSessionBranchSelector: React.FC<DraftSessionBranchSelectorProps> = ({
  directory,
  projectDirectory,
  label,
  projectRootOption,
  worktreeOptions,
  onSelectDirectory,
  onNavigatePrevPicker,
  finalFocus,
  className,
  maxWidthClassName = 'max-w-[48vw] sm:max-w-[20rem]',
  presentation = 'dropdown',
}) => {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  // Branch *lists* are repo-wide and already warmed for the project root by ChatInput.
  // Checkout / current branch still target the selected draft directory (root or worktree).
  const listDirectory = resolveDraftBranchListDirectory(projectDirectory, directory);
  const selectedDirectory = directory;
  const isListDirectoryGitRepo = useIsGitRepo(listDirectory);
  const isSelectedDirectoryGitRepo = useIsGitRepo(selectedDirectory);
  // Do not wait for `isGitRepo === true`: after switching to a worktree the store
  // entry is often still `null`, which previously disabled the query and cleared lists.
  const canQueryListBranches = canQueryDraftGitBranches(listDirectory, isListDirectoryGitRepo);
  const canQuerySelectedBranches = selectedDirectory !== listDirectory
    && canQueryDraftGitBranches(selectedDirectory, isSelectedDirectoryGitRepo);
  const listBranchesQuery = useGitBranchesQuery(listDirectory, git, canQueryListBranches);
  const selectedBranchesQuery = useGitBranchesQuery(selectedDirectory, git, canQuerySelectedBranches);
  const listBranches = listBranchesQuery.data;
  const selectedBranches = selectedDirectory === listDirectory
    ? listBranches
    : selectedBranchesQuery.data;
  const fetchStatus = useGitStore((state) => state.fetchStatus);
  const selectedStatusBranch = useGitStore((state) => (
    selectedDirectory
      ? state.directories.get(selectedDirectory)?.status?.current?.trim() || null
      : null
  ));
  const [branchSelectorOpen, setBranchSelectorOpen] = React.useState(false);
  const remotesQuery = useGitRemotesQuery(
    listDirectory,
    git,
    canQueryListBranches && branchSelectorOpen,
  );
  const remotes = remotesQuery.data ?? [];
  const [pendingBranch, setPendingBranch] = React.useState<string | null>(null);
  const [isActing, setIsActing] = React.useState(false);
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [discoveredWorktreesState, setDiscoveredWorktreesState] = React.useState<{
    directory: string | null;
    worktrees: WorktreeMetadata[];
  }>({ directory: null, worktrees: [] });
  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);

  React.useEffect(() => {
    if (!git) return;
    // Resolve unknown repo probes so later gates and status.current stay accurate.
    if (listDirectory && isListDirectoryGitRepo === null) {
      void fetchStatus(listDirectory, git, { silent: true });
    }
    if (
      selectedDirectory
      && selectedDirectory !== listDirectory
      && isSelectedDirectoryGitRepo === null
    ) {
      void fetchStatus(selectedDirectory, git, { silent: true });
    }
  }, [
    fetchStatus,
    git,
    isListDirectoryGitRepo,
    isSelectedDirectoryGitRepo,
    listDirectory,
    selectedDirectory,
  ]);

  const worktreeDialogProjectId = React.useMemo(() => {
    const normalizedProjectDirectory = normalizePath(projectDirectory);
    if (normalizedProjectDirectory) {
      const matched = projects.find(
        (project) => normalizePath(project.path) === normalizedProjectDirectory,
      );
      if (matched) return matched.id;
    }
    return activeProjectId;
  }, [activeProjectId, projectDirectory, projects]);

  React.useEffect(() => {
    if (!branchSelectorOpen || !listDirectory || !canQueryListBranches) return;
    let cancelled = false;
    void listProjectWorktrees({
      id: worktreeDialogProjectId ?? listDirectory,
      path: listDirectory,
    })
      .then((worktrees) => {
        if (cancelled) return;
        setDiscoveredWorktreesState({ directory: listDirectory, worktrees });
      })
      .catch(() => {
        // Keep current worktree options if on-demand discovery fails.
      });
    return () => {
      cancelled = true;
    };
  }, [branchSelectorOpen, canQueryListBranches, listDirectory, worktreeDialogProjectId]);

  const discoveredWorktrees = React.useMemo(
    () => (discoveredWorktreesState.directory === listDirectory ? discoveredWorktreesState.worktrees : []),
    [discoveredWorktreesState, listDirectory],
  );

  const mergedWorktreeOptions = React.useMemo(
    () => mergeDraftWorktreeOptions(worktreeOptions, discoveredWorktrees),
    [discoveredWorktrees, worktreeOptions],
  );

  const existingWorktreeBranches = React.useMemo(
    () => collectExistingWorktreeBranchNames(discoveredWorktrees, worktreeOptions, projectRootOption),
    [discoveredWorktrees, projectRootOption, worktreeOptions],
  );

  const remoteNames = React.useMemo(
    () => remotes.map((remote) => remote.name).filter(Boolean),
    [remotes],
  );

  const currentBranch = selectedBranches?.current?.trim() || selectedStatusBranch || null;

  const { localBranches, remoteBranches } = React.useMemo(
    () => splitGitBranchList(listBranches?.all, {
      currentBranch,
      branchRecency: resolveBranchRecencyMap({
        directory: listDirectory,
        branchInfo: listBranches?.branches,
      }),
    }),
    [currentBranch, listBranches, listDirectory],
  );
  // Parent may still pass a directory basename while branches load (or after a
  // missing-option fallback). Prefer the live git current branch over that.
  const chipLabel = (
    (!isDirectoryBasenameLabel(label, directory) && label)
    || currentBranch
    || label
    || t('chat.chatInput.branch')
  );

  const refreshGit = useEvent(async () => {
    if (!git) return;
    const targets = new Set<string>();
    if (listDirectory) targets.add(listDirectory);
    if (selectedDirectory) targets.add(selectedDirectory);
    await Promise.all([...targets].map(async (target) => {
      await refreshGitBranchesQuery(target, git);
      await fetchStatus(target, git, { silent: true });
    }));
  });

  const checkoutBranch = useEvent(async (branch: string) => {
    if (!selectedDirectory || !git) return;
    const normalized = normalizeDraftBranchRef(branch);
    if (currentBranch === normalized || currentBranch === branchShortName(normalized)) return;
    try {
      await git.checkoutBranch(selectedDirectory, normalized);
      toast.success(t('gitView.toast.checkedOut', { name: normalized }));
      await refreshGit();
    } catch (error) {
      const message = error instanceof Error
        ? error.message
        : t('gitView.toast.checkoutFailed', { name: normalized });
      toast.error(message);
    }
  });

  useEventListener('yuri:open-draft-branch-picker', () => {
    setPendingBranch(null);
    setBranchSelectorOpen(true);
  }, typeof window !== 'undefined' ? window : undefined);

  const handleBranchSelectorOpenChange = useEvent((nextOpen: boolean) => {
    if (!nextOpen && isActing) return;
    setBranchSelectorOpen(nextOpen);
    if (!nextOpen) {
      setPendingBranch(null);
    }
  });

  const handleBranchSelected = useEvent(async (branch: string) => {
    const normalized = normalizeDraftBranchRef(branch);
    if (!normalized) return;
    recordRecentBranchUsage(listDirectory, normalized);
    if (
      currentBranch === normalized
      || currentBranch === branchShortName(normalized)
    ) {
      setBranchSelectorOpen(false);
      return;
    }

    let worktreesForLookup = discoveredWorktrees;
    if (
      discoveredWorktreesState.directory !== listDirectory
      && listDirectory
      && canQueryListBranches
    ) {
      try {
        worktreesForLookup = await listProjectWorktrees({
          id: worktreeDialogProjectId ?? listDirectory,
          path: listDirectory,
        });
        setDiscoveredWorktreesState({ directory: listDirectory, worktrees: worktreesForLookup });
      } catch {
        // Fall back to already-known worktreeOptions when on-demand listing fails.
      }
    }

    const existingPath = findExistingWorktreePathForBranch({
      branch: normalized,
      discoveredWorktrees: worktreesForLookup,
      worktreeOptions,
      projectRootOption,
      remoteNames,
    });
    if (existingPath && normalizePath(existingPath) !== normalizePath(selectedDirectory)) {
      onSelectDirectory(existingPath);
      setPendingBranch(null);
      setBranchSelectorOpen(false);
      toast.success(t('chat.chatInput.branchSwitch.usingExistingWorktree', { branch: normalized }));
      return;
    }

    // Draft conversations drill into a level-2 inline select: checkout here or new worktree.
    setPendingBranch(normalized);
  });

  const handleCheckoutHere = useEvent(async () => {
    if (!pendingBranch || isActing) return;
    setIsActing(true);
    try {
      await checkoutBranch(pendingBranch);
      setPendingBranch(null);
      setBranchSelectorOpen(false);
    } finally {
      setIsActing(false);
    }
  });

  const handleCreateWorktree = useEvent(async () => {
    if (!pendingBranch || isActing) return;
    setIsActing(true);
    try {
      const path = await createWorktreeDraftForBranch({
        branch: pendingBranch,
        projectId: worktreeDialogProjectId ?? undefined,
        projectDirectory: projectDirectory ?? undefined,
      });
      if (path) {
        setPendingBranch(null);
        setBranchSelectorOpen(false);
      }
    } finally {
      setIsActing(false);
    }
  });

  const followUpStep = React.useMemo<BranchSelectorFollowUpStep | null>(() => {
    if (!pendingBranch) return null;
    return {
      title: pendingBranch,
      pending: isActing,
      onBack: () => {
        if (!isActing) setPendingBranch(null);
      },
      actions: [
        {
          id: 'checkout-here',
          icon: 'arrow-left-right',
          label: t('chat.chatInput.branchSwitch.checkoutHere'),
          onSelect: handleCheckoutHere,
        },
        {
          id: 'create-worktree',
          icon: 'git-branch',
          label: t('chat.chatInput.branchSwitch.createWorktree'),
          onSelect: handleCreateWorktree,
        },
      ],
    };
  }, [handleCheckoutHere, handleCreateWorktree, isActing, pendingBranch, t]);

  const handleCreate = useEvent(async (branchName: string, remote?: GitRemote) => {
    if (!selectedDirectory || !git) return;
    const remoteName = remote?.name ?? 'origin';
    try {
      await git.createBranch(selectedDirectory, branchName, currentBranch ?? 'HEAD');
      recordRecentBranchUsage(listDirectory, branchName);
      toast.success(t('gitView.toast.createdBranch', { name: branchName }));
      // After creating a brand-new branch, ask the same draft-only chooser.
      setPendingBranch(branchName);

      // Keep upstream setup opportunistic; do not block the chooser.
      void git.gitPush(selectedDirectory, {
        remote: remoteName,
        branch: branchName,
        options: ['--set-upstream'],
      }).then(async () => {
        await refreshGit();
        toast.success(t('gitView.toast.upstreamSet', { branch: branchName, remote: remoteName }));
      }).catch(async (pushError) => {
        const message = pushError instanceof Error
          ? pushError.message
          : t('gitView.toast.branchCreatedLocally');
        toast.warning(t('gitView.toast.branchCreatedLocally'), {
          description: (
            <span className="text-foreground/80 dark:text-foreground/70">
              {message}
            </span>
          ),
        });
        await refreshGit();
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : t('gitView.toast.createBranchFailed');
      toast.error(message);
      throw error;
    }
  });

  // Match the sidebar worktree entry: open the full configure dialog (branch
  // name, worktree directory, source branch) instead of silent instant create.
  const handleOpenCreateWorktreeDialog = useEvent(() => {
    const projectsState = useProjectsStore.getState();
    const normalizedProjectDirectory = normalizePath(projectDirectory);
    const matchedProject = normalizedProjectDirectory
      ? projectsState.projects.find(
        (project) => normalizePath(project.path) === normalizedProjectDirectory,
      ) ?? null
      : null;
    if (matchedProject && projectsState.activeProjectId !== matchedProject.id) {
      projectsState.setActiveProjectIdOnly(matchedProject.id);
    }
    setNewWorktreeDialogOpen(true);
  });

  const handleWorktreeCreated = useEvent(
    (worktreePath: string, options?: { sessionId?: string }) => {
      setNewWorktreeDialogOpen(false);
      if (options?.sessionId) {
        useSessionUIStore.getState().setCurrentSession(options.sessionId, worktreePath);
        return;
      }

      const projectsState = useProjectsStore.getState();
      const normalizedProjectDirectory = normalizePath(projectDirectory);
      const matchedProject = normalizedProjectDirectory
        ? projectsState.projects.find(
          (project) => normalizePath(project.path) === normalizedProjectDirectory,
        ) ?? null
        : null;
      const projectId = matchedProject?.id ?? projectsState.activeProjectId ?? null;
      const sessionStore = useSessionUIStore.getState();

      // Keep the open draft and only retarget its directory so composer text is preserved.
      if (sessionStore.newSessionDraft?.open) {
        sessionStore.overrideNewSessionDraftTarget({
          ...(projectId ? { selectedProjectId: projectId } : {}),
          directoryOverride: worktreePath,
          bootstrapPendingDirectory: worktreePath,
          preserveDirectoryOverride: true,
        });
        useDirectoryStore.getState().setDirectory(worktreePath, { showOverlay: false });
        return;
      }

      sessionStore.openNewSessionDraft({
        ...(projectId ? { selectedProjectId: projectId } : {}),
        directoryOverride: worktreePath,
        preserveDirectoryOverride: true,
      });
    },
  );

  const chipTrigger = (
    <button
      type="button"
      className={cn(
        'group relative inline-flex min-w-0 w-fit items-center gap-1.5 rounded-lg !border-0 px-1.5 font-medium text-foreground/80',
        presentation === 'mobile-sheet'
          ? 'h-[26px] text-[11px] leading-none'
          : 'h-6 py-1 pr-1.5 typography-micro transition-[padding] hover:pr-5 focus-visible:pr-5 data-[popup-open]:pr-5',
        maxWidthClassName,
        SELECTOR_CHIP_HOVER_CLASS,
        className,
      )}
      aria-label={chipLabel}
    >
      <Icon name="git-branch" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="min-w-0 truncate">{chipLabel}</span>
      {presentation === 'dropdown' ? (
        <Icon
          name="arrow-down-s"
          className="pointer-events-none absolute right-1 size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 group-data-[popup-open]:opacity-100"
          aria-hidden="true"
        />
      ) : null}
    </button>
  );

  return (
    <>
      <BranchSelector
        currentBranch={currentBranch}
        localBranches={localBranches}
        remoteBranches={remoteBranches}
        branchInfo={listBranches?.branches}
        directory={listDirectory}
        onCheckout={handleBranchSelected}
        keepOpenOnCheckout
        followUpStep={followUpStep}
        onNavigatePrevPicker={onNavigatePrevPicker}
        finalFocus={finalFocus}
        onCreate={handleCreate}
        remotes={remotes}
        trigger={chipTrigger}
        triggerLabel={chipLabel}
        hideTooltip
        projectRootOption={projectRootOption}
        worktreeOptions={mergedWorktreeOptions}
        existingWorktreeBranches={existingWorktreeBranches}
        selectedDirectory={directory}
        onSelectDirectory={onSelectDirectory}
        onCreateWorktree={handleOpenCreateWorktreeDialog}
        open={branchSelectorOpen}
        presentation={presentation}
        onOpenChange={handleBranchSelectorOpenChange}
      />

      {newWorktreeDialogOpen ? (
        <NewWorktreeDialog
          open={true}
          projectId={worktreeDialogProjectId}
          onOpenChange={setNewWorktreeDialogOpen}
          onWorktreeCreated={handleWorktreeCreated}
        />
      ) : null}
    </>
  );
};
