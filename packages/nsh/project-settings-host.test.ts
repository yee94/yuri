import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { createProjectSettingsEditor } from './project-settings';
import { withProjectSettingsFixture } from './tests/project-settings-runner.js';

type Audit = { writes: number; commits: number; rejectedRequests: number; auditSequence: number; actionCount: number; commands: string[]; wait: boolean };
type Host = {
  call(name: 'runtime.request', input: { path: string; method?: string; body?: unknown }): { status: number; body: unknown };
  call(name: 'projectSettings.fixture.audit', input: unknown): Audit;
  inspect: () => { writes: number; config: Record<string, unknown> };
};
type Fixture = { directory: string; entry: string; host: string };
const root = path.dirname(fileURLToPath(import.meta.url));
const artifactPaths = new Set<string>();
function isolatedHost(): Host {
  const context = vm.createContext({});
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  let artifact = '';
  const host = withProjectSettingsFixture(root, (fixture: Fixture) => {
    artifact = fixture.host;
    expect(path.isAbsolute(artifact)).toBe(true);
    expect(artifactPaths.has(artifact)).toBe(false); artifactPaths.add(artifact);
    const bundle = readFileSync(artifact, 'utf8');
    const syntax = ts.createSourceFile(artifact, bundle, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    expect(syntax.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier)).toBe(false);
    const exports: Record<string, unknown> = {};
    const source = ts.transpileModule(bundle, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    // Deliberately no require/import resolver: evaluate exactly the standalone artifact handed to --web-host.
    const evaluate = vm.runInContext(`(function(exports) { ${source}\n})`, context);
    evaluate(exports);
    return (exports.createHost as () => Host)();
  });
  expect(existsSync(path.dirname(artifact))).toBe(false);
  return host;
}

describe('project settings fixture without browser URL globals', () => {
  it('runs the real editor load, 409 retention, acknowledged write, failed read-back and read-only retry', async () => {
    const host = isolatedHost();
    const editor = createProjectSettingsEditor(async (path, method, body) => {
      const result = host.call('runtime.request', { path, method, body });
      if (result.status < 200 || result.status >= 300) throw Object.assign(new Error(`HTTP ${result.status}`), { status: result.status });
      return result.body;
    }, () => true, { id: 'catalog-do-not-use', path: '/fixture/root' }, () => undefined);
    await editor.load(); expect(editor.snapshot().ready).toEqual({ actions: true, setup: true });
    expect(host.call('projectSettings.fixture.audit', {})).toMatchObject({ writes: 0, commits: 0, rejectedRequests: 0, actionCount: 1, wait: true });
    editor.edit('actions', { actions: [] }); await editor.save('actions'); expect(editor.snapshot().errors.actions).toContain('409');
    await editor.save('actions'); expect(editor.snapshot().pending).toBe('actions'); expect(editor.snapshot().errors.actions).toContain('503');
    const beforeRetry = host.call('projectSettings.fixture.audit', {});
    expect(beforeRetry).toMatchObject({ writes: 2, commits: 1, rejectedRequests: 0 });
    await editor.save('actions'); expect(editor.snapshot().pending).toBeNull(); expect(host.inspect().writes).toBe(2); expect(host.inspect().config.projectActions).toEqual([]);
    expect(host.call('projectSettings.fixture.audit', {})).toMatchObject({ writes: beforeRetry.writes, commits: beforeRetry.commits, rejectedRequests: 0, actionCount: 0 });
  });

  it('grants audit only in a unique temporary app config and preserves the production config byte-for-byte', () => {
    const production = readFileSync(path.join(root, 'nsh.json'), 'utf8');
    let directory = '';
    withProjectSettingsFixture(root, (fixture: Fixture) => {
      directory = fixture.directory;
      const config = JSON.parse(readFileSync(path.join(directory, 'nsh.json'), 'utf8'));
      expect(config.capabilities).toEqual({ host: ['runtime.request', 'projectSettings.fixture.audit'] });
      expect(config.theme).toBe(path.join(root, 'theme.json'));
      expect(config.id).toBe('example.yuri.project-settings');
      expect(path.dirname(fixture.host)).toBe(directory);
      expect(fixture.entry).toBe('App.tsx');
      expect(readFileSync(path.join(directory, fixture.entry), 'utf8')).toBe(`import ${JSON.stringify(path.join(root, 'project-settings-fixture.tsx'))};\n`);
    });
    expect(existsSync(directory)).toBe(false);
    expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(production);
    expect(JSON.parse(production).capabilities.host).not.toContain('projectSettings.fixture.audit');
  });

  it('cleans its own bundle/config/Storage directory even when the engine callback throws', () => {
    let directory = '';
    expect(() => withProjectSettingsFixture(root, (fixture: Fixture) => {
      directory = fixture.directory; expect(existsSync(fixture.host)).toBe(true);
      throw new Error('Fixture engine callback failed');
    })).toThrow('Fixture engine callback failed');
    expect(path.isAbsolute(directory)).toBe(true); expect(existsSync(directory)).toBe(false);
  });

  it('records rejected execution requests in the audit instead of implementing or silently ignoring commands', () => {
    const host = isolatedHost();
    expect(() => host.call('runtime.request', { path: '/api/fs/exec?directory=%2Ffixture%2Froot', method: 'POST', body: { command: 'must never execute' } })).toThrow();
    expect(host.call('projectSettings.fixture.audit', {})).toMatchObject({ writes: 0, commits: 0, rejectedRequests: 1 });
  });

  it('rejects every nonempty/malformed audit payload instead of treating it as a mutating control endpoint', () => {
    const host = isolatedHost();
    for (const input of [undefined, null, [], { reset: true }, { commands: ['must not execute'] }]) expect(() => host.call('projectSettings.fixture.audit', input)).toThrow();
    expect(host.call('projectSettings.fixture.audit', {})).toMatchObject({ writes: 0, commits: 0 });
  });

  it.each([
    '/api/config/settings/extra', '/api/config/settings?unknown=1', '/api/fs/home?directory=%2Ffixture%2Froot',
    '/api/config/catalog/providers', '/api/config/catalog/providers?directory=%2Ffixture%2Fother',
    '/api/git/check?directory=%ZZ', '/api/git/check?directory=%2Ffixture%2Froot&%64irectory=%2Ffixture%2Fother',
    '/api/fs/read?directory=%2Ffixture%2Froot&path=%2Ffixture%2Fother',
    '/api/fs/read?directory=%2Ffixture%2Froot&path=x&unexpected=1',
    'https://fixture.invalid/api/config/settings', '//fixture.invalid/api/config/settings', '/api/config/settings#ignored',
    '/api/fs/exec?directory=%2Ffixture%2Froot',
  ])('rejects unexpected paths/query/scope rather than returning fallback success: %s', resource => {
    const host = isolatedHost(); expect(() => host.call('runtime.request', { path: resource })).toThrow(); expect(host.inspect().writes).toBe(0);
  });

  it.each(['/api/config/settings', '/api/fs/home', '/api/git/check?directory=%2Ffixture%2Froot', '/api/config/catalog/providers?directory=%2Ffixture%2Froot'])('rejects the wrong method at %s', resource => {
    expect(() => isolatedHost().call('runtime.request', { path: resource, method: 'POST', body: {} })).toThrow();
  });
});
