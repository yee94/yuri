import { expect, it, vi } from 'vitest';
import { createNotificationLaunchTransport, type NotificationLaunchScope } from './notification-launch-transport';
import { createNotificationRecovery } from './notification-global-recovery';
import { notificationTarget } from './notification-core';

const receipt = '12345678-1234-1234-1234-123456789abc';
const admission = { v: 1, kind: 'completion', eventID: 'admitted_completion_9_session-a_5_event', target: { kind: 'session', id: 'session-a' },
  source: { type: 'session', sessionID: 'session-a', directory: '/workspace/a', parentID: null, boundaryID: 'event' } };
const record = { v: 1, receipt, revision: 1, connectionID: 'host-a', authorizationID: 'authorization-a', admission, createdAt: 100, expiresAt: 200 };
function fixture() {
  let scope: NotificationLaunchScope | null = null, lease = 'lease-a', ackFails = false, stored: unknown = record;
  const call = vi.fn(async (name: string, _body?: Record<string, unknown>): Promise<unknown> => {
    if (name === 'notification.launch.peek') return { record: stored };
    if (name === 'notification.launch.claim') return { record: stored, route: { hostID: 'host-a', lease, target: admission.target } };
    if (name === 'notification.launch.ack') { if (ackFails) throw new Error('synthetic'); stored = null; return { ok: true }; }
    throw new Error('unexpected');
  });
  const transport = createNotificationLaunchTransport({ call, scope: () => scope, validateRoute: value => {
    const route = value as { hostID?: unknown; lease?: unknown; target?: unknown } | null;
    return route?.hostID === scope?.connectionID && route?.lease === lease ? notificationTarget(route?.target) : null;
  } });
  return { call, transport, scope: () => scope, connect: () => { scope = { connectionID: 'host-a', authorizationID: 'authorization-a', generation: 1 }; },
    setScope: (next: NotificationLaunchScope | null) => { scope = next; }, setLease: (value: string) => { lease = value; },
    failAck: (value: boolean) => { ackFails = value; }, setRecord: (value: unknown) => { stored = value; } };
}
it('keeps the same inbox visible before local Host scope exists; no claim/consume or Host guessing', async () => {
  const f = fixture(); expect(await f.transport.peek()).toEqual(record);
  await expect(f.transport.read(receipt)).rejects.toThrow('notification_stale');
  expect(f.call.mock.calls.map(([name]) => name)).toEqual(['notification.launch.peek']);
  f.connect(); expect(await f.transport.read(receipt)).toEqual(record);
  expect(await f.transport.consume(receipt, 1)).toBe(true); expect(await f.transport.peek()).toBeNull();
});
it('requires native current connection+authorization identity and does not substitute another Host', async () => {
  for (const change of [{ connectionID: 'host-b', authorizationID: 'authorization-a', generation: 1 }, { connectionID: 'host-a', authorizationID: 'authorization-b', generation: 1 }]) {
    const f = fixture(); f.setScope(change); await expect(f.transport.read(receipt)).rejects.toThrow();
    expect(await f.transport.consume(receipt, 1)).toBe(false);
  }
});
it('rejects target-only/legacy/unknown records rather than falling back to current Host', async () => {
  for (const value of [{ sessionId: 'session-a' }, { receipt, hostID: 'host-a', target: admission.target },
    { ...record, authorizationID: 'legacy' }, { ...record, url: 'https://example.invalid' }, { ...record, expiresAt: record.createdAt + 8 * 86400000 }]) {
    const f = fixture(); f.setRecord(value); await expect(f.transport.peek()).rejects.toThrow('notification_invalid');
  }
});
it('fences claim replies when generation changes during await', async () => {
  const f = fixture(); f.connect(); let finish!: (value: unknown) => void;
  f.call.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const work = f.transport.read(receipt); f.setScope({ connectionID: 'host-a', authorizationID: 'authorization-a', generation: 2 });
  finish({ record, route: { hostID: 'host-a', lease: 'lease-a', target: admission.target } });
  await expect(work).rejects.toThrow('notification_stale'); expect(await f.transport.consume(receipt, 1)).toBe(false);
});
it('CAS consumes only the claimed revision and current lease; invalidation does not delete native records', async () => {
  const f = fixture(); f.connect(); await f.transport.read(receipt);
  expect(await f.transport.consume(receipt, 2)).toBe(false);
  f.setLease('lease-new'); expect(await f.transport.consume(receipt, 1)).toBe(false);
  f.transport.invalidate(); expect(await f.transport.consume(receipt, 1)).toBe(false);
  expect(await f.transport.peek()).toEqual(record);
  await f.transport.read(receipt); expect(await f.transport.consume(receipt, 1)).toBe(true);
  expect(f.call.mock.calls.at(-1)).toEqual(['notification.launch.ack', { receipt, connectionID: 'host-a', lease: 'lease-new', expectedRevision: 1 }]);
});
it('composes the existing recovery with unique catalog lookup and retries ACK without reopening', async () => {
  const f = fixture(); f.connect(); const open = vi.fn(), resolve = vi.fn(async () => ['exact-destination']);
  const recovery = createNotificationRecovery({ scope: f.scope, now: () => 150, read: f.transport.read, consume: f.transport.consume, resolve, open });
  f.failAck(true); expect(await recovery.route({ v: 1, receipt })).toBe('unavailable'); expect(open).toHaveBeenCalledOnce();
  f.failAck(false); f.setLease('lease-new'); expect(await recovery.route({ v: 1, receipt })).toBe('opened'); expect(open).toHaveBeenCalledOnce();
  expect(resolve).toHaveBeenCalledWith(admission, expect.any(Function));
});
it('does not consume before ready/current scope, with missing/duplicate destinations or late disposal', async () => {
  for (const destinations of [[], ['a', 'b']]) {
    const f = fixture(); const open = vi.fn();
    const recovery = createNotificationRecovery({ scope: f.scope, now: () => 150, read: f.transport.read, consume: f.transport.consume, resolve: () => destinations, open });
    expect(await recovery.route({ v: 1, receipt })).toBe('stale'); expect(f.call).not.toHaveBeenCalled();
    f.connect(); expect(await recovery.route({ v: 1, receipt })).toBe('unavailable'); expect(open).not.toHaveBeenCalled();
    expect(f.call.mock.calls.map(([name]) => name)).not.toContain('notification.launch.ack');
    recovery.dispose(); f.transport.dispose(); await expect(f.transport.peek()).rejects.toThrow('notification_stale');
  }
});
it('lets the root fence navigation itself when a lease changes during authoritative catalog lookup', async () => {
  const f = fixture(); f.connect(); const opened = vi.fn(); let finish!: (value: string[]) => void;
  const resolve = vi.fn(() => new Promise<string[]>(done => { finish = done; }));
  const recovery = createNotificationRecovery({ scope: f.scope, now: () => 150, read: f.transport.read, consume: f.transport.consume, resolve,
    open: destination => { if (!f.transport.isCurrent(receipt)) throw new Error('notification_stale'); opened(destination); } });
  const work = recovery.route({ v: 1, receipt }); await vi.waitFor(() => expect(resolve).toHaveBeenCalledOnce());
  f.setLease('lease-new'); finish(['stale-destination']); expect(await work).toBe('unavailable'); expect(opened).not.toHaveBeenCalled();
  resolve.mockResolvedValueOnce(['current-destination']); expect(await recovery.route({ v: 1, receipt })).toBe('opened'); expect(opened).toHaveBeenCalledExactlyOnceWith('current-destination');
});
