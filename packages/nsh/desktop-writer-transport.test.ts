import { beforeEach, expect, test, vi } from 'vitest';
import { type DesktopWriterTarget, type VerifiedDesktopWriterGrant } from './desktop-writer-core';
import { createDesktopHttpClient, loadDesktopHttpGrant } from './desktop-http-core';
import { StrictWriterHost, writerDeferred, writerNativeError, writerTestScope } from './desktop-writer-test-host';
import type { RuntimeScope } from './runtime-scope';

const h = vi.hoisted(() => ({ source: undefined as StrictWriterHost | undefined, desktop: true }));
vi.mock('nsh', () => ({
  platform: { get desktop() { return h.desktop; } },
  host: { available: () => h.source?.available() ?? false, call: (name: string, body: unknown, options?: { timeout: number }) => h.source!.call(name, body, options) },
}));
import { bindRequest, bindRawRequest } from './runtime';
import { loadNativeDesktopWriterClient } from './desktop-writer';
beforeEach(() => { h.source = undefined; h.desktop = true; });

async function fixture(target: DesktopWriterTarget = { kind: 'session', id: 'session/a' }) {
  const host = h.source = new StrictWriterHost();
  const client = (await loadNativeDesktopWriterClient({ current: () => true }))!;
  const owner = client.claim({ target, expectedHost: writerTestScope, current: () => true }); await owner.ready();
  return { host, client, owner };
}
test('native adapter does zero discovery on iOS; unavailable/partial desktop support never installs a writer', async () => {
  const host = h.source = new StrictWriterHost(); h.desktop = false;
  expect(await loadNativeDesktopWriterClient({ current: () => true })).toBeUndefined(); expect(host.calls).toEqual([]);
  host.legacyRuntime = true;
  await bindRequest(writerTestScope)('/api/session/s/prompt', 'POST', { literal: true });
  expect(host.calls.map(row => row.name)).toEqual(['runtime.request']); expect(host.calls[0].input).not.toHaveProperty('writerGrant');
  h.desktop = true; host.capability = {};
  expect(await loadNativeDesktopWriterClient({ current: () => true })).toBeUndefined();
  expect(host.calls.filter(row => row.name === 'desktop.writer.acquire')).toHaveLength(0);
});
test('actual runtime preserves path/query/method/body/scope and adds only native grantID to the envelope', async () => {
  const f = await fixture(), send = bindRawRequest(writerTestScope, f.owner.grant);
  const body = { messageID: 'm1', parts: [{ type: 'text', text: 'literal' }] };
  expect(await send('/api/session/session%2Fa/prompt?directory=%2Fworkspace', 'post', body)).toEqual({ status: 200, body: { ok: true } });
  expect(f.host.calls.at(-1)?.input).toEqual({ path: '/api/session/session%2Fa/prompt?directory=%2Fworkspace', method: 'POST', body, expectedHost: writerTestScope, writerGrant: 'native_grant_1' });
  expect(body).not.toHaveProperty('writerGrant'); expect(f.owner.status().pending).toBe(0); expect(f.owner.canRelease()).toBe(true);
});
test('GET/goal-get/unrelated settings never read the writer getter or acquire from route paths', async () => {
  const host = h.source = new StrictWriterHost(), getter = vi.fn(() => { throw Error('must not read'); });
  const send = bindRequest(writerTestScope, getter);
  await send('/api/session/s/message?directory=%2Fx');
  await send('/api/rpc/opencode.goal/get?location%5Bdirectory%5D=%2Fx', 'POST', { input: { sessionID: 's' } });
  await send('/api/config/settings', 'PUT', { appearance: 'same' });
  expect(getter).not.toHaveBeenCalled(); expect(host.calls).toHaveLength(3); expect(host.calls.every(row => !('writerGrant' in row.input))).toBe(true);
});
test('missing seam still reaches the real native fail-closed gate; null/forged/borrowed target with a seam is zero native dispatch', async () => {
  const f = await fixture(); await expect(bindRequest(writerTestScope)('/api/session/session%2Fa/prompt', 'POST')).rejects.toThrow('writer_required');
  const count = f.host.calls.length, grant = f.owner.grant()!;
  for (const getter of [() => null, () => ({ ...grant }) as VerifiedDesktopWriterGrant, () => 'native_grant_1' as unknown as VerifiedDesktopWriterGrant]) {
    await expect(bindRequest(writerTestScope, getter)('/api/session/session%2Fa/prompt', 'POST')).rejects.toThrow('desktop_writer_required');
  }
  await expect(bindRequest(writerTestScope, f.owner.grant)('/api/session/other/prompt', 'POST')).rejects.toThrow();
  await expect(bindRequest({ ...writerTestScope, lease: 'old' }, f.owner.grant)('/api/session/session%2Fa/prompt', 'POST')).rejects.toThrow();
  expect(f.host.calls).toHaveLength(count);
});
test('runtime tracks pending and invalid/late/unknown mutation response cannot release or auto retry', async () => {
  for (const kind of ['malformed', 'late', 'network'] as const) {
    const f = await fixture(), gate = writerDeferred(); f.host.gates['runtime.request'] = gate.promise;
    const flight = bindRequest(writerTestScope, f.owner.grant)('/api/session/session%2Fa/prompt', 'POST').catch(error => error);
    expect(f.owner.status().pending).toBe(1); expect(await f.owner.release({ allowed: () => true })).toBe(false);
    if (kind === 'malformed') f.host.runtimeReply = { status: 200 };
    if (kind === 'late') f.owner.retire();
    if (kind === 'network') gate.reject(new Error('ETIMEDOUT')); else gate.resolve();
    expect(await flight).toBeInstanceOf(Error); expect(f.owner.status()).toMatchObject({ pending: 0, unknown: true, hasGrant: true });
    const count = f.host.calls.length; await f.owner.release({ allowed: () => true }); expect(f.host.calls).toHaveLength(count);
  }
});
test('domain invalid ACK can mark a transport-complete 2xx unknown; ordinary busy lookalike cannot prove no dispatch', async () => {
  const f = await fixture(); await bindRequest(writerTestScope, f.owner.grant)('/api/session/session%2Fa/prompt', 'POST');
  f.owner.markUnknown(new Error('domain_bad_ack')); expect(f.owner.canRelease()).toBe(false); expect(f.owner.grant()).toBeNull();
  for (const strict of [true, false]) {
    const next = await fixture(); next.host.errors['runtime.request'] = strict ? writerNativeError('native_host_busy') : new Error('native_host_busy');
    await expect(bindRequest(writerTestScope, next.owner.grant)('/api/session/session%2Fa/prompt', 'POST')).rejects.toThrow('native_host_busy');
    expect(next.owner.status().unknown).toBe(!strict);
  }
});
test('HTTP dispatch carries same verified writer; cancellation keeps original four-field identity and writer unknown survives native cancel ACK', async () => {
  const f = await fixture(), gate = writerDeferred(); f.host.gates['runtime.http.request'] = gate.promise;
  const cap = await loadDesktopHttpGrant({ source: () => f.host, current: () => true });
  const issues: unknown[] = [];
  const http = createDesktopHttpClient({ grant: cap, expectedHost: writerTestScope, current: () => true, onIssue: error => issues.push(error), writer: f.owner.grant })!;
  const abort = new AbortController(); const flight = http.request({ path: '/api/session/session%2Fa/generate', method: 'POST', body: { prompt: 'literal' } }, { signal: abort.signal }).catch(error => error);
  const request = f.host.calls.at(-1)!.input; expect(request.writerGrant).toBe('native_grant_1'); expect(f.owner.status().pending).toBe(1);
  abort.abort(); const result = await flight; expect(result).toMatchObject({ outcome: 'cancel-acknowledged', code: 'aborted' });
  const cancel = f.host.calls.at(-1)!.input;
  expect(cancel).toEqual({ ownerID: request.ownerID, requestID: request.requestID, windowID: request.windowID, expectedHost: writerTestScope });
  expect(f.owner.status()).toMatchObject({ pending: 0, unknown: true, hasGrant: true }); expect(issues).toEqual([]);
  gate.resolve(); await Promise.resolve(); expect(await f.owner.release({ allowed: () => true })).toBe(false);
});
test('HTTP rejects borrowed native-window grant before dispatch and leaves GET/goal envelopes unchanged', async () => {
  const f = await fixture(); f.host.windowID = 'different-native-window';
  const cap = await loadDesktopHttpGrant({ source: () => f.host, current: () => true });
  const getter = vi.fn(f.owner.grant), http = createDesktopHttpClient({ grant: cap, expectedHost: writerTestScope, current: () => true, onIssue: () => {}, writer: getter })!;
  const count = f.host.calls.length;
  await expect(http.request({ path: '/api/session/session%2Fa/prompt', method: 'POST' })).rejects.toMatchObject({ code: 'invalid-request', outcome: 'not-dispatched' }); expect(f.host.calls).toHaveLength(count);
  getter.mockClear();
  await http.request({ path: '/api/session/s/message' }); await http.request({ path: '/api/rpc/opencode.goal/get', method: 'POST', body: { input: { sessionID: 's' } } });
  expect(getter).not.toHaveBeenCalled(); expect(f.host.calls.slice(-2).every(row => !('writerGrant' in row.input))).toBe(true);
});
test('actual runtime old lane is rejected after renew; new captured lease uses new grant without changing target or draft owner', async () => {
  const f = await fixture(), oldLane = bindRequest(writerTestScope, f.owner.grant);
  f.host.scope = { ...writerTestScope, lease: 'lease-two' }; await f.owner.renew({ expectedHost: f.host.scope });
  const count = f.host.calls.length;
  await expect(oldLane('/api/session/session%2Fa/prompt', 'POST')).rejects.toThrow(); expect(f.host.calls).toHaveLength(count);
  await bindRequest(f.host.scope, f.owner.grant)('/api/session/session%2Fa/prompt', 'POST');
  expect(f.host.calls.at(-1)?.input).toMatchObject({ expectedHost: f.host.scope, writerGrant: 'native_grant_2' });
});

test('new-session explicit directory claim creates once; only an explicit real session claim ACK permits releasing the original draft grant', async () => {
  const f = await fixture({ kind: 'new-session', id: '/workspace' });
  await bindRequest(writerTestScope, f.owner.grant)('/api/session', 'POST', { location: { directory: '/workspace' } });
  const count = f.host.calls.length;
  await expect(bindRequest(writerTestScope, f.owner.grant)('/api/session', 'POST', { location: { directory: '/wrong' } })).rejects.toThrow(); expect(f.host.calls).toHaveLength(count);
  expect(f.host.ledger.rows.size).toBe(1);
  const gate = writerDeferred(); f.host.gates['desktop.writer.acquire'] = gate.promise;
  const session = f.client.claim({ target: { kind: 'session', id: 'authoritative-session-id' }, expectedHost: writerTestScope, current: () => true });
  expect(session.grant()).toBeNull(); expect(f.owner.grant()).not.toBeNull();
  gate.resolve(); expect(await session.ready()).not.toBeNull();
  expect(await f.owner.release({ allowed: () => !!session.grant() })).toBe(true);
  expect(f.host.ledger.rows.size).toBe(1); expect(session.grant()).not.toBeNull(); expect(session.ownerID).not.toBe(f.owner.ownerID);
});

test.each([201, 400, 503])('both transports preserve status/body and settle pending without treating HTTP %i as a domain ACK', async status => {
  for (const kind of ['runtime', 'http'] as const) {
    const f = await fixture(), body = { message: 'synthetic-response' };
    f.host.runtimeReply = { status, body };
    const cap = await loadDesktopHttpGrant({ source: () => f.host, current: () => true });
    const http = createDesktopHttpClient({ grant: cap, expectedHost: writerTestScope, current: () => true, onIssue: () => {}, writer: f.owner.grant })!;
    const result = kind === 'runtime'
      ? await bindRawRequest(writerTestScope, f.owner.grant)('/api/session/session%2Fa/prompt', 'POST')
      : await http.request({ path: '/api/session/session%2Fa/prompt', method: 'POST' });
    expect(result).toEqual({ status, body }); expect(f.owner.status()).toMatchObject({ pending: 0, unknown: status !== 201 });
    expect(f.owner.canRelease()).toBe(status === 201);
  }
});
test.each(['malformed', 'network', 'cancel-failed', 'bad-cancel', 'stale-error'])('HTTP %s keeps the original result semantics while fencing writer and settling pending once', async kind => {
  const f = await fixture(), gate = writerDeferred(); f.host.gates['runtime.http.request'] = gate.promise;
  const cap = await loadDesktopHttpGrant({ source: () => f.host, current: () => true });
  const issues: unknown[] = [], http = createDesktopHttpClient({ grant: cap, expectedHost: writerTestScope, current: () => true, onIssue: error => issues.push(error), writer: f.owner.grant })!;
  const abort = new AbortController();
  const flight = http.request({ path: '/api/session/session%2Fa/prompt', method: 'POST' }, { signal: abort.signal }).catch(error => error);
  expect(f.owner.status().pending).toBe(1);
  if (kind === 'malformed') { f.host.runtimeReply = { status: 200, body: {}, extra: true }; gate.resolve(); }
  else if (kind === 'network' || kind === 'stale-error') gate.reject(kind === 'network' ? new Error('ETIMEDOUT') : writerNativeError('runtime_host_scope_stale'));
  else {
    if (kind === 'cancel-failed') f.host.errors['runtime.http.cancel'] = new Error('synthetic-cancel-failure');
    else f.host.transform = (name, value) => name === 'runtime.http.cancel' ? { ok: false } : value;
    abort.abort();
  }
  expect(await flight).toMatchObject({ outcome: 'unknown', code: kind === 'malformed' ? 'invalid-response' : kind.startsWith('cancel') || kind === 'bad-cancel' ? 'cancel-failed' : 'native' });
  expect(issues).toHaveLength(1); expect(f.owner.status()).toMatchObject({ pending: 0, unknown: true, hasGrant: true });
  gate.resolve(); await Promise.resolve(); expect(f.owner.status().pending).toBe(0);
  const count = f.host.calls.length;
  expect(await f.owner.renew({ expectedHost: { ...writerTestScope, lease: 'lease-two' } })).toBeNull();
  expect(await f.owner.release({ allowed: () => true })).toBe(false); expect(f.host.calls).toHaveLength(count);
});
test('HTTP renew rebind rejects the old lane and uses the same owner with the new grant, never reacquiring', async () => {
  const f = await fixture(), cap = await loadDesktopHttpGrant({ source: () => f.host, current: () => true });
  const lane = (expectedHost: RuntimeScope) => createDesktopHttpClient({ grant: cap, expectedHost, current: () => true, onIssue: () => {}, writer: f.owner.grant })!;
  const old = lane(writerTestScope), ownerID = f.owner.ownerID;
  f.host.scope = { ...writerTestScope, lease: 'lease-two' }; await f.owner.renew({ expectedHost: f.host.scope });
  const count = f.host.calls.length;
  await expect(old.request({ path: '/api/session/session%2Fa/prompt', method: 'POST' })).rejects.toMatchObject({ outcome: 'not-dispatched' });
  expect(f.host.calls).toHaveLength(count);
  await lane(f.host.scope).request({ path: '/api/session/session%2Fa/prompt', method: 'POST', body: { exact: true } });
  expect(f.host.calls.at(-1)?.input).toMatchObject({ expectedHost: f.host.scope, writerGrant: 'native_grant_2', body: { exact: true } });
  expect(f.owner.ownerID).toBe(ownerID); expect(f.host.calls.filter(row => row.name === 'desktop.writer.acquire')).toHaveLength(1);
});
test('pre-dispatch subscriber veto or abort settles pending without any native request or unknown', async () => {
  for (const kind of ['runtime-retire', 'http-retire', 'http-abort'] as const) {
    const f = await fixture(), abort = new AbortController();
    const cap = await loadDesktopHttpGrant({ source: () => f.host, current: () => true });
    const http = createDesktopHttpClient({ grant: cap, expectedHost: writerTestScope, current: () => true, onIssue: () => {}, writer: f.owner.grant })!;
    f.owner.subscribe(() => { if (f.owner.status().pending) { if (kind === 'http-abort') abort.abort(); else f.owner.retire(); } });
    const count = f.host.calls.length;
    const flight = kind === 'runtime-retire'
      ? bindRawRequest(writerTestScope, f.owner.grant)('/api/session/session%2Fa/prompt', 'POST')
      : http.request({ path: '/api/session/session%2Fa/prompt', method: 'POST' }, { signal: abort.signal });
    await expect(flight).rejects.toMatchObject({ outcome: 'not-dispatched' });
    expect(f.host.calls).toHaveLength(count); expect(f.owner.status()).toMatchObject({ pending: 0, unknown: false });
  }
});
