import { describe, expect, it, vi } from 'vitest';
import {
  createDesktopNavigationPersistence, desktopNavigationBytes, desktopNavigationLimits,
  desktopNavigationPartition, desktopNavigationStorageKey,
  type DesktopNavigationAuthority, type DesktopNavigationContext, type DesktopNavigationRestoreDecision,
  type DesktopNavigationStorage, type DesktopNavigationTarget,
} from './desktop-navigation-state-core';

const host = (id = 'A', origin = `https://${id.toLowerCase()}.example`, lease = 'lease-1', authorizationID = 'auth-1'): DesktopNavigationAuthority => ({
  connection: { id, url: origin, authorizationID }, runtimeScope: { hostID: id, lease }, confirmed: true,
});
const route = (sessionID = 'session-1', directory = '/project'): DesktopNavigationTarget => ({ kind: 'session', sessionID, directory });
const entry = (authority = host(), target = route()) => ({ partition: desktopNavigationPartition(authority)!, target });
const disk = (...entries: ReturnType<typeof entry>[]) => JSON.stringify({ version: 1, entries });
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function setup(raw: string | null = null, initial = host()) {
  let value = raw, authority = initial;
  const storage: DesktopNavigationStorage = { getItem: vi.fn(async () => value), setItem: vi.fn(async (_key, next) => { value = next; }) };
  const requestRestore = vi.fn(async (target: DesktopNavigationTarget, _context: DesktopNavigationContext): Promise<DesktopNavigationRestoreDecision> => ({ status: 'ready', target }));
  const onRestore = vi.fn((_target: DesktopNavigationTarget, _context: DesktopNavigationContext) => true);
  const controller = createDesktopNavigationPersistence({ storage, authority: () => authority, requestRestore, onRestore });
  return { controller, storage, requestRestore, onRestore, raw: () => value, setHost: (next: DesktopNavigationAuthority) => { authority = next; controller.synchronize(); }, authority: () => authority };
}

describe('desktop navigation metadata, no migration/Host/draft ownership', () => {
  it('fresh successful empty read never navigates, creates, or writes a default route', async () => {
    const f = setup(); await f.controller.restore();
    expect(f.controller.snapshot().restore).toBe('empty');
    expect(f.requestRestore).not.toHaveBeenCalled(); expect(f.onRestore).not.toHaveBeenCalled();
    expect(f.storage.getItem).toHaveBeenCalledExactlyOnceWith(desktopNavigationStorageKey);
    expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.controller.save(route(), f.authority())).toBe(true); await f.controller.flush();
    expect(f.raw()).toBe(disk(entry()));
  });
  it.each([
    route(), { kind: 'session', sessionID: 's', directory: '/worktree', messageID: 'msg-1' },
    { kind: 'assistant', assistantID: 'bot-1', directory: '' },
    { kind: 'new-session', directory: '/worktree', projectID: 'project-1' },
    { kind: 'new-session', directory: '' }, { kind: 'project', projectID: 'project-1', directory: '/project' },
  ] satisfies DesktopNavigationTarget[])('round trips only the public $kind projection through explicit admission', async target => {
    const f = setup(); f.controller.save(target, f.authority()); await f.controller.flush();
    const second = setup(f.raw()); await second.controller.restore();
    expect(second.requestRestore).toHaveBeenCalledOnce();
    expect(second.requestRestore.mock.calls[0][0]).toEqual(target);
    expect(second.onRestore.mock.calls[0][0]).toEqual(target);
    expect(second.controller.snapshot().restore).toBe('restored');
    expect(second.storage.setItem).not.toHaveBeenCalled();
  });
  it('rejects private owners, content and credential-bearing endpoints instead of persisting them', async () => {
    const f = setup();
    for (const extra of [{ text: 'not navigation' }, { owner: {} }, { controller: () => {} }, { token: 'not navigation' }]) {
      expect(() => f.controller.save({ ...route(), ...extra }, f.authority())).toThrow('navigation_private_fields');
    }
    for (const origin of ['https://user:pass@a.example', 'https://a.example/?token=x', 'https://a.example/path', 'https://a.example/#x']) {
      f.setHost(host('A', origin)); expect(f.controller.save(route(), f.authority())).toBe(false);
    }
    await tick(); expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it('same ID with new origin or authorization cannot restore a prior partition; lease is not persisted identity', async () => {
    const f = setup(disk(entry()), host('A', 'https://other.example'));
    await f.controller.restore(); expect(f.controller.snapshot().restore).toBe('empty');
    f.controller.save(route('other'), f.authority()); await f.controller.flush();
    const auth = setup(f.raw(), host('A', 'https://a.example', 'lease-4', 'auth-2'));
    await auth.controller.restore(); expect(auth.controller.snapshot().restore).toBe('empty');
    const renewed = setup(f.raw(), host('A', 'https://A.EXAMPLE/', 'lease-99'));
    await renewed.controller.restore(); expect(renewed.onRestore.mock.calls[0][0]).toEqual(route());
    expect(f.raw()).not.toContain('lease'); expect(JSON.parse(f.raw()!).entries).toHaveLength(2);
  });
  it('unconfirmed/mismatched/missing scope is no read/write authority, including explicitly requested restore', async () => {
    for (const authority of [
      { ...host(), confirmed: false }, { ...host(), runtimeScope: null },
      { ...host(), runtimeScope: { hostID: 'B', lease: 'lease' } },
      { ...host(), connection: { id: 'A', url: 'https://a.example' } },
    ]) {
      const f = setup(disk(entry()), authority); await f.controller.restore();
      expect(f.controller.save(route(), authority)).toBe(false);
      expect(f.storage.getItem).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled();
    }
  });
});

describe('action admission, intent priority and stale completions', () => {
  it('user action before a delayed disk read beats restore, including same-route/overlay actions without a saved target', async () => {
    const read = deferred<string | null>(), f = setup(disk(entry()));
    vi.mocked(f.storage.getItem).mockReturnValueOnce(read.promise);
    const restoring = f.controller.restore(); f.controller.userNavigated(); read.resolve(disk(entry())); await restoring;
    expect(f.onRestore).not.toHaveBeenCalled(); expect(f.requestRestore).not.toHaveBeenCalled();
    await f.controller.retryRestore(); expect(f.controller.snapshot().restore).toBe('superseded');
  });
  it('navigation while lookup/dirty admission waits wins and the new public route is saved', async () => {
    const admission = deferred<DesktopNavigationRestoreDecision>(), f = setup(disk(entry()));
    f.requestRestore.mockReturnValueOnce(admission.promise);
    const restoring = f.controller.restore(); await tick();
    const captured = f.requestRestore.mock.calls[0][1]; expect(captured.current()).toBe(true);
    f.controller.userNavigated(); f.controller.save(route('user-choice'), f.authority());
    admission.resolve({ status: 'ready', target: route() }); await restoring; await f.controller.flush();
    expect(captured.current()).toBe(false); expect(f.onRestore).not.toHaveBeenCalled();
    expect(JSON.parse(f.raw()!).entries[0].target).toEqual(route('user-choice'));
  });
  it('a navigation intent before native scope is confirmed also vetoes late startup restore', async () => {
    const f = setup(disk(entry()), { ...host(), runtimeScope: null });
    f.controller.userNavigated(); f.setHost(host()); await tick();
    expect(f.requestRestore).not.toHaveBeenCalled(); expect(f.storage.getItem).not.toHaveBeenCalled();
  });
  it('lease renewal invalidates old admission but reuses the partition with only one physical lookup flight', async () => {
    const admission = deferred<DesktopNavigationRestoreDecision>(), f = setup(disk(entry()));
    f.requestRestore.mockReturnValueOnce(admission.promise);
    f.controller.synchronize(); await tick(); const old = f.requestRestore.mock.calls[0][1];
    f.setHost(host('A', 'https://a.example', 'lease-2'));
    expect(old.current()).toBe(false); expect(f.requestRestore).toHaveBeenCalledOnce();
    admission.resolve({ status: 'ready', target: route() }); await f.controller.restore();
    expect(f.requestRestore).toHaveBeenCalledTimes(2); expect(f.onRestore).toHaveBeenCalledOnce();
    expect(f.onRestore.mock.calls[0][1].runtimeScope.lease).toBe('lease-2');
    expect(f.storage.getItem).toHaveBeenCalledOnce();
  });
  it('a settled route does not get pushed again on foreground lease renewal; captured writes cannot borrow the new lease', async () => {
    const f = setup(disk(entry())); f.controller.synchronize(); await f.controller.restore();
    const captured = f.controller.captureAuthority()!;
    expect(Object.isFrozen(captured.connection)).toBe(true);
    f.setHost({ ...host(), runtimeScope: null }); f.setHost(host('A', 'https://a.example', 'lease-2')); await tick();
    expect(f.controller.snapshot().restore).toBe('restored');
    expect(f.onRestore).toHaveBeenCalledOnce(); expect(f.requestRestore).toHaveBeenCalledOnce();
    expect(f.controller.save(route('stale'), captured)).toBe(false);
    expect(f.controller.save(route('fresh'), f.controller.captureAuthority()!)).toBe(true);
    await f.controller.flush(); expect(f.raw()).toBe(disk(entry(host(), route('fresh'))));
  });
  it('save alone fences a delayed restore, and duplicate retry calls share one admission flight', async () => {
    const admission = deferred<DesktopNavigationRestoreDecision>(), f = setup(disk(entry()));
    f.requestRestore.mockReturnValueOnce(admission.promise);
    const restoring = f.controller.restore(); await tick();
    for (let index = 0; index < 50; index++) void f.controller.retryRestore();
    expect(f.requestRestore).toHaveBeenCalledOnce();
    f.controller.save(route('authorized-current'), f.controller.captureAuthority()!);
    admission.resolve({ status: 'ready', target: route() }); await restoring; await f.controller.flush();
    expect(f.onRestore).not.toHaveBeenCalled(); expect(f.controller.snapshot().restore).toBe('superseded');
  });
  it('bounded scope churn and stale 404/5xx cannot remove or restore the current entry', async () => {
    const admission = deferred<DesktopNavigationRestoreDecision>(), f = setup(disk(entry(), entry(host('B'))));
    f.requestRestore.mockReturnValueOnce(admission.promise);
    f.controller.synchronize(); await tick();
    for (let index = 0; index < 100; index++) f.setHost(host(`host-${index}`));
    f.setHost(host('B')); expect(f.requestRestore).toHaveBeenCalledOnce();
    admission.reject(Object.assign(new Error('gone'), { status: 404 })); await f.controller.restore();
    expect(f.onRestore).toHaveBeenCalledOnce(); expect(f.requestRestore).toHaveBeenCalledTimes(2);
    expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.raw()).toBe(disk(entry(), entry(host('B'))));
  });
  it('onRestore gets corrected authoritative directory, cannot change identity, and a refused apply keeps prior', async () => {
    const f = setup(disk(entry()));
    f.requestRestore.mockResolvedValueOnce({ status: 'ready', target: route('session-1', '/moved') });
    f.onRestore.mockReturnValueOnce(false); await f.controller.restore();
    expect(f.controller.snapshot().restore).toBe('blocked'); expect(f.raw()).toBe(disk(entry()));
    f.requestRestore.mockResolvedValueOnce({ status: 'ready', target: route('wrong-session') });
    await f.controller.retryRestore(); expect(f.controller.snapshot().restore).toBe('error');
    expect(f.onRestore).toHaveBeenCalledOnce();
    f.requestRestore.mockResolvedValueOnce({ status: 'ready', target: route('session-1', '/moved') });
    await f.controller.retryRestore(); await f.controller.flush();
    expect(f.controller.snapshot().restore).toBe('restored'); expect(f.raw()).toBe(disk(entry(host(), route('session-1', '/moved'))));
  });
  it('dispose during lookup prevents apply and cleanup, without trying to select a Host', async () => {
    const admission = deferred<DesktopNavigationRestoreDecision>(), f = setup(disk(entry()));
    f.requestRestore.mockReturnValueOnce(admission.promise); const restoring = f.controller.restore(); await tick();
    await f.controller.dispose(); admission.resolve({ status: 'missing' }); await restoring;
    expect(f.onRestore).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled();
  });
});

describe('failure is not empty; exact-entry cleanup and explicit retry', () => {
  it.each([401, 500, 503])('HTTP %s keeps current route and disk prior; retry repeats only lookup', async status => {
    const f = setup(disk(entry()));
    f.requestRestore.mockRejectedValueOnce(Object.assign(new Error('read failed'), { status }));
    await f.controller.restore(); expect(f.controller.snapshot().restore).toBe('error');
    expect(f.raw()).toBe(disk(entry())); expect(f.onRestore).not.toHaveBeenCalled();
    await f.controller.retryRestore(); expect(f.controller.snapshot().restore).toBe('restored');
    expect(f.onRestore).toHaveBeenCalledOnce(); expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it.each(['missing', '404'] as const)('authoritative %s removes only the current entry, not another Host', async result => {
    const f = setup(disk(entry(), entry(host('B'))));
    if (result === '404') f.requestRestore.mockRejectedValueOnce(Object.assign(new Error('gone'), { status: 404 }));
    else f.requestRestore.mockResolvedValueOnce({ status: 'missing' });
    await f.controller.restore(); await f.controller.flush();
    expect(f.controller.snapshot().restore).toBe('missing'); expect(f.onRestore).not.toHaveBeenCalled();
    expect(f.raw()).toBe(disk(entry(host('B'))));
  });
  it('a failed disk read is retryable, not fresh/empty; malformed and newer-version stores are not overwritten', async () => {
    const f = setup(disk(entry())); vi.mocked(f.storage.getItem).mockRejectedValueOnce(new Error('unavailable'));
    await f.controller.restore(); expect(f.controller.snapshot().restore).toBe('error');
    await f.controller.retryRestore(); expect(f.controller.snapshot().restore).toBe('restored');
    const privateRecord = JSON.stringify({ version: 1, entries: [{ ...entry(), target: { ...route(), owner: {} } }] });
    for (const raw of ['{', '{"version":2,"entries":[]}', disk(entry(), entry()), privateRecord]) {
      const bad = setup(raw); await bad.controller.restore(); expect(bad.controller.snapshot().restore).toBe('error');
      bad.controller.save(route('new'), bad.authority()); expect(await bad.controller.flush()).toBe(false);
      expect(bad.raw()).toBe(raw); expect(bad.storage.setItem).not.toHaveBeenCalled();
    }
  });
  it('cleanup write failure preserves prior and retry does not repeat restore admission/apply', async () => {
    const f = setup(disk(entry(), entry(host('B'))));
    vi.mocked(f.storage.setItem).mockRejectedValueOnce(new Error('full'));
    f.requestRestore.mockResolvedValueOnce({ status: 'missing' }); await f.controller.restore(); await tick();
    expect(f.controller.snapshot().write).toBe('error'); expect(f.raw()).toBe(disk(entry(), entry(host('B'))));
    expect(await f.controller.retryWrite()).toBe(true); expect(f.raw()).toBe(disk(entry(host('B'))));
    expect(f.requestRestore).toHaveBeenCalledOnce(); expect(f.onRestore).not.toHaveBeenCalled();
  });
});

describe('serial exact-partition writes, close and bounds', () => {
  it('an in-flight leaving-directory write keeps its partition, newer writes merge after success in order', async () => {
    const gate = deferred<unknown>(), f = setup();
    const write = vi.mocked(f.storage.setItem), original = write.getMockImplementation()!;
    write.mockImplementationOnce(async (key, value) => { await gate.promise; return original(key, value); });
    f.controller.userNavigated(); f.controller.save(route('old-dir', '/old'), f.authority()); await tick();
    const oldAuthority = f.authority(); f.setHost(host('B'));
    expect(f.controller.save(route('stale'), oldAuthority)).toBe(false);
    f.controller.save(route('B'), f.authority()); f.setHost(host('A', 'https://new-origin.example'));
    f.controller.save(route('new-origin'), f.authority());
    expect(write).toHaveBeenCalledOnce(); gate.resolve(null); expect(await f.controller.flush()).toBe(true);
    expect(JSON.parse(f.raw()!).entries).toEqual([entry(host(), route('old-dir', '/old')), entry(host('B'), route('B')), entry(f.authority(), route('new-origin'))]);
    expect(write).toHaveBeenCalledTimes(2);
  });
  it('failed close flush preserves disk prior, owner and latest pending projection for retry', async () => {
    const f = setup(disk(entry()));
    const original = vi.mocked(f.storage.setItem).getMockImplementation()!;
    vi.mocked(f.storage.setItem).mockRejectedValue(new Error('disk full'));
    f.controller.userNavigated(); f.controller.save(route('latest'), f.authority());
    expect(await f.controller.close()).toBe(false); expect(f.raw()).toBe(disk(entry()));
    expect(f.controller.snapshot().write).toBe('error');
    expect(f.controller.save(route('after-failed-close'), f.authority())).toBe(true);
    vi.mocked(f.storage.setItem).mockImplementation(original);
    expect(await f.controller.close()).toBe(true);
    expect(JSON.parse(f.raw()!).entries[0].target).toEqual(route('after-failed-close'));
    expect(f.controller.save(route('disposed'), f.authority())).toBe(false);
  });
  it('one validation/read for repeated unchanged sync, and writes coalesce to <=32 latest Host projections', async () => {
    const gate = deferred<unknown>(), f = setup();
    f.controller.synchronize(); await f.controller.restore();
    for (let i = 0; i < 50; i++) f.controller.synchronize();
    expect(f.storage.getItem).toHaveBeenCalledOnce(); expect(f.storage.setItem).not.toHaveBeenCalled();
    f.controller.userNavigated();
    const write = vi.mocked(f.storage.setItem), original = write.getMockImplementation()!;
    write.mockImplementationOnce(async (key, value) => { await gate.promise; return original(key, value); });
    f.controller.save(route('first'), f.authority()); await tick();
    for (let i = 0; i < 100; i++) { f.setHost(host(`host-${i}`)); for (let j = 0; j < 50; j++) f.controller.save(route(`s-${j}`), f.authority()); }
    expect(write).toHaveBeenCalledOnce(); gate.resolve(null); await f.controller.flush();
    const rows = JSON.parse(f.raw()!).entries;
    expect(rows).toHaveLength(32); expect(rows[0].partition.connectionID).toBe('host-68');
    expect(rows.at(-1).target.sessionID).toBe('s-49'); expect(write).toHaveBeenCalledTimes(2);
    expect(desktopNavigationBytes(f.raw()!)).toBeLessThanOrEqual(desktopNavigationLimits.bytes);
  });
  it('enforces actual UTF-8 entry/total budgets and LRU without truncating directory or dropping fields', async () => {
    const f = setup(); f.controller.userNavigated();
    expect(() => f.controller.save(route('s', '/' + '界'.repeat(3000)), f.authority())).toThrow('navigation_entry_too_large');
    for (let i = 0; i < 32; i++) { f.setHost(host(`host-${i}`)); f.controller.save(route('s', '/' + '界'.repeat(2000)), f.authority()); await f.controller.flush(); }
    const rows = JSON.parse(f.raw()!).entries;
    expect(rows.length).toBeLessThan(32); expect(rows.at(-1).target.directory).toBe('/' + '界'.repeat(2000));
    expect(desktopNavigationBytes(f.raw()!)).toBeLessThanOrEqual(desktopNavigationLimits.bytes);
    expect(desktopNavigationBytes('😀界')).toBe(7);
  });
});
