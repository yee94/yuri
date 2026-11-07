import { cleanup, effect, host, lifecycle, List, Scroll, signal, Text, untracked, View, type JSX } from 'nsh';
import { AlertDialog, Button, Input, NavPage, TextView } from 'nsh/base';
import { Icon } from './Icon';
import { t } from './i18n';
import { record, runtimeEventFrom, text, type ChatTarget, type Row } from './model';
import { app, captureHostRequest } from './state';
import { createScheduledCatalog, createScheduledHistory, scheduledRunTarget, sortScheduledTasks, taskIdentity, taskKey, type ScheduledTaskRun, type TaskIdentity } from './schedules-state';
import { AssistantAvatar } from './assistants-avatar-live';
import { assistantContacts, readAssistantSnapshot, snapshotBots } from './assistants-core';
import { formatCompactRunDuration, resolveRunDurationMs } from '../ui/src/lib/scheduledTaskRunDuration';

const quiet = 'min-h-11 min-w-11 px-2 rounded-full items-center justify-center active:bg-accent disabled:opacity-40';
const action = 'min-h-11 px-4 py-3 rounded-2xl bg-secondary active:bg-accent items-center justify-center disabled:opacity-40';
const card = 'bg-card border border-border/30 rounded-[22px] shadow-sm';
type Catalog = ReturnType<typeof createScheduledCatalog>;
type Filter = 'all' | 'active' | 'paused';
export type ScheduledHomeProps = {
  onCreate: () => void;
  onEdit: (item: Row) => void;
  onOpenSession: (target: ChatTarget) => void;
  onOpenTask?: (item: Row) => void;
  onOpenAssistant?: (target: ChatTarget) => void;
  active?: boolean;
};
export type ScheduledTaskDetailProps = { item: Row; onEdit: (item: Row) => void; onOpenSession: (target: ChatTarget) => void; onDeleted?: () => void; active?: boolean };

function dateTime(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 8.64e15) return '—';
  const date = new Date(value), pad = (number: number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function duration(value: number | null) {
  if (value === null) return '—';
  if (value < 1000) return t('sessions.scheduledTasks.history.duration.lessThanOneSecond');
  const seconds = Math.floor(value / 1000), minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  if (hours) return t('sessions.scheduledTasks.history.duration.hoursMinutes', { hours, minutes: minutes % 60 });
  if (minutes) return t('sessions.scheduledTasks.history.duration.minutesSeconds', { minutes, seconds: seconds % 60 });
  return t('sessions.scheduledTasks.history.duration.seconds', { count: seconds });
}

function relative(value: unknown) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';
  const delta = value - Date.now(), absolute = Math.abs(delta);
  if (absolute < 60_000) return t(delta >= 0 ? 'sessions.scheduledTasks.dialog.relativeTime.inLessThanOneMinute' : 'sessions.scheduledTasks.dialog.relativeTime.justNow');
  if (absolute < 3600_000) return t(delta >= 0 ? 'sessions.scheduledTasks.dialog.relativeTime.inMinutes' : 'sessions.scheduledTasks.dialog.relativeTime.minutesAgo', { count: Math.round(absolute / 60_000) });
  return t(delta >= 0 ? 'sessions.scheduledTasks.dialog.relativeTime.inDuration' : 'sessions.scheduledTasks.dialog.relativeTime.durationAgo', { duration: duration(absolute) });
}

function scheduleSummary(task: Row, timezone = false) {
  const schedule = record(task.schedule);
  const times = [...new Set((Array.isArray(schedule.times) ? schedule.times : [schedule.time]).filter((value): value is string => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)))].sort().join(', ') || '--:--';
  const zone = timezone && text(schedule.timezone);
  if (schedule.kind === 'daily') return zone ? t('sessions.scheduledTasks.dialog.schedule.dailyWithTimezone', { time: times, timezone: zone }) : t('sessions.scheduledTasks.dialog.schedule.daily', { time: times });
  if (schedule.kind === 'weekly') {
    const weekdays = [t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sun'), t('sessions.scheduledTasks.dialog.schedule.weekdayShort.mon'), t('sessions.scheduledTasks.dialog.schedule.weekdayShort.tue'), t('sessions.scheduledTasks.dialog.schedule.weekdayShort.wed'), t('sessions.scheduledTasks.dialog.schedule.weekdayShort.thu'), t('sessions.scheduledTasks.dialog.schedule.weekdayShort.fri'), t('sessions.scheduledTasks.dialog.schedule.weekdayShort.sat')];
    const days = (Array.isArray(schedule.weekdays) ? schedule.weekdays : []).map(day => typeof day === 'number' ? weekdays[day] || t('sessions.scheduledTasks.dialog.schedule.weekdayShort.unknown') : t('sessions.scheduledTasks.dialog.schedule.weekdayShort.unknown')).join(', ');
    return zone ? t('sessions.scheduledTasks.dialog.schedule.weeklyWithTimezone', { time: times, days, timezone: zone }) : t('sessions.scheduledTasks.dialog.schedule.weekly', { time: times, days });
  }
  if (schedule.kind === 'once') {
    const params = { date: text(schedule.date) || t('sessions.scheduledTasks.dialog.schedule.unknownDate'), time: text(schedule.time) || '--:--' };
    return zone ? t('sessions.scheduledTasks.dialog.schedule.onceWithTimezone', { ...params, timezone: zone }) : t('sessions.scheduledTasks.dialog.schedule.once', params);
  }
  return zone ? t('sessions.scheduledTasks.dialog.schedule.cronWithTimezone', { cron: text(schedule.cron), timezone: zone }) : t('sessions.scheduledTasks.dialog.schedule.cron', { cron: text(schedule.cron) });
}

function statusLabel(status: unknown) {
  return t(status === 'success' ? 'sessions.scheduledTasks.dialog.status.success' : status === 'error' ? 'sessions.scheduledTasks.dialog.status.error' : status === 'running' ? 'sessions.scheduledTasks.dialog.status.running' : 'sessions.scheduledTasks.dialog.status.idle');
}
function StatusIcon(props: { task: Row }) {
  const status = () => record(props.task.state).lastStatus;
  return <View class="size-9 rounded-full bg-secondary border border-border/40 items-center justify-center" accessibilityLabel={statusLabel(status())}>
    <Icon size={17} name={!props.task.enabled ? 'pause' : status() === 'success' ? 'checkbox-circle' : status() === 'error' ? 'error-warning' : status() === 'running' ? 'loader-4' : 'calendar-schedule'} />
  </View>;
}

function Feedback(props: { catalog: Catalog }) {
  return <View class="gap-2">
    <If when={props.catalog.partial().length > 0}><Text role="alert" class="text-sm text-muted-foreground">{t('sessions.scheduledTasks.workspace.partialLoadWarning')}</Text><Button class={action} disabled={props.catalog.loading()} onPress={() => { void props.catalog.load(); }}><Text class="text-foreground">{t('sessions.scheduledTasks.history.retry')}</Text></Button></If>
    <If when={!!props.catalog.notice()}><Text class="text-sm text-muted-foreground">{props.catalog.notice()}</Text></If>
    <If when={!!props.catalog.error()}><View class="gap-2">
      <Text role="alert" class="text-sm text-destructive">{props.catalog.error()}</Text>
      <Button class={action} disabled={props.catalog.loading()} onPress={() => { void props.catalog.load(); }}><Text class="text-foreground">{t('sessions.scheduledTasks.history.retry')}</Text></Button>
    </View></If>
  </View>;
}

function observeRuns(current: () => boolean, refresh: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = host.on('runtime.event', value => {
    const event = runtimeEventFrom(value);
    if (!current() || lifecycle() !== 'active' || event?.key !== 'global' || !['scheduled-task-ran', 'yuri:scheduled-task-ran', 'event-stream-ready', 'yuri:event-stream-ready', 'reconnected'].includes(event.type) || timer) return;
    timer = setTimeout(() => { timer = undefined; if (current() && lifecycle() === 'active') refresh(); }, 120);
  });
  cleanup(() => { stop(); if (timer) clearTimeout(timer); });
}

async function confirmRemove(catalog: Catalog, item: Row) {
  if (!catalog.current() || catalog.busy(item)) return;
  const operation = catalog.capture();
  const answer = await AlertDialog.show({
    title: t('sessions.scheduledTasks.dialog.actions.delete'),
    description: t('sessions.scheduledTasks.dialog.confirm.deleteTask', { taskName: text(record(item.task).name) }),
    actions: [{ id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' }, { id: 'delete', label: t('sessions.scheduledTasks.dialog.actions.delete'), role: 'destructive' }],
  });
  if (answer.action === 'delete' && operation.current()) await catalog.mutate(item, 'delete');
}

async function taskMenu(catalog: Catalog, item: Row, onEdit: (item: Row) => void, onHistory: ((item: Row) => void) | undefined, onOpenSession: (target: ChatTarget) => void) {
  if (!catalog.current() || catalog.busy(item)) return;
  const operation = catalog.capture();
  const answer = await AlertDialog.show({ title: text(record(item.task).name), presentation: 'actionSheet', actions: [
    { id: 'run', label: t('sessions.scheduledTasks.dialog.actions.runNow') },
    ...(onHistory ? [{ id: 'history', label: t('sessions.scheduledTasks.workspace.views.history') }] : []),
    { id: 'toggle', label: t(record(item.task).enabled ? 'sessions.scheduledTasks.dialog.actions.pause' : 'sessions.scheduledTasks.dialog.actions.resume') },
    { id: 'edit', label: t('sessions.scheduledTasks.dialog.actions.edit') },
    { id: 'delete', label: t('sessions.scheduledTasks.dialog.actions.delete'), role: 'destructive' },
    { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
  ] });
  if (!operation.current()) return;
  const latest = catalog.latest(item);
  if (!latest) return;
  if (answer.action === 'edit') onEdit(latest);
  if (answer.action === 'history') onHistory?.(latest);
  if (answer.action === 'delete') await confirmRemove(catalog, latest);
  if (answer.action === 'toggle') await catalog.mutate(latest, 'toggle');
  if (answer.action === 'run') {
    const target = await catalog.mutate(latest, 'run');
    if (target && operation.current()) onOpenSession(target);
  }
}

function RunCard(props: { run: ScheduledTaskRun; now: number; current: () => boolean; onOpenSession: (target: ChatTarget) => void }) {
  const target = () => scheduledRunTarget(props.run);
  const elapsed = () => resolveRunDurationMs(props.run, props.now);
  return <View class={`${card} p-4 gap-3`}>
    <View class="flex-row items-center gap-3">
      <View class="size-9 rounded-full bg-secondary items-center justify-center"><Icon size={17} name={props.run.status === 'success' ? 'checkbox-circle' : props.run.status === 'error' ? 'error-warning' : 'loader-4'} /></View>
      <View class="flex-1 gap-1"><Text class="text-sm font-semibold text-foreground">{props.run.taskName}</Text><Text class={props.run.status === 'error' ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>{statusLabel(props.run.status)} · {t(props.run.trigger === 'manual' ? 'sessions.scheduledTasks.history.trigger.manual' : 'sessions.scheduledTasks.history.trigger.scheduled')}</Text></View>
    </View>
    <Meta label={t('sessions.scheduledTasks.history.meta.started')} value={dateTime(props.run.startedAt)} />
    <Meta label={t('sessions.scheduledTasks.history.meta.ended')} value={dateTime(props.run.finishedAt)} />
    <Meta label={t('sessions.scheduledTasks.dialog.project.label')} value={app.projects().find(project => project.id === props.run.projectId)?.name || props.run.projectId} />
    <If when={!!props.run.directory}><Text class="text-xs text-muted-foreground">{props.run.directory}</Text></If>
    <Meta label={t('sessions.scheduledTasks.history.meta.duration')} value={formatCompactRunDuration(elapsed()) ?? '—'} />
    <If when={!!props.run.error}><Text class="text-sm text-destructive">{props.run.error}</Text></If>
    <If when={!!target()}><Button class={action} accessibilityLabel={t('sessions.scheduledTasks.history.openSession')} onPress={() => { const value = target(); if (value && props.current()) props.onOpenSession(value); }}><Text class="text-foreground">{t('sessions.scheduledTasks.history.openSession')}</Text></Button></If>
  </View>;
}

function History(props: { identity?: TaskIdentity; header?: JSX.Element; onOpenSession: (target: ChatTarget) => void; active?: boolean }) {
  const history = createScheduledHistory(props.identity);
  const active = () => history.current() && props.active !== false && lifecycle() === 'active', now = signal(Date.now());
  effect(() => { const visible = active(); untracked(() => { if (visible) void history.load(); else history.suspend(); }); });
  effect(() => {
    if (!active() || !history.runs().some(run => run.status === 'running')) return;
    untracked(() => now.set(Date.now()));
    const timer = setInterval(() => { if (active()) now.set(Date.now()); }, 1000);
    return () => clearInterval(timer);
  });
  observeRuns(active, () => { void history.load(); });
  return <List testID="scheduled-history" class="flex-1" contentClass="px-[18px] pt-4 pb-8 gap-4" each={history.runs()} keyExtractor={run => run.id}
    refreshing={history.loading()} onRefresh={() => { void history.load(); }}
    header={() => <View class="gap-3">{props.header}<If when={!!history.error()}><View class="gap-2">
      <Text role="alert" class="text-sm text-destructive">{history.runs().length ? t('sessions.scheduledTasks.history.error.more') : t('sessions.scheduledTasks.history.error.title')}</Text>
      <Text class="text-xs text-muted-foreground">{history.error()}</Text>
      <Button class={action} disabled={history.loading()} onPress={() => { void history.retry(); }}><Text class="text-foreground">{t('sessions.scheduledTasks.history.retry')}</Text></Button>
    </View></If></View>}
    empty={() => <View class="py-6 gap-2"><Text class="text-sm text-muted-foreground">{history.loading() ? t('sessions.scheduledTasks.history.loading') : history.loaded() ? t('sessions.scheduledTasks.history.empty.title') : ''}</Text><If when={history.loaded() && !history.loading()}><Text class="text-xs text-muted-foreground">{t('sessions.scheduledTasks.history.empty.description')}</Text></If></View>}
    footer={() => <If when={history.loaded() && !history.complete()}><Button testID="scheduled-history-more" class={action} disabled={history.loading()} onPress={() => { void history.load(true); }}><Text class="text-foreground">{t(history.loading() ? 'sessions.scheduledTasks.history.loadingMore' : 'sessions.scheduledTasks.history.loadMore')}</Text></Button></If>}
  >{run => <RunCard run={run()} now={run().status === 'running' ? now() : 0} current={active} onOpenSession={props.onOpenSession} />}</List>;
}

function Meta(props: { label: string; value: string }) {
  return <View class="flex-row items-start justify-between gap-3"><Text class="text-xs text-muted-foreground">{props.label}</Text><Text class="text-xs text-foreground flex-1 text-right">{props.value}</Text></View>;
}

function ScheduleAssistant(props: { current: () => boolean; onOpen: (target: ChatTarget) => void }) {
  const request = captureHostRequest();
  const selected = signal<Row | null>(null);
  let alive = true, sequence = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const current = () => alive && props.current();
  async function load() {
    const attempt = ++sequence;
    try {
      const snapshot = await readAssistantSnapshot({ current, request });
      if (!current() || attempt !== sequence) return;
      const bots = snapshotBots(snapshot);
      selected.set(snapshot.enabled === true ? assistantContacts(bots).pinned ?? bots[0] ?? null : null);
    } catch { /* The optional creation hint must not replace the task catalog with an error. */ }
  }
  const stop = host.on('runtime.event', value => {
    const event = runtimeEventFrom(value);
    if (!current() || timer || event?.key !== 'global' || !['assistants-changed', 'yuri:assistants-changed', 'reconnected'].includes(event.type)) return;
    timer = setTimeout(() => { timer = undefined; if (current()) void load(); }, 120);
  });
  cleanup(() => { alive = false; sequence++; stop(); if (timer) clearTimeout(timer); });
  void load();
  return <If when={!!selected()}><Button testID="scheduled-assistant" class="min-h-11 flex-row items-center gap-2" accessibilityLabel={t('sessions.scheduledTasks.assistant.openAria', { name: text(selected()?.name) })} onPress={() => { const bot = selected(); if (bot && current()) props.onOpen({ kind: 'assistant', id: text(bot.id), title: text(bot.name), directory: text(bot.effectiveWorkspacePath) }); }}><AssistantAvatar bot={selected()!} size={36} active={false} /><Text class="text-xs text-muted-foreground">{t('sessions.scheduledTasks.assistant.offer')}</Text></Button></If>;
}

function ScopedHome(props: ScheduledHomeProps) {
  const catalog = createScheduledCatalog(), view = signal<'tasks' | 'history'>('tasks'), filter = signal<Filter>('all'), historyTask = signal<Row | null>(null), search = signal('');
  const active = () => catalog.current() && props.active !== false && lifecycle() === 'active';
  const filtered = () => sortScheduledTasks(app.tasks().filter(item => {
    if (filter() !== 'all' && (record(item.task).enabled === true) !== (filter() === 'active')) return false;
    const needle = search().trim().toLocaleLowerCase();
    return !needle || `${text(record(item.task).name)} ${scheduleSummary(record(item.task))}`.toLocaleLowerCase().includes(needle);
  }));
  const openHistory = (item: Row) => { if (!catalog.current()) return; historyTask.set(item); view.set('history'); };
  effect(() => { const visible = active(); untracked(() => { if (visible) void catalog.load(); else catalog.suspend(); }); });
  observeRuns(active, () => { void catalog.load(); });
  return <View class="flex-1 bg-background">
    <View class="px-[18px] pt-5 gap-7">
      <View class="flex-row items-center gap-3"><Text role="header" class="flex-1 font-semibold text-foreground" style={{ fontSize: 32 }}>{t('sessions.scheduledTasks.dialog.title')}</Text><If when={!!props.onOpenAssistant && active()}><ScheduleAssistant onOpen={target => props.onOpenAssistant?.(target)} current={active} /></If></View>
      <View role="tablist" accessibilityLabel={t('sessions.scheduledTasks.workspace.views.aria')} class="flex-row rounded-full border border-border/30 bg-card p-1 shadow-sm">
        <Button testID="scheduled-tasks-tab" role="tab" selected={view() === 'tasks'} class="flex-1 min-h-10 flex-row gap-2 items-center justify-center rounded-full selected:bg-accent active:bg-accent" onPress={() => view.set('tasks')}><Icon name="calendar-schedule" size={16} /><Text class="text-sm font-semibold text-muted-foreground">{t('sessions.scheduledTasks.workspace.views.tasks')}</Text></Button>
        <Button testID="scheduled-history-tab" role="tab" selected={view() === 'history'} class="flex-1 min-h-10 flex-row gap-2 items-center justify-center rounded-full selected:bg-accent active:bg-accent" onPress={() => { historyTask.set(null); view.set('history'); }}><Icon name="history" size={16} /><Text class="text-sm font-semibold text-muted-foreground">{t('sessions.scheduledTasks.workspace.views.history')}</Text></Button>
      </View>
      <If when={view() === 'tasks'}><View class="flex-row rounded-full border border-border/30 bg-card p-1 shadow-sm">
        <Each of={['all', 'active', 'paused'] as const}>{value => <Button testID={`scheduled-filter-${value()}`} class="flex-1 min-h-10 rounded-full selected:bg-accent active:bg-accent items-center justify-center" selected={filter() === value()} onPress={() => filter.set(value())}><Text class="text-sm font-semibold text-muted-foreground">{t(value() === 'all' ? 'sessions.scheduledTasks.workspace.filters.all' : value() === 'active' ? 'sessions.scheduledTasks.workspace.filters.active' : 'sessions.scheduledTasks.workspace.filters.paused')}</Text></Button>}</Each>
        <Button testID="scheduled-create" class="min-h-10 min-w-10 rounded-xl bg-secondary items-center justify-center active:bg-accent disabled:opacity-40" disabled={!app.projects().length || !active()} accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.newTask')} onPress={() => { if (active() && app.projects().length) props.onCreate(); }}><Text class="text-xl text-foreground">+</Text></Button>
      </View></If>
      <If when={view() === 'tasks'}><Input testID="scheduled-search" class="p-3 rounded-xl bg-card text-foreground" value={search()} onChange={event => search.set(event.value)} placeholder={t('sessions.scheduledTasks.workspace.search.placeholder')} accessibilityLabel={t('sessions.scheduledTasks.workspace.search.placeholder')} /></If>
    </View>
    <If when={view() === 'tasks'}><Scroll testID="scheduled-tasks" class="flex-1" contentClass="px-[18px] pt-5 pb-8 gap-4" refreshing={catalog.loading()} onRefresh={() => { void catalog.load(); }}>
      <Feedback catalog={catalog} />
      <If when={filtered().length === 0}><Text class="py-6 text-sm text-muted-foreground">{catalog.loading() ? t('sessions.scheduledTasks.dialog.loading') : catalog.loaded() ? t(!app.projects().length ? 'sessions.scheduledTasks.dialog.project.empty' : search().trim() ? 'sessions.scheduledTasks.workspace.search.noResults' : 'sessions.scheduledTasks.dialog.empty.noTasks') : ''}</Text></If>
      <Each of={filtered()} key={taskKey}>{item => <View class={`${card} flex-row items-center px-2`}>
        <Button class="flex-1 min-h-[72px] py-3 pl-1 flex-row items-center gap-2 active:opacity-70" accessibilityLabel={`${text(record(item().task).name)}, ${statusLabel(record(record(item().task).state).lastStatus)}, ${t('sessions.scheduledTasks.dialog.lastRun.label')} ${dateTime(record(record(item().task).state).lastRunAt)}`} onPress={() => { if (catalog.current()) (props.onOpenTask ?? props.onEdit)(item()); }}>
          <StatusIcon task={record(item().task)} />
          <View class="flex-1 gap-1"><Text class="text-sm font-semibold text-foreground" style={{ numberOfLines: 1 }}>{text(record(item().task).name)}</Text><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{scheduleSummary(record(item().task))} · {record(item().task).enabled ? relative(record(record(item().task).state).nextRunAt) : t('sessions.scheduledTasks.dialog.taskToggle.paused')}</Text><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{app.projects().find(project => project.id === item().projectId)?.name || text(item().projectId)}</Text></View>
        </Button>
        <Button class={quiet} accessibilityLabel={t('sessions.scheduledTasks.history.filter.aria', { name: text(record(item().task).name) })} onPress={() => openHistory(item())}><Icon name="history" size={16} /></Button>
        <Button class={quiet} disabled={catalog.busy(item())} accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: text(record(item().task).name) })} onPress={() => { void taskMenu(catalog, item(), props.onEdit, openHistory, props.onOpenSession); }}><Icon name="more" size={18} /></Button>
      </View>}</Each>
      <Button class={quiet} accessibilityLabel={t('mcpDropdown.actions.refreshAria')} disabled={catalog.loading()} onPress={() => { void catalog.load(); }}><Icon name="refresh" size={16} /></Button>
    </Scroll></If>
    <If when={view() === 'history'}><Each of={[historyTask()]} key={item => item ? taskKey(item) : 'global'}>{selected => <History active={active()} identity={selected() ? taskIdentity(selected()!) : undefined} onOpenSession={props.onOpenSession} header={<If when={!!selected()}><Button class={action} accessibilityLabel={t('sessions.scheduledTasks.history.filter.clearAria')} onPress={() => historyTask.set(null)}><Text class="text-foreground">{text(record(selected()?.task).name)} · {t('sessions.scheduledTasks.history.filter.clearAria')}</Text></Button></If>} />}</Each></If>
  </View>;
}

/** Host owns SafeArea, nativeTabBar and navigation. Changing Host remounts the scope. */
export function ScheduledHome(props: ScheduledHomeProps) {
  return <Each of={app.connection() ? [app.connection()!] : []}>{() => <ScopedHome {...props} />}</Each>;
}

export function ScheduledTaskDetail(props: ScheduledTaskDetailProps) {
  const catalog = createScheduledCatalog(), currentItem = () => catalog.latest(props.item) ?? (!catalog.loaded() || catalog.partial().includes(text(props.item.projectId)) ? props.item : undefined), task = () => record(currentItem()?.task);
  const state = () => record(task().state), execution = () => record(task().execution);
  const active = () => catalog.current() && props.active !== false && lifecycle() === 'active';
  effect(() => { const visible = active(); untracked(() => { if (visible) void catalog.load(); else catalog.suspend(); }); });
  let dismissed = false;
  effect(() => {
    if (!active() || !catalog.loaded() || catalog.loading() || catalog.error() || catalog.partial().includes(text(props.item.projectId)) || catalog.latest(props.item) || dismissed || !props.onDeleted) return;
    dismissed = true; untracked(() => props.onDeleted?.());
  });
  observeRuns(active, () => { void catalog.load(); });
  const run = async () => { const item = currentItem(); if (!item) return; const target = await catalog.mutate(item, 'run'); if (target && catalog.current()) props.onOpenSession(target); };
  return <NavPage title={text(task().name) || text(record(props.item.task).name)} headerBackTitle="" class="flex-1 bg-background" headerRight={<Button class={quiet} disabled={!active() || !catalog.latest(props.item)} accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.edit')} onPress={() => { const item = catalog.latest(props.item); if (item && active()) props.onEdit(item); }}><Icon name="edit" size={20} /></Button>}>
    <History active={active()} identity={taskIdentity(props.item)} onOpenSession={props.onOpenSession} header={<View class="gap-4">
      <Feedback catalog={catalog} />
      <If when={!!currentItem() && catalog.current()} else={<Text class="py-4 text-muted-foreground">{t('sessions.scheduledTasks.dialog.empty.noTasks')}</Text>}>
        <View class={`${card} p-4 gap-4`}>
          <View class="flex-row items-center gap-3"><StatusIcon task={task()} /><View class="flex-1 gap-1"><Text class="text-base font-semibold text-foreground">{text(task().name)}</Text><Text class="text-xs text-muted-foreground">{t(task().enabled ? 'sessions.scheduledTasks.dialog.taskToggle.enabled' : 'sessions.scheduledTasks.dialog.taskToggle.paused')} · {statusLabel(state().lastStatus)}</Text></View><Button class={quiet} disabled={catalog.busy(props.item) || !catalog.latest(props.item)} accessibilityLabel={t('sessions.scheduledTasks.dialog.actions.moreAria', { taskName: text(task().name) })} onPress={() => { const item = catalog.latest(props.item); if (item) void taskMenu(catalog, item, props.onEdit, undefined, props.onOpenSession); }}><Icon name="more" size={20} /></Button></View>
          <Meta label={t('sessions.scheduledTasks.dialog.project.label')} value={app.projects().find(project => project.id === props.item.projectId)?.name || text(props.item.projectId)} />
          <If when={!!app.projects().find(project => project.id === props.item.projectId)?.path}><Text class="text-xs text-muted-foreground">{app.projects().find(project => project.id === props.item.projectId)?.path}</Text></If>
          <Text class="text-sm text-muted-foreground">{scheduleSummary(task(), true)}</Text>
          <Meta label={t('sessions.scheduledTasks.dialog.nextRun.label')} value={task().enabled ? dateTime(state().nextRunAt) : '—'} />
          <Meta label={t('sessions.scheduledTasks.dialog.lastRun.label')} value={typeof state().lastRunAt === 'number' ? dateTime(state().lastRunAt) : t('sessions.scheduledTasks.dialog.lastRun.never')} />
          <If when={!!state().lastError}><Text class="text-sm text-destructive">{text(state().lastError)}</Text></If>
          <View class="flex-row gap-2"><Button class={`${action} flex-1`} disabled={!catalog.latest(props.item) || catalog.busy(props.item) || task().enabled !== true || state().lastStatus === 'running'} onPress={() => { void run(); }}><Text class="text-foreground">{t('sessions.scheduledTasks.dialog.actions.runNow')}</Text></Button><Button class={`${action} flex-1`} disabled={!catalog.latest(props.item) || catalog.busy(props.item)} onPress={() => { const item = currentItem(); if (item) void catalog.mutate(item, 'toggle'); }}><Text class="text-foreground">{t(task().enabled ? 'sessions.scheduledTasks.dialog.actions.pause' : 'sessions.scheduledTasks.dialog.actions.resume')}</Text></Button></View>
        </View>
        <View class={`${card} p-4 gap-3`}><Text class="text-xs font-semibold text-muted-foreground">{t('sessions.scheduledTasks.editor.prompt.label')}</Text><TextView markdown={text(execution().prompt)} selectable class="text-sm text-foreground" /><Meta label={t('sessions.scheduledTasks.editor.model.label')} value={[text(execution().providerID), text(execution().modelID)].filter(Boolean).join(' / ')} /><If when={!!execution().agent}><Meta label={t('sessions.scheduledTasks.editor.agent.label')} value={text(execution().agent)} /></If><If when={!!execution().variant}><Meta label={t('sessions.scheduledTasks.editor.thinkingLevel.label')} value={text(execution().variant)} /></If></View>
      </If>
      <View class="flex-row items-center justify-between"><Text role="header" class="text-lg font-semibold text-foreground">{t('sessions.scheduledTasks.workspace.views.history')}</Text><Button class={quiet} accessibilityLabel={t('mcpDropdown.actions.refreshAria')} disabled={catalog.loading()} onPress={() => { void catalog.load(); }}><Icon name="refresh" size={17} /></Button></View>
    </View>} />
  </NavPage>;
}
