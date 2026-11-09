import type { DesktopWriterSource } from './desktop-writer-core';

export const writerTestScope = Object.freeze({ hostID: 'host-a', lease: 'lease-one' });
export const writerTestCapabilities = Object.freeze({ schemaVersion: 1, supported: true, acquire: true, release: true, renew: true, recovery: false, requiresExpectedHost: true, windowID: 'native-window-a', maxWriters: 64 });
export const writerNativeError = (message: string) => Object.assign(new Error(message), { code: 'ERR_NSH_HOST_ERROR' });
export function writerDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Row = { ownerID: string; target: unknown; windowID: string; expectedHost: unknown; grantID: string; authority: string; pending: number; unknown: boolean };
export class WriterTestLedger { rows = new Map<string, Row>(); sequence = 0; }
const key = (input: Record<string, unknown>) => JSON.stringify([writerTestScope.hostID, input.target]);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const fields = (input: Record<string, unknown>, allowed: string[], required = allowed) => {
  if (Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !(key in input))) throw writerNativeError('invalid_arguments');
};
/** Explicit synthetic producer. No default test host invents this capability. No network/Storage/UI. */
export class StrictWriterHost implements DesktopWriterSource {
  calls: { name: string; input: Record<string, unknown>; timeout?: number }[] = [];
  online = true;
  windowID = writerTestCapabilities.windowID as string;
  scope = { ...writerTestScope };
  authority = 'https://fixture.invalid|native-authorization-one';
  capability: unknown = writerTestCapabilities;
  errors: Record<string, unknown> = {};
  gates: Record<string, Promise<unknown> | undefined> = {};
  transform: ((name: string, value: unknown) => unknown) | undefined;
  runtimeReply: unknown = { status: 200, body: { ok: true } };
  legacyRuntime = false;
  constructor(readonly ledger = new WriterTestLedger()) {}
  available = () => this.online;
  call = async (name: string, raw: unknown, options?: { timeout: number }): Promise<unknown> => {
    const input = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
    this.calls.push({ name, input, timeout: options?.timeout });
    if (this.errors[name]) throw this.errors[name];
    let value: unknown;
    if (name === 'desktop.writer.capabilities') {
      fields(input, []); value = this.capability;
    } else if (name.startsWith('desktop.writer.')) {
      fields(input, ['ownerID', 'target', 'expectedHost', ...(name === 'desktop.writer.acquire' ? [] : ['grantID'])]);
      if (!same(input.expectedHost, this.scope)) throw writerNativeError('runtime_host_scope_stale');
      const identity = key(input), prior = this.ledger.rows.get(identity);
      if (name === 'desktop.writer.acquire' && !prior) {
        const row: Row = { ownerID: String(input.ownerID), target: input.target, expectedHost: input.expectedHost, windowID: this.windowID, grantID: `native_grant_${++this.ledger.sequence}`, authority: this.authority, pending: 0, unknown: false };
        this.ledger.rows.set(identity, row);
      } else {
        if (!prior) throw writerNativeError('writer_grant_stale');
        if (prior.unknown) throw writerNativeError('writer_unknown');
        if (prior.windowID !== this.windowID || prior.ownerID !== input.ownerID) throw writerNativeError('writer_conflict');
        if (name !== 'desktop.writer.acquire' && prior.grantID !== input.grantID) throw writerNativeError('writer_grant_stale');
        if (prior.authority !== this.authority) throw writerNativeError('writer_authority_changed');
        if (name === 'desktop.writer.renew') {
          if (prior.pending) throw writerNativeError('writer_pending');
          if (!same(prior.expectedHost, this.scope)) { prior.grantID = `native_grant_${++this.ledger.sequence}`; prior.expectedHost = { ...this.scope }; }
        } else if (!same(prior.expectedHost, this.scope)) throw writerNativeError('writer_scope_stale');
        if (name === 'desktop.writer.release') {
          if (prior.pending) throw writerNativeError('writer_pending');
          this.ledger.rows.delete(identity); value = { released: true, grantID: input.grantID };
        }
      }
      if (name !== 'desktop.writer.release') {
        const row = this.ledger.rows.get(identity)!;
        value = { schemaVersion: 1, ownerID: row.ownerID, windowID: row.windowID, target: row.target, expectedHost: row.expectedHost, grantID: row.grantID };
      }
    } else if (name === 'runtime.http.capabilities') {
      fields(input, []); value = { version: 1, request: true, cancel: true, windowID: this.windowID, maxRequests: 4096, maxConcurrent: 8, timeoutMs: 30000 };
    } else if (name === 'runtime.http.cancel') {
      fields(input, ['ownerID', 'requestID', 'windowID', 'expectedHost']);
      if (input.windowID !== this.windowID || !same(input.expectedHost, this.scope)) throw writerNativeError('http_receipt_stale');
      for (const row of this.ledger.rows.values()) if (row.pending && row.windowID === this.windowID) row.unknown = true;
      value = { ok: true };
    } else if (name === 'runtime.request' || name === 'runtime.http.request') {
      const identity = name === 'runtime.request' ? [] : ['ownerID', 'requestID', 'windowID'];
      fields(input, [...identity, 'expectedHost', 'path', 'method', 'body', 'writerGrant'], [...identity, 'path']);
      if (input.expectedHost && !same(input.expectedHost, this.scope)) throw writerNativeError('runtime_host_scope_stale');
      if (identity.length && input.windowID !== this.windowID) throw writerNativeError('http_receipt_stale');
      const row = [...this.ledger.rows.values()].find(row => row.grantID === input.writerGrant && row.windowID === this.windowID && same(row.expectedHost, this.scope));
      const path = String(input.path).split('?')[0];
      let target: unknown;
      if ((input.method ?? 'GET') !== 'GET') {
        if (path.startsWith('/api/session/')) target = { kind: 'session', id: decodeURIComponent(path.slice('/api/session/'.length).split('/')[0]) };
        else if (path.startsWith('/api/yuri/assistants/')) target = { kind: 'assistant', id: decodeURIComponent(path.slice('/api/yuri/assistants/'.length).split('/')[0]) };
        else if (path === '/api/session') target = { kind: 'new-session', id: (input.body as { location?: { directory?: unknown } })?.location?.directory };
      }
      if (!this.legacyRuntime && target && (!row || !same(row.target, target))) throw writerNativeError('writer_required');
      if (input.writerGrant && (!row || row.unknown)) throw writerNativeError('writer_not_owner');
      if (row) row.pending++;
      try { if (this.gates[name]) await this.gates[name]; value = this.runtimeReply; }
      finally { if (row) row.pending--; }
      return this.transform ? this.transform(name, value) : value;
    } else throw writerNativeError('unsupported_desktop_capability');
    if (this.gates[name]) await this.gates[name];
    return this.transform ? this.transform(name, value) : value;
  };
}
