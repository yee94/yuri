import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { NotificationCatalogScope } from './state';
import { sameRuntimeScope, type RuntimeScope } from './runtime-scope';

const h = vi.hoisted(() => ({ call: vi.fn(), cleanups: [] as Array<() => void>, stops: [] as Array<() => void>, lifecycle: 'active', listeners: new Map<string, Set<(value: unknown) => void>>() }));
vi.mock('nsh', () => ({
  signal: <T>(value: T) => Object.assign(() => value, { set: (next: T) => { value = next; } }),
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(), lifecycle: () => h.lifecycle,
  effect: (work: () => unknown) => { const dispose = work(); if (typeof dispose === 'function') h.stops.push(dispose as () => void); },
  cleanup: (work: () => void) => h.cleanups.push(work), Storage: { getItem: async () => null, setItem: async () => {} },
  host: { available: () => true, call: h.call, on: (name: string, work: (value: unknown) => void) => { const listeners = h.listeners.get(name) ?? new Set(); listeners.add(work); h.listeners.set(name, listeners); return () => { listeners.delete(work); }; } },
}));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const ticks = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
const paths = { projects: '/api/config/settings', sessions: '/api/yuri/session-index', bots: '/api/yuri/assistants/snapshot', tasks: '/api/yuri/scheduled-tasks' };
let scope: RuntimeScope, hostID: string, authorizationID: string;
let read: (path: string) => unknown;
const snapshot = () => ({ selected: hostID, connections: [{ id: hostID, label: 'Fixture', url: `https://${hostID.toLowerCase()}.example`, authorizationID }], runtimeScope: scope });
const requests = () => h.call.mock.calls.filter(([name, input]) => name === 'runtime.request' && input.path !== '/api/debug/location').map(([, input]) => input);
const hint = (type: string) => { for (const listener of h.listeners.get('runtime.event') ?? []) listener({ key: 'global', data: JSON.stringify({ type, data: {} }) }); };
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); h.lifecycle = 'active'; h.cleanups = []; h.stops = []; h.listeners.clear();
  hostID = 'A'; authorizationID = 'authorization-A'; scope = { hostID, lease: 'lease-A-1' };
  read = path => {
    if (path === paths.projects) return { projects: [] };
    if (path === paths.sessions) return { available: true, directories: [], sync: { active: false, completed: 0, total: 0, pendingDirectories: [], failedDirectories: [] } };
    if (path === paths.bots) return { assistants: [] };
    if (path === paths.tasks) return { tasks: [], failedProjectIds: [] };
    if (path === '/api/debug/location') return [];
    throw new Error(`unknown_runtime_request:${path}`);
  };
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return snapshot();
    if (name === 'runtime.request') {
      if (input.method !== 'GET') throw new Error('unexpected_mutation');
      if (!sameRuntimeScope(input.expectedHost, scope)) throw new Error('stale_runtime_scope');
      return { status: 200, body: await read(input.path) };
    }
    throw new Error(`unknown_native_call:${name}`);
  });
});
afterEach(() => { h.stops.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); vi.useRealTimers(); });
async function open() { const state = await import('./state'); await state.loadConnections(); return state; }
const identity = (state: Awaited<ReturnType<typeof open>>): NotificationCatalogScope => ({ hostID: state.app.connection()!.id, generation: state.epoch() });

it('awaits one existing full root refresh; successful empty arrays are complete, with no second transport or mutation', async () => {
  const state = await open(), normal = read, gate = deferred<unknown>();
  read = path => path === paths.bots ? gate.promise : normal(path);
  const refresh = state.refresh(); const a = state.awaitNotificationCatalogReady(identity(state), () => true), b = state.awaitNotificationCatalogReady(identity(state), () => true);
  let ready = false; void a.then(() => { ready = true; }); await ticks();
  expect(ready).toBe(false); expect(state.app.notificationCatalog().complete).toBe(false); expect(requests()).toHaveLength(4);
  gate.resolve({ assistants: [] }); await Promise.all([refresh, a, b]);
  expect(state.app.notificationCatalog()).toMatchObject({ complete: true, domains: { projects: 'complete', sessions: 'complete', bots: 'complete', tasks: 'complete' }, scope: { hostID: 'A', authorizationID, runtimeScope: scope }, error: null });
  const receipt = state.app.notificationCatalog(); await state.awaitNotificationCatalogReady(identity(state), () => true);
  expect(requests()).toHaveLength(4); expect(state.app.notificationCatalog()).toBe(receipt); expect(state.app.bots()).toEqual([]); expect(state.app.tasks()).toEqual([]);
});

it('cold ensure and explicit retry reuse root refresh, one attempt per call with no timer or hidden retry loop', async () => {
  const state = await open(), normal = read; let fail = true;
  read = path => { if (path === paths.bots && fail) throw new Error('fixture bots unavailable'); return normal(path); };
  await expect(state.awaitNotificationCatalogReady(identity(state), () => true)).rejects.toThrow('notification_catalog_incomplete');
  expect(requests()).toHaveLength(4); expect(state.app.notificationCatalog()).toMatchObject({ complete: false, domains: { bots: 'failed' }, error: 'fixture bots unavailable' });
  await vi.advanceTimersByTimeAsync(5000); expect(requests()).toHaveLength(4);
  fail = false; await state.awaitNotificationCatalogReady(identity(state), () => true); expect(requests()).toHaveLength(8); expect(state.app.notificationCatalog().complete).toBe(true);
});

it.each(['projects', 'sessions', 'bots', 'tasks'] as const)('%s failure retains that prior domain and cannot be mistaken for online, non-empty or loading=false completeness', async domain => {
  const state = await open(); await state.refresh();
  state.app.projects.set([{ id: 'prior', name: 'Prior', path: '/prior' }]); state.app.sessions.set([{ id: 'prior', title: 'Prior', directory: '/prior', updated: 0 }]);
  state.app.bots.set([{ id: 'prior' }]); state.app.tasks.set([{ projectId: 'prior', task: { id: 'prior' } }]);
  const before = { projects: state.app.projects(), sessions: state.app.sessions(), bots: state.app.bots(), tasks: state.app.tasks() }, normal = read;
  read = path => { if (path === paths[domain]) throw new Error(`fixture ${domain} unavailable`); return normal(path); };
  await expect(state.refresh()).rejects.toThrow(`fixture ${domain} unavailable`);
  const current = { projects: state.app.projects(), sessions: state.app.sessions(), bots: state.app.bots(), tasks: state.app.tasks() };
  expect(current[domain]).toBe(before[domain]); expect(state.app.loading()).toBe(false); state.app.online.set(true);
  await expect(state.awaitNotificationCatalogReady(identity(state), () => true)).rejects.toThrow('notification_catalog_incomplete');
  expect(state.app.notificationCatalog().complete).toBe(false); expect(state.app.notificationCatalog().domains[domain]).toBe('failed');
});

it('partial schedules preserve failed-project prior rows but never publish complete, even when another project succeeds', async () => {
  const state = await open(); state.app.tasks.set([{ projectId: 'failed', task: { id: 'prior' } }]); const normal = read;
  read = path => path === paths.tasks ? { tasks: [{ projectId: 'good', task: { id: 'new' } }], failedProjectIds: ['failed'] } : normal(path);
  await expect(state.awaitNotificationCatalogReady(identity(state), () => true)).rejects.toThrow('notification_catalog_incomplete');
  expect(state.app.tasks()).toEqual([{ projectId: 'good', task: { id: 'new' } }, { projectId: 'failed', task: { id: 'prior' } }]); expect(state.app.notificationCatalog().domains.tasks).toBe('failed');
});

it.each([
  ['projects', { projects: [], complete: false }], ['projects', {}],
  ['sessions', { available: true, directories: [], sync: { active: true } }],
  ['sessions', { available: true, directories: [], sync: { failedDirectories: ['/failed'] } }],
  ['sessions', { available: true, directories: [], sync: { pendingDirectories: ['/pending'] } }],
  ['sessions', { available: true, directories: [{ directory: '/bad' }] }],
  ['bots', { assistants: [], partial: true }], ['bots', { assistants: [{}] }],
  ['tasks', { tasks: [], complete: false }], ['tasks', { tasks: [{}] }],
] as const)('rejects partial/malformed %s authority without a complete receipt', async (domain, body) => {
  const state = await open(), normal = read; read = path => path === paths[domain] ? body : normal(path);
  await expect(state.awaitNotificationCatalogReady(identity(state), () => true)).rejects.toThrow('notification_catalog_incomplete');
  expect(state.app.notificationCatalog()).toMatchObject({ complete: false, domains: { [domain]: 'failed' } });
});

it('dirty tips invalidate readiness immediately and a tip during a flight fences that domain until its next existing refresh', async () => {
  const state = await open(); await state.refresh(); state.observeRuntime(() => {}); await ticks();
  const normal = read, gate = deferred<unknown>(); read = path => path === paths.bots ? gate.promise : normal(path);
  hint('yuri:assistants-changed'); expect(state.app.notificationCatalog().complete).toBe(false);
  const first = state.refresh(); const ready = state.awaitNotificationCatalogReady(identity(state), () => true); hint('yuri:assistants-changed');
  gate.resolve({ assistants: [] }); await first; await expect(ready).rejects.toThrow('notification_catalog_incomplete'); await ticks();
  // refresh.finally already drains the existing dirty-domain queue, not a new notification-owned reader.
  await state.awaitNotificationCatalogReady(identity(state), () => true); expect(state.app.notificationCatalog().complete).toBe(true);
  expect(requests().filter(input => input.path === paths.bots)).toHaveLength(3);
});

it.each(['host', 'authorization', 'lease', 'page'] as const)('an awaited catalog cannot become current after %s changes', async boundary => {
  const state = await open(), normal = read, gate = deferred<unknown>(); let current = true;
  read = path => path === paths.bots ? gate.promise : normal(path);
  const old = state.awaitNotificationCatalogReady(identity(state), () => current); await ticks();
  if (boundary === 'host') { hostID = 'B'; authorizationID = 'authorization-B'; scope = { hostID, lease: 'lease-B' }; await state.loadConnections(); }
  else if (boundary === 'authorization') { authorizationID = 'authorization-A-new'; await state.loadConnections(); }
  else if (boundary === 'lease') { scope = { hostID, lease: 'lease-A-new' }; await state.loadConnections(); }
  else current = false;
  gate.resolve({ assistants: [] }); await expect(old).rejects.toThrow('notification_catalog_stale');
  if (boundary !== 'page') expect(state.app.notificationCatalog().complete).toBe(false);
});

it('an old refresh generation cannot replace a newer successful receipt after lease reconstruction', async () => {
  const state = await open(), normal = read, gate = deferred<unknown>();
  read = path => path === paths.tasks ? gate.promise : normal(path);
  const old = state.refresh(); await ticks(); scope = { hostID, lease: 'lease-A-new' }; await state.loadConnections(); read = normal;
  await state.awaitNotificationCatalogReady(identity(state), () => true); const receipt = state.app.notificationCatalog();
  gate.resolve({ tasks: [{ projectId: 'stale', task: { id: 'stale' } }], failedProjectIds: [] }); await old;
  expect(state.app.notificationCatalog()).toBe(receipt); expect(state.app.tasks()).toEqual([]);
});

it('same-lease metadata rename preserves the receipt; real authorization changes invalidate it without inventing an id', async () => {
  const state = await open(); await state.refresh(); const receipt = state.app.notificationCatalog();
  await state.loadConnections(); expect(state.app.notificationCatalog()).toBe(receipt);
  authorizationID = 'new-authorization'; await state.loadConnections(); expect(state.app.notificationCatalog().complete).toBe(false);
  expect(state.app.connection()?.authorizationID).toBe('new-authorization');
});

it('a different page writer cannot lend the old complete receipt to its replacement or partial arrays', async () => {
  const state = await open(); await state.refresh(); const before = requests().length;
  state.app.bots.set([{ id: 'page-only-partial' }]);
  expect(state.app.notificationCatalog()).toMatchObject({ complete: false, domains: { bots: 'unknown' } });
  await state.awaitNotificationCatalogReady(identity(state), () => true);
  expect(requests()).toHaveLength(before + 4); expect(state.app.bots()).toEqual([]); expect(state.app.notificationCatalog().complete).toBe(true);
});

it('missing authorization or a stale caller cannot start catalog requests or obtain notification readiness', async () => {
  const state = await open(); h.call.mockClear();
  await expect(state.awaitNotificationCatalogReady(null, () => true)).rejects.toThrow('notification_catalog_stale');
  await expect(state.awaitNotificationCatalogReady(identity(state), () => false)).rejects.toThrow('notification_catalog_stale'); expect(requests()).toEqual([]);
  authorizationID = 'legacy'; await state.loadConnections(); h.call.mockClear();
  await expect(state.awaitNotificationCatalogReady(identity(state), () => true)).rejects.toThrow('notification_catalog_unsupported'); expect(requests()).toEqual([]);
});
