import { expect, it } from 'vitest';
import { createNotificationRootController } from './notification-root-core';
import { createNotificationSettingsTransport, type NotificationPreferences } from './notification-preferences-core';
import { notificationSessionLookup, type NotificationCatalogEntry } from './notification-session-live';
import { createNotificationAdmission, type NotificationAdmission, type NotificationAdmissionKind } from '../web/server/lib/notifications/admission-event.js';
import type { NotificationLanguage, NotificationScope } from './notification-core';
import type { NotificationRecoveryRecord } from './notification-global-recovery';
import type { RuntimeEvent, Session } from './model';

const scope = { hostID: 'host-a', generation: 1 };
const receipt = '12345678-1234-1234-1234-123456789abc';
const tick = async () => { for (let n = 0; n < 150; n++) await Promise.resolve(); };
function proof(kind: NotificationAdmissionKind = 'completion', boundaryID = 'boundary'): NotificationAdmission {
  if (kind === 'assistant') return createNotificationAdmission(kind, { kind: 'assistant', id: 'bot' }, { type: 'assistant', assistantID: 'bot', turnID: boundaryID, status: 'complete', publication: 'published' })!;
  if (kind === 'schedule') return createNotificationAdmission(kind, { kind: 'schedule', id: 'task' }, { type: 'schedule', projectID: 'project', taskID: 'task', runID: boundaryID, trigger: 'scheduled', resultOwner: 'unowned', status: 'success' })!;
  const id = kind === 'subtask' ? 'child' : 'session-a';
  return createNotificationAdmission(kind, { kind: 'session', id }, { type: 'session', sessionID: id, directory: '/project', parentID: kind === 'subtask' ? 'session-a' : null, boundaryID })!;
}
const event = (admission: NotificationAdmission): RuntimeEvent => ({ key: 'global', type: 'yuri:notification-admitted', body: admission, directory: '' });
const protectedRecord = (admission = proof()): NotificationRecoveryRecord => ({ v: 1, receipt, revision: 1, connectionID: scope.hostID, authorizationID: 'authorization-a', admission, createdAt: 1, expiresAt: 10_000 });
function setup() {
  let current: NotificationScope | null = scope, language: NotificationLanguage = 'en', authorizationID: string | null = 'authorization-a';
  let rows: readonly Session[] = [{ id: 'session-a', directory: '/project', title: 'A', updated: 1 }];
  let catalog: readonly NotificationCatalogEntry[] = [{ target: { kind: 'assistant', id: 'bot' } }, { target: { kind: 'schedule', id: 'task' }, projectID: 'project' }];
  let preferences: NotificationPreferences = { nativeNotificationsEnabled: true, notifyOnSubtasks: true };
  let failRead = false, failLive = false, failLookup = false, failAck = false, catalogKnown = true, openOK = true;
  let pending: unknown = null, claimPatch: ((value: unknown) => unknown) | null = null;
  let settingsReads = 0, sessionReads = 0, indexReads = 0, awaits = 0, now = 100;
  let catalogWait: (() => Promise<void>) | null = null, resolveWait: (() => Promise<void>) | null = null;
  const calls: [string, Record<string, unknown> | undefined][] = [], opened: string[] = [];
  const call = async (name: string, body?: Record<string, unknown>): Promise<unknown> => {
    calls.push([name, body]);
    if (name === 'notification.configure') return { lease: `lease-${current?.hostID}-${current?.generation}` };
    if (name === 'notification.live') { if (failLive) throw new Error('native unavailable'); return { result: 'suppressed' }; }
    if (name === 'notification.launch.peek') return { record: pending };
    if (name === 'notification.launch.claim') {
      const response = { record: pending, route: { hostID: current?.hostID, lease: `lease-${current?.hostID}-${current?.generation}`, target: (pending as NotificationRecoveryRecord)?.admission?.target } };
      return claimPatch ? claimPatch(response) : response;
    }
    if (name === 'notification.launch.ack') { if (failAck) return { ok: false }; pending = null; return { ok: true }; }
    throw new Error('Unexpected native call');
  };
  const transport = createNotificationSettingsTransport({ scope: () => current, language: () => language, call,
    read: async () => { settingsReads++; if (failRead) throw new Error('read failed'); return preferences; }, write: async () => true });
  const lookup = notificationSessionLookup(async path => { sessionReads++; if (failLookup) throw new Error('metadata failed');
    expect(path).toBe('/api/session/child?directory=%2Fproject'); return { data: { id: 'child', directory: '/project', parentID: 'session-a' } }; });
  const controller = createNotificationRootController({ transport, scope: () => current, authorizationID: () => authorizationID, now: () => now, call,
    sessions: () => { indexReads++; return rows; }, lookup,
    catalog: () => catalog,
    catalogReady: async valid => { awaits++; if (catalogWait) await catalogWait(); if (!valid()) return; if (!catalogKnown) throw new Error('catalog unknown'); },
    resolve: async identity => { if (resolveWait) await resolveWait(); return [identity.kind === 'session' ? `${identity.kind}:${identity.session.id}:${identity.session.directory}` : `${identity.kind}:${identity.id}`]; },
    open: (destination, valid) => { if (!openOK || !valid()) return false; opened.push(destination); return true; }, changed: () => {},
  });
  return { controller, transport, calls, opened, counts: () => ({ settingsReads, sessionReads, indexReads, awaits }),
    scope: (value: NotificationScope | null) => { current = value; }, language: (value: NotificationLanguage) => { language = value; }, auth: (value: string | null) => { authorizationID = value; },
    rows: (value: readonly Session[]) => { rows = value; }, catalog: (value: readonly NotificationCatalogEntry[]) => { catalog = value; },
    preferences: (value: NotificationPreferences) => { preferences = value; }, failRead: (value: boolean) => { failRead = value; }, failLive: (value: boolean) => { failLive = value; }, failLookup: (value: boolean) => { failLookup = value; },
    failAck: (value: boolean) => { failAck = value; }, catalogKnown: (value: boolean) => { catalogKnown = value; }, openOK: (value: boolean) => { openOK = value; },
    pending: (value: unknown) => { pending = value; }, claimPatch: (value: typeof claimPatch) => { claimPatch = value; }, now: (value: number) => { now = value; },
    catalogWait: (value: typeof catalogWait) => { catalogWait = value; }, resolveWait: (value: typeof resolveWait) => { resolveWait = value; },
  };
}
const lives = (s: ReturnType<typeof setup>) => s.calls.filter(([name]) => name === 'notification.live').map(([, body]) => body!);

it('production controller uses only the admitted sink, does zero token/raw work, and forwards full exact proof through native live', async () => {
  const s = setup(); s.controller.bind(scope, 'en', true); await tick();
  expect(s.controller.state().ready).toBe(true); const before = s.counts();
  for (let n = 0; n < 500; n++) for (const type of ['session.text.delta', 'session.execution.succeeded', 'session.idle', 'yuri:contact-turn-end', 'yuri:contact-bubble-delta', 'yuri:scheduled-task-ran'])
    s.controller.onEvent({ key: 'global', type, body: { sessionID: 'session-a', status: 'success' }, id: `raw-${n}`, directory: '/project' }, scope);
  expect(s.counts()).toEqual(before); expect(lives(s)).toEqual([]);
  for (const kind of ['completion', 'subtask', 'error', 'question', 'permission', 'goal', 'assistant', 'schedule'] as const) s.controller.onEvent(event(proof(kind)), scope);
  await tick();
  expect(lives(s).map(body => body.kind).sort()).toEqual(['completion', 'subtask', 'error', 'question', 'permission', 'goal', 'assistant', 'schedule'].sort());
  expect(s.counts().sessionReads).toBe(1); expect(s.opened).toEqual([]);
  for (const body of lives(s)) expect(body).toEqual({ lease: 'lease-host-a-1', eventID: proof(body.kind as NotificationAdmissionKind).eventID, kind: body.kind, target: proof(body.kind as NotificationAdmissionKind).target, admission: proof(body.kind as NotificationAdmissionKind) });
});

it('uses exact missing-child metadata, rejects failed/duplicate identity, and retries pending without erasing successful entities', async () => {
  const s = setup(); s.controller.bind(scope, 'en', true); await tick(); s.failLookup(true);
  s.controller.onEvent(event(proof('subtask')), scope); s.controller.onEvent(event(proof('error')), scope); await tick();
  expect(lives(s).map(body => body.kind)).toEqual(['error']); expect(s.controller.state().error).toBe('readFailed');
  s.failLookup(false); await s.controller.refresh(); expect(lives(s).map(body => body.kind)).toEqual(['error', 'subtask']);
  s.rows([{ id: 'child', directory: '/project', title: 'C', updated: 1, parentID: 'session-a' }, { id: 'child', directory: '/other', title: 'D', updated: 1 }]);
  const reads = s.counts().sessionReads; s.controller.onEvent(event(proof('subtask', 'duplicate')), scope); await tick();
  expect(s.counts().sessionReads).toBe(reads); expect(lives(s)).toHaveLength(2); expect(s.controller.state().error).toBe('unavailable');
});

it('checks task-ID uniqueness in the whole catalog before project proof, for both live and cold navigation', async () => {
  const s = setup(); s.controller.bind(scope, 'en', true); await tick();
  s.catalog([{ target: { kind: 'schedule', id: 'task' }, projectID: 'project' }, { target: { kind: 'schedule', id: 'task' }, projectID: 'other' }]);
  s.controller.onEvent(event(proof('schedule')), scope); await tick(); expect(lives(s)).toEqual([]);
  s.pending(protectedRecord(proof('schedule'))); await s.controller.route({ v: 1, receipt }); expect(s.opened).toEqual([]);
  expect(s.calls.filter(([name]) => name === 'notification.launch.ack')).toEqual([]);
  s.catalog([{ target: { kind: 'schedule', id: 'unrelated' }, projectID: 'other' }, { target: { kind: 'schedule', id: 'task' }, projectID: 'wrong-project' }]);
  await s.controller.refresh(); expect(lives(s)).toEqual([]); expect(s.opened).toEqual([]);
  s.catalog([{ target: { kind: 'schedule', id: 'task' }, projectID: 'project' }]); await s.controller.refresh();
  expect(lives(s)).toHaveLength(1); expect(s.opened).toEqual(['schedule:task']);
});

it('preserves preference receipt authority, independent flags, Basic confirmation and unknown/read-failure retry', async () => {
  const fields = ['notifyOnCompletion', 'notifyOnSubtasks', 'notifyOnError', 'notifyOnQuestion', 'notifyOnPermission', 'notifyOnGoals', 'notifyOnAssistants', 'notifyOnScheduledTasks'] as const;
  const kinds = ['completion', 'subtask', 'error', 'question', 'permission', 'goal', 'assistant', 'schedule'] as const;
  for (let i = 0; i < kinds.length; i++) {
    const s = setup(); s.preferences({ nativeNotificationsEnabled: true, ...Object.fromEntries(fields.map(field => [field, false])), [fields[i]]: true });
    s.controller.bind(scope, 'en', true); await tick();
    for (const kind of kinds) s.controller.onEvent(event(proof(kind)), scope); await tick();
    expect(lives(s).map(body => body.kind)).toEqual([kinds[i]]); s.controller.dispose();
  }
  const s = setup(); s.failRead(true); s.controller.bind(scope, 'en', true); await tick();
  s.controller.onEvent(event(proof()), scope); await tick(); expect(lives(s)).toEqual([]);
  s.failRead(false); await s.transport.refresh(); await tick(); expect(lives(s)).toHaveLength(1);
  s.failRead(true); s.controller.onEvent({ key: 'global', type: 'reconnected', body: {}, directory: '' }, scope); await tick();
  expect(s.controller.state()).toMatchObject({ ready: true, error: 'readFailed' });
  s.controller.onEvent(event(proof('error')), scope); await tick(); expect(lives(s)).toHaveLength(2);
  await expect(s.transport.synchronize(Object.freeze({ nativeNotificationsEnabled: false }))).rejects.toThrow('notification_stale');
});

it('fences Host/generation/authorization/active transitions and ignores stale or malformed proofs', async () => {
  for (const change of ['host', 'authorization', 'pause'] as const) {
    const s = setup(); s.controller.bind(scope, 'en', true); await tick(); let finish!: () => void;
    const gate = new Promise<void>(done => { finish = done; });
    s.catalogWait(() => gate); s.controller.onEvent(event(proof()), scope); await tick();
    if (change === 'host') { const next = { hostID: 'host-b', generation: 2 }; s.scope(next); s.controller.bind(next, 'en', true); }
    if (change === 'authorization') { s.auth('authorization-b'); s.controller.bind(scope, 'en', true); }
    if (change === 'pause') s.controller.bind(scope, 'en', false);
    s.controller.dispose(); finish(); await tick(); expect(lives(s)).toEqual([]);
  }
  const s = setup(); s.controller.bind(scope, 'en', true); await tick();
  s.controller.onEvent(event(proof()), { ...scope, generation: 0 });
  s.controller.onEvent({ ...event(proof()), body: { ...proof(), body: 'Private' } }, scope); await tick(); expect(lives(s)).toEqual([]);
});

it('deduplicates across language refresh and retries native failures only at explicit/confirmation/reconnect boundaries', async () => {
  const s = setup(); s.controller.bind(scope, 'en', true); await tick(); s.failLive(true);
  s.controller.onEvent(event(proof()), scope); await tick(); expect(lives(s)).toHaveLength(1);
  s.failLive(false); s.controller.onEvent({ key: 'global', type: 'server.connected', body: {}, directory: '' }, scope); await tick();
  expect(lives(s)).toHaveLength(2);
  s.language('ja'); s.controller.bind(scope, 'ja', true); await tick(); s.controller.onEvent(event(proof()), scope); await tick(); expect(lives(s)).toHaveLength(2);
});

it('waits for scope/configuration and actual catalog await before claim; cold open uses full proof then revision CAS', async () => {
  const s = setup(); s.pending(protectedRecord(proof('subtask')));
  await s.controller.route({ v: 1, receipt }); expect(s.calls).toEqual([]);
  let finish!: () => void; s.catalogWait(() => new Promise<void>(done => { finish = done; }));
  s.controller.bind(scope, 'en', true); await tick(); expect(s.calls.some(([name]) => name === 'notification.launch.claim')).toBe(false);
  s.catalogWait(null); finish(); await tick();
  expect(s.opened).toEqual(['session:child:/project']);
  expect(s.calls.find(([name]) => name === 'notification.launch.claim')?.[1]).toEqual({ connectionID: 'host-a', receipt });
  expect(s.calls.find(([name]) => name === 'notification.launch.ack')?.[1]).toEqual({ connectionID: 'host-a', receipt, lease: 'lease-host-a-1', expectedRevision: 1 });
});

it('does not peek or claim with missing/legacy authorization, nor accept target-only launch or OS target overrides', async () => {
  for (const binding of [null, 'legacy']) {
    const s = setup(); s.auth(binding); s.pending(protectedRecord()); s.controller.bind(scope, 'en', true); await tick(); await s.controller.route({ v: 1, receipt });
    expect(s.controller.state()).toMatchObject({ recovery: 'unsupported', error: 'unsupported' }); expect(s.calls.some(([name]) => name.startsWith('notification.launch.'))).toBe(false);
  }
  const s = setup(); s.controller.bind(scope, 'en', true); await tick();
  s.pending({ receipt, hostID: 'host-a', target: proof().target }); await s.controller.route({ v: 1, receipt }); expect(s.opened).toEqual([]);
  s.pending(protectedRecord()); await s.controller.route({ v: 1, receipt, target: proof().target }); expect(s.opened).toEqual([]);
  s.claimPatch(() => ({ hostID: 'host-a', lease: 'lease-host-a-1', target: proof().target })); await s.controller.route({ v: 1, receipt }); expect(s.opened).toEqual([]);
});

it('refuses wrong Host/authorization/expiry, changed claim, stale lease and partial catalog without consuming or Host switching', async () => {
  for (const patch of [{ connectionID: 'other' }, { authorizationID: 'other' }, { expiresAt: 99 }]) {
    const s = setup(); s.controller.bind(scope, 'en', true); await tick(); s.pending({ ...protectedRecord(), ...patch }); await s.controller.route({ v: 1, receipt });
    expect(s.opened).toEqual([]); expect(s.calls.some(([name]) => name === 'notification.launch.claim')).toBe(false);
  }
  for (const mutate of [(value: unknown) => ({ ...(value as object), record: { ...protectedRecord(), revision: 2 } }), (value: unknown) => ({ ...(value as object), route: { hostID: 'host-a', lease: 'old', target: proof().target } })]) {
    const s = setup(); s.controller.bind(scope, 'en', true); await tick(); s.pending(protectedRecord()); s.claimPatch(mutate);
    await s.controller.route({ v: 1, receipt }); expect(s.opened).toEqual([]); expect(s.calls.some(([name]) => name === 'notification.launch.ack')).toBe(false);
  }
  const s = setup(); s.controller.bind(scope, 'en', true); await tick(); s.catalogKnown(false); s.pending(protectedRecord()); await s.controller.route({ v: 1, receipt });
  expect(s.opened).toEqual([]); expect(s.calls.some(([name]) => name === 'notification.launch.claim')).toBe(false);
});

it('retains failed CAS/open for retry without duplicate navigation and fences lease/TTL while resolve is deferred', async () => {
  const s = setup(); s.controller.bind(scope, 'en', true); await tick(); s.pending(protectedRecord()); s.failAck(true);
  await s.controller.route({ v: 1, receipt }); expect(s.opened).toHaveLength(1);
  s.failAck(false); await s.controller.recover(); expect(s.opened).toHaveLength(1); expect(s.controller.state().recovery).toBe('opened');
  const unopened = setup(); unopened.controller.bind(scope, 'en', true); await tick(); unopened.pending(protectedRecord()); unopened.openOK(false);
  await unopened.controller.route({ v: 1, receipt }); expect(unopened.opened).toEqual([]); expect(unopened.calls.some(([name]) => name === 'notification.launch.ack')).toBe(false);
  unopened.openOK(true); await unopened.controller.recover(); expect(unopened.opened).toHaveLength(1);
  for (const change of ['expiry', 'lease', 'active'] as const) {
    const f = setup(); f.controller.bind(scope, 'en', true); await tick(); f.pending(protectedRecord()); let finish!: () => void;
    f.resolveWait(() => new Promise<void>(done => { finish = done; })); const work = f.controller.route({ v: 1, receipt }); await tick();
    if (change === 'expiry') f.now(10_001);
    if (change === 'lease') f.transport.delivery.invalidate();
    if (change === 'active') f.controller.bind(scope, 'en', false);
    finish(); await work; expect(f.opened).toEqual([]); expect(f.calls.some(([name]) => name === 'notification.launch.ack')).toBe(false);
  }
});

it('indexes a stable 1001-session catalog once for 50 admitted boundaries, never on token or preference reads', async () => {
  const s = setup(); let iterations = 0;
  const rows: Session[] = [{ id: 'session-a', directory: '/project', title: 'A', updated: 1 }, ...Array.from({ length: 1000 }, (_, n) => ({ id: `other-${n}`, directory: '/other', title: 'Other', updated: 1 }))];
  s.rows(new Proxy(rows, { get(target, key, receiver) { if (key === Symbol.iterator) iterations++; return Reflect.get(target, key, receiver); } }));
  s.controller.bind(scope, 'en', true); await tick();
  for (let n = 0; n < 50; n++) s.controller.onEvent(event(proof('completion', `boundary-${n}`)), scope);
  await s.controller.refresh(); expect(lives(s)).toHaveLength(50); expect(iterations).toBe(1); expect(s.counts().sessionReads).toBe(0);
});

it('retires the old active flight across pause/resume and delivers retained proof only once after real readiness returns', async () => {
  const s = setup(); s.controller.bind(scope, 'en', true); await tick(); let finish!: () => void;
  const gate = new Promise<void>(done => { finish = done; }); s.catalogWait(() => gate);
  s.controller.onEvent(event(proof()), scope); await tick(); s.controller.bind(scope, 'en', false);
  finish(); await tick(); expect(lives(s)).toEqual([]);
  s.catalogWait(null); s.controller.bind(scope, 'en', true); await tick(); expect(lives(s)).toHaveLength(1);
});

it('a new native receipt hint invalidates old same-scope navigation while lookup is in flight, then resolves only the newest receipt', async () => {
  const s = setup(); s.controller.bind(scope, 'en', true); await tick();
  s.pending(protectedRecord()); let finish!: () => void;
  const gate = new Promise<void>(done => { finish = done; }); s.resolveWait(() => gate);
  const first = s.controller.route({ v: 1, receipt }); await tick();
  const nextReceipt = '12345678-1234-1234-1234-123456789abd';
  s.pending({ ...protectedRecord(proof('assistant')), receipt: nextReceipt });
  void s.controller.recover(); s.resolveWait(null); finish(); await first; await tick();
  expect(s.opened).toEqual(['assistant:bot']);
  expect(s.calls.filter(([name]) => name === 'notification.launch.ack').map(([, body]) => body?.receipt)).toEqual([nextReceipt]);
});

it('live admission without a genuine authorization binding stays pending and never calls native with a fabricated binding', async () => {
  const s = setup(); s.auth(null); s.controller.bind(scope, 'en', true); await tick();
  s.controller.onEvent(event(proof()), scope); await tick();
  expect(lives(s)).toEqual([]); expect(s.controller.state().error).toBe('unsupported');
  s.auth('authorization-a'); s.controller.bind(scope, 'en', true); await tick();
  // An authorization replacement retires events admitted under the former unknown authority.
  expect(lives(s)).toEqual([]);
  s.controller.onEvent(event(proof()), scope); await tick(); expect(lives(s)).toHaveLength(1);
});
