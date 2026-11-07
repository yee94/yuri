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
});
