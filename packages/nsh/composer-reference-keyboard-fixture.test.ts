import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import { prepareReferenceKeyboardDriver } from './tests/composer-reference-keyboard-runner';
import { createHost } from './tests/composer-reference-keyboard-host.js';

const root = path.dirname(fileURLToPath(import.meta.url));
it('keyboard runner uses independent App capabilities, the interaction macOS driver and a standalone browser Host with cleanup', () => {
  const seen = new Set<string>(), production = readFileSync(path.join(root, 'nsh.json'), 'utf8');
  for (let index = 0; index < 2; index++) {
    const driver = prepareReferenceKeyboardDriver(root, ['await app.keyboard.press("tab");']);
    try {
      expect(seen.has(driver.fixtureDirectory)).toBe(false); seen.add(driver.fixtureDirectory);
      const config = JSON.parse(readFileSync(path.join(driver.fixtureDirectory, 'nsh.json'), 'utf8'));
      expect(config.capabilities.host).toEqual(['connection.list', 'runtime.request', 'runtime.stream', 'runtime.stop', 'referenceKeyboard.fixture.audit']);
      expect(readFileSync(path.join(driver.fixtureDirectory, 'App.tsx'), 'utf8')).toBe(`import ${JSON.stringify(path.join(root, 'composer-reference-keyboard-fixture.tsx'))};\n`);
      const script = readFileSync(driver.testFile, 'utf8');
      expect(script).toContain(path.join(driver.fixtureDirectory, 'App.tsx'));
      expect(script).toContain('platform: "macos", storage: {}, network: {}');
      expect(script).toContain('keyboard-audit:0:0'); expect(script).toContain('finally { app.dispose(); }');
      const host = driver.bundleHost(), bundle = readFileSync(host, 'utf8');
      const syntax = ts.createSourceFile(host, bundle, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
      expect(syntax.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier)).toBe(false);
      const exports: Record<string, unknown> = {};
      vm.runInNewContext(ts.transpileModule(bundle, { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS } }).outputText, { exports, URL: undefined, URLSearchParams: undefined });
      const bridge = (exports.createHost as typeof createHost)();
      const snapshot = bridge.call('connection.list', {});
      expect(bridge.call('runtime.request', { path: '/api/agent?location%5Bdirectory%5D=%2Fworkspace', method: 'GET', expectedHost: snapshot.runtimeScope })).toMatchObject({ status: 200, body: { data: [{ name: 'reviewer' }] } });
    } finally { driver.dispose(); }
    expect(existsSync(driver.fixtureDirectory)).toBe(false); expect(existsSync(driver.directory)).toBe(false);
    expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(production);
  }
});

it('keyboard Host requires a connection-issued scope and admits only exact file/catalog/session reads, with zero sends', () => {
  const host = createHost();
  expect(() => host.call('runtime.request', { path: '/api/agent', method: 'GET' })).toThrow('scope not issued');
  const snapshot = host.call('connection.list', {}), expectedHost = snapshot.runtimeScope;
  const request = { path: '/api/agent?location%5Bdirectory%5D=%2Fworkspace', method: 'GET' };
  for (const input of [request, { ...request, expectedHost: { ...expectedHost, lease: 'stale' } }, { ...request, expectedHost: { ...expectedHost, hostID: 'other' } },
    { ...request, expectedHost: { ...expectedHost, extra: true } }, { ...request, expectedHost, headers: {} }]) expect(() => host.call('runtime.request', input)).toThrow();
  expect(host.call('runtime.request', { ...request, expectedHost })).toMatchObject({ status: 200 });
  const send = (path: string) => host.call('runtime.request', { path, method: 'GET', expectedHost });
  expect(send('/api/fs/find?location%5Bdirectory%5D=%2Fworkspace&query=src&type=file&limit=80').body.data).toHaveLength(12);
  expect(send('/api/fs/find?location%5Bdirectory%5D=%2Fworkspace&query=src&type=directory&limit=40').body.data).toEqual([{ path: 'src/', type: 'directory' }]);
  expect(send('/api/session?search=src&limit=12&order=desc&archived=false').body.data).toHaveLength(1);
  for (const path of ['/api/agent?location%5Bdirectory%5D=%2Fother', '/api/agent?location%5Bdirectory%5D=%2Fworkspace&extra=1',
    '/api/fs/find?location%5Bdirectory%5D=%2Fworkspace&query=src&type=file&limit=40', '/api/fs/find?location%5Bdirectory%5D=%2Fother&query=src&type=file&limit=80',
    '/api/session?search=src&limit=12&order=asc&archived=false']) expect(() => send(path)).toThrow();
  expect(host.call('referenceKeyboard.fixture.audit', {})).toEqual({ mutations: 0, sends: 0 });
});

it('keyboard fixture never accepts Enter/Tab as prompt or other mutation requests', () => {
  const host = createHost(), snapshot = host.call('connection.list', {});
  for (const path of ['/api/session/reference-chat/prompt?directory=%2Fworkspace', '/api/config/settings']) {
    expect(() => host.call('runtime.request', { path, method: 'POST', body: {}, expectedHost: snapshot.runtimeScope })).toThrow('must not send or mutate');
  }
  expect(host.call('referenceKeyboard.fixture.audit', {})).toEqual({ mutations: 2, sends: 1 });
  expect(() => host.call('referenceKeyboard.fixture.audit', { expectedHost: snapshot.runtimeScope })).toThrow('Invalid keyboard fixture payload');
});
