import { beforeEach, expect, test, vi } from 'vitest';
const h = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('nsh', () => ({ host: { available: () => true, call: h.call },
  signal<T>(initial: T) { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); },
  untracked: <T>(work: () => T) => work(),
}));
import { createNativeDesktopHeaderUpdateOwner } from './desktop-header-update-native';
import { createNativeDesktopHeaderUpdateRoot } from './desktop-header-update-root';
import type { PageOperation } from './page-operations';

const snapshot = { supported: true, host: 'cli', serverId: 'synthetic-server', channel: 'stable', currentVersion: '2.3.0', available: true, checkError: null,
  update: { version: '2.4.0', kind: 'cli-package', planId: 'synthetic-plan', rollback: false, restartRequired: true }, operation: null };
beforeEach(() => { h.call.mockReset(); h.call.mockResolvedValue({ status: 200, body: snapshot }); });
function fixture() {
  let origin = 'https://synthetic.invalid', auth = 'synthetic-auth', lease = 'synthetic-lease';
  const identity = () => origin === 'https://synthetic.invalid' && auth === 'synthetic-auth';
  const operation = () => { const captured = lease; return { generation: 1, scope: { hostID: 'synthetic', lease: captured }, current: () => identity() && lease === captured,
    request: async () => { throw new Error('The existing raw native adapter, not a second request lane, owns this read'); } }; };
  const owner = createNativeDesktopHeaderUpdateOwner({ current: identity, operation: operation() });
  return { owner, operation, identity, change(field: 'origin' | 'auth' | 'lease') { if (field === 'origin') origin = 'https://other-synthetic.invalid'; if (field === 'auth') auth = 'other-auth'; if (field === 'lease') lease = 'next-lease'; } };
}
test('native producer binds expectedHost, only status GET and no implicit metadata/update capability', async () => {
  const f = fixture(); expect(h.call).not.toHaveBeenCalled();
  await f.owner.port.read({ current: () => true });
  expect(h.call).toHaveBeenCalledExactlyOnceWith('runtime.request', { path: '/api/system/update', method: 'GET', expectedHost: { hostID: 'synthetic', lease: 'synthetic-lease' } });
  await f.owner.about.prepareUpdate(); await f.owner.about.confirmUpdate(); await f.owner.port.run({ current: () => true });
  expect(h.call).toHaveBeenCalledTimes(1); expect(f.owner.about.updateWritable()).toBe(false); expect(f.owner.port.nativeGate()).toBe(false);
});
test.each(['origin', 'auth'] as const)('%s changes reject both a late response and future old-owner reads', async field => {
  const f = fixture(); let finish!: (value: unknown) => void;
  h.call.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  const pending = f.owner.port.read({ current: () => true }); f.change(field);
  finish({ status: 200, body: snapshot }); await expect(pending).rejects.toThrow('about_projection_stale');
  expect(f.owner.about.state().hostUpdate.value).toBeNull();
  f.owner.updateOperation(f.operation()); await expect(f.owner.port.read({ current: () => true })).rejects.toThrow(); expect(h.call).toHaveBeenCalledTimes(1);
});
test('same-identity lease renewal preserves prior, fences old read, and replacement is explicit and zero-I/O', async () => {
  const f = fixture(); await f.owner.port.read({ current: () => true });
  let finish!: (value: unknown) => void; h.call.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const pending = f.owner.about.hostUpdate(); f.change('lease'); f.owner.updateOperation(f.operation());
  expect(h.call).toHaveBeenCalledTimes(2); expect(f.owner.about.state().hostUpdate).toMatchObject({ refreshing: false, value: { currentVersion: '2.3.0' } });
  finish({ status: 200, body: { ...snapshot, currentVersion: '9.9.9' } }); await pending;
  expect(f.owner.about.state().hostUpdate.value?.currentVersion).toBe('2.3.0');
  await f.owner.port.read({ current: () => true });
  expect(h.call).toHaveBeenLastCalledWith('runtime.request', { path: '/api/system/update', method: 'GET', expectedHost: { hostID: 'synthetic', lease: 'next-lease' } });
});
test('retired exact-directory Header intent starts no request; hidden push subscription does no work', async () => {
  const f = fixture(); const changed = vi.fn(), intent = { current: () => false };
  const unsubscribe = f.owner.subscribe(intent, changed); await expect(f.owner.port.read(intent)).rejects.toThrow();
  expect(h.call).not.toHaveBeenCalled(); expect(changed).not.toHaveBeenCalled(); unsubscribe();
});
test('public native root is lazy, shares a single real bound source, and renews its original operation without status I/O', async () => {
  let lease = 'synthetic-lease', operation: PageOperation | null = null;
  const capture = (): PageOperation => { const captured = lease; return { generation: 1, scope: { hostID: 'synthetic', lease: captured }, current: () => lease === captured, request: async () => { throw new Error('Unexpected second read boundary'); } }; };
  const root = createNativeDesktopHeaderUpdateRoot({ current: () => true, committed: () => ({ host: { hostID: 'synthetic', lease }, authorityKey: 'synthetic-origin-auth' }), operation: () => operation });
  expect(h.call).not.toHaveBeenCalled(); operation = capture(); root.reconcile(); const about = root.about()!;
  await root.port.read({ current: () => true }); expect(h.call).toHaveBeenCalledTimes(1);
  operation = null; root.reconcile(); await about.hostUpdate(); expect(h.call).toHaveBeenCalledTimes(1);
  lease = 'renewed'; operation = capture(); root.reconcile(); expect(root.about()).toBe(about); expect(h.call).toHaveBeenCalledTimes(1);
  await root.port.read({ current: () => true }); expect(h.call).toHaveBeenLastCalledWith('runtime.request', { path: '/api/system/update', method: 'GET', expectedHost: { hostID: 'synthetic', lease: 'renewed' } });
  expect(root.canClose()).toBe(true); expect(root.dispose()).toBe(true);
});
