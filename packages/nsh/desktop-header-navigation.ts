import type { DesktopHeaderConnectionTarget } from './desktop-header-instances-root-core';
import type { DesktopHeaderServiceResult } from './desktop-header-services';
import { sameRuntimeScope, type RuntimeScope } from './runtime-scope';

export type DesktopHeaderNavigationTarget = DesktopHeaderConnectionTarget;
export type DesktopHeaderNavigationIntent = Readonly<{ current(): boolean; from: DesktopHeaderNavigationTarget | null }>;
export type DesktopHeaderNavigationGuard = Readonly<{
  window: object;
  route: object | null;
  runtimeScope: RuntimeScope | null;
  connection: DesktopHeaderNavigationTarget | null;
  connections: readonly DesktopHeaderNavigationTarget[] | null;
  generation: number;
  /** Captured external retirement epoch, NOT Header/popup/own guard modal visibility. */
  valid(): boolean;
}>;
export type DesktopHeaderNavigationTicket = Readonly<{
  snapshot: Readonly<Pick<DesktopHeaderNavigationGuard, 'window' | 'route' | 'runtimeScope' | 'connection' | 'generation'>>;
  current(): boolean;
}>;
export type DesktopHeaderNavigationFileReceipt = boolean | Readonly<{ status: 'accepted' | 'cancelled' | 'failed' | 'unknown' }>;
type Phase = 'entry' | 'files' | 'departure' | 'commit';
type Reason = 'committed' | 'unchanged' | 'entry-stale' | 'blocked' | 'pending' | 'unavailable' | 'invalid-target' | 'from-changed' | 'target-changed' | 'scope-changed' | 'retired' | 'disposed' | 'cancelled' | 'files-denied' | 'departure-denied' | 'files-changed' | 'failed' | 'unknown';
export type DesktopHeaderNavigationResult = Readonly<DesktopHeaderServiceResult & { phase: Phase; reason: Reason }>;
export type DesktopHeaderNavigationOptions = {
  canStart(): boolean;
  capture(): DesktopHeaderNavigationGuard | null;
  files: { request(): Promise<DesktopHeaderNavigationFileReceipt>; canLeave(): boolean };
  departure: { request(commit: () => void, validate?: () => boolean, action?: 'switch' | 'add'): Promise<boolean> };
  switch: { commit(target: DesktopHeaderNavigationTarget, ticket: DesktopHeaderNavigationTicket): Promise<DesktopHeaderServiceResult> };
  add: { commit(ticket: DesktopHeaderNavigationTicket): Promise<DesktopHeaderServiceResult> };
};

const result = (status: DesktopHeaderServiceResult['status'], phase: Phase, reason: Reason): DesktopHeaderNavigationResult => ({ status, phase, reason });
const commitReasons: Record<DesktopHeaderServiceResult['status'], Reason> = { accepted: 'committed', failed: 'failed', stale: 'retired', unsupported: 'blocked', unknown: 'unknown' };
const same = (a: DesktopHeaderNavigationTarget | null, b: DesktopHeaderNavigationTarget | null) => a === b || !!a && !!b && a.id === b.id && a.url === b.url && a.authorizationID === b.authorizationID;
const targetValid = (value: DesktopHeaderNavigationTarget | null): value is DesktopHeaderNavigationTarget => !!value && typeof value.id === 'string' && !!value.id && typeof value.url === 'string' && !!value.url && (value.authorizationID === undefined || typeof value.authorizationID === 'string');
const copyTarget = (value: DesktopHeaderNavigationTarget): DesktopHeaderNavigationTarget => Object.freeze({ id: value.id, url: value.url, ...(value.authorizationID === undefined ? {} : { authorizationID: value.authorizationID }) });
const exactMember = (rows: readonly DesktopHeaderNavigationTarget[], target: DesktopHeaderNavigationTarget) => {
  const matches = rows.filter(row => row?.id === target.id);
  return matches.length === 1 && same(matches[0], target);
};

/** One root-local job gate. Entry intent is consumed once; confirmations retain
 * exact root authority without depending on the popup they necessarily close. */
export function createDesktopHeaderNavigation(options: DesktopHeaderNavigationOptions) {
  type Job = { phase: Phase; failure?: DesktopHeaderNavigationResult };
  let alive = true, pending: Job | undefined;

  async function run(action: 'switch' | 'add', supplied: DesktopHeaderNavigationTarget | null, intent: DesktopHeaderNavigationIntent): Promise<DesktopHeaderNavigationResult> {
    if (!alive) return result('stale', 'entry', 'disposed');
    if (pending) return result('unsupported', 'entry', 'pending');
    const job: Job = { phase: 'entry' }; pending = job;
    let completion: Promise<DesktopHeaderNavigationResult> | undefined;
    const fail = (status: DesktopHeaderServiceResult['status'], reason: Reason) => job.failure ??= result(status, job.phase, reason);
    try {
      if (!intent.current()) return fail('stale', 'entry-stale');
      if (!options.canStart()) return fail('unsupported', 'blocked');
      if (action === 'switch' && !targetValid(supplied)) return fail('unsupported', 'invalid-target');
      if (intent.from !== null && !targetValid(intent.from)) return fail('stale', 'from-changed');
      const target = supplied && copyTarget(supplied), from = intent.from && copyTarget(intent.from);
      const captured = options.capture();
      if (!captured) return fail('unknown', 'unavailable');
      const snapshot: DesktopHeaderNavigationTicket['snapshot'] = Object.freeze({
        window: captured.window, route: captured.route, generation: captured.generation,
        runtimeScope: captured.runtimeScope && Object.freeze({ hostID: captured.runtimeScope.hostID, lease: captured.runtimeScope.lease }),
        connection: captured.connection && copyTarget(captured.connection),
      });
      let filesGranted = false;
      const valid = (): boolean => {
        if (job.failure) return false;
        try {
          if (!alive || pending !== job) { fail('stale', 'disposed'); return false; }
          if (!captured.valid()) { fail('stale', 'retired'); return false; }
          const next = options.capture();
          if (!next || !Array.isArray(next.connections)) { fail('unknown', 'unavailable'); return false; }
          if (!snapshot.window || typeof snapshot.window !== 'object' || snapshot.route !== null && typeof snapshot.route !== 'object'
            || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 0
            || next.window !== snapshot.window || next.route !== snapshot.route || next.generation !== snapshot.generation || !sameRuntimeScope(next.runtimeScope, snapshot.runtimeScope)) { fail('stale', 'scope-changed'); return false; }
          if (!same(snapshot.connection, from) || !same(next.connection, from) || from && !exactMember(next.connections, from)) { fail('stale', 'from-changed'); return false; }
          if (target && !exactMember(next.connections, target)) { fail('stale', 'target-changed'); return false; }
          if (filesGranted && !options.files.canLeave()) { fail('failed', 'files-changed'); return false; }
          return true;
        } catch { fail('unknown', 'unavailable'); return false; }
      };
      if (!valid()) return job.failure!;
      // Recheck the entry grant before any confirmation. It is deliberately
      // never consulted again after this synchronous transfer to the root.
      if (!intent.current()) return fail('stale', 'entry-stale');
      if (!options.canStart()) return fail('unsupported', 'blocked');
      if (action === 'switch' && same(target, from)) return result('accepted', 'entry', 'unchanged');

      job.phase = 'files';
      const files = await options.files.request();
      if (!valid()) return job.failure!;
      const fileStatus = typeof files === 'object' && files !== null ? files.status : undefined;
      if (files !== true && fileStatus !== 'accepted') {
        if (files === false) return fail('stale', 'files-denied');
        if (fileStatus === 'cancelled') return fail('stale', 'cancelled');
        return fail(fileStatus === 'failed' ? 'failed' : 'unknown', fileStatus === 'failed' ? 'failed' : 'unknown');
      }
      filesGranted = true;
      if (!valid()) return job.failure!;
      const ticket: DesktopHeaderNavigationTicket = Object.freeze({ snapshot, current: valid });
      job.phase = 'departure';
      let accepting = true, started = false;
      const commit = () => {
        if (!accepting || started || !valid()) return;
        started = true;
        job.phase = 'commit';
        try {
          const operation = action === 'switch' ? options.switch.commit(target!, ticket) : options.add.commit(ticket);
          completion = Promise.resolve(operation).then(value => {
            const status = value?.status;
            if (!status || !Object.hasOwn(commitReasons, status)) return result('unknown', 'commit', 'unknown');
            // A real accepted ACK may intentionally retire the OLD scope.
            // Never infer failure/retry from the resulting metadata refresh.
            return result(status, 'commit', commitReasons[status]);
          }).catch(() => result('unknown', 'commit', 'unknown'));
        } catch { completion = Promise.resolve(result('unknown', 'commit', 'unknown')); }
      };
      try {
        const departed = await options.departure.request(commit, valid, action);
        accepting = false;
        if (completion) return await completion;
        if (!valid()) return job.failure!;
        return fail(departed ? 'unknown' : 'stale', departed ? 'unknown' : 'departure-denied');
      } catch {
        accepting = false;
        if (completion) return await completion;
        if (!valid()) return job.failure!;
        return fail('unknown', 'unknown');
      }
    } catch { return completion ? await completion : fail('unknown', 'unknown'); }
    finally { if (pending === job) pending = undefined; }
  }
  return {
    switch: (target: DesktopHeaderNavigationTarget, intent: DesktopHeaderNavigationIntent) => run('switch', target, intent),
    add: (intent: DesktopHeaderNavigationIntent) => run('add', null, intent),
    pending: () => pending !== undefined,
    cancel() { if (pending && !pending.failure) pending.failure = result('stale', pending.phase, 'retired'); },
    dispose() { alive = false; if (pending && !pending.failure) pending.failure = result('stale', pending.phase, 'disposed'); },
  };
}
