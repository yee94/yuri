import { expect, it } from 'vitest';
import { createHost } from './features-memory-host.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { sessionsFrom } from './model';
import vm from 'node:vm';
import { appearanceFromSettings, createNativeAppearanceSync, type AppliedNativeAppearance } from './appearance-core';

it('memory appearance resolves canonical supported fonts and confirms them through the real sync protocol', async () => {
  const host = createHost(), connection = host.call('connection.list', {}), calls: string[] = [];
  let current: AppliedNativeAppearance | null = null, error = '';
  const read = async (path: string) => host.call('runtime.request', { expectedHost: connection.runtimeScope, method: 'GET', path }).body;
  const sync = createNativeAppearanceSync({
    readSettings: () => read('/api/config/settings'), readThemes: () => read('/api/config/themes'),
    reset: async scope => { calls.push('reset'); return host.call('appearance.reset', { hostID: scope?.hostID ?? null }).revision; },
    apply: async (scope, revision, appearance) => { calls.push('apply'); return host.call('appearance.apply', { hostID: scope.hostID, revision, mode: appearance.mode, cssVars: appearance.cssVars, fonts: appearance.fonts }); },
    changed: value => { current = value; }, failed: message => { error = message; },
  });
  const snapshot = (): AppliedNativeAppearance | null => current;
  sync.setScope({ hostID: 'features-memory', generation: 1, url: 'https://features-memory.invalid' });
  await sync.refresh();
  expect(error).toBe(''); expect(calls).toEqual(['reset', 'apply']);
  expect(snapshot()?.fonts).toEqual({ ui: 'system-ui', mono: 'monospace', assistantLight: 'JetBrains Mono', assistantDark: 'JetBrains Mono' });
  expect(snapshot()).toMatchObject({ uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'JetBrains Mono', dark: 'JetBrains Mono' }, unsupportedFonts: [] });
  expect(host.call('features.fixture.audit', {}).requests.every(call => call.method === 'GET')).toBe(true);
  const settings = await read('/api/config/settings');
  await expect(appearanceFromSettings({ ...settings, monoFont: 'system' }, async () => ({ themes: [] }))).rejects.toThrow('Host selected font is unsupported');
  const appearance = await appearanceFromSettings(settings, async () => ({ themes: [] }));
  const apply = { hostID: 'features-memory', revision: 1, mode: appearance.mode, cssVars: appearance.cssVars, fonts: appearance.fonts };
  expect(() => host.call('appearance.apply', { ...apply, fonts: { ...apply.fonts, mono: 'Uninstalled Font' } })).toThrow('Unsafe memory appearance apply');
  expect(() => host.call('appearance.apply', { ...apply, hostID: 'other' })).toThrow('Unsafe memory appearance apply');
  host.call('appearance.reset', { hostID: 'features-memory' });
  expect(() => host.call('appearance.apply', apply)).toThrow('Unsafe memory appearance apply');
  expect(() => host.call('appearance.reset', { hostID: 'other' })).toThrow('Unsafe memory appearance reset');
});

it('the actual memory app initialization waits for applied supported appearance before marking ready', async () => {
  const root = path.dirname(fileURLToPath(import.meta.url)), host = createHost();
  const connection = host.call('connection.list', {}), calls: string[] = [];
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  const appearance = signal<AppliedNativeAppearance | null>(null), signals: (() => unknown)[] = [];
  const imports: Record<string, unknown> = {
    nsh: { cleanup: () => {}, mount: (work: () => unknown) => work(), signal: <T>(value: T) => { const result = signal(value); signals.push(result); return result; }, Text: 'Text', View: 'View' },
    'nsh/base': { Button: 'Button', NavStack: 'NavStack', NavPage: 'NavPage', createNavStack: () => ({}) }, './features': {},
    './state': { app: { connection: () => connection.connections[0] }, epoch: () => 1, loadConnections: async () => {}, refresh: async () => {}, captureHostRequest: () => async (path: string) => host.call('runtime.request', { expectedHost: connection.runtimeScope, method: 'GET', path }).body },
    './runtime': { native: async (name: string, input: unknown) => { calls.push(name); return host.call(name, input); } },
    './i18n': { language: { set: () => {} } }, './appearance': { nativeAppearance: { current: appearance } },
    './appearance-core': { createNativeAppearanceSync, appearanceFromSettings }, './model': { record: (value: unknown) => value, text: (value: unknown) => String(value) },
  };
  const source = ts.transpileModule(readFileSync(path.join(root, 'features-write-ui-app.tsx'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
  vm.runInNewContext(source, { exports: {}, h: () => null, require: (id: string) => { if (!(id in imports)) throw new Error(`Unexpected memory app import ${id}`); return imports[id]; }, Error, Promise });
  expect(signals[0]()).toBe(false);
  for (let turn = 0; turn < 30; turn++) await Promise.resolve();
  expect(signals[1]()).toBe(''); expect(signals[0]()).toBe(true);
  expect(calls).toEqual(['features.fixture.identity', 'appearance.reset', 'appearance.apply']);
  expect(appearance()?.unsupportedFonts).toEqual([]);
});

it('memory Host empty session index is authoritative and accepted by the production adapter', () => {
  const host = createHost(), expectedHost = host.call('connection.list', {}).runtimeScope;
  const response = host.call('runtime.request', { expectedHost, method: 'GET', path: '/api/yuri/session-index' });
  expect(response.status).toBe(200);
  expect(sessionsFrom(response.body)).toEqual([]);
  expect(response.body.available).toBe(true);
  expect(response.body.directories).toEqual([{ directory: '/first-project', sessions: [] }]);
  expect(host.call('features.fixture.audit', {}).requests.every(call => call.method === 'GET')).toBe(true);
});

it('both engine fixtures explicitly isolate the macOS headless surface and wait for picker dismissal', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['features-ui.test.ts', 'features-write-ui.test.ts']) {
    const source = readFileSync(path.join(root, name), 'utf8');
    expect(source).toContain("platform: 'macos', storage: {}, network: {}");
    expect(source).toContain('finally { app.dispose(); }');
    expect(source).not.toContain('input: steps');
    expect(source).toContain('await app.waitUntil(() => !app.shows("id:features-model-sheet"))');
  }
});

it('both authored runners generate valid isolated test scripts without launching an engine', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  for (const name of ['features-ui.test.ts', 'features-write-ui.test.ts']) {
    let generated = ''; const files = new Map<string, string>(); const launches: { args: string[]; options: { input?: unknown; cwd: string } }[] = [];
    const source = readFileSync(path.join(root, name), 'utf8').replaceAll('import.meta.url', JSON.stringify(new URL(`file://${path.join(root, name)}`).href));
    const javascript = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
    const imports: Record<string, unknown> = {
      'node:child_process': { spawnSync: (_bin: string, args: string[], options: { cwd: string }) => { launches.push({ args, options }); return { status: 0, stdout: '', stderr: '' }; } },
      'node:fs': { readFileSync, mkdtempSync: (prefix: string) => `${prefix}unit-only`, writeFileSync: (path: string, content: string) => { generated = content; files.set(path, content); }, rmSync: () => {} },
      'node:os': { tmpdir: () => '/fixture-temp' }, 'node:url': { fileURLToPath }, 'node:path': path,
      vitest: { expect, it: (_name: string, run: () => void) => run(), beforeAll: () => {}, afterAll: () => {} },
    };
    vm.runInNewContext(javascript, { exports: {}, process: { env: { FEATURES_DATE_HOST: '/fixture-date-host.js' } }, require: (id: string) => { if (!(id in imports)) throw new Error(`Unexpected runner import ${id}`); return imports[id]; } });
    expect(launches).toHaveLength(1);
    expect(launches[0].args).toContain('--web-host');
    expect(launches[0].args[1]).toMatch(/features-engine\.test\.tsx$/);
    expect(launches[0].options.input).toBeUndefined();
    expect(generated).toContain("platform: 'macos', storage: {}, network: {}");
    // Parse the actual generated script, including every engine step, without
    // importing nsh/test or executing the script's open/press/write callbacks.
    const parsed = ts.transpileModule(generated, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } });
    expect(parsed.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error)).toEqual([]);
    for (const [file, source] of files) {
      if (!file.endsWith('.tsx')) continue;
      const compiled = ts.transpileModule(source, { fileName: file, reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.Preserve } });
      expect(compiled.diagnostics?.filter(item => item.category === ts.DiagnosticCategory.Error)).toEqual([]);
    }
    if (name === 'features-ui.test.ts') {
      expect(generated).toContain('expect(app.dialogs().length).toBe(botBackDialogs + 1)');
      expect(generated).toContain('expect(app.dialogs().length).toBe(taskCancelDialogs + 1)');
      expect(generated).toContain('expect(app.value("id:features-bot-name")).toBe(botDraft)');
      expect(generated).toContain('app.onDialog(() => "Discard")');
    } else {
      expect(launches[0].options.cwd).toBe(path.join(root, 'tests/features-write'));
      const stagedRoot = path.dirname(launches[0].args[1]), entry = path.join(stagedRoot, 'App.tsx');
      expect(generated).toContain(`open(${JSON.stringify(entry)},`);
      expect(files.get(entry)).toContain(`from ${JSON.stringify(path.join(stagedRoot, 'features.tsx'))}`);
      const instrumented = files.get(path.join(stagedRoot, 'features.tsx')) ?? '';
      expect(instrumented).toContain('featureHistoryPhase(historyMounted() ? "history-mounted-true"');
      expect(instrumented).toContain('onOpen={() => featureHistoryPhase("history-sheet-opened")}');
      expect(instrumented).toContain('"history-closed-while-request-open" : "history-closed-after-request"');
      expect(instrumented).toContain('historyMounted.set(false); featureHistoryPhase("history-unmounted")');
      expect(instrumented).toContain('"menu-choice-other"');
      expect(instrumented).toContain(`from ${JSON.stringify(path.join(stagedRoot, 'features-history.tsx'))}`);
      const historySource = files.get(path.join(stagedRoot, 'features-history.tsx')) ?? '';
      expect(historySource).toContain('featureHistoryPhase("history-content-created")');
      expect(historySource).toContain('"history-content-active" : "history-content-inactive"');
      expect(instrumented).toContain('featureHistoryLayout("sheet-host", event.bounds)');
      for (const part of ['root', 'header', 'list']) expect(historySource).toContain(`featureHistoryLayout("${part}", event.bounds)`);
      const stagedConfig = JSON.parse(files.get(path.join(stagedRoot, 'nsh.json')) ?? '{}');
      const fixtureConfig = JSON.parse(readFileSync(path.join(root, 'tests/features-write/nsh.json'), 'utf8'));
      expect(stagedConfig.capabilities).toEqual(fixtureConfig.capabilities);
      expect(stagedConfig.theme).toBe(path.resolve(root, 'tests/features-write', fixtureConfig.theme));
      expect(readFileSync(path.join(root, 'features.tsx'), 'utf8')).not.toContain('featureHistoryPhase');
      expect(readFileSync(path.join(root, 'features-history.tsx'), 'utf8')).not.toContain('featureHistoryPhase');
      expect(readFileSync(path.join(root, 'tests/features-write/App.tsx'), 'utf8')).toBe("import './fixture';\n");
      expect(readFileSync(path.join(root, 'tests/features-write/fixture.tsx'), 'utf8')).toContain("import '../../features-write-ui-app'");
      const runNotice = generated.indexOf('await app.waitFor("text:Schedule started")');
      const historyPress = generated.indexOf('dialogAnswer = "History"', runNotice);
      expect(generated.slice(runNotice, historyPress)).toContain('await app.waitUntil(() => app.enabled("id:features-task-more"))');
      expect(generated.match(/app\.onDialog\(/g)).toHaveLength(1);
      expect(generated).toContain('expect(dialogAnswers).toBe(historyAnswersBefore + 1)');
      expect(generated).toContain('audit.requests.filter(call => call.method === "PATCH" && call.path === "/api/projects/project/scheduled-tasks").length).toBe(2)');
    }
  }
});

it('memory Host admits exact fixture leases only and never accepts external URLs or unknown capabilities', () => {
  const host = createHost();
  expect(host.call('features.fixture.identity', {})).toBe('features-memory-only');
  expect(() => host.call('runtime.request', { method: 'POST', path: 'https://example.com' })).toThrow();
  expect(() => host.call('runtime.request', { method: 'DELETE', path: '/api/yuri/assistants/bot' })).toThrow('fixture lease');
  expect(() => host.call('speech.synthesize', {})).toThrow('Unknown');
});
it('lost ACK applies one in-memory write, readback reveals it and all audits remain synthetic', () => {
  const host = createHost(), expectedHost = host.call('connection.list', {}).runtimeScope;
  host.call('features.fixture.configure', { lose: 'POST /api/yuri/assistants' });
  const input = { expectedHost, method: 'POST', path: '/api/yuri/assistants', body: { name: 'Created', providerID: 'fixture', modelID: 'model', defaultPrompt: '', workspacePath: null } };
  expect(() => host.call('runtime.request', input)).toThrow('fixture ACK lost');
  const snapshot = host.call('runtime.request', { expectedHost, method: 'GET', path: '/api/yuri/assistants/snapshot' }).body;
  expect(snapshot.assistants.some(bot => bot.name === 'Created')).toBe(true);
  expect(host.call('features.fixture.audit', {}).requests.filter(call => call.method === 'POST')).toHaveLength(1);
});
it('the write fixture has its own narrow capability profile and syntactically valid engine steps', () => {
  const root = path.dirname(fileURLToPath(import.meta.url));
  const config = JSON.parse(readFileSync(path.join(root, 'tests/features-write/nsh.json'), 'utf8'));
  expect(config.capabilities.host).toEqual(['connection.list', 'runtime.request', 'features.fixture.identity', 'features.fixture.configure', 'features.fixture.audit', 'appearance.reset', 'appearance.apply']);
  const source = ts.createSourceFile('fixture.test.ts', readFileSync(path.join(root, 'features-write-ui.test.ts'), 'utf8'), ts.ScriptTarget.ES2023, true);
  let steps: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'steps' && node.initializer && ts.isCallExpression(node.initializer) && ts.isPropertyAccessExpression(node.initializer.expression) && ts.isArrayLiteralExpression(node.initializer.expression.expression)) {
      steps = node.initializer.expression.expression.elements.map(element => { if (!ts.isStringLiteral(element)) throw new Error('literal steps required'); return element.text; });
    }
    ts.forEachChild(node, visit);
  }
  visit(source); expect(steps.length).toBeGreaterThan(20);
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
  expect(() => new AsyncFunction('app', 'expect', steps.join('\n'))).not.toThrow();
});
