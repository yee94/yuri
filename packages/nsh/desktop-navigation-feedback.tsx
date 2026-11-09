import { signal, Text, View } from 'nsh';
import { Button } from 'nsh/base';
import type { attachDesktopNavigationApplication } from './desktop-navigation-application';
import { t } from './i18n';

export type DesktopNavigationFeedbackProps = {
  controller: Pick<ReturnType<typeof attachDesktopNavigationApplication>, 'state' | 'retryRestore' | 'retryWrite'>;
  active?: boolean;
};

/** Content feedback only: no title/status header and no raw errors, paths or payloads.
 * Retry delegates exactly one read/write lane; it is not a user navigation intent and
 * must never revoke the core's existing user-intent veto or reapply a captured route. */
export function NativeDesktopNavigationFeedback(props: DesktopNavigationFeedbackProps) {
  const retrying = signal(false);
  const restoreFailed = () => props.controller.state().restore === 'error' || props.controller.state().restore === 'blocked';
  const enabled = () => props.active !== false && !retrying();
  function retry(lane: 'restore' | 'write') {
    if (!enabled() || (lane === 'restore' ? !restoreFailed() : props.controller.state().write !== 'error')) return;
    retrying.set(true);
    void Promise.resolve().then(async () => {
      if (props.active === false) return;
      if (lane === 'restore') await props.controller.retryRestore();
      else await props.controller.retryWrite();
    })
      .catch(() => { /* The owning controller retains failure/prior state. Never render a transport error. */ })
      .finally(() => retrying.set(false));
  }
  const action = 'min-h-11 px-3 py-2 rounded-xl bg-secondary active:bg-accent items-center justify-center disabled:opacity-40';
  return <>
    <If when={restoreFailed()}><View testID="desktop-navigation-restore-feedback" class="px-4 py-2 bg-card flex-row items-center gap-3">
      <Text role="alert" class="flex-1 text-sm text-destructive">{t(props.controller.state().restore === 'blocked' ? 'sessions.navigation.restoreBlocked' : 'sessions.navigation.restoreFailed')}</Text>
      <Button testID="desktop-navigation-restore-retry" class={action} disabled={!enabled()} onPress={() => retry('restore')}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button>
    </View></If>
    <If when={props.controller.state().write === 'error'}><View testID="desktop-navigation-write-feedback" class="px-4 py-2 bg-card flex-row items-center gap-3">
      <Text role="alert" class="flex-1 text-sm text-destructive">{t('sessions.navigation.saveFailed')}</Text>
      <Button testID="desktop-navigation-write-retry" class={action} disabled={!enabled()} onPress={() => retry('write')}><Text class="text-foreground">{t('chat.questionDelegate.retry')}</Text></Button>
    </View></If>
  </>;
}
