import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as model from './model';
import * as deletion from './projects-delete';
import * as attention from './projects-attention';
import * as blocking from './projects-attention-blocking';
import * as indicator from '../ui/src/mobile/projects/mobileSessionIndicator';
import * as summary from '../ui/src/lib/sessionChangeSummary';
import * as orderGesture from './projects-order-gesture';
import * as orderTouch from './projects-order-touch';
import * as sidebar from './projects-sidebar';
import * as presentation from './projects-presentation';
import * as homeSummary from './projects-summary';
import * as timeCore from '../ui/src/lib/time-format-core';
import * as worktreeNames from '../ui/src/lib/worktrees/worktreeNames';
import * as branchNameGenerator from '../ui/src/lib/git/branchNameGenerator';
import * as sessionMenuModel from '../ui/src/mobile/sessionMenuModel';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'projects.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2023 } }).outputText;
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
let generation: number;
let effects: Array<() => void>;
const advanceGeneration = () => { generation++; effects.forEach(work => work()); };
let handle: (path: string, method?: string, body?: unknown) => unknown;
let request: ReturnType<typeof vi.fn>;
let module: typeof import('./projects');
let app: { sessions: ReturnType<typeof signal<model.Session[]>>; projects: ReturnType<typeof signal<model.Project[]>>; connection: ReturnType<typeof signal<{ id: string }>> };
let dispose: Array<() => void>;
let emit: (payload: unknown) => void;
let attentionStore: ReturnType<typeof attention.createProjectsAttention>;
const row = (id: string, directory = '/repo') => ({ id, title: id, location: { directory }, time: { updated: 10 } });
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
beforeEach(() => {
  vi.useFakeTimers();
  generation = 1; effects = []; dispose = []; app = { sessions: signal([]), projects: signal([]), connection: signal({ id: 'fixture-host' }) };
  handle = path => path === '/api/session/active' ? {} : path === '/api/session-folders/order' ? { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} } : { available: true, pinnedSessionIds: [], directories: [{ directory: '/repo', sessions: [row('head')], hasMore: true }] };
  request = vi.fn(async (...args: [string, string?, unknown?]) => handle(...args));
  attentionStore = attention.createProjectsAttention(); attentionStore.activate(JSON.stringify([generation, app.connection().id]));
  const exports = {};
  const imports: Record<string, unknown> = {
    nsh: { signal, effect: (work: () => void) => { effects.push(work); work(); }, untracked: (work: () => unknown) => work(), computed: (work: () => unknown) => work, cleanup: (stop: () => void) => dispose.push(stop), host: { on: (_name: string, listener: (payload: unknown) => void) => { emit = listener; return () => {}; } }, lifecycle: () => 'active' },
    // This suite never mounts UI. Isolate only the native presentation leaves;
    // createProjectsController and the page-operation fencing remain production code.
    'nsh/base': {}, './native-sheet': { NativeSheet: () => { throw new Error('Controller tests must not mount a Sheet'); } }, './Icon': {}, './i18n': { t: (key: string) => key }, './model': model,
    './runtime': { request, query: (directory: string) => `directory=${encodeURIComponent(directory)}`, sessionPath: (id: string, suffix: string) => `/api/session/${encodeURIComponent(id)}/${suffix}` },
     './state': { app: { ...app, runtimeScope: () => null }, epoch: () => generation,
       captureHostRequest: () => request,
       captureHostOperation: () => { const captured = generation, id = app.connection().id; return { current: () => captured === generation && id === app.connection().id, request: async (path: string, method?: string, body?: unknown) => { if (captured !== generation || id !== app.connection().id) throw new Error('host_operation_stale'); return body !== undefined ? request(path, method, body) : method !== undefined ? request(path, method) : request(path); } }; },
     },
     './projects-order-gesture': orderGesture,
      './projects-order-touch': orderTouch,
      './projects-sidebar': sidebar,
      './projects-presentation': presentation,
      './projects-summary': homeSummary,
      '../ui/src/lib/time-format-core': timeCore,
      '../ui/src/lib/worktrees/worktreeNames': worktreeNames,
      '../ui/src/lib/git/branchNameGenerator': branchNameGenerator,
      '../ui/src/mobile/sessionMenuModel': sessionMenuModel,
      './projects-worktree-picker': {},
      './projects-worktree-form': {},
      './appearance': {},
     './projects-delete': deletion, './projects-attention': { ...attention, projectsAttention: attentionStore }, '../ui/src/lib/sessionChangeSummary': summary,
     './projects-attention-blocking': blocking, './projects-attention-indicator': {}, '../ui/src/mobile/projects/mobileSessionIndicator': indicator,
  };
  const operationExports = {};
  const operationSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'page-operations.ts'), 'utf8');
  vm.runInNewContext(ts.transpileModule(operationSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, { exports: operationExports, require: (id: string) => imports[id] });
  imports['./page-operations'] = operationExports;
  vm.runInNewContext(compiled, { exports, require: (id: string) => { if (!(id in imports)) throw new Error(id); return imports[id]; }, setTimeout, clearTimeout, console });
  module = exports as typeof module;
});
afterEach(() => { dispose.forEach(stop => stop()); vi.useRealTimers(); });

describe('native projects authority', () => {
  it('exposes only retained authoritative parents/children to the lazy switcher, never the cold app seed', async () => {
    app.sessions.set([{ id: 'cold', title: 'Cold partial startup', directory: '/repo', updated: 100 }]);
    const controller = module.createProjectsController();
    expect(controller.catalogReady()).toBe(false); expect(controller.retainedSessions()).toEqual([]);
    const normal = handle;
    handle = path => path.startsWith('/api/session?') ? { data: [{ ...row('child'), parentID: 'head' }], cursor: {} } : normal(path);
    await controller.refresh(); expect(controller.catalogReady()).toBe(true);
    const loaded = handle, delayed = deferred();
    handle = () => delayed.promise;
    const paging = controller.loadDirectory('/repo'); expect(controller.catalogLoading()).toBe(true);
    delayed.resolve({ data: [], cursor: {} }); await paging; expect(controller.catalogLoading()).toBe(false);
    handle = loaded;
    await controller.sidebar.loadChildren(controller.sessions().find(row => row.id === 'head')!);
    const before = request.mock.calls.length;
    for (let i = 0; i < 50; i++) expect(controller.retainedSessions().map(row => row.id)).toEqual(['head', 'child']);
    expect(request).toHaveBeenCalledTimes(before);
    handle = () => { throw new Error('offline'); }; await controller.refresh();
    expect(controller.catalogReady()).toBe(true); expect(controller.error()).toContain('offline');
    expect(controller.retainedSessions().map(row => row.id)).toEqual(['head', 'child']);
    controller.dispose(); expect(controller.retainedSessions()).toEqual([]);
  });
  it('keeps initial readiness unknown on failed/partial index and resolves pinned metadata from the owning Host', async () => {
    app.sessions.set([{ id: 'pin', title: 'Cold seed', directory: '/repo', updated: 1 }]);
    const controller = module.createProjectsController(), normal = handle;
    handle = path => path === '/api/yuri/session-index' ? { available: true, directories: [], pinnedSessionIds: ['pin'], sync: { failedDirectories: ['/failed'] } }
      : path === '/api/yuri/session-index/session/pin' ? { session: { ...row('pin'), title: 'Host title', time: { created: 123, updated: 200 }, metadata: { yuri: { titleRefresh: { activityUpdatedAt: 300 } } } } } : normal(path);
    await controller.refresh();
    expect(controller.catalogReady()).toBe(false); expect(controller.error()).toContain('failed directories');
    expect(controller.retainedSessions()[0]).toMatchObject({ id: 'pin', title: 'Host title', created: 123, activity: 300 });
    expect(request.mock.calls.filter(([path]) => path === '/api/yuri/session-index/session/pin')).toHaveLength(1);
  });
  it('distinguishes an initial read failure from an authoritative successful empty retained catalog', async () => {
    const controller = module.createProjectsController(), normal = handle;
    handle = () => { throw new Error('offline'); }; await controller.refresh();
    expect(controller.catalogReady()).toBe(false); expect(controller.retainedSessions()).toEqual([]);
    handle = path => path === '/api/yuri/session-index' ? { available: true, directories: [], pinnedSessionIds: [] } : normal(path);
    await controller.refresh(); expect(controller.catalogReady()).toBe(true); expect(controller.error()).toBe('');
    expect(controller.retainedSessions()).toEqual([]);
  });
  it('retains an explicitly loaded twelve-row window through a five-row head refresh, but complete authority removes its old tail', async () => {
    const controller = module.createProjectsController();
    const wire = Array.from({ length: 12 }, (_, i) => ({ ...row(`window-${i}`), time: { updated: 100 - i } }));
    const sessions = wire.map(value => module.projectsSessionPage({ data: [value], cursor: {} }).sessions[0]!);
    controller.buckets.set({ '/repo': { sessions, cursor: null, loaded: true, hasMore: false } });
    let more = true;
    const normal = handle;
    handle = path => path === '/api/yuri/session-index' ? { available: true, directories: [{ directory: '/repo', sessions: wire.slice(0, 5), hasMore: more }] } : normal(path);
    await controller.refresh();
    expect(controller.sessions().map(row => row.id)).toEqual(sessions.map(row => row.id));
    expect(controller.buckets()['/repo']?.hasMore).toBe(false);
    more = false; await controller.refresh();
    expect(controller.sessions().map(row => row.id)).toEqual(sessions.slice(0, 5).map(row => row.id));
  });
  it('retains directory display limits independently of row mounts and never reads a complete index just to reveal cached rows', async () => {
    const controller = module.createProjectsController();
    controller.buckets.set({ '/repo': { sessions: Array.from({ length: 5 }, (_, i) => module.projectsSessionPage({ data: [row(`s${i}`)], cursor: {} }).sessions[0]!), loaded: false, cursor: null, hasMore: false } });
    const before = request.mock.calls.length;
    expect(controller.visibleCount('/repo')).toBe(3);
    controller.showMore('/repo');
    expect(controller.visibleCount('/repo')).toBe(10);
    expect(controller.visibleCount('/other')).toBe(3);
    for (let i = 0; i < 50; i++) expect(controller.visibleCount('/repo')).toBe(10);
    expect(request.mock.calls.length).toBe(before);
    controller.showFewer('/repo'); expect(controller.visibleCount('/repo')).toBe(3);
    expect(module.createProjectsController().visibleCount('/repo')).toBe(3);
  });
  it('keeps expanded limits and prior rows through paging failure; retired owners cannot change them', async () => {
    const controller = module.createProjectsController(); await controller.refresh();
    handle = () => { throw new Error('synthetic page unavailable'); };
    controller.showMore('/repo'); await Promise.resolve(); await Promise.resolve();
    expect(controller.visibleCount('/repo')).toBe(10);
    expect(controller.sessions().map(row => row.id)).toEqual(['head']);
    app.connection.set({ id: 'another-host' }); advanceGeneration(); controller.showMore('/repo'); controller.showFewer('/repo');
    expect(controller.visibleCount('/repo')).toBe(10);
  });
  it('enumerates the complete subtree, masks every surface without DELETE, and restores after snapshot eviction on Undo', async () => {
    vi.useFakeTimers();
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    const child = { ...row('child'), parentID: 'head' }, grandchild = { ...row('grandchild', '/other'), parentID: 'child' };
    handle = path => path.includes('parentID=head') && !path.includes('cursor=') ? { data: [], cursor: { next: 'opaque+=' } } : { data: path.includes('parentID=head') ? [child] : path.includes('parentID=child') ? [grandchild] : [], cursor: {} };
    await controller.mutate(root, 'delete');
    expect(controller.deleteBatches()[0]?.rows.map(row => row.id)).toEqual(['head', 'child', 'grandchild']);
    expect(controller.sessions()).toEqual([]); expect(controller.byDirectory().get('/repo')).toBeUndefined();
    await vi.advanceTimersByTimeAsync(9999);
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
    controller.buckets.set({}); app.sessions.set([]);
    expect(controller.undoDelete(controller.deleteBatches()[0]!.id)).toBe(true);
    expect(controller.sessions().map(row => row.id)).toEqual(['head']);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
  });
  it('makes no mutation or hidden row after incomplete subtree enumeration', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = path => { if (path.includes('parentID=head')) return { data: [{ ...row('child'), parentID: 'head' }], cursor: {} }; throw new Error('incomplete tree'); };
    await controller.mutate(root, 'delete');
    expect(controller.deleteBatches()).toEqual([]); expect(controller.sessions().map(row => row.id)).toEqual(['head']);
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
  });
  it('commits at ten seconds children-first and keeps failed descendants plus ancestors for explicit retry', async () => {
    vi.useFakeTimers();
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    let failed = true;
    handle = (path, method) => {
      if (method === 'DELETE') { if (path.includes('/bad?') && failed) throw new Error('retry child'); return true; }
      return { data: path.includes('parentID=head') ? [{ ...row('bad'), parentID: 'head' }, { ...row('good'), parentID: 'head' }] : [], cursor: {} };
    };
    await controller.mutate(root, 'delete'); await vi.advanceTimersByTimeAsync(10_000);
    expect(request.mock.calls.filter(([, method]) => method === 'DELETE').map(([path]) => path)).toEqual(['/api/session/bad?directory=%2Frepo', '/api/session/good?directory=%2Frepo']);
    expect(controller.deleteBatches()[0]).toMatchObject({ phase: 'failed', error: 'retry child' });
    expect(controller.deleteBatches()[0]?.rows.map(row => row.id)).toEqual(['head', 'bad']);
    expect(controller.sessions().map(row => row.id)).toEqual(['head']);
    failed = false; const before = request.mock.calls.length; await controller.retryDelete(controller.deleteBatches()[0]!.id);
    expect(request.mock.calls.slice(before).map(([path]) => path)).toEqual(['/api/session/bad?directory=%2Frepo', '/api/session/head?directory=%2Frepo']);
    expect(controller.sessions()).toEqual([]); expect(controller.deleteBatches()).toEqual([]);
  });
  it('does not turn an unconfirmed DELETE response into success and retries only after an explicit request', async () => {
    vi.useFakeTimers();
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = (_path, method) => method === 'DELETE' ? false : { data: [], cursor: {} };
    await controller.mutate(root, 'delete'); await vi.advanceTimersByTimeAsync(10_000);
    expect(controller.deleteBatches()[0]?.phase).toBe('failed'); expect(controller.sessions()).toHaveLength(1);
    const count = request.mock.calls.length; await vi.advanceTimersByTimeAsync(100_000); expect(request.mock.calls.length).toBe(count);
    handle = () => { throw Object.assign(new Error('already gone'), { status: 404 }); };
    await controller.retryDelete(controller.deleteBatches()[0]!.id); expect(controller.sessions()).toEqual([]);
  });
  it('keeps the undo journal across page disposal, but never sends a deferred DELETE to a switched Host', async () => {
    vi.useFakeTimers();
    let controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = () => ({ data: [], cursor: {} }); await controller.mutate(root, 'delete'); controller.dispose();
    controller = module.createProjectsController(); expect(controller.deleteBatches()).toHaveLength(1);
    advanceGeneration(); await vi.advanceTimersByTimeAsync(10_000);
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
  });
  it('commits a confirmed deferred delete after its owning page has unmounted on the same Host', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = (_path, method) => method === 'DELETE' ? true : { data: [], cursor: {} };
    await controller.mutate(root, 'delete'); controller.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request.mock.calls.filter(([, method]) => method === 'DELETE')).toEqual([['/api/session/head?directory=%2Frepo', 'DELETE']]);
    const remounted = module.createProjectsController(); expect(remounted.deleteBatches()).toEqual([]); expect(remounted.sessions()).toEqual([]);
  });
  it('Undo preserves newer title, pins and manual order rather than restoring an old whole-list snapshot', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    controller.pins.set(['head']);
    handle = () => ({ data: [], cursor: {} }); await controller.mutate(root, 'delete');
    const batch = controller.deleteBatches()[0]!;
    controller.buckets.set({ '/repo': { sessions: [{ ...root, title: 'New authority title', updated: 200 }], cursor: null, loaded: true, hasMore: false } });
    controller.order.set({ revision: 4, sessionOrderByScope: { '/repo': ['other', 'head'] }, sessionOrderActivityByScope: { '/repo': { head: 200 } } });
    controller.undoDelete(batch.id);
    expect(controller.sessions()[0]?.title).toBe('New authority title'); expect(controller.pins()).toEqual(['head']); expect(controller.order()?.revision).toBe(4);
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
  });
  it('projects authoritative created/changes and pinned creation rank instead of activity rank', () => {
    const page = module.projectsSessionPage({ data: [{ ...row('older'), time: { created: 1, updated: 100 }, model: { providerID: 'provider', id: 'model' }, summary: { additions: 5, deletions: 3, files: 2 }, metadata: { private: 'not-display' } }, { ...row('newer'), time: { created: 2, updated: 10 } }], cursor: {} });
    expect(page.sessions[0]?.changes).toBe('+5 −3');
    expect(page.sessions[0]).toMatchObject({ model: 'provider/model', summary: { additions: 5, deletions: 3, files: 2 } });
    expect(page.sessions[0]).not.toHaveProperty('metadata'); expect(page.sessions[1]).not.toHaveProperty('model'); expect(page.sessions[1]).not.toHaveProperty('summary');
    expect(module.orderedProjectSessions(page.sessions, '__pinned__', null, ['older', 'newer']).map(row => row.id)).toEqual(['newer', 'older']);
  });
  it('never ingests attention from a Projects listener, consumes the sole root source, and preserves repeated running membership', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const initialReads = request.mock.calls.length;
    const dispatch = (type: string, id: string, sessionID = 'head') => emit({ key: 'global', data: JSON.stringify({ payload: { type, id, data: { sessionID } } }) });
    dispatch('session.execution.started', 'run'); const running = controller.running();
    for (let i = 0; i < 50; i++) dispatch('session.step.started', `step-${i}`);
    expect(controller.running()).toBe(running);
    for (let i = 0; i < 50; i++) dispatch('session.text.delta', `delta-${i}`);
    expect(request.mock.calls.length).toBe(initialReads); expect(controller.attention().unseenBySession).toEqual({});
    dispatch('session.execution.succeeded', 'done'); dispatch('session.idle', 'legacy-idle');
    expect(controller.attention().unseenBySession).toEqual({});
    const rootSource = attention.createProjectsAttentionSource({ attention: attentionStore, sessions: () => controller.sessions() });
    rootSource.accept(JSON.stringify([generation, app.connection().id]), { key: 'global', type: 'session.execution.succeeded', body: { sessionID: 'head' }, directory: '/repo' });
    expect(controller.running()).toEqual([]); expect(controller.attention().unseenBySession).toEqual({ head: 1 });
    controller.markViewed('head'); expect(controller.attention().unseenBySession).toEqual({});
    dispatch('session.execution.succeeded', 'unknown-done', 'unknown-child');
    expect(controller.attention().unseenBySession).toEqual({}); expect(request.mock.calls.length).toBe(initialReads);
  });
  it('keeps newest-20 summary incomplete and pages with the upstream opaque cursor', async () => {
    const controller = module.createProjectsController(); await controller.refresh();
    expect(controller.buckets()['/repo']?.loaded).toBe(false);
    handle = path => ({ data: [row(path.includes('cursor=') ? 'older' : 'page')], cursor: { next: path.includes('cursor=') ? null : 'opaque+/=' } });
    await controller.loadDirectory('/repo'); await controller.loadDirectory('/repo');
    expect(request.mock.calls.at(-1)?.[0]).toContain('cursor=opaque%2B%2F%3D');
    expect(controller.sessions().map(item => item.id)).toContain('older');
    expect(controller.buckets()['/repo']?.hasMore).toBe(false);
  });
  it('does not mistake filtered empty pages for exhaustion', async () => {
    const controller = module.createProjectsController();
    handle = () => ({ data: [{ ...row('child'), parentID: 'parent' }], cursor: { next: 'next' } });
    await controller.loadDirectory('/repo');
    expect(controller.sessions()).toHaveLength(0);
    expect(controller.buckets()['/repo']?.hasMore).toBe(true);
  });
  it('retains valid snapshots and worktrees after failures', async () => {
    const controller = module.createProjectsController(); await controller.refresh();
    handle = () => [{ path: '/tree', branch: 'feature', name: 'tree' }];
    await controller.loadWorktrees({ id: 'p', name: 'Repo', path: '/repo' });
    handle = () => { throw new Error('offline'); };
    await controller.refresh(); await controller.loadDirectory('/repo'); await controller.loadWorktrees({ id: 'p', name: 'Repo', path: '/repo' });
    expect(controller.sessions().map(item => item.id)).toEqual(['head']);
    expect(controller.worktrees()['/repo']?.[0]?.path).toBe('/tree');
    expect(controller.error()).toContain('offline');
  });
  it('authoritative empty directory replaces stale app summaries', async () => {
    app.sessions.set([{ id: 'stale', title: 'stale', directory: '/repo', updated: 10 }]);
    const controller = module.createProjectsController(); handle = () => ({ data: [], cursor: {} });
    await controller.loadDirectory('/repo', true);
    expect(controller.sessions()).toEqual([]);
  });
  it('fences old-host pages even after the controller binds to the new host', async () => {
    const controller = module.createProjectsController(), late = deferred();
    handle = () => late.promise; const previous = controller.loadDirectory('/repo');
    advanceGeneration(); handle = path => path === '/api/session/active' ? {} : { available: true, directories: [], pinnedSessionIds: [] };
    await controller.refresh(); late.resolve({ data: [row('old-host')], cursor: {} }); await previous;
    expect(controller.sessions()).toEqual([]);
    expect(controller.pending()).toEqual([]);
  });
  it('fences page completion after unmount', async () => {
    const controller = module.createProjectsController(), late = deferred(); handle = () => late.promise;
    const work = controller.loadDirectory('/repo'); controller.dispose(); late.resolve({ data: [row('late')], cursor: {} }); await work;
    expect(controller.sessions()).toEqual([]);
  });
  it('searches all directories, not the summary cache, and rejects out-of-order results', async () => {
    const controller = module.createProjectsController(), late = deferred();
    handle = path => path.includes('search=old') ? late.promise : { data: [row('new', '/another')], cursor: {} };
    const old = controller.search('old'); await controller.search('new'); late.resolve({ data: [row('old')], cursor: {} }); await old;
    expect(controller.searchResults().map(item => item.id)).toEqual(['new']);
    expect(request.mock.calls[0]?.[0]).not.toContain('directory=');
  });
  it('uses exact pin and Host archive protocols and preserves failed mutations', async () => {
    const controller = module.createProjectsController(); await controller.refresh();
    const session = controller.sessions()[0]!;
    handle = () => null; await controller.mutate(session, 'pin');
    expect(request).toHaveBeenCalledWith('/api/yuri/session-index/session/head/pin', 'POST');
    expect(controller.pins()).toEqual(['head']);
    handle = () => { throw new Error('offline'); }; await controller.mutate(session, 'archive');
    expect(controller.sessions()).toHaveLength(1);
    handle = path => path.startsWith('/api/session?') ? { data: [], cursor: {} } : { session: { ...row('head'), time: { updated: 10, archived: 1 } } }; await controller.mutate(session, 'archive');
    expect(request).toHaveBeenLastCalledWith('/api/yuri/sessions/head/archive', 'PUT', expect.objectContaining({ directory: '/repo', archivedAt: expect.any(Number) }));
    expect(controller.sessions()).toEqual([]);
  });
  it('validates user-requested worktree creation and never creates after host change', async () => {
    const controller = module.createProjectsController(), late = deferred(); handle = () => late.promise;
    const work = controller.createWorktree({ id: 'p', name: 'Repo', path: '/repo' }, 'feature', 'folder', 'main');
    advanceGeneration(); late.resolve({ ok: true }); await work;
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]).toEqual(['/api/git/worktrees/validate?directory=%2Frepo', 'POST', { mode: 'new', branchName: 'feature', worktreeName: 'folder', startRef: 'main' }]);
  });
  it('renames through official PATCH and preserves the old title on failure', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const session = controller.sessions()[0]!;
    handle = () => { throw new Error('offline'); }; await controller.mutate(session, 'rename', 'Changed');
    expect(controller.sessions()[0]?.title).toBe('head');
    handle = path => path.endsWith('/metadata') ? { metadata: {} } : null; await controller.mutate(session, 'rename', ' Changed ');
    expect(request).toHaveBeenLastCalledWith('/api/session/head', 'PATCH', { title: 'Changed' });
    expect(controller.sessions()[0]?.title).toBe('Changed');
  });
  it('creates an existing-branch worktree only after validation and keeps unrelated worktrees on removal', async () => {
    const controller = module.createProjectsController();
    const project = { id: 'p', name: 'Repo', path: '/repo' };
    let deleted = false;
    handle = (path, method) => path.startsWith('/api/session?') ? { data: [], cursor: {} } : path.includes('/validate') ? { ok: true } : method === 'DELETE' ? (deleted = true, { success: true }) : method === 'POST' ? { path: '/tree' } : [{ path: '/other', branch: 'other', name: 'other' }, ...(!deleted ? [{ path: '/tree', branch: 'feature', name: 'tree' }] : [])];
    expect(await controller.createWorktree(project, 'feature', 'tree', '', 'existing')).toBe('/tree');
    expect(request.mock.calls[0]?.[2]).toEqual({ mode: 'existing', existingBranch: 'feature', worktreeName: 'tree' });
    await controller.removeWorktree(project, { path: '/tree', branch: 'feature', name: 'tree' }, true);
    expect(request).toHaveBeenCalledWith('/api/git/worktrees?directory=%2Frepo', 'DELETE', { directory: '/tree', deleteLocalBranch: true });
    expect(controller.worktrees()['/repo']?.map(tree => tree.path)).toEqual(['/other']);
  });
  it('never removes the main workspace', async () => {
    const controller = module.createProjectsController();
    await controller.removeWorktree({ id: 'p', name: 'Repo', path: '/repo' }, { path: '/repo', branch: 'main', name: 'repo' }, true);
    expect(request).not.toHaveBeenCalled();
  });
  it('formats the same compact path alias and excludes system sessions', () => {
    expect(module.projectPathHint('/home/person/Code/github/yuri')).toBe('Code/github');
    expect(module.projectsSessionPage({ data: [row('ok'), { ...row('worker'), metadata: { yuri: { scheduledTask: { taskID: 't' } } } }], cursor: {} }).sessions.map(item => item.id)).toEqual(['ok']);
  });
  it('uses Host ranks, preserves unloaded ranks, and promotes only new activity', async () => {
    const controller = module.createProjectsController();
    app.sessions.set([{ id: 'a', title: 'a', directory: '/repo', updated: 10 }, { id: 'b', title: 'b', directory: '/repo', updated: 20 }]);
    let snapshot = { revision: 1, sessionOrderByScope: { '/repo': ['a', 'hidden', 'b'], '/other': ['untouched'] }, sessionOrderActivityByScope: { '/repo': { a: 10, b: 20 }, '/other': {} } };
    handle = (path, method, body) => {
      if (method === 'POST') { const input = body as { scopeKey: string; order: string[]; activity: Record<string, number> }; snapshot = { ...snapshot, revision: snapshot.revision + 1, sessionOrderByScope: { ...snapshot.sessionOrderByScope, [input.scopeKey]: input.order }, sessionOrderActivityByScope: { ...snapshot.sessionOrderActivityByScope, [input.scopeKey]: input.activity } }; }
      return snapshot;
    };
    await controller.loadOrder(); expect(controller.byDirectory().get('/repo')?.map(row => row.id)).toEqual(['a', 'b']);
    await controller.reorder('/repo', 'b', 'a');
    expect(request).toHaveBeenLastCalledWith('/api/session-folders/order', 'POST', { scopeKey: '/repo', order: ['b', 'a', 'hidden'], activity: { a: 10, b: 20 }, onlyIfAbsent: false });
    expect(controller.order()?.sessionOrderByScope['/other']).toEqual(['untouched']);
    app.sessions.set([{ id: 'a', title: 'a', directory: '/repo', updated: 30 }, { id: 'b', title: 'b', directory: '/repo', updated: 20 }]);
    expect(controller.byDirectory().get('/repo')?.map(row => row.id)).toEqual(['a', 'b']);
  });
  it('keeps confirmed order on failed writes and ignores prior generation responses during same-Host recovery', async () => {
    const controller = module.createProjectsController();
    app.sessions.set([{ id: 'a', title: 'a', directory: '/repo', updated: 10 }, { id: 'b', title: 'b', directory: '/repo', updated: 20 }]);
    const snapshot = { revision: 5, sessionOrderByScope: { '/repo': ['a', 'b'] }, sessionOrderActivityByScope: { '/repo': { a: 10, b: 20 } } };
    handle = (_path, method) => { if (method === 'POST') throw new Error('write failed'); return snapshot; };
    await controller.loadOrder(); await controller.reorder('/repo', 'b', 'a');
    expect(controller.byDirectory().get('/repo')?.map(row => row.id)).toEqual(['a', 'b']);
    const late = deferred(); handle = () => late.promise; const read = controller.loadOrder();
    advanceGeneration(); handle = path => path === '/api/session/active' ? {} : path === '/api/session-folders/order' ? { revision: 6, sessionOrderByScope: {}, sessionOrderActivityByScope: {} } : { available: true, directories: [] };
    await controller.refresh(); late.resolve(snapshot); await expect(read).rejects.toThrow('page_operation_stale');
    expect(controller.order()?.revision).toBe(6);
  });
  it('enumerates paginated descendants before archiving and restores ancestors before children', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    const child = { ...row('child'), parentID: 'head' }, grandchild = { ...row('grandchild'), parentID: 'child' };
    const entities = { head: row('head'), child, grandchild };
    handle = (path, _method, body) => {
      if (path.startsWith('/api/session?')) return path.includes('parentID=head') && !path.includes('cursor=child-next') ? { data: [], cursor: { next: 'child-next' } } : { data: path.includes('parentID=head') ? [child] : path.includes('parentID=child') ? [grandchild] : [], cursor: {} };
      const id = path.split('/').at(-2)! as keyof typeof entities;
      return { session: { ...entities[id], time: { updated: 10, archived: (body as { archivedAt: number }).archivedAt } } };
    };
    await controller.mutate(root, 'archive');
    expect(controller.undoRows().map(row => row.id).sort()).toEqual(['child', 'grandchild', 'head']);
    expect(controller.sessions()).toEqual([]);
    const start = request.mock.calls.length; await controller.undoArchive();
    expect(request.mock.calls.slice(start).map(([path]) => path)).toEqual(['/api/yuri/sessions/head/archive', '/api/yuri/sessions/child/archive', '/api/yuri/sessions/grandchild/archive']);
    expect(controller.sessions().map(row => row.id)).toEqual(['head']); expect(controller.undoRows()).toEqual([]);
  });
  it('never mutates a partial child catalog and preserves independently failed archives for retry', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = () => { throw new Error('child snapshot failed'); }; await controller.mutate(root, 'archive');
    expect(request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0);
    expect(controller.sessions()).toHaveLength(1);
    handle = (path, _method, body) => {
      if (path.startsWith('/api/session?')) return { data: path.includes('parentID=head') ? [{ ...row('child'), parentID: 'head' }] : [], cursor: {} };
      if (path.includes('/child/')) throw new Error('child archive failed');
      return { session: { ...row('head'), time: { updated: 10, archived: (body as { archivedAt: number }).archivedAt } } };
    };
    await controller.mutate(root, 'archive'); expect(controller.undoRows().map(row => row.id)).toEqual(['head']);
    await controller.undoArchive(); expect(controller.sessions().map(row => row.id)).toEqual(['head']);
  });
  it('does not unarchive descendants that were archived before the operation', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = (path, _method, body) => path.startsWith('/api/session?') ? { data: path.includes('parentID=head') ? [{ ...row('old-archive'), parentID: 'head', time: { updated: 10, archived: 1 } }] : [], cursor: {} } : { session: { ...row('head'), time: { updated: 10, archived: (body as { archivedAt: number }).archivedAt } } };
    await controller.mutate(root, 'archive'); expect(controller.undoRows().map(row => row.id)).toEqual(['head']);
    expect(request.mock.calls.filter(([path, method]) => method === 'PUT' && path.includes('old-archive'))).toEqual([]);
  });
  it('retains failed undo entries and waits for parent restoration before restoring descendants', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = (path, _method, body) => path.startsWith('/api/session?') ? { data: path.includes('parentID=head') ? [{ ...row('child'), parentID: 'head' }] : [], cursor: {} } : { session: { ...row(path.includes('/child/') ? 'child' : 'head'), ...(path.includes('/child/') ? { parentID: 'head' } : {}), time: { updated: 10, archived: (body as { archivedAt: number }).archivedAt } } };
    await controller.mutate(root, 'archive');
    const normal = handle; handle = path => { if (path.includes('/head/')) throw new Error('parent restore failed'); throw new Error('child must not restore yet'); };
    const before = request.mock.calls.length; await controller.undoArchive();
    expect(request.mock.calls.slice(before).map(([path]) => path)).toEqual(['/api/yuri/sessions/head/archive']);
    expect(controller.undoRows()).toHaveLength(2);
    handle = normal; await controller.undoArchive(); expect(controller.undoRows()).toEqual([]);
  });
  it('ignores archive replies after a Host switch and never installs old undo actions', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!, late = deferred();
    handle = path => path.startsWith('/api/session?') ? { data: [], cursor: {} } : late.promise;
    const archive = controller.mutate(root, 'archive');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    advanceGeneration();
    handle = path => path === '/api/session/active' ? {} : path === '/api/session-folders/order' ? { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} } : { available: true, directories: [] };
    await controller.refresh(); late.resolve({ session: { ...row('head'), time: { archived: 1 } } }); await archive;
    expect(controller.undoRows()).toEqual([]); expect(controller.pending()).toEqual([]);
  });
  it('queues smart titles through the existing metadata merge patch without replacing other metadata', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = () => ({ metadata: { yuri: { titleRefresh: { requestedAt: 1 } } } });
    await controller.smartTitle(root);
    expect(request).toHaveBeenLastCalledWith('/api/yuri/sessions/head/metadata', 'PUT', { directory: '/repo', patch: { yuri: { titleRefresh: expect.objectContaining({ lastAutoTitle: 'head', requestedAt: expect.any(Number), isGenerating: null, lastError: null, failedAt: null }) } } });
    expect(controller.sessions()[0]?.title).toBe('head');
  });
  it('refuses message sync while authoritatively busy and reads the native projection when idle', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = () => ({ data: { head: { type: 'running' } } }); const start = request.mock.calls.length;
    await controller.syncMessages(root); expect(request.mock.calls.slice(start)).toHaveLength(1);
    handle = path => path === '/api/session/active' ? { data: {} } : { data: [], cursor: {} };
    await controller.syncMessages(root); expect(request.mock.calls.at(-1)?.[0]).toBe('/api/session/head/message?directory=%2Frepo&limit=20&order=desc');
    expect(controller.notice()).toContain('refreshTranscriptSuccess');
  });
  it('closes only the selected project and retains metadata on surviving projects', async () => {
    const controller = module.createProjectsController(); const survivor = { id: 'b', path: '/b', label: 'B', icon: 'custom', defaultModel: { id: 'm' } };
    app.projects.set([{ id: 'a', path: '/a', name: 'A' }, { id: 'b', path: '/b', name: 'B' }]);
    handle = (_path, method, body) => method === 'PUT' ? body : { projects: [{ id: 'a', path: '/a', label: 'A' }, survivor], activeProjectId: 'a', unrelatedSetting: true };
    await controller.updateProjectCatalog('close', 'a');
    expect(request).toHaveBeenLastCalledWith('/api/config/settings', 'PUT', { projects: [survivor], activeProjectId: 'b' });
    expect(app.projects().map(project => project.id)).toEqual(['b']);
    expect(request.mock.calls.some(([path]) => path.includes('/archive'))).toBe(false);
  });
  it('reads Host worktree ranks and writes CAS order retaining absent paths', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' };
    let order = { projectDirectory: '/repo', revision: 3, orderedPaths: ['/b', '/missing', '/a'] };
    handle = (path, method, body) => {
      if (path.startsWith('/api/git/worktrees')) return [{ path: '/repo', name: 'main', branch: 'main' }, { path: '/a', name: 'a', branch: 'a' }, { path: '/b', name: 'b', branch: 'b' }];
      if (method === 'PUT') { order = { ...order, revision: 4, orderedPaths: (body as { orderedPaths: string[] }).orderedPaths }; return { revision: 4, projectDirectory: '/repo' }; }
      return order;
    };
    await controller.loadWorktrees(project);
    expect(controller.orderedWorktrees(project).map(tree => tree.path)).toEqual(['/b', '/a']);
    await controller.reorderWorktree(project, '/a', '/b');
    expect(request).toHaveBeenCalledWith('/api/yuri/message-queue/worktrees/order', 'PUT', { requestID: expect.any(String), projectDirectory: '/repo', expectedRevision: 3, orderedPaths: ['/a', '/b', '/missing'] });
    expect(controller.orderedWorktrees(project).map(tree => tree.path)).toEqual(['/a', '/b']);
  });
  it('rebases worktree order once on CAS conflict without optimistic data loss', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' };
    controller.worktrees.set({ '/repo': [{ path: '/a', name: 'a', branch: 'a' }, { path: '/b', name: 'b', branch: 'b' }] });
    let writes = 0;
    handle = (_path, method) => {
      if (method === 'PUT') { writes++; if (writes === 1) throw Object.assign(new Error('revision_conflict'), { status: 409 }); return { revision: 6 }; }
      return { projectDirectory: '/repo', revision: writes > 1 ? 6 : writes ? 5 : 3, orderedPaths: writes > 1 ? ['/b', '/a'] : ['/a', '/b'] };
    };
    await controller.reorderWorktree(project, '/b', '/a');
    expect(request.mock.calls.filter(([, method]) => method === 'PUT').map(([, , body]) => (body as { expectedRevision: number }).expectedRevision)).toEqual([3, 5]);
    expect(controller.orderedWorktrees(project).map(tree => tree.path)).toEqual(['/b', '/a']);
    handle = () => { throw new Error('offline'); }; await controller.reorderWorktree(project, '/a', '/b');
    expect(controller.orderedWorktrees(project).map(tree => tree.path)).toEqual(['/b', '/a']);
  });
  it('does not treat a failed dirty read as clean and fences an old Host status', async () => {
    const controller = module.createProjectsController(), tree = { path: '/tree', name: 'tree', branch: 'feature' };
    handle = () => ({ isClean: false }); await controller.loadWorktreeStatus(tree);
    handle = () => { throw new Error('offline'); }; expect(await controller.loadWorktreeStatus(tree)).toBeUndefined();
    expect(controller.dirty()['/tree']).toBe(true);
    const late = deferred(); handle = () => late.promise; const read = controller.loadWorktreeStatus(tree); advanceGeneration();
    late.resolve({ isClean: true }); await read; expect(controller.dirty()['/tree']).toBe(true);
  });
  it('archives all worktree root pages before removal and retries remote deletion independently', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' }, tree = { path: '/tree', name: 'tree', branch: 'refs/heads/feature' };
    let removed = false, remoteFails = true;
    handle = (path, method, body) => {
      if (path.startsWith('/api/session?')) return path.includes('parentID=null') ? { data: [row(path.includes('cursor=') ? 'second' : 'first', '/tree')], cursor: { next: path.includes('cursor=') ? null : 'opaque+=' } } : { data: [], cursor: {} };
      if (path.endsWith('/archive')) return { session: { ...row(path.includes('/first/') ? 'first' : 'second', '/tree'), time: { updated: 10, archived: (body as { archivedAt: number }).archivedAt } } };
      if (path.startsWith('/api/git/remote-branches')) { if (remoteFails) throw new Error('remote unavailable'); return { success: true }; }
      if (method === 'DELETE') { removed = true; return { success: true }; }
      if (path.includes('/message-queue/')) return { projectDirectory: '/repo', revision: 0, orderedPaths: [] };
      return removed ? [] : [tree];
    };
    await controller.loadWorktrees(project); expect(await controller.removeWorktree(project, tree, true, true)).toBe(true);
    const writes = request.mock.calls.filter(([, method]) => method === 'PUT' || method === 'DELETE');
    expect(writes.map(([path]) => path)).toEqual(['/api/yuri/sessions/second/archive', '/api/yuri/sessions/first/archive', '/api/git/worktrees?directory=%2Frepo', '/api/git/remote-branches?directory=%2Frepo']);
    expect(writes.at(-1)?.[2]).toEqual({ branch: 'feature' });
    expect(controller.remoteDeletes()).toHaveLength(1); expect(controller.worktrees()['/repo']).toEqual([]);
    remoteFails = false; const before = request.mock.calls.length; await controller.deleteRemote(project, tree);
    expect(request.mock.calls.slice(before)).toEqual([['/api/git/remote-branches?directory=%2Frepo', 'DELETE', { branch: 'feature' }]]);
    expect(controller.remoteDeletes()).toEqual([]);
  });
  it('never removes worktrees after incomplete session inventory or failed archive', async () => {
    const project = { id: 'p', name: 'Repo', path: '/repo' }, tree = { path: '/tree', name: 'tree', branch: 'feature' };
    const controller = module.createProjectsController();
    handle = () => { throw new Error('inventory unavailable'); }; await controller.removeWorktree(project, tree, false);
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
    handle = path => { if (path.startsWith('/api/session?')) return { data: path.includes('parentID=null') ? [row('root', '/tree')] : [], cursor: {} }; throw new Error('archive failed'); };
    await controller.removeWorktree(project, tree, false);
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
  });
  it('retains failed descendants when their archived parent disappears from deletion retry pages', async () => {
    let controller = module.createProjectsController();
    const project = { id: 'p', name: 'Repo', path: '/repo' }, tree = { path: '/tree', name: 'tree', branch: 'feature' };
    const root = row('root', '/tree'), child = { ...row('child', '/tree'), parentID: 'root' };
    let parentArchived = false, childFails = true, catalogFails = false;
    handle = (path, method, body) => {
      if (path.startsWith('/api/session?')) {
        if (catalogFails && path.includes('parentID=root')) throw new Error('child inventory unavailable');
        if (path.includes('parentID=null')) return { data: parentArchived ? [] : [root], cursor: {} };
        if (path.includes('parentID=root') && !path.includes('cursor=')) return { data: [], cursor: { next: 'child-page+=' } };
        return { data: path.includes('parentID=root') ? [child] : [], cursor: {} };
      }
      if (path.endsWith('/archive')) {
        const entity = path.includes('/child/') ? child : root;
        if (entity.id === 'child' && childFails) throw new Error('child archive failed');
        if (entity.id === 'root') parentArchived = true;
        return { session: { ...entity, time: { updated: 10, archived: (body as { archivedAt: number }).archivedAt } } };
      }
      if (method === 'DELETE') return { success: true };
      if (path.includes('/message-queue/')) return { projectDirectory: '/repo', revision: 0, orderedPaths: [] };
      return [];
    };
    await controller.removeWorktree(project, tree, false);
    expect(parentArchived).toBe(true);
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
    controller.dispose(); controller = module.createProjectsController();
    const beforeRetry = request.mock.calls.length;
    await controller.removeWorktree(project, tree, false);
    expect(request.mock.calls.slice(beforeRetry).some(([path, method]) => path.includes('/child/archive') && method === 'PUT')).toBe(true);
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
    expect(request.mock.calls.some(([path]) => path.includes('cursor=child-page%2B%3D'))).toBe(true);
    catalogFails = true; const beforeFailedInventory = request.mock.calls.length;
    await controller.removeWorktree(project, tree, false);
    expect(request.mock.calls.slice(beforeFailedInventory).some(([, method]) => method === 'PUT' || method === 'DELETE')).toBe(false);
    catalogFails = false;
    childFails = false;
    const beforeSuccess = request.mock.calls.length;
    expect(await controller.removeWorktree(project, tree, false)).toBe(true);
    const mutations = request.mock.calls.slice(beforeSuccess).filter(([, method]) => method === 'PUT' || method === 'DELETE');
    expect(mutations.map(([path]) => path)).toEqual(['/api/yuri/sessions/child/archive', '/api/git/worktrees?directory=%2Frepo']);
  });
  it('requires every worktree descendant page before any archive or deletion write', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' }, tree = { path: '/tree', name: 'tree', branch: 'feature' };
    handle = path => {
      if (path.includes('parentID=null')) return { data: [row('first', '/tree'), row('second', '/tree')], cursor: {} };
      if (path.includes('parentID=first')) return { data: [], cursor: {} };
      throw new Error('second subtree unavailable');
    };
    await controller.removeWorktree(project, tree, false);
    expect(request.mock.calls.some(([, method]) => method === 'PUT' || method === 'DELETE')).toBe(false);
    expect(controller.error()).toContain('second subtree unavailable');
  });
  it('blocks directory deletion when an archive response does not confirm archived state', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' }, tree = { path: '/tree', name: 'tree', branch: 'feature' };
    handle = path => path.startsWith('/api/session?') ? { data: path.includes('parentID=null') ? [row('root', '/tree')] : [], cursor: {} } : { session: row('root', '/tree') };
    await controller.removeWorktree(project, tree, false);
    expect(controller.error()).toContain('not confirmed');
    expect(request.mock.calls.some(([, method]) => method === 'DELETE')).toBe(false);
  });
  it('preserves worktrees and never deletes remote branches when local removal fails', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' }, tree = { path: '/tree', name: 'tree', branch: 'feature' };
    controller.worktrees.set({ '/repo': [tree] });
    handle = (path, method) => { if (path.startsWith('/api/session?')) return { data: [], cursor: {} }; if (method === 'DELETE') return { success: false }; throw new Error('unexpected request'); };
    expect(await controller.removeWorktree(project, tree, true, true)).toBeUndefined();
    expect(controller.worktrees()['/repo']).toEqual([tree]); expect(controller.remoteDeletes()).toEqual([]);
    expect(request.mock.calls.some(([path]) => path.includes('remote-branches'))).toBe(false);
  });
  it('does not continue destructive work on a newly selected Host', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' }, tree = { path: '/tree', name: 'tree', branch: 'feature' }, late = deferred();
    handle = (path, method) => path.startsWith('/api/session?') ? { data: [], cursor: {} } : method === 'DELETE' ? late.promise : [];
    const work = controller.removeWorktree(project, tree, true, true);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    advanceGeneration(); const before = request.mock.calls.length; late.resolve({ success: true }); await work;
    expect(request.mock.calls.length).toBe(before); expect(controller.remoteDeletes()).toEqual([]);
  });
  it('ignores old Host worktree ranks and preserves equal-revision references', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' };
    handle = () => ({ projectDirectory: '/repo', revision: 4, orderedPaths: ['/tree'] }); await controller.loadTreeOrder(project);
    const before = controller.treeOrders(); await controller.loadTreeOrder(project); expect(controller.treeOrders()).toBe(before);
    const late = deferred(); handle = () => late.promise; const work = controller.loadTreeOrder(project); advanceGeneration();
    late.resolve({ projectDirectory: '/repo', revision: 9, orderedPaths: ['/stale'] }); await expect(work).rejects.toThrow('page_operation_stale');
    expect(controller.treeOrders()).toBe(before);
  });
  it('shares concurrent worktree order reads instead of multiplying event traffic', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' }, late = deferred();
    handle = () => late.promise;
    const reads = Array.from({ length: 50 }, () => controller.loadTreeOrder(project));
    expect(request).toHaveBeenCalledTimes(1);
    late.resolve({ projectDirectory: '/repo', revision: 1, orderedPaths: [] }); await Promise.all(reads);
    expect(controller.treeOrders()['/repo']?.revision).toBe(1);
  });
  it('reconciles an ACKed worktree drop with reads only after its follow-up GET fails', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' };
    controller.worktrees.set({ '/repo': [{ path: '/a', name: 'a', branch: 'a' }, { path: '/b', name: 'b', branch: 'b' }] });
    let writes = 0, recover = false;
    handle = (_path, method) => {
      if (method === 'PUT') { writes++; return { projectDirectory: '/repo', revision: 2 }; }
      if (writes && !recover) throw new Error('ACK read failed');
      return { projectDirectory: '/repo', revision: writes ? 2 : 1, orderedPaths: writes ? ['/b', '/a'] : ['/a', '/b'] };
    };
    await controller.reorderWorktree(project, '/b', '/a');
    expect(controller.error()).toContain('ACK read failed'); expect(writes).toBe(1);
    expect(controller.orderedWorktrees(project).map(row => row.path)).toEqual(['/a', '/b']);
    recover = true; const before = request.mock.calls.length; await controller.loadTreeOrder(project);
    expect(request.mock.calls.slice(before).every(([, method]) => method === undefined)).toBe(true);
    expect(writes).toBe(1); expect(controller.orderedWorktrees(project).map(row => row.path)).toEqual(['/b', '/a']);
  });
  it('does not turn a queued old-Host order event into a new-Host read', async () => {
    const controller = module.createProjectsController();
    controller.worktrees.set({ '/repo': [] });
    emit({ key: 'global', data: JSON.stringify({ type: 'yuri:message-queue-changed', data: {} }) });
    app.connection.set({ id: 'different-host' });
    const before = request.mock.calls.length; await vi.advanceTimersByTimeAsync(120);
    expect(request.mock.calls).toHaveLength(before);
  });
  it('a hidden desktop owner skips per-project rank fanout, while the iOS default remains enabled', async () => {
    let detail = false;
    const controller = module.createProjectsController({ detailReads: () => detail });
    controller.worktrees.set({ '/repo': [] });
    handle = path => path.includes('worktrees/order') ? { projectDirectory: '/repo', revision: 1, orderedPaths: [] } : path === '/api/session-folders/order' ? { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} } : { available: true, directories: [], pinnedSessionIds: [] };
    emit({ key: 'global', data: JSON.stringify({ type: 'yuri:message-queue-changed', data: {} }) });
    await vi.advanceTimersByTimeAsync(120);
    expect(request.mock.calls.some(([path]) => path.includes('worktrees/order'))).toBe(false);
    detail = true;
    emit({ key: 'global', data: JSON.stringify({ type: 'yuri:message-queue-changed', data: {} }) });
    await vi.advanceTimersByTimeAsync(120);
    expect(request.mock.calls.filter(([path]) => path.includes('worktrees/order'))).toHaveLength(1);
  });
  it('rejects cross-directory and pinned-to-unpinned drop identities without writes', async () => {
    const controller = module.createProjectsController();
    app.sessions.set([{ id: 'a', title: 'a', directory: '/repo', updated: 10 }, { id: 'b', title: 'b', directory: '/other', updated: 20 }]);
    controller.pins.set(['a']);
    await controller.reorder('/repo', 'a', 'b'); await controller.reorder('__pinned__', 'a', 'b');
    expect(request.mock.calls.some(([, method]) => method === 'POST')).toBe(false);
  });
  it('persists the exact visible body subset, retaining collapsed ranks and full activity like Web', async () => {
    const controller = module.createProjectsController(), ids = ['a', 'b', 'c', 'd', 'e'];
    app.sessions.set(ids.map((id, i) => ({ id, title: id, directory: '/repo', updated: 50 - i })));
    const activity = Object.fromEntries(ids.map((id, i) => [id, 50 - i]));
    handle = (_path, _method, body) => ({ revision: 1, sessionOrderByScope: { '/repo': body ? (body as { order: string[] }).order : ids }, sessionOrderActivityByScope: { '/repo': activity } });
    await controller.reorder('/repo', 'a', 'e', ['a', 'b', 'e']);
    expect(request).toHaveBeenLastCalledWith('/api/session-folders/order', 'POST', { scopeKey: '/repo', order: ['b', 'e', 'a', 'c', 'd'], activity, onlyIfAbsent: false });
  });
  it('bounds visible-subset validation and hidden-rank preservation at a 500-session drop', async () => {
    const controller = module.createProjectsController(), ids = Array.from({ length: 500 }, (_, i) => `row-${i}`);
    let identityReads = 0;
    const rows = ids.map((id, i) => Object.defineProperty({ id, title: id, directory: '/repo', updated: 1000 - i, pinned: false, archived: false }, 'id', { enumerable: true, get: () => { identityReads++; return id; } }));
    controller.buckets.set({ '/repo': { sessions: rows, cursor: null, loaded: true, hasMore: false } });
    const baseline = Object.fromEntries(ids.map((id, i) => [id, 1000 - i]));
    handle = (_path, _method, body) => ({ revision: 1, sessionOrderByScope: { '/repo': body ? (body as { order: string[] }).order : ids }, sessionOrderActivityByScope: { '/repo': baseline } });
    const visible = ids.filter((_, i) => i % 2 === 0 || i === 499);
    await controller.reorder('/repo', 'row-0', 'row-499', visible);
    expect(request.mock.calls).toHaveLength(2); expect(identityReads).toBeLessThan(20_000);
    expect(request.mock.calls.filter(([, method]) => method === 'POST')).toHaveLength(1);
  });
  it('retires the real page-operation lane while covered and only reads on same-Host reactivation', async () => {
    let active = true;
    const controller = module.createProjectsController(() => active), late = deferred();
    handle = () => late.promise; const read = controller.loadDirectory('/repo');
    active = false; effects.forEach(work => work());
    late.resolve({ data: [row('covered')], cursor: {} }); await read;
    expect(controller.sessions()).toEqual([]); expect(controller.pending()).toEqual([]);
    active = true; effects.forEach(work => work());
    handle = path => path === '/api/session/active' ? {} : path === '/api/session-folders/order' ? { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} } : { available: true, directories: [], pinnedSessionIds: [] };
    const before = request.mock.calls.length; await controller.refresh();
    expect(controller.current()).toBe(true); expect(request.mock.calls.slice(before).every(([, method]) => method === undefined)).toBe(true);
  });
  it('writes the narrow manual title intent before PATCH and fences the second write on Host switch', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = path => path.endsWith('/metadata') ? { metadata: { yuri: {} } } : null;
    const before = request.mock.calls.length; await controller.mutate(root, 'rename', ' Changed ');
    expect(request.mock.calls.slice(before)).toEqual([
      ['/api/yuri/sessions/head/metadata', 'PUT', { directory: '/repo', patch: { yuri: { titleAuthority: { sessionID: 'head', title: 'Changed', revision: expect.any(String), source: 'manual' }, titleRefresh: { activityUpdatedAt: 10, isGenerating: null, requestedAt: null, lastError: null, failedAt: null } } } }],
      ['/api/session/head', 'PATCH', { title: 'Changed' }],
    ]);
    const late = deferred(); handle = () => late.promise; const started = request.mock.calls.length;
    const work = controller.mutate(root, 'rename', 'Old Host'); advanceGeneration(); late.resolve({ metadata: {} }); await work;
    expect(request.mock.calls.slice(started)).toHaveLength(1);
  });
  it('does not PATCH after failed title-intent writes and keeps authoritative activity ranks', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = () => { throw new Error('intent failed'); }; const before = request.mock.calls.length;
    await controller.mutate(root, 'rename', 'Changed');
    expect(controller.sessions()[0]?.title).toBe('head'); expect(controller.sessions()[0]?.activity).toBe(10);
    expect(request.mock.calls.slice(before).some(([, method]) => method === 'PATCH')).toBe(false);
  });
  it('keeps partially archived roots as explicit retry actions even after they disappear from the visible catalog', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    let fail = true, parentArchived = false;
    handle = (path, _method, body) => {
      if (path.startsWith('/api/session?')) return { data: path.includes('parentID=head') ? [{ ...row('child'), parentID: 'head' }] : [], cursor: {} };
      if (path.includes('/child/') && fail) throw new Error('child failed');
      if (path.includes('/head/')) parentArchived = true;
      return { session: { ...row(path.includes('/head/') ? 'head' : 'child'), ...(path.includes('/child/') ? { parentID: 'head' } : {}), time: { updated: 10, archived: (body as { archivedAt: number }).archivedAt } } };
    };
    await controller.mutate(root, 'archive'); expect(parentArchived).toBe(true); expect(controller.sessions()).toEqual([]);
    expect(controller.archiveFailures().map(row => row.id)).toEqual(['head']);
    fail = false; const before = request.mock.calls.length; await controller.mutate(controller.archiveFailures()[0]!, 'archive');
    expect(controller.archiveFailures()).toEqual([]);
    expect(request.mock.calls.slice(before).filter(([, method]) => method === 'PUT').map(([path]) => path)).toEqual(['/api/yuri/sessions/child/archive']);
  });
  it('never removes a session on an archive response that did not confirm archival', async () => {
    const controller = module.createProjectsController(); await controller.refresh(); const root = controller.sessions()[0]!;
    handle = path => path.startsWith('/api/session?') ? { data: [], cursor: {} } : { session: row('head') };
    await controller.mutate(root, 'archive'); expect(controller.sessions()).toHaveLength(1); expect(controller.undoRows()).toEqual([]);
    expect(controller.error()).toContain('not confirmed'); expect(controller.archiveFailures()).toHaveLength(1);
  });
  it('does not publish late search results after the search sheet closes', async () => {
    const controller = module.createProjectsController(), late = deferred(); handle = () => late.promise;
    const work = controller.search('old'); controller.cancelSearch(); late.resolve({ data: [row('late')], cursor: {} }); await work;
    expect(controller.searchResults()).toEqual([]); expect(controller.searching()).toBe(false);
  });
  it('gates the branch entry on real repository authority and preserves unknown on probe failure', async () => {
    const controller = module.createProjectsController(), project = { id: 'p', name: 'Repo', path: '/repo' };
    handle = () => ({ isGitRepository: true }); expect(await controller.loadRepository(project)).toBe(true);
    expect(request).toHaveBeenLastCalledWith('/api/git/check?directory=%2Frepo');
    handle = () => ({ isGitRepository: false }); expect(await controller.loadRepository(project)).toBe(false);
    handle = () => { throw new Error('probe unavailable'); }; expect(await controller.loadRepository(project)).toBeUndefined(); expect(controller.error()).toContain('probe unavailable');
  });
});
