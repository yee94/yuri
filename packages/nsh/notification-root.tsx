import { cleanup, effect, host, lifecycle, signal, Text, untracked, View } from 'nsh';
import { Button } from 'nsh/base';
import { t } from './i18n';
import { settingsAction } from './settings-controls';
import { bindNativeNotificationRoot, currentNotificationLanguage, nativeNotificationAuthorization, nativeNotificationSettings, notificationScopedRequest, type NotificationRequest } from './notification-runtime';
import { createNotificationRootController, type NotificationRootInput, type NotificationRootState } from './notification-root-core';
import { notificationSessionLookup } from './notification-session-live';
import { native } from './runtime';
export { nativeNotificationScope } from './notification-runtime';

/** One root. Runtime events come only from observeRuntime's existing parsed-global callback. */
export function createNativeNotificationRoot<Destination>(input: Omit<NotificationRootInput<Destination>, 'transport' | 'changed'> & {
  captureRequest?: () => NotificationRequest;
  /** Legacy application prop, not a safe sender. Remove it when supplying captureRequest. */
  settingsRead?: () => Promise<unknown>;
}) {
  const unbind = bindNativeNotificationRoot(input);
  const state = signal<NotificationRootState>({ ready: false, refreshing: false, error: null, recovery: 'waitingReady' });
  const controller = createNotificationRootController({ ...input, transport: nativeNotificationSettings,
    authorizationID: input.authorizationID ?? nativeNotificationAuthorization,
    lookup: input.lookup ?? ((id, directory, current) => notificationSessionLookup(notificationScopedRequest())(id, directory, current)),
    call: input.call ?? native, changed: next => state.set(next),
  });
  effect(() => {
    const scope = input.scope(), language = currentNotificationLanguage(), active = lifecycle() === 'active';
    (input.authorizationID ?? nativeNotificationAuthorization)();
    untracked(() => controller.bind(scope, language, active));
  });
  const stopRoutes = host.on('notification.route', value => { void controller.route(value); });
  const stopLaunchHints = host.on('notification.launch.available', () => { void controller.recover(); });
  cleanup(() => { stopRoutes(); stopLaunchHints(); controller.dispose(); unbind(); });
  function Feedback() {
    return <If when={!!state().error}><View testID="notification-root-feedback" class="px-4 py-2 bg-card gap-2">
      <Text class="text-sm text-destructive">{t(state().error === 'readFailed' ? 'settings.notifications.native.readFailed' : 'common.unavailable')}</Text>
      <If when={state().error === 'readFailed' || state().error === 'unavailable'}><Button testID="notification-root-retry" class={settingsAction} disabled={state().refreshing} onPress={() => { void controller.refresh(); }}><Text class="text-foreground">{t('settings.voice.volcengine.retry')}</Text></Button></If>
      <If when={state().error === 'unavailable' || state().error === 'unsupported'}><Button class={settingsAction} onPress={controller.dismissUnavailable}><Text class="text-foreground">{t('dialog.common.actions.close')}</Text></Button></If>
    </View></If>;
  }
  return { onEvent: controller.onEvent, refresh: controller.refresh, recover: controller.recover, Feedback, state };
}
