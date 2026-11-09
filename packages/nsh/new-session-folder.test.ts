import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Row } from './model';

const h = vi.hoisted(() => ({ call: vi.fn(), storage: new Map<string, string>(), cleanups: [] as Array<() => void>, stops: [] as Array<() => void>, set: vi.fn() }));
vi.mock('nsh', () => ({
  platform: { os: 'ios', desktop: false },
  signal: <T>(value: T) => Object.assign(() => value, { set: (next: T) => { value = next; } }),
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(), lifecycle: () => 'active', locale: () => 'en',
  effect: (work: () => unknown) => { const dispose = work(); if (typeof dispose === 'function') h.stops.push(dispose as () => void); },
  cleanup: (work: () => void) => h.cleanups.push(work),
  Storage: { getItem: async (key: string) => h.storage.get(key) ?? null, setItem: h.set },
  host: { available: () => true, call: h.call, on: () => () => {} },
}));
type Draft = ReturnType<(typeof import('./new-session'))['openNativeNewSession']>;
type Owner = ReturnType<(typeof import('./projects-sidebar'))['createProjectsSidebar']>;
const project = { id: 'project', name: 'Project', path: '/repo' }, folder = { scope: '/repo', id: 'folder' };
const folders = () => ({ version: 1 as const, foldersMap: { '/repo': [{ id: 'folder', name: 'Folder', sessionIds: [] as string[], createdAt: 1 }] }, collapsedFolderIds: [] as string[], updatedAt: 1 });
let drafts: Draft[], owners: Owner[], wire: ReturnType<typeof folders>, authority: Row, active: boolean, authorization: string;
let intercept: (path: string, method: string, body: Row, next: () => unknown) => unknown;
const requests = () => h.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input as { path: string; method: string; body: Row });
const creates = () => requests().filter(row => row.path === '/api/session' && row.method === 'POST');
const memberships = () => requests().filter(row => row.path === '/api/session-folders' && row.method === 'POST');
const receipt = () => JSON.parse([...h.storage.entries()].find(([key]) => key.startsWith('nsh:new-session:v1:'))![1]);
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const ticks = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
beforeEach(async () => {
  vi.resetModules(); h.storage.clear(); h.cleanups = []; h.stops = []; drafts = []; owners = []; wire = folders(); authority = { id: 'created', directory: '/repo', title: 'Created' }; active = true; authorization = 'authorization';
  intercept = (_path, _method, _body, next) => next();
  h.set.mockReset().mockImplementation(async (key: string, value: string) => { h.storage.set(key, value); });
  h.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected: 'host', connections: [{ id: 'host', url: 'https://host.example', authorizationID: authorization, label: 'Fixture', lastUsedAt: 0 }], runtimeScope: { hostID: 'host', lease: `lease-${authorization}` } };
    if (name !== 'runtime.request') return true;
    const body = await intercept(input.path, input.method, input.body ?? {}, () => {
      if (input.path === '/api/session' && input.method === 'POST') return { data: authority };
      if (input.path === '/api/session-folders') {
        if (input.method === 'POST') { wire = structuredClone(input.body); return { success: true }; }
        return structuredClone(wire);
      }
      if (input.path.startsWith('/api/session/created?')) return { ...authority };
      if (input.path.includes('/message?') || input.path.includes('/inbox?')) return { data: [] };
      if (input.path === '/api/session/active') return {};
      throw new Error('unexpected_request');
    });
    return { status: 200, body };
  });
  const state = await import('./state'); await state.loadConnections();
});
afterEach(async () => { for (const draft of drafts) await draft.close(); owners.forEach(owner => owner.dispose()); h.stops.forEach(stop => stop()); h.cleanups.forEach(stop => stop()); });
async function mountFolderOwner() {
  const state = await import('./state'), { createProjectsSidebar } = await import('./projects-sidebar');
  const owner = createProjectsSidebar({ capture: state.captureHostOperation, current: () => active, changed: () => {}, directories: scope => scope === '/repo' ? ['/repo'] : [], projects: () => {}, restored: () => {}, visible: () => true,
    session: (value, directory = '/repo') => { const row = value as Row; return { id: String(row.id), title: String(row.title ?? ''), directory: String(row.directory ?? directory), updated: 0, parentID: typeof row.parentID === 'string' ? row.parentID : undefined, archived: Number((row.time as Row)?.archived) > 0, pinned: false }; },
  }); owners.push(owner); return owner;
}
async function open(extra: Partial<Parameters<(typeof import('./new-session'))['openNativeNewSession']>[0]> = {}) {
  const { openNativeNewSession } = await import('./new-session'); const draft = openNativeNewSession({ project, folder, active: () => active, ...extra }); drafts.push(draft); await draft.ready; return draft;
}

describe('first create → original folder owner → durable membership ACK → handoff', () => {
  it('opening, typing, a modal/cancel and remount persist only exact folder metadata, never a remote create/membership', async () => {
    await mountFolderOwner(); const draft = await open();
    for (let i = 0; i < 50; i++) draft.setDraftText(`draft ${i}`);
    active = false; await expect(draft.submit()).rejects.toThrow('scope-changed'); active = true;
    await draft.close(); const restored = await open({ folder: undefined });
    expect(restored.folder()).toEqual(folder); expect(receipt().folder).toEqual(folder); expect(Object.keys(receipt())).not.toContain('text');
    expect(creates()).toEqual([]); expect(memberships()).toEqual([]);
  });
  it('resolves the actual registered owner and posts once after create, before the installed handoff', async () => {
    await mountFolderOwner(); const draft = await open(); draft.setDraftText('hello');
    const handoff = await draft.submit(); expect(handoff?.target.id).toBe('created'); expect(draft.phase()).toBe('installed');
    expect(receipt().folder).toEqual({ ...folder, status: 'acknowledged' }); expect(wire.foldersMap['/repo'][0]!.sessionIds).toEqual(['created']);
    expect(creates()).toHaveLength(1); expect(memberships()).toHaveLength(1);
    expect(requests().findIndex(row => row === creates()[0])).toBeLessThan(requests().findIndex(row => row === memberships()[0]));
    await draft.submit(); expect(creates()).toHaveLength(1); expect(memberships()).toHaveLength(1);
  });
  it('an explicit folder hook retargets the same ordinary unsent owner without losing text or writing remotely', async () => {
    const draft = await open({ folder: undefined }); draft.setDraftText('keep this draft');
    await draft.setFolder(folder); expect(draft.durable.draft()).toBe('keep this draft'); expect(draft.folder()).toEqual(folder);
    expect(creates()).toEqual([]); expect(memberships()).toEqual([]);
    await draft.close(); const restored = await open({ folder: undefined }); expect(restored.folder()).toEqual(folder);
  });
  it('an in-flight local folder checkpoint blocks create and a second retarget in the core, not only in UI', async () => {
    const draft = await open({ folder: undefined }); draft.setDraftText('keep this draft');
    const gate = deferred<void>(), normal = h.set.getMockImplementation()!;
    h.set.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith('nsh:new-session:v1:') && JSON.parse(value).folder) await gate.promise;
      return normal(key, value);
    });
    const retarget = draft.setFolder(folder); await ticks(); expect(draft.folderChanging()).toBe(true);
    expect(await draft.submit()).toBeNull(); await expect(draft.setFolder({ ...folder, id: 'second' })).rejects.toThrow('folder-frozen');
    expect(creates()).toEqual([]); expect(memberships()).toEqual([]);
    gate.resolve(); await retarget; expect(draft.folderChanging()).toBe(false); expect(draft.folder()).toEqual(folder);
    expect(draft.durable.draft()).toBe('keep this draft');
  });
  it('a known ACK survives refresh failure and restart without repeating either POST', async () => {
    await mountFolderOwner(); let acknowledged = false;
    intercept = (path, method, _body, next) => {
      if (path === '/api/session-folders' && method === 'POST') { acknowledged = true; return next(); }
      if (path === '/api/session-folders' && acknowledged) throw new Error('refresh offline');
      return next();
    };
    const draft = await open(); draft.setDraftText('hello'); expect((await draft.submit())?.target.id).toBe('created');
    expect(draft.folder()?.status).toBe('acknowledged'); await draft.close();
    const restored = await open({ folder: undefined }); expect((await restored.submit())?.target.id).toBe('created');
    expect(memberships()).toHaveLength(1); expect(creates()).toHaveLength(1);
  });
  it.each(['lost', 'malformed'] as const)('an %s membership ACK stays unknown across remount; matching GET is not causal success', async outcome => {
    await mountFolderOwner(); intercept = (path, method, _body, next) => {
      const result = next(); if (path === '/api/session-folders' && method === 'POST') { if (outcome === 'lost') throw new Error('lost ACK'); return {}; } return result;
    };
    const draft = await open(); draft.setDraftText('hello'); await expect(draft.submit()).rejects.toThrow('folder-outcome-unknown');
    expect(draft.phase()).toBe('created'); expect(draft.folder()?.status).toBe('unknown'); await draft.close();
    const restored = await open({ folder: undefined }); await expect(restored.submit()).rejects.toThrow('folder-outcome-unknown');
    expect(wire.foldersMap['/repo'][0]!.sessionIds).toEqual(['created']); expect(creates()).toHaveLength(1); expect(memberships()).toHaveLength(1);
  });
  it('unknown create preserves the folder and never sends membership or another create', async () => {
    await mountFolderOwner(); intercept = (path, method, _body, next) => { if (path === '/api/session' && method === 'POST') throw new Error('lost create'); return next(); };
    const draft = await open(); draft.setDraftText('hello'); await expect(draft.submit()).rejects.toThrow('lost create'); await draft.close();
    const restored = await open({ folder: undefined }); expect(restored.folder()).toEqual(folder); await expect(restored.submit()).rejects.toThrow('create-outcome-unknown');
    expect(creates()).toHaveLength(1); expect(memberships()).toEqual([]);
  });
  it('failure to persist the membership write-ahead record sends no membership; a lost ACK journal never replays POST', async () => {
    await mountFolderOwner(); const draft = await open(); draft.setDraftText('hello');
    const normal = h.set.getMockImplementation()!; let block = true;
    h.set.mockImplementation(async (key: string, value: string) => {
      if (block && key.startsWith('nsh:new-session:v1:') && JSON.parse(value).folder?.status === 'unknown') throw new Error('disk');
      return normal(key, value);
    });
    await expect(draft.submit()).rejects.toThrow('folder-outcome-unknown'); expect(memberships()).toEqual([]); expect(draft.phase()).toBe('created');
    block = false;
    h.set.mockImplementation(async (key: string, value: string) => {
      if (key.startsWith('nsh:new-session:v1:') && JSON.parse(value).folder?.status === 'acknowledged') throw new Error('ACK disk');
      return normal(key, value);
    });
    await expect(draft.submit()).rejects.toThrow('folder-outcome-unknown'); expect(draft.folder()?.status).toBe('unknown');
    h.set.mockImplementation(normal); await expect(draft.submit()).rejects.toThrow('folder-outcome-unknown');
    expect(creates()).toHaveLength(1); expect(memberships()).toHaveLength(1);
  });
  it('missing/moved folder or foreign session blocks membership but retains the confirmed create receipt', async () => {
    await mountFolderOwner(); authority.directory = '/foreign'; const draft = await open(); draft.setDraftText('hello');
    await expect(draft.submit()).rejects.toThrow('folder-outcome-unknown');
    expect(draft.phase()).toBe('created'); expect(draft.folder()).toEqual(folder); expect(creates()).toHaveLength(1); expect(memberships()).toEqual([]);
    authority.directory = '/repo'; expect((await draft.submit())?.target.id).toBe('created'); expect(creates()).toHaveLength(1); expect(memberships()).toHaveLength(1);
  });
  it('modal pause while awaiting ACK retains the exact receipt and resumes by reading, not POSTing', async () => {
    await mountFolderOwner(); const gate = deferred<unknown>(); let sent = false;
    intercept = (path, method, _body, next) => { if (path === '/api/session-folders' && method === 'POST') { sent = true; next(); return gate.promise; } return next(); };
    const draft = await open(); draft.setDraftText('hello'); const pending = draft.submit(); await ticks(); expect(sent).toBe(true);
    active = false; gate.resolve({ success: true }); await expect(pending).rejects.toThrow('scope-changed');
    expect(draft.folder()?.status).toBe('acknowledged'); active = true; expect((await draft.submit())?.target.id).toBe('created');
    expect(creates()).toHaveLength(1); expect(memberships()).toHaveLength(1);
  });
  it('scope retirement cannot lend the old membership to a replacement authorization', async () => {
    await mountFolderOwner(); const gate = deferred<unknown>();
    intercept = (path, method, _body, next) => { if (path === '/api/session-folders' && method === 'POST') { next(); return gate.promise; } return next(); };
    const draft = await open(); draft.setDraftText('hello'); const pending = draft.submit(); await ticks();
    authorization = 'replacement'; const state = await import('./state'); await state.loadConnections(); gate.resolve({ success: true });
    await expect(pending).rejects.toThrow('scope-changed'); expect(draft.ownedScope()).toBe(false); expect(creates()).toHaveLength(1); expect(memberships()).toHaveLength(1);
  });
  it('no original owner is not an available fake; opening another folder cannot overwrite the saved target', async () => {
    const draft = await open(); draft.setDraftText('hello'); await expect(draft.submit()).rejects.toThrow('folder-owner-unavailable');
    expect(draft.phase()).toBe('created'); expect(creates()).toHaveLength(1); expect(memberships()).toEqual([]); await draft.close();
    await expect(open({ folder: { scope: '/repo', id: 'different' } })).rejects.toThrow('folder-conflict');
  });
});
