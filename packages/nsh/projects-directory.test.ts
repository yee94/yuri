import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as model from './model';
import { createProjectIdFromPath } from '../ui/src/lib/projectId';
import { normalizePath } from '../ui/src/lib/pathNormalization';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'projects-directory.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2023 } }).outputText;
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let module: typeof import('./projects-directory'), generation: number;
let handle: (path: string, method?: string, body?: unknown) => unknown;
let request: ReturnType<typeof vi.fn>;
let app: { projects: ReturnType<typeof signal<model.Project[]>> };
beforeEach(() => {
  generation = 1; app = { projects: signal([]) };
  handle = (path, method, body) => path === '/api/fs/home' ? { home: '/workspace' } : path.startsWith('/api/fs/list') ? { entries: [] } : method === 'PUT' ? body : { projects: [] };
  request = vi.fn(async (...args: [string, string?, unknown?]) => handle(...args));
  const exports = {}, imports: Record<string, unknown> = {
    nsh: { signal, computed: (work: () => unknown) => work, cleanup: () => {} }, 'nsh/base': {}, './Icon': {}, './i18n': { t: (key: string) => key }, './model': model,
    '../ui/src/lib/projectId': { createProjectIdFromPath }, '../ui/src/lib/pathNormalization': { normalizePath }, './runtime': { request }, './state': { app, epoch: () => generation },
  };
  vm.runInNewContext(compiled, { exports, require: (id: string) => { if (!(id in imports)) throw new Error(id); return imports[id]; }, console });
  module = exports as typeof module;
});

describe('native project directory acquisition (no NSH engine)', () => {
  it('canonicalizes repeated separators for target, browse parent and Host home without deleting repeated directory names', () => {
    expect(module.projectDirectoryLocation('/workspace//team///new-repo', '/workspace')).toEqual({ target: '/workspace/team/new-repo', parent: '/workspace/team', filter: 'new-repo' });
    expect(module.projectDirectoryLocation('/workspace//team///', '/workspace')).toEqual({ target: '/workspace/team', parent: '/workspace/team', filter: '' });
    expect(module.projectDirectoryLocation('~/team//new-repo', '/workspace//')).toEqual({ target: '/workspace/team/new-repo', parent: '/workspace/team', filter: 'new-repo' });
    expect(module.projectDirectoryLocation('/workspace//workspace/new-repo', '/workspace').target).toBe('/workspace/workspace/new-repo');
    expect(module.projectDirectoryLocation('C:\\workspace\\team\\new-repo', '/workspace')).toEqual({ target: 'C:/workspace/team/new-repo', parent: 'C:/workspace/team', filter: 'new-repo' });
    expect(module.projectDirectoryLocation('\\\\server\\share\\team\\new-repo', '/workspace')).toEqual({ target: '//server/share/team/new-repo', parent: '//server/share/team', filter: 'new-repo' });
  });
  it('sends canonical clone and registry paths and reuses the checkpoint across equivalent separator spellings', async () => {
    const controller = module.createProjectDirectoryController(); await controller.initialize(); controller.remote.set('https://repo.example/team/repo');
    let fail = true;
    handle = (path, method, body) => path === '/api/fs/clone' ? { success: true, path: '/workspace//new-repo/' } : method === 'PUT' ? fail ? Promise.reject(new Error('registry unavailable')) : body : { projects: [] };
    await controller.add('/workspace//new-repo/', { clone: true });
    expect(controller.prepared()?.path).toBe('/workspace/new-repo');
    fail = false; const added = await controller.add('/workspace/new-repo', { clone: true });
    expect(added?.path).toBe('/workspace/new-repo'); expect(added?.id).toBe(createProjectIdFromPath('/workspace/new-repo'));
    expect(request.mock.calls.filter(([path]) => path === '/api/fs/clone')).toEqual([['/api/fs/clone', 'POST', { remoteUrl: 'https://repo.example/team/repo', destinationPath: '/workspace/new-repo', gitIdentityId: null }]]);
  });
  it('resolves Host home and filters all folders without reading the phone or re-fetching per leaf character', async () => {
    const controller = module.createProjectDirectoryController();
    handle = path => path === '/api/fs/home' ? { home: '/workspace' } : { entries: [{ name: 'repo', path: '/workspace/repo', isDirectory: true }, { name: '.hidden', path: '/workspace/.hidden', isDirectory: true }, { name: 'file', path: '/workspace/file', isDirectory: false }] };
    await controller.initialize(); expect(controller.location().parent).toBe('/workspace');
    expect(controller.visibleEntries().map(row => row.name)).toEqual(['repo']);
    controller.edit('~/r'); controller.edit('~/re'); expect(request).toHaveBeenCalledTimes(2);
    controller.edit('~/.'); expect(controller.visibleEntries().map(row => row.name)).toEqual(['.hidden']);
    controller.navigate('/workspace/repo'); expect(controller.location().parent).toBe('/workspace/repo');
    controller.parent(); expect(controller.input()).toBe('/workspace/');
  });
  it('retains the valid folder snapshot on failure and never treats a 403 as permission to mkdir', async () => {
    const controller = module.createProjectDirectoryController(); await controller.initialize();
    controller.entries.set([{ name: 'existing', path: '/workspace/existing' }]);
    handle = () => { throw Object.assign(new Error('denied'), { status: 403 }); };
    await controller.browse(true); expect(controller.entries()).toHaveLength(1); expect(controller.missingPath()).toBe('');
    expect(await controller.add('/workspace/new')).toBeUndefined();
    expect(request.mock.calls.some(([, method]) => method === 'POST')).toBe(false);
    expect(controller.error()).toContain('denied');
  });
  it('adds only to a fresh Host registry, preserving all existing project metadata and deriving the Web ID', async () => {
    const controller = module.createProjectDirectoryController(); await controller.initialize();
    const survivor = { id: 'survivor', path: '/other', label: 'Other', icon: 'custom', defaultModel: { id: 'model' } };
    handle = (path, method, body) => path.startsWith('/api/fs/list') ? { entries: [] } : method === 'PUT' ? body : { projects: [survivor], activeProjectId: 'survivor', unrelated: true };
    const added = await controller.add('/workspace/repo');
    expect(added?.id).toBe(createProjectIdFromPath('/workspace/repo'));
    expect(request).toHaveBeenLastCalledWith('/api/config/settings', 'PUT', { projects: [expect.objectContaining({ id: added!.id, path: '/workspace/repo' }), survivor], activeProjectId: added!.id });
    expect(app.projects().map(row => row.id)).toEqual([added!.id, 'survivor']);
  });
  it('creates only after a confirmed missing target and keeps a successful mkdir checkpoint when registry writing fails', async () => {
    const controller = module.createProjectDirectoryController(); await controller.initialize();
    let writesFail = true;
    handle = (path, method, body) => {
      if (path.startsWith('/api/fs/list')) throw Object.assign(new Error('missing'), { status: 404 });
      if (path === '/api/fs/mkdir') return { success: true, path: '/workspace/new' };
      if (method === 'PUT') { if (writesFail) throw new Error('registry unavailable'); return body; }
      return { projects: [] };
    };
    expect(await controller.add('/workspace/new')).toBeUndefined(); expect(controller.prepared()?.path).toBe('/workspace/new');
    expect(controller.pending()).toBe(false); expect(app.projects()).toEqual([]);
    writesFail = false; expect((await controller.add('/workspace/new'))?.path).toBe('/workspace/new');
    expect(request.mock.calls.filter(([path]) => path === '/api/fs/mkdir')).toHaveLength(1);
  });
  it('never clones twice after a confirmed clone and a failed settings write; retry uses the exact identity and target', async () => {
    const controller = module.createProjectDirectoryController(); await controller.initialize(); controller.remote.set('ssh://git@repo.example/team/repo'); controller.identity.set('profile');
    let fail = true;
    handle = (path, method, body) => path === '/api/fs/clone' ? { success: true, path: '/workspace/repo' } : method === 'PUT' ? fail ? Promise.reject(new Error('write failed')) : body : { projects: [] };
    await controller.add('/workspace/repo', { clone: true }); expect(controller.error()).toContain('write failed');
    fail = false; expect((await controller.add('/workspace/repo', { clone: true }))?.path).toBe('/workspace/repo');
    expect(request.mock.calls.filter(([path]) => path === '/api/fs/clone')).toEqual([['/api/fs/clone', 'POST', { remoteUrl: 'ssh://git@repo.example/team/repo', destinationPath: '/workspace/repo', gitIdentityId: 'profile' }]]);
  });
  it('deduplicates existing paths and never makes quick add create a vanished folder', async () => {
    const controller = module.createProjectDirectoryController(); await controller.initialize();
    const existing = { id: 'legacy', path: '/workspace/repo', label: 'Custom', color: 'info' };
    handle = (path, method, body) => path.startsWith('/api/fs/list') ? { entries: [] } : method === 'PUT' ? body : { projects: [existing] };
    expect((await controller.add('/workspace/repo'))?.id).toBe('legacy'); expect(app.projects()).toHaveLength(1);
    handle = () => { throw Object.assign(new Error('missing'), { status: 404 }); };
    const before = request.mock.calls.length; await controller.add('/workspace/vanished', { quick: true });
    expect(request.mock.calls.slice(before).some(([, method]) => method === 'POST')).toBe(false);
  });
  it('rejects malformed confirmation without publishing a fictional project', async () => {
    const controller = module.createProjectDirectoryController(); await controller.initialize();
    handle = (path, method) => path.startsWith('/api/fs/list') ? { entries: [] } : method === 'PUT' ? { projects: [] } : { projects: [] };
    expect(await controller.add('/workspace/repo')).toBeUndefined(); expect(app.projects()).toEqual([]); expect(controller.prepared()).not.toBeNull();
    expect(controller.error()).toContain('not confirmed');
  });
  it('fences old Host clone completion before registry writes and clears the checkpoint on rebind', async () => {
    const controller = module.createProjectDirectoryController(); await controller.initialize(); controller.remote.set('https://repo.example/repo');
    const late = deferred(); handle = () => late.promise; const work = controller.add('/workspace/repo', { clone: true });
    generation++; late.resolve({ success: true, path: '/workspace/repo' }); await work;
    expect(request.mock.calls.filter(([path]) => path === '/api/config/settings')).toEqual([]); expect(app.projects()).toEqual([]);
    handle = path => path === '/api/fs/home' ? { home: '/new-home' } : { entries: [] }; await controller.initialize();
    expect(controller.home()).toBe('/new-home'); expect(controller.prepared()).toBeNull(); expect(controller.remote()).toBe('');
  });
  it('ignores stale browse completion and every write after disposal', async () => {
    const controller = module.createProjectDirectoryController(); await controller.initialize(); const late = deferred();
    handle = path => path.includes('first') ? late.promise : { entries: [{ name: 'new', path: '/second/new', isDirectory: true }] };
    controller.input.set('/first/'); const first = controller.browse(); controller.input.set('/second/'); await controller.browse();
    late.resolve({ entries: [{ name: 'old', path: '/first/old', isDirectory: true }] }); await first;
    expect(controller.entries()[0]?.name).toBe('new'); controller.dispose(); const before = request.mock.calls.length;
    await controller.add('/workspace/repo'); expect(request.mock.calls).toHaveLength(before);
  });
  it('coalesces 50 edits in one pending parent directory and rejects a late response after returning to the previous directory', async () => {
    const controller = module.createProjectDirectoryController(); await controller.initialize(); const late = deferred(); handle = () => late.promise;
    const before = request.mock.calls.length;
    controller.edit('/another/r');
    for (let index = 0; index < 50; index++) controller.edit('/another/repo' + index);
    expect(request.mock.calls.length - before).toBe(1);
    controller.navigate('/workspace'); expect(controller.loading()).toBe(false);
    late.resolve({ entries: [{ name: 'late', path: '/another/late', isDirectory: true }] });
    for (let index = 0; index < 5; index++) await Promise.resolve();
    expect(controller.listedPath()).toBe('/workspace'); expect(controller.entries()).toEqual([]);
  });
});
