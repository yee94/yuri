import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { searchFilesFrom, searchMessagesFrom, searchSessionsFrom } from './projects-search-core';
import * as core from './projects-search-core';
import * as model from './model';
import { withProjectsSearchFixture } from './tests/projects-search-runner.js';
import { createProjectsScopeVM } from './tests/projects-scope-vm';

type Host = { call(name: string, input: unknown): { status: number; body: unknown } };
type Fixture = { directory: string; entry: string; host: string };
const root = path.dirname(fileURLToPath(import.meta.url));
function evaluateBundle(filename: string) {
  const context = vm.createContext({});
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  const bundle = readFileSync(filename, 'utf8');
  const syntax = ts.createSourceFile(filename, bundle, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  expect(syntax.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier)).toBe(false);
  const compiled = ts.transpileModule(bundle, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }, reportDiagnostics: true });
  expect(compiled.diagnostics ?? []).toEqual([]);
  const exports: Record<string, unknown> = {};
  // Evaluate the exact standalone artifact without require/import resolver or browser polyfills.
  vm.runInContext(`(function(exports) { ${compiled.outputText}\n})`, context)(exports);
  return exports;
}
function isolatedHost() {
  return withProjectsSearchFixture(root, (fixture: Fixture) => (evaluateBundle(fixture.host).createHost as () => Host)());
}
const audit = (host: Host) => host.call('projectsSearch.fixture.audit', {}) as unknown as { calls: Array<{ path: string; query?: string; directory?: string }>; rejected: number };
const expectedHost = { hostID: 'search-fixture', lease: 'projects-fixture-lease' };
const request = (host: Host, path: string, method = 'GET') => host.call('runtime.request', { path, method, expectedHost });
function controllerFor(host: Host, focus: () => string | undefined) {
  const source = ts.transpileModule(readFileSync(path.join(root, 'projects-search.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React } }).outputText;
  const scope = createProjectsScopeVM((name, input) => host.call(name, input), 'search-fixture', host.call('connection.list', {}));
  const imports: Record<string, unknown> = {
    nsh: scope.native, 'nsh/base': {}, './Icon': {}, './i18n': {}, './model': model, './projects-search-core': core,
    './state': scope.state, './page-operations': scope.operations,
  };
  const pageOperations = {};
  const operationSource = ts.transpileModule(readFileSync(path.join(root, 'page-operations.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  vm.runInNewContext(operationSource, { exports: pageOperations, require: (id: string) => { if (!(id in imports)) throw new Error('Unexpected operation dependency: ' + id); return imports[id]; } });
  imports['./page-operations'] = pageOperations;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(source, { exports, require: (id: string) => { if (!(id in imports)) throw new Error('Unexpected controller dependency: ' + id); return imports[id]; } });
  return (exports as unknown as typeof import('./projects-search')).createProjectsSearchController(focus);
}

describe('search fixture standalone bundle (no engine, real Host, or browser URL globals)', () => {
  it('serves production-shaped title/content/file wire and preserves the deliberate refresh failure', () => {
    const host = isolatedHost();
    const titles = request(host, '/api/session?parentID=null&limit=30&order=desc&search=needle');
    expect(searchSessionsFrom(titles.body)).toHaveLength(8);
    const contentPath = '/api/yuri/content-search?q=needle&limit=30';
    const body = request(host, contentPath); expect(searchMessagesFrom(body.body).map(row => row.messageID)).toEqual(['m8', 'm9', 'exact-body-only']);
    expect(request(host, contentPath).status).toBe(503); expect(request(host, contentPath).status).toBe(200);
    const file = request(host, '/api/fs/find?location%5Bdirectory%5D=%2Ffixture%2Ffocus&query=needle&limit=40&type=file');
    expect(searchFilesFrom(file.body, '/fixture/focus')).toHaveLength(8);
    expect(audit(host).rejected).toBe(0);
  });
  it('runs the production controller against the exact strict standalone Host, keeps failed snapshots and skips files with no Focus', async () => {
    const host = isolatedHost(); let focus: string | undefined = '/fixture/focus';
    const controller = controllerFor(host, () => focus);
    await controller.search('needle'); const previous = controller.messages();
    expect(controller.errors()).toEqual({}); expect(controller.files()).toHaveLength(8);
    await controller.search('needle');
    expect(controller.messages()).toBe(previous); expect(controller.errors().messages).toContain('503');
    const merged = core.mergeSearchConversations(controller.sessions(), controller.messages());
    expect(merged).toHaveLength(9); expect(merged[0].hit?.messageID).toBe('m9');
    focus = undefined; await controller.search('needle');
    expect(controller.files()).toEqual([]); expect(controller.errors()).toEqual({});
    const calls = audit(host).calls;
    expect(calls.filter(row => row.path === '/api/fs/find')).toHaveLength(2);
    expect(calls.filter(row => row.path === '/api/yuri/content-search')).toHaveLength(3);
    expect(calls.filter(row => row.path === '/api/session')).toHaveLength(3);
    expect(audit(host).rejected).toBe(0);
  });
  it('parses encoded query data without confusing it with parameter delimiters', () => {
    const host = isolatedHost(), query = 'needle 中文 +&=?';
    expect(request(host, `/api/yuri/content-search?q=${encodeURIComponent(query)}&limit=30`).status).toBe(200);
    expect(audit(host).calls[0].query).toBe(query);
  });
  it('rejects missing, forged and old Host leases before counting a search read', async () => {
    const host = isolatedHost(), scope = createProjectsScopeVM((name, input) => host.call(name, input), 'search-fixture', host.call('connection.list', {}));
    const lane = scope.state.captureHostOperation();
    await lane.request('/api/session?parentID=null&limit=30&order=desc');
    const before = audit(host).calls.length;
    for (const forged of [undefined, { hostID: 'old-host', lease: 'projects-fixture-lease' }, { hostID: 'search-fixture', lease: 'old-lease' }]) {
      expect(() => host.call('runtime.request', { path: '/api/session?parentID=null&limit=30&order=desc', method: 'GET', expectedHost: forged })).toThrow('Missing exact Projects fixture lease');
    }
    expect(audit(host).calls).toHaveLength(before); expect(audit(host).rejected).toBe(3);
    scope.dispose();
  });
  it.each([
    'https://fixture.invalid/api/session?parentID=null&limit=30&order=desc', '//fixture.invalid/api/session', '/api/session#fragment',
    '/api/session?parentID=null&limit=30&order=desc&directory=%2Fother', '/api/session?parentID=null&limit=30&order=desc&search=',
    '/api/session?parentID=null&limit=50&order=desc', '/api/session?parentID=null&limit=30&order=asc',
    '/api/yuri/content-search?q=%ZZ&limit=30', '/api/yuri/content-search?q=needle&%71=duplicate&limit=30',
    '/api/yuri/content-search?q=needle&limit=30&directory=%2Fother', '/api/yuri/content-search?q=needle&limit=30&cursor=bad',
    '/api/fs/find?location%5Bdirectory%5D=%2Fother&query=needle&limit=40&type=file',
    '/api/fs/find?directory=%2Ffixture%2Ffocus&query=needle&limit=40&type=file',
    '/api/fs/find?location%5Bdirectory%5D=%2Ffixture%2Ffocus&query=needle&limit=40&type=directory', '/api/unknown',
  ])('rejects unknown, malformed, duplicate and scope-widened requests: %s', resource => {
    const host = isolatedHost(); expect(() => request(host, resource)).toThrow(); expect(audit(host)).toEqual({ calls: [], rejected: 1 });
  });
  it('is read-only and rejects unknown native calls/audit controls instead of falling back to success', () => {
    const host = isolatedHost();
    expect(() => request(host, '/api/session?parentID=null&limit=30&order=desc', 'POST')).toThrow();
    expect(() => host.call('runtime.request', { path: '/api/session?parentID=null&limit=30&order=desc', body: {} })).toThrow();
    expect(() => host.call('not-allowed', {})).toThrow();
    for (const input of [undefined, null, [], { reset: true }]) expect(() => host.call('projectsSearch.fixture.audit', input)).toThrow();
    expect(audit(host)).toEqual({ calls: [], rejected: 3 });
  });
  it('isolates and cleans each config/bundle/Storage directory without changing production capabilities', () => {
    const production = readFileSync(path.join(root, 'nsh.json'), 'utf8'), paths = new Set<string>();
    for (let index = 0; index < 2; index++) {
      let directory = '';
      expect(() => withProjectsSearchFixture(root, (fixture: Fixture) => {
        directory = fixture.directory; expect(paths.has(directory)).toBe(false); paths.add(directory);
        const config = JSON.parse(readFileSync(path.join(directory, 'nsh.json'), 'utf8'));
        expect(config.capabilities.host).toEqual(['connection.list', 'runtime.request', 'projectsSearch.fixture.audit']);
        expect(path.dirname(fixture.host)).toBe(directory); expect(existsSync(fixture.host)).toBe(true);
        expect(readFileSync(path.join(directory, fixture.entry), 'utf8')).toBe(`import ${JSON.stringify(path.join(root, 'projects-search-fixture.tsx'))};\n`);
        throw new Error('Deliberate runner failure');
      })).toThrow('Deliberate runner failure');
      expect(existsSync(directory)).toBe(false);
    }
    expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(production);
  });
  it('parses both TSX entrypoints and bundles the real shared fuzzy helper for a VM with no URL APIs', () => {
    for (const file of ['projects-search.tsx', 'projects-search-fixture.tsx']) {
      const parsed = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), { fileName: file, compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ES2023 }, reportDiagnostics: true });
      expect(parsed.diagnostics ?? []).toEqual([]);
    }
    const output = mkdtempSync(path.join(process.env.OPENCODE_TMP_DIR || tmpdir(), 'nsh-search-core-'));
    try {
      const filename = path.join(output, 'core.js'), graph = path.join(output, 'graph.json');
      const build = spawnSync('bun', ['build', 'projects-search-core.ts', '--target=browser', '--format=esm', '--outfile', filename, `--metafile=${graph}`], { cwd: root, encoding: 'utf8' });
      expect(build.status, build.stdout + build.stderr).toBe(0);
      const modules = Object.keys(JSON.parse(readFileSync(graph, 'utf8')).inputs);
      expect(modules.some(file => file.endsWith('fuzzySearch.ts'))).toBe(true);
      expect(modules.every(file => !/runtime|state\.ts|react|queryRuntime/.test(file))).toBe(true);
      const core = evaluateBundle(filename) as unknown as typeof import('./projects-search-core');
      const groups = core.projectSearchGroups({ query: 'nedle', commands: [], projects: [{ id: 'p', name: 'needle', path: '/global/project' }], sessions: [], messages: [], files: [] });
      expect(groups.projects.map(row => row.id)).toEqual(['p']);
    } finally { rmSync(output, { recursive: true, force: true }); }
  });
});
