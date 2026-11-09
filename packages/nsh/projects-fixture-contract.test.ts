import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { withProjectsNativeFixture } from './tests/projects-native-runner.js';
import { createProjectsScopeVM } from './tests/projects-scope-vm';

const root = path.dirname(fileURLToPath(import.meta.url));
type Fixture = { directory: string; entry: string; host: string };
type Host = { call(name: string, input: Record<string, unknown>): unknown };
function standalone(filename: string): Host {
  const exports: { createHost?: () => Host } = {}, context = vm.createContext({ exports });
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  const source = readFileSync(filename, 'utf8');
  vm.runInContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, context);
  return exports.createHost!();
}
describe('Projects native fixture bundle and authority (no NSH engine)', () => {
  it.each(['home', 'outer'])('%s uses a standalone Host and actual scoped runtime/page operations with isolated config and cleanup', async kind => {
    const production = readFileSync(path.join(root, 'nsh.json'), 'utf8'); let directory = '';
    const { scope, host, resource } = withProjectsNativeFixture(root, kind, (fixture: Fixture) => {
      directory = fixture.directory;
      const config = JSON.parse(readFileSync(path.join(directory, 'nsh.json'), 'utf8'));
      expect(config.capabilities.host).toEqual(['connection.list', 'runtime.request']);
      const host = standalone(fixture.host), snapshot = host.call('connection.list', {});
      const scope = createProjectsScopeVM((name, input) => host.call(name, input), 'fixture', snapshot);
      const resource = kind === 'home' ? '/api/yuri/session-index' : '/api/fs/home';
      return { scope, host, resource };
    });
    const lane = scope.operations.createPageOperations().capture();
    expect(lane.current()).toBe(true);
    const response = await lane.request(resource);
    expect(response).toMatchObject(kind === 'home' ? { available: true } : { home: '/workspace' });
    for (const expectedHost of [undefined, { hostID: 'old-host', lease: 'projects-fixture-lease' }, { hostID: 'fixture', lease: 'old-lease' }]) expect(() => host.call('runtime.request', { path: resource, method: 'GET', expectedHost })).toThrow('Missing exact Projects fixture lease');
    scope.advanceGeneration();
    await expect(lane.request(resource)).rejects.toThrow('page_operation_stale');
    scope.dispose();
    expect(existsSync(directory)).toBe(false); expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(production);
  });
});
