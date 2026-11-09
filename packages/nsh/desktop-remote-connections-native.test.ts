import { expect, test } from 'vitest';
import { createDesktopRemoteConnectionsController, DesktopSshDenied, DesktopSshNotDispatched } from './desktop-remote-connections-core';
import { loadDesktopRemoteConnectionsNative, type DesktopSshNativeSource } from './desktop-remote-connections-native-core';
import { nativeSshCapabilities as caps, nativeSshInstance as row, nativeSshError, StrictNativeSshHost } from './desktop-remote-connections-native-test-host.mjs';

function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
async function settle() { for (let i = 0; i < 16; i++) await Promise.resolve(); }
async function fixture(host = new StrictNativeSshHost()) {
  let live = true, source: DesktopSshNativeSource | undefined = host;
  let runtimeReady = true;
  const port = await loadDesktopRemoteConnectionsNative({ current: () => live, source: () => source, runtimeReady: () => runtimeReady });
  const controller = port && createDesktopRemoteConnectionsController(port, { connectionMutation: mutation => mutation.dispatch() });
  return { host, port: port!, controller: controller!, retire: () => { live = false; }, source: (next: DesktopSshNativeSource | undefined) => { source = next; }, runtimeReady: (value: boolean) => { runtimeReady = value; } };
}
test('strict capability discovery rejects partial, unsupported, overbroad and malformed capabilities without reads or mutations', async () => {
  for (const capability of [null, {}, true, { ...caps, version: 2 }, { ...caps, sync: { supported: true } }, { ...caps, sync: {} },
    { ...caps, connections: { supported: true } }, { ...caps, connections: { ...caps.connections, phase: 'starting' } },
    { ...caps, connections: { ...caps.connections, supported: false } }, { ...caps, connections: { ...caps.connections, maxPending: 17 } },
    { ...caps, connections: { ...caps.connections, extra: true } }, { ...caps, windowID: 'guessed' }]) {
    const host = new StrictNativeSshHost(); host.capability = capability;
    expect((await fixture(host)).port).toBeUndefined(); expect(host.calls.map(row => row.name)).toEqual(['desktop.ssh.capabilities']);
  }
  for (const code of ['ERR_ACCESS_DENIED', 'ERR_NSH_HOST_ERROR', 'ETIMEDOUT']) {
    const host = new StrictNativeSshHost(); host.capabilityError = Object.assign(new Error('denied'), { code });
    expect((await fixture(host)).port).toBeUndefined();
  }
  const host = new StrictNativeSshHost(); host.connected = false;
  expect((await fixture(host)).port).toBeUndefined(); expect(host.calls).toEqual([]);
  expect(await loadDesktopRemoteConnectionsNative({ current: () => true, source: () => undefined })).toBeUndefined();
});
test.each(['owner', 'source', 'available', 'method'])('late capability after %s retirement cannot issue a port', async kind => {
  const host = new StrictNativeSshHost(), gate = deferred(); host.capabilityGate = gate.promise;
  let live = true, source: DesktopSshNativeSource | undefined = host;
  const flight = loadDesktopRemoteConnectionsNative({ current: () => live, source: () => source, runtimeReady: () => true });
  await settle();
  if (kind === 'owner') live = false;
  if (kind === 'source') source = new StrictNativeSshHost();
  if (kind === 'available') host.connected = false;
  if (kind === 'method') host.call = async () => caps;
  gate.resolve(); expect(await flight).toBeUndefined(); expect(host.calls).toHaveLength(1);
});
test('real frozen method DTOs feed existing controller; no fake sync methods or window/Host identity is sent', async () => {
  const f = await fixture(); f.controller.setActive(true); await settle();
  expect(f.port.syncSupported).toBe(false); expect('syncPreview' in f.port).toBe(false);
  expect(await f.controller.save({ ...row, label: 'Renamed' })).toBe(true);
  expect(await f.controller.start(row.id, 'check')).toBe(true);
  expect(await f.controller.start(row.id, 'restore')).toBe(true);
  expect(await f.controller.preview(row.id, 'push')).toBe(false); expect(await f.controller.apply()).toBe(false);
  expect(await f.controller.history(row.id, 'pull')).toBe(false); await f.controller.refreshSync();
  expect(await f.controller.cancel(row.id, 2)).toBe(true);
  expect(await f.controller.remove(row.id)).toBe(true);
  expect(f.host.calls.map(row => row.name)).toEqual(['capabilities', 'capabilities', 'read', 'save', 'start', 'start', 'cancel', 'remove'].map(name => `desktop.ssh.${name}`));
  expect(f.host.calls[3].input).toMatchObject({ revision: 1, instance: { ...row, label: 'Renamed' } });
  expect(f.host.calls[5].input).toMatchObject({ id: row.id, intent: 'restore' });
  expect(f.host.calls[6].input).toEqual({ id: row.id, attempt: 2 });
  f.controller.dispose(); f.port.dispose();
});
test.each(['ssh_invalid', 'ssh_stale', 'ssh_busy', 'ssh_storage', 'ssh_authentication', 'native_host_busy'])('actual native Denied %s is not unknown and read retry never resends', async code => {
  const f = await fixture(); f.controller.setActive(true); await settle();
  f.host.operationError = nativeSshError(code);
  expect(await f.controller.save(row)).toBe(false); expect(f.controller.state().unknown).toBeNull();
  f.host.operationError = undefined; await f.controller.refresh();
  expect(f.host.calls.filter(row => row.name === 'desktop.ssh.save')).toHaveLength(1);
});
test.each(['ssh_commit_unknown', 'ssh_cancelled', 'ssh_unavailable', 'ssh_transport', 'ssh_runtime', 'ssh_bootstrap', 'unknown'])('ambiguous native %s stays unknown even after successful read with absent receipt', async code => {
  const f = await fixture(); f.controller.setActive(true); await settle(); f.host.operationError = nativeSshError(code);
  expect(await f.controller.save(row)).toBe(false); const request = f.controller.state().unknown; expect(request).toBeTruthy();
  f.host.operationError = undefined; await f.controller.refresh();
  expect(f.controller.state().unknown).toBe(request); expect(await f.controller.save(row)).toBe(false);
  expect(f.host.calls.filter(row => row.name === 'desktop.ssh.save')).toHaveLength(1);
});
test('non-native lookalike/timeout errors and malformed or unconfirmed mutation ACKs never become definite rejection', async () => {
  for (const result of [new Error('ssh_busy'), Object.assign(new Error('ssh_storage'), { code: 'ETIMEDOUT' }), {}, { ok: true }, { revision: 1, saving: false, instances: [row], statuses: [], receipts: [] }]) {
    const f = await fixture(); f.controller.setActive(true); await settle();
    if (result instanceof Error) f.host.operationError = result; else f.host.result = result;
    expect(await f.controller.save(row)).toBe(false); expect(f.controller.state().unknown).toBeTruthy();
  }
});
test('lost receipt, failed read and read-only recovery retain prior snapshot without replay', async () => {
  const f = await fixture(); f.controller.setActive(true); await settle(); const prior = f.controller.state().snapshot;
  f.host.loseNextSave = true; expect(await f.controller.save({ ...row, label: 'Saved, ACK lost' })).toBe(false);
  const request = f.controller.state().unknown; f.host.failNextRead = true; await f.controller.refresh();
  expect(f.controller.state().snapshot).toBe(prior); expect(f.controller.state().unknown).toBe(request);
  await f.controller.refresh(); expect(f.controller.state().unknown).toBe(request);
  f.host.value = f.host.withheld; await f.controller.refresh(); expect(f.controller.state().unknown).toBeNull();
  expect(f.controller.state().snapshot?.instances[0].label).toBe('Saved, ACK lost');
  expect(f.host.calls.filter(row => row.name === 'desktop.ssh.save')).toHaveLength(1);
});
test.each(['owner', 'source', 'method', 'dispose'])('late operation after observed %s retirement is rejected, never revived', async kind => {
  const f = await fixture(), gate = deferred(); f.host.operationGate = gate.promise;
  const flight = f.port.read().catch(error => error);
  if (kind === 'owner') f.retire();
  if (kind === 'source') f.source(undefined);
  const oldCall = f.host.call;
  if (kind === 'method') f.host.call = async () => caps;
  if (kind === 'dispose') f.port.dispose();
  expect(f.port.current()).toBe(false);
  f.source(f.host); f.host.connected = true; f.host.call = oldCall;
  expect(f.port.current()).toBe(false); gate.resolve(); expect(await flight).toBeInstanceOf(Error);
  await expect(f.port.cancel({ id: row.id, attempt: 1 })).rejects.toBeInstanceOf(DesktopSshDenied);
  expect(f.host.calls.map(row => row.name)).toEqual(['desktop.ssh.capabilities', 'desktop.ssh.read']);
});
test('bootstrap readiness and host availability gate operations without retiring current lifetime', async () => {
  const f = await fixture(); f.controller.setActive(true); await settle();
  const prior = f.controller.state().snapshot;
  f.runtimeReady(false);
  expect(f.port.current()).toBe(true); expect(f.port.ready()).toBe(false);
  const calls = f.host.calls.length;
  expect(await f.controller.start(row.id, 'connect')).toBe(false);
  await expect(f.port.cancel({ id: row.id, attempt: 1 })).rejects.toBeInstanceOf(DesktopSshNotDispatched);
  await f.controller.refresh(); expect(f.host.calls).toHaveLength(calls);
  expect(f.controller.state().snapshot).toBe(prior); expect(f.controller.state().unknown).toBeNull();
  f.runtimeReady(true); expect(f.port.ready()).toBe(false);
  await f.controller.refresh(); expect(f.port.ready()).toBe(true);
  f.host.connected = false; expect(f.port.current()).toBe(true); expect(f.port.ready()).toBe(false);
  f.host.connected = true; expect(f.port.ready()).toBe(false);
  await f.controller.refresh(); expect(f.port.current()).toBe(true); expect(f.port.ready()).toBe(true);
});
test('missing bootstrap proof never queries capabilities or infers readiness from transport presence', async () => {
  const host = new StrictNativeSshHost();
  expect(await loadDesktopRemoteConnectionsNative({ source: () => host, current: () => true })).toBeUndefined();
  expect(await loadDesktopRemoteConnectionsNative({ source: () => host, current: () => true, runtimeReady: () => false })).toBeUndefined();
  expect(host.calls).toEqual([]);
});
test('native capability loss gates reads and retains prior catalog without changing current or enabling sync', async () => {
  const f = await fixture(); f.controller.setActive(true); await settle(); const prior = f.controller.state().snapshot;
  for (const phase of ['starting', 'stopping', 'stopped', 'failed', 'unsupported']) {
    f.host.capability = { ...caps, connections: { ...caps.connections, phase, supported: false } };
    const reads = f.host.calls.filter(row => row.name === 'desktop.ssh.read').length;
    await f.controller.refresh(); expect(f.port.current()).toBe(true); expect(f.port.ready()).toBe(false);
    expect(f.controller.state().snapshot).toBe(prior); expect(f.controller.state().ready).toBe(false);
    expect(f.host.calls.filter(row => row.name === 'desktop.ssh.read')).toHaveLength(reads);
    expect(await f.controller.start(row.id, 'connect')).toBe(false);
    expect(await f.controller.preview(row.id, 'push')).toBe(false);
  }
  f.host.capability = caps; await f.controller.refresh(); expect(f.controller.state().ready).toBe(true);
});
test('capability refresh coalesces and late replies after runtime loss cannot restore readiness', async () => {
  const f = await fixture(), gate = deferred(); f.host.capabilityGate = gate.promise;
  const before = f.host.calls.length;
  const first = f.port.refreshCapabilities(), duplicate = f.port.refreshCapabilities(); await settle();
  expect(f.host.calls).toHaveLength(before + 1);
  f.runtimeReady(false); expect(f.port.ready()).toBe(false);
  f.runtimeReady(true); gate.resolve(); await Promise.all([first, duplicate]);
  expect(f.port.current()).toBe(true); expect(f.port.ready()).toBe(false);
  f.host.capabilityGate = undefined; await f.port.refreshCapabilities(); expect(f.port.ready()).toBe(true);
});
test('a dispatched write losing runtime readiness stays unknown and cannot replay after bootstrap recovers', async () => {
  const f = await fixture(); f.controller.setActive(true); await settle();
  const gate = deferred(); f.host.operationGate = gate.promise;
  const write = f.controller.save({ ...row, label: 'Late committed' }); await settle();
  f.runtimeReady(false); expect(f.port.current()).toBe(true); expect(f.port.ready()).toBe(false);
  gate.resolve(); expect(await write).toBe(false); expect(f.controller.state().unknown).toBeTruthy();
  f.runtimeReady(true); f.host.operationGate = undefined;
  expect(await f.controller.save(row)).toBe(false);
  expect(f.host.calls.filter(row => row.name === 'desktop.ssh.save')).toHaveLength(1);
  await f.controller.refresh(); expect(f.controller.state().unknown).toBeNull();
  expect(f.controller.state().snapshot?.instances[0].label).toBe('Late committed');
});
test('readiness recapture cannot adopt a late ACK from an earlier operation epoch', async () => {
  const f = await fixture(); f.controller.setActive(true); await settle();
  const prior = f.controller.state().snapshot, gate = deferred(); f.host.operationGate = gate.promise;
  const write = f.controller.save({ ...row, label: 'Retired epoch commit' }); await settle();
  f.runtimeReady(false); expect(f.port.ready()).toBe(false);
  f.runtimeReady(true); await f.port.refreshCapabilities(); expect(f.port.ready()).toBe(true);
  gate.resolve(); expect(await write).toBe(false);
  expect(f.controller.state().snapshot).toBe(prior); expect(f.controller.state().unknown).toBeTruthy();
  f.host.operationGate = undefined; await f.controller.refresh();
  expect(f.controller.state().unknown).toBeNull();
  expect(f.host.calls.filter(row => row.name === 'desktop.ssh.save')).toHaveLength(1);
});
test('native capability loss and recapture also fence late mutation ACKs without retiring the window', async () => {
  const f = await fixture(); f.controller.setActive(true); await settle();
  const prior = f.controller.state().snapshot, gate = deferred(); f.host.operationGate = gate.promise;
  const write = f.controller.save({ ...row, label: 'Capability epoch commit' }); await settle();
  f.host.capability = { ...caps, connections: { ...caps.connections, phase: 'stopping', supported: false } };
  await f.port.refreshCapabilities(); expect(f.port.ready()).toBe(false); expect(f.port.current()).toBe(true);
  f.host.capability = caps; await f.port.refreshCapabilities(); expect(f.port.ready()).toBe(true);
  gate.resolve(); expect(await write).toBe(false);
  expect(f.controller.state().snapshot).toBe(prior); expect(f.controller.state().unknown).toBeTruthy();
  f.host.operationGate = undefined; await f.controller.refresh();
  expect(f.controller.state().unknown).toBeNull();
  expect(f.host.calls.filter(row => row.name === 'desktop.ssh.save')).toHaveLength(1);
});
test('per-owner IDs are unique, bounded opaque identifiers; dispose does not send native disconnect/cancel', async () => {
  const f = await fixture(), other = await fixture(f.host), ids = new Set<string>();
  for (const port of [f.port, other.port]) for (let i = 0; i < 100; i++) { const id = port.newID(); expect(id).toMatch(/^[A-Za-z0-9_-]{1,128}$/); ids.add(id); }
  expect(ids.size).toBe(200); f.port.dispose(); other.port.dispose(); expect(f.host.calls).toHaveLength(2);
});
test('adapter validates frozen inputs before dispatch, including native safe-number bound', async () => {
  const f = await fixture();
  for (const input of [{ requestID: 'safe', revision: 0, instance: { ...row, password: 'forbidden' } },
    { requestID: '/path', revision: 0, instance: row }, { requestID: 'safe', revision: 9_007_199_254_740_001, instance: row }]) {
    await expect(f.port.save(input)).rejects.toBeInstanceOf(DesktopSshDenied);
  }
  await expect(f.port.cancel({ id: row.id, attempt: 0 })).rejects.toBeInstanceOf(DesktopSshDenied);
  expect(f.host.calls.map(row => row.name)).toEqual(['desktop.ssh.capabilities']);
});
test('retired owner suppresses late committed mutation rather than publishing to a replacement', async () => {
  const f = await fixture(); f.controller.setActive(true); await settle();
  const prior = f.controller.state().snapshot, gate = deferred(); f.host.operationGate = gate.promise;
  const mutation = f.controller.save({ ...row, label: 'Late commit' }); f.retire(); gate.resolve();
  expect(await mutation).toBe(false); expect(f.controller.state().snapshot).toBe(prior);
  expect(await f.controller.refresh()).toBeUndefined();
  expect(f.host.calls.filter(row => row.name === 'desktop.ssh.save')).toHaveLength(1);
});
