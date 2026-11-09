import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { PageOperation } from './page-operations';
import type { RuntimeScope } from './runtime-scope';
import { StrictWriterHost, writerDeferred, writerNativeError, writerTestScope } from './desktop-writer-test-host';

const h = vi.hoisted(() => {
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  return { signal, call: vi.fn(), get: vi.fn(), set: vi.fn(), storage: new Map<string, string>(), desktop: true,
    connection: signal({ id: 'host-a', url: 'https://fixture.invalid', authorizationID: 'native-authorization-one' }), scope: signal({ hostID: 'host-a', lease: 'lease-one' }),
    op: undefined as unknown, active: true, lifecycle: 'active', cleanups: [] as Array<() => void>, trace: [] as string[] };
});
vi.mock('nsh', () => ({ signal: h.signal, batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  effect: (work: () => void) => { work(); }, cleanup: (work: () => void) => h.cleanups.push(work), lifecycle: () => h.lifecycle,
  platform: { get desktop() { return h.desktop; }, get os() { return h.desktop ? 'macos' : 'ios'; } },
  host: { available: () => true, call: h.call }, Storage: { getItem: h.get, setItem: h.set } }));
vi.mock('./state', () => ({
  app: { connection: h.connection, runtimeScope: h.scope }, epoch: () => 1, captureHostOperation: () => h.op,
  captureHostRequest: () => (h.op as PageOperation).request, isCurrentHostScope: () => h.active,
}));

beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); h.storage.clear(); h.trace = []; h.cleanups = []; h.desktop = true; h.active = true; h.lifecycle = 'active';
  h.connection.set({ id: 'host-a', url: 'https://fixture.invalid', authorizationID: 'native-authorization-one' }); h.scope.set({ ...writerTestScope });
  h.get.mockReset().mockImplementation(async key => { h.trace.push('restore'); return h.storage.get(key) ?? null; });
  h.set.mockReset().mockImplementation(async (key, value) => { h.trace.push('persist'); h.storage.set(key, value); });
});
afterEach(() => { h.cleanups.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

async function fixture() {
  const host: Omit<StrictWriterHost, 'scope'> & { scope: RuntimeScope } = new StrictWriterHost();
  let authority: Record<string, unknown> = { id: 'session/created', location: { directory: '/canonical' } };
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'runtime.request') {
      const path = String(input.path), verb = input.method ?? 'GET';
      h.trace.push(verb + ':' + path);
      let body: unknown;
      if (path.startsWith('/api/fs/list?')) body = { path: '/canonical', entries: [] };
      else if (path === '/api/session') body = authority;
      else if (path.includes('/model?')) { authority = { ...authority, model: input.body.model }; body = null; }
      else if (path.includes('/agent?')) { authority = { ...authority, agent: input.body.agent }; body = null; }
      else if (path.startsWith('/api/session/session%2Fcreated?')) body = authority;
      else throw new Error('Unexpected synthetic request: ' + path);
      host.runtimeReply = { status: 200, body };
      return host.call(name, input);
    }
    h.trace.push(name);
    return host.call(name, input);
  });
  const { loadDesktopWriterClient } = await import('./desktop-writer-core');
  const client = (await loadDesktopWriterClient({ source: () => host, current: () => true }))!;
  const { bindRequest } = await import('./runtime');
  function operation(): PageOperation {
    const scope = h.scope();
    return Object.freeze({ scope, generation: 1, hostID: scope.hostID, current: () => h.active && h.scope() === scope,
      request: bindRequest(scope) });
  }
  h.op = operation();
  const api = await import('./new-session'), writer = await import('./new-session-writer');
  const admission = writer.createNewSessionWriterAdmission({ client, operation: h.op as PageOperation, directory: '/selected-link', current: () => h.connection().id === writerTestScope.hostID });
  const open = async () => {
    const desktopWriter = await admission.ready(); expect(desktopWriter).not.toBeNull();
    const entry = api.createNativeNewSessionOwnership({ directory: desktopWriter!.directory, desktopWriter: desktopWriter!, active: () => h.active, operation: () => h.op as PageOperation });
    await entry.owner.ready; return entry;
  };
  return { host, client, api, writer, admission, open, operation, authority: (value: Record<string, unknown>) => { authority = value; } };
}

test('desktop factory refuses before openDraft/Storage without a real admitted original claim', async () => {
  const f = await fixture();
  expect(() => f.api.openNativeNewSession({ directory: '/canonical', active: () => true })).toThrow('writer-required');
  expect(h.get).not.toHaveBeenCalled(); expect(h.set).not.toHaveBeenCalled();
  const receipt = await f.admission.ready();
  expect(() => f.api.openNativeNewSession({ directory: '/canonical', desktopWriter: { ...receipt! }, active: () => true })).toThrow('writer-required');
  expect(h.get).not.toHaveBeenCalled();
});

test('canonical GET and native acquire ACK precede all durable restore; one admission, 50 inputs, zero additional capability/claim IO', async () => {
  const f = await fixture(), gate = writerDeferred(); f.host.gates['desktop.writer.acquire'] = gate.promise;
  const pending = f.admission.ready(); expect(f.admission.ready()).toBe(pending);
  await Promise.resolve(); await Promise.resolve();
  expect(h.get).not.toHaveBeenCalled(); expect(f.admission.admitted()).toBeNull();
  gate.resolve(); const entry = await f.open();
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.acquire')).toHaveLength(1);
  expect(f.host.calls.find(row => row.name === 'desktop.writer.acquire')!.input.target).toEqual({ kind: 'new-session', id: '/canonical' });
  const count = f.host.calls.length;
  for (let index = 0; index < 50; index++) { entry.owner.setDraftText('input ' + index); f.admission.admitted(); f.admission.snapshot(); }
  expect(f.host.calls).toHaveLength(count); expect(f.host.calls.filter(row => row.name === 'desktop.writer.capabilities')).toHaveLength(1);
  await entry.disposePage(); expect(entry.released()).toBe(true);
  expect(f.host.calls.at(-1)?.name).toBe('desktop.writer.release');
});

test.each([writerNativeError('writer_conflict'), new Error('writer_conflict'), new Error('synthetic timeout')])('denied/unknown acquisition is readonly, no durable access/retry/automatic release: %s', async error => {
  const f = await fixture(); f.host.errors['desktop.writer.acquire'] = error;
  expect(await f.admission.ready()).toBeNull(); await f.admission.ready();
  expect(h.get).not.toHaveBeenCalled(); expect(h.set).not.toHaveBeenCalled();
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.acquire')).toHaveLength(1);
  expect(await f.admission.close({ allowed: () => true })).toBe(false);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
});

test('late acquisition is not restored or published after retirement; explicit safe close settles original ACK before release', async () => {
  const f = await fixture(), gate = writerDeferred(); f.host.gates['desktop.writer.acquire'] = gate.promise;
  const pending = f.admission.ready();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  const close = f.admission.close({ allowed: () => true }); gate.resolve();
  expect(await pending).toBeNull(); expect(await close).toBe(true); expect(h.get).not.toHaveBeenCalled();
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(1);
});

test('waiting guard revalidates safe no-authority and cancel; prepared release is only a zero-IO noop', async () => {
  const f = await fixture(); let alive = true;
  const guard = f.writer.createNewSessionWriterAdmissionGuard({ current: () => alive, safe: f.admission.safeToLeave });
  const calls = f.host.calls.length;
  expect(guard.current()).toBe(true); expect(guard.canClose()).toBe(false); expect(await guard.release()).toBe(false);
  expect(await guard.prepare()).toBe(true); expect(guard.canClose()).toBe(true); expect(await guard.release()).toBe(true);
  guard.cancel(); expect(guard.canClose()).toBe(false); expect(await guard.release()).toBe(false);
  expect(await guard.prepare()).toBe(true); alive = false;
  expect(guard.current()).toBe(false); expect(guard.canClose()).toBe(false); expect(await guard.release()).toBe(false);
  expect(f.host.calls).toHaveLength(calls); expect(h.get).not.toHaveBeenCalled();
});

test('resolve/acquire and ACK-before-source veto waiting guard, including acquisition starting after safe prepare', async () => {
  const f = await fixture(), resolveGate = writerDeferred(), acquireGate = writerDeferred();
  f.host.gates['runtime.request'] = resolveGate.promise; f.host.gates['desktop.writer.acquire'] = acquireGate.promise;
  const guard = f.writer.createNewSessionWriterAdmissionGuard({ current: () => true, safe: f.admission.safeToLeave });
  expect(await guard.prepare()).toBe(true);
  const ready = f.admission.ready(); expect(f.admission.snapshot().phase).toBe('resolving');
  expect(guard.canClose()).toBe(false); expect(await guard.release()).toBe(false); expect(await guard.prepare()).toBe(false);
  resolveGate.resolve(); for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(f.admission.snapshot().phase).toBe('acquiring'); expect(await guard.prepare()).toBe(false);
  expect(await guard.release()).toBe(false); acquireGate.resolve(); const value = await ready;
  expect(value?.claim.status().hasGrant).toBe(true); expect(f.admission.snapshot().phase).toBe('ready');
  expect(await guard.prepare()).toBe(false); expect(guard.canClose()).toBe(false); expect(await guard.release()).toBe(false);
  expect(h.get).not.toHaveBeenCalled(); expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
  expect(await f.admission.close({ allowed: () => true })).toBe(true);
});

test.each([
  [writerNativeError('writer_conflict'), true],
  [writerNativeError('writer_unsupported'), true],
  [new Error('synthetic lost ACK'), false],
] as const)('waiting guard distinguishes denied zero-held claim from unknown without cleanup IO: %s', async (error, safe) => {
  const f = await fixture(); f.host.errors['desktop.writer.acquire'] = error; await f.admission.ready();
  const guard = f.writer.createNewSessionWriterAdmissionGuard({ current: () => true, safe: f.admission.safeToLeave });
  expect(await guard.prepare()).toBe(safe); expect(guard.canClose()).toBe(safe); expect(await guard.release()).toBe(safe);
  guard.cancel(); expect(guard.canClose()).toBe(false);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.acquire')).toHaveLength(1);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0); expect(h.get).not.toHaveBeenCalled();
});

test('unsupported/missing client and failed canonical read have no claim and allow guarded no-authority departure', async () => {
  const f = await fixture();
  const missing = f.writer.createNewSessionWriterAdmission({ client: undefined, operation: h.op as PageOperation, directory: '/selected', current: () => true });
  await missing.ready(); expect(missing.safeToLeave()).toBe(true);
  f.host.errors['runtime.request'] = new Error('synthetic canonical read failure'); await f.admission.ready();
  const guard = f.writer.createNewSessionWriterAdmissionGuard({ current: () => true, safe: f.admission.safeToLeave });
  expect(await guard.prepare()).toBe(true); expect(await guard.release()).toBe(true);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.acquire')).toHaveLength(0); expect(h.get).not.toHaveBeenCalled();
});

test('stale/late held ACK remains protected until real final destruction; waiting guard never closes the original claim', async () => {
  const f = await fixture(), gate = writerDeferred(); f.host.gates['desktop.writer.acquire'] = gate.promise;
  const guard = f.writer.createNewSessionWriterAdmissionGuard({ current: () => true, safe: f.admission.safeToLeave });
  const ready = f.admission.ready(); for (let i = 0; i < 30; i++) await Promise.resolve();
  h.active = false; gate.resolve(); expect(await ready).toBeNull(); expect(f.admission.snapshot().phase).toBe('unavailable');
  expect(guard.current()).toBe(true); expect(await guard.prepare()).toBe(false); expect(await guard.release()).toBe(false);
  f.admission.retire(); expect(f.admission.safeToLeave()).toBe(false);
  expect(f.host.ledger.rows.size).toBe(1); expect(h.get).not.toHaveBeenCalled();
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
  expect(await f.admission.close({ allowed: () => true })).toBe(true); expect(f.host.ledger.rows.size).toBe(0);
});

test('known create claims exact session before configuration/destination restore and handoff preserves the very same verified claim', async () => {
  const f = await fixture(), entry = await f.open();
  entry.owner.setDraftText('hello'); await entry.owner.select({ model: { providerID: 'provider', id: 'model' }, agent: 'build' });
  const receipt = (await entry.owner.submit())!, handoff = entry.transfer(receipt);
  expect(handoff.desktopWriter).toBe(entry.owner.desktopWriter()); expect(handoff.desktopWriter!.target).toEqual({ kind: 'session', id: 'session/created' });
  expect(handoff.desktopWriter!.grant()).not.toBeNull(); expect(f.host.ledger.rows.size).toBe(2);
  const writes = f.host.calls.filter(row => row.name === 'runtime.request' && row.input.method === 'POST');
  expect(writes.map(row => row.input.path)).toEqual(['/api/session', '/api/session/session%2Fcreated/model?directory=%2Fcanonical', '/api/session/session%2Fcreated/agent?directory=%2Fcanonical']);
  expect(writes[0].input.writerGrant).not.toBe(writes[1].input.writerGrant);
  const all = f.host.calls, claim = all.findIndex(row => row.name === 'desktop.writer.acquire' && (row.input.target as { kind: string }).kind === 'session');
  expect(claim).toBeGreaterThan(all.indexOf(writes[0])); expect(claim).toBeLessThan(all.indexOf(writes[1]));
  await entry.disposePage(); expect(entry.released()).toBe(false); expect(f.host.ledger.rows.size).toBe(2);
  await entry.owner.complete(receipt); await handoff.release();
  expect(handoff.released()).toBe(true); expect(handoff.desktopWriter!.grant()).not.toBeNull(); expect(f.host.ledger.rows.size).toBe(1);
  expect((f.host.calls.at(-1)!.input.target as { kind: string }).kind).toBe('new-session');
});

test('session claim failure retains created receipt/input/attachments and never recreates, opens destination or washes source lock', async () => {
  const f = await fixture(), entry = await f.open(); entry.owner.setDraftText('retain');
  entry.owner.setAttachments([{ uri: 'attachment://keep', name: 'keep', mime: 'text/plain' }]);
  f.host.errors['desktop.writer.acquire'] = new Error('synthetic session acquire unknown');
  await expect(entry.owner.submit()).rejects.toThrow('writer-unknown');
  const inputID = entry.owner.inputID(); expect(entry.owner.phase()).toBe('created'); expect(entry.owner.target()?.id).toBe('session/created');
  await expect(entry.owner.submit()).rejects.toThrow();
  expect(entry.owner.inputID()).toBe(inputID); expect(entry.owner.durable.attachments()).toHaveLength(1); expect(entry.owner.durable.pendingSend()?.id).toBe(inputID);
  expect(f.host.calls.filter(row => row.name === 'runtime.request' && row.input.path === '/api/session')).toHaveLength(1);
  expect([...h.storage.keys()].filter(key => key !== [...h.storage.keys()].find(key => key.startsWith('nsh:new-session:')))).toHaveLength(1);
  await expect(entry.disposePage()).rejects.toThrow('release-blocked'); expect(entry.released()).toBe(false);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
});

test('unknown create or malformed domain receipt preserves creating lock, zero session claim/recreate/release', async () => {
  const f = await fixture(), entry = await f.open(); entry.owner.setDraftText('unknown');
  f.authority({ id: 'session/created', directory: '/different' });
  await expect(entry.owner.submit()).rejects.toThrow('invalid-create-receipt');
  const input = entry.owner.inputID(); expect(entry.owner.creationUnknown()).toBe(true);
  await expect(entry.owner.submit()).rejects.toThrow(); await expect(entry.disposePage()).rejects.toThrow();
  expect(entry.owner.inputID()).toBe(input); expect(entry.owner.durable.pendingSend()?.id).toBe(input); expect(entry.released()).toBe(false);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.acquire')).toHaveLength(1);
  expect(f.host.calls.filter(row => row.name === 'runtime.request' && row.input.path === '/api/session')).toHaveLength(1);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
});

test('native unknown release is not released:true even when the original draft flush completed', async () => {
  const f = await fixture(), entry = await f.open(); entry.owner.setDraftText('preserved');
  const closeDurable = vi.spyOn(entry.owner.durable, 'close');
  f.host.errors['desktop.writer.release'] = new Error('synthetic lost release ACK');
  await expect(entry.disposePage()).rejects.toThrow('release-blocked'); expect(entry.released()).toBe(false);
  await expect(entry.disposePage()).rejects.toThrow(); expect(entry.released()).toBe(false);
  expect(entry.owner.durable.draft()).toBe('preserved'); expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(1);
  expect(entry.owner.ownedScope()).toBe(true); expect(closeDurable).not.toHaveBeenCalled();
  expect(await entry.owner.releaseWriter()).toBe(false); expect(closeDurable).not.toHaveBeenCalled();
});

test('releaseWriter requires prepared exact revision, waits original native ACK, and leaves durable/lifetime intact until route cleanup', async () => {
  const f = await fixture(), entry = await f.open(); entry.owner.setDraftText('staged for departure');
  const closeDurable = vi.spyOn(entry.owner.durable, 'close');
  expect(await entry.owner.releaseWriter()).toBe(false); expect(entry.owner.current()).toBe(true);
  expect(await entry.owner.prepareWriterRetirement()).toBe(true);
  const gate = writerDeferred(); f.host.gates['desktop.writer.release'] = gate.promise;
  const release = entry.owner.releaseWriter(); expect(entry.owner.releaseWriter()).toBe(release);
  expect(closeDurable).not.toHaveBeenCalled(); expect(entry.owner.ownedScope()).toBe(true); expect(entry.released()).toBe(false);
  gate.resolve(); expect(await release).toBe(true);
  expect(closeDurable).not.toHaveBeenCalled(); expect(entry.owner.ownedScope()).toBe(true); expect(entry.owner.durable.draft()).toBe('staged for departure');
  expect(entry.owner.sourceWriter()?.phase()).toBe('released'); expect(await entry.owner.releaseWriter()).toBe(true);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(1);
  const cleanup = entry.owner.close(); expect(entry.owner.close()).toBe(cleanup); await cleanup;
  await entry.disposePage(); expect(closeDurable).toHaveBeenCalledTimes(1); expect(entry.released()).toBe(true); expect(entry.owner.ownedScope()).toBe(false);
  await entry.disposePage(); expect(closeDurable).toHaveBeenCalledTimes(1); expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(1);
});

test('prepared revision invalidation vetoes explicit release without closing durable or clearing pending resources', async () => {
  const f = await fixture(), entry = await f.open(), closeDurable = vi.spyOn(entry.owner.durable, 'close');
  entry.owner.setDraftText('retain revision'); expect(await entry.owner.prepareWriterRetirement()).toBe(true);
  entry.owner.durable.attachments.set([{ uri: 'attachment://late', name: 'late', mime: 'text/plain' }]);
  expect(await entry.owner.releaseWriter()).toBe(false); expect(closeDurable).not.toHaveBeenCalled();
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
  entry.owner.cancelWriterRetirement(); expect(entry.owner.current()).toBe(true); await entry.disposePage();
});

test('generic close/release cannot retire an installed source; admission cleanup then release ACK precedes its local disposal', async () => {
  const f = await fixture(), entry = await f.open(); entry.owner.setDraftText('retain installed input');
  const receipt = (await entry.owner.submit())!, handoff = entry.transfer(receipt), input = entry.owner.inputID();
  const closeDurable = vi.spyOn(entry.owner.durable, 'close');
  expect(await entry.owner.prepareWriterRetirement()).toBe(false); expect(await entry.owner.releaseWriter()).toBe(false);
  await expect(handoff.release()).rejects.toThrow('release-blocked'); expect(handoff.released()).toBe(false); expect(closeDurable).not.toHaveBeenCalled();
  expect(entry.owner.durable.pendingSend()?.id).toBe(input); expect(entry.owner.phase()).toBe('installed');
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
  await entry.owner.complete(receipt); expect(await entry.owner.prepareWriterRetirement()).toBe(true); expect(await entry.owner.releaseWriter()).toBe(true);
  expect(closeDurable).not.toHaveBeenCalled(); expect(handoff.desktopWriter!.grant()).not.toBeNull();
  await handoff.release(); expect(closeDurable).toHaveBeenCalledTimes(1); expect(handoff.released()).toBe(true);
  expect(handoff.desktopWriter!.grant()).not.toBeNull(); expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(1);
});

test('unresolved original attachment/selection retirement guard survives view unbind, release failure preserves editable old owner', async () => {
  const f = await fixture(), entry = await f.open(); let settled = false;
  const unbind = entry.owner.bindRetirementGuard(() => settled);
  entry.owner.setDraftText('original protected draft'); unbind();
  await expect(entry.disposePage()).rejects.toThrow('release-blocked'); expect(entry.released()).toBe(false);
  expect(entry.owner.setDraftText('recovery remains possible')).toBe(true);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
  settled = true; await entry.disposePage(); expect(entry.released()).toBe(true);
});

test('native window guard only prepares/flushes and revalidates; Cancel and stale revisions never release or destroy the source', async () => {
  const f = await fixture(), entry = await f.open(); entry.owner.setDraftText('dirty source');
  expect(entry.owner.canReleaseWriter()).toBe(false);
  expect(await entry.owner.prepareWriterRetirement()).toBe(true); expect(entry.owner.canReleaseWriter()).toBe(true);
  expect(entry.owner.setDraftText('must stay paused')).toBe(false);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
  entry.owner.cancelWriterRetirement(); expect(entry.owner.canReleaseWriter()).toBe(false); expect(entry.owner.setDraftText('cancel restored original')).toBe(true);
  expect(await entry.owner.prepareWriterRetirement()).toBe(true);
  entry.owner.durable.attachments.set([{ uri: 'attachment://late', name: 'late', mime: 'text/plain' }]);
  expect(entry.owner.canReleaseWriter()).toBe(false); expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
  entry.owner.cancelWriterRetirement(); await entry.disposePage();
});

test('unknown submissions and in-flight attachment retirement cannot be approved by a clean-looking native close', async () => {
  const f = await fixture(), entry = await f.open(); let complete = false;
  entry.owner.bindRetirementGuard(() => complete);
  expect(await entry.owner.prepareWriterRetirement()).toBe(false); expect(entry.owner.current()).toBe(true);
  complete = true; entry.owner.setDraftText('unknown'); f.authority({ id: 'created', directory: '/wrong' });
  await expect(entry.owner.submit()).rejects.toThrow(); expect(await entry.owner.prepareWriterRetirement()).toBe(false);
  expect(entry.owner.canReleaseWriter()).toBe(false); expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(0);
});

test('background during initial acquire retains native claim; next committed operation renews same owner before any durable restore', async () => {
  const f = await fixture(), gate = writerDeferred(); f.host.gates['desktop.writer.acquire'] = gate.promise;
  const ready = f.admission.ready(); for (let i = 0; i < 10; i++) await Promise.resolve();
  h.active = false; gate.resolve(); expect(await ready).toBeNull(); expect(h.get).not.toHaveBeenCalled();
  const original = f.host.calls.find(row => row.name === 'desktop.writer.acquire')!.input.ownerID;
  h.active = true; h.scope.set({ ...writerTestScope, lease: 'lease-two' }); f.host.scope = h.scope(); h.op = f.operation();
  const admitted = await f.admission.resume(h.op as PageOperation); expect(admitted).not.toBeNull();
  expect(admitted!.claim.ownerID).toBe(original); expect(admitted!.claim.expectedHost).toEqual(h.scope());
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.acquire')).toHaveLength(1); expect(h.get).not.toHaveBeenCalled();
  const entry = f.api.createNativeNewSessionOwnership({ directory: admitted!.directory, desktopWriter: admitted!, active: () => h.active, operation: () => h.op as PageOperation });
  await entry.owner.ready; await entry.disposePage();
});

test('modal/background pause keeps original draft and claims; explicit same-identity lease renewal does not reopen durable', async () => {
  const f = await fixture(), entry = await f.open(); entry.owner.setDraftText('original'); await entry.owner.durable.flush();
  const count = h.get.mock.calls.length, claims = f.host.calls.filter(row => row.name === 'desktop.writer.acquire').length;
  h.active = false; expect(entry.owner.setDraftText('hidden')).toBe(false); expect(entry.owner.durable.draft()).toBe('original');
  h.active = true; h.scope.set({ ...writerTestScope, lease: 'lease-two' }); f.host.scope = h.scope();
  const next = f.operation(); h.op = next; entry.owner.replaceOperation(next);
  for (let i = 0; i < 15; i++) await Promise.resolve();
  expect(entry.owner.current()).toBe(true); expect(entry.owner.durable.draft()).toBe('original'); expect(h.get).toHaveBeenCalledTimes(count);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.acquire')).toHaveLength(claims);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.renew')).toHaveLength(1);
});

test('iOS ignores injected desktop admission and performs zero writer/capability calls', async () => {
  const f = await fixture(); h.desktop = false; f.host.calls.length = 0;
  const entry = f.api.createNativeNewSessionOwnership({ directory: '/canonical', active: () => true, operation: () => h.op as PageOperation,
    desktopWriter: undefined });
  await entry.owner.ready; entry.owner.setDraftText('iOS'); await entry.disposePage();
  expect(f.host.calls).toEqual([]); expect(entry.released()).toBe(true);
});

test('destination persistence failure retries original created receipt and exact session claim, never another create', async () => {
  const f = await fixture(), entry = await f.open(); entry.owner.setDraftText('preserve through staging');
  const persist = h.set.getMockImplementation()!;
  h.set.mockImplementation(async (key, raw) => { if (key.includes('session%2Fcreated') && !key.startsWith('nsh:new-session:')) throw new Error('synthetic destination disk failed'); return persist(key, raw); });
  await expect(entry.owner.submit()).rejects.toThrow('destination disk');
  const input = entry.owner.inputID(); h.set.mockImplementation(persist);
  const receipt = (await entry.owner.submit())!;
  expect(receipt.inputID).toBe(input); expect(f.host.calls.filter(row => row.name === 'runtime.request' && row.input.path === '/api/session')).toHaveLength(1);
  expect(f.host.calls.filter(row => row.name === 'desktop.writer.acquire')).toHaveLength(2);
  await entry.owner.complete(receipt); await entry.disposePage();
});

test('source admission unknown keeps both original grants; its cleanup is the final source release barrier', async () => {
  const f = await fixture(), entry = await f.open(); entry.owner.setDraftText('retain admission');
  const handoff = entry.transfer((await entry.owner.submit())!);
  const { createNewSessionAdmission } = await import('./new-session-admission');
  const send = vi.fn(async () => false), changed = vi.fn();
  const admission = createNewSessionAdmission({ chat: {} as Parameters<typeof createNewSessionAdmission>[0]['chat'], handoff, current: () => true, changed, send });
  await admission.run(); expect(entry.owner.admission()).toBe('unknown'); expect(f.host.ledger.rows.size).toBe(2);
  await expect(handoff.release()).rejects.toThrow('release-blocked'); expect(handoff.released()).toBe(false);
  send.mockResolvedValue(true); await admission.reconcile();
  expect(changed).toHaveBeenLastCalledWith('complete'); expect(handoff.released()).toBe(true); expect(f.host.ledger.rows.size).toBe(1);
  expect(f.host.calls.filter(row => row.name === 'runtime.request' && row.input.path === '/api/session')).toHaveLength(1);
});
