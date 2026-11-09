import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { record } from './model';
import { createSetupTour, setupTourPlugins } from './setup-tour-core';
import { setupTourTestScope, type createSetupTourTestHost } from './setup-tour-test-host';
import * as runtimeScope from './runtime-scope';
import type { SettingsRequest } from './settings-protocol';
import * as core from './setup-tour-core';
import { createHistoryImport } from './history-import-core';

const root = path.dirname(fileURLToPath(import.meta.url));
type Host = ReturnType<typeof createSetupTourTestHost>;
let artifact: string | undefined;
function preparedHost(options: Parameters<typeof createSetupTourTestHost>[0] = {}) {
  if (!artifact) {
    const result = spawnSync('bun', ['build', path.join(root, 'setup-tour-test-host.ts'), '--target=node', '--format=cjs'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 5 * 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0); artifact = result.stdout;
  }
  const output = { exports: {} as { createSetupTourTestHost: typeof createSetupTourTestHost } };
  vm.runInNewContext(artifact, { module: output, exports: output.exports, URL: undefined, URLSearchParams: undefined, fetch: undefined, WebSocket: undefined, require: () => { throw new Error('Unexpected bundled Host dependency'); } });
  const host = output.exports.createSetupTourTestHost(options);
  const exports: { request?: SettingsRequest; bindRequest?: (scope: runtimeScope.RuntimeScope) => SettingsRequest } = {};
  const source = ts.transpileModule(readFileSync(path.join(root, 'runtime.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  vm.runInNewContext(source, { exports, require: (id: string) => {
    if (id === 'nsh') return { host: { available: () => true, call: host.call } };
    if (id === './model') return { record };
    if (id === './runtime-scope') return runtimeScope;
    throw new Error('Unexpected runtime dependency: ' + id);
  } });
  return { host, request: exports.bindRequest!(setupTourTestScope), bind: exports.bindRequest!, unbound: exports.request! };
}

describe('prepared strict Host + actual production request/controller (Node VM, not NSH)', () => {
  it('initial opening is GET-only and explicit save writes only config entries, preserving production config files', async () => {
    const productionConfig = readFileSync(path.join(root, 'nsh.json'), 'utf8');
    const { host, request } = preparedHost({ allowedPlugins: setupTourPlugins });
    const tour = createSetupTour({ send: request, directory: '/fixture/tour', current: () => true });
    tour.activate(true); await tour.refresh(); expect(host.audit().writes).toEqual([]);
    await tour.proceed(); expect(tour.snapshot().step).toBe('plugins'); await tour.refresh();
    expect(tour.snapshot().metadata[setupTourPlugins[1]]?.readme).toBe('# Author README 0'); await tour.proceed();
    expect(host.audit().writes).toEqual([...setupTourPlugins]); expect(host.audit().rejected).toEqual([]);
    expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(productionConfig);
  });

  it('rejects unexpected names, paths, queries, scope, method, keys and unconsented writes without wildcard success', () => {
    const { host } = preparedHost(); const before = host.audit();
    const invalid: Array<[string, unknown]> = [
      ['speech.start', {}], ['plugin.install', {}], ['runtime.stream', { path: '/api/event' }],
      ['runtime.request', { path: '/api/config/plugins', method: 'GET' }],
      ['runtime.request', { path: '/api/config/plugins?directory=%2Fwrong', method: 'GET' }],
      ['runtime.request', { path: '/api/config/plugins?directory=%2Ffixture%2Ftour&directory=other', method: 'GET' }],
      ['runtime.request', { path: 'https://external.example.invalid/api/config/plugins', method: 'GET' }],
      ['runtime.request', { path: '/api/config/plugins?directory=%2Ffixture%2Ftour#fragment', method: 'GET' }],
      ['runtime.request', { path: '/api/config/plugins?directory=%2Ffixture%2Ftour', method: 'GET', body: {} }],
      ['runtime.request', { path: '/api/config/plugins?directory=%2Ffixture%2Ftour', method: 'get' }],
      ['runtime.request', { path: '/api/config/plugins/entry?directory=%2Ffixture%2Ftour', method: 'POST', body: { spec: setupTourPlugins[0], scope: 'user' } }],
      ['runtime.request', { path: '/api/voice/settings', method: 'PUT', body: { apiKey: 'synthetic-tour-key' } }],
      ['runtime.request', { path: '/api/yuri/history-import/start', method: 'POST', body: { confirm: true } }],
    ];
    for (const [name, input] of invalid) expect(() => host.call(name, name === 'runtime.request' ? { ...(input as Record<string, unknown>), expectedHost: setupTourTestScope } : input)).toThrow();
    for (const expectedHost of [undefined, { ...setupTourTestScope, hostID: 'other' }, { ...setupTourTestScope, lease: 'other' }, { ...setupTourTestScope, extra: true }]) expect(() => host.call('runtime.request', { path: '/api/config/plugins?directory=%2Ffixture%2Ftour', method: 'GET', expectedHost })).toThrow();
    const after = host.audit(); expect(after.writes).toEqual([]); expect(after.config).toEqual(before.config); expect(after.voice).toEqual(before.voice); expect(after.entries).toEqual(before.entries);
    expect(after.rejected.length).toBeGreaterThan(0); expect(after.requests).toEqual([]);
  });

  it('strict shape checks do not accept extra fields even when a package was explicitly allowed', () => {
    const { host } = preparedHost({ allowedPlugins: [setupTourPlugins[0]], allowedVoice: true });
    const path = '/api/config/plugins/entry?directory=%2Ffixture%2Ftour';
    for (const body of [{ spec: setupTourPlugins[0], scope: 'project' }, { spec: setupTourPlugins[0], scope: 'user', options: {} }, { spec: 'other', scope: 'user' }, { spec: setupTourPlugins[0] }]) expect(() => host.call('runtime.request', { path, method: 'POST', body, expectedHost: setupTourTestScope })).toThrow();
    expect(() => host.call('runtime.request', { path: '/api/voice/settings', method: 'PUT', body: { apiKey: 'not-the-scripted-key' }, expectedHost: setupTourTestScope })).toThrow();
    expect(host.audit().writes).toEqual([]);
  });

  it('legacy unbound write fails closed before reaching even the strict fake Host', async () => {
    const { host, unbound } = preparedHost({ allowedPlugins: setupTourPlugins });
    await expect(unbound('/api/config/plugins/entry?directory=%2Ffixture%2Ftour', 'POST', { spec: setupTourPlugins[0], scope: 'user' })).rejects.toThrow('scope_required');
    expect(host.audit()).toMatchObject({ writes: [], requests: [], rejected: [] });
  });

  it('the actual runtime binder copies its lease at construction; later input mutation cannot retarget its wire', async () => {
    const { host, bind } = preparedHost();
    const scope: { hostID: string; lease: string } = { ...setupTourTestScope };
    const send = bind(scope); scope.lease = 'synthetic-replacement';
    await send('/api/config/plugins?directory=%2Ffixture%2Ftour');
    expect(host.audit()).toMatchObject({ writes: [], rejected: [], requests: [{ path: '/api/config/plugins?directory=%2Ffixture%2Ftour', method: 'GET' }] });
  });
});

type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
/** Executes production event closures with inert JSX nodes. This is not a
 * replacement renderer and cannot certify NSH effects, layout or gestures. */
function productionCallbacks(controller: ReturnType<typeof createSetupTour>, stateBoundary?: Record<string, unknown>) {
  const nodes: Node[] = [], effects: Array<() => void> = [], cleanups: Array<() => void> = [], details: unknown[] = [];
  const jsx = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => { const node = { type, props: props ?? {}, children }; nodes.push(node); return node; };
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  const exports: Record<string, unknown> = {};
  const modules: Record<string, unknown> = {
    nsh: { signal, computed: (read: () => unknown) => read, cleanup: (work: () => void) => cleanups.push(work), effect: (work: () => void) => effects.push(work), untracked: (work: () => unknown) => work(), lifecycle: () => 'active', Image: 'Image', View: 'View', Scroll: 'Scroll', Text: 'Text', openUrl: () => { throw new Error('Unexpected URL open'); } },
    'nsh/base': { Button: 'Button', NavPage: 'NavPage', Sheet: 'Sheet', TextView: 'TextView' },
    './native-sheet': { NativeSheet: 'Sheet' },
    './Icon': { Icon: 'Icon' }, './i18n': { t: (key: string) => key },
    './appearance': { nativeCodeTextViewStyles: () => ({}) },
    './settings-controls': { SettingsGroup: 'SettingsGroup', settingsAction: 'neutral-action' }, './setup-tour-core': core,
    './state': stateBoundary ?? { app: { connection: () => ({ id: 'fixture' }), runtimeScope: () => null }, epoch: () => 1, captureHostRequest: () => { throw new Error('Unexpected native factory construction in injected callback test'); } },
    './runtime-scope': runtimeScope,
    './history-import': { NativeHistoryImportStep: 'NativeHistoryImportStep', createNativeHistoryImport: () => createHistoryImport({ send: async () => { throw new Error('Unexpected history request in Tour-only callback test'); }, current: () => true }) },
  };
  const stateModule = modules['./state'] as { app: { connection: () => { id: string }; runtimeScope: () => runtimeScope.RuntimeScope | null }; epoch: () => number; captureHostRequest: () => SettingsRequest; captureHostOperation?: () => unknown };
  stateModule.captureHostOperation = () => { const scope = stateModule.app.runtimeScope(), generation = stateModule.epoch(), id = stateModule.app.connection().id, request = stateModule.captureHostRequest(); return { scope, generation, request, current: () => id === stateModule.app.connection().id && generation === stateModule.epoch() && runtimeScope.sameRuntimeScope(scope, stateModule.app.runtimeScope()) }; };
  const source = ts.transpileModule(readFileSync(path.join(root, 'setup-tour.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
  vm.runInNewContext(source, { exports, jsx, If: 'If', Each: 'Each', require: (id: string) => {
    if (id.endsWith('.svg')) return { default: 'local-brand-asset' };
    if (id in modules) return modules[id]; throw new Error('Unexpected UI dependency: ' + id);
  } });
  const history = createHistoryImport({ send: async () => { throw new Error('Unexpected history request in injected Tour callback fixture'); }, current: () => true });
  (exports.NativeSetupTourPage as (props: unknown) => unknown)({ controller: { ...controller, historyImport: history }, active: true, onOpenDetail: (detail: unknown) => details.push(detail) });
  for (let index = 0; index < nodes.length; index++) if (nodes[index].type === 'Each') {
    const render = nodes[index].children[0] as (read: () => unknown) => unknown;
    for (const item of nodes[index].props.of as unknown[]) render(() => item);
  }
  const press = (id: string) => {
    const node = nodes.find(item => item.props.testID === id);
    if (!node || typeof node.props.onPress !== 'function') throw new Error('Missing production callback: ' + id);
    (node.props.onPress as () => void)();
  };
  return { nodes, details, press, history, factory: exports.createNativeSetupTour as (input: { directory?: string }) => ReturnType<typeof createSetupTour>, start: () => effects.forEach(work => work()), stop: () => cleanups.forEach(work => work()) };
}

describe('actual Tour TSX callback boundaries (inert JSX only)', () => {
  it('the actual native factory captures its immutable sender once at construction, never on save/retry', async () => {
    const { host, request } = preparedHost({ allowedPlugins: setupTourPlugins });
    let hostID = 'A', generation = 1, captures = 0;
    const lanes: string[] = [];
    const ui = productionCallbacks(createSetupTour({ send: request, current: () => true }), {
      app: { connection: () => ({ id: hostID }), runtimeScope: () => ({ hostID, lease: 'synthetic-factory-lease' }) }, epoch: () => generation,
      captureHostRequest: () => { captures++; const captured = hostID; return (...args: Parameters<SettingsRequest>) => { lanes.push(captured); return request(...args); }; },
    });
    const tour = ui.factory({ directory: '/fixture/tour' }); expect(captures).toBe(1);
    tour.activate(true); await tour.refresh(); await tour.proceed();
    hostID = 'B'; generation++; await tour.refresh(); await tour.proceed(); tour.later();
    expect(captures).toBe(1); expect(new Set(lanes)).toEqual(new Set(['A'])); expect(host.audit().writes).toEqual([setupTourPlugins[0]]);
    expect(tour.snapshot().step).toBe('plugins'); ui.stop();
  });
  it('same Host ID and epoch cannot keep a controller alive after its native lease rotates', async () => {
    const { host, request } = preparedHost({ allowedPlugins: setupTourPlugins });
    let lease = 'synthetic-first';
    const ui = productionCallbacks(createSetupTour({ send: request, current: () => true }), {
      app: { connection: () => ({ id: 'same' }), runtimeScope: () => ({ hostID: 'same', lease }) }, epoch: () => 1, captureHostRequest: () => request,
    });
    const tour = ui.factory({ directory: '/fixture/tour' }); tour.activate(true); await tour.refresh(); const before = host.audit().requests;
    lease = 'synthetic-second'; await tour.proceed(); await tour.refresh(); tour.later();
    expect(host.audit().requests).toEqual(before); expect(host.audit().writes).toEqual([]); expect(tour.snapshot().step).toBe('models'); ui.stop();
  });
  it('has a single system NavPage, native README Sheet and one system glass footer, no WebView', () => {
    const { host, request } = preparedHost(); const tour = createSetupTour({ send: request, current: () => true });
    const ui = productionCallbacks(tour);
    expect(ui.nodes.filter(node => node.type === 'NavPage')).toHaveLength(1);
    expect(ui.nodes.find(node => node.type === 'NavPage')?.props.popOnBack).toBe(true);
    expect(ui.nodes.filter(node => node.type === 'Sheet')).toHaveLength(1);
    expect(ui.nodes.filter(node => (node.props.style as { glassEffect?: string } | undefined)?.glassEffect === 'regular')).toHaveLength(1);
    expect(ui.nodes.some(node => /webview/i.test(String(node.type)))).toBe(false);
    expect(host.audit().requests).toEqual([]); ui.stop();
  });

  it('provider and independent ASR/TTS routes use explicit production callbacks; opening does not save', async () => {
    const { host, request } = preparedHost(); const tour = createSetupTour({ send: request, directory: '/fixture/tour', current: () => true });
    const ui = productionCallbacks(tour); ui.start();
    for (let index = 0; index < 20 && (tour.snapshot().busy || tour.snapshot().loading); index++) await Promise.resolve();
    ui.press('setup-tour-provider-anthropic'); expect(ui.details).toEqual([{ kind: 'provider', providerID: 'anthropic' }]); expect(tour.snapshot().provider).toBe('other');
    tour.move('voice'); await tour.refresh();
    ui.press('setup-tour-asr'); ui.press('setup-tour-tts');
    expect(ui.details.slice(1)).toEqual([{ kind: 'voice', section: 'asr' }, { kind: 'voice', section: 'tts' }]);
    expect(host.audit().writes).toEqual([]); ui.stop();
  });

  it('the real primary callback invokes the production writer only after the explicit press', async () => {
    const { host, request } = preparedHost({ allowedPlugins: [setupTourPlugins[0]] });
    const tour = createSetupTour({ send: request, directory: '/fixture/tour', current: () => true }); const ui = productionCallbacks(tour); ui.start();
    for (let index = 0; index < 30 && (tour.snapshot().busy || tour.snapshot().loading); index++) await Promise.resolve();
    expect(host.audit().writes).toEqual([]); ui.press('setup-tour-continue');
    for (let index = 0; index < 60 && tour.snapshot().busy; index++) await Promise.resolve();
    expect(host.audit().writes).toEqual([setupTourPlugins[0]]); expect(tour.snapshot().step).toBe('plugins'); ui.stop();
  });

  it('README event/back handlers close the sheet first; the import step requires the real owner rather than an unavailable placeholder', async () => {
    const { host, request } = preparedHost(); const tour = createSetupTour({ send: request, directory: '/fixture/tour', current: () => true });
    const ui = productionCallbacks(tour); ui.start();
    for (let index = 0; index < 30 && tour.snapshot().loading; index++) await Promise.resolve();
    tour.move('plugins'); await tour.refresh(); ui.press('setup-tour-readme-' + setupTourPlugins[1]);
    const dismiss = ui.nodes.find(node => node.type === 'NavPage')?.props.onDismiss as () => void;
    const closeSheet = ui.nodes.find(node => node.type === 'Sheet')?.props.onOpenChange as (value: { open: boolean }) => void;
    closeSheet({ open: false }); expect(tour.snapshot().closed).toBe(false);
    tour.move('import');
    expect(ui.nodes.find(node => node.type === 'NativeHistoryImportStep')?.props.controller).toBe(ui.history);
    expect(ui.nodes.find(node => node.props.testID === 'setup-tour-import-unavailable')).toBeUndefined();
    ui.press('setup-tour-import-next'); expect(tour.snapshot().step).toBe('import'); expect(host.audit().writes).toEqual([]);
    dismiss(); expect(tour.snapshot().closed).toBe(true); dismiss(); ui.stop();
  });
});

it('production Tour modules type-check with the generated native declarations, without invoking NSH', () => {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const program = ts.createProgram(['.nsh/types/nsh/globals.d.ts', '.nsh/types/nsh/assets.d.ts', '.nsh/types/nsh/tokens.d.ts', 'setup-tour-core.ts', 'setup-tour-voice.ts', 'setup-tour.tsx', 'setup-tour-details.tsx', 'setup-tour-test-host.ts', 'setup-tour-core.test.ts', 'setup-tour-production.test.ts'].map(file => path.join(root, file)), { ...parsed.options, types: ['node'] });
  const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => {
    const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0);
    return `${diagnostic.file ? path.relative(root, diagnostic.file.fileName) : 'compiler'}:${(position?.line ?? 0) + 1}:${(position?.character ?? 0) + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`;
  });
  expect(diagnostics).toEqual([]);
}, 30_000);

it('tracks the current mobile/Web Tour and retains the actual Host default-field writer rather than duplicating it', () => {
  const web = readFileSync(path.join(root, '../ui/src/components/onboarding/SetupTourDialog.tsx'), 'utf8');
  expect(web).toContain("['tour.models', 'tour.plugins', 'tour.import', 'tour.voice']");
  expect(readFileSync(path.join(root, '../ui/src/apps/MobileApp.tsx'), 'utf8')).toContain('<SetupTourHost autoStart={false}');
  const server = readFileSync(path.join(root, '../web/server/lib/opencode/plugins.js'), 'utf8');
  expect(server).toContain("config = { $schema: 'https://opencode.ai/config.json', lsp: true, ...getConfigForPath(layers, targetPath) }");
  const native = readFileSync(path.join(root, 'setup-tour-core.ts'), 'utf8');
  expect(native).toContain("settingsMutation('plugins'"); expect(native).not.toContain('lsp: true');
});
