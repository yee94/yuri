import { expect, test, vi } from 'vitest';
import { beginDesktopWriterDispatch, loadDesktopWriterClient, type VerifiedDesktopWriterGrant } from './desktop-writer-core';
import { StrictWriterHost, WriterTestLedger, writerDeferred, writerNativeError, writerTestCapabilities, writerTestScope } from './desktop-writer-test-host';

const target = { kind: 'session', id: 'session/a' } as const;
async function fixture(host = new StrictWriterHost()) {
  let rootLive = true, ownerLive = true, source: StrictWriterHost | undefined = host;
  const client = (await loadDesktopWriterClient({ source: () => source, current: () => rootLive }))!;
  const owner = client.claim({ target, expectedHost: writerTestScope, current: () => ownerLive });
  return { host, client, owner, rootOff: () => { rootLive = false; }, ownerOff: () => { ownerLive = false; }, source: (next: StrictWriterHost | undefined) => { source = next; } };
}
test('verified capability discovery is exact and missing/partial/old capabilities cause zero acquire', async () => {
  for (const capability of [undefined, false, {}, { ...writerTestCapabilities, renew: undefined }, { ...writerTestCapabilities, recovery: true }, { ...writerTestCapabilities, supported: false }, { ...writerTestCapabilities, windowID: '' }, { ...writerTestCapabilities, extra: true }, { ...writerTestCapabilities, maxWriters: 65 }]) {
    const host = new StrictWriterHost(); host.capability = capability;
    expect(await loadDesktopWriterClient({ source: () => host, current: () => true })).toBeUndefined();
    expect(host.calls.map(row => row.name)).toEqual(['desktop.writer.capabilities']);
  }
  expect(await loadDesktopWriterClient({ source: () => undefined, current: () => true })).toBeUndefined();
  const host = new StrictWriterHost(); host.online = false;
  expect(await loadDesktopWriterClient({ source: () => host, current: () => true })).toBeUndefined(); expect(host.calls).toEqual([]);
});
test('single explicit claim, crypto owner, immutable opaque grant; repeated ready/50 input reads are zero I/O', async () => {
  const f = await fixture(); const promise = f.owner.ready(); expect(f.owner.ready()).toBe(promise);
  const grant = await promise; expect(grant).toBe(f.owner.grant()); expect(Object.isFrozen(grant)).toBe(true); expect(Object.isFrozen(grant!.expectedHost)).toBe(true);
  expect(grant).not.toHaveProperty('grantID'); expect(f.owner.ownerID).toMatch(/^[a-f\d-]{36}$/i);
  const count = f.host.calls.length, listener = vi.fn(), off = f.owner.subscribe(listener);
  for (let index = 0; index < 50; index++) { f.owner.grant(); f.owner.status(); f.owner.phase(); f.owner.canRelease(); expect(f.owner.ready()).toBe(promise); }
  expect(f.host.calls).toHaveLength(count); expect(listener).not.toHaveBeenCalled(); off();
  expect(f.host.calls.map(row => row.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire']);
});
test.each(['owner', 'window', 'scope', 'target', 'field', 'schema'])('malformed/mismatched acquire ACK is sticky unknown, never a grant: %s', async fault => {
  const host = new StrictWriterHost();
  host.transform = (name, value) => {
    if (name !== 'desktop.writer.acquire') return value;
    const row = { ...(value as Record<string, unknown>) };
    if (fault === 'owner') row.ownerID = 'borrowed'; if (fault === 'window') row.windowID = 'borrowed-window'; if (fault === 'scope') row.expectedHost = { ...writerTestScope, lease: 'other' };
    if (fault === 'target') row.target = { ...target, id: 'other' }; if (fault === 'field') row.extra = true; if (fault === 'schema') row.schemaVersion = 2;
    return row;
  };
  const f = await fixture(host); expect(await f.owner.ready()).toBeNull(); expect(f.owner.phase()).toBe('unknown'); expect(f.owner.grant()).toBeNull();
  expect(await f.owner.release({ allowed: () => true })).toBe(false); expect(host.calls).toHaveLength(2);
});
test('a strict native conflict is denied; lookalike and timeout remain unknown with zero resend', async () => {
  for (const [failure, phase] of [[writerNativeError('writer_conflict'), 'denied'], [new Error('writer_conflict'), 'unknown'], [new Error('ETIMEDOUT'), 'unknown']] as const) {
    const host = new StrictWriterHost(); host.errors['desktop.writer.acquire'] = failure;
    const f = await fixture(host); expect(await f.owner.ready()).toBeNull(); expect(f.owner.phase()).toBe(phase);
    await f.owner.ready(); await f.owner.close({ allowed: () => true }); expect(host.calls).toHaveLength(2);
  }
});
test('late acquire is retained after owner retirement and only explicitly allowed close releases the original grant', async () => {
  const host = new StrictWriterHost(), gate = writerDeferred(); host.gates['desktop.writer.acquire'] = gate.promise;
  const f = await fixture(host); f.ownerOff(); const closing = f.owner.close({ allowed: () => true });
  expect(f.owner.close({ allowed: () => false })).toBe(closing); expect(host.calls).toHaveLength(2);
  gate.resolve(); expect(await f.owner.ready()).toBeNull(); expect(await closing).toBe(true);
  expect(host.calls.at(-1)?.input).toEqual({ ownerID: f.owner.ownerID, target, expectedHost: writerTestScope, grantID: 'native_grant_1' }); expect(f.owner.phase()).toBe('released');
});
test('late acquire after client/source retirement retains receipt but never borrows a replacement client for release', async () => {
  const host = new StrictWriterHost(), gate = writerDeferred(); host.gates['desktop.writer.acquire'] = gate.promise;
  const f = await fixture(host); f.source(new StrictWriterHost()); gate.resolve();
  expect(await f.owner.ready()).toBeNull(); expect(f.owner.status()).toMatchObject({ hasGrant: true, unknown: true });
  expect(await f.owner.close({ allowed: () => true })).toBe(false); expect(host.calls).toHaveLength(2);
});
test('release requires current explicit permission; pending guard blocks it and copied/forged/wrong scope/window grants cannot dispatch', async () => {
  const f = await fixture(); const grant = (await f.owner.ready())!;
  expect(await f.owner.release({ allowed: () => false })).toBe(false); expect(f.host.calls).toHaveLength(2);
  const base = { writer: () => grant, expectedHost: writerTestScope, path: '/api/session/session%2Fa/prompt', method: 'POST' };
  for (const bad of [{ ...base, writer: () => ({ ...grant }) as VerifiedDesktopWriterGrant }, { ...base, writer: () => 'native_grant_1' as unknown as VerifiedDesktopWriterGrant }, { ...base, windowID: 'other-window' }, { ...base, expectedHost: { ...writerTestScope, lease: 'old' } }, { ...base, path: '/api/session/other/prompt' }]) expect(() => beginDesktopWriterDispatch(bad)).toThrow();
  const dispatch = beginDesktopWriterDispatch(base)!; expect(f.owner.status().pending).toBe(1);
  expect(await f.owner.release({ allowed: () => true })).toBe(false); dispatch.finish('confirmed');
  const gate = writerDeferred(); f.host.gates['desktop.writer.release'] = gate.promise;
  const release = f.owner.release({ allowed: () => true }); expect(f.owner.release({ allowed: () => true })).toBe(release); expect(f.owner.grant()).toBeNull();
  gate.resolve(); expect(await release).toBe(true); expect(f.owner.phase()).toBe('released'); expect(dispatch.current()).toBe(false);
});
test.each(['timeout', 'bad-ack', 'lookalike', 'retired'])('unknown release never washes the receipt or retries: %s', async kind => {
  const f = await fixture(); await f.owner.ready();
  if (kind === 'timeout') f.host.errors['desktop.writer.release'] = new Error('ETIMEDOUT');
  if (kind === 'lookalike') f.host.errors['desktop.writer.release'] = new Error('writer_pending');
  if (kind === 'bad-ack') f.host.transform = (name, value) => name === 'desktop.writer.release' ? { released: true, grantID: 'wrong' } : value;
  const gate = writerDeferred(); if (kind === 'retired') f.host.gates['desktop.writer.release'] = gate.promise;
  const release = f.owner.release({ allowed: () => true }); if (kind === 'retired') { await vi.waitFor(() => expect(f.host.calls.at(-1)?.name).toBe('desktop.writer.release')); f.rootOff(); gate.resolve(); }
  expect(await release).toBe(false); expect(f.owner.status()).toMatchObject({ unknown: true, hasGrant: true });
  await f.owner.release({ allowed: () => true }); await f.owner.close({ allowed: () => true }); expect(f.host.calls).toHaveLength(3);
});
test('native peer conflict and UUID per mount are not replaced by a JS target authority map', async () => {
  const ledger = new WriterTestLedger(), a = await fixture(new StrictWriterHost(ledger)), b = await fixture(new StrictWriterHost(ledger));
  await a.owner.ready(); await b.owner.ready(); expect(a.owner.ownerID).not.toBe(b.owner.ownerID); expect(b.owner.phase()).toBe('denied'); expect(ledger.rows.size).toBe(1);
});
test('passive same-authority lease renewal keeps owner/draft identity, rotates the opaque grant and invalidates old lanes', async () => {
  const f = await fixture(); const old = (await f.owner.ready())!; const ready = f.owner.ready();
  f.host.scope = { ...writerTestScope, lease: 'lease-two' };
  const gate = writerDeferred(); f.host.gates['desktop.writer.renew'] = gate.promise;
  const renewing = f.owner.renew({ expectedHost: f.host.scope }); expect(f.owner.renew({ expectedHost: f.host.scope })).toBe(renewing); expect(f.owner.grant()).toBeNull(); expect(f.owner.phase()).toBe('renewing');
  expect(() => beginDesktopWriterDispatch({ writer: () => old, expectedHost: writerTestScope, path: '/api/session/session%2Fa/prompt', method: 'POST' })).toThrow();
  gate.resolve(); const next = await renewing; expect(next).not.toBeNull(); expect(next).not.toBe(old); expect(next!.ownerID).toBe(old.ownerID); expect(f.owner.ready()).toBe(ready);
  expect(f.owner.expectedHost).toEqual(f.host.scope); expect(f.host.calls.map(call => call.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire', 'desktop.writer.renew']);
  expect(await f.owner.release({ allowed: () => true })).toBe(true); expect(f.host.calls.at(-1)?.input.expectedHost).toEqual(f.host.scope);
});
test('pending/unknown or changed authority cannot renew; lost renewal ACK retains original receipt without automatic resend', async () => {
  const f = await fixture(); const old = (await f.owner.ready())!;
  const dispatch = beginDesktopWriterDispatch({ writer: f.owner.grant, expectedHost: writerTestScope, path: '/api/session/session%2Fa/prompt', method: 'POST' })!;
  f.host.scope = { ...writerTestScope, lease: 'lease-two' };
  expect(await f.owner.renew({ expectedHost: f.host.scope })).toBeNull(); expect(f.host.calls).toHaveLength(2);
  dispatch.finish('confirmed'); f.host.authority = 'https://fixture.invalid|different-native-auth';
  expect(await f.owner.renew({ expectedHost: f.host.scope })).toBeNull(); expect(f.owner.status()).toMatchObject({ hasGrant: true, unknown: true });
  await f.owner.renew({ expectedHost: f.host.scope }); expect(f.host.calls).toHaveLength(3); expect(f.owner.grant()).toBeNull(); expect(old).not.toHaveProperty('grantID');
});

test('temporary transport unavailability does not retire the stable owner, but observed source/call retirement never revives', async () => {
  const f = await fixture(); await f.owner.ready(); f.host.online = false;
  expect(f.owner.grant()).toBeNull(); expect(f.owner.status().unknown).toBe(false);
  f.host.online = true; f.host.scope = { ...writerTestScope, lease: 'lease-two' };
  expect(await f.owner.renew({ expectedHost: f.host.scope })).not.toBeNull();
  const original = f.host.call; f.host.call = async () => ({});
  expect(f.owner.grant()).toBeNull(); f.host.call = original;
  expect(f.owner.grant()).toBeNull(); expect(f.client.current()).toBe(false);
});
test('unknown/lost renewal ACK has no retry or release even if availability and source return', async () => {
  const f = await fixture(); await f.owner.ready(); f.host.scope = { ...writerTestScope, lease: 'lease-two' };
  f.host.transform = (name, value) => name === 'desktop.writer.renew' ? { ...value as object, extra: true } : value;
  expect(await f.owner.renew({ expectedHost: f.host.scope })).toBeNull();
  expect(f.owner.status()).toMatchObject({ hasGrant: true, unknown: true });
  f.host.transform = undefined; await f.owner.renew({ expectedHost: f.host.scope }); await f.owner.release({ allowed: () => true });
  expect(f.host.calls.map(call => call.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire', 'desktop.writer.renew']);
});

test('explicit renew during acquire waits for its original receipt without publishing the old scope or acquiring twice', async () => {
  const host = new StrictWriterHost(), acquired = writerDeferred(), renewed = writerDeferred();
  host.gates['desktop.writer.acquire'] = acquired.promise; host.gates['desktop.writer.renew'] = renewed.promise;
  const f = await fixture(host), ready = f.owner.ready(), ownerID = f.owner.ownerID;
  host.scope = { ...writerTestScope, lease: 'lease-two' };
  const intent = f.owner.renew({ expectedHost: host.scope });
  expect(f.owner.renew({ expectedHost: host.scope })).toBe(intent);
  expect(await f.owner.renew({ expectedHost: { ...host.scope, lease: 'lease-three' } })).toBeNull();
  const published: unknown[] = [];
  f.owner.subscribe(() => { if (f.owner.grant()) published.push(f.owner.grant()!.expectedHost); });
  expect(f.owner.grant()).toBeNull(); expect(f.owner.canRelease()).toBe(false);
  expect(host.calls.map(row => row.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire']);
  acquired.resolve(); expect(await ready).toBeNull();
  await vi.waitFor(() => expect(host.calls.at(-1)?.name).toBe('desktop.writer.renew'));
  expect(f.owner.grant()).toBeNull(); expect(published).toEqual([]);
  renewed.resolve(); const grant = await intent;
  expect(grant).not.toBeNull(); expect(grant!.ownerID).toBe(ownerID); expect(grant!.expectedHost).toEqual(host.scope);
  expect(f.owner.ready()).toBe(ready); expect(published).toEqual([host.scope]);
  expect(host.calls.map(row => row.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire', 'desktop.writer.renew']);
  expect(await f.owner.release({ allowed: () => true })).toBe(true);
  expect(host.calls.at(-1)?.input.expectedHost).toEqual(host.scope);
});
test.each(['retire', 'source', 'unknown'])('queued renew never dispatches after %s and never falls back to an old-scope release', async kind => {
  const host = new StrictWriterHost(), gate = writerDeferred(); host.gates['desktop.writer.acquire'] = gate.promise;
  const f = await fixture(host); host.scope = { ...writerTestScope, lease: 'lease-two' };
  const renewal = f.owner.renew({ expectedHost: host.scope });
  if (kind === 'retire') f.owner.retire();
  if (kind === 'source') f.source(new StrictWriterHost());
  if (kind === 'unknown') f.owner.markUnknown();
  gate.resolve(); expect(await f.owner.ready()).toBeNull(); expect(await renewal).toBeNull();
  expect(await f.owner.close({ allowed: () => true })).toBe(false);
  expect(f.owner.status().hasGrant).toBe(true); expect(f.owner.grant()).toBeNull();
  expect(host.calls.map(row => row.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire']);
});
test.each([true, false])('explicit close during queued renew allows cleanup only through new native scope with late permission=%s', async allowed => {
  const host = new StrictWriterHost(), gate = writerDeferred(); host.gates['desktop.writer.acquire'] = gate.promise;
  const f = await fixture(host); host.scope = { ...writerTestScope, lease: 'lease-two' };
  const renewal = f.owner.renew({ expectedHost: host.scope });
  let permission = true;
  const closing = f.owner.close({ allowed: () => permission }); permission = allowed;
  expect(f.owner.close({ allowed: () => false })).toBe(closing);
  gate.resolve(); expect(await f.owner.ready()).toBeNull(); expect(await renewal).toBeNull();
  expect(await closing).toBe(allowed); expect(f.owner.grant()).toBeNull();
  expect(host.calls.map(row => row.name)).toEqual(['desktop.writer.capabilities', 'desktop.writer.acquire', ...(allowed ? ['desktop.writer.renew', 'desktop.writer.release'] : [])]);
  if (allowed) expect(host.calls.at(-1)?.input).toMatchObject({ expectedHost: host.scope, grantID: 'native_grant_2' });
});
test('close after native renew dispatch retains its late receipt and only releases the new scope with late permission', async () => {
  for (const allowed of [true, false]) {
    const f = await fixture(); await f.owner.ready();
    f.host.scope = { ...writerTestScope, lease: 'lease-two' };
    const gate = writerDeferred(); f.host.gates['desktop.writer.renew'] = gate.promise;
    const renewal = f.owner.renew({ expectedHost: f.host.scope });
    await vi.waitFor(() => expect(f.host.calls.at(-1)?.name).toBe('desktop.writer.renew'));
    let permission = true;
    const closing = f.owner.close({ allowed: () => permission }); permission = allowed; gate.resolve();
    expect(await renewal).toBeNull(); expect(await closing).toBe(allowed);
    expect(f.owner.expectedHost).toEqual(f.host.scope); expect(f.owner.grant()).toBeNull();
    expect(f.host.calls.filter(row => row.name === 'desktop.writer.release').map(row => row.input.expectedHost)).toEqual(allowed ? [f.host.scope] : []);
  }
});
test('subscriber reentrancy joins one release and permission cannot make unknown releasable', async () => {
  const f = await fixture(); await f.owner.ready();
  let duplicate: Promise<boolean> | undefined;
  f.owner.subscribe(() => { if (f.owner.phase() === 'releasing') duplicate = f.owner.release({ allowed: () => true }); });
  const release = f.owner.release({ allowed: () => true }); expect(duplicate).toBe(release);
  expect(await release).toBe(true); expect(f.host.calls.filter(row => row.name === 'desktop.writer.release')).toHaveLength(1);
  for (const poisonAt of [1, 2]) {
    const next = await fixture(); await next.owner.ready(); let checks = 0;
    expect(await next.owner.release({ allowed: () => { if (++checks === poisonAt) next.owner.markUnknown(); return true; } })).toBe(false);
    expect(next.host.calls).toHaveLength(2); expect(next.owner.phase()).toBe('unknown');
  }
});
