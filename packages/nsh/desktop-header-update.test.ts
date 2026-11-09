import { describe, expect, test, vi } from 'vitest';
import { createSettingsAbout } from './settings-about-core';
import { createDesktopHeaderUpdateOwner } from './desktop-header-update';
import { createDesktopHeaderServices } from './desktop-header-services';

const plan = { version: '2.4.0', kind: 'cli-package', planId: 'synthetic-plan', rollback: false, restartRequired: true, releaseNotes: 'Synthetic notes' };
const snapshot = { supported: true, host: 'cli', serverId: 'synthetic-server', channel: 'stable', currentVersion: '2.3.0', available: true, checkError: null, update: plan, operation: null };
const task = { id: 'synthetic-task', planId: plan.planId, version: plan.version, kind: plan.kind, channel: 'stable', status: 'checking', progress: null };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(write = false) {
  let current = true;
  const read = vi.fn(async (_path: string): Promise<unknown> => snapshot), submitUpdate = vi.fn(async (): Promise<unknown> => ({ operation: task }));
  const call = vi.fn(async (): Promise<unknown> => { throw new Error('Unexpected native call'); });
  const about = createSettingsAbout({ current: () => current, read, call, hostID: 'synthetic-host', ...(write ? { submitUpdate } : {}) });
  const owner = createDesktopHeaderUpdateOwner({ about, current: () => current });
  const intent = { current: () => current };
  return { about, owner, read, call, submitUpdate, intent, setCurrent(value: boolean) { current = value; } };
}

describe('single About source for Settings and desktop Instance', () => {
  test('construct/hidden/Usage and 50 same-demand input updates perform zero reads', async () => {
    const f = fixture(), changed = vi.fn(), request = vi.fn(async () => { throw new Error('Unexpected MCP read'); });
    const operation = { current: () => true, request };
    const services = createDesktopHeaderServices({ current: () => true, operation: () => operation, update: f.owner.port, changed });
    for (let index = 0; index < 50; index++) services.update({ tab: 'usage', active: true });
    expect(f.read).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
    services.update({ tab: 'instance', active: true });
    await services.refreshInstance();
    const reads = f.read.mock.calls.length;
    for (let index = 0; index < 50; index++) services.update({ tab: 'instance', active: true });
    expect(f.read).toHaveBeenCalledTimes(reads); expect(f.call).not.toHaveBeenCalled();
    services.dispose(); expect(f.owner.dispose()).toBe(true);
  });
  test('both consumers await ONE status flight, not a prematurely resolved refreshing snapshot', async () => {
    const f = fixture(), gate = deferred<unknown>(); f.read.mockReturnValue(gate.promise);
    const settings = f.about.hostUpdate();
    let headerSettled = false;
    const header = f.owner.port.read(f.intent).then(value => { headerSettled = true; return value; });
    await Promise.resolve(); expect(headerSettled).toBe(false); expect(f.read).toHaveBeenCalledTimes(1);
    gate.resolve(snapshot); await settings;
    expect(await header).toMatchObject({ hostUpdate: { status: 'ready', refreshing: false, value: { currentVersion: '2.3.0', plan } } });
    expect(f.call).not.toHaveBeenCalled();
  });
  test('a synchronous source subscriber joins the published flight instead of completing on refreshing', async () => {
    const f = fixture(), gate = deferred<unknown>(); f.read.mockReturnValue(gate.promise);
    let reentrant: Promise<unknown> | undefined, finished = false;
    const unsubscribe = f.about.subscribe(value => {
      if (value.hostUpdate.refreshing && !reentrant) reentrant = f.owner.port.read(f.intent).then(() => { finished = true; });
    });
    const reading = f.about.hostUpdate(); await Promise.resolve();
    expect(reentrant).toBeDefined(); expect(finished).toBe(false); expect(f.read).toHaveBeenCalledTimes(1);
    gate.resolve(snapshot); await Promise.all([reading, reentrant]); expect(finished).toBe(true); unsubscribe();
  });
  test('failure preserves prior for both consumers and is never authoritative empty success', async () => {
    const f = fixture(); await f.owner.port.read(f.intent);
    f.read.mockRejectedValue(new Error('Synthetic failure'));
    const result = await f.owner.port.read(f.intent);
    expect(result.hostUpdate).toMatchObject({ status: 'failed', refreshing: false, value: { currentVersion: '2.3.0', plan } });
    expect(f.about.state().hostUpdate).toBe(result.hostUpdate);
    expect(JSON.stringify(result)).not.toContain('Synthetic failure');
    expect(f.owner.port.nativeGate()).toBe(false); expect(f.owner.port.available()).toBe(false);
    expect(await f.owner.port.run(f.intent)).toEqual({ status: 'unsupported' });
    expect(f.submitUpdate).not.toHaveBeenCalled();
  });
  test('Header remains read-only even when an injected About controller has a synthetic submitter', async () => {
    const f = fixture(true); await f.owner.port.read(f.intent);
    expect(f.about.updateAvailable()).toBe(true);
    expect(await f.owner.port.run(f.intent)).toEqual({ status: 'unsupported' });
    expect(f.owner.unavailableReason).toBe('native-update-admission-and-confirmation-unavailable');
    expect(f.submitUpdate).not.toHaveBeenCalled();
  });
  test('read-only source cannot manufacture confirmation; Settings explicit refresh reuses the flight', async () => {
    const f = fixture(); await f.about.prepareUpdate(); expect(f.about.state().updateConfirm).toBeNull();
    expect(f.read).not.toHaveBeenCalled(); expect(f.about.updateWritable()).toBe(false);
    const gate = deferred<unknown>(); f.read.mockImplementation(path => path === '/api/system/update' ? gate.promise : Promise.resolve({}));
    const header = f.owner.port.read(f.intent), settings = f.about.refresh();
    expect(f.read.mock.calls.filter(([path]) => path === '/api/system/update')).toHaveLength(1);
    gate.resolve(snapshot); await Promise.all([header, settings]);
    expect(f.about.state().hostUpdate.status).toBe('ready');
  });
  test('closing/reopening consumers preserves prior and unknown; failed dispose does not wash locks', async () => {
    const f = fixture(true); await f.about.prepareUpdate();
    expect(f.owner.dispose()).toBe(false); expect(f.about.state().updateConfirm?.plan).toEqual(plan);
    const post = deferred<unknown>(); f.submitUpdate.mockReturnValue(post.promise);
    const saving = f.about.confirmUpdate(); expect(f.owner.dispose()).toBe(false);
    expect(f.about.state()).toMatchObject({ updateBusy: true, updateUncertain: true });
    post.resolve({ operation: {} }); await saving;
    expect(f.owner.dispose()).toBe(false); expect(f.about.state().updateUncertain).toBe(true);
    // An idle plan or another task is not a receipt for the lost POST.
    await f.about.reconcileUpdate(); expect(f.about.state().updateUncertain).toBe(true);
    f.read.mockResolvedValue({ ...snapshot, update: null, operation: { ...task, planId: 'another-plan' } });
    await f.about.reconcileUpdate(); expect(f.about.state().updateUncertain).toBe(true);
    f.read.mockRejectedValue(new Error('Restart gap')); await f.about.reconcileUpdate();
    expect(f.about.state().updateUncertain).toBe(true); expect(f.owner.dispose()).toBe(false);
    f.read.mockResolvedValue({ ...snapshot, update: null, operation: task }); await f.about.reconcileUpdate();
    expect(f.about.state().updateUncertain).toBe(false); expect(f.submitUpdate).toHaveBeenCalledTimes(1);
    expect(f.owner.dispose()).toBe(true);
  });
  test('lease replacement during pending POST preserves unknown and ignores the retired completion', async () => {
    const f = fixture(true); await f.about.prepareUpdate(); const gate = deferred<unknown>(); f.submitUpdate.mockReturnValue(gate.promise);
    const saving = f.about.confirmUpdate();
    f.about.replaceLane({ current: () => true, hostID: 'synthetic-host', read: f.read, call: f.call, submitUpdate: f.submitUpdate });
    expect(f.about.state()).toMatchObject({ updateBusy: false, updateUncertain: true }); expect(f.owner.dispose()).toBe(false);
    gate.resolve({ operation: task }); await saving;
    expect(f.about.state().updateUncertain).toBe(true); expect(f.submitUpdate).toHaveBeenCalledTimes(1);
  });
  test('modal intent retirement fences late Header read/push but does not destroy shared status', async () => {
    const f = fixture(), gate = deferred<unknown>(); let visible = true;
    const intent = { current: () => visible }, changed = vi.fn();
    const unsubscribe = f.owner.subscribe(intent, changed);
    f.read.mockReturnValue(gate.promise); const read = f.owner.port.read(intent);
    visible = false; gate.resolve(snapshot);
    await expect(read).rejects.toThrow('about_projection_stale'); expect(f.about.state().hostUpdate.status).toBe('ready');
    const count = changed.mock.calls.length; await f.about.hostUpdate(); expect(changed).toHaveBeenCalledTimes(count);
    unsubscribe(); visible = true;
    expect(f.owner.projection().hostUpdate.value?.currentVersion).toBe('2.3.0');
  });
  test('identity retirement is permanent, even if caller accidentally restores its boolean', async () => {
    const f = fixture(); f.setCurrent(false); await expect(f.owner.port.read(f.intent)).rejects.toThrow(); f.setCurrent(true);
    await expect(f.owner.port.read(f.intent)).rejects.toThrow(); expect(f.read).not.toHaveBeenCalled();
  });
});
