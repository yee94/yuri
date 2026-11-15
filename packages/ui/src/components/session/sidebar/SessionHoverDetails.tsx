import { Icon } from '@/components/icon/Icon';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl, type DesktopHost } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/v2-types';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeApiBaseUrl, getRuntimeKey, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { getConfigDirectoryKey, useConfigStore } from '@/stores/useConfigStore';
import { useGitStore } from '@/stores/useGitStore';
import { TaskProjectBadge, type TaskProjectMark } from './TaskCardParts';

/** Mounted only for the open hover card. Reads metadata, never fetches a transcript or probes git/hosts. */
export function SessionHoverDetails({ session, title, projectLabel, project, branch, directory, time }: {
  session: Session;
  title: string;
  projectLabel?: string | null;
  project?: TaskProjectMark | null;
  branch?: string | null;
  directory?: string | null;
  time: string;
}) {
  const { t } = useI18n();
  const currentBranch = useGitStore((state) => directory ? state.directories.get(directory)?.status?.current : undefined);
  const modelLabel = useConfigStore((state) => {
    const model = session.model;
    if (!model) return null;
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
  const hostLabel = host ? redactSensitiveUrl(host.label)
    : isDesktopLocalOriginActive() ? t('desktopHostSwitcher.instance.local') : null;
  const mismatchedBranch = Boolean(branch && currentBranch && currentBranch !== 'HEAD' && currentBranch !== branch);

  return (
    <div className="flex flex-col gap-2 text-left" data-session-hover-details={session.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 break-words typography-ui-label font-medium text-foreground">{title}</div>
        <span className="shrink-0 typography-meta text-muted-foreground">{time}</span>
      </div>
      {projectLabel ? (
        <div className="flex min-w-0 items-center gap-2 typography-meta text-muted-foreground">
          <TaskProjectBadge project={project} />
          <span className="min-w-0 break-words">{projectLabel}</span>
        </div>
      ) : null}
      {hostLabel ? (
        <div className="flex min-w-0 items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="computer" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{hostLabel}</span>
        </div>
      ) : null}
      {branch ? (
        <div className="flex min-w-0 items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="git-branch" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{branch}</span>
        </div>
      ) : null}
      {mismatchedBranch ? (
        <div className="flex items-start gap-2 typography-meta text-status-warning">
          <Icon name="error-warning" className="mt-0.5 size-3.5 shrink-0" />
          <span>{t('sessions.sidebar.session.hover.differentBranch', { branch: currentBranch ?? '' })}</span>
        </div>
      ) : null}
      {modelLabel ? (
        <div className="flex min-w-0 items-center gap-2 typography-meta text-muted-foreground">
          <Icon name="ai-agent" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{modelLabel}</span>
        </div>
      ) : null}
    </div>
  );
}
