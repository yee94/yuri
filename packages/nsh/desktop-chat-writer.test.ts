import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDesktopChatWriter, type DesktopChatWriterRetirement } from './desktop-chat-writer';
import { beginDesktopWriterDispatch, loadDesktopWriterClient, type DesktopWriterClaim, type DesktopWriterClient } from './desktop-writer-core';
import { StrictWriterHost, writerDeferred, writerNativeError, writerTestScope } from './desktop-writer-test-host';
import type { RuntimeScope } from './runtime-scope';

const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), rows: new Map<string, string>() }));
vi.mock('nsh', () => ({ batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  Storage: { getItem: storage.get, setItem: storage.set } }));
const target = { kind: 'session', id: 'session/a' } as const;
const drafts: Array<{ close(): Promise<void> }> = [];
beforeEach(() => {
  vi.useFakeTimers(); storage.rows.clear();
  storage.get.mockReset().mockImplementation(async key => storage.rows.get(key) ?? null);
  storage.set.mockReset().mockImplementation(async (key, value) => { storage.rows.set(key, value); });
});
afterEach(async () => { await Promise.allSettled(drafts.splice(0).map(draft => draft.close())); vi.useRealTimers(); });
async function fixture(host = new StrictWriterHost(), handoff?: DesktopWriterClaim, existingClient?: DesktopWriterClient) {
  const client = existingClient ?? (await loadDesktopWriterClient({ source: () => host, current: () => true }))!;
  const { openDraft } = await import('./drafts');
  let committed: RuntimeScope | null = writerTestScope, stable = 'host-a|https://fixture.invalid|authorization-one', live = true, capabilities = true;
  let rootClient: DesktopWriterClient | undefined = client;
  const construct = vi.fn((grant, markUnknown) => {
    const draft = openDraft(writerTestScope.hostID, { ...target, title: 'Synthetic', directory: '/workspace' }, stable); drafts.push(draft);
    return { draft, grant, markUnknown };
  });
  const scopeReady = vi.fn();
  const owner = createDesktopChatWriter({ client: () => rootClient, capabilitiesReady: () => capabilities, target,
    current: () => live, committedRuntimeScope: () => committed, stableAuthorityIdentity: () => stable,
    handoff, renderChild: construct, scopeReady });
  return { host, client, owner, construct, scopeReady, scope(value: RuntimeScope | null) { committed = value; }, authority(value: string) { stable = value; },
    live(value: boolean) { live = value; }, capabilities(value: boolean) { capabilities = value; }, clientValue(value: DesktopWriterClient | undefined) { rootClient = value; } };
}
function business(): DesktopChatWriterRetirement & { protected: boolean; paused: boolean } {
  const value = { protected: false, paused: false, async prepareWriterRetirement() { value.paused = true; return !value.protected; },
    canReleaseWriter: () => value.paused && !value.protected, cancelWriterRetirement() { value.paused = false; } };
  return value;
}
const calls = (host: StrictWriterHost, name: string) => host.calls.filter(row => row.name === 'desktop.writer.' + name);

test('acquire ACK precedes original openDraft/Storage; one retained child and 50 input/modal reads cause zero native calls', async () => {
  const host = new StrictWriterHost(), gate = writerDeferred(); host.gates['desktop.writer.acquire'] = gate.promise;
  const f = await fixture(host), ready = f.owner.ready(); expect(f.owner.reconcile()).toBe(ready);
  await Promise.resolve(); expect(calls(host, 'acquire')).toHaveLength(1); expect(f.construct).not.toHaveBeenCalled(); expect(storage.get).not.toHaveBeenCalled();
  gate.resolve(); const grant = await ready; expect(grant).not.toBeNull();
  const child = f.owner.child()!; await child.draft.ready; expect(f.construct).toHaveBeenCalledTimes(1); expect(storage.get).toHaveBeenCalledTimes(1);
  const count = host.calls.length;
  for (let index = 0; index < 50; index++) { child.draft.setDraftText('retained ' + index); f.owner.status(); f.owner.grant(); await f.owner.reconcile(); }
  expect(f.owner.child()).toBe(child); expect(child.draft.draft()).toBe('retained 49'); expect(host.calls).toHaveLength(count); expect(f.construct).toHaveBeenCalledTimes(1);
});
test('explicit discovery loading, unsupported and missing committed scope never construct or touch Storage', async () => {
  const f = await fixture(); f.capabilities(false); expect(await f.owner.ready()).toBeNull(); expect(f.owner.status().phase).toBe('capabilities-loading');
  f.capabilities(true); f.clientValue(undefined); await f.owner.ready(); expect(f.owner.status().phase).toBe('unsupported');
  f.clientValue(f.client); f.scope(null); await f.owner.reconcile(); expect(f.owner.status().phase).toBe('waiting-scope');
  expect(f.construct).not.toHaveBeenCalled(); expect(storage.get).not.toHaveBeenCalled(); expect(calls(f.host, 'acquire')).toHaveLength(0);
  f.scope(writerTestScope); expect(await f.owner.reconcile()).not.toBeNull();
  const invalidClient = vi.fn(() => { throw new Error('synthetic root getter failure'); });
  const broken = createDesktopChatWriter({ client: invalidClient, capabilitiesReady: () => true, target, current: () => true,
    committedRuntimeScope: () => writerTestScope, stableAuthorityIdentity: () => 'fixture', renderChild: vi.fn() });
  expect(await broken.ready()).toBeNull(); expect(broken.status().phase).toBe('unknown'); expect(await broken.reconcile()).toBeNull(); expect(invalidClient).toHaveBeenCalledTimes(1);
});
test.each([writerNativeError('writer_conflict'), new Error('writer_conflict'), new Error('timeout')])('acquire failure is sticky, no re-claim/capability retry or Storage: %s', async error => {
  const host = new StrictWriterHost(); host.errors['desktop.writer.acquire'] = error;
  const f = await fixture(host); await f.owner.ready(); const phase = f.owner.status().phase;
  expect(phase).toBe(error === host.errors['desktop.writer.acquire'] && 'code' in error ? 'denied' : 'unknown');
  for (let i = 0; i < 50; i++) await f.owner.reconcile();
  expect(calls(host, 'acquire')).toHaveLength(1); expect(calls(host, 'capabilities')).toHaveLength(1); expect(storage.get).not.toHaveBeenCalled(); expect(f.construct).not.toHaveBeenCalled();
});
test('same-authority renew await preserves the original child/draft; old grant cannot cross either scope and ACK triggers original lane notification', async () => {
  const f = await fixture(); const old = (await f.owner.ready())!, child = f.owner.child()!; await child.draft.ready; child.draft.setDraftText('Keep draft');
  f.host.scope = { ...writerTestScope, lease: 'lease-two' }; f.scope(f.host.scope);
  expect(f.owner.grant()).toBeNull();
  const gate = writerDeferred(); f.host.gates['desktop.writer.renew'] = gate.promise;
  const renewing = f.owner.reconcile(); await Promise.resolve();
  expect(f.owner.grant()).toBeNull(); expect(f.owner.child()).toBe(child); expect(f.owner.status().phase).toBe('renewing');
  const write = { path: '/api/session/session%2Fa/prompt', method: 'POST' };
  for (const expectedHost of [writerTestScope, f.host.scope]) expect(() => beginDesktopWriterDispatch({ ...write, expectedHost, writer: () => old })).toThrow();
  gate.resolve(); const next = await renewing; expect(next).not.toBe(old); expect(next!.ownerID).toBe(old.ownerID);
  expect(f.owner.child()).toBe(child); expect(child.draft.draft()).toBe('Keep draft'); expect(storage.get).toHaveBeenCalledTimes(1); expect(f.scopeReady).toHaveBeenLastCalledWith(f.host.scope);
  expect(calls(f.host, 'acquire')).toHaveLength(1); expect(calls(f.host, 'renew')).toHaveLength(1);
});
test.each(['bad-ack', 'timeout'])('unknown renew is fail closed, no retry/release/new draft: %s', async fault => {
  const f = await fixture(); await f.owner.ready(); const child = f.owner.child(); f.host.scope = { ...writerTestScope, lease: 'lease-two' }; f.scope(f.host.scope);
  if (fault === 'bad-ack') f.host.transform = (name, value) => name === 'desktop.writer.renew' ? { ...value as object, extra: true } : value;
  else f.host.errors['desktop.writer.renew'] = new Error('timeout');
  expect(await f.owner.reconcile()).toBeNull(); expect(f.owner.status().phase).toBe('unknown');
  for (let i = 0; i < 50; i++) await f.owner.reconcile();
  expect(await f.owner.release()).toBe(false); expect(calls(f.host, 'renew')).toHaveLength(1); expect(f.owner.child()).toBe(child); expect(f.owner.grant()).toBeNull();
});
test.each(['authority', 'host', 'route', 'client'])('stable identity change never lends the old draft to another owner: %s', async change => {
  const f = await fixture(); await f.owner.ready(); const child = f.owner.child();
  if (change === 'authority') f.authority('host-a|https://other.invalid|authorization-two');
  if (change === 'host') f.scope({ hostID: 'host-b', lease: 'other' });
  if (change === 'route') f.live(false);
  if (change === 'client') f.clientValue(undefined);
  expect(f.owner.grant()).toBeNull(); expect(await f.owner.reconcile()).toBeNull(); expect(f.owner.status().phase).toBe('retired'); expect(f.owner.child()).toBe(child);
  expect(calls(f.host, 'renew')).toHaveLength(0); expect(calls(f.host, 'release')).toHaveLength(0);
});
test('original producer claim handoff is verified/reused; no session re-acquire and stale producer current cannot be repaired by consumer', async () => {
  const host = new StrictWriterHost(); const client = (await loadDesktopWriterClient({ source: () => host, current: () => true }))!;
  let originalCurrent = true; const original = client.claim({ target, expectedHost: writerTestScope, current: () => originalCurrent }); await original.ready();
  const f = await fixture(host, original, client); expect(await f.owner.ready()).toBe(original.grant()); expect(calls(host, 'acquire')).toHaveLength(1); expect(calls(host, 'capabilities')).toHaveLength(1);
  originalCurrent = false; expect(f.owner.grant()).toBeNull(); expect(await f.owner.reconcile()).toBeNull(); expect(calls(host, 'acquire')).toHaveLength(1);
});
test('wrong target/scope and copied opaque receipt handoffs never construct or mutate the original producer', async () => {
  for (const fault of ['target', 'scope', 'copy']) {
    const host = new StrictWriterHost(), client = (await loadDesktopWriterClient({ source: () => host, current: () => true }))!;
    const original = client.claim({ target: fault === 'target' ? { ...target, id: 'other' } : target, expectedHost: writerTestScope, current: () => true }); await original.ready();
    const candidate = fault === 'copy' ? { ...original, grant: () => ({ ...original.grant()! }) } as DesktopWriterClaim : original;
    const f = await fixture(host, candidate, client); if (fault === 'scope') f.scope({ ...writerTestScope, lease: 'lease-other' });
    expect(await f.owner.ready()).toBeNull(); expect(f.construct).not.toHaveBeenCalled(); expect(original.grant()).not.toBeNull();
    f.owner.retire(); expect(original.grant()).not.toBeNull(); expect(calls(host, 'acquire')).toHaveLength(1);
  }
});
test('prepare uses original business flush and additional final veto; cancellation restores same admission; native close never releases early', async () => {
  const f = await fixture(); await f.owner.ready(); const chat = business(); let additional = true;
  const unbind = f.owner.bindBusiness(chat, () => additional);
  expect(await f.owner.prepareRetirement()).toBe(true); expect(f.owner.grant()).toBeNull(); expect(f.owner.canClose()).toBe(true);
  additional = false; expect(f.owner.canClose()).toBe(false); expect(await f.owner.release()).toBe(false); expect(calls(f.host, 'release')).toHaveLength(0);
  expect(f.owner.cancel()).toBe(true); expect(chat.paused).toBe(false); expect(f.owner.grant()).not.toBeNull();
  additional = true; expect(await f.owner.prepareRetirement()).toBe(true); expect(calls(f.host, 'release')).toHaveLength(0);
  f.owner.retire(); expect(f.owner.grant()).toBeNull(); expect(calls(f.host, 'release')).toHaveLength(0); unbind();
});
test('normal departure only releases after prepared/final business+native guards; exact release ACK precedes commit', async () => {
  const f = await fixture(); await f.owner.ready(); const child = f.owner.child(), chat = business();
  const dispatch = beginDesktopWriterDispatch({ writer: f.owner.grant, expectedHost: writerTestScope, path: '/api/session/session%2Fa/prompt', method: 'POST' })!;
  expect(await f.owner.prepareRetirement(chat)).toBe(false); dispatch.finish('confirmed');
  chat.protected = true; expect(await f.owner.prepareRetirement(chat)).toBe(false); expect(f.owner.grant()).not.toBeNull();
  chat.protected = false; expect(await f.owner.prepareRetirement(chat)).toBe(true);
  const gate = writerDeferred(); f.host.gates['desktop.writer.release'] = gate.promise;
  let committed = false; const releasing = f.owner.release(); expect(f.owner.release()).toBe(releasing);
  const departure = releasing.then(allowed => { if (allowed) committed = true; }); await Promise.resolve();
  expect(committed).toBe(false); expect(f.owner.cancel()).toBe(false); expect(f.owner.child()).toBe(child);
  gate.resolve(); await departure; expect(committed).toBe(true); expect(f.owner.status().phase).toBe('released'); expect(f.owner.grant()).toBeNull();
});
test('pending unknown remains sticky after cancel and no cleanup permission washes failed release', async () => {
  const f = await fixture(); await f.owner.ready(); const child = f.owner.child(); expect(await f.owner.prepareRetirement(business())).toBe(true);
  f.host.errors['desktop.writer.release'] = new Error('lost ACK'); expect(await f.owner.release()).toBe(false); f.owner.cancel();
  expect(f.owner.status().phase).toBe('unknown'); expect(f.owner.child()).toBe(child); expect(f.owner.grant()).toBeNull();
  expect(await f.owner.release()).toBe(false); expect(await f.owner.close({ allowed: () => true })).toBe(false); expect(calls(f.host, 'release')).toHaveLength(1);
});
test('late acquire receipt survives retirement without construction; only explicit exact-authority close cleans it up', async () => {
  for (const allowed of [false, true]) {
    const host = new StrictWriterHost(), gate = writerDeferred(); host.gates['desktop.writer.acquire'] = gate.promise;
    const f = await fixture(host), ready = f.owner.ready(); await Promise.resolve(); f.owner.retire();
    const close = f.owner.close({ allowed: () => allowed }); gate.resolve(); await ready;
    expect(await close).toBe(allowed); expect(f.construct).not.toHaveBeenCalled(); expect(calls(host, 'release')).toHaveLength(allowed ? 1 : 0);
  }
});
test('cancel invalidates in-flight original flush without retiring or replacing draft/claim', async () => {
  const f = await fixture(); await f.owner.ready(); const child = f.owner.child(), chat = business(), flush = writerDeferred<boolean>();
  chat.prepareWriterRetirement = () => { chat.paused = true; return flush.promise; };
  const preparing = f.owner.prepareRetirement(chat); await Promise.resolve(); f.owner.cancel(); flush.resolve(true);
  expect(await preparing).toBe(false); expect(chat.paused).toBe(false); expect(f.owner.grant()).not.toBeNull(); expect(f.owner.child()).toBe(child);
  expect(calls(f.host, 'release')).toHaveLength(0);
});
