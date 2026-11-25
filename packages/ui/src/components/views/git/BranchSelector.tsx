import React from 'react';
import { useEvent } from '@reactuses/core';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Kbd } from '@/components/ui/kbd';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MobileResizableSheet } from '@/components/ui/MobileResizableSheet';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
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
  /** Optional left-arrow handoff to an adjacent picker (e.g. draft project picker). */
  onNavigatePrevPicker?: () => void;
  /** Optional finalFocus target when closing the desktop dropdown. */
  finalFocus?: React.ComponentProps<typeof DropdownMenuContent>['finalFocus'];
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

const scrollRowIntoView = (container: HTMLElement | null, item: HTMLElement | null): void => {
  if (!container || !item) return;
  const containerRect = container.getBoundingClientRect();
  const itemRect = item.getBoundingClientRect();
  if (itemRect.top < containerRect.top) {
    container.scrollTop += itemRect.top - containerRect.top - 4;
  } else if (itemRect.bottom > containerRect.bottom) {
    container.scrollTop += itemRect.bottom - containerRect.bottom + 4;
  }
};

type PickerSelectableItem =
  | { kind: 'branch'; id: string; branch: string; isLocal: boolean }
  | { kind: 'directory'; id: string; directory: string }
  | { kind: 'create-branch'; id: string }
  | { kind: 'create-worktree'; id: string };

const ROW_BASE_CLASS =
  'min-h-8 w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[0.8125rem] leading-[1.125rem] text-foreground cursor-pointer outline-none select-none transition-colors';

interface BranchPickerBodyProps {
  open: boolean;
  currentBranch: string | null | undefined;
  localBranches: string[];
  remoteBranches: string[];
  branchInfo: Record<string, BranchInfo> | undefined;
  directory: string | null;
  selectedDirectory: string | null;
  projectRootOption: BranchSelectorWorktreeOption | null;
  worktreeOptions: BranchSelectorWorktreeOption[];
  existingWorktreeBranches?: ReadonlySet<string>;
  remotes: GitRemote[];
  keepOpenOnCheckout: boolean;
  followUpStep: BranchSelectorFollowUpStep | null;
  onNavigatePrevPicker?: () => void;
  onCheckout: (branch: string) => void | Promise<void>;
  onCreate: (name: string, remote?: GitRemote) => Promise<void>;
  onSelectDirectory?: (directory: string) => void;
  onCreateWorktree?: () => void;
  worktreesLabel?: string;
  worktreeNewLabel?: string;
  projectRootLabel?: string;
  presentation: 'dropdown' | 'mobile-sheet';
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  followUpListRef: React.RefObject<HTMLDivElement | null>;
  onRequestClose: () => void;
}

/**
 * Mounted only inside the popup/sheet presence boundary so closed composer
 * renders never scan, rank, or map large branch or worktree lists.
 */
function BranchPickerBody({
  open,
  currentBranch,
  localBranches,
  remoteBranches,
  branchInfo,
  directory,
  selectedDirectory,
  projectRootOption,
  worktreeOptions,
  existingWorktreeBranches,
  remotes,
  keepOpenOnCheckout,
  followUpStep,
  onNavigatePrevPicker,
  onCheckout,
  onCreate,
  onSelectDirectory,
  onCreateWorktree,
  worktreesLabel,
  worktreeNewLabel,
  projectRootLabel,
  presentation,
  searchInputRef,
  followUpListRef,
  onRequestClose,
}: BranchPickerBodyProps) {
  const { t } = useI18n();
  const [search, setSearch] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const [showCreate, setShowCreate] = React.useState(false);
  const [showRemoteSelect, setShowRemoteSelect] = React.useState(false);
  const [newBranchName, setNewBranchName] = React.useState('');
  const [isCreating, setIsCreating] = React.useState(false);
  const [followUpIndex, setFollowUpIndex] = React.useState(0);
  const [pendingActionId, setPendingActionId] = React.useState<string | null>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<Array<HTMLElement | null>>([]);
  const createInputRef = React.useRef<HTMLInputElement>(null);

  const hasMultipleRemotes = remotes.length > 1;
  const showWorktreeSection = Boolean(onSelectDirectory || onCreateWorktree);
  const recencyDirectory = directory ?? selectedDirectory;

  const branchRecency = React.useMemo(
    () => resolveBranchRecencyMap({ directory: recencyDirectory, branchInfo }),
    [branchInfo, recencyDirectory],
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
    [newBranchName],
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

  const visibleMatching = React.useMemo<RankedBranchItem[]>(
    () => (rankedBranches.matching.length > DEFAULT_BRANCH_RENDER_LIMIT
      ? rankedBranches.matching.slice(0, DEFAULT_BRANCH_RENDER_LIMIT)
      : rankedBranches.matching),
    [rankedBranches.matching],
  );
  const visibleLocal = React.useMemo(
    () => (rankedBranches.otherLocal.length > DEFAULT_BRANCH_RENDER_LIMIT
      ? rankedBranches.otherLocal.slice(0, DEFAULT_BRANCH_RENDER_LIMIT)
      : rankedBranches.otherLocal),
    [rankedBranches.otherLocal],
  );
  const visibleRemote = React.useMemo(
    () => (rankedBranches.otherRemote.length > DEFAULT_BRANCH_RENDER_LIMIT
      ? rankedBranches.otherRemote.slice(0, DEFAULT_BRANCH_RENDER_LIMIT)
      : rankedBranches.otherRemote),
    [rankedBranches.otherRemote],
  );

  const { flatItems, indexById } = React.useMemo(() => {
    const items: PickerSelectableItem[] = [];
    if (hasSearchTerm) {
      for (const item of visibleMatching) {
        items.push({
          kind: 'branch',
          id: `match:${item.source}:${item.label}`,
          branch: item.label,
          isLocal: item.source === 'local',
        });
      }
    } else {
      for (const branch of visibleLocal) {
        items.push({ kind: 'branch', id: `local:${branch}`, branch, isLocal: true });
      }
      for (const branch of visibleRemote) {
        items.push({ kind: 'branch', id: `remote:${branch}`, branch, isLocal: false });
      }
    }
    if (showWorktreeSection) {
      if (projectRootOption && projectRootMatches) {
        items.push({ kind: 'directory', id: `root:${projectRootOption.value}`, directory: projectRootOption.value });
      }
      for (const option of filteredWorktrees) {
        items.push({ kind: 'directory', id: `worktree:${option.value}`, directory: option.value });
      }
    }
    if (!showCreate && !showRemoteSelect) {
      items.push({ kind: 'create-branch', id: 'action:create-branch' });
      if (onCreateWorktree) {
        items.push({ kind: 'create-worktree', id: 'action:create-worktree' });
      }
    }
    const map = new Map<string, number>();
    items.forEach((item, index) => map.set(item.id, index));
    return { flatItems: items, indexById: map };
  }, [
    filteredWorktrees,
    hasSearchTerm,
    onCreateWorktree,
    projectRootMatches,
    projectRootOption,
    showCreate,
    showRemoteSelect,
    showWorktreeSection,
    visibleLocal,
    visibleMatching,
    visibleRemote,
  ]);

  React.useEffect(() => {
    setActiveIndex(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [search]);

  React.useEffect(() => {
    if (flatItems.length === 0) {
      setActiveIndex(0);
    } else if (activeIndex >= flatItems.length) {
      setActiveIndex(flatItems.length - 1);
    }
  }, [activeIndex, flatItems.length]);

  React.useEffect(() => {
    if (!open) return;
    if (followUpStep) {
      setFollowUpIndex(0);
      const frame = window.requestAnimationFrame(() => {
        followUpListRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (showCreate) {
      const frame = window.requestAnimationFrame(() => {
        createInputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
    if (!showRemoteSelect) {
      const frame = window.requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
      return () => window.cancelAnimationFrame(frame);
    }
  }, [followUpListRef, followUpStep, open, searchInputRef, showCreate, showRemoteSelect]);

  const handleCheckout = useEvent((branch: string) => {
    recordRecentBranchUsage(recencyDirectory, branch);
    if (branch === currentBranch) {
      onRequestClose();
      return;
    }
    void onCheckout(branch);
    if (!keepOpenOnCheckout) {
      onRequestClose();
    }
    setSearch('');
  });

  const handleSelectDirectory = useEvent((dir: string) => {
    onSelectDirectory?.(dir);
    onRequestClose();
    setSearch('');
  });

  const handleShowCreate = useEvent(() => {
    setShowCreate(true);
  });

  const handleCreate = useEvent(async () => {
    if (!sanitizedNewBranch || isCreating) return;
    if (hasMultipleRemotes) {
      setShowRemoteSelect(true);
      return;
    }
    setIsCreating(true);
    try {
      await onCreate(sanitizedNewBranch, remotes[0]);
      recordRecentBranchUsage(recencyDirectory, sanitizedNewBranch);
      setNewBranchName('');
      setShowCreate(false);
      if (!keepOpenOnCheckout) {
        onRequestClose();
      }
    } finally {
      setIsCreating(false);
    }
  });

  const handleSelectRemote = useEvent(async (remote: GitRemote) => {
    if (!sanitizedNewBranch || isCreating) return;
    setIsCreating(true);
    try {
      await onCreate(sanitizedNewBranch, remote);
      recordRecentBranchUsage(recencyDirectory, sanitizedNewBranch);
      setNewBranchName('');
      setShowCreate(false);
      setShowRemoteSelect(false);
      if (!keepOpenOnCheckout) {
        onRequestClose();
      }
    } finally {
      setIsCreating(false);
    }
  });

  const handleCancelCreate = useEvent(() => {
    setNewBranchName('');
    setShowCreate(false);
    setShowRemoteSelect(false);
  });

  const activateItem = useEvent((item: PickerSelectableItem | undefined) => {
    if (!item) return;
    if (item.kind === 'branch') {
      handleCheckout(item.branch);
      return;
    }
    if (item.kind === 'directory') {
      handleSelectDirectory(item.directory);
      return;
    }
    if (item.kind === 'create-branch') {
      handleShowCreate();
      return;
    }
    if (item.kind === 'create-worktree') {
      onRequestClose();
      onCreateWorktree?.();
    }
  });

  const moveSelection = useEvent((direction: 1 | -1) => {
    const total = flatItems.length;
    if (total === 0) return;
    const nextIndex = (activeIndex + direction + total) % total;
    setActiveIndex(nextIndex);
    window.requestAnimationFrame(() => {
      scrollRowIntoView(scrollRef.current, itemRefs.current[nextIndex] ?? null);
    });
  });

  const handleLevel1KeyDown = useEvent((event: React.KeyboardEvent) => {
    if (showCreate || showRemoteSelect) return;
    event.stopPropagation();

    const targetInput = event.target instanceof HTMLInputElement ? event.target : null;

    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      moveSelection(1);
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault();
      moveSelection(-1);
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      activateItem(flatItems[activeIndex]);
      return;
    }
    if (event.key === 'ArrowRight') {
      const atEnd = !targetInput
        || targetInput.value.length === 0
        || (targetInput.selectionStart === targetInput.value.length
          && targetInput.selectionEnd === targetInput.value.length);
      if (atEnd) {
        const active = flatItems[activeIndex];
        if (active && active.kind === 'branch' && active.branch !== currentBranch) {
          event.preventDefault();
          activateItem(active);
        }
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      const atStart = !targetInput
        || targetInput.value.length === 0
        || (targetInput.selectionStart === 0 && targetInput.selectionEnd === 0);
      if (atStart && onNavigatePrevPicker) {
        event.preventDefault();
        onRequestClose();
        window.requestAnimationFrame(() => onNavigatePrevPicker());
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onRequestClose();
    }
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
    event.stopPropagation();
    const count = followUpStep.actions.length;
    if (event.key === 'ArrowDown' || (event.key === 'Tab' && !event.shiftKey)) {
      event.preventDefault();
      if (count > 0) setFollowUpIndex((prev) => (prev + 1) % count);
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)) {
      event.preventDefault();
      if (count > 0) setFollowUpIndex((prev) => (prev - 1 + count) % count);
      return;
    }
    if (event.key === 'Enter' || event.key === 'ArrowRight') {
      event.preventDefault();
      const action = followUpStep.actions[followUpIndex];
      if (action) runFollowUpAction(action);
      return;
    }
    if (event.key === 'Escape' || event.key === 'ArrowLeft' || event.key === 'Backspace') {
      event.preventDefault();
      if (!followUpStep.pending) followUpStep.onBack();
    }
  });

  const resolvedWorktreesLabel = worktreesLabel ?? t('chat.chatInput.worktrees');
  const resolvedWorktreeNewLabel = worktreeNewLabel ?? t('chat.chatInput.branchSwitch.createWorktree');
  const resolvedProjectRootLabel = projectRootLabel ?? t('chat.chatInput.projectRoot');

  if (followUpStep) {
    return (
      <div
        ref={followUpListRef}
        tabIndex={-1}
        role="listbox"
        data-branch-followup-step
        onKeyDown={handleFollowUpKeyDown}
        className="flex min-h-0 flex-1 flex-col outline-none"
      >
        <div className="flex shrink-0 items-center gap-1.5 border-b border-[var(--yuri-popup-divider)] px-2 py-1.5">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={followUpStep.pending}
            onClick={followUpStep.onBack}
            aria-label={t('header.actions.backAria')}
            className="size-6 shrink-0 text-muted-foreground"
          >
            <Icon name="arrow-left" className="size-3.5" />
          </Button>
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {followUpStep.title}
          </span>
        </div>

        <div className="model-picker-list flex flex-col gap-0.5">
          {followUpStep.actions.map((action, index) => {
            const isHighlighted = index === followUpIndex;
            return (
              <button
                key={action.id}
                type="button"
                role="option"
                aria-selected={isHighlighted}
                data-branch-followup-action={action.id}
                data-selected={isHighlighted ? 'true' : undefined}
                disabled={followUpStep.pending}
                onMouseEnter={() => setFollowUpIndex(index)}
                onClick={() => runFollowUpAction(action)}
                className={cn(
                  ROW_BASE_CLASS,
                  isHighlighted
                    ? 'bg-interactive-selection text-interactive-selection-foreground'
                    : 'hover:bg-interactive-hover/50',
                  followUpStep.pending && 'pointer-events-none opacity-50',
                )}
              >
                {followUpStep.pending && pendingActionId === action.id ? (
                  <Icon name="loader-4" className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <Icon name={action.icon} className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate font-medium">{action.label}</span>
              </button>
            );
          })}
        </div>

        <div className="model-picker-footer flex shrink-0 items-center gap-3 text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Kbd variant="hint">
              <Icon name="arrow-up" className="size-2.5" />
              <Icon name="arrow-down" className="size-2.5" />
            </Kbd>
            {t('directoryExplorerDialog.footer.navigate')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd variant="hint">
              <Icon name="corner-down-left" className="size-2.5" />
            </Kbd>
            {t('directoryExplorerDialog.footer.select')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd variant="hint">
              <Icon name="arrow-left" className="size-2.5" />
            </Kbd>
            {t('header.actions.backAria')}
          </span>
        </div>
      </div>
    );
  }

  const renderBranchRow = (id: string, branch: string, isLocal: boolean) => {
    const rowIndex = indexById.get(id) ?? -1;
    const isHighlighted = rowIndex >= 0 && rowIndex === activeIndex;
    const isCurrent = Boolean(isLocal && currentBranch === branch);
    const hasExistingWorktree = Boolean(isLocal && !isCurrent && existingWorktreeBranches?.has(branch));
    const info = isLocal ? branchInfo?.[branch] : undefined;

    return (
      <button
        key={id}
        ref={(el) => { if (rowIndex >= 0) itemRefs.current[rowIndex] = el; }}
        type="button"
        role="option"
        aria-selected={isCurrent}
        data-branch-item={id}
        data-selected={isHighlighted ? 'true' : undefined}
        onMouseEnter={() => { if (rowIndex >= 0) setActiveIndex(rowIndex); }}
        onClick={() => handleCheckout(branch)}
        className={cn(
          ROW_BASE_CLASS,
          isHighlighted
            ? 'bg-interactive-selection text-interactive-selection-foreground'
            : 'hover:bg-interactive-hover/50',
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{branch}</span>
          {isLocal && (info?.ahead || info?.behind) ? (
            <span className="text-[0.6875rem] leading-[0.875rem] text-muted-foreground">
              {info.ahead || 0} ahead · {info.behind || 0} behind
            </span>
          ) : null}
        </span>
        {isCurrent ? (
          <span className="shrink-0 text-[0.6875rem] leading-4 text-primary">
            {t('gitView.branch.currentBadge')}
          </span>
        ) : hasExistingWorktree ? (
          <span className="shrink-0 text-[0.6875rem] leading-4 text-muted-foreground">
            {t('gitView.branch.worktreeBadge')}
          </span>
        ) : null}
      </button>
    );
  };

  const createBranchRowIndex = indexById.get('action:create-branch') ?? -1;
  const createWorktreeRowIndex = indexById.get('action:create-worktree') ?? -1;
  const noSearchResults = hasSearchTerm
    && visibleMatching.length === 0
    && filteredWorktrees.length === 0
    && !projectRootMatches;

  return (
    <div
      data-branch-picker-surface
      onKeyDown={handleLevel1KeyDown}
      className="flex h-full min-h-0 flex-col outline-none"
    >
      <div
        className="model-picker-search-area"
        data-mobile-sheet-no-dismiss={presentation === 'mobile-sheet' ? '' : undefined}
      >
        <div className="relative">
          <Icon
            name="search"
            className="pointer-events-none absolute left-0 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchInputRef}
            type="text"
            autoFocus
            data-branch-search-input
            placeholder={t('gitView.branch.searchPlaceholder')}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="model-picker-search h-6 pl-7"
          />
        </div>
      </div>

      <ScrollableOverlay
        ref={scrollRef}
        outerClassName="max-h-[min(360px,calc(60vh-6rem))] min-h-0 flex-1 overflow-x-hidden"
        className="overlay-scrollbar-target--no-gutter"
        scrollbarClassName="overlay-scrollbar--flush overlay-scrollbar--dense overlay-scrollbar--zero"
        disableHorizontal
      >
        <div role="listbox" className="model-picker-list flex flex-col gap-0.5">
          {noSearchResults ? (
            <div className="px-2.5 py-5 text-center text-xs text-muted-foreground">
              {t('gitView.branch.empty')}
            </div>
          ) : null}

          {hasSearchTerm ? (
            visibleMatching.length > 0 ? (
              <div className="flex flex-col gap-0.5">
                <div className="model-picker-section-header flex items-center">
                  <span className="min-w-0 truncate">{t('session.newWorktree.matchingBranches')}</span>
                </div>
                {visibleMatching.map((item) =>
                  renderBranchRow(`match:${item.source}:${item.label}`, item.label, item.source === 'local'),
                )}
              </div>
            ) : null
          ) : (
            <>
              <div className="flex flex-col gap-0.5">
                <div className="model-picker-section-header flex items-center">
                  <span className="min-w-0 truncate">{t('gitView.branch.localBranches')}</span>
                </div>
                {visibleLocal.length > 0 ? (
                  visibleLocal.map((branch) => renderBranchRow(`local:${branch}`, branch, true))
                ) : (
                  <div className="px-2.5 py-2 text-center text-xs text-muted-foreground">
                    {t('gitView.branch.noLocalBranches')}
                  </div>
                )}
              </div>

              <div className="model-picker-section-divider" />

              <div className="flex flex-col gap-0.5">
                <div className="model-picker-section-header flex items-center">
                  <span className="min-w-0 truncate">{t('gitView.branch.remoteBranches')}</span>
                </div>
                {visibleRemote.length > 0 ? (
                  visibleRemote.map((branch) => renderBranchRow(`remote:${branch}`, branch, false))
                ) : (
                  <div className="px-2.5 py-2 text-center text-xs text-muted-foreground">
                    {t('gitView.branch.noRemoteBranches')}
                  </div>
                )}
              </div>
            </>
          )}

          {showWorktreeSection && ((projectRootOption && projectRootMatches) || filteredWorktrees.length > 0) ? (
            <>
              <div className="model-picker-section-divider" />
              <div className="flex flex-col gap-0.5">
                <div className="model-picker-section-header flex items-center justify-between">
                  <span className="min-w-0 truncate">{resolvedWorktreesLabel}</span>
                </div>
                {projectRootOption && projectRootMatches ? (() => {
                  const id = `root:${projectRootOption.value}`;
                  const rowIndex = indexById.get(id) ?? -1;
                  const isHighlighted = rowIndex >= 0 && rowIndex === activeIndex;
                  const isSelected = selectedDirectory === projectRootOption.value;
                  return (
                    <button
                      key={id}
                      ref={(el) => { if (rowIndex >= 0) itemRefs.current[rowIndex] = el; }}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-branch-item={id}
                      data-selected={isHighlighted ? 'true' : undefined}
                      onMouseEnter={() => { if (rowIndex >= 0) setActiveIndex(rowIndex); }}
                      onClick={() => handleSelectDirectory(projectRootOption.value)}
                      className={cn(
                        ROW_BASE_CLASS,
                        isHighlighted
                          ? 'bg-interactive-selection text-interactive-selection-foreground'
                          : 'hover:bg-interactive-hover/50',
                      )}
                    >
                      <span className="flex min-w-0 flex-1 flex-col">
                        <span className="text-[0.6875rem] leading-[0.875rem] text-muted-foreground">
                          {resolvedProjectRootLabel}
                        </span>
                        <span className="truncate font-medium">{projectRootOption.label}</span>
                      </span>
                      {isSelected ? (
                        <span className="shrink-0 text-[0.6875rem] leading-4 text-primary">
                          {t('gitView.branch.currentBadge')}
                        </span>
                      ) : null}
                    </button>
                  );
                })() : null}
                {filteredWorktrees.map((option) => {
                  const id = `worktree:${option.value}`;
                  const rowIndex = indexById.get(id) ?? -1;
                  const isHighlighted = rowIndex >= 0 && rowIndex === activeIndex;
                  const isSelected = selectedDirectory === option.value;
                  return (
                    <button
                      key={id}
                      ref={(el) => { if (rowIndex >= 0) itemRefs.current[rowIndex] = el; }}
                      type="button"
                      role="option"
                      aria-selected={isSelected}
                      data-branch-item={id}
                      data-selected={isHighlighted ? 'true' : undefined}
                      onMouseEnter={() => { if (rowIndex >= 0) setActiveIndex(rowIndex); }}
                      onClick={() => handleSelectDirectory(option.value)}
                      className={cn(
                        ROW_BASE_CLASS,
                        isHighlighted
                          ? 'bg-interactive-selection text-interactive-selection-foreground'
                          : 'hover:bg-interactive-hover/50',
                      )}
                    >
                      <span className="min-w-0 flex-1 truncate font-medium">
                        {option.pending ? '⏳ ' : ''}{option.label}
                      </span>
                      {isSelected ? (
                        <span className="shrink-0 text-[0.6875rem] leading-4 text-primary">
                          {t('gitView.branch.currentBadge')}
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            </>
          ) : null}
        </div>
      </ScrollableOverlay>

      <div className="composer-picker-actions flex flex-col gap-0.5">
        {showRemoteSelect ? (
          <div className="px-1.5 py-1">
            <div className="mb-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => setShowRemoteSelect(false)}
                disabled={isCreating}
                className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
              >
                <Icon name="arrow-left" className="size-3.5" />
              </button>
              <span className="text-xs text-muted-foreground">
                {t('gitView.branch.pushToPrefix')}{' '}
                <span className="font-medium text-foreground">{sanitizedNewBranch}</span>{' '}
                {t('gitView.branch.pushToSuffix')}
              </span>
            </div>
            <div className="flex flex-col gap-0.5">
              {remotes.map((remote) => (
                <button
                  key={remote.name}
                  type="button"
                  onClick={() => void handleSelectRemote(remote)}
                  disabled={isCreating}
                  className={cn(ROW_BASE_CLASS, 'flex-col items-start gap-0.5 hover:bg-interactive-hover/50')}
                >
                  <span className="font-medium text-foreground">
                    {isCreating ? (
                      <Icon name="loader-4" className="mr-1.5 inline size-3 animate-spin" />
                    ) : null}
                    {remote.name}
                  </span>
                  <span className="max-w-full truncate text-[0.6875rem] leading-4 text-muted-foreground">
                    {remote.pushUrl}
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : showCreate ? (
          <div className="flex items-center gap-2 rounded-lg px-2 py-1">
            <input
              ref={createInputRef}
              placeholder={t('gitView.branch.newBranchPlaceholder')}
              value={newBranchName}
              onChange={(event) => setNewBranchName(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void handleCreate();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  handleCancelCreate();
                }
              }}
              className="min-w-0 flex-1 bg-transparent text-[0.8125rem] leading-5 outline-none placeholder:text-muted-foreground"
            />
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={!sanitizedNewBranch || isCreating}
              className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              {isCreating ? (
                <Icon name="loader-4" className="size-3.5 animate-spin" />
              ) : (
                <Icon name="add" className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={handleCancelCreate}
              disabled={isCreating}
              className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <Icon name="close" className="size-3.5" />
            </button>
          </div>
        ) : (
          <>
            <button
              ref={(el) => { if (createBranchRowIndex >= 0) itemRefs.current[createBranchRowIndex] = el; }}
              type="button"
              role="menuitem"
              data-branch-item="action:create-branch"
              data-selected={createBranchRowIndex >= 0 && activeIndex === createBranchRowIndex ? 'true' : undefined}
              onMouseEnter={() => { if (createBranchRowIndex >= 0) setActiveIndex(createBranchRowIndex); }}
              onClick={handleShowCreate}
              className={cn(
                'flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors',
                createBranchRowIndex >= 0 && activeIndex === createBranchRowIndex
                  ? 'bg-interactive-selection text-interactive-selection-foreground'
                  : 'hover:bg-interactive-hover/50 hover:text-foreground',
              )}
            >
              <Icon name="add" className="size-3.5 shrink-0" />
              <span className="truncate">{t('gitView.branch.create')}</span>
            </button>
            {onCreateWorktree ? (
              <button
                ref={(el) => { if (createWorktreeRowIndex >= 0) itemRefs.current[createWorktreeRowIndex] = el; }}
                type="button"
                role="menuitem"
                data-branch-item="action:create-worktree"
                data-selected={createWorktreeRowIndex >= 0 && activeIndex === createWorktreeRowIndex ? 'true' : undefined}
                onMouseEnter={() => { if (createWorktreeRowIndex >= 0) setActiveIndex(createWorktreeRowIndex); }}
                onClick={() => {
                  onRequestClose();
                  onCreateWorktree();
                }}
                className={cn(
                  'flex min-h-8 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs text-muted-foreground transition-colors',
                  createWorktreeRowIndex >= 0 && activeIndex === createWorktreeRowIndex
                    ? 'bg-interactive-selection text-interactive-selection-foreground'
                    : 'hover:bg-interactive-hover/50 hover:text-foreground',
                )}
              >
                <Icon name="git-branch" className="size-3.5 shrink-0" />
                <span className="truncate">{resolvedWorktreeNewLabel}</span>
              </button>
            ) : null}
          </>
        )}
      </div>

      {presentation === 'dropdown' ? (
        <div className="model-picker-footer flex shrink-0 items-center gap-3 text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Kbd variant="hint">
              <Icon name="arrow-up" className="size-2.5" />
              <Icon name="arrow-down" className="size-2.5" />
            </Kbd>
            {t('directoryExplorerDialog.footer.navigate')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <Kbd variant="hint">
              <Icon name="corner-down-left" className="size-2.5" />
            </Kbd>
            {t('directoryExplorerDialog.footer.select')}
          </span>
          {onNavigatePrevPicker ? (
            <span className="inline-flex items-center gap-1.5">
              <Kbd variant="hint">
                <Icon name="arrow-left" className="size-2.5" />
              </Kbd>
              {t('chat.leaderKey.action.project')}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export const BranchSelector: React.FC<BranchSelectorProps> = ({
  currentBranch,
  localBranches,
  remoteBranches,
  branchInfo,
  directory = null,
  onCheckout,
  keepOpenOnCheckout = false,
  followUpStep = null,
  onNavigatePrevPicker,
  finalFocus,
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
  const searchInputRef = React.useRef<HTMLInputElement>(null);
  const followUpListRef = React.useRef<HTMLDivElement>(null);
  const mobileSheetId = React.useId();
  const open = controlledOpen ?? isOpen;
  const setOpen = useEvent((nextOpen: boolean) => {
    if (controlledOpen === undefined) setIsOpen(nextOpen);
    onOpenChange?.(nextOpen);
  });

  const branchLabel = triggerLabel || currentBranch || t('gitView.branch.detachedHead');
  const resolvedContentAlign = contentAlign ?? (iconOnly ? 'end' : 'start');

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

  const pickerBody = (
    <BranchPickerBody
      open={open}
      currentBranch={currentBranch}
      localBranches={localBranches}
      remoteBranches={remoteBranches}
      branchInfo={branchInfo}
      directory={directory}
      selectedDirectory={selectedDirectory}
      projectRootOption={projectRootOption}
      worktreeOptions={worktreeOptions}
      existingWorktreeBranches={existingWorktreeBranches}
      remotes={remotes}
      keepOpenOnCheckout={keepOpenOnCheckout}
      followUpStep={followUpStep}
      onNavigatePrevPicker={onNavigatePrevPicker}
      onCheckout={onCheckout}
      onCreate={onCreate}
      onSelectDirectory={onSelectDirectory}
      onCreateWorktree={onCreateWorktree}
      worktreesLabel={worktreesLabel}
      worktreeNewLabel={worktreeNewLabel}
      projectRootLabel={projectRootLabel}
      presentation={presentation}
      searchInputRef={searchInputRef}
      followUpListRef={followUpListRef}
      onRequestClose={() => setOpen(false)}
    />
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
          <div className="yuri-composer-picker flex h-full min-h-0 flex-col">
            {pickerBody}
          </div>
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

      <DropdownMenuContent
        align={resolvedContentAlign}
        finalFocus={finalFocus}
        className="yuri-composer-picker flex max-h-[60vh] w-[min(320px,calc(100vw-2rem))] flex-col p-0"
      >
        {pickerBody}
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
