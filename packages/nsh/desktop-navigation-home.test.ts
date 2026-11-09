import { describe, expect, it, vi } from 'vitest';
import { createDesktopNavigationPersistence, desktopNavigationPartition, desktopNavigationTargetFrom, type DesktopNavigationAuthority, type DesktopNavigationTarget } from './desktop-navigation-state-core';
import { createDesktopNavigationRestoreAdmission, projectDesktopNavigation, type ResolvedNavigation } from './desktop-navigation-application-core';

const host = (id = 'A', origin = `https://${id.toLowerCase()}.example`, authorizationID = 'auth-A', lease = 'lease-1'): DesktopNavigationAuthority => ({ connection: { id, url: origin, authorizationID }, runtimeScope: { hostID: id, lease }, confirmed: true });
const home = (section: 'assistants' | 'schedules'): DesktopNavigationTarget => ({ kind: 'home', section });
const assistantSnapshot = { enabled: true, revision: 1, assistants: [] };
const tasksSnapshot = { tasks: [], failedProjectIds: [] };
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (failure: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function setup(target: DesktopNavigationTarget = home('assistants'), raw?: string) {
  let authority = host(), value = raw ?? JSON.stringify({ version: 1, entries: [{ partition: desktopNavigationPartition(authority), target }] });
  const initial = value, storage = { getItem: vi.fn(async () => value), setItem: vi.fn(async (_key: string, next: string) => { value = next; }) };
  const read = vi.fn(async (path: string): Promise<unknown> => {
    if (path === '/api/yuri/assistants/snapshot') return assistantSnapshot;
    if (path === '/api/yuri/scheduled-tasks') return tasksSnapshot;
    if (path.startsWith('/api/session/')) return { id: 'saved', title: 'Saved', location: { directory: '/actual' }, time: { archived: 0 } };
    if (path === '/api/config/settings') return { projects: [{ id: 'actual', path: '/actual' }] };
    if (path.startsWith('/api/fs/list')) return { path: '/actual', entries: [] };
    throw new Error('Unexpected navigation read');
  });
  const applied = vi.fn((_resource: ResolvedNavigation) => true);
  const admission = createDesktopNavigationRestoreAdmission({ captureOperation: () => {
    const captured = authority, signature = JSON.stringify(captured);
    return { scope: captured.runtimeScope, current: () => signature === JSON.stringify(authority) && authority.confirmed, request: read };
  }, rawApply: applied });
  const controller = createDesktopNavigationPersistence({ storage, authority: () => authority, requestRestore: admission.requestRestore, onRestore: admission.onRestore });
  return { controller, admission, storage, read, applied, initial, raw: () => value,
    setHost: (next: DesktopNavigationAuthority) => { authority = next; controller.synchronize(); } };
}

describe('explicit desktop home section navigation', () => {
  it.each(['assistants', 'schedules'] as const)('restores and round trips %s through its real complete empty GET snapshot without inferring a missing entry', async section => {
    const target = home(section), f = setup(target); await f.controller.restore();
    expect(f.controller.snapshot().restore).toBe('restored'); expect(f.applied.mock.calls[0]?.[0]).toEqual(target);
    expect(f.read).toHaveBeenCalledExactlyOnceWith(section === 'assistants' ? '/api/yuri/assistants/snapshot' : '/api/yuri/scheduled-tasks');
    expect(f.raw()).toBe(f.initial); expect(f.storage.setItem).not.toHaveBeenCalled();
    expect(f.controller.save(target, f.controller.captureAuthority()!)).toBe(true); expect(await f.controller.flush()).toBe(true);
    expect(JSON.parse(f.raw()).version).toBe(1); expect(JSON.parse(f.raw()).entries[0].target).toEqual(target);
    expect(projectDesktopNavigation({ kind: 'home', section } as Parameters<typeof projectDesktopNavigation>[0])).toEqual(target);
  });
  it('keeps all existing version 1 target shapes readable and rewrites only the explicitly chosen partition', async () => {
    const targets: DesktopNavigationTarget[] = [{ kind: 'session', sessionID: 'saved', directory: '/actual' }, { kind: 'assistant', assistantID: 'bot', directory: '/actual' }, { kind: 'project', projectID: 'actual', directory: '/actual' }, { kind: 'new-session', directory: '/actual', projectID: 'actual' }];
    const entries = targets.map((target, index) => ({ partition: desktopNavigationPartition(host(String(index))), target }));
    const f = setup(home('assistants'), JSON.stringify({ version: 1, entries }));
    expect(f.controller.save(home('schedules'), host())).toBe(true); await f.controller.flush();
    expect(JSON.parse(f.raw()).entries.slice(0, 4)).toEqual(entries); expect(JSON.parse(f.raw()).entries[4].target).toEqual(home('schedules'));
  });
  it.each([{ kind: 'home' }, { kind: 'home', section: 'projects' }, { kind: 'home', section: 1 }, { kind: 'home', section: 'assistants', directory: '' }, { kind: 'home', section: 'schedules', taskID: 'guessed' }, { kind: 'home', section: 'assistants', settings: {} }])('rejects malformed/private home targets and preserves the original envelope: %#', async target => {
    expect(() => desktopNavigationTargetFrom(target)).toThrow();
    const raw = JSON.stringify({ version: 1, entries: [{ partition: desktopNavigationPartition(host()), target }] }), f = setup(home('assistants'), raw);
    await f.controller.restore(); expect(f.controller.snapshot().restore).toBe('error'); expect(f.read).not.toHaveBeenCalled();
    f.controller.save(home('schedules'), f.controller.captureAuthority()!); expect(await f.controller.flush()).toBe(false); expect(f.raw()).toBe(raw);
  });
  it('a disabled but valid assistants snapshot still admits the main section, without reopening any bot', async () => {
    const f = setup(); f.read.mockResolvedValueOnce({ ...assistantSnapshot, enabled: false }); await f.controller.restore();
    expect(f.applied).toHaveBeenCalledOnce(); expect(f.applied.mock.calls[0]?.[0]).toEqual(home('assistants')); expect(f.raw()).toBe(f.initial);
  });
  it.each(['assistants', 'schedules'] as const)('404/401/503 and partial/incomplete %s snapshots preserve prior metadata for explicit read retry', async section => {
    for (const failure of [404, 401, 503, 'partial', 'incomplete'] as const) {
      const f = setup(home(section));
      if (typeof failure === 'number') f.read.mockRejectedValueOnce(Object.assign(new Error('snapshot unavailable'), { status: failure }));
      else f.read.mockResolvedValueOnce({ ...(section === 'assistants' ? assistantSnapshot : tasksSnapshot), ...(failure === 'partial' ? { partial: true } : { complete: false }) });
      await f.controller.restore(); await f.controller.flush();
      expect(f.controller.snapshot().restore).toBe('error'); expect(f.applied).not.toHaveBeenCalled(); expect(f.storage.setItem).not.toHaveBeenCalled(); expect(f.raw()).toBe(f.initial);
      await f.controller.retryRestore(); expect(f.controller.snapshot().restore).toBe('restored'); expect(f.applied).toHaveBeenCalledOnce();
    }
  });
  it.each([{ tasks: null }, { tasks: [{ projectId: 'p', task: {} }] }, { tasks: [], failedProjectIds: ['p'] }, { tasks: [], failedProjectIds: null }, { tasks: [], failedProjectIds: [1] }, { tasks: [{ projectId: 'p', task: { id: 't' } }, { projectId: 'p', task: { id: 't' } }] }])('malformed/partial scheduled catalog never becomes an empty successful home admission: %#', async response => {
    const f = setup(home('schedules')); f.read.mockResolvedValueOnce(response); await f.controller.restore();
    expect(f.controller.snapshot().restore).toBe('error'); expect(f.applied).not.toHaveBeenCalled(); expect(f.raw()).toBe(f.initial);
  });
  it('sameResource rejects changing assistants into schedules during admission', async () => {
    const f = setup(), applied = vi.fn(() => true); const controller = createDesktopNavigationPersistence({ storage: f.storage, authority: () => host(), requestRestore: async () => ({ status: 'ready', target: home('schedules') }), onRestore: applied });
    await controller.restore(); expect(controller.snapshot().restore).toBe('error'); expect(applied).not.toHaveBeenCalled(); expect(f.raw()).toBe(f.initial);
  });
  it('an invalid custom missing admission cannot delete a built-in main section', async () => {
    const f = setup(), applied = vi.fn(() => true); const controller = createDesktopNavigationPersistence({ storage: f.storage, authority: () => host(), requestRestore: async () => ({ status: 'missing' }), onRestore: applied });
    await controller.restore(); await controller.flush(); expect(controller.snapshot().restore).toBe('error'); expect(f.raw()).toBe(f.initial); expect(f.storage.setItem).not.toHaveBeenCalled(); expect(applied).not.toHaveBeenCalled();
  });
  it('a user section choice wins before a delayed startup catalog completes, including later retry', async () => {
    const f = setup(), gate = deferred<unknown>(); f.read.mockReturnValueOnce(gate.promise);
    const restoring = f.controller.restore(); await tick(); f.controller.userNavigated(); f.controller.save(home('schedules'), f.controller.captureAuthority()!);
    gate.resolve(assistantSnapshot); await restoring; await f.controller.flush(); await f.controller.retryRestore();
    expect(f.applied).not.toHaveBeenCalled(); expect(f.controller.snapshot().restore).toBe('superseded'); expect(JSON.parse(f.raw()).entries[0].target).toEqual(home('schedules')); expect(f.read).toHaveBeenCalledOnce();
  });
  it('a late old-Host 404 cannot remove either home entry or apply across a new live authority', async () => {
    const entries = [{ partition: desktopNavigationPartition(host()), target: home('assistants') }, { partition: desktopNavigationPartition(host('B')), target: home('schedules') }];
    const f = setup(home('assistants'), JSON.stringify({ version: 1, entries })), gate = deferred<unknown>(); f.read.mockReturnValueOnce(gate.promise);
    f.controller.synchronize(); await tick(); f.setHost(host('B')); gate.reject(Object.assign(new Error('stale endpoint'), { status: 404 })); await f.controller.restore();
    expect(f.applied).toHaveBeenCalledOnce(); expect(f.applied.mock.calls[0]?.[0]).toEqual(home('schedules')); expect(JSON.parse(f.raw()).entries).toEqual(entries); expect(f.storage.setItem).not.toHaveBeenCalled();
  });
  it('new origin/authorization cannot adopt a home entry; settled same-identity lease renewal does not re-read/reapply', async () => {
    for (const authority of [host('A', 'https://other.example'), host('A', 'https://a.example', 'other-auth')]) {
      const f = setup(); f.setHost(authority); await f.controller.restore(); expect(f.controller.snapshot().restore).toBe('empty'); expect(f.read).not.toHaveBeenCalled(); expect(f.raw()).toBe(f.initial);
    }
    const f = setup(); f.controller.synchronize(); await f.controller.restore(); f.setHost(host('A', 'https://a.example', 'auth-A', 'lease-2')); await tick();
    expect(f.read).toHaveBeenCalledOnce(); expect(f.applied).toHaveBeenCalledOnce(); expect(f.raw()).not.toContain('lease');
  });
  it('failed home write/close preserves prior and retries the public metadata without repeating admission', async () => {
    const f = setup(); await f.controller.restore(); f.storage.setItem.mockRejectedValueOnce(new Error('storage unavailable'));
    f.controller.save(home('schedules'), f.controller.captureAuthority()!); expect(await f.controller.close()).toBe(false); expect(f.raw()).toBe(f.initial);
    expect(await f.controller.retryWrite()).toBe(true); expect(JSON.parse(f.raw()).entries[0].target).toEqual(home('schedules')); expect(f.read).toHaveBeenCalledOnce(); expect(f.applied).toHaveBeenCalledOnce();
  });
});
