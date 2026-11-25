import type { ReactNode } from 'react';
import { Icon } from '@/components/icon/Icon';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl, type DesktopHost } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/v2-types';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeApiBaseUrl, getRuntimeKey, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { formatWorktreeFooterLabel } from '@/lib/worktrees/sessionWorktreeMetadata';
import { getConfigDirectoryKey, useConfigStore } from '@/stores/useConfigStore';
import { useGitStore } from '@/stores/useGitStore';
import type { WorktreeMetadata } from '@/types/worktree';
import { TaskProjectBadge, type TaskProjectMark } from './TaskCardParts';

/** Mounted only for the open hover card. Reads metadata, never fetches a transcript or probes git/hosts. */
export function SessionHoverDetails({ session, title, projectLabel, project, branch, worktree, directory, time, remote }: {
  session: Session;
  title: string;
  projectLabel?: string | null;
  project?: TaskProjectMark | null;
  branch?: string | null;
  worktree?: Pick<WorktreeMetadata, 'branch' | 'name' | 'label' | 'path' | 'worktreeRoot'> | null;
  directory?: string | null;
  time: string;
  remote?: { hostLabel: string; projectBadge: ReactNode };
}) {
  const { t } = useI18n();
  const currentBranch = useGitStore((state) => !remote && directory ? state.directories.get(directory)?.status?.current : undefined);
  const modelLabel = useConfigStore((state) => {
    const model = session.model;
    if (!model) return null;
    if (remote) return model.id;
    return state.directoryScoped[getConfigDirectoryKey(directory)]?.providers.find((provider) => provider.id === model.providerID)
      ?.models.find((candidate) => candidate.id === model.id)?.name ?? model.id;
  });
  const inventory = queryClient.getQueryData<{ hosts: DesktopHost[] }>(['desktop-host-inventory', getRuntimeTransportIdentity()]);
  const runtimeKey = getRuntimeKey();
  const apiUrl = getRuntimeApiBaseUrl();
  const hostId = runtimeKey.startsWith('host:') ? runtimeKey.slice(5) : null;
  const host = inventory?.hosts.find((candidate) => hostId
    ? candidate.id === hostId
    : Boolean(apiUrl && locationMatchesHost(apiUrl, getDesktopHostApiUrl(candidate))));
  const hostLabel = remote?.hostLabel ?? (host ? redactSensitiveUrl(host.label)
    : isDesktopLocalOriginActive() ? t('desktopHostSwitcher.instance.local') : null);
  const worktreeLabel = formatWorktreeFooterLabel(worktree);
  const branchDisplay = worktreeLabel || branch || null;
  const absolutePath = worktree?.path?.trim() || directory?.trim() || null;
  const mismatchedBranch = Boolean(branch && currentBranch && currentBranch !== 'HEAD' && currentBranch !== branch);

  return (
    <div className="flex flex-col gap-1.5 text-left" data-session-hover-details={session.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 break-words typography-ui-label font-medium text-foreground">{title}</div>
        <span className="shrink-0 text-xs leading-4 text-muted-foreground">{time}</span>
      </div>
      {projectLabel ? (
        <div className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
          {remote?.projectBadge ?? <TaskProjectBadge project={project} />}
          <span className="min-w-0 break-words">{projectLabel}</span>
        </div>
      ) : null}
      {branchDisplay ? (
        <div className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
          <Icon name="git-branch" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{branchDisplay}</span>
        </div>
      ) : null}
      {absolutePath ? (
        <div
          data-session-hover-path
          className="flex min-w-0 items-start gap-2 text-xs leading-4 text-muted-foreground"
        >
          <Icon name="folder-open" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-all">{absolutePath}</span>
        </div>
      ) : null}
      {mismatchedBranch ? (
        <div
          data-session-hover-branch-note
          className="flex items-start gap-2 text-xs leading-4 text-muted-foreground"
        >
          <Icon name="arrow-left-right" className="mt-0.5 size-3.5 shrink-0 opacity-75" />
          <span>{t('sessions.sidebar.session.hover.differentBranch', { branch: currentBranch ?? '' })}</span>
        </div>
      ) : null}
      {hostLabel ? (
        <div className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
          <Icon name="computer" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{hostLabel}</span>
        </div>
      ) : null}
      {modelLabel ? (
        <div className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
          <Icon name="ai-agent" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{modelLabel}</span>
        </div>
      ) : null}
    </div>
  );
}
