import { memo } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SELECTOR_CHIP_HOVER_CLASS } from '@/components/chat/message/parts/toolRowChrome';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { cn, formatDirectoryName, truncatePathMiddle } from '@/lib/utils';
import { useGitBranchesQuery } from '@/queries/gitBranchQueries';
import { useIsGitRepo } from '@/stores/useGitStore';

function WorkspaceDirectoryRow({ directory, primary }: { directory: string; primary: boolean }) {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const isGitRepo = useIsGitRepo(directory);
  const query = useGitBranchesQuery(directory, git, isGitRepo !== false);
  const current = isGitRepo === false || query.isError ? undefined : query.data?.current?.trim();
  const branch = current === 'HEAD' ? t('gitView.branch.detachedHead') : current;

  return (
    <li data-workspace-directory className="min-w-0">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate font-medium text-foreground">{formatDirectoryName(directory)}</span>
          {primary ? <span className="shrink-0">· {t('workspace.paths.primaryBadge')}</span> : null}
        </span>
        {branch ? (
          <span data-workspace-directory-branch className="flex min-w-0 shrink-0 items-center gap-1">
            <Icon name="git-branch" className="size-3.5 shrink-0" />
            <span className="min-w-0 max-w-40 truncate">{branch}</span>
          </span>
        ) : null}
      </div>
      <div data-workspace-directory-path className="mt-0.5 min-w-0 select-text truncate typography-micro text-muted-foreground/70" title={directory}>{truncatePathMiddle(directory, { maxLength: 56 })}</div>
    </li>
  );
}

export const DraftWorkspaceDirectories = memo(function DraftWorkspaceDirectories({ directories }: { directories: readonly string[] }) {
  const { t } = useI18n();
  const label = t('workspace.paths.count', { count: directories.length });
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button
        type="button"
        variant="ghost"
        size="xs"
        data-testid="draft-workspace-directories"
        className={cn('min-w-0 gap-1 px-1.5 typography-micro text-muted-foreground', SELECTOR_CHIP_HOVER_CLASS)}
      />}>
        <Icon name="folders" className="size-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        <Icon name="arrow-down-s" className="size-3.5 shrink-0" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} collisionPadding={8} className="z-50">
          <Popover.Popup aria-label={label} className="yuri-mobile-overlay-surface yuri-popup-surface w-max min-w-48 max-w-[min(28rem,calc(100vw-1rem))] rounded-xl p-2.5 typography-meta text-muted-foreground">
            <ul className="max-h-[min(18rem,50dvh)] space-y-2 overflow-y-auto">
              {directories.map((directory, index) => (
                <WorkspaceDirectoryRow key={directory} directory={directory} primary={index === 0 && directories.length > 1} />
              ))}
            </ul>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
