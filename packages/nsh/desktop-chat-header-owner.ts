import { createChatHeaderMetadata, type ChatHeaderMetadata } from './chat-header-metadata';
import type { HeaderQuotaSnapshot } from './chat-header-quota';
import type { ChatTarget } from './model';
import type { PageOperation } from './page-operations';
import type { DesktopChatHeaderResult } from './desktop-chat-header-core';

export type DesktopChatHeaderOperation = Pick<PageOperation, 'current' | 'request'>;
export type DesktopChatHeaderDemand = { readDemand?: boolean; busy?: boolean };
export type DesktopChatHeaderOwnerOptions = {
  target: ChatTarget;
  operation: () => DesktopChatHeaderOperation | null;
  /** Captured Host/Chat identity, not modal or display activity. False retires permanently. */
  current: () => boolean;
  changed: (value: ChatHeaderMetadata) => void;
  now?: () => number;
};

type Flight<T> = {
  generation: number; lane: DesktopChatHeaderOperation;
  promise: Promise<DesktopChatHeaderResult>;
  finish: (value: DesktopChatHeaderResult) => void;
  completed?: T;
};

function quotaFailed(value: HeaderQuotaSnapshot): boolean {
  return !value.loaded || value.loading || value.errors.length > 0 || value.groups.some(group =>
    !!group.error || group.stale === true || group.rows.some(row => !!row.accountError || row.stale === true));
}

/** The retained Chat constructs and drives this once, outside the header render slot.
 * Exactly one existing bounded source owns metadata, quotas and its catalog cache. */
export function createDesktopChatHeaderOwner(options: DesktopChatHeaderOwnerOptions) {
  const target = { ...options.target };
  let alive = true, retired = false, generation = 0, demand = false, busy = false, dirty = false;
  let lane: DesktopChatHeaderOperation | null = null;
  let metadataFlight: Flight<ChatHeaderMetadata> | undefined, quotaFlight: Flight<HeaderQuotaSnapshot> | undefined;
  let snapshot: ChatHeaderMetadata = { loading: false, errors: [] };
  let sourceQuota: HeaderQuotaSnapshot | undefined;

  function authorityCurrent() {
    if (!alive || retired) return false;
    if (!options.current()) { retired = true; return false; }
    return true;
  }
  function valid(serial: number, captured: DesktopChatHeaderOperation | null): captured is DesktopChatHeaderOperation {
    return authorityCurrent() && demand && captured !== null && generation === serial && lane === captured
      && options.operation() === captured && captured.current();
  }
  function flightCurrent<T>(flight: Flight<T>) { return valid(flight.generation, flight.lane); }
  function publish(value: ChatHeaderMetadata) {
    if (snapshot === value) return;
    snapshot = value;
    if (authorityCurrent()) options.changed(value);
  }
  function markStale() {
    const quota = snapshot.quota;
    let retainedQuota = quota;
    if (quota && (quota.loading || quota.loaded !== false || quota.groups.some(group => !group.stale || group.rows.some(row => !row.stale)))) {
      retainedQuota = { ...quota, loading: false, loaded: false, groups: quota.groups.map(group => ({ ...group, stale: true,
        rows: group.rows.map(row => row.stale ? row : { ...row, stale: true }) })) };
    }
    if (snapshot.loading || snapshot.contextStale !== true || retainedQuota !== quota) publish({ ...snapshot, loading: false, contextStale: true, ...(retainedQuota ? { quota: retainedQuota } : {}) });
  }

  const source = createChatHeaderMetadata({ target, now: options.now,
    current: () => valid(generation, lane),
    read: async path => {
      const captured = lane, serial = generation;
      if (!valid(serial, captured)) throw new Error('desktop_header_read_stale');
      const result = await captured.request(path, 'GET');
      if (!valid(serial, captured)) throw new Error('desktop_header_read_stale');
      return result;
    },
    changed: value => {
      // The existing controller also publishes quota patches inside its metadata
      // object. Adopt only the lane that actually changed; a metadata start must
      // not undo retained quota staleness (or a quota patch undo context staleness).
      const quotaChanged = value.quota !== sourceQuota;
      sourceQuota = value.quota;
      if (quotaChanged) {
        const flight = quotaFlight, quota = value.quota;
        if (!flight || !quota || !flightCurrent(flight)) return;
        if (!quota.loading) flight.completed = quota;
        const retained = quota.loading && snapshot.quota ? { ...snapshot.quota, loading: true, errors: quota.errors } : quota;
        publish({ ...snapshot, quota: retained });
      } else {
        const flight = metadataFlight;
        if (!flight || !flightCurrent(flight)) return;
        if (!value.loading) flight.completed = value;
        publish(value.loading ? { ...snapshot, loading: true, errors: value.errors, contextStale: true }
          : { ...value, quota: snapshot.quota });
      }
    },
  });

  function revoke() {
    generation++;
    source.cancel();
    const previousMetadata = metadataFlight, previousQuota = quotaFlight;
    metadataFlight = undefined; quotaFlight = undefined;
    previousMetadata?.finish({ status: 'stale' }); previousQuota?.finish({ status: 'stale' });
    markStale();
  }
  function reconcileLane() {
    if (!authorityCurrent()) {
      if (alive && (lane || metadataFlight || quotaFlight)) { lane = null; dirty = false; revoke(); }
      return;
    }
    const candidate = options.operation(), next = candidate?.current() ? candidate : null;
    if (next === lane) return;
    lane = next;
    if (next && target.kind === 'session') dirty = true;
    revoke();
  }
  function makeFlight<T>(captured: DesktopChatHeaderOperation): Flight<T> {
    let finish!: (result: DesktopChatHeaderResult) => void;
    const promise = new Promise<DesktopChatHeaderResult>(resolve => { finish = resolve; });
    return { generation, lane: captured, promise, finish };
  }
  function startMetadata(force = false): Promise<DesktopChatHeaderResult> {
    if (!valid(generation, lane)) return Promise.resolve({ status: 'unsupported' });
    if (target.kind !== 'session') return Promise.resolve({ status: 'unsupported' });
    if (metadataFlight) return metadataFlight.promise;
    dirty = false;
    const flight = makeFlight<ChatHeaderMetadata>(lane); metadataFlight = flight;
    const complete = (threw = false) => {
      if (metadataFlight !== flight || !flightCurrent(flight)) { if (metadataFlight === flight) reconcileLane(); flight.finish({ status: 'stale' }); return; }
      const value = flight.completed;
      metadataFlight = undefined;
      if (threw || !value) publish({ ...snapshot, loading: false, contextStale: true });
      flight.finish({ status: !flightCurrent(flight) ? 'stale' : !threw && value && !value.loading && !value.contextStale && !value.errors.length ? 'accepted' : 'failed' });
      drive();
    };
    void source.refresh(force).then(() => complete(), () => complete(true));
    return flight.promise;
  }
  function drive() {
    if (dirty && !busy && !metadataFlight && valid(generation, lane)) void startMetadata();
  }
  function update(value: DesktopChatHeaderDemand) {
    if (!alive) return;
    const previousDemand = demand, previousBusy = busy;
    if (value.readDemand !== undefined) demand = value.readDemand;
    if (value.busy !== undefined) busy = value.busy;
    if (previousBusy && !busy && target.kind === 'session' && authorityCurrent()) dirty = true;
    reconcileLane();
    if (previousDemand && !demand) revoke();
    drive();
  }
  return {
    snapshot: () => snapshot,
    update,
    setDemand(value: boolean) { update({ readDemand: value }); },
    refresh(force = false) {
      reconcileLane();
      return startMetadata(force);
    },
    refreshQuotas(force = true): Promise<DesktopChatHeaderResult> {
      reconcileLane();
      if (!valid(generation, lane)) return Promise.resolve({ status: 'unsupported' });
      if (quotaFlight) return quotaFlight.promise;
      const flight = makeFlight<HeaderQuotaSnapshot>(lane); quotaFlight = flight;
      const complete = (threw = false) => {
        if (quotaFlight !== flight || !flightCurrent(flight)) { if (quotaFlight === flight) reconcileLane(); flight.finish({ status: 'stale' }); return; }
        const value = flight.completed;
        quotaFlight = undefined;
        if (threw || !value) {
          const quota = snapshot.quota;
          if (quota) publish({ ...snapshot, quota: { ...quota, loading: false, loaded: false } });
        }
        flight.finish({ status: !flightCurrent(flight) ? 'stale' : !threw && value && !quotaFailed(value) ? 'accepted' : 'failed' });
      };
      void source.refreshQuotas(force).then(() => complete(), () => complete(true));
      return flight.promise;
    },
    setQuotaMode(_mode: 'usage' | 'remaining'): DesktopChatHeaderResult { return { status: 'unsupported' }; },
    dispose() {
      if (!alive) return;
      alive = false; retired = true; dirty = false;
      revoke(); source.dispose();
    },
  };
}
