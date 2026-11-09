import { describe, expect, test, vi } from 'vitest';
import { createDesktopHeaderUpdateRootController, type DesktopHeaderUpdateCommitted } from './desktop-header-update-root-core';
import { createDesktopHeaderUpdateOwner } from './desktop-header-update';
import { aboutCanClose, createSettingsAbout, type AboutDependencies } from './settings-about-core';
import type { PageOperation } from './page-operations';

const plan = { version: '2.4.0', kind: 'cli-package', planId: 'synthetic-plan', rollback: false, restartRequired: true };
const snapshot = { supported: true, host: 'cli', serverId: 'synthetic-server', channel: 'stable', currentVersion: '2.3.0', available: true, update: plan, operation: null, checkError: null };
function gate<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(write = false) {
  let alive = true, descriptor: DesktopHeaderUpdateCommitted | null = null, assigned: PageOperation | null = null;
  const read = vi.fn(async (): Promise<unknown> => snapshot), call = vi.fn(async (name: string, input?: Record<string, unknown>): Promise<unknown> => name === 'native.diagnostics.status' || name === 'native.diagnostics.setEnabled'
    ? { schemaVersion: 2, mode: 'event-recorder', enabled: input?.enabled ?? true } : name === 'native.diagnostics.export' ? { outcome: 'shared' } : { schemaVersion: 1, version: '0.1.0', build: '1', updates: { status: 'unsupported' } });
  const submit = vi.fn(async (): Promise<unknown> => { throw new Error('Synthetic lost ACK'); });
  const sources: ReturnType<typeof createDesktopHeaderUpdateOwner>[] = [], disposals: ReturnType<typeof vi.fn>[] = [];
  const factory = vi.fn((input: { current(): boolean; operation: PageOperation | null; admitted?(): boolean }) => {
    let operation = input.operation;
    const dependencies = (): AboutDependencies => { const captured = operation; return { hostID: captured?.scope?.hostID ?? null,
      current: () => input.current() && operation === captured && captured?.current() === true && input.admitted?.() !== false,
      read, call, ...(write ? { submitUpdate: submit } : {}) }; };
    const about = createSettingsAbout(dependencies()), source = createDesktopHeaderUpdateOwner({ about, current: input.current });
    const dispose = vi.fn(source.dispose); sources.push(source); disposals.push(dispose);
    return { ...source, dispose, updateOperation(next: PageOperation | null) { if (operation === next) return; operation = next; about.replaceLane(dependencies()); } };
  });
  const current = vi.fn(() => alive), committed = vi.fn(() => descriptor), operation = vi.fn(() => assigned);
  const root = createDesktopHeaderUpdateRootController({ current, committed, operation }, factory);
  function adopt(hostID = 'a', authorityKey = 'synthetic-origin-auth-a', lease = 'lease-a') {
    descriptor = { host: { hostID, lease }, authorityKey };
    const captured = { ...descriptor, host: { ...descriptor.host } };
    assigned = { scope: captured.host, generation: 1, current: () => alive && !!descriptor && descriptor.host.hostID === captured.host.hostID && descriptor.host.lease === captured.host.lease && descriptor.authorityKey === captured.authorityKey,
      request: async () => { throw new Error('No second reader'); } };
  }
  return { root, factory, read, call, submit, sources, disposals, current, committed, operation, adopt,
    pause() { assigned = null; }, descriptor(value: DesktopHeaderUpdateCommitted | null) { descriptor = value; }, alive(value: boolean) { alive = value; },
    mismatchedOperation() { assigned = { ...assigned!, scope: { hostID: 'wrong-host', lease: 'wrong-lease' } }; },
  };
}
const intent = { current: () => true };

describe('window-retained thin About root', () => {
  test('constructor is inert, early empty/current=false does not poison the first committed owner, fifty reconciles are zero I/O', () => {
    const f = fixture(); expect(f.current).not.toHaveBeenCalled(); expect(f.committed).not.toHaveBeenCalled(); expect(f.operation).not.toHaveBeenCalled();
    const port = f.root.port; expect(f.root.about()).toBeUndefined(); expect(f.root.canClose()).toBe(true);
    f.alive(false); expect(f.root.reconcile()).toBe(false); f.alive(true); f.adopt();
    expect(f.root.reconcile()).toBe(true); const about = f.root.about(); expect(about).toBeDefined();
    for (let index = 0; index < 50; index++) { f.root.reconcile(); expect(f.root.about()).toBe(about); expect(f.root.canClose()).toBe(true); }
    expect(f.root.port).toBe(port); expect(f.factory).toHaveBeenCalledTimes(1); expect(f.read).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled(); expect(f.disposals[0]).not.toHaveBeenCalled();
  });
  test('same authority pause/null descriptor/resume and lease renewal retain one controller and prior', async () => {
    const f = fixture(); f.adopt(); const about = f.root.about()!; await f.root.port.read(intent);
    f.pause(); expect(f.root.reconcile()).toBe(true); expect(f.root.about()).toBe(about);
    await expect(f.root.port.read(intent)).rejects.toThrow('about_root_unavailable'); expect(about.state().hostUpdate.value?.currentVersion).toBe('2.3.0');
    f.descriptor(null); expect(f.root.reconcile()).toBe(false); expect(f.root.about()).toBeUndefined(); await about.hostUpdate();
    expect(f.read).toHaveBeenCalledTimes(1);
    f.adopt('a', 'synthetic-origin-auth-a', 'lease-next'); expect(f.root.reconcile()).toBe(true); expect(f.root.about()).toBe(about);
    expect(f.factory).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1); await f.root.port.read(intent);
    expect(f.read).toHaveBeenCalledTimes(2); expect(f.root.canClose()).toBe(true);
  });
  test('root port and Settings await the identical existing status flight without another source', async () => {
    const f = fixture(); f.adopt(); const about = f.root.about()!, pending = gate<unknown>(); f.read.mockReturnValueOnce(pending.promise);
    const settings = about.hostUpdate(), header = f.root.port.read(intent);
    expect(f.read).toHaveBeenCalledTimes(1); expect(f.root.canClose()).toBe(false);
    pending.resolve(snapshot); await Promise.all([settings, header]); expect(f.root.canClose()).toBe(true); expect(f.factory).toHaveBeenCalledTimes(1);
  });
  test('Host/origin/auth transition disposes idle owner once, never returns the old controller, stable port projects new source', async () => {
    const f = fixture(); f.adopt(); const first = f.root.about()!; await f.root.port.read(intent);
    f.adopt('a', 'other-origin-and-auth'); const second = f.root.about()!;
    expect(second).not.toBe(first); expect(f.factory).toHaveBeenCalledTimes(2); expect(f.disposals[0]).toHaveBeenCalledTimes(1);
    await first.hostUpdate(); expect(f.read).toHaveBeenCalledTimes(1);
    await f.root.port.read(intent); expect(f.read).toHaveBeenCalledTimes(2);
    f.adopt('b', 'host-b'); expect(f.root.about()).not.toBe(second); expect(f.factory).toHaveBeenCalledTimes(3);
  });
  test('authority change while a status read is pending keeps old entry/guard, fences result, and switches only after real settlement', async () => {
    const f = fixture(); f.adopt(); const first = f.root.about()!, pending = gate<unknown>(); f.read.mockReturnValueOnce(pending.promise);
    const reading = f.root.port.read(intent); expect(f.root.canClose()).toBe(false);
    for (let index = 0; index < 50; index++) expect(f.root.canClose()).toBe(false);
    expect(f.disposals[0]).not.toHaveBeenCalled();
    f.adopt('b', 'host-b'); expect(f.root.reconcile()).toBe(false); expect(f.root.about()).toBeUndefined(); expect(f.factory).toHaveBeenCalledTimes(1);
    pending.resolve(snapshot); await expect(reading).rejects.toThrow();
    expect(first.state().hostUpdate.value).toBeNull(); expect(f.root.canClose()).toBe(true);
    expect(f.root.reconcile()).toBe(true); expect(f.root.about()).not.toBe(first); expect(f.factory).toHaveBeenCalledTimes(2);
  });
  test('lease replacement cannot wash actual read flight just because retain cleared the displayed refreshing field', async () => {
    const f = fixture(); f.adopt(); const about = f.root.about()!, pending = gate<unknown>(); f.read.mockReturnValueOnce(pending.promise);
    const reading = about.hostUpdate(); f.adopt('a', 'synthetic-origin-auth-a', 'renewed'); f.root.reconcile();
    expect(about.state().hostUpdate.refreshing).toBe(false); expect(f.root.canClose()).toBe(false);
    pending.resolve(snapshot); await reading; expect(f.root.canClose()).toBe(true); expect(f.root.about()).toBe(about);
  });
  test('known unknown, confirmation and pending POST stay on their original authority and block replacement/close', async () => {
    const f = fixture(true); f.adopt(); const about = f.root.about()!; await about.prepareUpdate();
    expect(f.root.canClose()).toBe(false); expect(about.state().updateConfirm?.plan?.planId).toBe(plan.planId);
    f.adopt('b', 'host-b'); expect(f.root.reconcile()).toBe(false); expect(f.root.about()).toBeUndefined(); expect(f.factory).toHaveBeenCalledTimes(1);
    f.adopt(); f.root.reconcile(); await about.prepareUpdate(); const pending = gate<unknown>(); f.submit.mockReturnValueOnce(pending.promise);
    const saving = about.confirmUpdate(); expect(f.root.canClose()).toBe(false);
    pending.resolve({ operation: {} }); await saving; expect(about.state().updateUncertain).toBe(true);
    f.adopt('b', 'host-b'); expect(f.root.about()).toBeUndefined(); expect(f.root.reconcile()).toBe(false); expect(f.root.canClose()).toBe(false);
    expect(f.root.dispose()).toBe(false); expect(about.state().updateUncertain).toBe(true); expect(f.root.about()).toBeUndefined();
    expect(f.root.reconcile()).toBe(false); expect(f.factory).toHaveBeenCalledTimes(1); expect(f.submit).toHaveBeenCalledTimes(1);
  });
  test('diagnostics mutation/export and retired-lane activity are actual canClose guards', async () => {
    const f = fixture(); f.adopt(); const about = f.root.about()!; await about.diagnostics();
    const setting = gate<unknown>(); f.call.mockReturnValueOnce(setting.promise); const changing = about.setDiagnostics(true);
    expect(f.root.canClose()).toBe(false); f.pause(); f.root.reconcile();
    expect(about.state().diagnosticsBusy).toBe(false); expect(f.root.canClose()).toBe(false);
    setting.resolve({ schemaVersion: 2, mode: 'event-recorder', enabled: true }); await changing;
    expect(f.root.canClose()).toBe(true); f.adopt(); f.root.reconcile();
    const sharing = gate<unknown>(); f.call.mockReturnValueOnce(sharing.promise); const exporting = about.exportDiagnostics();
    expect(f.root.canClose()).toBe(false); expect(about.state().exporting).toBe(true);
    sharing.resolve({ outcome: 'shared' }); await exporting; expect(f.root.canClose()).toBe(true);
  });
  test('invalid descriptor, wrong operation scope and stale Header intent cannot cause a GET or capability admission', async () => {
    const f = fixture(); f.adopt(); f.mismatchedOperation(); f.root.reconcile();
    expect(f.root.about()).toBeDefined(); await expect(f.root.port.read(intent)).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
    f.adopt(); await expect(f.root.port.read({ current: () => false })).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
    f.descriptor({ host: { hostID: 'a', lease: '' }, authorityKey: 'auth' }); expect(f.root.about()).toBeUndefined();
    expect(f.root.port.available()).toBe(false); expect(f.root.port.nativeGate()).toBe(false); expect(await f.root.port.run(intent)).toEqual({ status: 'stale' });
  });
  test('retire is callback-only, keeps real read guard until settlement, and cannot reopen another owner', async () => {
    const f = fixture(); f.adopt(); const about = f.root.about()!, pending = gate<unknown>(); f.read.mockReturnValueOnce(pending.promise);
    const reading = f.root.port.read(intent); f.root.retire(); expect(f.root.canClose()).toBe(false);
    expect(f.root.about()).toBeUndefined(); expect(f.root.reconcile()).toBe(false); expect(f.disposals[0]).not.toHaveBeenCalled();
    pending.resolve(snapshot); await expect(reading).rejects.toThrow(); expect(f.root.canClose()).toBe(true);
    expect(about.state().hostUpdate.value).toBeNull(); expect(f.root.dispose()).toBe(true); expect(f.root.dispose()).toBe(true);
    f.adopt('b', 'host-b'); expect(f.root.about()).toBeUndefined(); expect(f.factory).toHaveBeenCalledTimes(1);
  });
  test('refused root dispose retires callbacks but does not release the actual in-flight close guard', async () => {
    const f = fixture(); f.adopt(); const pending = gate<unknown>(); f.read.mockReturnValueOnce(pending.promise);
    const reading = f.root.port.read(intent); expect(f.root.dispose()).toBe(false); expect(f.root.canClose()).toBe(false);
    expect(f.root.about()).toBeUndefined(); pending.resolve(snapshot); await expect(reading).rejects.toThrow();
    expect(f.root.canClose()).toBe(true); expect(f.root.about()).toBeUndefined(); expect(f.root.dispose()).toBe(true);
  });
  test('read failure preserves prior and root canClose never treats failed resource as a pending write', async () => {
    const f = fixture(); f.adopt(); const about = f.root.about()!; await f.root.port.read(intent);
    f.read.mockRejectedValueOnce(new Error('Synthetic failure')); const value = await f.root.port.read(intent);
    expect(value.hostUpdate).toMatchObject({ status: 'failed', value: { currentVersion: '2.3.0' } }); expect(f.root.canClose()).toBe(true); expect(f.root.about()).toBe(about);
  });
  test('all public About read resource flags independently veto synchronous close', () => {
    const f = fixture(); f.adopt(); const state = f.root.about()!.state(); expect(aboutCanClose(state)).toBe(true);
    for (const key of ['client', 'host', 'opencode', 'hostUpdate', 'diagnostics'] as const) expect(aboutCanClose({ ...state, [key]: { ...state[key], refreshing: true } })).toBe(false);
    for (const key of ['updateBusy', 'updateUncertain', 'diagnosticsBusy', 'exporting'] as const) expect(aboutCanClose({ ...state, [key]: true })).toBe(false);
  });
});
