import { cleanup, effect, host, lifecycle, List, locale, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { createScheduledHistory, scheduledRunTarget, type TaskIdentity } from './schedules-state';
import { runtimeEventFrom, type ChatTarget } from './model';
import { language, t } from './i18n';
import { nativeTimeFormat, nativeDensity } from './appearance';
import { formatCompactRunDuration, resolveRunDurationMs } from '../ui/src/lib/scheduledTaskRunDuration';

/** Owns presentation only; opaque paging and validation stay with the schedule history core. */
export function FeaturesTaskHistory(props: { identity: TaskIdentity; active: boolean; close: () => void; onOpenSession?: (target: ChatTarget) => void }) {
  const history = createScheduledHistory(props.identity), now = signal(Date.now());
  const active = () => props.active && history.current() && lifecycle() === 'active';
  const timestamp = (value: number) => {
    const preference = nativeTimeFormat();
    return new Intl.DateTimeFormat(language() === 'system' ? locale() : language(), { year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: preference === '12h' ? true : preference === '24h' ? false : undefined }).format(new Date(value));
  };
  effect(() => { const visible = active(); untracked(() => { if (visible) void history.load(); else history.suspend(); }); });
  effect(() => {
    if (!active() || !history.runs().some(run => run.status === 'running')) return;
    const timer = setInterval(() => now.set(Date.now()), 1000); return () => clearInterval(timer);
  });
  const stop = host.on('runtime.event', value => {
    const event = runtimeEventFrom(value);
    if (active() && event?.key === 'global' && ['scheduled-task-ran', 'yuri:scheduled-task-ran', 'reconnected'].includes(event.type)) void history.load();
  });
  cleanup(stop);
  return <View class="flex-1 gap-2"><View class="min-h-11 px-3 flex-row items-center"><Text role="header" class="flex-1 text-foreground">{t('sessions.scheduledTasks.workspace.views.history')}</Text><Button testID="features-history-close" class="min-h-11 px-3" onPress={props.close}><Text class="text-foreground">{t('gitView.common.done')}</Text></Button></View>
    <List testID="features-history" class="flex-1" contentClass="px-3 pb-6 gap-3" contentStyle={nativeDensity().pages.taskHistory} each={history.runs()} keyExtractor={run => run.id} refreshing={history.loading()} onRefresh={() => { void history.load(); }}
      header={() => <If when={!!history.error()}><Text testID="features-history-error" class="text-destructive">{history.error()}</Text><Button testID="features-history-retry" class="min-h-11 px-3 bg-secondary" disabled={history.loading()} onPress={() => { void history.retry(); }}><Text class="text-foreground">{t('sessions.scheduledTasks.history.retry')}</Text></Button></If>}
      empty={() => <Text class="p-3 text-muted-foreground">{t(history.loading() ? 'sessions.scheduledTasks.history.loading' : 'sessions.scheduledTasks.history.empty.title')}</Text>}
      footer={() => <If when={history.loaded() && !history.complete()}><Button testID="features-history-more" class="min-h-11 px-3 bg-secondary" disabled={history.loading()} onPress={() => { void history.load(true); }}><Text class="text-foreground">{t('sessions.scheduledTasks.history.loadMore')}</Text></Button></If>}
    >{run => <View testID={`features-history-run-${run().id}`} class="p-4 rounded-xl bg-card gap-2" style={nativeDensity().forms.historyCard}><Text class="text-foreground">{run().taskName}</Text><Text class="text-muted-foreground">{t(run().status === 'running' ? 'sessions.scheduledTasks.dialog.status.running' : run().status === 'success' ? 'sessions.scheduledTasks.dialog.status.success' : 'sessions.scheduledTasks.dialog.status.error')} · {timestamp(run().startedAt)} · {formatCompactRunDuration(resolveRunDurationMs(run(), run().status === 'running' ? now() : 0)) ?? '—'}</Text><If when={!!run().error}><Text class="text-destructive">{run().error}</Text></If><If when={!!props.onOpenSession && !!scheduledRunTarget(run())}><Button testID={`features-history-session-${run().id}`} class="min-h-11 px-3 bg-secondary" onPress={() => { const target = scheduledRunTarget(run()); if (target && active()) props.onOpenSession?.(target); }}><Text class="text-foreground">{t('sessions.scheduledTasks.history.openSession')}</Text></Button></If></View>}</List>
  </View>;
}
