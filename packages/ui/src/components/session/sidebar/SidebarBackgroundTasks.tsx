import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { importJobProgress } from '@/lib/historyImport';
import { isDesktopLocalOriginActive } from '@/lib/desktop';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { dismissImport, importJobsQueryOptions, resumeImport } from '@/queries/historyImportQueries';
import { resumeSessionContentIndex, sessionContentIndexStatusOptions } from '@/queries/sessionContentSearchQueries';
import { hostUpdateQueryOptions, isHostUpdateActive, resumeHostUpdate } from '@/queries/hostUpdateQueries';
import { refreshProjectOrderSnapshot } from '@/queries/projectOrderQueries';
import { useUpdateStore } from '@/stores/useUpdateStore';

type Task = { id: string; label: string; detail: string; completed: number; total: number; stale: boolean; bytes?: boolean; hideCounts?: boolean;
  failed?: boolean; failures?: number; resume?: () => Promise<unknown>; dismiss?: () => Promise<unknown> };

function TaskRing({ task }: { task: Task }) {
  const value = task.total > 0 ? Math.min(99, Math.floor(Math.max(0, task.completed) / task.total * 100)) : undefined;
  return <span role="progressbar" aria-label={task.detail} aria-valuenow={value} aria-valuemin={0} aria-valuemax={100} className={`inline-flex size-4 shrink-0 ${task.failed ? 'text-[var(--status-error)]' : ''}`}>
    <svg viewBox="0 0 18 18" fill="none" aria-hidden="true" className={`size-full -rotate-90 ${value === undefined && !task.failed ? 'motion-safe:animate-spin' : ''}`}>
      <circle cx="9" cy="9" r="7.5" stroke="currentColor" strokeOpacity="0.2" strokeWidth="1.5" />
      <circle cx="9" cy="9" r="7.5" pathLength="100" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
        strokeDasharray="100" strokeDashoffset={100 - (value ?? 22)} className="motion-safe:transition-[stroke-dashoffset] motion-safe:duration-300" />
    </svg>
  </span>;
}

function TaskDetails({ task }: { task: Task }) {
  const { t, locale } = useI18n();
  const [removing, setRemoving] = React.useState(false);
  const flight = React.useRef(false);
  const mutation = useMutation({ mutationFn: async (action: 'resume' | 'dismiss') => {
    try { await (action === 'dismiss' ? task.dismiss?.() : task.resume?.()); }
    finally { flight.current = false; }
  }, onError: (_error, action) => { if (action === 'resume' && task.dismiss) setRemoving(true); }, retry: false });
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  return <div className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-2 py-2.5" data-background-task={task.id}>
    <span className="text-muted-foreground"><TaskRing task={task} /></span>
    <div className="min-w-0 space-y-0.5">
      <div className="flex flex-wrap items-baseline gap-x-1.5">
        <span className="typography-ui-label">{task.label}</span>
        {task.detail !== task.label && <span className="break-words typography-micro text-muted-foreground">{task.detail}</span>}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-2 typography-micro tabular-nums text-muted-foreground" data-background-task-meta>
        {task.total > 0 && !task.hideCounts && <span aria-label={t(task.bytes ? 'backgroundTasks.downloaded' : 'backgroundTasks.processed', { completed: number(task.completed), total: number(task.total) })}>
          {task.bytes ? t('backgroundTasks.downloaded', { completed: number(task.completed), total: number(task.total) }) : `${number(task.completed)} / ${number(task.total)}`}
        </span>}
        {Boolean(task.failures) && <span className="text-[var(--status-error)]">{t('backgroundTasks.failedCount', { count: number(task.failures!) })}</span>}
      </div>
    </div>
    {task.failed && task.resume && <Button size="xs" className="shrink-0" disabled={mutation.isPending} onClick={() => {
      if (flight.current) return;
      flight.current = true;
      mutation.mutate(removing ? 'dismiss' : 'resume');
    }}>{t(removing ? mutation.isPending ? 'backgroundTasks.removing' : 'backgroundTasks.dismiss'
      : mutation.isPending ? 'backgroundTasks.resuming' : 'backgroundTasks.resume')}</Button>}
    {task.stale && <p className="col-span-2 col-start-2 typography-micro text-muted-foreground">{t('backgroundTasks.progressUnavailable')}</p>}
    {mutation.isError && <p role="alert" className="col-span-2 col-start-2 typography-micro text-[var(--status-error)]">{t(mutation.variables === 'dismiss' ? 'backgroundTasks.dismissFailed' : mutation.error.message === 'update_plan_changed' ? 'backgroundTasks.updateChanged'
      : mutation.error.message === 'resume_request_missing' ? 'backgroundTasks.originalSelectionMissing' : 'backgroundTasks.resumeFailed')}</p>}
  </div>;
}

export const SidebarBackgroundTasks = React.memo(function SidebarBackgroundTasks() {
  const generation = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  return <RuntimeBackgroundTasks key={`${getRuntimeTransportIdentity()}:${generation}`} />;
});

function RuntimeBackgroundTasks() {
  const { t, locale } = useI18n();
  const [opened, setOpened] = React.useState(false);
  const downloading = useUpdateStore((state) => state.downloading);
  const downloadError = useUpdateStore((state) => state.downloadError);
  const downloadVersion = useUpdateStore((state) => state.downloadVersion);
  const downloadCompleted = useUpdateStore((state) => state.progress?.downloaded ?? 0);
  const downloadTotal = useUpdateStore((state) => state.progress?.total ?? 0);
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const jobs = useQuery({ ...importJobsQueryOptions(transport), retry: false,
    refetchInterval: (query) => query.state.error?.message === 'history_import_unsupported' ? false : query.state.data?.some((job) => job.state === 'running') ? 1000 : 15_000 });
  const index = useQuery({ ...sessionContentIndexStatusOptions(), retry: false,
    refetchInterval: (query) => query.state.data === null ? false : query.state.data?.phase === 'indexing' || query.state.data?.phase === 'pending' ? 3000 : 15_000 });
  const update = useQuery({ ...hostUpdateQueryOptions(transport, generation),
    refetchInterval: (query) => isHostUpdateActive(query.state.data?.operation) ? 2000 : query.state.error?.message === 'host_update_unsupported' ? false : 15_000 });
  const observed = React.useRef(new Set<string>());
  React.useEffect(() => {
    if (!jobs.data || jobs.isError) return;
    const running = new Set(jobs.data.filter((job) => job.state === 'running').map((job) => job.id));
    const finished = [...observed.current].some((id) => !running.has(id));
    observed.current = running;
    if (finished && transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration()) void refreshProjectOrderSnapshot(transport).catch(() => {});
  }, [jobs.data, jobs.isError, transport, generation]);

  const tasks: Task[] = [];
  for (const job of jobs.data ?? []) if (job.state !== 'completed') {
    const progress = importJobProgress(job);
    tasks.push({ id: job.id, label: t('backgroundTasks.import'), detail: t(job.state === 'running' ? `historyImport.phase.${progress.phase}` : `historyImport.state.${job.state}`),
      ...progress, stale: jobs.isError, failed: job.state !== 'running', failures: job.failures,
      resume: () => resumeImport(job.id, transport, generation), dismiss: () => dismissImport(job.id, transport, generation) });
  }
  if (index.data && index.data.phase !== 'ready') tasks.push({ id: 'content-index', label: t('backgroundTasks.index'),
    detail: t(['partial', 'error'].includes(index.data.phase) ? 'backgroundTasks.indexFailed' : 'backgroundTasks.indexing'),
    completed: index.data.completed, total: index.data.total, stale: index.isError, failed: ['partial', 'error'].includes(index.data.phase), failures: index.data.failed,
    resume: () => resumeSessionContentIndex(transport, generation) });
  if (downloading || downloadError) tasks.push({ id: 'client-update', label: t('backgroundTasks.download'), detail: t(downloadError ? 'backgroundTasks.downloadFailed' : 'updateDialog.status.downloading'),
    completed: downloadCompleted, total: downloadTotal, stale: false, bytes: true, failed: Boolean(downloadError), resume: async () => {
      await useUpdateStore.getState().downloadUpdate({ resume: true });
      if (useUpdateStore.getState().downloadError) throw new Error(useUpdateStore.getState().downloadError!);
    } });
  const operation = update.data?.operation;
  if (operation && (isHostUpdateActive(operation) || operation.status === 'failed') && !((downloading || downloadError) && operation.version === downloadVersion && isDesktopLocalOriginActive())) tasks.push({
    id: operation.id, label: t('backgroundTasks.download'), detail: `${t(operation.status === 'failed' ? 'backgroundTasks.downloadFailed'
      : operation.status === 'installing' ? 'updateDialog.status.installingUpdate' : operation.status === 'restarting' ? 'updateDialog.status.serverRestarting'
        : operation.status === 'checking' ? 'updateDialog.status.updating' : 'updateDialog.status.downloading')} · ${operation.version}`,
    completed: operation.progress ?? 0, total: operation.progress == null ? 0 : 100, stale: update.isError, hideCounts: true,
    failed: operation.status === 'failed', resume: () => resumeHostUpdate(operation, transport, generation),
  });
  if (!tasks.length && !opened) return null;
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  return <Popover.Root open={opened} onOpenChange={setOpened}>
    <div className={`ml-auto w-fit min-w-0 shrink text-muted-foreground/60 ${tasks.length ? '' : 'invisible'}`} data-sidebar-background-tasks={tasks.length ? '' : undefined}>
      <Popover.Trigger render={<Button variant="ghost" size="xs" aria-label={t('backgroundTasks.title')}
        className="max-w-full gap-2 text-[10px] font-normal text-muted-foreground/60" />}>
          {tasks.map((task) => <TaskRing key={task.id} task={task} />)}
          {tasks.length === 1 && <span className="truncate">{tasks[0].label}</span>}
      </Popover.Trigger>
    </div>
    <Popover.Portal>
      <Popover.Positioner side="top" align="center" sideOffset={10} className="z-50">
        <Popover.Popup initialFocus={false} className="yuri-mobile-overlay-surface yuri-popup-surface w-72 max-w-[calc(100vw-24px)] origin-[var(--transform-origin)] overflow-hidden rounded-2xl outline-none transition-[opacity,transform] duration-150 data-[starting-style]:translate-y-1 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0">
          <div className="flex items-center gap-2 px-3 pb-1 pt-3">
            <Popover.Title className="typography-micro font-medium text-muted-foreground">{t('backgroundTasks.title')}</Popover.Title>
            {tasks.length > 0 && <span className="typography-micro text-muted-foreground tabular-nums">{number(tasks.length)}</span>}
          </div>
          <div className="max-h-64 divide-y-[length:var(--yuri-popup-divider-width)] divide-[var(--yuri-popup-divider)] overflow-y-auto px-3 pb-1" data-background-task-details>
            {tasks.length ? tasks.map((task) => <TaskDetails key={task.id} task={task} />) : <p className="px-2 py-3 typography-meta text-muted-foreground">{t('backgroundTasks.empty')}</p>}
          </div>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}
