import { notificationAdmission, type NotificationAdmission } from '../web/server/lib/notifications/admission-event.js';
import { notificationPreferenceValue, type NotificationPreferences } from './notification-preferences-core';
import type { NotificationLanguage, NotificationScope, NotificationTarget, NotificationLiveEvent } from './notification-core';
import type { RuntimeEvent } from './model';

const preference = { completion: 'notifyOnCompletion', subtask: 'notifyOnSubtasks', error: 'notifyOnError', question: 'notifyOnQuestion', permission: 'notifyOnPermission', schedule: 'notifyOnScheduledTasks', assistant: 'notifyOnAssistants', goal: 'notifyOnGoals' } as const;
const same = (a: NotificationScope, b: NotificationScope | null) => !!b && a.hostID === b.hostID && a.generation === b.generation;
type Pending = { admission: NotificationAdmission; scope: NotificationScope; language: NotificationLanguage };

/** One existing observer supplies admitted events. Never projects raw execution, history, token or status traffic. */
export function createNotificationGlobalAdmission(input: {
  scope: () => NotificationScope | null; language: () => NotificationLanguage; active: () => boolean;
  settings: () => NotificationPreferences | null;
  resolve: (admission: NotificationAdmission, current: () => boolean) => readonly NotificationTarget[] | Promise<readonly NotificationTarget[]>;
  deliver: (event: NotificationLiveEvent, admission: NotificationAdmission) => Promise<'scheduled' | 'suppressed' | 'duplicate' | 'stale'>;
  error: (error: 'readFailed' | 'unavailable', eventID: string) => void;
  resolved?: (eventID: string) => void;
}) {
  let alive = true, bound: NotificationScope | null = null, revision = 0;
  let flight: Promise<void> | null = null, dirty = false;
  const pending = new Map<string, Pending>(), seen = new Set<string>();
  function bind() {
    const next = input.scope();
    if (next && bound && same(next, bound) || !next && !bound) return;
    revision++; bound = next ? { ...next } : null; pending.clear(); seen.clear(); flight = null;
  }
  const remember = (id: string) => { seen.add(id); if (seen.size > 256) seen.delete(seen.values().next().value!); };
  async function retry() {
    bind();
    if (!alive || !bound || !input.active()) return;
    for (const [id, entry] of pending) if (entry.language !== input.language()) pending.set(id, { ...entry, language: input.language() });
    if (flight) { dirty = true; return flight; }
    const turn = revision;
    const work = (async () => {
      do {
        dirty = false;
        const batch = [...pending.values()]; let cursor = 0;
        await Promise.all(Array.from({ length: Math.min(2, batch.length) }, async () => {
          while (cursor < batch.length && alive && turn === revision && input.active()) {
            const entry = batch[cursor++], { admission } = entry;
            const valid = () => alive && turn === revision && same(entry.scope, input.scope()) && entry.language === input.language() && input.active() && pending.get(admission.eventID) === entry;
            if (!valid()) continue;
            const settings = input.settings();
            if (!settings) continue;
            if (!notificationPreferenceValue(settings, 'nativeNotificationsEnabled') || !notificationPreferenceValue(settings, preference[admission.kind])) {
              remember(admission.eventID); pending.delete(admission.eventID); input.resolved?.(admission.eventID); continue;
            }
            try {
              const matches = await input.resolve(admission, valid);
              if (!valid()) continue;
              if (matches.length !== 1 || matches[0].kind !== admission.target.kind || matches[0].id !== admission.target.id) { input.error('unavailable', admission.eventID); continue; }
              const confirmed = input.settings();
              if (!confirmed || !notificationPreferenceValue(confirmed, 'nativeNotificationsEnabled') || !notificationPreferenceValue(confirmed, preference[admission.kind])) continue;
              const result = await input.deliver({ origin: 'live', scope: entry.scope, eventID: admission.eventID, kind: admission.kind, target: { ...admission.target } }, admission);
              if (!valid() || result === 'stale') continue;
              remember(admission.eventID); pending.delete(admission.eventID); input.resolved?.(admission.eventID);
            } catch (error) {
              if (valid() && !(error instanceof Error && error.message === 'notification_catalog_incomplete')) input.error('readFailed', admission.eventID);
            }
          }
        }));
      } while (dirty && alive && turn === revision && input.active());
    })();
    flight = work;
    try { await work; } finally { if (flight === work) flight = null; }
  }
  return {
    retry,
    retire(clear = false) {
      revision++; flight = null; dirty = false;
      if (clear) { pending.clear(); seen.clear(); bound = null; }
    },
    onEvent(event: RuntimeEvent, scope: NotificationScope) {
      if (!alive || event.key !== 'global' || !input.active() || !same(scope, input.scope())) return;
      bind();
      if (event.type === 'reconnected' || event.type === 'server.connected') { void retry(); return; }
      if (event.type !== 'yuri:notification-admitted') return;
      const admission = notificationAdmission(event.body);
      if (!admission || seen.has(admission.eventID) || pending.has(admission.eventID)) return;
      pending.set(admission.eventID, { admission, scope: { ...scope }, language: input.language() });
      if (pending.size > 256) pending.delete(pending.keys().next().value!);
      void retry();
    },
    dispose() { alive = false; revision++; pending.clear(); seen.clear(); },
  };
}
