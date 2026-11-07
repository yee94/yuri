import { cleanup, effect, host, lifecycle, signal, Text, untracked } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { native } from './runtime';
import { SettingsGroup, SettingsToggle, settingsAction } from './settings-controls';
import { notificationAuthorized, notificationStatus, requestNotificationEnable, type NotificationCall, type NotificationStatus } from './notification-core';
import { currentNotificationLanguage } from './notification-runtime';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';

export { currentNotificationLanguage } from './notification-runtime';

/** Replaces Basic's raw enable row. The native parent hides browser-only focused/template controls. */
export function SettingsNativeNotifications(props: {
  hostID: string; enabled: boolean; active?: boolean; current: () => boolean;
  onEnabledChange: (enabled: boolean) => void | Promise<void>;
  disabled?: boolean; onBusyChange?: (busy: boolean) => void;
  call?: NotificationCall;
}) {
  const call: NotificationCall = props.call ?? native;
  const status = signal<NotificationStatus | null>(null), busy = signal(false), error = signal(''), notice = signal('');
  let alive = true, refreshRevision = 0;
  const current = () => alive && props.current();
  const disabled = () => busy() || props.disabled === true || props.active === false;
  cleanup(() => { alive = false; ++refreshRevision; });
  async function refresh() {
    const turn = ++refreshRevision;
    try { const next = notificationStatus(await call('notification.status')); if (current() && turn === refreshRevision) { status.set(next); error.set(''); } }
    catch { if (current() && turn === refreshRevision) error.set(t('settings.notifications.page.toast.notificationsApiUnavailable')); }
  }
  async function perform(work: () => Promise<void>, failureKey: I18nKey = 'settings.notifications.page.toast.testNotificationFailed') {
    if (!current() || disabled()) return;
    busy.set(true); props.onBusyChange?.(true); error.set(''); notice.set('');
    try { await work(); }
    catch { if (current()) error.set(t(failureKey)); }
    finally { if (current()) { busy.set(false); props.onBusyChange?.(false); } }
  }
  async function enable(next: boolean) {
    await perform(async () => {
      if (!next) { await props.onEnabledChange(false); return; }
      const nextStatus = await requestNotificationEnable(call);
      if (!current()) return;
      ++refreshRevision;
      status.set(nextStatus);
      if (notificationAuthorized(nextStatus)) await props.onEnabledChange(true);
      else error.set(t(`settings.notifications.native.${nextStatus.authorization}`));
    }, 'settings.notifications.page.toast.requestPermissionFailed');
  }
  async function test() {
    await perform(async () => {
      const result = await call('notification.test', { hostID: props.hostID, language: currentNotificationLanguage() });
      if (!result || typeof result !== 'object' || (result as Record<string, unknown>).result !== 'scheduled') throw new Error('notification_not_scheduled');
      if (current()) notice.set(t('settings.notifications.native.scheduled'));
    });
  }
  effect(() => {
    if (props.active === false || lifecycle() !== 'active') return;
    untracked(() => { void refresh(); });
  });
  const off = host.on('notification.status', () => { if (current() && props.active !== false && lifecycle() === 'active') void refresh(); });
  cleanup(off);
  return <SettingsGroup title={t('settings.notifications.page.delivery.title')}>
    <SettingsToggle testID="notification-enable" title={t('settings.notifications.page.delivery.enableLabel')} value={props.enabled} disabled={disabled() || (!status() && !props.enabled)} onChange={next => { void enable(next); }} />
    <Text class="text-sm text-foreground">{t('settings.notifications.native.status')}</Text>
    <Text testID="notification-status" class="text-sm text-muted-foreground">{t(`settings.notifications.native.${status()?.authorization ?? 'unknown'}`)}</Text>
    <If when={!!status() && status()!.alert !== 'enabled'}><Text class="text-xs text-muted-foreground">{t('settings.notifications.native.alertDisabled')}</Text></If>
    <If when={status()?.authorization === 'notDetermined'}><Button testID="notification-request" class={settingsAction} disabled={disabled()} onPress={() => { void enable(true); }}><Text class="text-foreground">{t('settings.notifications.native.request')}</Text></Button></If>
    <Button testID="notification-settings" class={settingsAction} disabled={disabled()} onPress={() => { void perform(async () => { await call('notification.openSettings'); }, 'settings.notifications.page.toast.notificationsApiUnavailable'); }}><Text class="text-foreground">{t('settings.notifications.native.openSettings')}</Text></Button>
    <Button testID="notification-test" class={settingsAction} disabled={disabled() || !status() || !notificationAuthorized(status()!)} onPress={() => { void test(); }}><Text class="text-foreground">{t('settings.notifications.page.delivery.testAction')}</Text></Button>
    <Text testID="notification-background-gap" class="text-xs text-muted-foreground">{t('settings.notifications.native.backgroundGap')}</Text>
    <If when={!!error()}><Text testID="notification-error" class="text-sm text-destructive">{error()}</Text></If>
    <If when={!!notice()}><Text testID="notification-notice" class="text-sm text-muted-foreground">{notice()}</Text></If>
    <If when={!status() && !!error()}><Button class={settingsAction} disabled={disabled()} onPress={() => { void refresh(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
  </SettingsGroup>;
}
