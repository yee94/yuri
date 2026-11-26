import React from 'react';
import { useInterval } from '@reactuses/core';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { PROJECT_COLOR_MAP, PROJECT_ICON_MAP, ProjectIconImage } from '@/lib/projectMeta';
import { formatRunElapsed, runElapsedRefreshMs } from './taskRunElapsed';
import { SessionBusyIndicator } from '../SessionBusyIndicator';

/** Project identity shown on a task card; the same icon the project row uses. */
export type TaskProjectMark = {
  id: string;
  icon?: string;
  color?: string;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  isMultiPath?: boolean;
};

export function TaskProjectBadge({ project }: { project: TaskProjectMark | null | undefined }): React.ReactNode {
  const iconName = project?.icon ? PROJECT_ICON_MAP[project.icon] : null;
  const color = project?.color ? PROJECT_COLOR_MAP[project.color] : undefined;
  const fallback = (
    <Icon name={iconName ?? (project?.isMultiPath ? 'folders' : 'folder-open')} className="size-3.5" style={color ? { color } : undefined} />
  );
  return (
    <span className="inline-flex size-3.5 shrink-0 items-center justify-center">
      {project?.iconImage
        ? <ProjectIconImage project={{ id: project.id, iconImage: project.iconImage }} className="size-full object-contain" fallback={fallback} />
        : fallback}
    </span>
  );
}

export function TaskUnreadDot(): React.ReactNode {
  const { t } = useI18n();
  return (
    <span
      className="yuri-task-unread-dot inline-block size-2 shrink-0 self-center rounded-full bg-[var(--session-unread-fill)]"
      role="img"
      aria-label={t('sessions.sidebar.session.status.unread')}
    />
  );
}

/** "Running 3m". Only this span re-renders on each tick, never the row. */
export function TaskRunElapsed({ startedAt }: { startedAt: number }): React.ReactNode {
  const { t } = useI18n();
  const [now, setNow] = React.useState(() => Date.now());
  useInterval(() => setNow(Date.now()), runElapsedRefreshMs(now - startedAt));
  return <>{t('sessions.sidebar.task.runningFor', { duration: formatRunElapsed(now - startedAt) })}</>;
}

export function TaskRunningStatus({ startedAt }: { startedAt: number | null }): React.ReactNode {
  const { t } = useI18n();
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium leading-none tabular-nums text-status-info" title={t('sessions.sidebar.session.status.active')}>
      <SessionBusyIndicator size={10} arcColor="var(--status-info)" />
      {startedAt !== null ? <TaskRunElapsed startedAt={startedAt} /> : null}
    </span>
  );
}
