import { cleanup, effect, host, lifecycle, signal, Text, untracked } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { native } from './runtime';
import { SettingsGroup, SettingsToggle, settingsAction } from './settings-controls';
import { notificationAuthorized, notificationStatus, requestNotificationEnable, type NotificationCall, type NotificationStatus } from './notification-core';
import { currentNotificationLanguage } from './notification-runtime';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';

export { currentNotificationLanguage } from './notification-runtime';

/** Replaces Basic's raw enable row. The parent owns platform-specific mode controls. */
export function SettingsNativeNotifications(props: {
  hostID: string; enabled: boolean; active?: boolean; current: () => boolean;
  onEnabledChange: (enabled: boolean) => void | Promise<void>;
  disabled?: boolean; onBusyChange?: (busy: boolean) => void;
  operationToken?: unknown;
  call?: NotificationCall;
}) {
  const call: NotificationCall = props.call ?? native;
  const status = signal<NotificationStatus | null>(null), busy = signal(false), error = signal(''), notice = signal('');
  let alive = true, refreshRevision = 0, actionRevision = 0;
  const current = () => alive && props.current();
  function captureCurrent() {
    const operation = props.operationToken, revision = actionRevision;
    return () => current() && props.active !== false && lifecycle() === 'active' && operation === props.operationToken && revision === actionRevision;
  }
  const disabled = () => busy() || props.disabled === true || props.active === false;
  cleanup(() => { alive = false; ++refreshRevision; ++actionRevision; props.onBusyChange?.(false); });
  async function refresh() {
    const turn = ++refreshRevision;
    const valid = captureCurrent();
    try { const next = notificationStatus(await call('notification.status')); if (valid() && turn === refreshRevision) { status.set(next); error.set(''); } }
    catch { if (valid() && turn === refreshRevision) error.set(t('settings.notifications.page.toast.notificationsApiUnavailable')); }
  }
  async function perform(work: (valid: () => boolean) => Promise<void>, failureKey: I18nKey = 'settings.notifications.page.toast.testNotificationFailed') {
    if (!current() || disabled()) return;
    const valid = captureCurrent();
    if (!valid()) return;
    busy.set(true); props.onBusyChange?.(true); error.set(''); notice.set('');
    try { await work(valid); }
    catch { if (valid()) error.set(t(failureKey)); }
    finally { if (valid()) { busy.set(false); props.onBusyChange?.(false); } }
  }
  async function enable(next: boolean) {
    await perform(async valid => {
      if (!next) { await props.onEnabledChange(false); return; }
      const scopedCall: NotificationCall = (name, body) => valid() ? call(name, body) : Promise.reject(new Error('notification_stale'));
      const nextStatus = await requestNotificationEnable(scopedCall);
      if (!valid()) return;
      ++refreshRevision;
      status.set(nextStatus);
      if (notificationAuthorized(nextStatus)) await props.onEnabledChange(true);
      else error.set(t(`settings.notifications.native.${nextStatus.authorization}`));
    }, 'settings.notifications.page.toast.requestPermissionFailed');
  }
  async function test() {
    await perform(async valid => {
      const result = await call('notification.test', { hostID: props.hostID, language: currentNotificationLanguage() });
      if (!result || typeof result !== 'object' || (result as Record<string, unknown>).result !== 'scheduled') throw new Error('notification_not_scheduled');
      if (valid()) notice.set(t('settings.notifications.native.scheduled'));
    });
  }
  effect(() => {
    props.operationToken;
    const active = props.active !== false && lifecycle() === 'active' && current();
    untracked(() => { ++actionRevision; ++refreshRevision; busy.set(false); props.onBusyChange?.(false); if (active) void refresh(); });
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
