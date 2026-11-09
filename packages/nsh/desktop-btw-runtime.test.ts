import { expect, test, vi } from 'vitest';
import { createNativeBtwStore, type NativeBtwRuntime, type NativeBtwSelection } from './desktop-btw';
import { createDesktopBtwRuntime, DesktopBtwResponseError } from './desktop-btw-runtime';
import { DesktopHttpError, loadDesktopHttpGrant } from './desktop-http-core';
import { StrictHttpHost, flushHttp, httpTestScope } from './desktop-http-test-host';
import type { RuntimeScope } from './runtime-scope';

const target = { sessionId: 'session/a b', directory: '/workspace' };
async function fixture(host = new StrictHttpHost(), selected: NativeBtwSelection | null = { providerID: 'provider', modelID: 'model', variant: 'high', agent: 'agent' }) {
  let live = true, runtime: NativeBtwRuntime = { transport: 'native', generation: 1 }, scope: RuntimeScope | null = httpTestScope;
  const issues: Array<DesktopHttpError | DesktopBtwResponseError> = [];
  const grant = await loadDesktopHttpGrant({ source: () => host, current: () => live });
  const port = createDesktopBtwRuntime({ grant, expectedHost: httpTestScope, scope: target, runtime: () => runtime,
    runtimeScope: () => scope, current: () => live, onIssue: error => issues.push(error) });
  const signals: AbortSignal[] = [], remember = vi.fn();
  const store = createNativeBtwStore({ runtime: () => runtime, resolveSelection: () => selected, rememberSelection: remember,
    applySelection: async (captured, value, request) => { signals.push(request.signal); await port!.applySelection(captured, value, request); },
    generate: port ? async (captured, body, request) => { signals.push(request.signal); return port.generate(captured, body, request); } : undefined });
  const captured = store.captureScope(target);
  return { host, port, store, captured, issues, signals, remember, requestScope: { sessionID: target.sessionId, directory: target.directory, runtime },
    selection: (value: NativeBtwSelection | null) => { selected = value; },
    runtime: (value: NativeBtwRuntime) => { runtime = value; }, scope: (value: RuntimeScope | null) => { scope = value; }, retire: () => { live = false; } };
}
const paths = (f: Awaited<ReturnType<typeof fixture>>) => f.host.requests.map(row => row.input.path);
async function selectionAck(f: Awaited<ReturnType<typeof fixture>>, start = 0) {
  f.host.reply(start, 204, null); await flushHttp();
  f.host.reply(start + 1, 204, null); await flushHttp();
}

test('capability failure/bad capability leaves actual store unavailable and preserves quotes; no fallback sender', async () => {
  for (const kind of ['failure', 'bad']) {
    const host = new StrictHttpHost();
    if (kind === 'failure') host.capabilityError = new Error('ERR_ACCESS_DENIED'); else host.capability = { request: true, cancel: true };
    const f = await fixture(host);
    expect(f.port).toBeUndefined(); expect(f.store.available()).toBe(false);
    f.store.addQuote(target, 'keep'); expect(await f.store.ask(target, 'question')).toBe(false);
    expect(f.store.entry(target)).toEqual({ turns: [], quotes: ['keep'] }); expect(host.requests).toHaveLength(0);
    expect(host.calls.map(call => call.name)).toEqual(['runtime.http.capabilities']); f.store.dispose();
  }
});

test('real store applies captured SDK ModelRef/Agent then prompt-only generate with same signal; no main prompt/SSE/PTY', async () => {
  const original = { providerID: 'provider', modelID: 'first', variant: 'high', agent: 'first-agent' }, f = await fixture(undefined, original);
  expect(f.host.requests).toHaveLength(0); f.store.addQuote(target, 'quoted');
  const flight = f.store.ask(f.captured, 'side question');
  expect(f.host.requests[0].input.body).toEqual({ model: { providerID: 'provider', id: 'first', variant: 'high' } });
  original.modelID = 'mutated'; original.agent = 'later-agent'; original.variant = 'low';
  f.selection({ providerID: 'other', modelID: 'other' });
  f.host.reply(0, 204, null); await flushHttp(); expect(f.host.requests[1].input.body).toEqual({ agent: 'first-agent' });
  f.host.reply(1, 204, null); await flushHttp();
  const body = f.host.requests[2].input.body;
  expect(Object.keys(body as object)).toEqual(['prompt']); expect((body as { prompt: string }).prompt).toContain('> quoted');
  expect((body as { prompt: string }).prompt).toContain('side question');
  expect(paths(f)).toEqual(['model', 'agent', 'generate'].map(phase => `/api/session/session%2Fa%20b/${phase}`));
  expect(new Set(f.signals).size).toBe(1); expect(f.signals).toHaveLength(2);
  expect(new Set(f.host.requests.map(row => row.input.requestID)).size).toBe(3);
  expect(new Set(f.host.requests.map(row => row.input.ownerID)).size).toBe(1);
  f.host.reply(2, 200, { data: { text: 'side answer' } }); await flight;
  expect(f.store.entry(target).turns[0]).toMatchObject({ answer: 'side answer', pending: false, error: null });
  expect(f.host.calls.every(call => ['runtime.http.capabilities', 'runtime.http.request'].includes(call.name))).toBe(true);
  expect(f.issues).toEqual([]); f.store.dispose(); await f.port!.dispose();
});

test.each(['model', 'agent', 'generate'] as const)('non-2xx %s keeps raw response, stops later phases and never rolls back acknowledged configuration', async phase => {
  const f = await fixture(), flight = f.store.ask(f.captured, 'question');
  const index = ['model', 'agent', 'generate'].indexOf(phase);
  for (let i = 0; i < index; i++) { f.host.reply(i, 204, null); await flushHttp(); }
  const body = { error: 'synthetic conflict', diagnostic: { retained: true } }; f.host.reply(index, 409, body); await flight;
  expect(f.host.requests).toHaveLength(index + 1); expect(f.issues[0]).toBeInstanceOf(DesktopBtwResponseError);
  expect(f.issues[0]).toMatchObject({ phase, response: { status: 409, body } });
  expect(f.store.entry(target).turns[0]).toMatchObject({ pending: false, answer: '', error: `desktop_btw_${phase}_response_409` });
  expect(f.remember).not.toHaveBeenCalled(); f.store.dispose(); await f.port!.dispose();
});

test.each(['model', 'agent', 'generate'] as const)('cancelling during %s uses exact original receipt; late End cannot advance/revive the slot', async phase => {
  const f = await fixture(), flight = f.store.ask(f.captured, 'cancel');
  const index = ['model', 'agent', 'generate'].indexOf(phase);
  for (let i = 0; i < index; i++) { f.host.reply(i, 204, null); await flushHttp(); }
  f.host.settleOnCancel = false;
  f.store.cancel(f.captured); await flushHttp(); await flight;
  expect(f.signals[0].aborted).toBe(true);
  const request = f.host.requests[index].input, cancel = f.host.calls.find(call => call.name === 'runtime.http.cancel')!;
  expect(cancel.input).toEqual({ ownerID: request.ownerID, requestID: request.requestID, windowID: request.windowID, expectedHost: httpTestScope });
  f.host.reply(index, phase === 'generate' ? 200 : 204, phase === 'generate' ? { data: { text: 'late answer' } } : null); await flushHttp();
  expect(f.host.requests).toHaveLength(index + 1); expect(f.store.entry(target).turns[0]).toMatchObject({ pending: false, answer: '', error: null });
  expect(f.issues).toEqual([]); f.store.dispose(); await f.port!.dispose();
});

test('cancel-before-native-start never fetches model/Agent/generate; retry allocates new receipt identities', async () => {
  const host = new StrictHttpHost(); host.holdStart = true;
  const f = await fixture(host), flight = f.store.ask(f.captured, 'cancel before start');
  f.store.cancel(f.captured); await flushHttp(); host.start(0); await flight;
  expect(host.requests[0].started).toBe(false); expect(host.requests).toHaveLength(1);
  host.holdStart = false;
  const retry = f.store.retry(f.captured); await selectionAck(f, 1); host.reply(3, 200, { data: { text: 'retry answer' } }); await retry;
  expect(new Set(host.requests.map(row => row.input.requestID)).size).toBe(4);
  expect(f.store.entry(target).turns).toHaveLength(1); expect(f.store.entry(target).turns[0].answer).toBe('retry answer');
  f.store.dispose(); await f.port!.dispose();
});

test.each(['busy', 'cancel-failed'])('%s is not fake success; cancel failure remains observable after store slot retirement', async kind => {
  const f = await fixture();
  if (kind === 'busy') f.host.requestError = new Error('native_host_busy');
  const flight = f.store.ask(f.captured, 'failure');
  if (kind === 'cancel-failed') {
    f.host.cancelError = new Error('native_host_busy'); f.store.cancel(f.captured);
  }
  await flight; expect(f.issues).toHaveLength(1);
  expect(f.issues[0]).toMatchObject({ code: kind === 'busy' ? 'native' : 'cancel-failed', outcome: kind === 'busy' ? 'not-dispatched' : 'unknown' });
  expect(f.store.entry(target).turns[0].answer).toBe('');
  if (kind === 'cancel-failed') { f.host.reply(0, 204, null); await flushHttp(); }
  expect(f.host.requests).toHaveLength(kind === 'busy' ? 0 : 1); f.store.dispose(); await f.port!.dispose();
});

test.each(['lease', 'runtime', 'current', 'missing-scope'])('%s retirement fences selection continuation and keeps cancellation on original lease', async kind => {
  const f = await fixture(), flight = f.store.ask(f.captured, 'old operation');
  if (kind === 'lease') f.scope({ ...httpTestScope, lease: '00000000-0000-4000-abcd-000000000002' });
  if (kind === 'runtime') f.runtime({ transport: 'native', generation: 2 });
  if (kind === 'current') f.retire();
  if (kind === 'missing-scope') f.scope(null);
  expect(f.port!.current()).toBe(false);
  f.host.reply(0, 204, null); await flight;
  expect(f.host.requests).toHaveLength(1); expect(f.store.entry(target).turns[0].answer).toBe('');
  expect(f.host.calls.find(call => call.name === 'runtime.http.cancel')?.input.expectedHost).toEqual(httpTestScope);
  f.store.dispose(); await f.port!.dispose();
});

test('old unknown selection completion cannot overwrite a newer store slot; no compensating model rollback', async () => {
  const f = await fixture(); f.host.settleOnCancel = false;
  const old = f.store.ask(f.captured, 'old'), newer = f.store.ask(f.captured, 'new'); await flushHttp();
  await selectionAck(f, 1); f.host.reply(3, 200, { data: { text: 'new answer' } }); await newer;
  f.host.reply(0, 204, null); await old; await flushHttp();
  expect(f.host.requests).toHaveLength(4); expect(f.store.entry(target).turns.map(turn => turn.answer)).toEqual(['', 'new answer']);
  expect(paths(f).filter(path => String(path).endsWith('/model'))).toHaveLength(2); f.store.dispose(); await f.port!.dispose();
});

test('runtime port checks captured directory/session/runtime, SDK response envelope and status, without adding query fields', async () => {
  const f = await fixture(), controller = new AbortController();
  for (const patch of [{ directory: '/other' }, { sessionID: 'other' }, { runtime: { transport: 'native', generation: 0 } }]) {
    await expect(f.port!.generate({ ...f.requestScope, ...patch }, { sessionID: target.sessionId, prompt: 'q' }, { signal: controller.signal })).rejects.toMatchObject({ code: 'stale', outcome: 'not-dispatched' });
  }
  expect(f.host.requests).toHaveLength(0);
  for (const [status, body] of [[200, { text: 'not enveloped' }], [204, null], [200, { data: { text: 1 } }]] as const) {
    const flight = f.port!.generate(f.requestScope, { sessionID: target.sessionId, prompt: 'q' }, { signal: controller.signal });
    f.host.reply(f.host.requests.length - 1, status, body); await expect(flight).rejects.toBeInstanceOf(DesktopBtwResponseError);
  }
  f.store.dispose(); await f.port!.dispose();
});

test('default variant and absent Agent are omitted, not invented; generated SDK input stays prompt-only', async () => {
  const f = await fixture(undefined, { providerID: 'provider', modelID: 'model', variant: null });
  const flight = f.store.ask(f.captured, 'default');
  expect(f.host.requests[0].input.body).toEqual({ model: { providerID: 'provider', id: 'model' } });
  f.host.reply(0, 204, null); await flushHttp();
  expect(paths(f)).toEqual(['/api/session/session%2Fa%20b/model', '/api/session/session%2Fa%20b/generate']);
  f.host.reply(1, 200, { data: { text: 'answer' } }); await flight; f.store.dispose(); await f.port!.dispose();
});
