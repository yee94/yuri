import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as model from './model';
import * as core from './projects-search-core';
import { createProjectsScopeVM } from './tests/projects-scope-vm';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'projects-search.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2023 } }).outputText;
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let module: typeof import('./projects-search'), scope: ReturnType<typeof createProjectsScopeVM>;
let handle: (path: string) => unknown, request: ReturnType<typeof vi.fn>;
const session = { id: 's', title: 'Title', location: { directory: '/remote' }, time: { updated: 1 } };
const message = { sessionID: 's', messageID: 'm', title: 'Title', directory: '/remote', role: 'assistant', snippet: 'Body hit', createdAt: 1 };
beforeEach(() => {
  handle = path => path.startsWith('/api/session?') ? { data: [session], cursor: {} } : path.includes('content-search') ? { hits: [message] } : { data: [{ path: 'src/file.ts' }] };
  request = vi.fn(async (path: string) => handle(path));
  scope = createProjectsScopeVM(async (name, input) => { if (name !== 'runtime.request') throw new Error(name); return { status: 200, body: await request(input.path as string) }; });
  const exports = {}, imports: Record<string, unknown> = { nsh: scope.native, 'nsh/base': {}, './Icon': {}, './i18n': { t: (key: string) => key }, './model': model, './state': scope.state, './page-operations': scope.operations, './projects-search-core': core };
  vm.runInNewContext(compiled, { exports, require: (id: string) => { if (!(id in imports)) throw new Error(id); return imports[id]; }, console }); module = exports as typeof module;
});
afterEach(() => scope?.dispose());
describe('native global project search (no NSH engine)', () => {
  it('uses the captured production request lease and cannot dispatch while root readiness is withdrawn', async () => {
    const controller = module.createProjectsSearchController(() => '/repo');
    scope.context.runtimeReady.set(false); scope.flush(); await controller.search('body');
    expect(request).not.toHaveBeenCalled(); expect(controller.current()).toBe(false);
    scope.context.runtimeReady.set(true); scope.flush(); await controller.search('body');
    expect(request).toHaveBeenCalledTimes(3); expect(controller.current()).toBe(true);
    const lane = scope.state.captureHostOperation();
    scope.state.app.runtimeScope.set({ hostID: 'projects-fixture', lease: 'replacement-lease' });
    await expect(lane.request('/api/session?parentID=null&limit=30&order=desc')).rejects.toThrow('host_operation_stale');
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('rejects late old-Host results and permanently retires the old display even when that Host is selected again', async () => {
    const controller = module.createProjectsSearchController(() => '/repo'), late = deferred(); handle = () => late.promise;
    const work = controller.search('old'); expect(request).toHaveBeenCalledTimes(3);
    const previous = scope.state.app.connection(), lease = scope.state.app.runtimeScope();
    scope.state.app.connection.set({ ...previous, id: 'other-host' });
    scope.state.app.runtimeScope.set({ hostID: 'other-host', lease: 'other-lease' }); scope.advanceGeneration(); scope.flush();
    late.resolve({ data: [session], hits: [message] }); await work;
    expect(controller.sessions()).toEqual([]); expect(controller.messages()).toEqual([]); expect(controller.files()).toEqual([]);
    scope.state.app.connection.set(previous); scope.state.app.runtimeScope.set(lease); scope.advanceGeneration(); scope.flush();
    await controller.search('old'); expect(request).toHaveBeenCalledTimes(3); expect(controller.current()).toBe(false);
  });
  it('searches sessions and content globally and files only in the explicit Focus', async () => {
    const controller = module.createProjectsSearchController(() => '/focused project'); await controller.search(' body ');
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/api/session?parentID=null&limit=30&order=desc&search=body', '/api/yuri/content-search?q=body&limit=30', '/api/fs/find?location%5Bdirectory%5D=%2Ffocused%20project&query=body&limit=40&type=file']);
    expect(controller.sessions()[0]?.directory).toBe('/remote'); expect(controller.messages()[0]?.messageID).toBe('m'); expect(controller.files()[0]?.directory).toBe('/focused project');
  });
  it('does not search files without Focus or scan every registered project', async () => {
    const controller = module.createProjectsSearchController(() => undefined); await controller.search('body');
    expect(request).toHaveBeenCalledTimes(2); expect(controller.files()).toEqual([]);
    const before = request.mock.calls.length; await controller.search('');
    expect(request.mock.calls.slice(before)).toEqual([['/api/session?parentID=null&limit=30&order=desc']]); expect(controller.messages()).toEqual([]);
  });
  it('preserves successful domains and previous same-query snapshots on partial failure', async () => {
    const controller = module.createProjectsSearchController(() => '/repo'); await controller.search('body'); const previous = controller.messages();
    handle = path => { if (path.includes('content-search')) throw new Error('content offline'); return path.startsWith('/api/session?') ? { data: [{ ...session, title: 'Updated' }] } : { data: [] }; };
    await controller.search('body'); expect(controller.messages()).toBe(previous); expect(controller.sessions()[0]?.title).toBe('Updated'); expect(controller.files()).toEqual([]);
    expect(controller.errors().messages).toContain('content offline'); expect(controller.pending()).toEqual([]);
  });
  it('keeps malformed authorities as errors, not authoritative empty results', async () => {
    const controller = module.createProjectsSearchController(() => '/repo'); await controller.search('body');
    handle = () => ({}); await controller.search('body');
    expect(controller.sessions()).toHaveLength(1); expect(controller.messages()).toHaveLength(1); expect(controller.files()).toHaveLength(1);
    expect(Object.keys(controller.errors()).sort()).toEqual(['files', 'messages', 'sessions']);
  });
  it('drops only old Focus file snapshots on scope changes, including a failed new scope', async () => {
    let focus: string | undefined = '/repo';
    const controller = module.createProjectsSearchController(() => focus); await controller.search('body');
    const sessions = controller.sessions(), messages = controller.messages();
    focus = '/other'; handle = () => { throw new Error('offline'); };
    await controller.search('body');
    expect(controller.sessions()).toBe(sessions); expect(controller.messages()).toBe(messages); expect(controller.files()).toEqual([]);
    focus = undefined; await controller.search('body'); expect(controller.files()).toEqual([]);
    expect(request.mock.calls.filter(([path]) => path.includes('/fs/find'))).toHaveLength(2);
  });
  it('new query/Host failures never reuse the prior authority, and dispose rejects late results', async () => {
    const controller = module.createProjectsSearchController(() => '/repo'); await controller.search('body');
    handle = () => { throw new Error('offline'); }; await controller.search('new');
    expect(controller.sessions()).toEqual([]); expect(controller.messages()).toEqual([]); expect(controller.files()).toEqual([]);
    scope.advanceGeneration(); await controller.search('new'); expect(controller.sessions()).toEqual([]);
    scope.flush();
    const late = deferred(); handle = () => late.promise;
    const before = request.mock.calls.length;
    const work = controller.search('last'); expect(request.mock.calls.length - before).toBe(3); controller.dispose(); late.resolve({ data: [session], hits: [message] }); await work;
    expect(controller.sessions()).toEqual([]); expect(controller.messages()).toEqual([]);
  });
  it('ignores stale queries, cancelled queries, old Host results and an old Focus file response', async () => {
    const controller = module.createProjectsSearchController(() => '/repo'), late = deferred(); handle = () => late.promise;
    const old = controller.search('old'); controller.cancel();
    late.resolve({ data: [session], hits: [message] }); await old; expect(controller.sessions()).toEqual([]); expect(controller.messages()).toEqual([]);
    const second = deferred(); handle = () => second.promise; const work = controller.search('another'); scope.advanceGeneration();
    second.resolve({ data: [session], hits: [message] }); await work; expect(controller.sessions()).toEqual([]);
    let focus = '/repo'; const scoped = module.createProjectsSearchController(() => focus), file = deferred();
    handle = path => path.includes('/fs/find') ? file.promise : path.includes('content-search') ? { hits: [] } : { data: [] };
    const search = scoped.search('file'); focus = '/new'; file.resolve({ data: [{ path: 'old.ts' }] }); await search; expect(scoped.files()).toEqual([]);
  });
});
