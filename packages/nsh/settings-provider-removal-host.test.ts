import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, test } from 'vitest';
import { createProviderRemoval, providerRemovalBlock } from './settings-provider-removal';
import type { SettingsRequest } from './settings-protocol';
import { withProviderRemovalHost } from './tests/settings-provider-removal-runner.js';

type Input = { path: string; method?: string; body?: unknown };
type Host = { call(name: string, input: Input): { status: number; body: unknown } };
const directory = path.dirname(fileURLToPath(import.meta.url));
const artifactPaths = new Set<string>();
function isolatedHost(): Host {
  const context = vm.createContext({});
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  let artifact = '';
  const host = withProviderRemovalHost(directory, (filename: string) => {
    artifact = filename;
    expect(path.isAbsolute(filename)).toBe(true);
    expect(artifactPaths.has(filename)).toBe(false); artifactPaths.add(filename);
    const bundle = readFileSync(filename, 'utf8');
    const syntax = ts.createSourceFile(filename, bundle, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
    expect(syntax.statements.some(node => ts.isImportDeclaration(node) || (ts.isExportDeclaration(node) && !!node.moduleSpecifier))).toBe(false);
    const exports: Record<string, unknown> = {};
    const source = ts.transpileModule(bundle, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    // No require/import resolver: this is the same standalone bundle handed to --web-host.
    const evaluate = vm.runInContext(`(function(exports, require) { ${source}\n})`, context);
    evaluate(exports, undefined);
    return (exports.createHost as () => Host)();
  });
  expect(existsSync(artifact)).toBe(false);
  return host;
}
function fixture(scope?: string) {
  const host = isolatedHost(), calls: Input[] = [];
  const send: SettingsRequest = async (resource, method = 'GET', body) => {
    calls.push({ path: resource, method, body });
    const response = host.call('runtime.request', { path: resource, method, ...(body === undefined ? {} : { body }) });
    if (response.status < 200 || response.status >= 300) throw new Error(`Fixture HTTP ${response.status}`);
    return response.body;
  };
  const initialize = () => send(`/api/config/catalog/providers${scope ? '?directory=' + encodeURIComponent(scope) : ''}`);
  const removal = (providerID: string) => createProviderRemoval(send, { providerID, directory: scope, current: () => true });
  return { host, send, calls, initialize, removal };
}

describe('Provider fake Host in a VM without browser URL APIs', () => {
  test('scenario bundle and Storage namespace are isolated and cleaned even when the runner fails', () => {
    let artifact = '';
    expect(() => withProviderRemovalHost(directory, (filename: string) => {
      artifact = filename; expect(existsSync(filename)).toBe(true);
      throw new Error('Fixture engine failure');
    })).toThrow('Fixture engine failure');
    expect(path.isAbsolute(artifact)).toBe(true);
    expect(existsSync(path.dirname(artifact))).toBe(false);
  });
  test.each([undefined, '/fixture/project'])('global/scoped target: initial catalog, cancel read-only, scoped metadata and confirmed removal (%s)', async scope => {
    const f = fixture(scope); expect(await f.initialize()).toMatchObject({ schemaVersion: 1, providers: ['target', 'environment', 'runtime', 'partial-config', 'partial-credential', 'refresh'].map(id => ({ id })) });
    await expect(f.send('/api/config/settings')).resolves.toEqual({ hiddenModels: [] });
    await expect(f.send(`/api/integration/integration-target${scope ? '?location%5Bdirectory%5D=' + encodeURIComponent(scope) : ''}`)).resolves.toMatchObject({ data: { id: 'integration-target', methods: [] } });
    const removal = f.removal('target'), consent = await removal.inspect();
    expect(f.calls.every(call => call.method === 'GET')).toBe(true);
    await removal.remove(consent);
    expect(await f.initialize()).toMatchObject({ providers: expect.arrayContaining([{ id: 'read-back', name: 'Verified removal: target', models: {} }]) });
    expect(f.calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual([
      `/api/provider/target/auth?scope=config${scope ? '&directory=%2Ffixture%2Fproject' : ''}`, '/api/credential/target%2Fa', '/api/credential/target%2Fb',
    ]);
  });

  test.each(['partial-config', 'partial-credential'])('%s route keeps its real injected failure and safe retry checkpoints', async id => {
    const f = fixture('/fixture/project'); await f.initialize();
    const removal = f.removal(id);
    await expect(removal.remove(await removal.inspect())).rejects.toMatchObject({ reason: 'failed' });
    await removal.remove();
    expect((await removal.inspect()).present).toBe(false);
    expect(f.calls.filter(call => call.method === 'DELETE' && call.path.includes('/auth?'))).toHaveLength(id === 'partial-config' ? 2 : 1);
    expect(f.calls.filter(call => call.method === 'DELETE' && call.path.endsWith(`${id}%2Fa`))).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'DELETE' && call.path.endsWith(`${id}%2Fb`))).toHaveLength(id === 'partial-credential' ? 2 : 1);
  });

  test('refresh scenario still fails the first authoritative read, then resumes with GET only', async () => {
    const f = fixture('/fixture/project'); await f.initialize();
    const removal = f.removal('refresh');
    await expect(removal.remove(await removal.inspect())).rejects.toMatchObject({ reason: 'metadata' });
    const writes = f.calls.filter(call => call.method === 'DELETE');
    await removal.inspect(); await removal.remove();
    expect(f.calls.filter(call => call.method === 'DELETE')).toEqual(writes);
    expect((await removal.inspect()).present).toBe(false);
  });

  test.each(['environment', 'runtime'])('%s route retains its removal gate with no writes', async id => {
    const f = fixture(); await f.initialize();
    const removal = f.removal(id), consent = await removal.inspect();
    expect(providerRemovalBlock(consent)).toBe(id === 'environment' ? 'environment' : 'unavailable');
    await expect(removal.remove(consent)).rejects.toMatchObject({ reason: id === 'environment' ? 'environment' : 'unavailable' });
    expect(f.calls.some(call => call.method === 'DELETE')).toBe(false);
  });

  test.each([
    '/api/config/catalog/providers?directory=%2Fother', '/api/config/catalog/providers?directory=',
    '/api/config/settings?unknown=1', '/api/config/settings?directory=%2Ffixture%2Fproject',
    '/api/config/catalog/providers?directory=%2Ffixture%2Fproject&directory=%2Fother',
    '/api/provider?location%5Bdirectory%5D=%2Ffixture%2Fproject&location%5Bdirectory%5D=%2Fother',
    '/api/provider?location%5Bdirectory%5D=%2Ffixture%2Fproject&%6Cocation%5Bdirectory%5D=%2Fother',
    '/api/provider?directory=%2Ffixture%2Fproject', '/api/provider', '/api/provider?location%5Bdirectory%5D=%2Fother',
    '/api/integration/integration-target', '/api/integration/integration-target?location%5Bdirectory%5D=%2Fother',
    '/api/integration/integration-target/extra?location%5Bdirectory%5D=%2Ffixture%2Fproject',
    '/api/config/providers/sources', '/api/config/providers/sources?directory=%2Fother',
    '/api/config/providers/sources?directory=%ZZ', '/api/config/providers/sources?directory=%2Ffixture%2Fproject&unknown=1',
    '/api/config/settings/extra', 'https://fixture.invalid/api/config/settings', '//fixture.invalid/api/config/settings',
    '/api/config/settings#ignored', '/api/config/settings?', '/api/config/settings?x',
  ])('rejects unknown/malformed GET route/query without widening the fixture: %s', async resource => {
    const f = fixture('/fixture/project'); await f.initialize();
    expect(() => f.host.call('runtime.request', { path: resource, method: 'GET' })).toThrow();
  });

  test.each([
    '/api/provider/target/auth', '/api/provider/target/auth?scope=auth&directory=%2Ffixture%2Fproject',
    '/api/provider/target/auth?scope=config', '/api/provider/target/auth?scope=config&directory=%2Fother',
    '/api/provider/target/auth?scope=config&scope=config&directory=%2Ffixture%2Fproject',
    '/api/provider/target/auth?scope=config&directory=%2Ffixture%2Fproject&extra=1',
    '/api/provider/target/extra/auth?scope=config&directory=%2Ffixture%2Fproject',
    '/api/provider/absent/auth?scope=config&directory=%2Ffixture%2Fproject',
    '/api/credential/target%2Fa?directory=%2Ffixture%2Fproject', '/api/credential/target/a',
    '/api/credential/target%2Fa?unknown=1', '/api/credential/unknown',
  ])('rejects unsafe DELETE wire instead of mutating: %s', async resource => {
    const f = fixture('/fixture/project'); await f.initialize();
    expect(() => f.host.call('runtime.request', { path: resource, method: 'DELETE' })).toThrow();
    expect((await f.removal('target').inspect()).credentials).toEqual(['target/a', 'target/b']);
  });

  test.each(['POST', 'PUT', 'PATCH', 'HEAD', 'get', 'UNKNOWN'])('rejects unsupported method %s on every known route', async method => {
    const f = fixture('/fixture/project'); await f.initialize();
    for (const resource of ['/api/config/catalog/providers?directory=%2Ffixture%2Fproject', '/api/config/settings', '/api/provider?location%5Bdirectory%5D=%2Ffixture%2Fproject', '/api/integration?location%5Bdirectory%5D=%2Ffixture%2Fproject', '/api/integration/integration-target?location%5Bdirectory%5D=%2Ffixture%2Fproject', '/api/config/providers/sources?directory=%2Ffixture%2Fproject', '/api/provider/target/auth?scope=config&directory=%2Ffixture%2Fproject', '/api/credential/target%2Fa']) {
      expect(() => f.host.call('runtime.request', { path: resource, method })).toThrow();
    }
  });

  test('GET/DELETE cannot be swapped, and the read/delete fixture never accepts a body', async () => {
    const f = fixture('/fixture/project'); await f.initialize();
    for (const resource of ['/api/config/catalog/providers?directory=%2Ffixture%2Fproject', '/api/config/settings', '/api/provider?location%5Bdirectory%5D=%2Ffixture%2Fproject', '/api/integration?location%5Bdirectory%5D=%2Ffixture%2Fproject', '/api/integration/integration-target?location%5Bdirectory%5D=%2Ffixture%2Fproject', '/api/config/providers/sources?directory=%2Ffixture%2Fproject']) {
      expect(() => f.host.call('runtime.request', { path: resource, method: 'DELETE' })).toThrow();
      expect(() => f.host.call('runtime.request', { path: resource, method: 'GET', body: {} })).toThrow();
    }
    for (const resource of ['/api/provider/target/auth?scope=config&directory=%2Ffixture%2Fproject', '/api/credential/target%2Fa']) {
      expect(() => f.host.call('runtime.request', { path: resource, method: 'GET' })).toThrow();
      expect(() => f.host.call('runtime.request', { path: resource, method: 'DELETE', body: {} })).toThrow();
    }
  });

  test('initial catalog cannot choose an unknown directory and established global scope cannot be widened', async () => {
    const host = isolatedHost();
    expect(() => host.call('runtime.request', { path: '/api/config/catalog/providers?directory=%2Fother', method: 'GET' })).toThrow();
    const f = fixture(); await f.initialize();
    expect(() => f.host.call('runtime.request', { path: '/api/config/catalog/providers?directory=%2Ffixture%2Fproject', method: 'GET' })).toThrow();
    expect(() => f.host.call('runtime.request', { path: '/api/provider?location%5Bdirectory%5D=%2Ffixture%2Fproject', method: 'GET' })).toThrow();
  });
});
