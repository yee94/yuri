import { resourcePath } from './resources-model';
import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';

export type DesktopWriterTarget = Readonly<{ kind: 'session' | 'assistant' | 'new-session'; id: string }>;
export type DesktopWriterPhase = 'acquiring' | 'renewing' | 'ready' | 'denied' | 'unknown' | 'releasing' | 'released' | 'retired';
export type DesktopWriterSource = {
  available(): boolean;
  call(name: 'desktop.writer.capabilities' | 'desktop.writer.acquire' | 'desktop.writer.release' | 'desktop.writer.renew', input: unknown, options: { timeout: number }): Promise<unknown>;
};
export const DESKTOP_WRITER_TIMEOUTS = Object.freeze({ capabilities: 5000, acquire: 15000, release: 15000, renew: 15000 });
export class DesktopWriterError extends Error {
  constructor(readonly code: 'invalid-input' | 'required' | 'target-mismatch' | 'stale' | 'denied' | 'invalid-response' | 'native' | 'owner-blocked', readonly outcome: 'not-dispatched' | 'unknown', readonly original?: unknown) {
    super(`desktop_writer_${code}`); this.name = 'DesktopWriterError';
  }
}
declare const verified: unique symbol;
/** No native grantID is exposed on this object or accepted back from callers. */
export type VerifiedDesktopWriterGrant = Readonly<{ ownerID: string; windowID: string; target: DesktopWriterTarget; expectedHost: RuntimeScope; [verified]: true }>;
export type DesktopWriterStatus = Readonly<{ phase: DesktopWriterPhase; pending: number; hasGrant: boolean; unknown: boolean; error: DesktopWriterError | null }>;
export type DesktopWriterClaim = {
  readonly ownerID: string; readonly windowID: string; readonly target: DesktopWriterTarget; readonly expectedHost: RuntimeScope;
  ready(): Promise<VerifiedDesktopWriterGrant | null>;
  grant(): VerifiedDesktopWriterGrant | null;
  phase(): DesktopWriterPhase;
  status(): DesktopWriterStatus;
  subscribe(listener: () => void): () => void;
  canRelease(): boolean;
  release(options: { allowed(): boolean }): Promise<boolean>;
  renew(options: { expectedHost: RuntimeScope }): Promise<VerifiedDesktopWriterGrant | null>;
  retire(): void;
  close(options: { allowed(): boolean }): Promise<boolean>;
  markUnknown(cause?: unknown): void;
};
export type DesktopWriterClient = {
  readonly windowID: string;
  current(): boolean;
  claim(options: { target: DesktopWriterTarget; expectedHost: RuntimeScope; current(): boolean }): DesktopWriterClaim;
  retire(): void;
};
type NativeGrant = { schemaVersion: 1; ownerID: string; windowID: string; target: DesktopWriterTarget; expectedHost: RuntimeScope; grantID: string };
type GrantRecord = { native: NativeGrant; current(): boolean; begin(): void; finish(unknown: boolean): void };
const grants = new WeakMap<VerifiedDesktopWriterGrant, GrantRecord>();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const exact = (value: unknown, keys: string[]): value is Record<string, unknown> => object(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const safe = (callback: () => boolean) => { try { return callback() === true; } catch { return false; } };
function targetFrom(value: unknown): DesktopWriterTarget {
  if (!exact(value, ['kind', 'id']) || !['session', 'assistant', 'new-session'].includes(String(value.kind)) || typeof value.id !== 'string' || !value.id || /[\x00-\x1f\x7f]/.test(value.id) || new TextEncoder().encode(value.id).length > 1024) throw new DesktopWriterError('invalid-input', 'not-dispatched');
  if (value.kind === 'new-session' && resourcePath(value.id) !== value.id) throw new DesktopWriterError('invalid-input', 'not-dispatched');
  return Object.freeze({ kind: value.kind, id: value.id }) as DesktopWriterTarget;
}
const sameTarget = (left: DesktopWriterTarget, right: DesktopWriterTarget) => left.kind === right.kind && left.id === right.id;
function scopeFrom(value: unknown): RuntimeScope {
  const scope = runtimeScopeFrom(value);
  if (!scope || !id(scope.lease) || new TextEncoder().encode(scope.hostID).length > 512 || /[\x00-\x1f\x7f]/.test(scope.hostID)) throw new DesktopWriterError('invalid-input', 'not-dispatched');
  return scope;
}
function ack(value: unknown, expected: { ownerID: string; windowID: string; target: DesktopWriterTarget; expectedHost: RuntimeScope }): NativeGrant {
  if (!exact(value, ['schemaVersion', 'ownerID', 'windowID', 'target', 'expectedHost', 'grantID']) || value.schemaVersion !== 1 || !id(value.grantID) || value.ownerID !== expected.ownerID || value.windowID !== expected.windowID
    || !sameTarget(targetFrom(value.target), expected.target) || !sameRuntimeScope(scopeFrom(value.expectedHost), expected.expectedHost)) throw new DesktopWriterError('invalid-response', 'unknown');
  return Object.freeze({ schemaVersion: 1, ...expected, grantID: value.grantID });
}
function nativeCode(error: unknown): string {
  return error instanceof Error && 'code' in error && error.code === 'ERR_NSH_HOST_ERROR' ? error.message : '';
}
/** @internal Only the real Host error code can prove the original actor rejected before dispatch. */
export const desktopWriterNotDispatched = (error: unknown): boolean => nativeCode(error) === 'native_host_busy';
const acquireDenied = new Set(['writer_conflict', 'writer_capacity', 'writer_target_invalid', 'writer_identity_invalid', 'invalid_arguments', 'writer_unsupported', 'writer_unavailable', 'native_host_busy', 'runtime_host_scope_required', 'runtime_host_scope_invalid', 'runtime_host_scope_stale', 'runtime_host_unavailable']);

/** One root discovery. No global client/target registry and no authority from caller-supplied booleans. */
export async function loadDesktopWriterClient(options: { source(): DesktopWriterSource | undefined; current(): boolean }): Promise<DesktopWriterClient | undefined> {
  try {
    const getSource = options.source, rootCurrent = options.current;
    const source = getSource();
    if (!source || !safe(rootCurrent) || !safe(() => source.available())) return undefined;
    const call = source.call, available = source.available;
    let alive = true;
    const listeners = new Set<() => void>();
    const identity = () => {
      if (alive && (!safe(rootCurrent) || !safe(() => getSource() === source && source.call === call && source.available === available))) alive = false;
      return alive;
    };
    const current = () => identity() && safe(() => available.call(source));
    const value = await call.call(source, 'desktop.writer.capabilities', {}, { timeout: DESKTOP_WRITER_TIMEOUTS.capabilities });
    if (!current() || !exact(value, ['schemaVersion', 'supported', 'acquire', 'release', 'renew', 'recovery', 'requiresExpectedHost', 'windowID', 'maxWriters']) || value.schemaVersion !== 1 || value.supported !== true || value.acquire !== true || value.release !== true || value.renew !== true
      || value.recovery !== false || value.requiresExpectedHost !== true || !id(value.windowID) || value.maxWriters !== 64) return undefined;
    const windowID = value.windowID;
    const invoke = (name: Parameters<DesktopWriterSource['call']>[0], input: unknown, timeout: number) => call.call(source, name, input, { timeout });
    return {
      windowID, current,
      retire() { if (!alive) return; alive = false; for (const listener of [...listeners]) listener(); },
      claim(input) {
        const ownerCurrent = input.current;
        const ownerID = crypto.randomUUID();
        if (!id(ownerID)) throw new DesktopWriterError('invalid-input', 'not-dispatched');
        const target = targetFrom(input.target);
        let scope = scopeFrom(input.expectedHost), receipt: NativeGrant | null = null, issued: VerifiedDesktopWriterGrant | null = null;
        let retired = false, released = false, unknown = false, pending = 0, error: DesktopWriterError | null = null;
        let busy: 'acquire' | 'renew' | 'release' | null = 'acquire';
        let releaseFlight: Promise<boolean> | undefined, closeFlight: Promise<boolean> | undefined, renewFlight: Promise<VerifiedDesktopWriterGrant | null> | undefined, renewScope: RuntimeScope | undefined;
        let closingAllowed: (() => boolean) | undefined;
        const subscribers = new Set<() => void>();
        let snapshot: DesktopWriterStatus, notifying = false;
        const phase = (): DesktopWriterPhase => unknown ? 'unknown' : released ? 'released' : retired ? 'retired' : busy === 'acquire' ? 'acquiring' : busy === 'renew' ? 'renewing' : busy === 'release' ? 'releasing' : receipt ? 'ready' : 'denied';
        const emit = () => {
          const next = { phase: phase(), pending, hasGrant: !!receipt, unknown, error };
          if (snapshot && Object.keys(next).every(key => next[key as keyof typeof next] === snapshot[key as keyof typeof next])) return;
          snapshot = Object.freeze(next);
          if (notifying) return;
          notifying = true;
          try { for (const subscriber of [...subscribers]) { try { subscriber(); } catch { /* A view cannot change the receipt outcome. */ } } } finally { notifying = false; }
        };
        const markUnknown = (cause?: unknown) => { unknown = true; error = cause instanceof DesktopWriterError ? cause : new DesktopWriterError('native', 'unknown', cause); emit(); };
        const observe = () => {
          if (!retired && (!identity() || !safe(ownerCurrent))) { retired = true; emit(); }
        };
        const grant = () => { observe(); return !unknown && !retired && !released && !busy && current() ? issued : null; };
        const issue = (next: NativeGrant) => {
          receipt = next; scope = next.expectedHost;
          const result = Object.freeze({ ownerID, windowID, target, expectedHost: scope }) as VerifiedDesktopWriterGrant;
          issued = result;
          grants.set(result, {
            native: next, current: () => grant() === result,
            begin() { pending++; emit(); },
            finish(failed) { pending--; if (failed) markUnknown(); else emit(); },
          });
          return result;
        };
        const rootRetired = () => { observe(); };
        listeners.add(rootRetired);
        emit();
        const ready = (async () => {
          if (!current() || !safe(ownerCurrent)) { busy = null; retired = true; error = new DesktopWriterError('stale', 'not-dispatched'); emit(); return null; }
          try {
            const value = await invoke('desktop.writer.acquire', { ownerID, target, expectedHost: scope }, DESKTOP_WRITER_TIMEOUTS.acquire);
            const next = ack(value, { ownerID, windowID, target, expectedHost: scope });
            issue(next); // Retain the original receipt even if it is now too late to publish it.
            if (!current()) { markUnknown(new DesktopWriterError('stale', 'unknown')); return null; }
            observe();
            return retired || unknown || renewScope ? null : issued;
          } catch (cause) {
            if (current() && acquireDenied.has(nativeCode(cause))) error = new DesktopWriterError('denied', 'not-dispatched', cause);
            else markUnknown(cause instanceof DesktopWriterError ? new DesktopWriterError('invalid-response', 'unknown', cause) : cause);
            return null;
          } finally { busy = renewScope ? 'renew' : null; emit(); }
        })();
        const canRelease = () => { observe(); return !!receipt && !released && !unknown && !pending && !busy && (!renewScope || sameRuntimeScope(scope, renewScope)) && current(); };
        const release = (permission: { allowed(): boolean }): Promise<boolean> => {
          if (releaseFlight) return releaseFlight;
          if (released) return Promise.resolve(true);
          const allowed = permission.allowed;
          if (!canRelease() || !safe(allowed) || !canRelease()) return Promise.resolve(false);
          const original = receipt!;
          busy = 'release';
          releaseFlight = Promise.resolve().then(async () => {
            try {
              if (!safe(allowed) || !current() || unknown || pending || receipt !== original) return false;
              const value = await invoke('desktop.writer.release', { ownerID, target, expectedHost: original.expectedHost, grantID: original.grantID }, DESKTOP_WRITER_TIMEOUTS.release);
              if (!current() || unknown || pending || receipt !== original || !exact(value, ['released', 'grantID']) || value.released !== true || value.grantID !== original.grantID) { markUnknown(new DesktopWriterError('invalid-response', 'unknown')); return false; }
              released = true; issued = null; error = null; listeners.delete(rootRetired); return true;
            } catch (cause) {
              if (current() && nativeCode(cause) === 'writer_pending') error = new DesktopWriterError('denied', 'not-dispatched', cause);
              else markUnknown(cause);
              return false;
            } finally { busy = null; emit(); }
          });
          const flight = releaseFlight;
          void flight.then(() => { if (!released && !unknown && releaseFlight === flight) releaseFlight = undefined; });
          emit();
          return flight;
        };
        const retire = () => { retired = true; emit(); };
        return {
          ownerID, windowID, target, get expectedHost() { return scope; }, ready: () => ready, grant, phase: () => { observe(); return phase(); },
          status() { observe(); emit(); return snapshot; }, subscribe(listener) { subscribers.add(listener); return () => { subscribers.delete(listener); }; },
          canRelease, release, retire, markUnknown,
          renew(nextInput) {
            let nextScope: RuntimeScope;
            try { nextScope = scopeFrom(nextInput.expectedHost); } catch { return Promise.resolve(null); }
            if (renewFlight) return sameRuntimeScope(renewScope ?? null, nextScope) ? renewFlight : Promise.resolve(null);
            observe();
            if (unknown || retired || released || pending || busy && busy !== 'acquire' || !current() || nextScope.hostID !== scope.hostID || !receipt && busy !== 'acquire') return Promise.resolve(null);
            if (sameRuntimeScope(scope, nextScope)) return busy === 'acquire' ? ready : Promise.resolve(grant());
            const acquiring = busy === 'acquire';
            renewScope = nextScope; issued = null;
            if (!acquiring) busy = 'renew';
            renewFlight = Promise.resolve().then(async () => {
              try {
                if (acquiring) await ready;
                observe();
                if (retired && (!closingAllowed || !safe(closingAllowed))) return null;
                if (!receipt || unknown || released || pending || !current()) return null;
                const original = receipt;
                const value = await invoke('desktop.writer.renew', { ownerID, target, expectedHost: nextScope, grantID: original.grantID }, DESKTOP_WRITER_TIMEOUTS.renew);
                const next = ack(value, { ownerID, windowID, target, expectedHost: nextScope });
                if (next.grantID === original.grantID) throw new DesktopWriterError('invalid-response', 'unknown');
                issue(next);
                if (!current() || unknown) { markUnknown(new DesktopWriterError('stale', 'unknown')); return null; }
                observe(); return retired ? null : issued;
              } catch (cause) { markUnknown(cause); return null; }
              finally { busy = null; emit(); }
            });
            const flight = renewFlight;
            void flight.then(() => { if (renewFlight === flight) renewFlight = undefined; });
            emit();
            return flight;
          },
          close(permission) {
            if (closeFlight) return closeFlight;
            const allowed = permission.allowed; closingAllowed = allowed;
            closeFlight = Promise.resolve().then(async () => { await ready; if (renewFlight) await renewFlight; return release({ allowed }); });
            retire(); return closeFlight;
          },
        };
      },
    };
  } catch { return undefined; }
}

/** @internal Validates an explicit target; never acquires or guesses authority from a path. */
function requestTarget(path: string, method: string, body: unknown): DesktopWriterTarget | null {
  if (method === 'GET') return null;
  const raw = path.split('?')[0];
  if (method === 'POST' && raw === '/api/rpc/opencode.goal/get') return null;
  if (raw === '/api/session') {
    if (method !== 'POST' || !object(body) || !object(body.location)) throw new DesktopWriterError('target-mismatch', 'not-dispatched');
    return targetFrom({ kind: 'new-session', id: body.location.directory });
  }
  for (const [prefix, kind] of [['/api/session/', 'session'], ['/api/yuri/assistants/', 'assistant']] as const) {
    if (raw.startsWith(prefix)) {
      try { return targetFrom({ kind, id: decodeURIComponent(raw.slice(prefix.length).split('/')[0]) }); }
      catch (cause) { throw new DesktopWriterError('target-mismatch', 'not-dispatched', cause); }
    }
  }
  let decoded: string;
  try { decoded = decodeURIComponent(raw); } catch { throw new DesktopWriterError('target-mismatch', 'not-dispatched'); }
  if (decoded.startsWith('/api/session') || decoded.startsWith('/api/yuri/assistants/') || decoded.startsWith('/api/rpc/')) throw new DesktopWriterError('target-mismatch', 'not-dispatched');
  return null;
}
export type DesktopWriterDispatch = { readonly grantID: string; current(): boolean; finish(outcome: 'confirmed' | 'unknown' | 'not-dispatched'): void };
/** @internal Transport-only receipt. A forged, copied, stale or wrong-target grant never yields a string. */
export function beginDesktopWriterDispatch(options: { writer?: () => VerifiedDesktopWriterGrant | null; expectedHost: RuntimeScope | null; windowID?: string; path: string; method: string; body?: unknown }): DesktopWriterDispatch | null {
  if (!options.writer) return null; // iOS/legacy fidelity; the desktop native gate still enforces missing grants.
  const target = requestTarget(options.path, options.method, options.body);
  if (!target) return null;
  const value = options.writer(), record = value && grants.get(value);
  if (!record || !record.current() || !sameRuntimeScope(record.native.expectedHost, options.expectedHost) || !sameTarget(record.native.target, target) || options.windowID !== undefined && options.windowID !== record.native.windowID) throw new DesktopWriterError('required', 'not-dispatched');
  record.begin();
  let done = false;
  return {
    grantID: record.native.grantID, current: () => !done && record.current(),
    finish(outcome) { if (done) return; done = true; record.finish(outcome === 'unknown'); },
  };
}
