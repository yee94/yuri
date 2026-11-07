import { notificationIdentifier, notificationTarget, type NotificationCall, type NotificationTarget } from './notification-core';
import { notificationRecoveryRecord, type NotificationRecoveryRecord } from './notification-global-recovery';

export type NotificationLaunchScope = { connectionID: string; authorizationID: string; generation: number };
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const same = (a: NotificationLaunchScope, b: NotificationLaunchScope | null) => !!b && a.connectionID === b.connectionID && a.authorizationID === b.authorizationID && a.generation === b.generation;

/** Adapter for the existing createNotificationRecovery, NOT a second queue or JS notification handler.
 * peek may run before Host restoration. read/consume require the root's real native lease and scope.
 * The root owns readiness, catalog resolution and its one notification.launch.available subscription.
 * No permission, Host switching, OS notifications, timer, history read, or APNs registration here.
 */
export function createNotificationLaunchTransport(input: {
  call: NotificationCall;
  scope: () => NotificationLaunchScope | null;
  validateRoute: (value: unknown) => NotificationTarget | null;
}) {
  let alive = true, revision = 0;
  const claims = new Map<string, { revision: number; scope: NotificationLaunchScope; lease: string; route: unknown }>();
  const current = (scope: NotificationLaunchScope, turn: number) => alive && turn === revision && same(scope, input.scope());
  return {
    isCurrent(receipt: string): boolean {
      const claim = claims.get(receipt);
      return !!claim && current(claim.scope, revision) && !!input.validateRoute(claim.route);
    },
    async peek(): Promise<NotificationRecoveryRecord | null> {
      if (!alive) throw new Error('notification_stale');
      const value = object(await input.call('notification.launch.peek', {}));
      if (!alive) throw new Error('notification_stale');
      if (!value || Object.keys(value).join(',') !== 'record') throw new Error('notification_invalid');
      if (value.record === null) return null;
      const record = notificationRecoveryRecord(value.record);
      if (!record) throw new Error('notification_invalid');
      return record;
    },
    async read(receipt: string): Promise<NotificationRecoveryRecord> {
      const scope = input.scope(), turn = revision;
      if (!alive || !scope || !notificationIdentifier(scope.authorizationID) || scope.authorizationID === 'legacy') throw new Error('notification_stale');
      const captured = { ...scope };
      const value = object(await input.call('notification.launch.claim', { receipt, connectionID: captured.connectionID }));
      if (!current(captured, turn)) throw new Error('notification_stale');
      const record = notificationRecoveryRecord(value?.record), route = object(value?.route), target = input.validateRoute(route);
      if (!value || Object.keys(value).sort().join(',') !== 'record,route' || !record || record.receipt !== receipt
        || record.connectionID !== captured.connectionID || record.authorizationID !== captured.authorizationID
        || !route || Object.keys(route).sort().join(',') !== 'hostID,lease,target' || route.hostID !== captured.connectionID
        || !notificationIdentifier(route.lease) || !target || !notificationTarget(route.target)
        || target.kind !== record.admission.target.kind || target.id !== record.admission.target.id) throw new Error('notification_invalid');
      if (!claims.has(receipt) && claims.size >= 16) throw new Error('notification_unavailable');
      claims.set(receipt, { revision: record.revision, scope: captured, lease: route.lease, route });
      return record;
    },
    async consume(receipt: string, expectedRevision: number): Promise<boolean> {
      const claim = claims.get(receipt), turn = revision;
      if (!claim || expectedRevision !== claim.revision || !current(claim.scope, turn) || !input.validateRoute(claim.route)) return false;
      const value = object(await input.call('notification.launch.ack', { receipt, connectionID: claim.scope.connectionID, lease: claim.lease, expectedRevision }));
      if (!current(claim.scope, turn) || !input.validateRoute(claim.route)) return false;
      if (value?.ok !== true) return false;
      if (claims.get(receipt) === claim) claims.delete(receipt);
      return true;
    },
    invalidate() { revision++; claims.clear(); },
    dispose() { alive = false; revision++; claims.clear(); },
  };
}
