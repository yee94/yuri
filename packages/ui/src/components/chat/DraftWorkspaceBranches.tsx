import { memo, useMemo } from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { SELECTOR_CHIP_HOVER_CLASS } from '@/components/chat/message/parts/toolRowChrome';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useI18n } from '@/lib/i18n';
import { cn, formatDirectoryName } from '@/lib/utils';
import { useGitBranchesQuery } from '@/queries/gitBranchQueries';
import { useIsGitRepo } from '@/stores/useGitStore';

function WorkspaceDirectoryBranches({ directory }: { directory: string }) {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const isGitRepo = useIsGitRepo(directory);
  const query = useGitBranchesQuery(directory, git, isGitRepo !== false);
  const current = query.data?.current?.trim();
  const branches = useMemo(() => {
    const refs = query.data?.all ?? [];
    return Array.from(new Set([...(current ? [current] : []), ...refs]));
  }, [current, query.data?.all]);

  return (
    <li className="min-w-0 space-y-1">
      <div className="min-w-0 truncate font-medium text-foreground" title={directory}>{formatDirectoryName(directory)}</div>
      {isGitRepo === false ? <p>{t('gitView.empty.notGitRepository')}</p> : (
        <>
          {branches.length > 0 ? (
            <ul className="space-y-1">
              {branches.map((branch) => (
                <li key={branch} className="flex items-start justify-between gap-2">
                  <span className="min-w-0 break-all">{branch === 'HEAD' ? t('gitView.branch.detachedHead') : branch}</span>
                  {branch === current ? <span className="shrink-0 text-foreground">{t('gitView.branch.currentBadge')}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
          {query.isError ? <p>{t('common.unavailable')}</p>
            : query.isPending ? <p>{t('common.loading')}</p>
            : branches.length === 0 ? <p>{t('gitView.branch.empty')}</p> : null}
        </>
      )}
    </li>
  );
}

export const DraftWorkspaceBranches = memo(function DraftWorkspaceBranches({ directories }: { directories: readonly string[] }) {
  const { t } = useI18n();
  return (
    <Popover.Root>
      <Popover.Trigger render={<Button
        type="button"
        variant="ghost"
        size="xs"
        data-testid="draft-multi-repo-branch-readonly"
        className={cn('min-w-0 gap-1 px-1.5 typography-micro text-muted-foreground', SELECTOR_CHIP_HOVER_CLASS)}
      />}>
        <Icon name="git-branch" className="size-3.5 shrink-0" />
        <span className="truncate">{t('chat.chatInput.branch')}</span>
        <Icon name="arrow-down-s" className="size-3.5 shrink-0" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="bottom" align="start" sideOffset={4} collisionPadding={8} className="z-50">
          <Popover.Popup aria-label={t('chat.chatInput.branch')} className="yuri-mobile-overlay-surface yuri-popup-surface w-64 max-w-[calc(100vw-1rem)] rounded-xl p-2.5 typography-meta text-muted-foreground">
            <ul className="max-h-[min(18rem,50dvh)] space-y-2 overflow-y-auto">
              {directories.map((directory) => <WorkspaceDirectoryBranches key={directory} directory={directory} />)}
            </ul>
            <p className="mt-2">{t('workspace.multiRepo.branchReadOnly')}</p>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
});
