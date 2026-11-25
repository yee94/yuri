import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { cn } from '@/lib/utils';
import type { GitRemote } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import { recordRecentBranchUsage, resolveBranchRecencyMap } from '@/lib/worktrees/branchRecency';
import {
  DEFAULT_BRANCH_RENDER_LIMIT,
  rankBranchesForQuery,
  type RankedBranchItem,
} from '@/lib/worktrees/branchSearch';

interface BranchInfo {
  ahead?: number;
  behind?: number;
  lastUsedAt?: number;
}

export type BranchSelectorWorktreeOption = {
  value: string;
  label: string;
  pending?: boolean;
};

export type BranchSelectorFollowUpAction = {
  id: string;
  icon: IconName;
  label: string;
  onSelect: () => void | Promise<void>;
};

export type BranchSelectorFollowUpStep = {
  title: string;
  actions: BranchSelectorFollowUpAction[];
  pending?: boolean;
  onBack: () => void;
};

interface BranchSelectorProps {
  currentBranch: string | null | undefined;
  localBranches: string[];
  remoteBranches: string[];
  branchInfo: Record<string, BranchInfo> | undefined;
  /** Repository directory for recording & reading client-side recent branch usage. */
  directory?: string | null;
  onCheckout: (branch: string) => void | Promise<void>;
  /** Keep the popup open after onCheckout so the caller can close or show followUpStep. */
  keepOpenOnCheckout?: boolean;
  /** Optional inline second-level step rendered inside the same dropdown/sheet. */
  followUpStep?: BranchSelectorFollowUpStep | null;
  onCreate: (name: string, remote?: GitRemote) => Promise<void>;
  remotes?: GitRemote[];
  disabled?: boolean;
  /** Icon-only trigger; branch name shown in tooltip. */
  iconOnly?: boolean;
  /** Replace the default trigger (e.g. draft composer chip). */
  trigger?: React.ReactElement;
  /** Optional content label override for the default text trigger. */
  triggerLabel?: string | null;
  /** Align the dropdown. Defaults based on iconOnly. */
  contentAlign?: 'start' | 'end' | 'center';
  /** Hide the trigger tooltip (useful for custom composer chips). */
  hideTooltip?: boolean;
  /** Project root directory row shown above linked worktrees. */
  projectRootOption?: BranchSelectorWorktreeOption | null;
  /** Linked worktrees listed under the branch lists. */
  worktreeOptions?: BranchSelectorWorktreeOption[];
  /** Local branch names that already have an existing local worktree checkout. */
  existingWorktreeBranches?: ReadonlySet<string>;
  /** Currently selected session/worktree directory. */
  selectedDirectory?: string | null;
  onSelectDirectory?: (directory: string) => void;
  onCreateWorktree?: () => void;
  worktreesLabel?: string;
  worktreeNewLabel?: string;
  projectRootLabel?: string;
  onOpenChange?: (open: boolean) => void;
  open?: boolean;
  presentation?: 'dropdown' | 'mobile-sheet';
}

function BranchList({ branches, local, currentBranch, branchInfo, existingWorktreeBranches, onCheckout }: {
  branches: string[];
  local?: boolean;
  currentBranch?: string | null;
  branchInfo?: Record<string, BranchInfo>;
  existingWorktreeBranches?: ReadonlySet<string>;
  onCheckout: (branch: string) => void;
}) {
  const { t } = useI18n();
  const visible = branches.length > DEFAULT_BRANCH_RENDER_LIMIT
    ? branches.slice(0, DEFAULT_BRANCH_RENDER_LIMIT)
    : branches;
  return (
    <CommandGroup heading={t(local ? 'gitView.branch.localBranches' : 'gitView.branch.remoteBranches')}>
      {visible.map((branch) => {
        const isCurrent = Boolean(local && currentBranch === branch);
        const hasExistingWorktree = Boolean(local && !isCurrent && existingWorktreeBranches?.has(branch));
        return (
          <CommandItem
            key={`${local ? 'local' : 'remote'}-${branch}`}
            value={`${local ? 'local' : 'remote'}:${branch}`}
            onSelect={() => onCheckout(branch)}
          >
            {local ? (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate typography-ui-label text-foreground">{branch}</span>
                {(branchInfo?.[branch]?.ahead || branchInfo?.[branch]?.behind) && (
                  <span className="typography-micro text-muted-foreground">
                    {branchInfo[branch].ahead || 0} ahead ·{' '}
                    {branchInfo[branch].behind || 0} behind
                  </span>
                )}
              </span>
            ) : <span className="min-w-0 flex-1 truncate typography-ui-label text-foreground">{branch}</span>}
            {isCurrent ? (
              <span className="shrink-0 text-xs leading-4 text-primary">{t('gitView.branch.currentBadge')}</span>
            ) : hasExistingWorktree ? (
              <span className="shrink-0 text-xs leading-4 text-muted-foreground">{t('gitView.branch.worktreeBadge')}</span>
            ) : null}
          </CommandItem>
        );
      })}
      {visible.length === 0 && (
        <CommandItem disabled className="justify-center">
          <span className="typography-meta text-muted-foreground">
            {t(local ? 'gitView.branch.noLocalBranches' : 'gitView.branch.noRemoteBranches')}
          </span>
        </CommandItem>
      )}
    </CommandGroup>
  );
}

function MatchingBranchList({ items, currentBranch, branchInfo, existingWorktreeBranches, onCheckout }: {
  items: RankedBranchItem[];
  currentBranch?: string | null;
  branchInfo?: Record<string, BranchInfo>;
  existingWorktreeBranches?: ReadonlySet<string>;
  onCheckout: (branch: string) => void;
}) {
  const { t } = useI18n();
  const visible = items.length > DEFAULT_BRANCH_RENDER_LIMIT
    ? items.slice(0, DEFAULT_BRANCH_RENDER_LIMIT)
    : items;
  if (visible.length === 0) return null;
  return (
    <CommandGroup heading={t('session.newWorktree.matchingBranches')}>
      {visible.map((item) => {
        const isLocal = item.source === 'local';
        const info = isLocal ? branchInfo?.[item.label] : undefined;
        const isCurrent = Boolean(isLocal && currentBranch === item.label);
        const hasExistingWorktree = Boolean(isLocal && !isCurrent && existingWorktreeBranches?.has(item.label));
        return (
          <CommandItem
            key={`match-${item.source}-${item.label}`}
            value={`match:${item.source}:${item.label}`}
            onSelect={() => onCheckout(item.label)}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate typography-ui-label text-foreground">{item.label}</span>
              {isLocal && (info?.ahead || info?.behind) ? (
                <span className="typography-micro text-muted-foreground">
                  {info.ahead || 0} ahead · {info.behind || 0} behind
                </span>
              ) : null}
            </span>
            {isCurrent ? (
              <span className="shrink-0 text-xs leading-4 text-primary">{t('gitView.branch.currentBadge')}</span>
            ) : hasExistingWorktree ? (
              <span className="shrink-0 text-xs leading-4 text-muted-foreground">{t('gitView.branch.worktreeBadge')}</span>
            ) : null}
          </CommandItem>
        );
      })}
    </CommandGroup>
  );
}

function WorktreeItems({ options, selectedDirectory, onSelect }: {
  options: BranchSelectorWorktreeOption[];
  selectedDirectory: string | null;
  onSelect: (directory: string) => void;
}) {
  const { t } = useI18n();
  return options.map((option) => (
    <CommandItem key={`worktree-${option.value}`} onSelect={() => onSelect(option.value)}>
      <span className="truncate typography-ui-label text-foreground">
        {option.pending ? '⏳ ' : ''}{option.label}
      </span>
      {selectedDirectory === option.value ? (
        <span className="typography-micro text-primary">{t('gitView.branch.currentBadge')}</span>
      ) : null}
    </CommandItem>
  ));
}

const sanitizeBranchNameInput = (value: string): string => {
  return value
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/\/-+/g, '/')
    .replace(/-+\//g, '/')
    .replace(/^[-/]+/, '')
    .replace(/[-/]+$/, '');
};

export const BranchSelector: React.FC<BranchSelectorProps> = ({
  currentBranch,
  localBranches,
  remoteBranches,
  branchInfo,
  directory = null,
  onCheckout,
  keepOpenOnCheckout = false,
  followUpStep = null,
  onCreate,
  remotes = [],
  disabled = false,
  iconOnly = false,
  trigger,
  triggerLabel,
  contentAlign,
  hideTooltip = false,
  projectRootOption = null,
  worktreeOptions = [],
  existingWorktreeBranches,
  selectedDirectory = null,
  onSelectDirectory,
  onCreateWorktree,
  worktreesLabel,
  worktreeNewLabel,
  projectRootLabel,
  onOpenChange,
  open: controlledOpen,
  presentation = 'dropdown',
}) => {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = React.useState(false);
  const [search, setSearch] = React.useState('');
  const [showCreate, setShowCreate] = React.useState(false);
  const [showRemoteSelect, setShowRemoteSelect] = React.useState(false);
  const [newBranchName, setNewBranchName] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);
  const [followUpIndex, setFollowUpIndex] = React.useState(0);
  const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
  const commandRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const createInputRef = React.useRef<HTMLInputElement>(null);
  const followUpListRef = React.useRef<HTMLDivElement>(null);
  const mobileSheetId = React.useId();
  const open = controlledOpen ?? isOpen;
  const setOpen = (nextOpen: boolean) => {
    if (controlledOpen === undefined) setIsOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  const stopDropdownTypeahead = useEvent((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      const target = commandRef.current ?? event.currentTarget;
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: event.shiftKey ? 'ArrowUp' : 'ArrowDown',
        bubbles: true,
        cancelable: true,
      }));
      return;
    }
    event.stopPropagation();
  });

  const runFollowUpAction = useEvent((action: BranchSelectorFollowUpAction) => {
    if (followUpStep?.pending) return;
    setPendingActionId(action.id);
    void Promise.resolve(action.onSelect()).finally(() => {
      setPendingActionId((current) => (current === action.id ? null : current));
    });
  });

  const handleFollowUpKeyDown = useEvent((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (!followUpStep) return;
    const count = followUpStep.actions.length;
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (count > 0) setFollowUpIndex((prev) => (prev + 1) % count);
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (count > 0) setFollowUpIndex((prev) => (prev - 1 + count) % count);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      const action = followUpStep.actions[followUpIndex];
      if (action) runFollowUpAction(action);
      return;
    }
    if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      if (!followUpStep.pending) followUpStep.onBack();
    }
  });

  const hasMultipleRemotes = remotes.length > 1;
  const showWorktreeSection = Boolean(onSelectDirectory || onCreateWorktree);
  const recencyDirectory = directory ?? selectedDirectory;

  const branchRecency = React.useMemo(
    () => (open ? resolveBranchRecencyMap({ directory: recencyDirectory, branchInfo }) : undefined),
    [branchInfo, open, recencyDirectory],
  );

  const rankedBranches = React.useMemo(
    () => rankBranchesForQuery({
      localBranches,
      remoteBranches,
      query: search,
      currentBranch,
      branchRecency,
    }),
    [branchRecency, currentBranch, localBranches, remoteBranches, search],
  );
  const hasSearchTerm = search.trim().length > 0;

  const sanitizedNewBranch = React.useMemo(
    () => sanitizeBranchNameInput(newBranchName),
    [newBranchName]
  );

  const filteredWorktrees = React.useMemo(() => {
    const term = search.trim();
    if (!term) return worktreeOptions;
    return scoreByFuzzyQuery(worktreeOptions, term, (option) => option.label).map((entry) => entry.item);
  }, [search, worktreeOptions]);

  const projectRootMatches = React.useMemo(() => {
    if (!projectRootOption) return false;
    const term = search.trim();
    if (!term) return true;
    return scoreByFuzzyQuery(
      [projectRootOption],
      term,
      (option) => [option.label, projectRootLabel ?? ''],
    ).length > 0;
  }, [projectRootLabel, projectRootOption, search]);

  const handleCheckout = (branch: string) => {
    recordRecentBranchUsage(recencyDirectory, branch);
    if (branch === currentBranch) {
      setOpen(false);
      return;
    }
    void onCheckout(branch);
    if (!keepOpenOnCheckout) {
      setOpen(false);
    }
    setSearch('');
  };

  const handleSelectDirectory = (directory: string) => {
    onSelectDirectory?.(directory);
    setOpen(false);
    setSearch('');
  };

  const handleShowCreate = () => {
    setShowCreate(true);
    setTimeout(() => createInputRef.current?.focus(), 50);
  };

  const handleCreate = async () => {
    if (!sanitizedNewBranch || isCreating) return;

    // If multiple remotes, show remote selection first
    if (hasMultipleRemotes) {
      setShowRemoteSelect(true);
      return;
    }

    // Single or no remote - proceed directly
    setIsCreating(true);
    try {
      await onCreate(sanitizedNewBranch, remotes[0]);
      recordRecentBranchUsage(recencyDirectory, sanitizedNewBranch);
      setNewBranchName('');
      setShowCreate(false);
      if (!keepOpenOnCheckout) {
        setOpen(false);
      }
    } finally {
      setIsCreating(false);
    }
  };

  const handleSelectRemote = async (remote: GitRemote) => {
    if (!sanitizedNewBranch || isCreating) return;
    setIsCreating(true);
    try {
      await onCreate(sanitizedNewBranch, remote);
      recordRecentBranchUsage(recencyDirectory, sanitizedNewBranch);
      setNewBranchName('');
      setShowCreate(false);
      setShowRemoteSelect(false);
      if (!keepOpenOnCheckout) {
        setOpen(false);
      }
    } finally {
      setIsCreating(false);
    }
  };

  const handleBackFromRemoteSelect = () => {
    setShowRemoteSelect(false);
  };

  const handleCancelCreate = () => {
    setNewBranchName('');
    setShowCreate(false);
    setShowRemoteSelect(false);
  };

  React.useEffect(() => {
    if (!open) {
      setSearch('');
      setShowCreate(false);
      setShowRemoteSelect(false);
      setNewBranchName('');
      setFollowUpIndex(0);
      setPendingActionId(null);
      return;
    }
    if (followUpStep) {
      setFollowUpIndex(0);
      const frame = window.requestAnimationFrame(() => {
        followUpListRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (!showCreate && !showRemoteSelect) {
      const frame = window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [followUpStep, open, showCreate, showRemoteSelect]);

  const branchLabel = triggerLabel || currentBranch || t('gitView.branch.detachedHead');
  const resolvedContentAlign = contentAlign ?? (iconOnly ? 'end' : 'start');
  const resolvedWorktreesLabel = worktreesLabel ?? t('chat.chatInput.worktrees');
  const resolvedWorktreeNewLabel = worktreeNewLabel ?? t('chat.chatInput.worktreeNew');
  const resolvedProjectRootLabel = projectRootLabel ?? t('chat.chatInput.projectRoot');

  const defaultTrigger = iconOnly ? (
    <button
      type="button"
      className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
      disabled={disabled}
      aria-label={branchLabel}
    >
      <Icon name="git-branch" className="size-3.5" />
    </button>
  ) : (
    <Button
      variant="ghost"
      size="xs"
      className="h-6 min-w-0 max-w-full justify-start gap-1 px-0 hover:bg-transparent"
      disabled={disabled}
      aria-label={branchLabel}
    >
      <Icon name="git-branch" className="size-3.5 text-primary" />
      <span className="min-w-0 truncate typography-ui-label font-semibold text-left text-foreground">
        {branchLabel}
      </span>
      <Icon name="arrow-down-s" className="size-3 shrink-0 text-muted-foreground" />
    </Button>
  );

  const menuTrigger = (
    <DropdownMenuTrigger asChild disabled={disabled}>
      {trigger ?? defaultTrigger}
    </DropdownMenuTrigger>
  );

  const commandSurface = followUpStep ? (
    <div
      ref={followUpListRef}
      tabIndex={-1}
      role="menu"
      data-branch-followup-step
      onKeyDown={handleFollowUpKeyDown}
      className="flex flex-col p-1 outline-none"
    >
      <div className="mb-1 flex items-center gap-1.5 border-b border-border/60 px-2 py-1.5">
        <button
          type="button"
          disabled={followUpStep.pending}
          onClick={followUpStep.onBack}
          aria-label={t('header.actions.backAria')}
          className="inline-flex size-5 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground disabled:opacity-50"
        >
          <Icon name="arrow-left" className="size-3.5" />
        </button>
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-muted-foreground">
          {followUpStep.title}
        </span>
      </div>
      {followUpStep.actions.map((action, index) => {
        const isHighlighted = index === followUpIndex;
        return (
          <button
            key={action.id}
            type="button"
            role="menuitem"
            data-branch-followup-action={action.id}
            data-selected={isHighlighted ? 'true' : undefined}
            disabled={followUpStep.pending}
            onMouseEnter={() => setFollowUpIndex(index)}
            onClick={() => runFollowUpAction(action)}
            className={cn(
              'relative flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left typography-ui-label text-foreground outline-none select-none disabled:pointer-events-none disabled:opacity-50',
              isHighlighted
                ? 'bg-interactive-selection text-interactive-selection-foreground'
                : 'hover:bg-interactive-hover',
            )}
          >
            {followUpStep.pending && pendingActionId === action.id ? (
              <Icon name="loader-4" className="size-4 shrink-0 animate-spin text-muted-foreground" />
            ) : (
              <Icon name={action.icon} className="size-4 shrink-0 text-muted-foreground" />
            )}
            <span className="min-w-0 flex-1 truncate">{action.label}</span>
          </button>
        );
      })}
    </div>
  ) : (
        <Command ref={commandRef} shouldFilter={false} className="h-full min-h-0">
          <div data-mobile-sheet-no-dismiss={presentation === 'mobile-sheet' ? '' : undefined}>
            <CommandInput
              ref={searchInputRef}
              autoFocus
              placeholder={t('gitView.branch.searchPlaceholder')}
              value={search}
              onValueChange={setSearch}
              onKeyDown={stopDropdownTypeahead}
            />
          </div>
          <CommandList
            scrollbarClassName="overlay-scrollbar--flush overlay-scrollbar--dense overlay-scrollbar--zero"
            disableHorizontal
          >
            {hasSearchTerm && rankedBranches.matching.length === 0 && filteredWorktrees.length === 0 && !projectRootMatches ? (
              <div className="py-6 text-center typography-ui-label text-muted-foreground">
                {t('gitView.branch.empty')}
              </div>
            ) : null}

            <CommandGroup>
              {showRemoteSelect ? (
                // Remote selection step
                <div className="px-2 py-1.5">
                  <div className="flex items-center gap-2 mb-2">
                    <button
                      type="button"
                      onClick={handleBackFromRemoteSelect}
                      disabled={isCreating}
                      className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                    >
                      <Icon name="arrow-left" className="size-4" />
                    </button>
                    <span className="typography-meta text-muted-foreground">
                      {t('gitView.branch.pushToPrefix')} <span className="text-foreground font-medium">{sanitizedNewBranch}</span> {t('gitView.branch.pushToSuffix')}
                    </span>
                  </div>
                  <div className="flex flex-col gap-1">
                    {remotes.map((remote) => (
                      <button
                        key={remote.name}
                        type="button"
                        onClick={() => handleSelectRemote(remote)}
                        disabled={isCreating}
                        className="flex flex-col items-start gap-0.5 px-2 py-1.5 rounded-md text-left hover:bg-accent disabled:opacity-50"
                      >
                        <span className="typography-ui-label text-foreground">
                          {isCreating ? (
                            <Icon name="loader-4" className="inline size-3 mr-1.5 animate-spin" />
                          ) : null}
                          {remote.name}
                        </span>
                        <span className="typography-micro text-muted-foreground truncate max-w-full">
                          {remote.pushUrl}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ) : !showCreate ? (
                <CommandItem onSelect={handleShowCreate}>
                  <Icon name="add" className="size-4" />
                  <span>{t('gitView.branch.create')}</span>
                </CommandItem>
              ) : (
                <div className="flex items-center gap-2 px-2 py-1.5 rounded-lg">
                  <input
                    ref={createInputRef}
                    placeholder={t('gitView.branch.newBranchPlaceholder')}
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    onClick={(e) => e.stopPropagation()}
                    onKeyDown={(e) => {
                      stopDropdownTypeahead(e);
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        handleCreate();
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        handleCancelCreate();
                      }
                    }}
                    className="flex-1 min-w-0 bg-transparent typography-meta outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={!sanitizedNewBranch || isCreating}
                    className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {isCreating ? (
                      <Icon name="loader-4" className="size-4 animate-spin" />
                    ) : (
                      <Icon name="add" className="size-4" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelCreate}
                    disabled={isCreating}
                    className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </div>
              )}
            </CommandGroup>

            <CommandSeparator />

            {hasSearchTerm ? (
              <MatchingBranchList
                items={rankedBranches.matching}
                currentBranch={currentBranch}
                branchInfo={branchInfo}
                existingWorktreeBranches={existingWorktreeBranches}
                onCheckout={handleCheckout}
              />
            ) : (
              <>
                <BranchList
                  branches={rankedBranches.otherLocal}
                  local
                  currentBranch={currentBranch}
                  branchInfo={branchInfo}
                  existingWorktreeBranches={existingWorktreeBranches}
                  onCheckout={handleCheckout}
                />

                <CommandSeparator />

                <BranchList
                  branches={rankedBranches.otherRemote}
                  onCheckout={handleCheckout}
                />
              </>
            )}

            {showWorktreeSection ? (
              <>
                <CommandSeparator />
                <CommandGroup>
                  <div className="flex items-center justify-between px-2 py-1">
                    <span className="text-muted-foreground text-xs leading-4 font-medium">{resolvedWorktreesLabel}</span>
                    {onCreateWorktree ? (
                      <button
                        type="button"
                        className="cursor-pointer text-muted-foreground text-xs leading-4 font-medium hover:text-foreground"
                        onPointerDown={(event) => { event.stopPropagation(); }}
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setOpen(false);
                          onCreateWorktree();
                        }}
                      >
                        {resolvedWorktreeNewLabel}
                      </button>
                    ) : null}
                  </div>
                  {projectRootOption && projectRootMatches ? (
                    <CommandItem onSelect={() => handleSelectDirectory(projectRootOption.value)}>
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="typography-micro text-muted-foreground">{resolvedProjectRootLabel}</span>
                        <span className="truncate typography-ui-label text-foreground">{projectRootOption.label}</span>
                      </span>
                      {selectedDirectory === projectRootOption.value ? (
                        <span className="typography-micro text-primary">{t('gitView.branch.currentBadge')}</span>
                      ) : null}
                    </CommandItem>
                  ) : null}
                  <WorktreeItems options={filteredWorktrees} selectedDirectory={selectedDirectory} onSelect={handleSelectDirectory} />
                </CommandGroup>
              </>
            ) : null}

          </CommandList>
        </Command>
  );

  if (presentation === 'mobile-sheet') {
    const mobileTrigger = React.cloneElement(trigger ?? defaultTrigger, {
      onClick: () => setOpen(true),
      'data-popup-open': open ? '' : undefined,
    } as React.HTMLAttributes<HTMLElement>);

    return (
      <>
        {mobileTrigger}
        <MobileResizableSheet
          id={`mobile-draft-branch-picker-sheet-${mobileSheetId}`}
          open={open}
          onOpenChange={setOpen}
          ariaLabel={t('gitView.branch.selectBranch')}
          closeAriaLabel={t('mobile.surface.closeAria')}
          resizeAriaLabel={t('mobile.sessions.sheet.resizeAria')}
        >
          {commandSurface}
        </MobileResizableSheet>
      </>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      {hideTooltip || trigger ? (
        menuTrigger
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            {menuTrigger}
          </TooltipTrigger>
          <TooltipContent sideOffset={8}>
            {iconOnly ? branchLabel : t('gitView.branch.currentBranchTooltip')}
          </TooltipContent>
        </Tooltip>
      )}

      <DropdownMenuContent align={resolvedContentAlign} className="w-72 p-0 max-h-[60vh] flex flex-col">
        {commandSurface}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
