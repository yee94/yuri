import { cleanup, effect, lifecycle, platform, Scroll, signal, Text, untracked, View, type ScrollRef } from 'nsh';
import { nativeDensity } from './appearance';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { SettingsGroup, SettingsToggle, settingsAction, settingsPageLifetime } from './settings-controls';
import { SettingsTarget } from './settings-target';
import { createSettingsTargetNavigation } from './settings-search-core';
import { SettingsNativeNotifications } from './notification';
import { nativeNotificationScope, nativeNotificationSettings } from './notification-runtime';
import { createNotificationPreferencesController, notificationEventFields } from './notification-preferences-core';
import { publishSettingsEditor } from './desktop-settings-publisher';

/** Device permission never rewrites a Host preference. Only acknowledged writes + read-back configure native. */
export function SettingsNotifications(props: { target?: string; active?: boolean }) {
  const lifetime = settingsPageLifetime(() => props.active !== false && lifecycle() === 'active'), permissionBusy = signal(false);
  let scroll!: ScrollRef;
  const navigation = createSettingsTargetNavigation(() => scroll, lifetime.current, () => lifetime.operation()?.current ?? (() => false));
  const current = () => lifetime.current() && nativeNotificationScope() !== null;
  const controller = createNotificationPreferencesController({
    desktop: platform?.desktop === true,
    read: nativeNotificationSettings.read, write: nativeNotificationSettings.write, synchronize: nativeNotificationSettings.synchronize,
    current, captureCurrent: () => lifetime.operation()?.current ?? (() => false), changed: next => state.set(next),
  });
  const state = signal(controller.state());
  publishSettingsEditor({ current: () => current() && props.active !== false && lifecycle() === 'active',
    scope: () => { const scope = nativeNotificationScope(); return scope ? `${scope.generation}:${scope.hostID}` : null; },
    pending: () => state().busy || state().pending !== null || state().syncPending || permissionBusy(),
    dirty: () => Object.keys(state().draft).length > 0, stamp: () => [state().draft],
  });
  const blocked = () => !current() || state().busy || state().pending !== null || state().snapshot === null;
  const confirmed = nativeNotificationSettings.confirmed();
  let loaded = !!confirmed && current();
  if (loaded && confirmed) controller.adopt(confirmed.preferences);
  const stop = nativeNotificationSettings.onConfirmed(value => { if (current()) controller.adopt(value.preferences); });
  cleanup(stop);
  cleanup(controller.retire);
  effect(() => {
    const operation = lifetime.operation(), active = props.active !== false && lifecycle() === 'active' && current();
    untracked(() => {
      controller.retire();
      if (!active || !operation) { loaded = false; return; }
      if (!loaded) void controller.refresh();
      loaded = false;
    });
  });
  return <Scroll ref={scroll} onScroll={navigation.onScroll} class="flex-1" contentClass="p-5 gap-5 pb-10" contentStyle={nativeDensity().pages.settings}>
    <View testID="notification-settings-header" class="flex-row justify-end">
      <Button testID="settings-notifications-save" class={settingsAction} disabled={blocked() || permissionBusy() || state().syncPending || !Object.keys(state().draft).length} onPress={() => { void controller.save(); }}><Text class="text-foreground">{t('settings.plugins.page.action.save')}</Text></Button>
    </View>
    <If when={!!state().error}><Text testID="notification-preferences-error" class="text-sm text-destructive">{state().error ? t(`settings.notifications.native.${state().error!}`) : ''}</Text></If>
    <If when={state().saved}><Text class="text-sm text-muted-foreground">{t('filesView.editor.saved')}</Text></If>
    <If when={!!state().error || state().pending !== null || state().syncPending || !state().snapshot}><Button testID="notification-preferences-retry" class={settingsAction} disabled={state().busy || permissionBusy() || !current()} onPress={() => { void controller.refresh(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
    <SettingsTarget id="notifications.nativeNotificationsEnabled" target={props.target} onReveal={navigation.reveal}>
      <SettingsNativeNotifications hostID={nativeNotificationScope()?.hostID ?? ''} enabled={controller.value('nativeNotificationsEnabled')} active={props.active} current={current} operationToken={lifetime.operation()} disabled={blocked()} onBusyChange={value => permissionBusy.set(value)} onEnabledChange={value => controller.edit('nativeNotificationsEnabled', value)} />
    </SettingsTarget>
    <SettingsTarget id="notifications.notificationMode" target={props.target} onReveal={navigation.reveal}>
      <If when={platform?.desktop === true}><SettingsToggle testID="settings-notifications-focused" title={t('settings.notifications.page.delivery.focusedLabel')} value={controller.mode() === 'always'} disabled={blocked() || permissionBusy() || !controller.value('nativeNotificationsEnabled')} onChange={value => controller.editMode(value ? 'always' : 'hidden-only')} /></If>
      <If when={platform?.desktop !== true}><Text testID="notification-native-policy" class="text-xs text-muted-foreground">{t('settings.notifications.native.policy')}</Text></If>
    </SettingsTarget>
    <If when={!!state().snapshot && (controller.value('nativeNotificationsEnabled') || notificationEventFields.some(field => props.target === `notifications.${field.key}`))}><SettingsGroup title={t('settings.notifications.page.events.title')}>
      <Each of={notificationEventFields}>{field => <SettingsTarget id={`notifications.${field().key}`} target={props.target} onReveal={navigation.reveal}>
        <SettingsToggle testID={`notification-event-${field().key}`} title={t(field().title)} value={controller.value(field().key)} disabled={blocked() || permissionBusy() || !controller.value('nativeNotificationsEnabled')} onChange={value => controller.edit(field().key, value)} />
      </SettingsTarget>}</Each>
    </SettingsGroup></If>
  </Scroll>;
}
