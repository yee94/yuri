import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('nsh', () => ({ signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); } }));
vi.mock('./runtime', () => ({ request: vi.fn(), query: (directory: string) => `directory=${encodeURIComponent(directory)}` }));
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => vi.resetModules());
describe('new-session local picker catalog', () => {
  it('closed/controller construction does no requests; model picker uses only catalog/settings GETs', async () => {
    const { createNewSessionCatalog } = await import('./new-session-selection');
    const send = vi.fn(async (path: string) => path.includes('/providers?') ? { schemaVersion: 1, providers: [{ id: 'p', models: {} }] } : { recentModels: [] });
    const catalog = createNewSessionCatalog('/work tree', () => true, send); expect(send).not.toHaveBeenCalled();
    await catalog.load('model'); expect(catalog.resolved()).toBe(true); expect(send.mock.calls.map(([path]) => path)).toEqual(['/api/config/catalog/providers?directory=%2Fwork%20tree', '/api/config/settings']);
    expect(send.mock.calls.every(call => call.length === 1)).toBe(true);
  });
  it('Agent catalog keeps primary/all visible Agents only and never reads a session', async () => {
    const { createNewSessionCatalog } = await import('./new-session-selection');
    const send = vi.fn(async () => ({ data: [{ name: 'build', mode: 'primary' }, { name: 'all', mode: 'all' }, { name: 'child', mode: 'subagent' }, { name: 'hidden', mode: 'primary', hidden: true }] }));
    const catalog = createNewSessionCatalog('/repo', () => true, send); await catalog.load('agent'); expect(catalog.agents().map(agent => agent.name)).toEqual(['build', 'all']); expect(send).toHaveBeenCalledTimes(1);
  });
  it('failed refresh keeps the last authoritative catalog and surfaces the error', async () => {
    const { createNewSessionCatalog } = await import('./new-session-selection'); let fail = false;
    const send = vi.fn(async (path: string) => { if (fail) throw new Error('offline'); return path.includes('/providers?') ? { schemaVersion: 1, partial: true, providers: [{ id: 'p' }] } : {}; });
    const catalog = createNewSessionCatalog('/repo', () => true, send); await catalog.load('model'); const previous = catalog.providers(); fail = true; await catalog.load('model');
    expect(catalog.providers()).toBe(previous); expect(catalog.partial()).toBe(true); expect(catalog.error()).toBe('offline');
  });
  it('inactive, disposed and superseded loads cannot publish stale data', async () => {
    const { createNewSessionCatalog } = await import('./new-session-selection'); let current = true; const gate = deferred<unknown>();
    const send = vi.fn(async () => gate.promise); const catalog = createNewSessionCatalog('/repo', () => current, send); const loading = catalog.load('agent'); current = false; gate.resolve({ data: [{ name: 'old', mode: 'primary' }] }); await loading;
    expect(catalog.agents()).toEqual([]); current = true; catalog.dispose(); await catalog.load('agent'); expect(send).toHaveBeenCalledTimes(1);
  });
  it('warm reopen paints the cached catalog immediately and forces one shared background refresh', async () => {
    const { createNewSessionCatalog } = await import('./new-session-selection');
    const providers = Array.from({ length: 300 }, (_, i) => ({ id: `p-${i}`, models: { m: { id: 'm' } } }));
    const send = vi.fn(async (path: string) => path.includes('/providers?') ? { schemaVersion: 1, providers } : { favoriteModels: [], secret: 'never-retained' });
    const first = createNewSessionCatalog('/repo', () => true, send, 'host:lease'); await first.load('model'); first.dispose();
    const gate = deferred<unknown>(); send.mockImplementation(async () => gate.promise);
    const a = createNewSessionCatalog('/repo', () => true, send, 'host:lease'), b = createNewSessionCatalog('/repo', () => true, send, 'host:lease');
    expect(a.providers()).toHaveLength(300); expect(a.preferences().secret).toBeUndefined();
    const refreshA = a.load('model'), refreshB = b.load('model'); await Promise.resolve();
    expect(a.busy()).toBe(false); expect(a.refreshing()).toBe(true); expect(send).toHaveBeenCalledTimes(4);
    gate.resolve({ schemaVersion: 1, providers: [] }); await Promise.all([refreshA, refreshB]);
    expect(a.providers()).toEqual([]); expect(b.providers()).toEqual([]);
    await a.load('model'); expect(send).toHaveBeenCalledTimes(6);
    const other = createNewSessionCatalog('/other', () => true, send, 'host:lease'); expect(other.providers()).toEqual([]);
    expect(createNewSessionCatalog('/repo', () => true, send, 'other:lease').providers()).toEqual([]);
  });
  it('publishes independent readiness, preserves complete providers on partial refresh, and fences preference writes', async () => {
    const { createNewSessionCatalog } = await import('./new-session-selection');
    let partial = false; const gate = deferred<unknown>(); let wait = false;
    const send = vi.fn(async (path: string) => path.includes('/providers?') ? { schemaVersion: 1, partial, providers: partial ? [] : [{ id: 'p', models: { m: { id: 'm' } } }] } : wait ? gate.promise : {});
    const first = createNewSessionCatalog('/repo', () => true, send, 'host'); await first.load('model');
    const previous = first.providers(); partial = true; wait = true;
    const work = first.load('model'); for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(first.providers()).toBe(previous); expect(first.partial()).toBe(true); expect(first.refreshing()).toBe(true);
    first.setPreferences({ favoriteModels: [{ providerID: 'p', modelID: 'm' }] }); gate.resolve({ favoriteModels: [] }); await work;
    expect(first.preferences().favoriteModels).toHaveLength(1);
  });
});
