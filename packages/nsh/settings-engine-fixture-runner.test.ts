import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { dict as english } from '../ui/src/lib/i18n/messages/en';

const h = vi.hoisted(() => ({ inspect: (_command: string, _args: string[], _options: { cwd: string; timeout: number }) => ({ status: 0, stdout: '', stderr: '' }) }));
vi.mock('node:child_process', async () => {
  const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return { ...real, spawnSync: (command: string, args: string[], options: { cwd: string; timeout: number }) => {
    if (command === 'bun') return real.spawnSync(command, args, options);
    return h.inspect(command, args, options);
  } };
});
import { runSettingsEngineFixture } from './tests/settings-engine-fixture-runner.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
it.each([
  ['settings-outer.test.ts', 12, 35_000, 45_000],
  ['schedules-ui.test.ts', 1, 60_000, 75_000],
  ['assistants-ui.test.ts', 1, 60_000, 90_000],
  ['assistants-settings-ui.test.ts', 2, 60_000, 75_000],
] as const)('%s scenarios produce syntactically valid driver steps with their original engine timeout', (file, count, engineTimeout, testTimeout) => {
  const filename = path.join(root, file), scenarios: Array<{ name: string; run: () => void; timeout: number }> = [];
  let selected = '', inspected = 0;
  const source = readFileSync(filename, 'utf8').replace('import.meta.url', JSON.stringify(pathToFileURL(filename).href));
  const modules: Record<string, unknown> = {
    'node:url': { fileURLToPath }, 'node:path': { default: path },
    vitest: { expect, test: (name: string, run: () => void, timeout: number) => scenarios.push({ name, run, timeout }), it: (name: string, run: () => void, timeout: number) => scenarios.push({ name, run, timeout }) },
    '../ui/src/lib/i18n/messages/en': { dict: english },
    './tests/settings-engine-fixture-runner.mjs': { runSettingsEngineFixture: (_root: string, _entry: string, _host: string, steps: string[], timeout: number) => {
      expect(timeout).toBe(engineTimeout);
      const parsed = ts.createSourceFile('driver.tsx', `async function scenario() {\n${steps.join('\n')}\n}`, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
      expect((parsed as ts.SourceFile & { parseDiagnostics: readonly unknown[] }).parseDiagnostics, selected).toEqual([]);
      inspected++; return { status: 0, stdout: '', stderr: '' };
    } },
  };
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, {
    exports: {}, require(id: string) { if (!(id in modules)) throw new Error('Unexpected Outer test import ' + id); return modules[id]; },
  });
  expect(scenarios).toHaveLength(count);
  expect(new Set(scenarios.map(scenario => scenario.name)).size).toBe(count);
  if (file === 'settings-outer.test.ts') {
    expect(scenarios.map(scenario => scenario.name)).toContain('Appearance keeps an unconfirmed font draft across explicit GET retry and reopen without replay or treating equal GET as ACK');
    expect(scenarios.map(scenario => scenario.name)).toContain('Appearance confirms an acknowledged font write after explicit GET retry and reopens the confirmed Host value without replay');
  }
  for (const scenario of scenarios) {
    selected = scenario.name;
    expect(scenario.timeout).toBe(testTimeout);
    const before = inspected;
    scenario.run();
    expect(inspected - before, scenario.name).toBe(1);
  }
  expect(inspected).toBe(count);
});
it.each([
  ['settings-test-app.tsx', 'tests/settings-host.js', 45_000, []],
  ['settings-outer-test-app.tsx', 'tests/settings-outer-host.js', 35_000, ['notification.status', 'notification.openSettings', 'notification.configure']],
  ['settings-collections-fixture.tsx', 'tests/settings-collections-host.js', 60_000, ['collections.fixture.audit']],
  ['settings-provider-removal-test-app.tsx', 'tests/settings-provider-removal-host.js', 35_000, []],
  ['schedules-test-app.tsx', 'tests/schedules-host.js', 60_000, []],
  ['assistants-test-app.tsx', 'tests/assistants-host.js', 60_000, []],
  ['assistants-settings-test-app.tsx', 'tests/assistants-settings-host.js', 60_000, []],
] as const)('%s: standalone strict browser Host, explicit macOS driver and isolated config survive until disposal', (entry, source, timeout, capabilities) => {
  const production = readFileSync(path.join(root, 'nsh.json'), 'utf8'), seen = new Set<string>();
  for (let index = 0; index < 2; index++) {
    let directory = '', driver = '';
    h.inspect = (_command, args, options) => {
      directory = options.cwd; driver = args[1];
      expect(args[0]).toBe('test'); expect(args[2]).toBe('--web-host'); expect(options.timeout).toBe(timeout);
      expect(path.dirname(driver).startsWith(path.join(root, 'tests', '.settings-engine-'))).toBe(true);
      const code = readFileSync(driver, 'utf8');
      expect(code).toContain('platform: "macos", storage: {}, network: {}');
      expect(code).toContain('finally { app.dispose(); }'); expect(code).toContain('retained original business step');
      expect(code).toContain(path.join(directory, 'App.tsx'));
      expect(readFileSync(path.join(directory, 'App.tsx'), 'utf8')).toBe(`import ${JSON.stringify(path.join(root, entry))};\n`);
      const config = JSON.parse(readFileSync(path.join(directory, 'nsh.json'), 'utf8'));
      expect(config.capabilities.host).toEqual(['connection.list', 'runtime.request', 'settings.fixture.scope', 'settings.fixture.scopeAudit', ...capabilities]);
      const hostPath = args[3]; expect(seen.has(hostPath)).toBe(false); seen.add(hostPath);
      const bundle = readFileSync(hostPath, 'utf8');
      const syntax = ts.createSourceFile(hostPath, bundle, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
      expect(syntax.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier)).toBe(false);
      const exports: Record<string, unknown> = {};
      vm.runInNewContext(ts.transpileModule(bundle, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, { exports, URL: undefined, URLSearchParams: undefined });
      const host = (exports.createHost as () => { call: (name: string, input: object) => unknown })();
      expect(() => host.call('runtime.request', { path: '/api/config/settings', method: 'PUT', body: {} })).toThrow('snapshot not issued');
      return { status: index, stdout: '', stderr: '' };
    };
    expect(runSettingsEngineFixture(root, entry, source, ['// retained original business step'], timeout, [...capabilities]).status).toBe(index);
    expect(existsSync(directory)).toBe(false); expect(existsSync(path.dirname(driver))).toBe(false);
    expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(production);
  }
});
