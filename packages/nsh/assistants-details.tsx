import { cleanup, effect, lifecycle, signal, Text, untracked, View } from 'nsh';
import { AlertDialog, Button } from 'nsh/base';
import { BotEditor } from './features';
import { AssistantChannels } from './assistants-channels';
import { assistantRequest, assistantScheduledFallback, assistantScheduledTasks, assistantURL, clearAssistantHistory, type AssistantFence } from './assistants-core';
import { t } from './i18n';
import { Icon } from './Icon';
import { record, text, type ChatTarget, type Row } from './model';
import { app, captureHostRequest, epoch } from './state';

export type AssistantDetailsProps = {
  bot: Row;
  onDone: () => void;
  onOpenChat?: (target: ChatTarget) => void;
  onOpenTask?: (item: Row) => void;
  active?: boolean;
  /** The owning integration supplies localized copy; history wipe is not Bot deletion. */
  historyActions?: { clearLabel: string; confirmDescription: string; clearedLabel: string };
  onHistoryCleared?: (assistantID: string, generation: number) => void;
};

function scheduleLabel(task: Row) {
  const schedule = record(task.schedule), kind = text(schedule.kind), timezone = text(schedule.timezone);
  const time = Array.isArray(schedule.times) ? schedule.times.filter(value => typeof value === 'string').join(', ') : text(schedule.time);
  if (kind === 'daily') return t(timezone ? 'sessions.scheduledTasks.dialog.schedule.dailyWithTimezone' : 'sessions.scheduledTasks.dialog.schedule.daily', { time, timezone });
  if (kind === 'weekly') {
    const keys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
    const days = Array.isArray(schedule.weekdays) ? schedule.weekdays.filter((value): value is number => typeof value === 'number' && value >= 0 && value < 7 && Number.isInteger(value)).map(day => t(`sessions.scheduledTasks.dialog.schedule.weekdayShort.${keys[day]}`)).join(', ') : '';
    return t(timezone ? 'sessions.scheduledTasks.dialog.schedule.weeklyWithTimezone' : 'sessions.scheduledTasks.dialog.schedule.weekly', { days, time, timezone });
  }
  if (kind === 'once') return t(timezone ? 'sessions.scheduledTasks.dialog.schedule.onceWithTimezone' : 'sessions.scheduledTasks.dialog.schedule.once', { date: text(schedule.date), time, timezone });
  if (kind === 'cron') return t(timezone ? 'sessions.scheduledTasks.dialog.schedule.cronWithTimezone' : 'sessions.scheduledTasks.dialog.schedule.cron', { cron: text(schedule.cron), timezone });
  return t('assistants.contact.card.schedule.timeUnavailable');
}
function taskStatus(task: Row) {
  const status = text(record(task.state).lastStatus);
  if (task.enabled === false) return t('sessions.scheduledTasks.dialog.taskToggle.paused');
  return t(status === 'running' ? 'sessions.scheduledTasks.dialog.status.running' : status === 'success' ? 'sessions.scheduledTasks.dialog.status.success' : status === 'error' ? 'sessions.scheduledTasks.dialog.status.error' : 'sessions.scheduledTasks.dialog.status.idle');
}

/** Saved Bot settings uses the same draft/revision owner as creation. No synthetic contact messages or guessed routes. */
export function AssistantDetails(props: AssistantDetailsProps) {
  const request = captureHostRequest();
  const captured = epoch(), connectionID = app.connection()?.id;
  let alive = true, sequence = 0;
  cleanup(() => { alive = false; });
  const fence: AssistantFence = { current: () => alive && captured === epoch() && connectionID === app.connection()?.id, request };
  const tasks = signal<Row[]>([]), loading = signal(true), error = signal('');
  const clearing = signal(false), historyError = signal(''), historyNotice = signal('');
  const requestLeave = signal<((afterLeave?: () => void) => Promise<void>) | null>(null);
  async function clearHistory() {
    const copy = props.historyActions;
    if (!copy || clearing() || !fence.current()) return;
    clearing.set(true); historyError.set(''); historyNotice.set('');
    try {
      const answer = await AlertDialog.show({ title: copy.clearLabel, description: copy.confirmDescription, actions: [{ id: 'cancel', label: t('settings.common.actions.cancel'), role: 'cancel' }, { id: 'clear', label: copy.clearLabel, role: 'destructive' }] });
      if (!fence.current() || answer.action !== 'clear') return;
      const result = await clearAssistantHistory(fence, props.bot);
      if (!fence.current()) return;
      historyNotice.set(copy.clearedLabel);
      props.onHistoryCleared?.(text(props.bot.id), Number(result.generation));
    } catch (failure) { if (fence.current()) historyError.set(failure instanceof Error ? failure.message : String(failure)); }
    finally { if (fence.current()) clearing.set(false); }
  }
  async function load() {
    if (!fence.current() || props.active === false || lifecycle() !== 'active') return;
    const attempt = ++sequence;
    loading.set(true);
    try {
      const page = await assistantRequest(fence, assistantURL(text(props.bot.id), '/scheduled-tasks'));
      if (!fence.current() || attempt !== sequence) return;
      const mapped = assistantScheduledTasks(page, tasks());
      tasks.set(mapped.tasks); error.set(mapped.incomplete ? t('assistants.state.unavailable') : '');
    } catch (failure) {
      if (!fence.current() || attempt !== sequence) return;
      error.set(failure instanceof Error ? failure.message : String(failure));
      try {
        const [contact, global] = await Promise.all([
          assistantRequest(fence, assistantURL(text(props.bot.id), '/contact/messages?limit=30')),
          assistantRequest(fence, '/api/yuri/scheduled-tasks'),
        ]);
        if (!fence.current() || attempt !== sequence) return;
        const fallback = assistantScheduledFallback(contact, global, tasks());
        tasks.set(fallback.tasks);
        // Keep the primary-load failure visible, including when fallback rows exist.
      } catch { /* Failed fallback leaves the last valid tasks and the primary error intact. */ }
    }
    finally { if (fence.current() && attempt === sequence) loading.set(false); }
  }
  effect(() => { if (props.active !== false && lifecycle() === 'active' && fence.current()) untracked(() => { void load(); }); else { sequence++; loading.set(false); } });
  return <BotEditor bot={props.bot} onDone={props.onDone} onNavigation={next => requestLeave.set(next)}>
    <If when={!!props.onOpenChat}><Button testID="assistant-settings-back-to-chat" class="p-3 rounded-xl bg-secondary flex-row items-center gap-2" disabled={!requestLeave()} onPress={() => { void requestLeave()?.(() => props.onOpenChat?.({ kind: 'assistant', id: text(props.bot.id), title: text(props.bot.name), directory: text(props.bot.effectiveWorkspacePath) })); }}><Icon name="chat-thread" /><Text class="text-foreground">{t('assistants.actions.backToChat')}</Text></Button></If>
    <View class="gap-2">
      <Text class="text-xs text-muted-foreground">{t('assistants.settings.scheduledTasks.title')}</Text>
      <View class="p-4 gap-3 rounded-2xl bg-card">
        <If when={loading()}><Text class="text-muted-foreground">{t('common.loading')}</Text></If>
        <Each of={tasks()}>{entry => <Button class="min-h-14 py-2 gap-1" disabled={!props.onOpenTask || !fence.current()} accessibilityLabel={t('assistants.settings.scheduledTasks.open', { name: text(record(entry().task).name) })} onPress={() => { if (fence.current()) props.onOpenTask?.(entry()); }}>
          <Text class="text-foreground font-semibold">{text(record(entry().task).name)}</Text>
          <Text class="text-xs text-muted-foreground">{scheduleLabel(record(entry().task))} · {taskStatus(record(entry().task))}</Text>
        </Button>}</Each>
        <If when={!loading() && !error() && !tasks().length}><Text class="text-muted-foreground">{t('assistants.settings.scheduledTasks.empty')}</Text></If>
        <If when={!!error()}><Text class="text-destructive">{error()}</Text><Button onPress={() => { void load(); }}><Text class="text-foreground">{t('assistants.actions.retry')}</Text></Button></If>
      </View>
    </View>
    <AssistantChannels bot={props.bot} />
    <If when={!!props.historyActions}><View class="gap-2"><Button testID="assistant-clear-history" class="min-h-11 p-3 rounded-xl bg-secondary disabled:opacity-40" disabled={clearing() || !fence.current()} onPress={() => { void clearHistory(); }}><Text class="text-destructive">{props.historyActions?.clearLabel}</Text></Button><If when={!!historyError()}><Text role="alert" class="text-destructive">{historyError()}</Text></If><If when={!!historyNotice()}><Text class="text-muted-foreground">{historyNotice()}</Text></If></View></If>
  </BotEditor>;
}
