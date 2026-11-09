import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DesktopNavigationTarget } from './desktop-navigation-state-core';
import type { ResolvedNavigation } from './desktop-navigation-application-core';

const native = vi.hoisted(() => ({
  effects: [] as Array<() => void>, cleanups: [] as Array<() => void>, lifecycle: 'active',
  storage: new Map<string, string>(), getItem: vi.fn(), setItem: vi.fn(), call: vi.fn(),
}));
// Only the NSH platform leaf is synthetic. state.captureHostOperation, runtime.bindRequest,
// error decoding, the production application adapter and Storage core all execute unchanged.
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  Storage: { getItem: native.getItem, setItem: native.setItem },
  lifecycle: () => native.lifecycle,
  effect: (work: () => void) => { native.effects.push(work); work(); }, cleanup: (work: () => void) => native.cleanups.push(work),
  host: { available: () => true, call: native.call, on: () => () => {} },
}));
const tick = async () => { for (let index = 0; index < 80; index++) await Promise.resolve(); };
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const target: DesktopNavigationTarget = { kind: 'session', sessionID: 'saved', directory: '/project' };
const key = 'desktop.navigation.v1';
let connection: { id: string; url: string; authorizationID: string; label: string; lastUsedAt: number }, lease: string;
let wire: (path: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
function serialized(projection = target, origin = 'https://a.example') {
  return JSON.stringify({ version: 1, entries: [{ partition: { connectionID: 'A', origin, authorizationID: 'auth-A' }, target: projection }] });
}
const requests = () => native.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, payload]) => payload as { path: string; method: string; expectedHost: { hostID: string; lease: string }; body?: unknown });
beforeEach(() => {
  vi.resetModules(); native.effects = []; native.cleanups = []; native.lifecycle = 'active'; native.storage.clear();
  connection = { id: 'A', url: 'https://a.example', authorizationID: 'auth-A', label: 'Synthetic Host', lastUsedAt: 1 }; lease = 'native-lease-1';
  wire = path => {
    if (path === '/api/session/saved?directory=%2Fproject') return { status: 200, body: { id: 'saved', title: 'Fresh Host title', location: { directory: '/project' }, time: { archived: 0 }, privateMetadata: 'not projected' } };
    if (path === '/api/config/settings') return { status: 200, body: { projects: [{ id: 'decoy', path: '/wrong' }, { id: 'p', path: '/project', name: 'Fresh project' }] } };
    if (path === '/api/fs/list?path=%2Fproject') return { status: 200, body: { path: '/project', entries: [] } };
    if (path === '/api/yuri/assistants/snapshot') return { status: 200, body: { revision: 1, enabled: true, assistants: [{ id: 'bot', revision: 1, enabled: true, name: 'Fresh bot', effectiveWorkspacePath: '/project' }] } };
    throw new Error('Unexpected synthetic GET ' + path);
  };
  native.getItem.mockReset().mockImplementation(async (name: string) => native.storage.get(name) ?? null);
  native.setItem.mockReset().mockImplementation(async (name: string, value: string) => { native.storage.set(name, value); });
  native.call.mockReset().mockImplementation(async (name: string, payload: Record<string, unknown>) => {
    if (name === 'connection.list') return { connections: [{ ...connection }], selected: connection.id, runtimeScope: { hostID: connection.id, lease } };
    if (name !== 'runtime.request') throw new Error('Unexpected synthetic native call ' + name);
    expect(payload.method).toBe('GET'); expect(payload.body).toBeUndefined();
    expect(payload.expectedHost).toEqual({ hostID: connection.id, lease });
    return wire(String(payload.path));
  });
});
afterEach(async () => { native.cleanups.reverse().forEach(stop => stop()); await tick(); });
async function attach(projection: DesktopNavigationTarget = target) {
  native.storage.set(key, serialized(projection));
  const state = await import('./state'); await state.loadConnections();
  // Stale local catalog must never authorize restore or provide its title/directory.
  state.app.sessions.set([{ id: 'saved', title: 'Stale local title', directory: '/wrong', updated: 1 }]);
  const application = await import('./desktop-navigation-application');
  const rawApply = vi.fn((_resource: ResolvedNavigation) => true);
  const navigation = application.attachDesktopNavigationApplication({ rawApply });
  return { state, application, rawApply, navigation };
}

describe('production captureHostOperation → native runtime.request → resolved CAS', () => {
  it('uses real binder and fresh session metadata; exact captured native lease, no create/send or cached catalog authority', async () => {
    const f = await attach(); await f.navigation.restore();
    expect(f.navigation.state().restore).toBe('restored'); expect(f.navigation.pendingResolvedCount()).toBe(0);
    expect(f.rawApply.mock.calls[0][0]).toEqual({ kind: 'session', target: { kind: 'session', id: 'saved', title: 'Fresh Host title', directory: '/project' } });
    expect(requests()).toEqual([{ path: '/api/session/saved?directory=%2Fproject', method: 'GET', expectedHost: { hostID: 'A', lease: 'native-lease-1' } }]);
    expect(native.storage.get(key)).toBe(serialized());
  });
  it.each([401, 500, 503])('production HTTP %s decoder keeps route/disk prior and exposes a retryable restore error', async status => {
    const original = wire; wire = () => ({ status, body: { error: 'synthetic failure' } });
    const f = await attach(); await f.navigation.restore();
    expect(f.navigation.state().restore).toBe('error'); expect(f.navigation.pendingResolvedCount()).toBe(0);
    expect(f.rawApply).not.toHaveBeenCalled(); expect(native.storage.get(key)).toBe(serialized());
    wire = original; await f.navigation.retryRestore();
    expect(f.navigation.state().restore).toBe('restored'); expect(f.rawApply).toHaveBeenCalledOnce();
  });
  it('404 removes only the affected navigation metadata, with no apply', async () => {
    wire = () => ({ status: 404, body: { error: 'session missing' } });
    const f = await attach(); await f.navigation.restore(); await f.navigation.flush();
    expect(f.navigation.state().restore).toBe('missing'); expect(f.rawApply).not.toHaveBeenCalled();
    expect(JSON.parse(native.storage.get(key)!).entries).toEqual([]);
  });
  it('retryRestore after a failed read and subsequent user edit is a permanent no-op, not a renewed startup admission', async () => {
    const original = wire; wire = () => ({ status: 401, body: { error: 'private transport body' } });
    const f = await attach(); await f.navigation.restore();
    expect(f.navigation.state().restore).toBe('error'); expect(native.storage.get(key)).toBe(serialized());
    f.navigation.userNavigated(); wire = original;
    const count = requests().length;
    await f.navigation.retryRestore(); await f.navigation.retryRestore();
    expect(f.navigation.state().restore).toBe('superseded'); expect(requests()).toHaveLength(count);
    expect(f.rawApply).not.toHaveBeenCalled(); expect(native.storage.get(key)).toBe(serialized());
  });
  it('wrong-directory production success is a failure, not absence or permission to open another workspace', async () => {
    wire = () => ({ status: 200, body: { id: 'saved', location: { directory: '/wrong' }, time: {} } });
    const f = await attach(); await f.navigation.restore();
    expect(f.navigation.state().restore).toBe('error'); expect(f.rawApply).not.toHaveBeenCalled();
    expect(native.storage.get(key)).toBe(serialized());
  });
  it.each([
    { kind: 'project', projectID: 'p', directory: '/project' },
    { kind: 'new-session', projectID: 'p', directory: '/project' },
    { kind: 'assistant', assistantID: 'bot', directory: '/project' },
  ] satisfies DesktopNavigationTarget[])('production $kind resolves actual Host resource without mutation', async projection => {
    const f = await attach(projection); await f.navigation.restore();
    expect(f.navigation.state().restore).toBe('restored'); expect(f.rawApply.mock.calls[0][0].kind).toBe(projection.kind);
    expect(requests().every(request => request.method === 'GET' && request.expectedHost.lease === lease)).toBe(true);
    if (projection.kind === 'project' || projection.kind === 'new-session') expect(requests().map(request => request.path)).toEqual(['/api/config/settings', '/api/fs/list?path=%2Fproject']);
  });
  it.each([200, 404, 503])('user-before-await retires pending HTTP %s and saves new navigation on the captured exact Host', async status => {
    const wait = deferred<{ status: number; body: unknown }>(); wire = () => wait.promise;
    const f = await attach(); await tick(); const captured = f.navigation.captureAuthority()!;
    expect(requests()).toHaveLength(1); f.navigation.userNavigated();
    expect(f.navigation.saveRoute({ kind: 'new-session', directory: '/chosen' }, captured)).toBe(true);
    wait.resolve({ status, body: status === 200 ? { id: 'saved', location: { directory: '/project' }, time: {} } : { error: 'late failure' } });
    await f.navigation.restore(); await f.navigation.flush();
    expect(f.navigation.state().restore).toBe('superseded'); expect(f.rawApply).not.toHaveBeenCalled();
    expect(f.navigation.pendingResolvedCount()).toBe(0);
    expect(JSON.parse(native.storage.get(key)!).entries[0].target).toEqual({ kind: 'new-session', directory: '/chosen' });
  });
  it('same ID/new origin and a new native lease cannot take a pending old-origin resource or save via an old capture', async () => {
    const wait = deferred<{ status: number; body: unknown }>(); wire = () => wait.promise;
    const f = await attach(); await tick(); const captured = f.navigation.captureAuthority()!;
    connection = { ...connection, url: 'https://new.example' }; lease = 'native-lease-2'; await f.state.loadConnections();
    native.effects.forEach(run => run());
    wait.resolve({ status: 200, body: { id: 'saved', directory: '/project', time: {} } });
    await f.navigation.restore();
    expect(f.navigation.state().restore).toBe('empty'); expect(f.rawApply).not.toHaveBeenCalled();
    expect(f.navigation.pendingResolvedCount()).toBe(0);
    expect(f.navigation.saveRoute({ kind: 'root' }, captured, '/chosen')).toBe(false);
    expect(native.storage.get(key)).toBe(serialized());
  });
  it('suspended/unconfirmed native authority cannot start a resolver, and unrelated updates do no scans/reads', async () => {
    const f = await attach(); await f.navigation.restore(); const reads = requests().length;
    for (let i = 0; i < 50; i++) { f.state.app.sessions.set([]); native.effects.forEach(run => run()); }
    expect(requests()).toHaveLength(reads); expect(f.rawApply).toHaveBeenCalledOnce();
    native.lifecycle = 'background'; native.effects.forEach(run => run());
    expect(f.navigation.captureAuthority()).toBeNull(); expect(f.navigation.pendingResolvedCount()).toBe(0);
  });
  it('failed flush preserves prior and allows metadata retry without repeating lookup or disposing the route/draft', async () => {
    const f = await attach(); await f.navigation.restore(); const original = native.setItem.getMockImplementation()!;
    native.setItem.mockRejectedValue(new Error('storage full'));
    f.navigation.userNavigated(); f.navigation.saveRoute({ kind: 'root' }, f.navigation.captureAuthority()!, '/chosen');
    expect(await f.navigation.flush()).toBe(false); expect(native.storage.get(key)).toBe(serialized());
    expect(f.navigation.state().write).toBe('error'); expect(f.navigation.pendingResolvedCount()).toBe(0);
    native.setItem.mockImplementation(original); expect(await f.navigation.flush()).toBe(true);
    expect(JSON.parse(native.storage.get(key)!).entries[0].target).toEqual({ kind: 'new-session', directory: '/chosen' });
    expect(requests()).toHaveLength(1); expect(f.rawApply).toHaveBeenCalledOnce();
  });
});
