import type { DesktopWriterClaim, DesktopWriterClient } from './desktop-writer-core';
import { resolveNewSessionWriterDirectory } from './new-session-directory';
import type { PageOperation } from './page-operations';
import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';

export type NewSessionWriterPhase = 'unavailable' | 'resolving' | 'acquiring' | 'ready' | 'denied' | 'unknown' | 'retired' | 'released';
export type NewSessionWriterAdmission = Readonly<{ directory: string; client: DesktopWriterClient; claim: DesktopWriterClaim }>;
export type NewSessionWriterAdmissionGuard = Readonly<{
  current(): boolean;
  prepare(): Promise<boolean>;
  canClose(): boolean;
  cancel(): void;
  release(): Promise<boolean>;
}>;
const admissions = new WeakSet<NewSessionWriterAdmission>(), adopted = new WeakSet<NewSessionWriterAdmission>();

/** Waiting-page protection only; never acquires, retires or releases a native claim. */
export function createNewSessionWriterAdmissionGuard(options: { current(): boolean; safe(): boolean }): NewSessionWriterAdmissionGuard {
  let prepared = false;
  const canClose = () => prepared && options.current() && options.safe();
  return {
    current: options.current,
    prepare() { prepared = options.current() && options.safe(); return Promise.resolve(prepared); },
    canClose,
    cancel() { prepared = false; },
    release: () => Promise.resolve(canClose()),
  };
}

/** No discovery here: only the window root's verified client may admit a draft. */
export function createNewSessionWriterAdmission(options: {
  client: DesktopWriterClient | undefined; operation: PageOperation; directory: string; current(): boolean; changed?(): void;
}) {
  let phase: NewSessionWriterPhase = 'unavailable', alive = true, admission: NewSessionWriterAdmission | null = null;
  let claim: DesktopWriterClaim | undefined, flight: Promise<NewSessionWriterAdmission | null> | undefined, closeFlight: Promise<boolean> | undefined;
  let operation = options.operation, resolving: Promise<NewSessionWriterAdmission | null> | undefined, resumed: PageOperation | undefined;
  let resumeFlight: Promise<NewSessionWriterAdmission | null> | undefined;
  const current = () => alive && options.current();
  const publish = (next: NewSessionWriterPhase) => { phase = next; options.changed?.(); };
  function admitted() { return current() && operation.current() && admission?.claim.grant() && sameRuntimeScope(admission.claim.expectedHost, operation.scope) ? admission : null; }
  function resolve(captured: PageOperation) {
    if (resolving) return resolving;
    const work = (async () => {
      try {
        const client = options.client, scope = runtimeScopeFrom(captured.scope);
        if (!current()) { publish('retired'); return null; }
        if (!captured.current() || operation !== captured) { publish('unavailable'); return null; }
        if (!client?.current() || !scope) { publish('unavailable'); return null; }
        if (claim) {
          await claim.ready();
          if (!sameRuntimeScope(claim.expectedHost, scope)) await claim.renew({ expectedHost: scope });
          if (!current() || operation !== captured || !captured.current()) return null;
          if (!claim.grant()) { publish(claim.status().unknown ? 'unknown' : 'denied'); return null; }
          publish('ready'); return admitted();
        }
        publish('resolving');
        const directory = await resolveNewSessionWriterDirectory({ directory: options.directory, read: captured.request, current: () => current() && operation === captured && captured.current() });
        if (!current() || operation !== captured || !captured.current()) return null;
        publish('acquiring');
        claim = client.claim({ expectedHost: scope, target: { kind: 'new-session', id: directory }, current });
        await claim.ready();
        if (!current()) { claim.retire(); publish('retired'); return null; }
        if (!claim.grant()) { publish(claim.status().unknown ? 'unknown' : 'denied'); return null; }
        admission = Object.freeze({ directory, client, claim }); admissions.add(admission);
        if (operation !== captured || !captured.current()) { publish('unavailable'); return null; }
        publish('ready'); return admitted();
      } catch { publish(current() ? 'unavailable' : 'retired'); return null; }
    })();
    resolving = work;
    void work.finally(() => { if (resolving === work) resolving = undefined; });
    return work;
  }
  function ready() {
    flight ??= resolve(operation);
    return flight;
  }
  return {
    ready, admitted, snapshot: () => Object.freeze({ phase }),
    safeToLeave() {
      const status = claim?.status();
      return !resolving && !['resolving', 'acquiring', 'unknown'].includes(phase)
        && (!status || !status.hasGrant && !status.pending && !status.unknown && !['acquiring', 'renewing', 'releasing'].includes(status.phase));
    },
    resume(next: PageOperation) {
      if (resumed === next && resumeFlight) return resumeFlight;
      if (!current() || !next.current() || !next.scope || next.scope.hostID !== options.operation.scope?.hostID) return Promise.resolve(null);
      resumed = next; operation = next;
      const pending = resolving;
      resumeFlight = (async () => {
        if (pending) await pending;
        if (operation !== next || !current() || !next.current()) return null;
        return resolve(next);
      })();
      return resumeFlight;
    },
    retire() { alive = false; claim?.retire(); publish('retired'); },
    close(permission: { allowed(): boolean }) {
      closeFlight ??= (async () => {
        alive = false; claim?.retire();
        if (resolving) await resolving;
        if (resumeFlight) await resumeFlight;
        const released = claim ? await claim.close(permission) : permission.allowed();
        publish(released ? 'released' : claim?.status().unknown ? 'unknown' : 'retired');
        return released;
      })();
      return closeFlight;
    },
  };
}

/** Per-original-source custody, not a second native writer registry. */
export function createNewSessionWriterCustody(admission: NewSessionWriterAdmission, options: { directory: string; scope: RuntimeScope | null; current(): boolean; hostCurrent(): boolean; changed(): void }) {
  const source = admission.claim;
  if (!admissions.has(admission) || adopted.has(admission) || admission.directory !== options.directory || source.target.kind !== 'new-session' || source.target.id !== options.directory
    || !sameRuntimeScope(source.expectedHost, options.scope) || !source.grant()) throw new Error('new-session-writer-required');
  adopted.add(admission);
  let session: DesktopWriterClaim | undefined, sessionID: string | undefined, sessionFlight: Promise<DesktopWriterClaim> | undefined;
  let transferred = false;
  const stopSource = source.subscribe(options.changed);
  let stopSession: (() => void) | undefined;
  function sessionReady() { return session?.grant() ? session : undefined; }
  function current(scope: RuntimeScope | null) { return !!source.grant() && sameRuntimeScope(source.expectedHost, scope) && (!session || !!session.grant() && sameRuntimeScope(session.expectedHost, scope)); }
  async function ensureSession(id: string, operation: PageOperation) {
    if (sessionID && sessionID !== id) throw new Error('new-session-writer-target-changed');
    if (!session) {
      if (!operation.current() || !current(operation.scope) || !operation.scope) throw new Error('new-session-writer-required');
      sessionID = id;
      session = admission.client.claim({ target: { kind: 'session', id }, expectedHost: operation.scope, current: () => transferred ? options.hostCurrent() : options.current() });
      stopSession = session.subscribe(options.changed);
      sessionFlight = session.ready().then(() => {
        if (!sessionReady()) throw new Error(session!.status().unknown ? 'new-session-writer-unknown' : 'new-session-writer-unavailable');
        return session!;
      });
    }
    if (sessionFlight) await sessionFlight;
    if (!operation.current() || !current(operation.scope) || !sessionReady()) throw new Error('new-session-writer-required');
    return session!;
  }
  async function renew(scope: RuntimeScope) {
    if (!options.current()) return false;
    if (!sameRuntimeScope(source.expectedHost, scope)) await source.renew({ expectedHost: scope });
    if (session && !sameRuntimeScope(session.expectedHost, scope)) await session.renew({ expectedHost: scope });
    options.changed(); return current(scope);
  }
  return {
    source, current, renew, ensureSession, session: sessionReady,
    transfer() { const value = sessionReady(); if (!value) throw new Error('new-session-writer-required'); transferred = true; return value; },
    reclaim() { transferred = false; },
    async releaseSource(allowed: () => boolean) {
      const released = await source.release({ allowed });
      if (released) { stopSource(); stopSession?.(); }
      return released;
    },
  };
}
