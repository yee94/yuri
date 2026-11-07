import { expect, it } from 'vitest';
import { createNotificationRecovery, notificationRecoveryRecord, type NotificationRecoveryRecord } from './notification-global-recovery';
import { createNotificationAdmission } from '../web/server/lib/notifications/admission-event.js';

const receipt = '12345678-1234-1234-1234-123456789abc';
const record: NotificationRecoveryRecord = { v: 1, receipt, revision: 1, connectionID: 'host-a', authorizationID: 'authorization-a', admission: createNotificationAdmission('completion', { kind: 'session', id: 'session-a' }, { type: 'session', sessionID: 'session-a', directory: '/project', parentID: null, boundaryID: 'execution' })!, createdAt: 1, expiresAt: 1000 };
function setup() {
  let scope = { connectionID: 'host-a', authorizationID: 'authorization-a', generation: 2 }, value: unknown = record, count = 1, fail = false, consumed = false;
  const opened: string[] = [];
  const recovery = createNotificationRecovery({ scope: () => scope, now: () => 100,
    read: async () => { if (fail) throw new Error('secure storage failure'); return consumed ? null : value; },
    consume: async (_receipt, revision) => { expect(revision).toBe(1); if (fail) throw new Error('secure storage failure'); consumed = true; return true; },
    resolve: admission => Array.from({ length: count }, () => admission.target.id), open: (destination, current) => { if (current()) opened.push(destination); } });
  return { recovery, opened, scope: (next: typeof scope) => { scope = next; }, record: (next: unknown) => { value = next; }, count: (next: number) => { count = next; }, fail: (next: boolean) => { fail = next; } };
}
it('routes only a current native-protected receipt and consumes with CAS, never OS-supplied target/Host/URL', async () => {
  const s = setup(); expect(await s.recovery.route({ v: 1, receipt })).toBe('opened'); expect(s.opened).toEqual(['session-a']);
  expect(await s.recovery.route({ v: 1, receipt })).toBe('unavailable');
  for (const input of [{ v: 1, receipt, target: record.admission.target }, { v: 1, receipt, hostID: 'other' }, { v: 1, receipt, url: 'https://outside.invalid' }, { v: 1, receipt: 'unknown' }]) expect(await s.recovery.route(input)).toBe('unavailable');
});
it('fails closed on unknown, expired, reauthorized, wrong-Host and ambiguous records without auto-switching', async () => {
  for (const value of [null, { ...record, expiresAt: 99 }, { ...record, createdAt: 101 }, { ...record, expiresAt: 1e20 }, { ...record, authorizationID: 'legacy' }, { ...record, authorizationID: 'other' }, { ...record, connectionID: 'other' }, { ...record, token: 'excluded' }, { ...record, revision: 0 }]) {
    const s = setup(); s.record(value); expect(await s.recovery.route({ v: 1, receipt })).toBe('unavailable'); expect(s.opened).toEqual([]);
  }
  const s = setup(); s.count(2); expect(await s.recovery.route({ v: 1, receipt })).toBe('unavailable'); expect(s.opened).toEqual([]);
  s.count(1); s.fail(true); expect(await s.recovery.route({ v: 1, receipt })).toBe('unavailable'); s.fail(false);
  expect(await s.recovery.route({ v: 1, receipt })).toBe('opened');
  expect(notificationRecoveryRecord({ ...record, admission: { ...record.admission, target: { ...record.admission.target, directory: '/private' } } })).toBeNull();
});
it('coalesces duplicate taps and fences asynchronous lookup after Host generation or authorization changes', async () => {
  let finish!: (value: string[]) => void, generation = 1, opens = 0, reads = 0;
  const recovery = createNotificationRecovery({ scope: () => ({ connectionID: 'host-a', authorizationID: 'authorization-a', generation }), now: () => 100,
    read: async () => { reads++; return record; }, consume: async () => true, resolve: () => new Promise<string[]>(done => { finish = done; }), open: () => { opens++; } });
  const first = recovery.route({ v: 1, receipt }), duplicate = recovery.route({ v: 1, receipt });
  await Promise.resolve(); generation++; finish(['session-a']);
  expect(await first).toBe('stale'); expect(await duplicate).toBe('stale'); expect(opens).toBe(0); expect(reads).toBe(1);
});
it('retains the protected receipt on CAS failure without reopening, and rejects retargeting of the same receipt', async () => {
  let stored = record, allowConsume = false, opens = 0;
  const recovery = createNotificationRecovery({ scope: () => ({ connectionID: 'host-a', authorizationID: 'authorization-a', generation: 1 }), now: () => 100,
    read: async () => stored, consume: async () => allowConsume, resolve: admission => [admission.target.id], open: () => { opens++; } });
  expect(await recovery.route({ v: 1, receipt })).toBe('unavailable'); expect(opens).toBe(1);
  allowConsume = true; expect(await recovery.route({ v: 1, receipt })).toBe('opened'); expect(opens).toBe(1);
  stored = { ...record, revision: 2 }; expect(await recovery.route({ v: 1, receipt })).toBe('unavailable'); expect(opens).toBe(1);
});
it('rechecks expiry and native authorization after deferred identity resolution', async () => {
  for (const change of ['expiry', 'authorization'] as const) {
    let now = 100, authorizationID = 'authorization-a', finish!: (value: string[]) => void, opened = false;
    const recovery = createNotificationRecovery({ scope: () => ({ connectionID: 'host-a', authorizationID, generation: 1 }), now: () => now,
      read: async () => record, consume: async () => true, resolve: () => new Promise<string[]>(done => { finish = done; }), open: () => { opened = true; } });
    const pending = recovery.route({ v: 1, receipt }); await Promise.resolve();
    if (change === 'expiry') now = 1001; else authorizationID = 'authorization-b';
    finish(['session-a']); expect(await pending).toBe('stale'); expect(opened).toBe(false);
  }
});
