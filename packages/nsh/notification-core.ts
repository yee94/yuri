import { notificationAdmission } from '../web/server/lib/notifications/admission-event.js';

const notificationKinds = ['completion', 'subtask', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'] as const;
export type NotificationKind = typeof notificationKinds[number];
export type NotificationLanguage = 'en' | 'zh-CN' | 'zh-TW' | 'ja' | 'ko' | 'fr' | 'es' | 'pl' | 'pt-BR' | 'uk';
export type NotificationTarget = { kind: 'session' | 'assistant' | 'schedule'; id: string };
export type NotificationScope = { hostID: string; generation: number };
export type NotificationStatus = {
  authorization: 'notDetermined' | 'denied' | 'authorized' | 'provisional' | 'ephemeral' | 'unknown';
  alert: 'enabled' | 'disabled' | 'unsupported' | 'unknown';
  sound: 'enabled' | 'disabled' | 'unsupported' | 'unknown';
  badge: 'enabled' | 'disabled' | 'unsupported' | 'unknown';
  backgroundPush: false;
};
export type NotificationConfiguration = { hostID: string; enabled: boolean; mode: 'always' | 'hidden-only'; events: NotificationKind[]; language: NotificationLanguage };
export type NotificationCall = (name: string, body?: Record<string, unknown>) => Promise<unknown>;
export const notificationIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
/** A typed namespace plus two bounded domain IDs; target/Host/lease identifiers remain limited to 128. */
export const notificationEventIdentifier = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,384}$/.test(value);
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

export function notificationStatus(value: unknown): NotificationStatus {
  const data = object(value);
  if (!data || !['notDetermined', 'denied', 'authorized', 'provisional', 'ephemeral', 'unknown'].includes(String(data.authorization)) || data.backgroundPush !== false
    || !['alert', 'sound', 'badge'].every(key => ['enabled', 'disabled', 'unsupported', 'unknown'].includes(String(data[key])))) throw new Error('notification_invalid_status');
  return { authorization: data.authorization as NotificationStatus['authorization'], alert: data.alert as NotificationStatus['alert'], sound: data.sound as NotificationStatus['sound'], badge: data.badge as NotificationStatus['badge'], backgroundPush: false };
}
export const notificationAuthorized = (status: NotificationStatus) => ['authorized', 'provisional', 'ephemeral'].includes(status.authorization);
export function notificationLanguage(value: string): NotificationLanguage {
  if (value.startsWith('zh')) return /TW|HK|Hant/.test(value) ? 'zh-TW' : 'zh-CN';
  if (value.startsWith('pt')) return 'pt-BR';
  const language = value.split(/[-_]/)[0];
  return ['ja', 'ko', 'fr', 'es', 'pl', 'uk'].includes(language) ? language as NotificationLanguage : 'en';
}
export function notificationTarget(value: unknown): NotificationTarget | null {
  const data = object(value);
  if (!data || Object.keys(data).sort().join(',') !== 'id,kind' || !['session', 'assistant', 'schedule'].includes(String(data.kind)) || !notificationIdentifier(data.id)) return null;
  return { kind: data.kind as NotificationTarget['kind'], id: data.id };
}

const eventSettings: Record<NotificationKind, string> = {
  completion: 'notifyOnCompletion', subtask: 'notifyOnSubtasks', error: 'notifyOnError', question: 'notifyOnQuestion',
  permission: 'notifyOnPermission', schedule: 'notifyOnScheduledTasks', assistant: 'notifyOnAssistants', goal: 'notifyOnGoals',
};
/** Only a successful authoritative settings snapshot may enter this projection. Unknown is not disabled. */
export function notificationConfiguration(hostID: string, value: unknown, language: NotificationLanguage): NotificationConfiguration {
  const data = object(value);
  if (!notificationIdentifier(hostID) || !data) throw new Error('notification_invalid_configuration');
  if (['nativeNotificationsEnabled', ...Object.values(eventSettings)].some(key => key in data && typeof data[key] !== 'boolean')
    || ('notificationMode' in data && data.notificationMode !== 'always' && data.notificationMode !== 'hidden-only')) throw new Error('notification_invalid_configuration');
  return {
    hostID, enabled: data.nativeNotificationsEnabled === true, mode: data.notificationMode === 'always' ? 'always' : 'hidden-only', language,
    events: notificationKinds.filter(kind => typeof data[eventSettings[kind]] === 'boolean' ? data[eventSettings[kind]] === true : kind !== 'subtask'),
  };
}

/** Turning a preference on is not permission. Denial must never optimistically turn the toggle on. */
export async function requestNotificationEnable(call: NotificationCall): Promise<NotificationStatus> {
  let status = notificationStatus(await call('notification.status'));
  if (status.authorization === 'notDetermined') status = notificationStatus(await call('notification.request'));
  return status;
}

export type NotificationLiveEvent = {
  origin: 'live'; scope: NotificationScope; eventID: string; kind: NotificationKind; target?: NotificationTarget;
};
/** No status/busy observer, history reader, timer, background task or connection of its own. */
export function createNotificationDelivery(input: { call: NotificationCall; scope: () => NotificationScope | null }) {
  let revision = 0;
  let lease: { id: string; scope: NotificationScope; revision: number } | null = null;
  const same = (a: NotificationScope, b: NotificationScope | null) => !!b && a.hostID === b.hostID && a.generation === b.generation;
  return {
    async configure(config: NotificationConfiguration) {
      const captured = input.scope(), turn = ++revision;
      const previous = lease;
      if (!captured || config.hostID !== captured.hostID) { lease = null; throw new Error('notification_stale'); }
      if (lease && !same(lease.scope, captured)) lease = null;
      let response: Record<string, unknown> | null;
      try { response = object(await input.call('notification.configure', { ...config })); }
      catch (error) {
        if (turn === revision && same(captured, input.scope()) && previous && same(previous.scope, captured)) lease = { ...previous, revision: turn };
        throw error;
      }
      if (turn !== revision || !same(captured, input.scope())) return;
      if (!response || !notificationIdentifier(response.lease)) throw new Error('notification_invalid_lease');
      lease = { id: response.lease, scope: { ...captured }, revision: turn };
    },
    invalidate() { revision++; lease = null; },
    ready(): boolean { return !!lease && same(lease.scope, input.scope()); },
    leaseCurrent(id: unknown): boolean { return !!lease && id === lease.id && same(lease.scope, input.scope()); },
    route(value: unknown): NotificationTarget | null {
      const data = object(value), captured = lease;
      if (!data || Object.keys(data).sort().join(',') !== 'hostID,lease,target' || !captured || !same(captured.scope, input.scope())
        || data.hostID !== captured.scope.hostID || data.lease !== captured.id) return null;
      return notificationTarget(data.target);
    },
    async acceptLive(event: NotificationLiveEvent, proof?: unknown): Promise<'scheduled' | 'suppressed' | 'duplicate' | 'stale'> {
      const captured = lease;
      if (!captured || !same(captured.scope, input.scope()) || !same(captured.scope, event.scope)) return 'stale';
      if (event.origin !== 'live' || !notificationEventIdentifier(event.eventID) || !notificationKinds.includes(event.kind)
        || (event.target !== undefined && !notificationTarget(event.target))) throw new Error('notification_invalid_event');
      const admission = notificationAdmission(proof);
      if (!admission || admission.kind !== event.kind || admission.eventID !== event.eventID
        || admission.target.kind !== event.target?.kind || admission.target.id !== event.target.id) throw new Error('notification_invalid_admission');
      // Explicit allowlist: never forward a spread of an upstream event (text, URLs, credentials, error details).
      const result = object(await input.call('notification.live', { lease: captured.id, eventID: event.eventID, kind: event.kind, target: admission.target, admission }));
      if (revision !== captured.revision || !same(captured.scope, input.scope())) return 'stale';
      if (!result || !['scheduled', 'suppressed', 'duplicate'].includes(String(result.result))) throw new Error('notification_invalid_result');
      return result.result as 'scheduled' | 'suppressed' | 'duplicate';
    },
  };
}
