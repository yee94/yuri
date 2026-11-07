import { expect, it } from 'vitest';
import { createNotificationAdmission, type NotificationAdmission } from '../web/server/lib/notifications/admission-event.js';
import { createNotificationGlobalAdmission } from './notification-global-admission';
import { createNotificationAdmissionResolver, notificationSessionLookup } from './notification-session-live';
import { runtimeEventFrom, type RuntimeEvent, type Session } from './model';
import type { NotificationLanguage, NotificationScope, NotificationLiveEvent, NotificationTarget } from './notification-core';
import type { NotificationPreferences } from './notification-preferences-core';

const scope = { hostID: 'host-a', generation: 1 };
const tick = async () => { for (let n = 0; n < 40; n++) await Promise.resolve(); };
const session = (kind: 'completion' | 'subtask' | 'error' | 'question' | 'permission' | 'goal', boundaryID = kind) => createNotificationAdmission(kind, { kind: 'session', id: kind === 'subtask' ? 'child' : 'root' }, { type: 'session', sessionID: kind === 'subtask' ? 'child' : 'root', directory: '/project', parentID: kind === 'subtask' ? 'root' : null, boundaryID })!;
const assistant = () => createNotificationAdmission('assistant', { kind: 'assistant', id: 'bot' }, { type: 'assistant', assistantID: 'bot', turnID: 'turn', status: 'complete', publication: 'published' })!;
const schedule = (runID = 'run') => createNotificationAdmission('schedule', { kind: 'schedule', id: 'task' }, { type: 'schedule', projectID: 'project', taskID: 'task', runID, status: 'success', trigger: 'scheduled', resultOwner: 'unowned' })!;
const event = (value: NotificationAdmission): RuntimeEvent => runtimeEventFrom({ key: 'global', data: JSON.stringify({ type: 'yuri:notification-admitted', properties: value }) })!;
function setup() {
  let selected: NotificationScope | null = scope, language: NotificationLanguage = 'en', active = true, settings: NotificationPreferences | null = { nativeNotificationsEnabled: true, notifyOnSubtasks: true };
  let sessions: readonly Session[] = [{ id: 'root', directory: '/project', updated: 1, title: 'Root' }];
  let catalog: { target: NotificationTarget; projectID?: string }[] | null = null, fail = false, stale = false, requests = 0;
  const delivered: NotificationLiveEvent[] = [], errors: string[] = [];
  const lookup = notificationSessionLookup(async path => { requests++; if (fail) throw new Error('failed'); expect(path).toBe('/api/session/child?directory=%2Fproject'); return { data: { id: 'child', location: { directory: '/project' }, parentID: 'root' } }; });
  const resolve = createNotificationAdmissionResolver({ sessions: () => sessions, lookup, catalog: target => catalog ?? [{ target, projectID: 'project' }] });
  const admission = createNotificationGlobalAdmission({ scope: () => selected, language: () => language, active: () => active, settings: () => settings, resolve,
    deliver: async value => { if (fail) throw new Error('failed'); if (stale) return 'stale'; delivered.push(value); return 'suppressed'; }, error: value => errors.push(value) });
  return { admission, delivered, errors, requests: () => requests,
    settings: (value: NotificationPreferences | null) => { settings = value; }, scope: (value: NotificationScope | null) => { selected = value; },
    language: (value: NotificationLanguage) => { language = value; }, active: (value: boolean) => { active = value; }, fail: (value: boolean) => { fail = value; }, stale: (value: boolean) => { stale = value; },
    catalog: (value: NonNullable<typeof catalog>) => { catalog = value; }, sessions: (value: readonly Session[]) => { sessions = value; } };
}

it('admits all eight producer proofs through one sink; child lookup is authoritative and no content is forwarded', async () => {
  const s = setup();
  const values = [session('completion'), session('subtask'), session('error'), session('question'), session('permission'), session('goal'), assistant(), schedule()];
  for (const value of values) s.admission.onEvent(event(value), scope);
  await tick();
  expect(s.delivered.map(value => value.kind).sort()).toEqual(values.map(value => value.kind).sort());
  expect(s.requests()).toBe(1); expect(s.errors).toEqual([]);
  expect(s.delivered.every(value => Object.keys(value).sort().join(',') === 'eventID,kind,origin,scope,target')).toBe(true);
  expect(JSON.stringify(s.delivered)).not.toMatch(/directory|parentID|publication|trigger|body|token/);
});

it('does zero work for 500 raw tokens/old terminals and deduplicates admitted turns/runs across replay and language refresh', async () => {
  const s = setup();
  for (let n = 0; n < 500; n++) s.admission.onEvent({ key: 'global', type: 'session.text.delta', body: {}, directory: '' }, scope);
  s.admission.onEvent({ key: 'global', type: 'session.execution.succeeded', id: 'old', body: { sessionID: 'root' }, directory: '/project' }, scope);
  expect(s.requests()).toBe(0); expect(s.delivered).toEqual([]);
  const value = schedule(); for (let n = 0; n < 100; n++) s.admission.onEvent(event(value), scope);
  await tick(); expect(s.delivered).toHaveLength(1);
  s.language('ja'); await s.admission.retry(); s.admission.onEvent(event(value), scope); await tick(); expect(s.delivered).toHaveLength(1);
  s.admission.onEvent(event(schedule('next-run')), scope); await tick(); expect(s.delivered).toHaveLength(2);
});

it('preserves failed and stale delivery for explicit/reconnect retry without marking unknown settings as success', async () => {
  const s = setup(); s.settings(null); s.admission.onEvent(event(session('subtask')), scope); await tick(); expect(s.requests()).toBe(0);
  s.settings({ nativeNotificationsEnabled: true, notifyOnSubtasks: true }); s.fail(true); await s.admission.retry(); expect(s.errors).toEqual(['readFailed']);
  s.fail(false); s.stale(true); await s.admission.retry(); expect(s.delivered).toEqual([]);
  s.stale(false); s.admission.onEvent({ key: 'global', type: 'reconnected', body: {}, directory: '' }, scope); await tick();
  expect(s.delivered).toHaveLength(1); await s.admission.retry(); expect(s.delivered).toHaveLength(1);
});

it('refuses ambiguous session directories and same task IDs across projects, keeping retryable prior state', async () => {
  const s = setup(); s.sessions([{ id: 'root', directory: '/project', title: 'A', updated: 1 }, { id: 'root', directory: '/other', title: 'B', updated: 1 }]);
  s.admission.onEvent(event(session('question')), scope); await tick(); expect(s.delivered).toEqual([]); expect(s.requests()).toBe(0);
  s.catalog([{ projectID: 'project-a', target: { kind: 'schedule', id: 'task' } }, { projectID: 'project-b', target: { kind: 'schedule', id: 'task' } }]);
  s.admission.onEvent(event(schedule()), scope); await tick(); expect(s.delivered).toEqual([]);
  s.catalog([{ target: { kind: 'schedule', id: 'task' }, projectID: 'other-project' }]); await s.admission.retry(); expect(s.delivered).toEqual([]);
  s.catalog([{ target: { kind: 'schedule', id: 'task' }, projectID: 'project' }]); await s.admission.retry(); expect(s.delivered).toHaveLength(1); expect(s.errors).toContain('unavailable');
});

it('isolates Host/generation/lifecycle and settings gates and drops late lookups after dispose', async () => {
  const s = setup(); s.settings({ nativeNotificationsEnabled: true, notifyOnAssistants: false }); s.admission.onEvent(event(assistant()), scope); await tick(); expect(s.delivered).toEqual([]);
  s.active(false); s.admission.onEvent(event(schedule()), scope); await tick(); expect(s.delivered).toEqual([]);
  s.active(true); const next = { ...scope, generation: 2 }; s.scope(next); s.admission.onEvent(event(schedule()), scope); await tick(); expect(s.delivered).toEqual([]);
  s.admission.onEvent(event(schedule()), next); await tick(); expect(s.delivered).toHaveLength(1); expect(s.delivered[0].scope).toEqual(next);
  let finish!: (value: readonly { kind: 'assistant'; id: string }[]) => void;
  const delayed = createNotificationGlobalAdmission({ scope: () => scope, active: () => true, language: () => 'en', settings: () => ({ nativeNotificationsEnabled: true }),
    resolve: () => new Promise(done => { finish = done; }), deliver: async () => { throw new Error('Must never deliver'); }, error: () => { throw new Error('Must not publish stale error'); } });
  delayed.onEvent(event(assistant()), scope); await tick(); delayed.dispose(); finish([{ kind: 'assistant', id: 'bot' }]); await tick();
});

it('does not interpret malformed child/session reads as authoritative empty success', async () => {
  for (const value of [null, { error: 'failed' }, { data: { id: 'other', directory: '/project' } }, { data: { id: 'child', directory: '/other' } }, { data: { id: 'child', directory: '/project', parentID: 3 } }]) {
    await expect(notificationSessionLookup(async () => value)('child', '/project', () => true)).rejects.toThrow();
  }
});

it('looks up an uncataloged tap by exact ID without inventing a directory, fencing the returned identity', async () => {
  const paths: string[] = [];
  const lookup = notificationSessionLookup(async path => { paths.push(path); return { data: { id: 'child', directory: '/actual', parentID: 'root' } }; });
  expect(await lookup('child', null, () => true)).toEqual([{ id: 'child', directory: '/actual', parentID: 'root', title: 'child', updated: 0 }]);
  expect(paths).toEqual(['/api/session/child']);
  await expect(lookup('child', '/guessed', () => true)).rejects.toThrow();
});

it('bounds unknown-setting pending work to 256 and retries it after language refresh without treating it as success', async () => {
  const s = setup(); s.settings(null);
  for (let n = 0; n < 300; n++) s.admission.onEvent(event(schedule(`run-${n}`)), scope);
  await s.admission.retry(); expect(s.delivered).toEqual([]);
  s.language('uk'); s.settings({ nativeNotificationsEnabled: true }); await s.admission.retry();
  expect(s.delivered).toHaveLength(256);
  expect(s.delivered[0].eventID).toBe(schedule('run-44').eventID);
  await s.admission.retry(); expect(s.delivered).toHaveLength(256);
});

it('limits resolution to two flights and keeps a failed entity retryable without blocking other entities', async () => {
  let live = 0, peak = 0;
  const finishes: (() => void)[] = [], delivered: string[] = [];
  const admission = createNotificationGlobalAdmission({ scope: () => scope, active: () => true, language: () => 'en', settings: () => ({ nativeNotificationsEnabled: true }),
    resolve: async value => { live++; peak = Math.max(peak, live); await new Promise<void>(done => finishes.push(done)); live--; if (value.eventID === schedule('failed').eventID) throw new Error('unavailable'); return [value.target]; },
    deliver: async value => { delivered.push(value.eventID); return 'scheduled'; }, error: () => {} });
  for (const id of ['first', 'failed', 'last']) admission.onEvent(event(schedule(id)), scope);
  await tick(); finishes.shift()!(); await tick();
  expect(peak).toBe(2);
  finishes.shift()!(); await tick(); finishes.shift()!(); await tick();
  expect(delivered).toEqual([schedule('first').eventID, schedule('last').eventID]);
  // An explicit retry, not a timer, is required for the remaining failed entity.
  const retry = admission.retry(); await tick(); finishes.shift()!(); await retry;
  expect(delivered).toHaveLength(2); admission.dispose();
});
