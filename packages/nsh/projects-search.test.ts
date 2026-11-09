import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as model from './model';
import * as core from './projects-search-core';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'projects-search.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2023 } }).outputText;
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let module: typeof import('./projects-search'), generation: number;
let handle: (path: string) => unknown, request: ReturnType<typeof vi.fn>;
const session = { id: 's', title: 'Title', location: { directory: '/remote' }, time: { updated: 1 } };
const message = { sessionID: 's', messageID: 'm', title: 'Title', directory: '/remote', role: 'assistant', snippet: 'Body hit', createdAt: 1 };
beforeEach(() => {
  generation = 1;
  handle = path => path.startsWith('/api/session?') ? { data: [session], cursor: {} } : path.includes('content-search') ? { hits: [message] } : { data: [{ path: 'src/file.ts' }] };
  request = vi.fn(async (path: string) => handle(path));
  const connection = { id: 'search-controller-test', url: 'https://host.example' };
  const exports = {}, imports: Record<string, unknown> = {
    nsh: { signal, cleanup: () => {}, effect: (work: () => void) => work(), untracked: (work: () => unknown) => work(), lifecycle: () => 'active' },
    'nsh/base': {}, './Icon': {}, './i18n': { t: (key: string) => key }, './model': model, './runtime': { request },
    './state': { epoch: () => generation, app: { connection: () => connection, runtimeScope: () => null }, captureHostOperation: () => {
      const captured = generation;
      return { generation: captured, scope: null, current: () => captured === generation, request: (path: string) => request(path) };
    } }, './projects-search-core': core,
  };
  const pageOperations = {};
  const operationSource = ts.transpileModule(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'page-operations.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  vm.runInNewContext(operationSource, { exports: pageOperations, require: (id: string) => { if (!(id in imports)) throw new Error(id); return imports[id]; } });
  imports['./page-operations'] = pageOperations;
  vm.runInNewContext(compiled, { exports, require: (id: string) => { if (!(id in imports)) throw new Error(id); return imports[id]; }, console }); module = exports as typeof module;
});
describe('native global project search (no NSH engine)', () => {
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
    generation++; await controller.search('new'); expect(controller.sessions()).toEqual([]);
    const late = deferred(); handle = () => late.promise;
    const work = controller.search('last'); controller.dispose(); late.resolve({ data: [session], hits: [message] }); await work;
    expect(controller.sessions()).toEqual([]); expect(controller.messages()).toEqual([]);
  });
  it('ignores stale queries, cancelled queries, old Host results and an old Focus file response', async () => {
    const controller = module.createProjectsSearchController(() => '/repo'), late = deferred(); handle = () => late.promise;
    const old = controller.search('old'); controller.cancel();
    late.resolve({ data: [session], hits: [message] }); await old; expect(controller.sessions()).toEqual([]); expect(controller.messages()).toEqual([]);
    const second = deferred(); handle = () => second.promise; const work = controller.search('another'); generation++;
    second.resolve({ data: [session], hits: [message] }); await work; expect(controller.sessions()).toEqual([]);
    let focus = '/repo'; const scoped = module.createProjectsSearchController(() => focus), file = deferred();
    handle = path => path.includes('/fs/find') ? file.promise : path.includes('content-search') ? { hits: [] } : { data: [] };
    const search = scoped.search('file'); focus = '/new'; file.resolve({ data: [{ path: 'old.ts' }] }); await search; expect(scoped.files()).toEqual([]);
  });
});
