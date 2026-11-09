import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as protocol from './history-import-protocol';
import * as core from './history-import-core';
import * as tourCore from './setup-tour-core';
import * as scopes from './runtime-scope';
import { record } from './model';
import { historyImportTestScope, syntheticImportJob, type createHistoryImportTestHost } from './history-import-test-host';
import type { SettingsRequest } from './settings-protocol';

const root = path.dirname(fileURLToPath(import.meta.url));
let bundle: string;
function prepared(options: Parameters<typeof createHistoryImportTestHost>[0] = {}) {
  if (!bundle) {
    const result = spawnSync('bun', ['build', path.join(root, 'history-import-test-host.ts'), '--target=node', '--format=cjs'], { encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
    expect(result.status, result.stderr).toBe(0); bundle = result.stdout;
  }
  const module = { exports: {} as { createHistoryImportTestHost: typeof createHistoryImportTestHost } };
  vm.runInNewContext(bundle, { module, exports: module.exports, URL: undefined, URLSearchParams: undefined, fetch: undefined, WebSocket: undefined, require: () => { throw new Error('Unexpected prepared Host dependency'); } });
  const host = module.exports.createHistoryImportTestHost(options);
  const exports: { bindRawRequest?: (scope: scopes.RuntimeScope) => (path: string, method?: string, body?: unknown) => Promise<{ status: number; body: unknown }> } = {};
  const source = ts.transpileModule(readFileSync(path.join(root, 'runtime.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  vm.runInNewContext(source, { exports, require: (id: string) => {
    if (id === 'nsh') return { host: { available: () => true, call: host.raw } };
    if (id === './model') return { record }; if (id === './runtime-scope') return scopes;
    throw new Error('Unexpected runtime dependency ' + id);
  } });
  const raw = exports.bindRawRequest!(historyImportTestScope);
  const send: SettingsRequest = async (...args) => {
    const response = await raw(...args);
    if (response.status >= 300) throw new protocol.NativeHistoryImportError((response.body as { code: string }).code, response.status);
    return response.body;
  };
  return { host, raw, send, bindRaw: exports.bindRawRequest! };
}
async function drain(owner: core.HistoryImportController) { for (let index = 0; index < 100 && (owner.snapshot().loading || owner.snapshot().scanning || owner.snapshot().writing); index++) await Promise.resolve(); }

describe('prepared strict history Host through actual immutable runtime binder', () => {
  it('executes real controller scan/source-start/exact full receipt without touching production config', async () => {
    const config = readFileSync(path.join(root, 'nsh.json'), 'utf8');
    const f = prepared({ allow: ['scan', 'imported', 'start'] });
    const owner = core.createHistoryImport({ send: f.send, current: () => true, directory: '/fixture/history' }); owner.demand('tour', true); await drain(owner);
    expect(f.host.audit().requests.filter(request => request.path.endsWith('/scan'))).toHaveLength(1);
    owner.select('claude', true); await owner.proceed();
    expect(owner.snapshot()).toMatchObject({ acceptedID: 'synthetic-start-1', pending: null, job: { state: 'running' } });
    expect(f.host.audit().mutations).toEqual(['start']); expect(f.host.audit().rejected).toEqual([]);
    expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(config);
  });
  it('rejects unknown natives, absolute URLs, duplicate queries, wrong scope/lease, methods, extra keys and unconsented mutation', () => {
    const f = prepared();
    const invalid: Array<[string, unknown]> = [
      ['speech.start', {}], ['plugin.install', {}], ['runtime.stream', {}],
      ...['https://external.example.invalid/api/yuri/history-import/job', '/api/yuri/history-import/job?', '/api/yuri/history-import/job?id=unknown', '/api/yuri/history-import/job?id=x&id=x', '/api/yuri/history-import/other', '/api/yuri/history-import/jobs?directory=other'].map(path => ['runtime.request', { path, method: 'GET', expectedHost: historyImportTestScope }] as [string, unknown]),
      ['runtime.request', { path: protocol.importRoute('job'), method: 'GET', expectedHost: { ...historyImportTestScope, lease: 'other' } }],
      ['runtime.request', { path: protocol.importRoute('job'), method: 'GET', expectedHost: { ...historyImportTestScope, extra: true } }],
      ['runtime.request', { path: protocol.importRoute('job'), method: 'GET' }],
      ['runtime.request', { path: protocol.importRoute('job'), method: 'GET', expectedHost: historyImportTestScope, body: {} }],
      ['runtime.request', { path: protocol.importRoute('job'), method: 'DELETE', expectedHost: historyImportTestScope, body: {} }],
      ['runtime.request', { path: protocol.importRoute('start'), method: 'POST', expectedHost: historyImportTestScope, body: { sources: ['claude'], confirm: true, directory: '/fixture/history' } }],
    ];
    for (const [name, value] of invalid) expect(() => f.host.raw(name, value)).toThrow();
    expect(f.host.audit().requests).toEqual([]); expect(f.host.audit().mutations).toEqual([]); expect(f.host.audit().rejected).toHaveLength(invalid.length);
  });
  it('an allowed mutation still rejects guessed selection, destination, confirmation, IDs and injected options', () => {
    const f = prepared({ allow: ['start', 'resume'], jobs: [syntheticImportJob('known', 'interrupted')] });
    for (const body of [
      { sources: [], confirm: true, directory: '/fixture/history' }, { sources: ['unknown'], confirm: true, directory: '/fixture/history' },
      { sources: ['claude', 'claude'], confirm: true, directory: '/fixture/history' }, { sources: ['claude'], confirm: false, directory: '/fixture/history' },
      { sources: ['claude'], confirm: true, directory: '/wrong' }, { sources: ['claude'], confirm: true, directory: '/fixture/history', settings: true },
    ]) expect(() => f.host.raw('runtime.request', { path: protocol.importRoute('start'), method: 'POST', expectedHost: historyImportTestScope, body })).toThrow();
    expect(() => f.host.raw('runtime.request', { path: protocol.importRoute('resume'), method: 'POST', expectedHost: historyImportTestScope, body: { id: 'known', sources: ['claude'], confirm: true } })).toThrow();
    expect(f.host.audit().mutations).toEqual([]);
  });
});

type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
function uiModule(f: ReturnType<typeof prepared>, boundary?: { id: () => string; lease: () => string; epoch: () => number }) {
  const nodes: Node[] = [], effects: Array<() => void> = [], cleanups: Array<() => void> = [], timers: Array<() => void> = [];
  let signalWrites = 0;
  const jsx = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => { const value = { type, props: props ?? {}, children }; nodes.push(value); return value; };
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { signalWrites++; value = next; } }); };
  const modules: Record<string, unknown> = {
    nsh: { signal, computed: (work: () => unknown) => work, cleanup: (work: () => void) => cleanups.push(work), effect: (work: () => void) => effects.push(work), untracked: (work: () => unknown) => work(), lifecycle: () => 'active', colorScheme: () => 'light', locale: () => 'en', reduceMotion: () => true, Image: 'Image', View: 'View', Scroll: 'Scroll', Text: 'Text' },
    'nsh/base': { Button: 'Button', NavPage: 'NavPage', Progress: 'Progress', Sheet: 'Sheet', TextView: 'TextView' },
    './native-sheet': { NativeSheet: 'Sheet' },
    './appearance': { nativeAppearance: { current: () => null }, nativeCodeTextViewStyles: () => ({}) }, './i18n': { language: () => 'en', t: (key: string) => key }, './Icon': { Icon: 'Icon' },
    './state': { app: { connection: () => ({ id: boundary?.id() ?? historyImportTestScope.hostID }), runtimeScope: () => ({ hostID: boundary?.id() ?? historyImportTestScope.hostID, lease: boundary?.lease() ?? historyImportTestScope.lease }) }, epoch: () => boundary?.epoch() ?? 1, captureHostRequest: () => f.send },
    './runtime': { bindRawRequest: f.bindRaw }, './runtime-scope': scopes,
    './history-import-core': core, './history-import-protocol': protocol, './settings-controls': { SettingsGroup: 'SettingsGroup', settingsAction: 'neutral-action' },
  };
  (modules['./state'] as Record<string, unknown>).captureHostOperation = () => {
    const scope = { hostID: boundary?.id() ?? historyImportTestScope.hostID, lease: boundary?.lease() ?? historyImportTestScope.lease }, generation = boundary?.epoch() ?? 1;
    return { scope, generation, request: f.send, current: () => scope.hostID === (boundary?.id() ?? historyImportTestScope.hostID) && scope.lease === (boundary?.lease() ?? historyImportTestScope.lease) && generation === (boundary?.epoch() ?? 1) };
  };
  const exports: Record<string, unknown> = {};
  const source = ts.transpileModule(readFileSync(path.join(root, 'history-import.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
  vm.runInNewContext(source, { exports, jsx, If: 'If', Each: 'Each', setTimeout: (work: () => void) => { timers.push(work); return work; }, clearTimeout: (work: () => void) => { const index = timers.indexOf(work); if (index >= 0) timers.splice(index, 1); }, require: (id: string) => { if (id.endsWith('.svg')) return { default: id }; if (id in modules) return modules[id]; throw new Error('Unexpected import ' + id); } });
  function evaluateTour() {
    const output: Record<string, unknown> = {};
    const text = ts.transpileModule(readFileSync(path.join(root, 'setup-tour.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
    vm.runInNewContext(text, { exports: output, jsx, If: 'If', Each: 'Each', require: (id: string) => {
      if (id === './history-import') return exports;
      if (id === './setup-tour-core') return tourCore;
      if (id.endsWith('.svg')) return { default: id };
      if (id in modules) return modules[id]; throw new Error('Unexpected Tour import ' + id);
    } });
    return output as { createNativeSetupTour: typeof import('./setup-tour').createNativeSetupTour; NativeSetupTourPage: typeof import('./setup-tour').NativeSetupTourPage };
  }
  const render = (name: string, props: Record<string, unknown>) => {
    nodes.length = 0; (exports[name] as (props: unknown) => unknown)(props);
    for (let index = 0; index < nodes.length; index++) if (nodes[index].type === 'Each') {
      const callback = nodes[index].children[0] as (read: () => unknown) => unknown;
      for (const value of nodes[index].props.of as unknown[]) callback(() => value);
    }
  };
  return { nodes, timers, exports, render, evaluateTour, signalWrites: () => signalWrites, start: () => effects.forEach(work => work()), stop: () => cleanups.forEach(work => work()),
    factory: exports.createNativeHistoryImport as (input: { directory?: string }) => core.HistoryImportController,
    press(id: string) { const node = nodes.find(node => node.props.testID === id); if (!node || typeof node.props.onPress !== 'function') throw new Error('Missing actual callback ' + id); (node.props.onPress as () => void)(); },
  };
}

describe('actual native factory and TSX event closures (inert JSX, not an NSH renderer)', () => {
  it('same Host foreground operation can be replaced without losing metadata; a real Host change permanently retires the old owner', async () => {
    const f = prepared({ allow: ['scan', 'imported'] }); let generation = 1, hostID: string = historyImportTestScope.hostID;
    const ui = uiModule(f, { id: () => hostID, lease: () => historyImportTestScope.lease, epoch: () => generation });
    const owner = ui.factory({ directory: '/fixture/history' }); owner.demand('tour', true); await drain(owner); owner.select('claude', true); const scan = owner.snapshot().scan;
    generation++; expect(owner.current()).toBe(false); const before = f.host.audit().requests.length;
    await owner.replaceLane({ send: f.send, current: () => true }); expect(owner.current()).toBe(true); expect(owner.snapshot().scan).toBe(scan); expect(owner.snapshot().selected).toEqual(['claude']);
    expect(f.host.audit().requests.slice(before).every(request => request.method === 'GET')).toBe(true);
    hostID = 'different-host'; expect(owner.current()).toBe(false); hostID = historyImportTestScope.hostID;
    expect(await owner.replaceLane({ send: f.send, current: () => true })).toBe(false); expect(owner.current()).toBe(false);
  });
  it('the actual Tour factory embeds its real history owner, completes Voice navigation from real background action and reuses it on explicit reopen', async () => {
    const f = prepared({ allow: ['scan', 'imported', 'start'] }); const ui = uiModule(f), tourModule = ui.evaluateTour();
    const history = ui.factory({ directory: '/fixture/history' });
    const first = tourModule.createNativeSetupTour({ directory: '/fixture/history', historyImport: history, step: 'import' }); first.activate(true);
    expect(first.historyImport).toBe(history); history.demand('tour', true); await drain(history); await history.scan(); history.select('claude', true); await history.proceed(); await history.proceed();
    expect(first.snapshot().step).toBe('voice'); first.close(); first.dispose(); expect(history.current()).toBe(true);
    const reopened = tourModule.createNativeSetupTour({ directory: '/fixture/history', historyImport: history, step: 'import' }); reopened.activate(true); await history.proceed();
    expect(reopened.snapshot().step).toBe('voice'); expect(f.host.audit().mutations).toEqual(['start']);
    expect(() => tourModule.createNativeSetupTour({ directory: '/wrong', historyImport: history })).toThrow('import_owner_scope_mismatch');
    reopened.dispose(); history.dispose(); expect(ui.timers).toHaveLength(0);
  });
  it('native factory keeps its original lease through reads/retry and preserves real Host error codes', async () => {
    const f = prepared({ allow: ['scan'] }); let lease: string = historyImportTestScope.lease;
    const ui = uiModule(f, { id: () => historyImportTestScope.hostID, epoch: () => 1, lease: () => lease });
    const owner = ui.factory({ directory: '/fixture/history' }); expect(f.host.audit().requests).toEqual([]); owner.demand('tour', true); await drain(owner);
    f.host.script('scan', { status: 409, code: 'import_busy' }); await owner.scan(); expect(owner.snapshot().errors.scan).toBe('import_busy');
    const requests = f.host.audit().requests; lease = 'replacement-same-id'; await owner.scan(); await owner.retry(); expect(f.host.audit().requests).toEqual(requests); expect(f.host.audit().mutations).toEqual([]); owner.dispose();
  });
  it('production source cards show five original asset imports, tri-state labels, <=5 previews and actual select callback', async () => {
    const f = prepared({ allow: ['scan', 'imported'] }); const owner = core.createHistoryImport({ current: () => true, directory: '/fixture/history', send: f.send }); owner.demand('tour', true); await drain(owner); await owner.scan();
    const ui = uiModule(f); ui.render('NativeHistoryImportStep', { controller: owner, active: true, onOpenTasks() {} });
    expect(ui.nodes.filter(node => String(node.props.testID).startsWith('history-import-source-'))).toHaveLength(5);
    expect(ui.nodes.filter(node => String(node.props.testID).startsWith('history-import-preview-'))).toHaveLength(25);
    expect(ui.nodes.find(node => node.props.testID === 'history-import-source-claude')?.props.accessibilityLabel).toContain('historyImport.installed');
    expect(ui.nodes.find(node => node.props.testID === 'history-import-source-codex')?.props.accessibilityLabel).toContain('historyImport.notDetected');
    expect(ui.nodes.find(node => node.props.testID === 'history-import-source-cursor')?.props.accessibilityLabel).toContain('historyImport.installationUnknown');
    ui.press('history-import-source-claude'); expect(owner.snapshot().selected).toEqual(['claude']); expect(f.host.audit().mutations).toEqual([]); ui.stop();
  });
  it('actual Page uses one system NavPage and glass footer; explicit primary starts the real controller; back never cancels Host work', async () => {
    const f = prepared({ allow: ['scan', 'imported', 'start'] }); const owner = core.createHistoryImport({ current: () => true, directory: '/fixture/history', send: f.send }); owner.demand('tour', true); await drain(owner); await owner.scan(); owner.select('codex', true);
    let back = 0; const ui = uiModule(f); ui.render('NativeHistoryImportPage', { controller: owner, active: true, onDismiss: () => { back++; }, onComplete() {}, onOpenTasks() {} });
    expect(ui.nodes.filter(node => node.type === 'NavPage')).toHaveLength(1); expect(ui.nodes.find(node => node.type === 'NavPage')?.props.popOnBack).toBe(true);
    expect(ui.nodes.filter(node => (node.props.style as { glassEffect?: string } | undefined)?.glassEffect === 'regular')).toHaveLength(1);
    expect(ui.nodes.some(node => /webview/i.test(String(node.type)))).toBe(false);
    ui.press('history-import-next'); await drain(owner); expect(f.host.audit().mutations).toEqual(['start']);
    expect(ui.nodes.find(node => node.type === 'NavPage')?.props.onBackPress).toBeUndefined();
    (ui.nodes.find(node => node.type === 'NavPage')?.props.onDismiss as () => void)(); expect(back).toBe(1); expect(f.host.audit().mutations).toEqual(['start']); ui.stop();
  });
  it('task recovery callback uses exact id and switches a missing original selection to Remove', async () => {
    const f = prepared({ allow: ['resume', 'dismiss'], jobs: [{ ...syntheticImportJob('legacy', 'interrupted'), resumable: false }] });
    const owner = core.createHistoryImport({ current: () => true, directory: '/fixture/history', send: f.send }); owner.demand('root', true, 'tasks'); await drain(owner);
    const ui = uiModule(f); ui.render('NativeHistoryImportTasksPage', { controller: owner, active: true, onBack() {} }); ui.press('history-import-recover-legacy'); await drain(owner);
    expect(owner.snapshot().removeActions).toEqual(['legacy']); ui.render('NativeHistoryImportTasksPage', { controller: owner, active: true, onBack() {} }); ui.press('history-import-recover-legacy'); await drain(owner);
    expect(f.host.audit().mutations).toEqual(['dismiss']); expect(owner.tasks()).toEqual([]); ui.stop();
  });

  it('an inactive production Tour step does no signal adoption while the shared visible task owner refreshes', async () => {
    const f = prepared({ jobs: [syntheticImportJob('running')] }), owner = core.createHistoryImport({ current: () => true, send: f.send }); owner.demand('root', true, 'tasks'); await drain(owner);
    const ui = uiModule(f); let active = false;
    ui.render('NativeHistoryImportStep', { controller: owner, get active() { return active; }, onOpenTasks() {} }); ui.start();
    const baseline = ui.signalWrites();
    for (let index = 0; index < 50; index++) await owner.refresh();
    expect(ui.signalWrites()).toBe(baseline);
    active = true; ui.start(); expect(ui.signalWrites()).toBeGreaterThan(baseline); const visibleBaseline = ui.signalWrites(); await owner.refresh(); expect(ui.signalWrites()).toBeGreaterThan(visibleBaseline);
    active = false; ui.start(); const hidden = ui.signalWrites(); await owner.refresh(); expect(ui.signalWrites()).toBe(hidden); ui.stop(); owner.dispose();
  });
});

it('all history-import production modules, fixtures and tests type-check against actual generated declarations', () => {
  const config = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile), parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  const names = ['.nsh/types/nsh/globals.d.ts', '.nsh/types/nsh/assets.d.ts', '.nsh/types/nsh/tokens.d.ts', 'history-import-protocol.ts', 'history-import-core.ts', 'history-import.tsx', 'history-import-test-host.ts', 'history-import-core.test.ts', 'history-import-production.test.ts', 'setup-tour.tsx', 'setup-tour-details.tsx', 'application.tsx', 'App.tsx'];
  const declarations = parsed.fileNames.filter(file => file.endsWith('.d.ts'));
  const program = ts.createProgram([...new Set([...names.map(file => path.join(root, file)), ...declarations])], { ...parsed.options, types: ['node'] });
  const diagnostics = ts.getPreEmitDiagnostics(program).map(diagnostic => { const position = diagnostic.file?.getLineAndCharacterOfPosition(diagnostic.start ?? 0); return `${diagnostic.file ? path.relative(root, diagnostic.file.fileName) : 'compiler'}:${(position?.line ?? 0) + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`; });
  expect(diagnostics).toEqual([]);
}, 30_000);
