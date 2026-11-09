import { expect, it, vi } from 'vitest';
import { createLocalCompatibilityPreferences, iosNativeUiPreferenceKey, type SidebarBrandCapture } from './local-compatibility-preferences-core';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture() {
  const disk = new Map<string, string>(), changes = vi.fn();
  const get = vi.fn(async (key: string) => disk.get(key) ?? null);
  const set = vi.fn(async (key: string, value: string) => { disk.set(key, value); });
  const preferences = createLocalCompatibilityPreferences({ get, set });
  let transportID: string | null = 'route-A', host = { hostID: 'connection', lease: 'lease-1' }, active = true;
  const capture = (): SidebarBrandCapture => ({ transportID: transportID!, expectedHost: { ...host }, current: () => active,
    currentHost: () => host, currentTransportID: () => transportID });
  return { disk, changes, get, set, preferences, capture,
    select(id: string | null) { transportID = id; }, lease(value: string) { host = { ...host, lease: value }; },
    active(value: boolean) { active = value; },
    brand: () => preferences.openSidebarBrand(capture(), changes),
    ios: () => preferences.openIosNativeUi({ current: () => active, changed: changes }),
  };
}

it('successful missing/legacy reads default without writing; whitespace and 64 UTF-16 units match the Web store', async () => {
  const f = fixture(), owner = f.brand();
  expect(owner.snapshot()).toBeNull();
  expect(await owner.load()).toEqual({ sidebarBrandName: 'Yuri' });
  const key = f.get.mock.calls[0][0]; f.disk.set(key, '{}');
  expect(await owner.load()).toEqual({ sidebarBrandName: 'Yuri' });
  expect(f.set).not.toHaveBeenCalled();
  for (const name of ['', '   ', '  custom  brand  ', '😀'.repeat(40)]) {
    expect(await owner.save({ sidebarBrandName: name })).toEqual({ sidebarBrandName: name.slice(0, 64) });
    expect(JSON.parse(f.disk.get(key)!)).toEqual({ sidebarBrandName: name.slice(0, 64) });
  }
  owner.dispose();
  expect(await f.brand().load()).toEqual({ sidebarBrandName: '😀'.repeat(32) });
});

it('exact transport partitions remain independent even for the same Host; retiring callbacks cannot change the new owner', async () => {
  const f = fixture(), a = f.brand();
  await a.save({ sidebarBrandName: 'A' });
  f.select('route-B'); const b = f.brand();
  expect(a.snapshot()).toBeNull();
  await expect(a.save({ sidebarBrandName: 'wrong' })).rejects.toThrow('stale');
  expect(await b.load()).toEqual({ sidebarBrandName: 'Yuri' });
  await b.save({ sidebarBrandName: 'B' });
  f.select('route-A');
  expect(await f.brand().load()).toEqual({ sidebarBrandName: 'A' });
  expect(f.disk.size).toBe(2);
  expect([...f.disk.keys()].every(key => !key.includes('connection') && !key.includes('lease'))).toBe(true);
});

it('requires explicit opaque transport identity and native receipt without a hostname/global fallback', () => {
  const f = fixture();
  for (const transportID of ['', 'https://server.example/path?token=private', '/workspace/project', 'a.b', 'x'.repeat(129)]) {
    expect(() => f.preferences.openSidebarBrand({ ...f.capture(), transportID }, f.changes)).toThrow('scope_required');
  }
  expect(() => f.preferences.openSidebarBrand({ ...f.capture(), expectedHost: null as never }, f.changes)).toThrow('scope_required');
  expect(f.get).not.toHaveBeenCalled(); expect(f.set).not.toHaveBeenCalled();
});

it('a stale open cannot retire a valid handle and changing the capture object cannot replace its authority', async () => {
  const f = fixture(), capture = f.capture(), owner = f.preferences.openSidebarBrand(capture, f.changes);
  await owner.save({ sidebarBrandName: 'prior' });
  expect(() => f.preferences.openSidebarBrand({ ...capture, expectedHost: { hostID: 'connection', lease: 'old' } }, f.changes)).toThrow('stale');
  expect(owner.snapshot()).toEqual({ sidebarBrandName: 'prior' });
  const held = capture.expectedHost as { hostID: string; lease: string }; held.lease = 'mutated';
  expect(await owner.load()).toEqual({ sidebarBrandName: 'prior' });
  f.lease('lease-2');
  await expect(owner.load()).rejects.toThrow('stale');
});

it('a lease change during read prevents both publication and the following write; retries never adopt a newer receipt', async () => {
  const f = fixture(), read = deferred<string | null>(), entered = deferred<void>();
  f.get.mockImplementationOnce(async () => { entered.resolve(); return read.promise; });
  const owner = f.brand(), save = owner.save({ sidebarBrandName: 'old' });
  await entered.promise; f.lease('lease-2'); read.resolve(null);
  await expect(save).rejects.toThrow('stale');
  await expect(owner.load()).rejects.toThrow('stale');
  expect(f.set).not.toHaveBeenCalled(); expect(f.changes).not.toHaveBeenCalled();
  expect(await f.brand().load()).toEqual({ sidebarBrandName: 'Yuri' });
});

it('a transport switch while a read is pending cannot publish into another partition', async () => {
  const f = fixture(), read = deferred<string | null>(), entered = deferred<void>();
  f.get.mockImplementationOnce(async () => { entered.resolve(); return read.promise; });
  const old = f.brand().load(); await entered.promise;
  f.select('route-B'); const current = f.brand(); await current.load();
  read.resolve('{"sidebarBrandName":"old A"}');
  await expect(old).rejects.toThrow('stale');
  expect(f.changes.mock.calls).toEqual([[{ sidebarBrandName: 'Yuri' }]]);
});

it('an already dispatched write stays on its captured key and serializes before a replacement owner reads', async () => {
  const f = fixture(), write = deferred<void>(), entered = deferred<void>();
  f.set.mockImplementationOnce(async (key, value) => { entered.resolve(); await write.promise; f.disk.set(key, value); });
  const old = f.brand(), saving = old.save({ sidebarBrandName: 'persisted A' });
  await entered.promise; old.dispose(); const replacement = f.brand(), loading = replacement.load();
  expect(f.get).toHaveBeenCalledTimes(1);
  write.resolve(); await expect(saving).rejects.toThrow('stale');
  expect(await loading).toEqual({ sidebarBrandName: 'persisted A' });
  expect(f.changes).toHaveBeenCalledTimes(1);
});

it('queued saves capture drafts and read before every write, and a replaced/disposed owner cannot dispatch queued work', async () => {
  const f = fixture(), owner = f.brand(), draft = { sidebarBrandName: 'captured' };
  const saved = owner.save(draft); draft.sidebarBrandName = 'mutated';
  expect(await saved).toEqual({ sidebarBrandName: 'captured' });
  const events: string[] = [];
  f.get.mockImplementation(async key => { events.push('read'); return f.disk.get(key) ?? null; });
  f.set.mockImplementation(async (key, value) => { events.push('write'); f.disk.set(key, value); });
  await Promise.all([owner.save({ sidebarBrandName: 'first' }), owner.save({ sidebarBrandName: 'last' })]);
  expect(events).toEqual(['read', 'write', 'read', 'write']);
  const stale = owner.save({ sidebarBrandName: 'must not write' }); f.brand();
  await expect(stale).rejects.toThrow('stale');
  const newOwner = f.brand(); newOwner.dispose(); await expect(newOwner.load()).rejects.toThrow('stale');
});

it('brand read/malformed/write failures preserve prior, do not echo storage details, and leave the serial lane retryable', async () => {
  const f = fixture(), owner = f.brand(); await owner.save({ sidebarBrandName: 'prior' });
  const prior = owner.snapshot(), key = f.get.mock.calls[0][0]; f.set.mockClear(); f.changes.mockClear();
  f.get.mockRejectedValueOnce(new Error('private path and credential'));
  await expect(owner.save({ sidebarBrandName: 'new' })).rejects.toThrow('local_preference_read_failed');
  for (const raw of ['broken', 'null', '[]', 'false', '{"sidebarBrandName":null}', '{"sidebarBrandName":4}', '{"token":"private"}']) {
    f.disk.set(key, raw); await expect(owner.load()).rejects.toThrow('invalid');
    await expect(owner.save({ sidebarBrandName: 'new' })).rejects.toThrow('invalid');
    expect(owner.snapshot()).toBe(prior); expect(f.disk.get(key)).toBe(raw);
  }
  expect(f.set).not.toHaveBeenCalled(); expect(f.changes).not.toHaveBeenCalled();
  f.disk.set(key, JSON.stringify(prior)); f.set.mockRejectedValueOnce(new Error('private'));
  await expect(owner.save({ sidebarBrandName: 'new' })).rejects.toThrow('local_preference_write_failed');
  expect(owner.snapshot()).toBe(prior);
  expect(await owner.save({ sidebarBrandName: 'recovered' })).toEqual({ sidebarBrandName: 'recovered' });
});

it('the iOS compatibility flag defaults only after a valid read, persists true and false, and is device-wide across transports', async () => {
  const f = fixture(), owner = f.ios(); expect(owner.snapshot()).toBeNull();
  expect(await owner.load()).toEqual({ iosNativeUiEnabled: false });
  f.disk.set(iosNativeUiPreferenceKey, '{}');
  expect(await owner.load()).toEqual({ iosNativeUiEnabled: false });
  expect(f.set).not.toHaveBeenCalled();
  await owner.save({ iosNativeUiEnabled: true }); owner.dispose(); f.select('route-B');
  const reopened = f.ios(); expect(await reopened.load()).toEqual({ iosNativeUiEnabled: true });
  await reopened.save({ iosNativeUiEnabled: false });
  expect(await f.ios().load()).toEqual({ iosNativeUiEnabled: false });
  expect([...f.disk.keys()]).toEqual([iosNativeUiPreferenceKey]);
});

it('flag corruption, invalid drafts, read/write errors and inactive owners never publish a false default or overwrite prior', async () => {
  const f = fixture(), owner = f.ios(); await owner.save({ iosNativeUiEnabled: true });
  const prior = owner.snapshot(); f.set.mockClear(); f.changes.mockClear();
  for (const raw of ['broken', '[]', '{"iosNativeUiEnabled":"false"}', '{"iosNativeUiEnabled":0}', '{"iosNativeUiEnabled":null}']) {
    f.disk.set(iosNativeUiPreferenceKey, raw);
    await expect(owner.load()).rejects.toThrow('invalid');
    await expect(owner.save({ iosNativeUiEnabled: false })).rejects.toThrow('invalid');
    expect(owner.snapshot()).toBe(prior);
  }
  f.disk.set(iosNativeUiPreferenceKey, JSON.stringify(prior));
  await expect(owner.save({ iosNativeUiEnabled: 'false' as never })).rejects.toThrow('invalid');
  f.get.mockRejectedValueOnce(new Error('disk')); await expect(owner.load()).rejects.toThrow('read_failed');
  f.set.mockRejectedValueOnce(new Error('disk')); await expect(owner.save({ iosNativeUiEnabled: false })).rejects.toThrow('write_failed');
  expect(owner.snapshot()).toBe(prior); expect(f.changes).not.toHaveBeenCalled();
  f.active(false); await expect(owner.save({ iosNativeUiEnabled: false })).rejects.toThrow('stale');
  f.active(true); expect(await owner.save({ iosNativeUiEnabled: false })).toEqual({ iosNativeUiEnabled: false });
});
