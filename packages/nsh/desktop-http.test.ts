import { expect, test, vi } from 'vitest';
import { createDesktopHttpClient, DESKTOP_HTTP_TIMEOUTS, DesktopHttpError, loadDesktopHttpGrant, type DesktopHttpGrant, type DesktopHttpSource } from './desktop-http-core';
import { StrictHttpHost, flushHttp, httpTestCaps, httpTestScope } from './desktop-http-test-host';

async function fixture(host = new StrictHttpHost()) {
  let live = true, source: DesktopHttpSource | undefined = host;
  const issues: DesktopHttpError[] = [];
  const grant = await loadDesktopHttpGrant({ source: () => source, current: () => live });
  const client = createDesktopHttpClient({ grant, expectedHost: httpTestScope, current: () => live, onIssue: error => issues.push(error) })!;
  return { host, grant, client, issues, retireScope: () => { live = false; }, source: (value: DesktopHttpSource | undefined) => { source = value; } };
}
test('capability loader never grants on unsupported, failure, malformed/forged capability or stale source', async () => {
  for (const value of [undefined, true, {}, { ...httpTestCaps, version: 2 }, { ...httpTestCaps, cancel: false }, { ...httpTestCaps, windowID: '' },
    { ...httpTestCaps, maxConcurrent: 9 }, { ...httpTestCaps, maxRequests: 0 }, { ...httpTestCaps, timeoutMs: 1 }, { ...httpTestCaps, extra: true }]) {
    const host = new StrictHttpHost(); host.capability = value;
    expect(await loadDesktopHttpGrant({ source: () => host, current: () => true })).toBeUndefined();
    expect(host.requests).toHaveLength(0);
  }
  const host = new StrictHttpHost(); host.capabilityError = new Error('ERR_ACCESS_DENIED');
  expect(await loadDesktopHttpGrant({ source: () => host, current: () => true })).toBeUndefined();
  expect(await loadDesktopHttpGrant({ source: () => undefined, current: () => true })).toBeUndefined();
  expect(createDesktopHttpClient({ grant: httpTestCaps as DesktopHttpGrant, expectedHost: httpTestScope, current: () => true, onIssue: () => {} })).toBeUndefined();
  let release!: () => void, current = true;
  host.capabilityError = undefined; host.capabilityGate = new Promise<void>(resolve => { release = resolve; });
  const pending = loadDesktopHttpGrant({ source: () => host, current: () => current }); current = false; release(); expect(await pending).toBeUndefined();
});
test('exact request/cancel identities and timeouts; body snapshot, raw non-2xx response and no replay IDs', async () => {
  const f = await fixture(); const body = { literal: 'original' };
  const first = f.client.request({ path: '/api/synthetic', method: 'POST', body }); body.literal = 'changed';
  expect(f.host.requests[0].input.body).toEqual({ literal: 'original' }); f.host.reply(0, 409, { error: 'conflict' });
  expect(await first).toEqual({ status: 409, body: { error: 'conflict' } });
  const controller = new AbortController(); const second = f.client.request({ path: '/api/synthetic' }, { signal: controller.signal });
  const result = second.catch(error => error); controller.abort(); await flushHttp();
  expect(await result).toMatchObject({ code: 'aborted', outcome: 'cancel-acknowledged' });
  const cancellation = f.host.calls.find(call => call.name === 'runtime.http.cancel')!;
  expect(cancellation.input).toEqual(Object.fromEntries(Object.entries(f.host.requests[1].input).filter(([key]) => ['ownerID', 'requestID', 'windowID', 'expectedHost'].includes(key))));
  expect(new Set(f.host.requests.map(row => row.input.requestID)).size).toBe(2);
  expect(f.host.calls.map(call => call.timeout)).toEqual([DESKTOP_HTTP_TIMEOUTS.capabilities, DESKTOP_HTTP_TIMEOUTS.request, DESKTOP_HTTP_TIMEOUTS.request, DESKTOP_HTTP_TIMEOUTS.cancel]);
  expect(f.issues).toEqual([]);
});
test('already-aborted sends nothing; cancel before native start prevents fetch and late End cannot resolve', async () => {
  const host = new StrictHttpHost(); host.holdStart = true; host.settleOnCancel = false;
  const f = await fixture(host), first = new AbortController(); first.abort();
  await expect(f.client.request({ path: '/api/synthetic' }, { signal: first.signal })).rejects.toMatchObject({ outcome: 'not-dispatched' });
  expect(host.requests).toHaveLength(0);
  const controller = new AbortController(); const flight = f.client.request({ path: '/api/synthetic' }, { signal: controller.signal }).catch(error => error);
  controller.abort(); await flushHttp(); host.start(0);
  expect(host.requests[0].started).toBe(false); expect(await flight).toMatchObject({ code: 'aborted' });
  host.reply(0, 200, { text: 'late' }); await flushHttp(); expect(f.issues).toEqual([]);
});
test('abort cancels only its original slot, cleans signal listeners and never cancels a completed request', async () => {
  const f = await fixture(), controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
  const first = f.client.request({ path: '/api/a' }, { signal: controller.signal });
  f.host.reply(0, 200, {}); await first; expect(remove).toHaveBeenCalledTimes(1);
  const secondController = new AbortController(); const next = f.client.request({ path: '/api/b' }, { signal: secondController.signal });
  controller.abort(); await flushHttp(); expect(f.host.calls.filter(call => call.name === 'runtime.http.cancel')).toHaveLength(0);
  f.host.reply(1, 200, { next: true }); expect(await next).toEqual({ status: 200, body: { next: true } });
});
test.each([new Error('native_host_busy'), new Error('ETIMEDOUT')])('cancel failure is unknown, reported exactly once and suppresses late success: %s', async failure => {
  const f = await fixture(); f.host.cancelError = failure;
  const controller = new AbortController(); const result = f.client.request({ path: '/api/synthetic' }, { signal: controller.signal }).catch(error => error);
  controller.abort(); await flushHttp(); const error = await result;
  expect(error).toMatchObject({ code: 'cancel-failed', outcome: 'unknown', original: failure }); expect(f.issues).toEqual([error]);
  f.host.reply(0, 200, { late: true }); await flushHttp(); expect(f.issues).toHaveLength(1);
  await f.client.retire(); expect(f.host.calls.filter(call => call.name === 'runtime.http.cancel')).toHaveLength(1);
});
test('invalid cancel ACK and native busy/malformed response are real errors, not empty success', async () => {
  const f = await fixture(); f.host.cancelAck = { ok: false };
  const controller = new AbortController(); const result = f.client.request({ path: '/api/synthetic' }, { signal: controller.signal }).catch(error => error);
  controller.abort(); expect(await result).toMatchObject({ code: 'cancel-failed', outcome: 'unknown' });
  f.host.requestError = new Error('native_host_busy');
  await expect(f.client.request({ path: '/api/busy' })).rejects.toMatchObject({ code: 'native', outcome: 'not-dispatched' });
  f.host.requestError = undefined; const invalid = f.client.request({ path: '/api/invalid' });
  f.host.requests[1].reply.resolve({ status: 200 }); await expect(invalid).rejects.toMatchObject({ code: 'invalid-response', outcome: 'unknown' });
});
test('source/operation changes fence pending results; retirement uses old identity even after new grant', async () => {
  const f = await fixture(); const result = f.client.request({ path: '/api/old' }).catch(error => error);
  const oldInput = f.host.requests[0].input; f.source(new StrictHttpHost());
  expect(f.client.current()).toBe(false);
  await f.client.retire(); expect(await result).toMatchObject({ code: 'stale', outcome: 'cancel-acknowledged' });
  expect(f.host.calls.find(call => call.name === 'runtime.http.cancel')?.input.requestID).toBe(oldInput.requestID);
  f.host.reply(0, 200, {}); await flushHttp();
  await expect(f.client.request({ path: '/api/retired' })).rejects.toMatchObject({ code: 'stale', outcome: 'not-dispatched' });
});
test('IDs never repeat across distinct clients/owners sharing the native lifetime', async () => {
  const f = await fixture(); const other = createDesktopHttpClient({ grant: f.grant, expectedHost: httpTestScope, current: () => true, onIssue: () => {} })!;
  const first = f.client.request({ path: '/api/a' }), second = other.request({ path: '/api/b' });
  f.host.reply(0, 200, {}); f.host.reply(1, 200, {}); await Promise.all([first, second]);
  expect(f.host.requests[0].input.ownerID).not.toBe(f.host.requests[1].input.ownerID);
  expect(f.host.requests[0].input.requestID).not.toBe(f.host.requests[1].input.requestID);
});

test.each(['lease', 'window'])('retired native %s rejects old cancel as unknown, never borrows new scope or identity', async kind => {
  const f = await fixture(), flight = f.client.request({ path: '/api/old' }).catch(error => error);
  const original = f.host.requests[0].input;
  if (kind === 'lease') f.host.acceptedScope = { ...httpTestScope, lease: '00000000-0000-4000-abcd-000000000002' };
  else f.host.acceptedWindow = 'new-window';
  f.retireScope();
  await expect(f.client.retire()).rejects.toMatchObject({ code: 'cancel-failed', outcome: 'unknown', original: new Error('http_receipt_stale') });
  expect(await flight).toBe(f.issues[0]);
  const cancel = f.host.calls.find(row => row.name === 'runtime.http.cancel')!;
  expect(cancel.input.expectedHost).toEqual(httpTestScope); expect(cancel.input.windowID).toBe(original.windowID); expect(cancel.input.requestID).toBe(original.requestID);
  f.host.reply(0, 200, { late: true }); await flushHttp(); expect(f.issues).toHaveLength(1);
});

test('abort while cancel ACK is pending wins over native completion and cleans the original signal once', async () => {
  const f = await fixture(), controller = new AbortController(), remove = vi.spyOn(controller.signal, 'removeEventListener');
  let release!: () => void; f.host.cancelGate = new Promise(resolve => { release = resolve; });
  const flight = f.client.request({ path: '/api/race' }, { signal: controller.signal }).catch(error => error);
  controller.abort(); f.host.reply(0, 200, { late: true }); await flushHttp();
  expect(remove).not.toHaveBeenCalled(); release();
  expect(await flight).toMatchObject({ code: 'aborted', outcome: 'cancel-acknowledged' }); expect(remove).toHaveBeenCalledTimes(1);
});

test('new window/lease grant allocates a new owner and request ID, never replays the old window request', async () => {
  const f = await fixture(), flight = f.client.request({ path: '/api/a' });
  f.host.reply(0, 200, null); await flight; await f.client.retire();
  const host = new StrictHttpHost(); host.acceptedWindow = 'next-window'; host.acceptedScope = { ...httpTestScope, lease: '00000000-0000-4000-abcd-000000000002' };
  host.capability = { ...httpTestCaps, windowID: host.acceptedWindow };
  const grant = await loadDesktopHttpGrant({ source: () => host, current: () => true });
  const next = createDesktopHttpClient({ grant, expectedHost: host.acceptedScope, current: () => true, onIssue: () => {} })!;
  const result = next.request({ path: '/api/b' }); host.reply(0, 200, null); await result;
  expect(host.requests[0].input.ownerID).not.toBe(f.host.requests[0].input.ownerID);
  expect(host.requests[0].input.requestID).not.toBe(f.host.requests[0].input.requestID);
  expect(host.requests[0].input.windowID).toBe('next-window'); expect(host.requests[0].input.expectedHost).toEqual(host.acceptedScope);
  await next.retire();
});

test.each(['source', 'operation'])('observed %s retirement is terminal even if the old callback/source reappears', async kind => {
  const f = await fixture(); let current = true;
  const client = createDesktopHttpClient({ grant: f.grant, expectedHost: httpTestScope, current: () => current, onIssue: () => {} })!;
  if (kind === 'source') f.source(undefined); else current = false;
  expect(client.current()).toBe(false);
  f.source(f.host); current = true;
  expect(client.current()).toBe(false);
  await expect(client.request({ path: '/api/never-revive' })).rejects.toMatchObject({ code: 'stale', outcome: 'not-dispatched' });
  expect(f.host.requests).toHaveLength(0); await client.retire();
});
