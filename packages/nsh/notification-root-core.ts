import { type RuntimeEvent } from './model';
import { notificationIdentifier, type NotificationCall, type NotificationLanguage, type NotificationScope } from './notification-core';
import { createNotificationGlobalAdmission } from './notification-global-admission';
import { createNotificationIdentityResolver, type NotificationIdentityInput, type NotificationCatalogIdentity } from './notification-session-live';
import { createNotificationRecovery, notificationRecoveryFingerprint, notificationRecoveryTap, type NotificationRecoveryRecord } from './notification-global-recovery';
import type { createNotificationSettingsTransport } from './notification-preferences-core';
import type { NotificationAdmission } from '../web/server/lib/notifications/admission-event.js';
import { createNotificationLaunchTransport } from './notification-launch-transport';

export type { NotificationCatalogIdentity } from './notification-session-live';
export type NotificationRootState = {
  ready: boolean; refreshing: boolean; error: 'readFailed' | 'unavailable' | 'unsupported' | null;
  recovery: 'idle' | 'waitingReady' | 'unsupported' | 'resolving' | 'opened' | 'unavailable';
};
type Transport = ReturnType<typeof createNotificationSettingsTransport>;
const same = (a: NotificationScope | null, b: NotificationScope | null) => !!a && !!b && a.hostID === b.hostID && a.generation === b.generation;
const unsupported = () => { throw new Error('notification_unsupported'); };
export type NotificationRootInput<Destination> = {
  transport: Transport; scope: () => NotificationScope | null; sessions: NotificationIdentityInput['sessions'];
  lookup?: NotificationIdentityInput['lookup']; catalog?: NotificationIdentityInput['catalog'];
  catalogReady?: (current: () => boolean) => Promise<void>;
  authorizationID?: () => string | null; call?: NotificationCall; now?: () => number;
  resolve: (identity: NotificationCatalogIdentity, current: () => boolean) => readonly Destination[] | Promise<readonly Destination[]>;
  open: (destination: Destination, current: () => boolean) => boolean | void | Promise<boolean | void>;
  changed: (state: NotificationRootState) => void;
};

/** One production root controller; the outer root owns the only event and tap subscriptions. */
export function createNotificationRootController<Destination>(input: NotificationRootInput<Destination>) {
  let alive = true, active = false, bound: NotificationScope | null = null, language: NotificationLanguage = 'en', generation = 0;
  let authorization: string | null = null;
  let state: NotificationRootState = { ready: false, refreshing: false, error: null, recovery: 'waitingReady' };
  let flight: Promise<void> | null = null, dirty = false, launchFlight: Promise<void> | null = null, launchDirty = false;
  let launchEpoch = 0;
  let pendingTap: string | null = null;
  const failures = new Map<string, NonNullable<NotificationRootState['error']>>(), dismissed = new Set<string>();
  const set = (change: Partial<NotificationRootState>) => {
    if (!alive) return;
    const next = { ...state, ...change, error: [...failures].find(([source]) => !dismissed.has(source))?.[1] ?? null };
    if (Object.keys(next).every(key => next[key as keyof NotificationRootState] === state[key as keyof NotificationRootState])) return;
    state = next; input.changed(state);
  };
  const failure = (source: string, error: NonNullable<NotificationRootState['error']>) => { failures.set(source, error); dismissed.delete(source); set({}); };
  const resolved = (source: string) => { failures.delete(source); dismissed.delete(source); set({}); };
  const current = (scope: NotificationScope, turn = generation) => alive && active && turn === generation && same(scope, bound) && same(scope, input.scope());
  const ready = () => !!bound && current(bound) && state.ready && input.transport.delivery.ready() && same(input.transport.confirmed()?.scope ?? null, bound);
  const currentAuthorization = () => {
    const value = input.authorizationID?.();
    return notificationIdentifier(value) && value !== 'legacy' ? value : null;
  };
  const resolveIdentity = createNotificationIdentityResolver({ sessions: input.sessions, lookup: input.lookup ?? unsupported, catalog: input.catalog ?? unsupported });
  async function identity(admission: NotificationAdmission, valid: () => boolean) {
    if (!input.catalogReady) return unsupported();
    await input.catalogReady(valid);
    return valid() ? resolveIdentity(admission, valid) : null;
  }
  async function destinations(admission: NotificationAdmission, valid: () => boolean) {
    const target = await identity(admission, valid);
    return valid() && target ? input.resolve(target, valid) : [];
  }
  const admitted = createNotificationGlobalAdmission({
    scope: input.scope, language: () => language, active: () => alive && active,
    settings: () => input.transport.confirmed()?.preferences ?? null,
    resolve: async (admission, valid) => await identity(admission, valid) ? [{ ...admission.target }] : [],
    deliver: async (event, admission) => {
      if (!bound || !current(bound)) return 'stale';
      if (!authorization || authorization !== currentAuthorization()) { failure(`live:${event.eventID}`, 'unsupported'); return 'stale'; }
      const result = await input.transport.delivery.acceptLive(event, admission);
      return result;
    },
    error: (error, eventID) => failure(`live:${eventID}`, error),
    resolved: eventID => resolved(`live:${eventID}`),
  });
  const recoveryScope = () => ready() && bound && authorization && authorization === currentAuthorization()
    ? { connectionID: bound.hostID, generation: bound.generation, authorizationID: authorization } : null;
  const launch = createNotificationLaunchTransport({ call: input.call ?? unsupported, scope: recoveryScope, validateRoute: input.transport.delivery.route });
  let peeked: NotificationRecoveryRecord | null = null;
  const recovery = createNotificationRecovery<Destination>({
    scope: recoveryScope,
    now: input.now ?? Date.now,
    read: async receipt => {
      const expected = peeked;
      if (!expected || expected.receipt !== receipt) throw new Error('notification_stale');
      const record = await launch.read(receipt);
      if (notificationRecoveryFingerprint(record) !== notificationRecoveryFingerprint(expected)) throw new Error('notification_invalid_claim');
      return record;
    },
    valid: record => {
      return launch.isCurrent(record.receipt);
    },
    consume: launch.consume,
    resolve: destinations, open: input.open,
  });

  async function recoverLaunch(explicit = false): Promise<void> {
    if (!ready()) { set({ recovery: 'waitingReady' }); return; }
    if (!authorization || authorization !== currentAuthorization() || !input.call || !input.catalogReady) {
      set({ recovery: 'unsupported' }); if (explicit) failure('launch:authorization', 'unsupported'); return;
    }
    if (launchFlight) { launchDirty = true; return launchFlight; }
    const captured = { ...bound! }, turn = generation, binding = authorization, launchTurn = launchEpoch;
    const valid = () => current(captured, turn) && ready() && binding === currentAuthorization() && launchTurn === launchEpoch;
    let failureSource = pendingTap ? `launch:${pendingTap}` : 'launch:read';
    const work = (async () => {
      try {
        // Readiness is awaited before claim. A partial/failed catalog is never empty success.
        await input.catalogReady!(valid);
        if (!valid()) return;
        const record = await launch.peek();
        if (!valid()) return;
        resolved('launch:read'); resolved('launch:authorization');
        if (record === null) { pendingTap = null; set({ recovery: 'idle' }); return; }
        failureSource = `launch:${record.receipt}`;
        const now = (input.now ?? Date.now)();
        if (!record || record.connectionID !== captured.hostID || record.authorizationID !== binding
          || record.createdAt > now || record.expiresAt <= now || pendingTap && record.receipt !== pendingTap) {
          set({ recovery: 'unavailable' }); failure(failureSource, 'unavailable'); return;
        }
        peeked = record;
        set({ recovery: 'resolving' });
        const result = await recovery.route({ v: 1, receipt: record.receipt });
        if (!valid()) return;
        if (result === 'opened') {
          pendingTap = null; resolved(failureSource); set({ recovery: 'opened' });
        } else if (result === 'unavailable') { set({ recovery: 'unavailable' }); failure(failureSource, 'unavailable'); }
        else set({ recovery: 'waitingReady' });
      } catch (error) {
        if (valid()) {
          if (error instanceof Error && error.message === 'notification_catalog_incomplete') set({ recovery: 'waitingReady' });
          else { failure(failureSource, 'readFailed'); set({ recovery: 'unavailable' }); }
        }
      }
    })();
    launchFlight = work;
    try { await work; } finally {
      if (launchFlight === work) {
        launchFlight = null;
        if (launchDirty) { launchDirty = false; void recoverLaunch(); }
      }
    }
  }
  async function retryReady() {
    if (!ready()) return;
    await admitted.retry();
    if (ready()) await recoverLaunch();
  }
  const off = input.transport.onConfirmed(value => {
    if (bound && current(bound) && same(value.scope, bound)) {
      resolved('settings'); set({ ready: true });
      if (!flight) void retryReady();
    }
  });
  async function refresh() {
    if (!bound || !current(bound)) return;
    if (flight) { dirty = true; return flight; }
    const captured = { ...bound }, turn = generation;
    const work = (async () => {
      do {
        dirty = false; set({ refreshing: true });
        try {
          await input.transport.refresh();
          if (current(captured, turn)) { resolved('settings'); set({ ready: true }); await retryReady(); }
        } catch (error) { if (current(captured, turn) && !(error instanceof Error && error.message === 'notification_stale')) failure('settings', 'readFailed'); }
      } while (dirty && current(captured, turn));
      if (current(captured, turn)) set({ refreshing: false });
    })();
    flight = work;
    try { await work; } finally { if (flight === work) flight = null; }
  }
  return {
    state: () => state, refresh,
    async recover() {
      pendingTap = null; launchEpoch++; launch.invalidate(); peeked = null;
      if (ready()) await admitted.retry();
      return recoverLaunch(true);
    },
    async route(value: unknown) {
      const receipt = notificationRecoveryTap(value);
      if (!receipt) { failure('launch:tap', 'unavailable'); return; }
      resolved('launch:tap');
      if (pendingTap !== receipt) { launchEpoch++; launch.invalidate(); peeked = null; }
      pendingTap = receipt;
      await recoverLaunch(true);
    },
    dismissUnavailable() { for (const source of failures.keys()) dismissed.add(source); set({}); },
    bind(scope: NotificationScope | null, nextLanguage: NotificationLanguage, foreground: boolean) {
      if (!alive) return;
      const hostChanged = !same(scope, bound) && (scope !== null || bound !== null);
      const nextAuthorization = currentAuthorization(), authChanged = nextAuthorization !== authorization;
      const changed = hostChanged || authChanged || language !== nextLanguage;
      const resumed = foreground && !active, paused = !foreground && active;
      active = foreground;
      if (changed || paused || resumed) {
        generation++; bound = scope ? { ...scope } : null; language = nextLanguage; authorization = nextAuthorization;
        dirty = false; flight = null; launchFlight = null; launchDirty = false; peeked = null; launch.invalidate();
        admitted.retire(hostChanged || authChanged);
        if (hostChanged || authChanged) { failures.clear(); dismissed.clear(); }
        if (hostChanged || authChanged) input.transport.invalidate(); else if (changed) input.transport.retireReads();
        set({ ready: !!input.transport.confirmed() && input.transport.delivery.ready(), refreshing: false, error: null, recovery: 'waitingReady' });
      }
      if (active && bound && (changed || resumed)) void refresh();
    },
    onEvent(event: RuntimeEvent, scope: NotificationScope) {
      if (!bound || !current(bound) || event.key !== 'global' || !same(scope, bound)) return;
      // The Host has no general settings revision tip today. Do not invent yuri:settings-changed.
      if (event.type === 'reconnected' || event.type === 'server.connected') { void refresh(); return; }
      admitted.onEvent(event, scope);
    },
    dispose() { alive = false; generation++; off(); admitted.dispose(); recovery.dispose(); launch.dispose(); input.transport.invalidate(); },
  };
}
