import type { DesktopHttpSource } from './desktop-http-core';
import type { RuntimeScope } from './runtime-scope';

export const httpTestScope = Object.freeze({ hostID: 'synthetic', lease: '00000000-0000-4000-abcd-000000000001' });
export const httpTestCaps = Object.freeze({ version: 1, request: true, cancel: true, windowID: 'native-window', maxRequests: 4096, maxConcurrent: 8, timeoutMs: 30000 });
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Row = Record<string, unknown>;
function exact(value: unknown, allowed: string[], required = allowed): asserts value is Row {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error('strict_fake_payload');
}
export class StrictHttpHost implements DesktopHttpSource {
  calls: Array<{ name: string; input: Row; timeout: number }> = [];
  requests: Array<{ input: Row; reply: ReturnType<typeof deferred<unknown>>; started: boolean }> = [];
  capability: unknown = httpTestCaps;
  capabilityError: Error | undefined;
  capabilityGate: Promise<void> | undefined;
  cancelError: Error | undefined;
  cancelAck: unknown = { ok: true };
  cancelGate: Promise<void> | undefined;
  requestError: Error | undefined;
  holdStart = false;
  settleOnCancel = true;
  acceptedScope: RuntimeScope = httpTestScope;
  acceptedWindow = httpTestCaps.windowID;
  available = () => true;
  private seen = new Set<string>();
  private cancelled = new Set<string>();
  async call(name: Parameters<DesktopHttpSource['call']>[0], input: unknown, options: { timeout: number }): Promise<unknown> {
    if (name === 'runtime.http.capabilities') {
      exact(input, []); this.calls.push({ name, input, timeout: options.timeout });
      await this.capabilityGate;
      if (this.capabilityError) throw this.capabilityError;
      return this.capability;
    }
    const identity = ['ownerID', 'requestID', 'windowID', 'expectedHost'];
    exact(input, name === 'runtime.http.cancel' ? identity : [...identity, 'path', 'method', 'body'], name === 'runtime.http.cancel' ? identity : [...identity, 'path']);
    this.calls.push({ name, input, timeout: options.timeout });
    for (const field of ['ownerID', 'requestID', 'windowID']) if (typeof input[field] !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input[field])) throw new Error('http_receipt_invalid');
    if (input.windowID !== this.acceptedWindow || JSON.stringify(input.expectedHost) !== JSON.stringify(this.acceptedScope)) throw new Error('http_receipt_stale');
    const id = String(input.requestID);
    if (name === 'runtime.http.cancel') {
      await this.cancelGate;
      if (this.cancelError) throw this.cancelError;
      const prior = this.requests.find(row => row.input.requestID === id);
      if (prior && prior.input.ownerID !== input.ownerID) throw new Error('http_receipt_stale');
      this.cancelled.add(id);
      if (this.settleOnCancel) prior?.reply.reject(new Error('http_request_cancelled'));
      return this.cancelAck;
    }
    if (this.requestError) throw this.requestError;
    const row = { input, reply: deferred<unknown>(), started: false };
    this.requests.push(row);
    if (!this.holdStart) this.start(this.requests.length - 1);
    return row.reply.promise;
  }
  start(index: number) {
    const row = this.requests[index], id = String(row.input.requestID);
    if (this.seen.has(id)) { row.reply.reject(new Error('http_receipt_reused')); return; }
    this.seen.add(id);
    if (this.cancelled.has(id)) { row.reply.reject(new Error('http_request_cancelled')); return; }
    row.started = true;
  }
  reply(index: number, status: number, body: unknown) { this.requests[index].reply.resolve({ status, body }); }
}
export async function flushHttp() { for (let index = 0; index < 12; index++) await Promise.resolve(); }
