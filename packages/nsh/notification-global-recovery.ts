import { notificationIdentifier } from './notification-core';
import { notificationAdmission, type NotificationAdmission } from '../web/server/lib/notifications/admission-event.js';

export type NotificationRecoveryRecord = {
  v: 1; receipt: string; revision: number; connectionID: string; authorizationID: string;
  admission: NotificationAdmission; createdAt: number; expiresAt: number;
};
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export function notificationRecoveryTap(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const row = payload as Record<string, unknown>;
  return Object.keys(row).sort().join(',') === 'receipt,v' && row.v === 1 && uuid(row.receipt) ? row.receipt : null;
}
export function notificationRecoveryFingerprint(record: NotificationRecoveryRecord): string {
  const { admission } = record;
  return JSON.stringify([record.connectionID, record.authorizationID, record.revision, record.createdAt, record.expiresAt,
    admission.kind, admission.eventID, admission.target.kind, admission.target.id,
    Object.entries(admission.source).sort(([a], [b]) => a.localeCompare(b))]);
}

/** Read only from the native protected receipt store, never from OS userInfo or a deep-link target. */
export function notificationRecoveryRecord(value: unknown): NotificationRecoveryRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>, admission = notificationAdmission(row.admission);
  if (Object.keys(row).sort().join(',') !== 'admission,authorizationID,connectionID,createdAt,expiresAt,receipt,revision,v'
    || row.v !== 1 || !uuid(row.receipt) || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1
    || !notificationIdentifier(row.connectionID) || !notificationIdentifier(row.authorizationID) || row.authorizationID === 'legacy' || !admission
    || typeof row.createdAt !== 'number' || !Number.isFinite(row.createdAt) || row.createdAt < 0
    || typeof row.expiresAt !== 'number' || !Number.isFinite(row.expiresAt) || row.expiresAt <= row.createdAt || row.expiresAt - row.createdAt > 7 * 24 * 60 * 60 * 1000) return null;
  return { v: 1, receipt: row.receipt, revision: row.revision, connectionID: row.connectionID, authorizationID: row.authorizationID, admission, createdAt: row.createdAt, expiresAt: row.expiresAt };
}

/** Safe cold-tap contract. No automatic Host switch, message read, notification send or implicit authority. */
export function createNotificationRecovery<Destination>(input: {
  scope: () => { connectionID: string; authorizationID: string; generation: number } | null;
  now: () => number;
  read: (receipt: string) => Promise<unknown>;
  consume: (receipt: string, expectedRevision: number) => Promise<boolean>;
  valid?: (record: NotificationRecoveryRecord) => boolean;
  resolve: (admission: NotificationAdmission, current: () => boolean) => readonly Destination[] | Promise<readonly Destination[]>;
  open: (destination: Destination, current: () => boolean) => boolean | void | Promise<boolean | void>;
}) {
  let alive = true;
  const flights = new Map<string, Promise<'opened' | 'unavailable' | 'stale'>>(), opened = new Map<string, string>();
  return {
    async route(payload: unknown): Promise<'opened' | 'unavailable' | 'stale'> {
      const receipt = notificationRecoveryTap(payload);
      if (!receipt) return 'unavailable';
      const joined = flights.get(receipt);
      if (joined) return joined;
      if (flights.size >= 16) return 'unavailable';
      const selected = input.scope();
      if (!alive || !selected) return 'stale';
      const captured = { ...selected };
      let protectedRecord: NotificationRecoveryRecord | null = null;
      let consumed = false;
      let lifetime: { createdAt: number; expiresAt: number } | null = null;
      const current = () => { const scope = input.scope(); return alive && !!scope && scope.connectionID === captured.connectionID && scope.authorizationID === captured.authorizationID && scope.generation === captured.generation && (!lifetime || lifetime.createdAt <= input.now() && lifetime.expiresAt > input.now()) && (!protectedRecord || consumed || input.valid?.(protectedRecord) !== false); };
      const work = (async () => {
        try {
          const record = notificationRecoveryRecord(await input.read(receipt));
          if (!current()) return 'stale' as const;
          if (!record || record.receipt !== receipt || record.connectionID !== captured.connectionID || record.authorizationID !== captured.authorizationID || record.createdAt > input.now() || record.expiresAt <= input.now()) return 'unavailable' as const;
          lifetime = { createdAt: record.createdAt, expiresAt: record.expiresAt };
          protectedRecord = record;
          if (!current()) return 'stale' as const;
          const fingerprint = notificationRecoveryFingerprint(record);
          if (opened.has(receipt) && opened.get(receipt) !== fingerprint) return 'unavailable' as const;
          if (!opened.has(receipt)) {
            const matches = await input.resolve(record.admission, current);
            if (!current()) return 'stale' as const;
            if (matches.length !== 1) return 'unavailable' as const;
            if (await input.open(matches[0], current) === false) return 'unavailable' as const;
            if (!current()) return 'stale' as const;
            opened.set(receipt, fingerprint); if (opened.size > 256) opened.delete(opened.keys().next().value!);
          }
          if (!await input.consume(receipt, record.revision)) return 'unavailable' as const;
          consumed = true;
          return current() ? 'opened' as const : 'stale' as const;
        } catch { return current() ? 'unavailable' as const : 'stale' as const; }
      })();
      flights.set(receipt, work);
      try { return await work; } finally { if (flights.get(receipt) === work) flights.delete(receipt); }
    },
    dispose() { alive = false; flights.clear(); opened.clear(); },
  };
}
