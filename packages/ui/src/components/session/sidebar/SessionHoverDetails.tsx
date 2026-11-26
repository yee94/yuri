import type { ReactNode } from 'react';
import { Icon } from '@/components/icon/Icon';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { getDesktopHostApiUrl, locationMatchesHost, redactSensitiveUrl, type DesktopHost } from '@/lib/desktopHosts';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/v2-types';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeApiBaseUrl, getRuntimeKey, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { getWorkspaceDisplayLabel, getWorkspacePaths, isWorkspaceId, normalizeWorkspacePath, readSessionWorkspaceId } from '@/lib/workspacePaths';
import { getConfigDirectoryKey, useConfigStore } from '@/stores/useConfigStore';
import { useGitStore } from '@/stores/useGitStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { WorktreeMetadata } from '@/types/worktree';
import { TaskProjectBadge, type TaskProjectMark } from './TaskCardParts';

/** Mounted only for the open hover card. Reads metadata, never fetches a transcript or probes git/hosts. */
export function SessionHoverDetails({ session, title, projectLabel, project, projectId, indexedWorkspaceId, branch, worktree, directory, time, remote }: {
  session: Session;
  title: string;
  projectLabel?: string | null;
  project?: TaskProjectMark | null;
  projectId?: string | null;
  indexedWorkspaceId?: string | null;
  branch?: string | null;
  worktree?: Pick<WorktreeMetadata, 'branch' | 'name' | 'label' | 'path' | 'worktreeRoot'> | null;
  directory?: string | null;
  time: string;
  remote?: { hostLabel: string; projectBadge: ReactNode };
}) {
  const { t } = useI18n();
  const rowProjectId = projectId ?? project?.id;
  const liveWorkspaceId = readSessionWorkspaceId(session);
  const workspace = useProjectsStore((state) => {
    if (remote) return undefined;
    const findLocalProject = (id?: string | null) => id
      ? state.projects.find((candidate) => candidate.id === id && !candidate.hostId)
      : undefined;
    const rowProject = findLocalProject(rowProjectId);
    // The tree's workspace owns the row even when its live session snapshot only names the executing project.
    if (rowProject && (isWorkspaceId(rowProject.id) || (rowProject.paths?.length ?? 0) > 1)) {
      return rowProject;
    }
    const indexedWorkspace = findLocalProject(indexedWorkspaceId);
    if (indexedWorkspace) return indexedWorkspace;
    const liveWorkspace = findLocalProject(liveWorkspaceId);
    if (liveWorkspace && (isWorkspaceId(liveWorkspace.id) || (liveWorkspace.paths?.length ?? 0) > 1)) {
      return liveWorkspace;
    }
    return rowProject ?? liveWorkspace;
  });
  const attachedPaths = getWorkspacePaths(workspace);
  const workspacePaths = attachedPaths.length > 1 ? attachedPaths : null;
  const projectMark = workspacePaths && workspace ? {
    id: workspace.id,
    icon: workspace.icon ?? undefined,
    color: workspace.color ?? undefined,
    iconImage: workspace.iconImage ?? undefined,
    isMultiPath: true,
  } : project;
  const displayProjectLabel = workspace ? getWorkspaceDisplayLabel(workspace) : projectLabel;
  const absolutePath = worktree?.path?.trim() || directory?.trim() || null;
  const checkoutDirectory = absolutePath ? normalizeWorkspacePath(absolutePath) : null;
  const currentBranch = useGitStore((state) =>
    !remote && checkoutDirectory ? state.directories.get(checkoutDirectory)?.status?.current?.trim() : undefined);
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
  const savedBranch = (worktree ? worktree.branch : branch)?.trim();
  const branchDisplay = currentBranch === 'HEAD'
    ? t('gitView.branch.detachedHead')
    : currentBranch || (savedBranch === 'HEAD' ? null : savedBranch);
  const pathLines = [...(workspacePaths ?? []),
    ...(absolutePath && checkoutDirectory && !workspacePaths?.includes(checkoutDirectory) ? [absolutePath] : [])];

  return (
    <div className="flex flex-col gap-1.5 text-left text-wrap" data-session-hover-details={session.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1 break-words typography-ui-label font-medium text-foreground">{title}</div>
        <span className="shrink-0 text-xs leading-4 text-muted-foreground">{time}</span>
      </div>
      {displayProjectLabel ? (
        <div className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
          {remote?.projectBadge ?? <TaskProjectBadge project={projectMark} />}
          <span className="min-w-0 break-words">{displayProjectLabel}</span>
        </div>
      ) : null}
      {branchDisplay ? (
        <div className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
          <Icon name="git-branch" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{branchDisplay}</span>
        </div>
      ) : null}
      {pathLines.map((line) => (
        <div
          key={line}
          data-session-hover-path
          className="flex min-w-0 items-start gap-2 text-xs leading-4 text-muted-foreground"
        >
          <Icon name="route" className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 break-all">{line}</span>
        </div>
      ))}
      {hostLabel ? (
        <div className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
          <Icon name="computer" className="size-3.5 shrink-0" />
          <span className="min-w-0 break-words">{hostLabel}</span>
        </div>
      ) : null}
      {modelLabel ? (
        <div className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground">
          <ModelLogo
            modelId={session.model?.id}
            providerId={session.model?.providerID}
            className="size-3.5 shrink-0"
            fallback={<Icon name="ai-agent" className="size-3.5 shrink-0 text-foreground" />}
          />
          <span className="min-w-0 break-words">{modelLabel}</span>
        </div>
      ) : null}
    </div>
  );
}
