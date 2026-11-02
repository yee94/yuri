import React from 'react';
import { useEvent } from '@reactuses/core';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import { cn } from '@/lib/utils';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useGitHubAuthQuery } from '@/queries/githubAuthQueries';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { useDeviceInfo } from '@/lib/device';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { useInfiniteQuery } from '@tanstack/react-query';
import type { GitHubPullRequestContextResult, GitHubRepoSelector } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { queryKeys } from '@/lib/queryRuntime';

const parsePrNumber = (value: string): number | null => {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const urlMatch = trimmed.match(/\/pull\/(\d+)(?:\b|\/|$)/i);
  if (urlMatch) {
    const parsed = Number(urlMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  const hashMatch = trimmed.match(/^#?(\d+)$/);
  if (hashMatch) {
    const parsed = Number(hashMatch[1]);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  return null;
};

const buildPullRequestContextText = (payload: GitHubPullRequestContextResult) => {
  return `GitHub pull request context (JSON)\n${JSON.stringify(payload, null, 2)}`;
};

export function GitHubPrPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect?: (pr: {
    number: number;
    title: string;
    url: string;
    head: string;
    base: string;
    includeDiff: boolean;
    instructionsText: string;
    contextText: string;
    author?: { login: string; avatarUrl?: string };
  }) => void;
}) {
  const { t } = useI18n();
  const { github } = useRuntimeAPIs();
  const githubAuthQuery = useGitHubAuthQuery();
  const githubAuthStatus = githubAuthQuery.data ?? null;
  const githubAuthChecked = githubAuthQuery.isFetched;
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const isMobile = useUIStore((state) => state.isMobile);
  const { isTablet } = useDeviceInfo();
  const alwaysShowActions = isMobile || isTablet;
  const activeProject = useProjectsStore((state) => state.getActiveProject());

  const projectDirectory = activeProject?.path ?? null;

  const [query, setQuery] = React.useState('');
  const [includeDiff, setIncludeDiff] = React.useState(false);
  const [loadingPrNumber, setLoadingPrNumber] = React.useState<number | null>(null);
  const actionRequestGenerationRef = React.useRef(0);

  const directNumber = React.useMemo(() => parsePrNumber(query), [query]);
  const debouncedQuery = useDebouncedValue(query, 350);
  const searchQuery = directNumber ? '' : debouncedQuery.trim();
  const searchReady = Boolean(directNumber) || query === debouncedQuery;
  const enabled = open && searchReady && Boolean(projectDirectory) && Boolean(github?.prsList) && !(githubAuthChecked && githubAuthStatus?.connected === false);
  const prsQuery = useInfiniteQuery({
    queryKey: queryKeys.scoped('github-prs', projectDirectory, searchQuery),
    enabled,
    initialPageParam: 1,
    refetchOnMount: 'always',
    queryFn: ({ pageParam }) => github!.prsList!(projectDirectory!, {
      page: pageParam,
      ...(searchQuery ? { query: searchQuery } : {}),
    }),
    getNextPageParam: (lastPage) => lastPage.hasMore ? (lastPage.page ?? 1) + 1 : undefined,
  });
  const result = searchReady ? prsQuery.data?.pages.at(-1) ?? null : null;
  const prs = searchReady ? prsQuery.data?.pages.flatMap((page) => page.prs ?? []) ?? [] : [];
  const hasMore = searchReady && prsQuery.hasNextPage;
  const isLoading = !directNumber && !searchReady || prsQuery.isLoading;
  const isLoadingMore = searchReady && prsQuery.isFetchingNextPage;
  const error = searchReady && prsQuery.error
    ? prsQuery.error instanceof Error ? prsQuery.error.message : String(prsQuery.error)
    : null;
  const loadMore = useEvent(async () => {
    try {
      await prsQuery.fetchNextPage();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('session.githubPrPicker.toast.loadMoreFailed'), { description: message });
    }
  });

  React.useEffect(() => {
    if (!open) {
      ++actionRequestGenerationRef.current;
      setQuery('');
      setIncludeDiff(false);
      setLoadingPrNumber(null);
    }
  }, [open]);

  React.useEffect(() => {
    ++actionRequestGenerationRef.current;
  }, [open, projectDirectory]);

  const connected = !githubAuthChecked || (githubAuthStatus?.connected !== false && result?.connected !== false);

  const openGitHubSettings = useEvent(() => {
    setSettingsPage('github');
    setSettingsDialogOpen(true);
  });

  const attachPr = useEvent(async (prNumber: number, sourceRepo?: GitHubRepoSelector | null) => {
    if (!projectDirectory) {
      toast.error(t('session.githubPrPicker.error.noActiveProject'));
      return;
    }
    if (!github?.prContext) {
      toast.error(t('session.githubPrPicker.error.runtimeUnavailable'));
      return;
    }
    if (loadingPrNumber) return;

    const requestGeneration = ++actionRequestGenerationRef.current;
    const isCurrentRequest = () => actionRequestGenerationRef.current === requestGeneration;
    setLoadingPrNumber(prNumber);
    try {
      const context = await github.prContext(projectDirectory, prNumber, {
        includeDiff,
        includeCheckDetails: false,
        sourceRepo,
      });
      if (!isCurrentRequest()) return;

      if (context.connected === false) {
        toast.error(t('session.githubPrPicker.error.notConnected'));
        return;
      }

      if (!context.pr) {
        toast.error(t('session.githubPrPicker.error.prNotFound'));
        return;
      }

      if (!context.repo) {
        toast.error(t('session.githubPrPicker.error.repoNotResolvable'), {
          description: t('session.githubPrPicker.error.repoMustBeGithub'),
        });
        return;
      }

      if (onSelect) {
        const instructionsText = await renderMagicPrompt('github.pr.review.instructions');
        if (!isCurrentRequest()) return;
        onSelect({
          number: context.pr.number,
          title: context.pr.title,
          url: context.pr.url,
          head: context.pr.head,
          base: context.pr.base,
          includeDiff,
          instructionsText,
          contextText: buildPullRequestContextText(context),
          author: context.pr.author
            ? {
              login: context.pr.author.login,
              avatarUrl: context.pr.author.avatarUrl,
            }
            : undefined,
        });
      }
      onOpenChange(false);
    } catch (e) {
      if (!isCurrentRequest()) return;
      const message = e instanceof Error ? e.message : String(e);
      toast.error(t('session.githubPrPicker.toast.loadDetailsFailed'), { description: message });
    } finally {
      if (isCurrentRequest()) setLoadingPrNumber(null);
    }
  });

  const title = t('session.githubPrPicker.title');
  const description = t('session.githubPrPicker.description');

  const content = (
    <>
      <div className="yuri-picker-search mt-2 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-0">
          <Icon name="search" className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t('session.githubPrPicker.searchPlaceholder')}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            className="pl-9 w-full"
          />
        </div>
        <button
          type="button"
          onClick={() => setIncludeDiff((prev) => !prev)}
          className="h-9 shrink-0 flex items-center gap-2 text-left"
          aria-pressed={includeDiff}
          aria-label={t('session.githubPrPicker.includeDiffAria')}
        >
          <span onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={includeDiff}
              onChange={(checked) => setIncludeDiff(checked)}
              ariaLabel={t('session.githubPrPicker.includeDiffAria')}
            />
          </span>
          <span className="typography-small text-muted-foreground whitespace-nowrap">{t('session.githubPrPicker.includeDiff')}</span>
        </button>
      </div>

      <div className={cn('yuri-picker-list', isMobile ? 'min-h-0' : 'flex-1 overflow-y-auto')}>
          {!projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{t('session.githubPrPicker.empty.noActiveProject')}</div>
          ) : null}

          {!github ? (
            <div className="text-center text-muted-foreground py-8">{t('session.githubPrPicker.empty.runtimeUnavailable')}</div>
          ) : null}

          {isLoading ? (
            <div className="text-center text-muted-foreground py-8 flex items-center justify-center gap-2">
              <Icon name="loader-4" className="h-4 w-4 animate-spin" />
              {t('session.githubPrPicker.loading.pullRequests')}
            </div>
          ) : null}

          {connected === false ? (
            <div className="text-center text-muted-foreground py-8 space-y-3">
              <div>{t('session.githubPrPicker.empty.notConnected')}</div>
              <div className="flex justify-center">
                <Button variant="outline" size="sm" onClick={openGitHubSettings}>
                  {t('session.githubPrPicker.actions.openSettings')}
                </Button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="text-center text-muted-foreground py-8 break-words">{error}</div>
          ) : null}

          {directNumber && projectDirectory && github && connected ? (
            <div
              className={cn(
                'yuri-picker-row group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
                loadingPrNumber === directNumber && 'bg-interactive-selection/30'
              )}
              onClick={() => void attachPr(directNumber)}
            >
              <span className="typography-meta text-muted-foreground w-5 text-right flex-shrink-0">#</span>
              <p className="flex-1 min-w-0 typography-small text-foreground truncate ml-0.5">
                {t('session.githubPrPicker.actions.usePullRequest', { number: directNumber })}
              </p>
              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {loadingPrNumber === directNumber ? (
                  <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : null}
              </div>
            </div>
          ) : null}

          {prs.length === 0 && !isLoading && !error && connected && github && projectDirectory ? (
            <div className="text-center text-muted-foreground py-8">{debouncedQuery.trim() ? t('session.githubPrPicker.empty.noPullRequestsFound') : t('session.githubPrPicker.empty.noOpenPullRequestsFound')}</div>
          ) : null}

          {prs.map((pr) => (
            <div
              key={`${pr.sourceRepo?.owner ?? ''}-${pr.sourceRepo?.repo ?? ''}-${pr.number}`}
              className={cn(
                'yuri-picker-row group flex items-center gap-2 py-1.5 hover:bg-interactive-hover/30 rounded transition-colors cursor-pointer',
                loadingPrNumber === pr.number && 'bg-interactive-selection/30'
              )}
              onClick={() => void attachPr(pr.number, pr.sourceRepo)}
            >
              <div className="flex-1 min-w-0 ml-0.5">
                <p className="yuri-picker-label typography-small text-foreground truncate">
                  <span className="text-muted-foreground mr-1">#{pr.number}</span>
                  {pr.title}
                </p>
                {pr.sourceRepo?.source === 'upstream' ? (
                  <span className="typography-micro px-1 py-0.5 rounded bg-status-info/10 text-status-info">
                    {pr.sourceRepo.owner}/{pr.sourceRepo.repo}
                  </span>
                ) : null}
                <p className="yuri-picker-meta typography-meta text-muted-foreground truncate">{pr.head} → {pr.base}</p>
              </div>

              <div className="flex-shrink-0 h-5 flex items-center mr-2">
                {loadingPrNumber === pr.number ? (
                  <Icon name="loader-4" className="h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={cn(
                      "h-5 w-5 items-center justify-center text-muted-foreground hover:text-foreground transition-colors",
                      alwaysShowActions ? "flex" : "hidden group-hover:flex"
                    )}
                    onClick={(e) => e.stopPropagation()}
                    aria-label={t('session.githubPrPicker.actions.openInGitHubAria')}
                  >
                    <Icon name="external-link" className="h-4 w-4" />
                  </a>
                )}
              </div>
            </div>
          ))}

          {hasMore && connected && projectDirectory && github ? (
            <div className="py-2 flex justify-center">
              <button
                type="button"
                onClick={() => void loadMore()}
                disabled={isLoadingMore || Boolean(loadingPrNumber)}
                className={cn(
                  'typography-meta text-muted-foreground hover:text-foreground transition-colors underline underline-offset-4',
                  (isLoadingMore || Boolean(loadingPrNumber)) && 'opacity-50 cursor-not-allowed hover:text-muted-foreground'
                )}
              >
                {isLoadingMore ? (
                  <span className="inline-flex items-center gap-2">
                    <Icon name="loader-4" className="h-4 w-4 animate-spin" />
                    {t('session.githubPrPicker.loading.more')}
                  </span>
                ) : (
                  t('session.githubPrPicker.actions.loadMore')
                )}
              </button>
            </div>
          ) : null}
      </div>
    </>
  );

  if (isMobile) {
    return (
      <MobileOverlayPanel
        open={open}
        title={title}
        onClose={() => onOpenChange(false)}
        renderHeader={(closeButton) => (
          <div className="flex flex-col gap-1.5 px-3 py-2 border-b border-border/40">
            <div className="flex items-center justify-between">
              <h2 className="typography-ui-label font-semibold text-foreground">{title}</h2>
              {closeButton}
            </div>
            <p className="typography-small text-muted-foreground">{description}</p>
          </div>
        )}
      >
        {content}
      </MobileOverlayPanel>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent presentation="picker">
        <DialogHeader className="yuri-picker-header">
          <DialogTitle className="yuri-picker-title">
            {title}
          </DialogTitle>
        </DialogHeader>

        {content}
      </DialogContent>
    </Dialog>
  );
}
