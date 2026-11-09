import { locale, platform } from 'nsh';
import { language } from './i18n';
import { native } from './runtime';
import { app, captureHostRequest, epoch, isCurrentHostScope } from './state';
import { record } from './model';
import { notificationLanguage, type NotificationCall, type NotificationScope } from './notification-core';
import { createNotificationSettingsTransport } from './notification-preferences-core';

export const currentNotificationLanguage = () => notificationLanguage(language() === 'system' ? locale() : language());
export function nativeNotificationScope(): NotificationScope | null {
  const hostID = app.connection()?.id, generation = epoch(), runtimeScope = app.runtimeScope();
  return hostID && runtimeScope?.hostID === hostID && isCurrentHostScope(generation, hostID) ? { hostID, generation } : null;
}
export function nativeNotificationAuthorization(): string | null {
  const value = record(app.connection()).authorizationID;
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value) && value !== 'legacy' ? value : null;
}
export type NotificationRequest = (path: string, method?: string, body?: unknown) => Promise<unknown>;
// Root live/tap delivery and Basic read-back share this lease. Importing does not fetch or request permission.
type RootBinding = { scope: () => NotificationScope | null; captureRequest?: () => NotificationRequest; call?: NotificationCall };
let root: RootBinding | null = null;
let sender: { scope: NotificationScope; root: RootBinding | null; send: NotificationRequest } | null = null;
export function notificationScopedRequest(): NotificationRequest {
  const selected = root ? root.scope() : nativeNotificationScope();
  if (!selected) throw new Error('notification_stale');
  const captured = { ...selected }, owner = root;
  if (!sender || sender.scope.hostID !== captured.hostID || sender.scope.generation !== captured.generation || sender.root !== owner) {
    // Capture once per Host/generation. Never resolve a newer native request lease on an old sender.
    if (!owner?.captureRequest && app.runtimeScope()?.hostID !== captured.hostID) throw new Error('notification_unsupported');
    sender = { scope: captured, root: owner, send: owner?.captureRequest ? owner.captureRequest() : captureHostRequest() };
  }
  const send = sender.send;
  const valid = () => {
    const current = root ? root.scope() : nativeNotificationScope();
    return root === owner && current?.hostID === captured.hostID && current.generation === captured.generation;
  };
  return async (path, method, body) => {
    if (!valid()) throw new Error('notification_stale');
    const value = await send(path, method, body);
    if (!valid()) throw new Error('notification_stale');
    return value;
  };
}
export function bindNativeNotificationRoot(input: NonNullable<typeof root>) {
  if (root) throw new Error('Native notification root already mounted');
  root = input; sender = null;
  return () => { if (root === input) { nativeNotificationSettings.invalidate(); root = null; sender = null; } };
}
export const nativeNotificationSettings = createNotificationSettingsTransport({
  desktop: platform?.desktop === true,
  scope: () => root ? root.scope() : nativeNotificationScope(), language: currentNotificationLanguage,
  call: (name, body) => root?.call ? root.call(name, body) : native(name, body),
  read: () => notificationScopedRequest()('/api/config/settings'),
  write: changes => notificationScopedRequest()('/api/config/settings', 'PUT', changes),
});
