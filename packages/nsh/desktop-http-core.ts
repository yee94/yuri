import { runtimeScopeFrom, type RuntimeScope } from './runtime-scope';
import { beginDesktopWriterDispatch, desktopWriterNotDispatched, type DesktopWriterDispatch, type VerifiedDesktopWriterGrant } from './desktop-writer-core';

export type DesktopHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type DesktopHttpIdentity = Readonly<{ ownerID: string; requestID: string; windowID: string; expectedHost: RuntimeScope }>;
export type DesktopHttpResponse = { status: number; body: unknown };
export type DesktopHttpSource = {
  available: () => boolean;
  call: (name: 'runtime.http.capabilities' | 'runtime.http.request' | 'runtime.http.cancel', input: unknown, options: { timeout: number }) => Promise<unknown>;
};
type Capabilities = Readonly<{ version: 1; request: true; cancel: true; windowID: string; maxRequests: 4096; maxConcurrent: 8; timeoutMs: 30000 }>;
declare const granted: unique symbol;
export type DesktopHttpGrant = Capabilities & { readonly [granted]: true };
export const DESKTOP_HTTP_TIMEOUTS = Object.freeze({ capabilities: 5000, request: 40000, cancel: 10000 });
export class DesktopHttpError extends Error {
  constructor(
    readonly code: 'aborted' | 'stale' | 'invalid-request' | 'invalid-response' | 'native' | 'cancel-failed',
    readonly outcome: 'not-dispatched' | 'unknown' | 'cancel-acknowledged',
    readonly identity?: DesktopHttpIdentity,
    readonly original?: unknown,
  ) { super(`desktop_http_${code}`); this.name = code === 'aborted' ? 'AbortError' : 'DesktopHttpError'; }
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const grants = new WeakMap<DesktopHttpGrant, { source: DesktopHttpSource; current: () => boolean }>();
let namespace: string | undefined, sequence = 0;
function nextID() {
  // NSH 0.4's lazy standard crypto supplies randomUUID. No clock/Math.random fallback or counter reset.
  namespace ??= `http_${crypto.randomUUID()}`;
  if (sequence >= Number.MAX_SAFE_INTEGER) throw new DesktopHttpError('invalid-request', 'not-dispatched');
  return `${namespace}_${++sequence}`;
}

/** Only a successful call on the captured native source can issue a grant. Unsupported/failure is undefined. */
export async function loadDesktopHttpGrant(options: {
  source: () => DesktopHttpSource | undefined;
  current: () => boolean;
}): Promise<DesktopHttpGrant | undefined> {
  try {
    const source = options.source();
    if (!source?.available() || !options.current()) return undefined;
    let alive = true;
    const current = () => {
      if (!alive) return false;
      alive = options.current() && options.source() === source && source.available();
      return alive;
    };
    const value = await source.call('runtime.http.capabilities', {}, { timeout: DESKTOP_HTTP_TIMEOUTS.capabilities });
    if (!current() || !object(value) || Object.keys(value).sort().join(',') !== 'cancel,maxConcurrent,maxRequests,request,timeoutMs,version,windowID'
      || value.version !== 1 || value.request !== true || value.cancel !== true || !id(value.windowID)
      || value.maxRequests !== 4096 || value.maxConcurrent !== 8 || value.timeoutMs !== 30000) return undefined;
    const grant = Object.freeze({ ...value }) as DesktopHttpGrant;
    grants.set(grant, { source, current });
    return grant;
  } catch { return undefined; }
}

export type DesktopHttpClient = {
  readonly windowID: string;
  current: () => boolean;
  request: (input: { path: string; method?: DesktopHttpMethod; body?: unknown }, options?: { signal?: AbortSignal }) => Promise<DesktopHttpResponse>;
  /** Retire before dropping the owning operation; cancels only its original source/identity slots. */
  retire: () => Promise<void>;
};

/** No queue or HTTP engine here: all requests share the native actor's 8 jobs / 30-second policy. */
export function createDesktopHttpClient(options: {
  grant: DesktopHttpGrant | undefined;
  expectedHost: RuntimeScope;
  current: () => boolean;
  /** Mandatory error/unknown receipt seam, including cancel errors after a view/store has retired. Never logs. */
  onIssue: (error: DesktopHttpError) => void;
  writer?: () => VerifiedDesktopWriterGrant | null;
}): DesktopHttpClient | undefined {
  const captured = options.grant && grants.get(options.grant);
  let expectedHost: RuntimeScope | null;
  try { expectedHost = runtimeScopeFrom(options.expectedHost); } catch { return undefined; }
  if (!captured || !options.grant || !expectedHost || !options.current() || !captured.current()) return undefined;
  const { source } = captured, windowID = options.grant.windowID, ownerID = nextID();
  const scope = expectedHost;
  let alive = true;
  const current = () => {
    if (!alive) return false;
    alive = captured.current() && options.current();
    return alive;
  };
  const slots = new Map<string, { cancel: (reason: 'aborted' | 'stale') => Promise<void> }>();
  const report = (error: DesktopHttpError) => { try { options.onIssue(error); } catch { /* The rejecting request still preserves the failure. */ } };
  return {
    windowID, current,
    async request(input, requestOptions = {}) {
      if (!current()) throw new DesktopHttpError('stale', 'not-dispatched');
      const { signal } = requestOptions;
      if (signal?.aborted) throw new DesktopHttpError('aborted', 'not-dispatched');
      if (!input || Object.keys(input).some(key => !['path', 'method', 'body'].includes(key)) || typeof input.path !== 'string' || !input.path.startsWith('/')
        || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method ?? 'GET')) throw new DesktopHttpError('invalid-request', 'not-dispatched');
      let body: unknown;
      try { body = input.body === undefined ? undefined : JSON.parse(JSON.stringify(input.body)); }
      catch (cause) { throw new DesktopHttpError('invalid-request', 'not-dispatched', undefined, cause); }
      if (!current()) throw new DesktopHttpError('stale', 'not-dispatched');
      if (signal?.aborted) throw new DesktopHttpError('aborted', 'not-dispatched');
      const identity: DesktopHttpIdentity = Object.freeze({ ownerID, requestID: nextID(), windowID, expectedHost: scope });
      let permit: DesktopWriterDispatch | null;
      try { permit = beginDesktopWriterDispatch({ writer: options.writer, expectedHost: scope, windowID, path: input.path, method: input.method ?? 'GET', body }); }
      catch (cause) { throw new DesktopHttpError('invalid-request', 'not-dispatched', undefined, cause); }
      if (!current() || permit && !permit.current()) { permit?.finish('not-dispatched'); throw new DesktopHttpError('stale', 'not-dispatched'); }
      if (signal?.aborted) { permit?.finish('not-dispatched'); throw new DesktopHttpError('aborted', 'not-dispatched'); }
      const payload = { ...identity, path: input.path, ...(input.method ? { method: input.method } : {}), ...(body === undefined ? {} : { body }), ...(permit ? { writerGrant: permit.grantID } : {}) };
      return new Promise<DesktopHttpResponse>((resolve, reject) => {
        let done = false, dispatched = false, cancelling: Promise<void> | undefined;
        const cleanup = () => { done = true; signal?.removeEventListener('abort', abort); slots.delete(identity.requestID); };
        const fail = (error: DesktopHttpError) => { if (done) return; permit?.finish(!dispatched || desktopWriterNotDispatched(error.original) ? 'not-dispatched' : 'unknown'); cleanup(); reject(error); };
        const cancel = (reason: 'aborted' | 'stale'): Promise<void> => {
          if (cancelling) return cancelling;
          if (done) return Promise.resolve();
          // Set the cancelling marker before entering even a synchronously resolving native source.
          cancelling = Promise.resolve().then(async () => {
            try {
              const ack = await source.call('runtime.http.cancel', identity, { timeout: DESKTOP_HTTP_TIMEOUTS.cancel });
              if (!object(ack) || Object.keys(ack).length !== 1 || ack.ok !== true) throw new Error('invalid_cancel_ack');
              fail(new DesktopHttpError(reason, 'cancel-acknowledged', identity));
            } catch (cause) {
              const error = new DesktopHttpError('cancel-failed', 'unknown', identity, cause);
              report(error); fail(error); throw error;
            }
          });
          return cancelling;
        };
        const abort = () => { void cancel('aborted').catch(() => {}); };
        slots.set(identity.requestID, { cancel });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) { abort(); return; }
        let flight: Promise<unknown>;
        try { dispatched = true; flight = source.call('runtime.http.request', payload, { timeout: DESKTOP_HTTP_TIMEOUTS.request }); }
        catch (cause) { flight = Promise.reject(cause); }
        void flight.then(value => {
          if (done || cancelling) return;
          if (!current() || permit && !permit.current() || signal?.aborted) { void cancel(signal?.aborted ? 'aborted' : 'stale').catch(() => {}); return; }
          if (!object(value) || Object.keys(value).sort().join(',') !== 'body,status' || !Number.isInteger(value.status) || Number(value.status) < 100 || Number(value.status) > 599) {
            const error = new DesktopHttpError('invalid-response', 'unknown', identity);
            report(error); fail(error); return;
          }
          permit?.finish(Number(value.status) >= 200 && Number(value.status) < 300 ? 'confirmed' : 'unknown');
          cleanup(); resolve({ status: Number(value.status), body: value.body });
        }, cause => {
          if (done || cancelling) return;
          if (!current() || signal?.aborted) { void cancel(signal?.aborted ? 'aborted' : 'stale').catch(() => {}); return; }
          const busy = cause instanceof Error && cause.message === 'native_host_busy';
          const error = new DesktopHttpError('native', busy ? 'not-dispatched' : 'unknown', identity, cause);
          report(error); fail(error);
        });
      });
    },
    async retire() {
      alive = false;
      await Promise.all([...slots.values()].map(slot => slot.cancel('stale')));
    },
  };
}
