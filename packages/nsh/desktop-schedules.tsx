import { effect, List, locale, signal, Text, token, View, windowSize, type JSX } from 'nsh';
import { Button, ContextMenu, Input, Menu, MenuItem, Tab, Tabs } from 'nsh/base';
import { Icon } from './Icon';
import { language, t } from './i18n';
import { record, text, type ChatTarget, type Row } from './model';
import { app } from './state';
import { nativeAgentPaletteTokens } from './appearance';
import { scheduledRunTarget, taskKey, type createScheduledCatalog, type createScheduledHistory, type ScheduledTaskRun, type TaskIdentity } from './schedules-state';
import { formatCompactRunDuration, resolveRunDurationMs } from '../ui/src/lib/scheduledTaskRunDuration';

export type DesktopSchedulePresentation = {
  /** Already-owned editor content; never mount a second creator/controller here. */
  editor?: JSX.Element;
  /** Separate admission metadata: never evaluate editor content to test its presence. */
  editorOpen?: boolean;
  selectedTask?: TaskIdentity | null;
  /** Existing editor owner confirms dirty/pending departure, then calls commit. */
  requestViewChange?: (commit: () => void) => void;
};
type Catalog = ReturnType<typeof createScheduledCatalog>;
type History = ReturnType<typeof createScheduledHistory>;
type WorkspaceView = 'tasks' | 'history';
type Filter = 'all' | 'active' | 'paused';
const iconButton = 'size-8 shrink-0 rounded-lg items-center justify-center hover:bg-accent focus:bg-accent active:bg-accent disabled:opacity-40';
const button = 'h-8 px-3 rounded-md bg-secondary items-center justify-center hover:bg-accent focus:bg-accent active:bg-accent disabled:opacity-40';
const menuItem = 'flex-row items-center gap-2 rounded-md px-2 py-2 hover:bg-secondary focus:bg-accent active:bg-accent disabled:opacity-40';
const menuClass = 'min-w-40 rounded-lg bg-card border border-border p-1 shadow-lg';

function statusMeta(status: unknown) {
  const name = status == null ? 'idle' : text(status);
  const values = { success: ['checkbox-circle', 'success'], error: ['error-warning', 'error'], running: ['loader-4', 'warning'], idle: ['pulse', 'muted'] } as const;
  return values[name as keyof typeof values] ?? ['question', 'muted'] as const;
}
function statusLabel(value: unknown) {
  if (value == null || value === 'idle') return t('sessions.scheduledTasks.dialog.status.idle');
  if (value === 'success' || value === 'error' || value === 'running') return t(`sessions.scheduledTasks.dialog.status.${value}`);
  return t('common.unavailable');
}
function statusColor(status: unknown) {
  const tone = statusMeta(status)[1];
  return nativeAgentPaletteTokens()[`--status-${tone}`] ?? String(token(tone === 'success' ? 'success' : tone === 'error' ? 'destructive' : 'muted-foreground'));
}
function nextRun(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || !value) return '—';
  const difference = value - Date.now(), absolute = Math.abs(difference), future = difference >= 0;
  if (absolute < 60_000) return t(future ? 'sessions.scheduledTasks.dialog.relativeTime.inLessThanOneMinute' : 'sessions.scheduledTasks.dialog.relativeTime.justNow');
  if (absolute < 3600_000) return t(future ? 'sessions.scheduledTasks.dialog.relativeTime.inMinutes' : 'sessions.scheduledTasks.dialog.relativeTime.minutesAgo', { count: Math.round(absolute / 60_000) });
  const leading = Math.floor(absolute / (absolute < 86400_000 ? 3600_000 : 86400_000));
  const trailing = Math.round(absolute % (absolute < 86400_000 ? 3600_000 : 86400_000) / (absolute < 86400_000 ? 60_000 : 3600_000));
  const body = absolute < 86400_000 ? `${leading}h${trailing ? ` ${trailing}m` : ''}` : `${leading}d${trailing ? ` ${trailing}h` : ''}`;
  return t(future ? 'sessions.scheduledTasks.dialog.relativeTime.inDuration' : 'sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: body });
}
function Feedback(props: { catalog: Catalog; active: boolean; interactive: boolean; contractError?: string }) {
  const can = () => props.active && props.interactive;
  return <View class="gap-2">
    <If when={props.catalog.partial().length > 0}><View class="p-3 rounded-xl border border-border"><Text role="alert" class="text-xs text-muted-foreground">{t('sessions.scheduledTasks.workspace.partialLoadWarning')}</Text><Button class={button} disabled={!can() || props.catalog.loading()} onPress={() => { if (can()) void props.catalog.load(); }}><Text class="text-xs text-foreground">{t('sessions.scheduledTasks.history.retry')}</Text></Button></View></If>
    <If when={!!props.catalog.notice()}><Text class="text-xs text-muted-foreground">{props.catalog.notice()}</Text></If>
    <If when={!!props.catalog.error() || !!props.contractError}><View class="p-3 rounded-xl border border-border gap-2"><Text role="alert" class="text-xs text-destructive">{props.contractError || props.catalog.error()}</Text><Button testID="desktop-schedules-retry" class={button} disabled={!can() || props.catalog.loading()} onPress={() => { if (can()) void props.catalog.load(); }}><Text class="text-xs text-foreground">{t('sessions.scheduledTasks.history.retry')}</Text></Button></View></If>
  </View>;
}

/** Pure desktop surface over ScopedHome's single catalog, filters and history owner. */
export function DesktopScheduleWorkspace(props: DesktopSchedulePresentation & {
  catalog: Catalog; active: boolean; interactive: boolean; tasks: Row[];
  view: WorkspaceView; filter: Filter; search: string; historyTask: Row | null; history?: JSX.Element;
  contractError: string; scheduleLabel: (task: Row, timezone?: boolean) => string;
  onView: (view: WorkspaceView) => void; onFilter: (filter: Filter) => void; onSearch: (value: string) => void;
  onCreate: () => void; onEdit: (item: Row) => void; onHistory: (item: Row | null) => void;
  onAction: (item: Row, kind: 'run' | 'toggle' | 'delete') => void;
}) {
  const menu = signal('');
  const can = () => props.active && props.interactive;
  const invoke = (work: () => void) => { if (can()) work(); };
  effect(() => { if (!can()) menu.set(''); });
  const selected = (item: Row) => !!props.selectedTask && taskKey(item) === JSON.stringify([props.selectedTask.projectId, props.selectedTask.taskId]);
  function Items(item: { row: Row }) {
    const disabled = () => !can() || props.catalog.busy(item.row);
    return <View>
      <MenuItem class={menuItem} disabled={disabled() || record(item.row.task).enabled !== true || record(record(item.row.task).state).lastStatus === 'running'} onSelect={() => invoke(() => props.onAction(item.row, 'run'))}><Icon name="play" size={16} /><Text class="text-sm text-foreground">{t('sessions.scheduledTasks.dialog.actions.runNow')}</Text></MenuItem>
      <MenuItem class={menuItem} disabled={!can()} onSelect={() => invoke(() => props.onHistory(item.row))}><Icon name="history" size={16} /><Text class="text-sm text-foreground">{t('sessions.scheduledTasks.workspace.views.history')}</Text></MenuItem>
      <MenuItem class={menuItem} disabled={disabled()} onSelect={() => invoke(() => props.onAction(item.row, 'toggle'))}><Icon name={record(item.row.task).enabled ? 'pause' : 'play'} size={16} /><Text class="text-sm text-foreground">{t(record(item.row.task).enabled ? 'sessions.scheduledTasks.dialog.actions.pause' : 'sessions.scheduledTasks.dialog.actions.resume')}</Text></MenuItem>
      <MenuItem class={menuItem} disabled={disabled()} onSelect={() => invoke(() => props.onAction(item.row, 'delete'))}><Icon name="delete-bin" size={16} /><Text class="text-sm text-destructive">{t('sessions.scheduledTasks.dialog.actions.delete')}</Text></MenuItem>
    </View>;
  }
  function TaskRow(item: { row: Row }) {
    const task = () => record(item.row.task), state = () => record(task().state), key = () => taskKey(item.row);
    return <View class="group flex-row items-center gap-1">
      <ContextMenu class="flex-1 min-w-0" open={can() && menu() === `context:${key()}`} onOpenChange={event => menu.set(event.open && can() ? `context:${key()}` : '')} popupClass={menuClass} trigger={
        <Button testID={`desktop-scheduled-task-${text(item.row.projectId)}-${text(task().id)}`} class={`flex-row flex-1 min-w-0 items-center gap-3 rounded-xl border px-4 py-3 hover:bg-accent focus:bg-accent active:bg-accent ${selected(item.row) ? 'border-border bg-card' : 'border-transparent'} ${task().enabled ? '' : 'opacity-65'}`} selected={selected(item.row)} disabled={!can()} onPress={() => invoke(() => props.onEdit(item.row))}>
          <View class="size-5 rounded-full border border-border items-center justify-center" accessibilityLabel={statusLabel(state().lastStatus)}><Icon name={task().enabled ? statusMeta(state().lastStatus)[0] : 'pause'} size={14} color={task().enabled ? statusColor(state().lastStatus) : String(token('muted-foreground'))} /></View>
          <View class="flex-1 min-w-0 gap-1"><Text class="text-sm font-medium text-foreground" style={{ numberOfLines: 1 }}>{text(task().name)}</Text><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{props.scheduleLabel(task(), true)} · {nextRun(state().nextRunAt)}</Text></View>
        </Button>
      }><Items row={item.row} /></ContextMenu>
      <Button testID={`desktop-scheduled-history-${text(item.row.projectId)}-${text(task().id)}`} class={iconButton} style={{ width: 36, height: 36 }} disabled={!can()} accessibilityLabel={t('sessions.scheduledTasks.workspace.views.history')} onPress={() => invoke(() => props.onHistory(item.row))}><Icon name="history" size={16} /></Button>
      <Menu open={can() && menu() === `menu:${key()}`} onOpenChange={event => menu.set(event.open && can() ? `menu:${key()}` : '')} popupClass={menuClass} align="end" trigger={<Button testID={`desktop-scheduled-menu-${text(item.row.projectId)}-${text(task().id)}`} class={`${iconButton} ${selected(item.row) ? '' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`} disabled={!can() || props.catalog.busy(item.row)} accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: text(task().name) })}><Icon name="more-2" size={16} /></Button>}><Items row={item.row} /></Menu>
    </View>;
  }
  function EditorBody() {
    return props.editor ?? <View class="flex-1 items-center justify-center p-4"><Text class="text-sm text-muted-foreground">{t('common.unavailable')}</Text></View>;
  }
  return <View testID="desktop-schedules-workspace" class="flex-1 flex-row min-w-0 min-h-0 bg-background" disabled={!props.interactive}>
    <View class="flex-1 min-w-0 min-h-0">
      <View class="px-6 pt-4 pb-5"><View class="w-full self-center" style={{ maxWidth: 896 }}>
        <View role="group" accessibilityLabel={t('sessions.scheduledTasks.workspace.views.aria')}><Tabs testID="desktop-scheduled-views" class="flex-row gap-1 p-1 rounded-xl bg-muted mb-3" indicatorClass="bg-card rounded-lg inset-y-1">
          <Each of={['tasks', 'history'] as const}>{view => <Tab testID={`desktop-scheduled-${view()}-tab`} class="flex-1 min-h-9 flex-row gap-1.5 items-center justify-center rounded-lg focus:bg-accent" selected={props.view === view()} disabled={!can()} onPress={() => invoke(() => props.onView(view()))}><Icon name={view() === 'tasks' ? 'calendar-schedule' : 'history'} size={16} /><Text class={props.view === view() ? 'text-sm text-foreground' : 'text-sm text-muted-foreground'}>{t(`sessions.scheduledTasks.workspace.views.${view()}`)}</Text></Tab>}</Each>
        </Tabs></View>
        <If when={props.view === 'tasks'}><View class="flex-row items-center justify-between gap-3">
          <View class="flex-row items-center gap-1"><Each of={['all', 'active', 'paused'] as const}>{filter => <Button testID={`desktop-scheduled-filter-${filter()}`} class={`h-9 px-3 rounded-xl items-center justify-center hover:bg-accent focus:bg-accent ${props.filter === filter() ? 'bg-card' : ''}`} selected={props.filter === filter()} disabled={!can()} onPress={() => invoke(() => props.onFilter(filter()))}><Text class={props.filter === filter() ? 'text-sm text-foreground' : 'text-sm text-muted-foreground'}>{t(`sessions.scheduledTasks.workspace.filters.${filter()}`)}</Text></Button>}</Each></View>
          <Button testID="desktop-scheduled-create" class="h-9 px-3.5 flex-row gap-2 rounded-full bg-secondary items-center justify-center hover:bg-accent focus:bg-accent disabled:opacity-40" disabled={!can() || !app.projects().length} accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.create')} onPress={() => invoke(props.onCreate)}><Icon name="add" size={16} /><Text class="text-sm text-foreground">{t('sessions.scheduledTasks.dialog.actions.create')}</Text></Button>
        </View><View class="flex-row items-center gap-2 h-9 px-3.5 mt-7 rounded-full bg-card border border-border"><Icon name="search" size={16} /><Input testID="desktop-scheduled-search" class="flex-1 text-sm text-foreground" disabled={!can()} value={props.search} placeholder={t('sessions.scheduledTasks.workspace.search.placeholder')} accessibilityLabel={t('sessions.scheduledTasks.workspace.search.placeholder')} onChange={event => invoke(() => props.onSearch(event.value))} /></View></If>
        <If when={props.view === 'history' && !!props.historyTask}><View class="flex-row mt-3"><View class="flex-row items-center gap-1 pl-3 pr-1 py-1 rounded-full bg-card border border-border"><Text class="text-xs text-foreground" style={{ numberOfLines: 1 }}>{text(record(props.historyTask?.task).name)}</Text><Button testID="desktop-scheduled-history-clear" class={iconButton} style={{ width: 28, height: 28 }} disabled={!can()} accessibilityLabel={t('sessions.scheduledTasks.history.filter.clearAria')} onPress={() => invoke(() => props.onHistory(null))}><Icon name="close" size={14} /></Button></View></View></If>
      </View></View>
      <View class="flex-1 min-h-0" style={{ display: props.view === 'tasks' ? 'flex' : 'none' }}>
        <List testID="desktop-scheduled-tasks" class="flex-1 min-h-0" contentClass="px-6 pb-6" each={props.tasks} keyExtractor={taskKey}
          header={() => <View class="w-full self-center pt-4" style={{ maxWidth: 896 }}><Feedback catalog={props.catalog} active={props.active} interactive={props.interactive} contractError={props.contractError} /><If when={props.catalog.loading()}><Text class="text-xs text-muted-foreground py-3">{t('sessions.scheduledTasks.dialog.loading')}</Text></If></View>}
          empty={() => <If when={props.catalog.loaded() && !props.catalog.loading() && !props.catalog.error() && !props.catalog.partial().length}><View testID="desktop-scheduled-empty" class="w-full self-center p-4 rounded-xl border border-border" style={{ maxWidth: 896 }}><Text class="text-xs text-muted-foreground">{t(app.tasks().length ? 'sessions.scheduledTasks.workspace.search.noResults' : 'sessions.scheduledTasks.dialog.empty.noTasks')}</Text></View></If>}>
          {row => <View class="w-full self-center pt-1" style={{ maxWidth: 896 }}><TaskRow row={row()} /></View>}
        </List>
      </View>
      <View class="flex-1 min-h-0" style={{ display: props.view === 'history' ? 'flex' : 'none' }}>{props.history}</View>
    </View>
    <If when={props.editorOpen}><View testID="desktop-scheduled-editor" class="min-h-0 border-l border-border bg-background" style={{ width: Math.min(480, Math.max(380, windowSize().width * .36)), flexShrink: 0 }}><EditorBody /></View></If>
  </View>;
}

function location(run: ScheduledTaskRun) {
  const name = (path: string) => path.replace(/[\\/]+$/u, '').split(/[\\/]/u).pop() || path;
  const project = app.projects().find(project => project.id === run.projectId), projectName = project ? name(project.path) : run.projectId;
  const directory = run.directory ? name(run.directory) : '';
  return directory && directory !== projectName ? `${projectName} · ${directory}` : projectName;
}

/** Uses History's existing controller/cursor/timer; it never reads or streams itself. */
export function DesktopScheduleHistory(props: { history: History; active: boolean; interactive: boolean; editorOpen?: boolean; now: number; onOpenSession: (target: ChatTarget) => void }) {
  const history = props.history, can = () => props.active && props.interactive;
  const more = () => { if (can() && !props.editorOpen && history.loaded() && !history.loading() && !history.error() && !history.complete()) void history.load(true); };
  function Run(item: { run: ScheduledTaskRun }) {
    const target = () => scheduledRunTarget(item.run);
    const duration = () => formatCompactRunDuration(resolveRunDurationMs(item.run, props.now)) ?? (item.run.status === 'running' ? t('sessions.scheduledTasks.history.duration.pending') : '');
    const timestamp = () => new Intl.DateTimeFormat(language() === 'system' ? locale() : language(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(item.run.startedAt));
    const body = () => <View class="flex-row items-start gap-3 min-w-0">
      <View class="size-8 rounded-full border border-border items-center justify-center" accessibilityLabel={statusLabel(item.run.status)}><Icon name={statusMeta(item.run.status)[0]} size={16} color={statusColor(item.run.status)} /></View>
      <View class="flex-1 min-w-0 gap-1">
        <View class="flex-row items-start justify-between gap-2"><Text class="flex-1 min-w-0 text-sm font-semibold text-foreground" style={{ numberOfLines: 1 }}>{item.run.taskName}</Text><View class="flex-row items-center gap-1.5"><Text class="text-xs text-muted-foreground">{duration()}</Text><Text class="text-xs font-medium" style={{ color: statusColor(item.run.status) }}>{statusLabel(item.run.status)}</Text></View></View>
        <View class="flex-row items-center gap-1.5"><Icon name="folder" size={14} /><Text class="flex-1 text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{location(item.run)}</Text></View>
        <View class="flex-row items-center justify-between gap-3"><View class="flex-1 flex-row flex-wrap gap-3"><View class="flex-row items-center gap-1"><Icon name="time" size={12} /><Text class="text-xs text-muted-foreground">{timestamp()}</Text></View><View class="flex-row items-center gap-1"><Icon name={item.run.trigger === 'manual' ? 'play' : 'calendar-schedule'} size={12} /><Text class="text-xs text-muted-foreground">{t(`sessions.scheduledTasks.history.trigger.${item.run.trigger}`)}</Text></View></View><If when={!!target()}><Text class="text-sm font-medium text-foreground">{t('sessions.scheduledTasks.history.openSession')}</Text></If></View>
        <If when={!!item.run.error}><Text class="text-xs text-destructive" style={{ numberOfLines: 1 }}>{item.run.error}</Text></If>
      </View>
    </View>;
    return <View class="border-b border-border"><If when={!!target()} else={<View class="px-4 py-3">{body()}</View>}><Button testID={`desktop-scheduled-run-${item.run.id}`} class="w-full px-4 py-3 hover:bg-accent focus:bg-accent active:bg-accent" disabled={!can()} accessibilityLabel={t('sessions.scheduledTasks.history.openSession')} onPress={() => { const value = target(); if (can() && value) props.onOpenSession(value); }}>{body()}</Button></If></View>;
  }
  return <List testID="desktop-scheduled-history" class="flex-1 min-h-0" contentClass="px-6 pb-6" each={history.runs()} keyExtractor={run => run.id} onLoadMore={more} loadMoreThreshold={.5}
    header={() => <View class="w-full self-center pt-4" style={{ maxWidth: 896 }}><If when={history.loading()}><Text class="text-xs text-muted-foreground px-4 py-3">{t(history.loaded() ? 'sessions.scheduledTasks.history.loadingMore' : 'sessions.scheduledTasks.history.loading')}</Text></If></View>}
    empty={() => <If when={history.loaded() && !history.loading() && !history.error()}><View testID="desktop-scheduled-history-empty" class="w-full self-center p-6 border border-border rounded-xl items-center gap-2" style={{ maxWidth: 896 }}><Icon name="history" size={20} /><Text class="text-sm font-medium text-foreground">{t('sessions.scheduledTasks.history.empty.title')}</Text><Text class="text-xs text-muted-foreground">{t('sessions.scheduledTasks.history.empty.description')}</Text></View></If>}
    footer={() => <View class="w-full self-center" style={{ maxWidth: 896 }}><If when={!!history.error()}><View class="p-3 border border-border rounded-xl gap-2"><Text role="alert" class="text-xs text-destructive">{t(history.runs().length ? 'sessions.scheduledTasks.history.error.more' : 'sessions.scheduledTasks.history.error.title')}</Text><Text class="text-xs text-muted-foreground">{history.error()}</Text><Button testID="desktop-scheduled-history-retry" class={button} disabled={!can() || history.loading()} onPress={() => { if (can()) void history.retry(); }}><Text class="text-xs text-foreground">{t('sessions.scheduledTasks.history.retry')}</Text></Button></View></If></View>}>
    {run => <View class="w-full self-center bg-card" style={{ maxWidth: 896 }}><Run run={run()} /></View>}
  </List>;
}
