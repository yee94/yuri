import { describe, expect, it } from 'vitest';
import { createNotificationDelivery, notificationAuthorized, notificationConfiguration, notificationLanguage, notificationStatus, notificationTarget, requestNotificationEnable, type NotificationLiveEvent, type NotificationScope } from './notification-core';
import { notificationMessageKeys } from './notification-messages';
import { createNotificationAdmission } from '../web/server/lib/notifications/admission-event.js';
import { settingsDict as en } from '../ui/src/lib/i18n/messages/en.settings';
import { settingsDict as zhCN } from '../ui/src/lib/i18n/messages/zh-CN.settings';
import { settingsDict as zhTW } from '../ui/src/lib/i18n/messages/zh-TW.settings';
import { settingsDict as ja } from '../ui/src/lib/i18n/messages/ja.settings';
import { settingsDict as ko } from '../ui/src/lib/i18n/messages/ko.settings';
import { settingsDict as fr } from '../ui/src/lib/i18n/messages/fr.settings';
import { settingsDict as es } from '../ui/src/lib/i18n/messages/es.settings';
import { settingsDict as pl } from '../ui/src/lib/i18n/messages/pl.settings';
import { settingsDict as ptBR } from '../ui/src/lib/i18n/messages/pt-BR.settings';
import { settingsDict as uk } from '../ui/src/lib/i18n/messages/uk.settings';
const notificationMessages: Record<string, Record<string, string>> = { en, 'zh-CN': zhCN, 'zh-TW': zhTW, ja, ko, fr, es, pl, 'pt-BR': ptBR, uk };

const status = (authorization: string) => ({ authorization, alert: 'enabled', sound: 'disabled', badge: 'unsupported', backgroundPush: false });
const scope = { hostID: 'host-a', generation: 4 };
const config = notificationConfiguration(scope.hostID, { nativeNotificationsEnabled: true }, 'en');
const admission = createNotificationAdmission('completion', { kind: 'session', id: 'session_1' }, { type: 'session', sessionID: 'session_1', directory: '/project', parentID: null, boundaryID: 'event-1' })!;
const event: NotificationLiveEvent = { origin: 'live', scope, eventID: admission.eventID, kind: 'completion', target: admission.target };

describe('native notification boundary', () => {
  it('reads every iOS authorization state without conflating permission, alert settings or APNs', () => {
    for (const value of ['notDetermined', 'denied', 'authorized', 'provisional', 'ephemeral', 'unknown']) {
      const result = notificationStatus(status(value));
      expect(notificationAuthorized(result)).toBe(['authorized', 'provisional', 'ephemeral'].includes(value));
      expect(result.backgroundPush).toBe(false);
    }
    for (const invalid of [null, {}, { ...status('authorized'), backgroundPush: true }, { ...status('allowed') }, { ...status('authorized'), alert: true }]) expect(() => notificationStatus(invalid)).toThrow();
  });
  it('requests only notDetermined and never claims denied permission was enabled', async () => {
    for (const value of ['denied', 'authorized', 'provisional', 'ephemeral', 'unknown']) {
      const calls: string[] = [];
      const result = await requestNotificationEnable(async name => { calls.push(name); return status(value); });
      expect(result.authorization).toBe(value); expect(calls).toEqual(['notification.status']);
    }
    const calls: string[] = [];
    expect((await requestNotificationEnable(async name => { calls.push(name); return status(name === 'notification.status' ? 'notDetermined' : 'denied'); })).authorization).toBe('denied');
    expect(calls).toEqual(['notification.status', 'notification.request']);
    await expect(requestNotificationEnable(async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });
  it('preserves Web defaults and event toggles but never forwards settings text or secrets', () => {
    expect(config).toEqual({ hostID: 'host-a', enabled: true, mode: 'hidden-only', language: 'en', events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'] });
    const result = notificationConfiguration('host-a', { nativeNotificationsEnabled: false, notificationMode: 'always', notifyOnSubtasks: true, notifyOnError: false, notificationTemplates: { title: 'private' }, token: 'excluded' }, 'ja');
    expect(result.events).toContain('subtask'); expect(result.events).not.toContain('error'); expect(result.enabled).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(/private|excluded|token/);
    expect(() => notificationConfiguration('https://host.invalid', {}, 'en')).toThrow();
    expect(() => notificationConfiguration('host-a', null, 'en')).toThrow();
    expect(() => notificationConfiguration('host-a', { notifyOnError: 'false' }, 'en')).toThrow();
    expect(() => notificationConfiguration('host-a', { notificationMode: 'sometimes' }, 'en')).toThrow();
  });
  it('only admits explicitly live, same Host AND generation events using an allowlist', async () => {
    let current: NotificationScope | null = scope;
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const delivery = createNotificationDelivery({ scope: () => current, call: async (name, body) => { calls.push([name, body]); return name === 'notification.configure' ? { lease: 'lease-1' } : { result: 'scheduled' }; } });
    expect(await delivery.acceptLive(event, admission)).toBe('stale');
    await delivery.configure(config);
    expect(await delivery.acceptLive({ ...event, body: 'excluded', token: 'excluded' } as NotificationLiveEvent, admission)).toBe('scheduled');
    expect(calls.at(-1)).toEqual(['notification.live', { lease: 'lease-1', eventID: admission.eventID, kind: 'completion', target: event.target, admission }]);
    await expect(delivery.acceptLive(event)).rejects.toThrow('notification_invalid_admission');
    await expect(delivery.acceptLive(event, { ...admission, token: 'excluded' })).rejects.toThrow('notification_invalid_admission');
    await expect(delivery.acceptLive({ ...event, kind: 'error' }, admission)).rejects.toThrow('notification_invalid_admission');
    await expect(delivery.acceptLive({ ...event, origin: 'history' } as unknown as NotificationLiveEvent, admission)).rejects.toThrow();
    await expect(delivery.acceptLive({ ...event, eventID: 'https://outside.invalid' }, admission)).rejects.toThrow();
    const long = createNotificationAdmission('completion', { kind: 'session', id: 'a'.repeat(128) }, { type: 'session', sessionID: 'a'.repeat(128), directory: '/project', parentID: null, boundaryID: 'b'.repeat(128) })!;
    expect(await delivery.acceptLive({ ...event, eventID: long.eventID, target: long.target }, long)).toBe('scheduled');
    await expect(delivery.acceptLive({ ...event, eventID: 'a'.repeat(385) }, admission)).rejects.toThrow();
    await expect(delivery.acceptLive({ ...event, target: { kind: 'assistant', id: 'a'.repeat(129) } }, admission)).rejects.toThrow();
    expect(await delivery.acceptLive({ ...event, scope: { ...scope, generation: 3 } }, admission)).toBe('stale');
    current = { ...scope, generation: 5 };
    expect(await delivery.acceptLive(event, admission)).toBe('stale');
    current = null; delivery.invalidate(); expect(await delivery.acceptLive(event, admission)).toBe('stale');
  });
  it('drops late configure/live replies and old tap routes after same-Host reconnect or configuration replacement', async () => {
    let finish!: (value: unknown) => void;
    let current = scope;
    const delivery = createNotificationDelivery({ scope: () => current, call: async () => new Promise(resolve => { finish = resolve; }) });
    const pending = delivery.configure(config);
    current = { ...scope, generation: 5 }; finish({ lease: 'old-lease' }); await pending;
    expect(await delivery.acceptLive({ ...event, scope: current }, admission)).toBe('stale');
    const next = delivery.configure(config); finish({ lease: 'new-lease' }); await next;
    const tap = { hostID: scope.hostID, lease: 'new-lease', target: event.target };
    expect(delivery.route(tap)).toEqual(event.target);
    expect(delivery.route({ ...tap, lease: 'old-lease' })).toBeNull();
    expect(delivery.route({ ...tap, hostID: 'host-b' })).toBeNull();
    expect(delivery.route({ ...tap, url: 'https://outside.invalid' })).toBeNull();
    const flight = delivery.acceptLive({ ...event, scope: current }, admission);
    delivery.invalidate(); finish({ result: 'scheduled' });
    expect(await flight).toBe('stale'); expect(delivery.route(tap)).toBeNull();
  });
  it('signals failed configuration/delivery and never turns an unknown result into success', async () => {
    const delivery = createNotificationDelivery({ scope: () => scope, call: async name => name === 'notification.configure' ? { lease: 'valid-lease' } : {} });
    await delivery.configure(config); await expect(delivery.acceptLive(event, admission)).rejects.toThrow('notification_invalid_result');
    const failed = createNotificationDelivery({ scope: () => scope, call: async () => { throw new Error('denied'); } });
    await expect(failed.configure(config)).rejects.toThrow('denied'); expect(await failed.acceptLive(event, admission)).toBe('stale');
  });
  it('preserves a same-scope authoritative lease after a rejected reconfiguration', async () => {
    let fail = false;
    const delivery = createNotificationDelivery({ scope: () => scope, call: async name => {
      if (name === 'notification.configure') { if (fail) throw new Error('native'); return { lease: 'confirmed-lease' }; }
      return { result: 'suppressed' };
    } });
    await delivery.configure(config); fail = true;
    await expect(delivery.configure(config)).rejects.toThrow('native');
    expect(delivery.route({ hostID: scope.hostID, lease: 'confirmed-lease', target: event.target })).toEqual(event.target);
    expect(await delivery.acceptLive(event, admission)).toBe('suppressed');
  });
  it('rejects URLs, path traversal, extra credentials and incomplete route objects', () => {
    for (const invalid of [null, {}, { kind: 'url', id: 'valid' }, { kind: 'session', id: '../../private' }, { kind: 'session', id: 'https://outside.invalid' }, { kind: 'session', id: 'valid', token: 'excluded' }]) expect(notificationTarget(invalid)).toBeNull();
    expect(notificationTarget({ kind: 'assistant', id: 'bot-123' })).toEqual({ kind: 'assistant', id: 'bot-123' });
  });
  it('ships complete real translations in all ten languages and normalizes system locales', () => {
    expect(Object.keys(notificationMessages)).toHaveLength(10);
    const keys = notificationMessageKeys;
    for (const [language, messages] of Object.entries(notificationMessages)) {
      for (const key of keys) { const value = messages[key]; expect(value?.trim().length).toBeGreaterThan(0); if (language !== 'en') expect(value).not.toBe(notificationMessages.en[key]); }
    }
    for (const [input, result] of [['zh-Hant-HK', 'zh-TW'], ['zh-Hans-CN', 'zh-CN'], ['pt-PT', 'pt-BR'], ['uk-UA', 'uk'], ['ko_KR', 'ko'], ['de-DE', 'en']]) expect(notificationLanguage(input)).toBe(result);
  });
});
