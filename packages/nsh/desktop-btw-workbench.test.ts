import { expect, test, vi } from 'vitest';
import { createDesktopBtwWorkbench } from './desktop-btw-workbench';
import { createNativeDesktopBtwHandle } from './desktop-btw-panel-core';
import { loadDesktopHttpGrant } from './desktop-http-core';
import { StrictHttpHost, flushHttp, httpTestScope } from './desktop-http-test-host';
import type { NativeLocalCommandInvocation } from './composer-local-commands';

async function fixture(supported = true) {
  const host = new StrictHttpHost();
  let live = true, interactive = true, present = false, generation = 1;
  let scope = { host: httpTestScope, authorityKey: 'stable-authority', sessionID: 'session', directory: '/workspace' };
  const grant = supported ? await loadDesktopHttpGrant({ source: () => host, current: () => live }) : undefined;
  const open = vi.fn(() => { present = true; return true; }), issues = vi.fn();
  const workbench = createDesktopBtwWorkbench({ grant: () => grant, runtime: () => ({ transport: 'native', generation }), runtimeScope: () => scope.host,
    scope: () => scope, current: expected => live && JSON.stringify(scope) === JSON.stringify(expected), interactive: () => interactive,
    selection: () => ({ providerID: 'provider', modelID: 'model', agent: 'build' }), open, present: () => present, onIssue: issues });
  const invocation = (tail = ''): NativeLocalCommandInvocation => ({ command: 'btw', tail, resourcePolicy: 'preserve', current: () => live && interactive,
    snapshot: { scope: { host: 'host', draft: 'draft', directory: '/workspace' }, authority: 'authority', target: { kind: 'session', id: 'session', directory: '/workspace' },
      revision: 1, text: '/btw ' + tail, inputMode: 'normal', active: true, ready: true, pending: false, unknown: false, sending: false, queueEditing: false,
      hasReferences: false, hasMessages: true, selection: { model: { providerID: 'provider', modelID: 'model' }, agent: 'build' } } });
  const mount = () => {
    const captured = { ...scope, host: { ...scope.host } };
    const handle = createNativeDesktopBtwHandle({ store: workbench.store, scope: workbench.scope(captured), current: () => live && scope.sessionID === captured.sessionID,
      active: () => true, interactive: () => interactive, visible: () => present, onClose: () => { present = false; } });
    return { handle, retire: workbench.publish(captured, handle) };
  };
  return { host, workbench, invocation, mount, open, issues, scope: () => scope,
    close() { present = false; workbench.reconcile(); }, cover() { interactive = false; workbench.reconcile(); },
    switch() { scope = { ...scope, sessionID: 'other' }; workbench.reconcile(); },
    nextGeneration() { generation++; workbench.reconcile(); },
    dispose() { live = false; workbench.dispose(); } };
}

test('only a real mounted handle admits a side question; model then agent then generate share one captured port', async () => {
  const f = await fixture(), pending = f.workbench.action.run(f.invocation('Side question'));
  expect(f.open).toHaveBeenCalledTimes(1); expect(f.host.requests).toHaveLength(0);
  const mounted = f.mount(); expect(await pending).toEqual({ status: 'accepted' });
  await flushHttp(); expect(f.host.requests[0].input).toMatchObject({ path: '/api/session/session/model', body: { model: { providerID: 'provider', id: 'model' } } });
  f.host.reply(0, 204, null); await flushHttp(); expect(f.host.requests[1].input.body).toEqual({ agent: 'build' });
  f.host.reply(1, 204, null); await flushHttp(); expect(f.host.requests[2].input.path).toBe('/api/session/session/generate');
  f.host.reply(2, 200, { data: { text: 'Only side answer' } }); await flushHttp();
  expect(f.workbench.store.entry(mounted.handle.scope).turns[0]).toMatchObject({ answer: 'Only side answer', pending: false });
  expect(new Set(f.host.requests.map(row => row.input.ownerID)).size).toBe(1); expect(f.issues).not.toHaveBeenCalled(); f.dispose();
});

test('bare command opens without generate; repeated opens dedupe to the same product handle', async () => {
  const f = await fixture(), pending = f.workbench.action.run(f.invocation()); f.mount();
  expect(await pending).toEqual({ status: 'accepted' }); expect(await f.workbench.action.run(f.invocation())).toEqual({ status: 'accepted' });
  expect(f.host.requests).toHaveLength(0); f.dispose();
});

test('closing the panel clears side state once; reopening the same mounted tab has a usable captured port', async () => {
  const f = await fixture(), pending = f.workbench.action.run(f.invocation()); const mounted = f.mount(); await pending;
  f.workbench.store.addQuote(mounted.handle.scope, 'Explicitly closed quote');
  const changed = vi.fn(), off = f.workbench.store.observe(mounted.handle.scope, changed);
  f.close(); expect(f.workbench.store.entry(mounted.handle.scope).quotes).toEqual([]);
  for (let index = 0; index < 50; index++) f.workbench.reconcile(); expect(changed).toHaveBeenCalledTimes(1);
  expect(await f.workbench.action.run(f.invocation('Reopened'))).toEqual({ status: 'accepted' }); await flushHttp();
  expect(f.host.requests).toHaveLength(1); expect(f.host.requests[0].input.path).toBe('/api/session/session/model');
  off(); f.dispose();
});

test.each(['close', 'cover', 'switch', 'nextGeneration', 'dispose'] as const)('%s releases an outstanding opening ticket; a late real mount never asks', async action => {
  const f = await fixture(), pending = f.workbench.action.run(f.invocation('Must never run'));
  f[action](); expect(await pending).toEqual({ status: 'rejected' });
  f.mount(); await flushHttp(); expect(f.host.requests).toHaveLength(0); f.dispose();
});

test('missing native grant, wrong target and concurrent opening cannot become available consumers', async () => {
  const unsupported = await fixture(false); expect(unsupported.workbench.available()).toBe(false);
  expect(await unsupported.workbench.action.run(unsupported.invocation('blocked'))).toEqual({ status: 'rejected' }); expect(unsupported.open).not.toHaveBeenCalled(); unsupported.dispose();
  const f = await fixture(), wrong = f.invocation(); wrong.snapshot.target.directory = '/wrong';
  expect(await f.workbench.action.run(wrong)).toEqual({ status: 'rejected' });
  const pending = f.workbench.action.run(f.invocation());
  expect(await f.workbench.action.run(f.invocation('second'))).toEqual({ status: 'rejected' });
  f.mount(); expect(await pending).toEqual({ status: 'accepted' }); expect(f.host.requests).toHaveLength(0); f.dispose();
});

test('closing a mounted pending side turn cancels only its exact request and clears its own entry', async () => {
  const f = await fixture(), pending = f.workbench.action.run(f.invocation('pending')); const mounted = f.mount(); await pending; await flushHttp();
  const request = f.host.requests[0].input; f.close(); await flushHttp();
  const cancel = f.host.calls.find(call => call.name === 'runtime.http.cancel');
  expect(cancel?.input).toEqual({ ownerID: request.ownerID, requestID: request.requestID, windowID: request.windowID, expectedHost: request.expectedHost });
  expect(f.workbench.store.entry(mounted.handle.scope).turns).toEqual([]); f.dispose();
});
