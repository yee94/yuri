import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeLayoutDensity } from './native-density';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { readSettingsCollection, scopedSettingsPath, settingsMutation } from './settings-protocol';
import { nativeAgentEditor } from './settings-collections-core';
import * as collectionsCore from './settings-collections-core';
import * as collectionOperations from './settings-collection-operations';
import * as collectionScope from './settings-collection-scope';
import * as collectionJSONC from './settings-collection-jsonc';
import * as settingsSearch from './settings-search-core';
import * as settingsProtocol from './settings-protocol';
import * as model from './model';
import * as projectsSearchCore from './projects-search-core';
import * as runtimeScopeCore from './runtime-scope';
import { createHistoryImport } from './history-import-core';
import { parseNativeImportJobs } from './history-import-protocol';
import { createNotificationSettingsTransport } from './notification-preferences-core';
import { createNotificationRootController } from './notification-root-core';
import { createProjectsAttention, createProjectsAttentionSource } from './projects-attention';
import { readProjectsBlocking } from './projects-attention-blocking';
import { createAboutDiagnosticsRoot } from './settings-about-diagnostics';
import { chatMcpScenario, enterActualChat, globalSettingsScenario, scopedSettingsScenario, typeSettingsURL, verifyActualFileSearch, verifyCommandPaletteToggle, verifySessionSwitcherBack, verifySettingsHomeContent, type SettingsNavigationAudit } from './tests/settings-navigation-production-scenarios';
import { settingsNavigationCapabilities, withSettingsNavigationProductionFixture } from './tests/settings-navigation-production-runner.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const actual = '/fixture/second/.worktrees/topic';
type Fixture = { directory: string; entry: string; host: string };
type Host = { call: (name: string, input?: unknown) => unknown };
type ConnectionSnapshot = import('./runtime').ConnectionSnapshot;
type Audit = SettingsNavigationAudit & { nativeCounts: Record<string, number>; agentDescription: string; instructions: string; mcpURL: string };

/** The actual JS runtime binder, with only its native call boundary replaced by this strict synthetic Host. */
function productionRuntime(host: Host) {
  const imports: Record<string, unknown> = {
    nsh: { host: { available: () => true, call: async (name: string, input: unknown) => host.call(name, input) } },
    './model': model, './runtime-scope': runtimeScopeCore,
  };
  const source = ts.transpileModule(readFileSync(path.join(root, 'runtime.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(source, { exports, require: (name: string) => { if (!(name in imports)) throw new Error('Unexpected runtime dependency: ' + name); return imports[name]; } });
  return exports as typeof import('./runtime');
}

function evaluateHost(fixture: Fixture, initial?: { selected: string | null }) {
  const artifact = readFileSync(fixture.host, 'utf8');
  const syntax = ts.createSourceFile(fixture.host, artifact, ts.ScriptTarget.ES2023, true, ts.ScriptKind.JS);
  expect(syntax.statements.some(node => ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && !!node.moduleSpecifier)).toBe(false);
  const source = ts.transpileModule(artifact, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 }, reportDiagnostics: true });
  expect(source.diagnostics ?? []).toEqual([]);
  const context = vm.createContext({});
  expect(vm.runInContext('typeof URL + ":" + typeof URLSearchParams', context)).toBe('undefined:undefined');
  const exports: Record<string, unknown> = {};
  vm.runInContext(`(function(exports) { ${source.outputText}\n})`, context)(exports);
  const host = (exports.createHost as (initial?: { selected: string | null }) => Host)(initial);
  const runtime = productionRuntime(host);
  const snapshot = () => runtime.connectionSnapshotFrom(host.call('connection.list', {}));
  const scope = snapshot().runtimeScope;
  return { host, scope, snapshot, runtime, bindRequest: runtime.bindRequest, send: runtime.bindRequest(scope), audit: () => host.call('settingsNavigation.fixture.audit', {}) as Audit };
}
const isolatedHost = (initial?: { selected: string | null }): ReturnType<typeof evaluateHost> => withSettingsNavigationProductionFixture(root, (fixture: Fixture) => evaluateHost(fixture, initial));
const flushCollectionEffects = async () => { for (let tick = 0; tick < 100; tick++) await Promise.resolve(); };

/** Executes original controller/page callbacks only; inert JSX records are not navigation or a replacement search renderer. */
function productionSearchCallbacks(send: (path: string) => Promise<unknown>) {
  type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
  const nodes: Node[] = [], cleanups: Array<() => void> = [];
  const jsx = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => { const node = { type, props: props ?? {}, children }; nodes.push(node); return node; };
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
  const imports: Record<string, unknown> = {
    nsh: { signal, lifecycle: () => 'active', computed: (work: () => unknown) => work, effect: (work: () => void) => work(), untracked: (work: () => unknown) => work(), cleanup: (work: () => void) => cleanups.push(work), List: 'List', Text: 'Text', View: 'View' },
    'nsh/base': { Button: 'Button', Input: 'Input', NavPage: 'NavPage' }, './Icon': { Icon: 'Icon' }, './i18n': { t: (key: string) => key },
    './model': model, './projects-search-core': projectsSearchCore, './runtime': { request: send }, './state': { captureHostRequest: () => send, captureHostOperation: () => ({ generation: 1, scope: null, current: () => true, request: send }), epoch: () => 1, app: { connection: () => ({ id: 'settings-navigation-production' }), runtimeScope: () => null, projects: () => [] } },
  };
  const pageOperationsSource = ts.transpileModule(readFileSync(path.join(root, 'page-operations.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  const pageOperations: Record<string, unknown> = {};
  vm.runInNewContext(pageOperationsSource, { exports: pageOperations, require: (name: string) => { if (!(name in imports)) throw new Error('Unexpected page operation dependency: ' + name); return imports[name]; } });
  imports['./page-operations'] = pageOperations;
  const source = ts.transpileModule(readFileSync(path.join(root, 'projects-search.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(source, { exports, jsx, If: 'If', Each: 'Each', setTimeout, clearTimeout, require: (name: string) => { if (!(name in imports)) throw new Error('Unexpected search dependency: ' + name); return imports[name]; } });
  return {
    module: exports as typeof import('./projects-search'),
    mountCallbacks(focusDirectory: string | undefined, onSelect: () => void) {
      (exports as typeof import('./projects-search')).ProjectsSearchPage({ commands: [{ id: 'open-settings', title: 'Open Settings', group: 'commands', onSelect }], focusDirectory, projects: [], onOpenChat() {}, onOpenFile() {} });
      const input = nodes.find(node => node.props.testID === 'projects-global-search');
      const list = nodes.find(node => node.type === 'List');
      const row = (list?.props.each as Array<{ key: string }> | undefined)?.find(row => row.key === 'command:open-settings');
      if (!input || !list || !row) throw new Error('Production Search callbacks missing');
      (list.children[0] as (row: () => unknown) => unknown)(() => row);
      const command = nodes.find(node => node.props.testID === 'projects-search-command:open-settings');
      if (!command) throw new Error('Production command callback missing');
      return { change: (value: string) => (input.props.onChange as (event: { value: string }) => void)({ value }), select: command.props.onPress as () => void };
    },
    dispose: () => cleanups.forEach(work => work()),
  };
}

/** Callback execution only: JSX nodes are inert, not an alternate NSH renderer or navigation owner. */
function collectionEditorCallbacks(fixture: ReturnType<typeof evaluateHost>, page: 'mcp' | 'agents' | 'skills.installed' = 'mcp', entity = 'scope-mcp', field = 'url') {
  type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
  type Lifetime = ReturnType<typeof import('./settings-controls').settingsPageLifetime>;
  let lifetime: Lifetime | undefined;
  const nodes: Node[] = [];
  const reactive = ['when', 'of', 'value', 'disabled', 'active'];
  const jsx = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
    const observed = { ...props };
    for (const key of reactive) if (typeof observed[key] === 'function') Object.defineProperty(observed, key, { get: observed[key] as () => unknown });
    const node = { type, props: observed, children }; nodes.push(node); return node;
  };
  type Observer = { run: () => void; dependencies: Set<Set<Observer>>; alive: boolean };
  let observer: Observer | null = null;
  const scheduled = new Set<Observer>(), cleanups: Array<() => void> = [];
  const signal = <T>(initial: T) => {
    let value = initial; const subscribers = new Set<Observer>();
    return Object.assign(() => { if (observer) { subscribers.add(observer); observer.dependencies.add(subscribers); } return value; }, { set(next: T) {
      if (Object.is(value, next)) return; value = next;
      for (const effect of subscribers) if (effect.alive && !scheduled.has(effect)) {
        scheduled.add(effect); queueMicrotask(() => { scheduled.delete(effect); if (effect.alive) effect.run(); });
      }
    } });
  };
  const untracked = <T>(work: () => T) => { const previous = observer; observer = null; try { return work(); } finally { observer = previous; } };
  const effect = (work: () => void) => {
    const effect: Observer = { alive: true, dependencies: new Set(), run() {
      effect.dependencies.forEach(dependency => dependency.delete(effect)); effect.dependencies.clear();
      const previous = observer; observer = effect; try { work(); } finally { observer = previous; }
    } };
    cleanups.push(() => { effect.alive = false; effect.dependencies.forEach(dependency => dependency.delete(effect)); effect.dependencies.clear(); });
    effect.run();
  };
  const generation = signal(1), ready = signal(true), foreground = signal(true), active = signal(true);
  const connection = signal(fixture.snapshot().connections.find(row => row.id === fixture.scope?.hostID) ?? null);
  const runtimeScope = signal(fixture.scope);
  const stateSyntax = ts.createSourceFile('state.ts', readFileSync(path.join(root, 'state.ts'), 'utf8'), ts.ScriptTarget.ES2023, true);
  const declaration = stateSyntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'captureHostOperation');
  if (!declaration) throw new Error('Missing production captureHostOperation');
  const operationExports: { captureHostOperation?: typeof import('./state').captureHostOperation } = {};
  const operationContext = vm.createContext({ exports: operationExports, ...runtimeScopeCore, bindRequest: fixture.runtime.bindRequest,
    runtimeReady: ready, switching: false, lifecycle: () => foreground() ? 'active' : 'inactive', app: { connection, runtimeScope } });
  Object.defineProperty(operationContext, 'generation', { get: generation });
  vm.runInContext(ts.transpileModule(declaration.getText(stateSyntax), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, operationContext);
  const captureHostOperation = operationExports.captureHostOperation!;
  const modules: Record<string, unknown> = {
    nsh: { signal, cleanup: (work: () => void) => cleanups.push(work), effect, untracked, Scroll: 'Scroll', Text: 'Text', View: 'View' },
    'nsh/base': { Button: 'Button', Input: 'Input', Select: 'Select', Switch: 'Switch', TextView: 'TextView', AlertDialog: {} },
    './native-select': { NativeSelect: 'NativeSelect' },
    './appearance': { nativeCodeTextViewStyles: () => ({}), nativeDensity: () => nativeLayoutDensity(100) },
    './native-editor-style': { nativeEditorTextStyle: () => ({}) },
    './model': model, './runtime': fixture.runtime, './state': { captureHostRequest: () => fixture.runtime.bindRequest(runtimeScope()), captureHostOperation, epoch: generation, app: { connection, runtimeScope } },
    './i18n': { t: (key: string) => key }, './Icon': { Icon: 'Icon' }, './settings-protocol': settingsProtocol, './settings-collections-core': collectionsCore,
    './settings-collection-operations': collectionOperations, './settings-search-core': settingsSearch,
    './settings-collection-scope': collectionScope, './settings-collection-jsonc': collectionJSONC,
    './settings-collection-kv': { SettingsCollectionKV: 'SettingsCollectionKV' }, './settings-collection-picker': { SettingsCollectionPicker: 'SettingsCollectionPicker' },
    './settings-collection-plugins': { SettingsCollectionPlugins: 'SettingsCollectionPlugins' }, './settings-collection-directory': { SettingsCollectionDirectory: 'SettingsCollectionDirectory' },
    './native-sheet': { NativeSheet: 'NativeSheet' },
    './settings-providers': { SettingsProviders: 'SettingsProviders' }, './settings-skill-files': { SettingsSkillFiles: 'SettingsSkillFiles' },
    './settings-permissions': { SettingsPermissions: 'SettingsPermissions', SettingsSavedPermissions: 'SettingsSavedPermissions' },
    './settings-mcp-live': { SettingsMcpLive: 'SettingsMcpLive' }, './settings-plugin-runtime': { SettingsPluginRuntime: 'SettingsPluginRuntime' }, './settings-mcp-import': { SettingsMcpImport: 'SettingsMcpImport' },
  };
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && reactive.includes(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), ts.visitNode(node.initializer.expression, visit) as ts.Expression)));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  const evaluate = (filename: string) => {
    const source = ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { before: [lazy] } }).outputText;
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(source, { exports, jsx, If: 'If', Each: 'Each', require: (id: string) => { if (!(id in modules)) throw new Error('Unexpected callback dependency: ' + id); return modules[id]; } });
    return exports;
  };
  const controls = evaluate('settings-controls.tsx');
  const createLifetime = controls.settingsPageLifetime as (active?: () => boolean) => Lifetime;
  modules['./settings-controls'] = { ...controls, settingsPageLifetime: (current?: () => boolean) => { lifetime = createLifetime(current); return lifetime; } };
  const collection = evaluate('settings-collections.tsx').SettingsCollection as (props: Record<string, unknown>) => unknown;
  collection({ page, entity, directory: actual, get active() { return active(); }, onOpen() {}, onBack() {} });
  const input = nodes.find(node => node.props.testID === 'settings-' + field);
  const save = nodes.find(node => node.type === 'Button' && node.children.some(child => (child as Node)?.children?.includes('settings.plugins.page.action.save')));
  if (!input || !save || !lifetime) throw new Error('Production editor callback not found');
  return {
    lifetime,
    edit: input.props.onChange as (value: string) => void,
    save: save.props.onPress as () => void,
    value: () => input.props.value,
    captureHostOperation,
    renew: () => { generation.set(generation() + 1); runtimeScope.set(fixture.snapshot().runtimeScope); },
    setForeground: (value: boolean) => foreground.set(value),
    dispose: () => cleanups.slice().reverse().forEach(work => work()),
  };
}

describe('hardware shortcut driver contracts (pure; no NSH or browser module execution)', () => {
  it('guards the exact Web defaults by reading only shortcut metadata strings', () => {
    const filename = path.join(root, '../ui/src/lib/shortcuts.ts');
    const syntax = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
    const declaration = syntax.statements.filter(ts.isVariableStatement).flatMap(node => [...node.declarationList.declarations]).find(node => ts.isIdentifier(node.name) && node.name.text === 'SHORTCUT_ACTIONS');
    const initializer = declaration?.initializer && ts.isAsExpression(declaration.initializer) ? declaration.initializer.expression : declaration?.initializer;
    if (!initializer || !ts.isArrayLiteralExpression(initializer)) throw new Error('Missing Web shortcut metadata array');
    const defaults = initializer.elements.filter(ts.isObjectLiteralExpression).map(node => Object.fromEntries(node.properties.filter(ts.isPropertyAssignment).flatMap(property => {
      if (!ts.isIdentifier(property.name) || !['id', 'defaultCombo'].includes(property.name.text) || !ts.isStringLiteral(property.initializer)) return [];
      return [[property.name.text, property.initializer.text]];
    })));
    for (const [id, combo] of [['open_command_palette', 'mod+p'], ['toggle_sidebar', 'mod+b']]) {
      expect(defaults.filter(row => row.id === id)).toEqual([{ id, defaultCombo: combo }]);
    }
  });

  it('uses the documented Keyboard.press API twice, waits for closure and checks the retained draft', async () => {
    let palette = false;
    const app = {
      keyboard: { press: vi.fn(async (key: string) => { expect(key).toBe('mod+p'); palette = !palette; }) },
      waitFor: vi.fn(async (selector: string, options?: { state?: string | null } | null) => {
        if (selector === 'id:projects-global-search') expect(palette).toBe(options?.state !== 'gone');
        else { expect(selector).toBe('id:composer'); expect(palette).toBe(false); }
      }),
      value: vi.fn(() => 'Unsaved actual worktree draft'),
    };
    await verifyCommandPaletteToggle(app, expect);
    expect(app.keyboard.press.mock.calls).toEqual([['mod+p'], ['mod+p']]);
    expect(app.waitFor.mock.calls).toEqual([['id:projects-global-search'], ['id:projects-global-search', { state: 'gone' }], ['id:composer']]);
    expect(app.value).toHaveBeenCalledExactlyOnceWith('id:composer');
    app.value.mockReturnValueOnce('Lost draft');
    await expect(verifyCommandPaletteToggle(app, expect)).rejects.toThrow();
  });

  it('checks zero duplicate Settings content titles without inventing a native navigation title API', () => {
    const app = { shows: (selector: string) => selector === 'id:settings-search', texts: () => ['Agents', 'Skills', 'MCP'] };
    verifySettingsHomeContent(app, expect);
    expect(() => verifySettingsHomeContent({ ...app, texts: () => ['Settings', 'Agents'] }, expect)).toThrow();
    expect(() => verifySettingsHomeContent({ ...app, shows: () => false }, expect)).toThrow();
  });

  it('uses the actual ProjectsHome search control and Back to check a retained Chat rather than waiting for a system title', async () => {
    let picker = false;
    const app = {
      keyboard: { press: vi.fn(async (key: string) => { expect(key).toBe('mod+b'); picker = true; }) },
      back: vi.fn(async () => { expect(picker).toBe(true); picker = false; }),
      waitFor: vi.fn(async (selector: string, options?: { state?: string | null } | null) => {
        if (selector === 'id:projects-open-search') expect(picker).toBe(options?.state !== 'gone');
        else { expect(selector).toBe('id:composer'); expect(picker).toBe(false); }
      }),
      shows: (selector: string) => selector === 'id:composer' && !picker,
      value: vi.fn(() => 'Unsaved actual worktree draft'),
    };
    await verifySessionSwitcherBack(app, expect);
    expect(app.keyboard.press.mock.calls).toEqual([['mod+b']]);
    expect(app.back).toHaveBeenCalledOnce();
    expect(app.waitFor.mock.calls).toEqual([['id:projects-open-search'], ['id:projects-open-search', { state: 'gone' }], ['id:composer']]);
  });

  it('checks the complete typed URL immediately and keyboard-only continuation; rejects the reported h and lost focus', async () => {
    let value = '', focused = true;
    const url = 'https://mcp.example.invalid/edited';
    const app = {
      clear: vi.fn(async (selector: string) => { expect(selector).toBe('id:settings-url'); value = ''; }),
      type: vi.fn(async (selector: string, text: string) => { expect(selector).toBe('id:settings-url'); for (const character of text) value += character; }),
      value: vi.fn((selector: string) => { expect(selector).toBe('id:settings-url'); return value; }),
      keyboard: { press: vi.fn(async (key: string) => { if (focused) value = key === 'backspace' ? value.slice(0, -1) : value + key; }) },
    };
    await typeSettingsURL(app, expect);
    expect(app.type.mock.calls).toEqual([['id:settings-url', url]]);
    expect(app.keyboard.press.mock.calls).toEqual([['x'], ['backspace']]);
    expect(value).toBe(url);
    focused = false;
    await expect(typeSettingsURL(app, expect)).rejects.toThrow();
    app.type.mockImplementationOnce(async () => { value = 'h'; });
    await expect(typeSettingsURL(app, expect)).rejects.toThrow();
  });
});

describe('settings navigation strict production Host (pure VM; not route/engine evidence)', () => {
  it('parses the sole current-scope root history jobs read as no jobs using the real protocol', async () => {
    const { send, scope, audit } = isolatedHost();
    expect(parseNativeImportJobs(await send('/api/yuri/history-import/jobs'))).toEqual([]);
    expect(audit().requests).toEqual([{ path: '/api/yuri/history-import/jobs', resource: '/api/yuri/history-import/jobs', method: 'GET', expectedHost: scope }]);
    expect(audit().writes).toEqual([]); expect(audit().rejected).toEqual([]);
  });

  it('real root tasks demand reads only jobs, deduplicates demand and cancels polling when hidden without job/scan', async () => {
    const { send, audit } = isolatedHost(), schedule = vi.fn(() => 'synthetic-task-timer'), cancel = vi.fn();
    const monitor = createHistoryImport({ send, current: () => true, clock: { schedule, cancel } });
    try {
      expect(audit().requests).toEqual([]);
      monitor.demand('projects-root', true, 'tasks');
      await monitor.refresh();
      expect(monitor.snapshot()).toMatchObject({ job: null, jobs: [], jobsReady: true, errors: {}, loading: false, scanning: false, writing: false });
      expect(audit().requests.map(row => [row.path, row.method])).toEqual([['/api/yuri/history-import/jobs', 'GET']]);
      expect(audit().requests.filter(row => row.path === '/api/yuri/history-import/job')).toEqual([]);
      expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 15000);
      monitor.demand('projects-root', true, 'tasks');
      expect(audit().requests).toHaveLength(1); expect(schedule).toHaveBeenCalledOnce();
      monitor.demand('projects-root', false, 'tasks');
      expect(cancel).toHaveBeenCalledExactlyOnceWith('synthetic-task-timer');
      await monitor.refresh();
      expect(audit().requests).toHaveLength(1); expect(audit().writes).toEqual([]); expect(audit().rejected).toEqual([]);
    } finally { monitor.dispose(); }
  });

  it('rejects history-monitor legacy/extra-query/body/write/unknown-prefix calls and stale scope after A→B→A', async () => {
    const { host, send, scope, audit } = isolatedHost();
    let rejected = 0;
    const deny = (input: Record<string, unknown>) => { expect(() => host.call('runtime.request', input)).toThrow(); rejected++; };
    for (const route of ['jobs']) {
      const path = '/api/yuri/history-import/' + route;
      deny({ path, method: 'GET' });
      for (const query of ['?id=synthetic-job', '?directory=%2Ffixture%2Fsecond', '?extra=true', '?']) deny({ path: path + query, method: 'GET', expectedHost: scope });
      for (const body of [undefined, null, {}]) deny({ path, method: 'GET', body, expectedHost: scope });
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) deny({ path, method, expectedHost: scope });
    }
    for (const route of ['job', 'scan', 'start', 'cancel', 'resume', 'dismiss', 'imported', 'sources', 'job/other']) {
      for (const method of ['GET', 'POST']) deny({ path: '/api/yuri/history-import/' + route, method, expectedHost: scope });
    }
    host.call('connection.select', { id: 'settings-navigation-production-secondary' });
    host.call('connection.select', { id: scope!.hostID });
    await expect(send('/api/yuri/history-import/jobs')).rejects.toThrow(); rejected++;
    expect(audit().writes).toEqual([]); expect(audit().rejected).toHaveLength(rejected);
  });

  it('publishes the exact synthetic scope snapshot, rotates every select including A→B→A, but never rotates on rename', () => {
    const { host, snapshot, scope, audit } = isolatedHost();
    const raw = host.call('connection.list', {}) as ConnectionSnapshot;
    expect(Object.keys(raw).sort()).toEqual(['connections', 'runtimeScope', 'selected']);
    expect(raw).toEqual(snapshot());
    expect(scope).toEqual({ hostID: 'settings-navigation-production', lease: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i) });
    const renamed = host.call('connection.rename', { id: scope!.hostID, version: 'legacy', label: 'Renamed synthetic Host' }) as ConnectionSnapshot;
    expect(renamed.runtimeScope).toEqual(scope); expect(renamed.selected).toBe(scope!.hostID);
    expect(renamed.connections.find(row => row.id === scope!.hostID)?.label).toBe('Renamed synthetic Host');
    const secondary = host.call('connection.select', { id: 'settings-navigation-production-secondary' }) as ConnectionSnapshot;
    expect(secondary.runtimeScope?.hostID).toBe(secondary.selected); expect(secondary.runtimeScope?.lease).not.toBe(scope!.lease);
    const returned = host.call('connection.select', { id: scope!.hostID }) as ConnectionSnapshot;
    expect(returned.selected).toBe(scope!.hostID); expect(returned.runtimeScope?.hostID).toBe(scope!.hostID);
    expect(returned.runtimeScope?.lease).not.toBe(scope!.lease); expect(returned.runtimeScope?.lease).not.toBe(secondary.runtimeScope?.lease);
    const reselected = host.call('connection.select', { id: scope!.hostID }) as ConnectionSnapshot;
    expect(reselected.runtimeScope?.lease).not.toBe(returned.runtimeScope?.lease);
    expect(audit().writes).toEqual([]); expect(audit().rejected).toEqual([]);
  });

  it('keeps synthetic handoff controls out of the engine capability grants and rejects malformed/unknown controls', () => {
    const { host, snapshot, scope, audit } = isolatedHost();
    expect(settingsNavigationCapabilities).not.toContain('connection.select');
    expect(settingsNavigationCapabilities).not.toContain('connection.rename');
    for (const [name, input] of [
      ['connection.select', { id: scope!.hostID, extra: true }], ['connection.select', { id: 'unknown' }],
      ['connection.rename', { id: scope!.hostID, version: 'stale', label: 'Renamed' }],
      ['connection.rename', { id: scope!.hostID, version: 'legacy', label: 'Renamed', extra: true }],
      ['connection.rotateLease', {}],
    ] as const) expect(() => host.call(name, input)).toThrow();
    expect(snapshot().runtimeScope).toEqual(scope); expect(snapshot().selected).toBe(scope!.hostID);
    expect(audit().writes).toEqual([]); expect(audit().rejected).toHaveLength(5);
  });

  it('accepts current bound stream/stop envelopes from the new state owner but validates their optional scope exactly', () => {
    const { host, scope, audit } = isolatedHost();
    expect(host.call('runtime.stream', { path: '/api/yuri/events', key: 'global', expectedHost: scope })).toBe(true);
    expect(host.call('runtime.stop', { key: 'global', expectedHost: scope })).toBe(true);
    for (const expectedHost of [{ ...scope, extra: true }, { ...scope, lease: 'stale' }, null]) {
      expect(() => host.call('runtime.stream', { path: '/api/yuri/events', key: 'global', expectedHost })).toThrow();
      expect(() => host.call('runtime.stop', { key: 'global', expectedHost })).toThrow();
    }
    expect(audit().requests).toEqual([]); expect(audit().writes).toEqual([]); expect(audit().rejected).toHaveLength(6);
  });

  it('requires exact current expectedHost on non-GET, validates supplied GET scope, and allows only explicit read-only legacy omission', () => {
    const { host, scope, audit } = isolatedHost();
    const resource = scopedSettingsPath('/api/config/mcp/scope-mcp', actual);
    const body = { url: 'https://mcp.example.invalid/edited', scope: 'project' };
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(() => host.call('runtime.request', { path: resource, method, body })).toThrow('Missing settings navigation expectedHost');
    expect(host.call('runtime.request', { path: '/api/config/settings', expectedHost: scope })).toMatchObject({ status: 200 });
    expect(host.call('runtime.request', { path: '/api/config/settings' })).toMatchObject({ status: 200 });
    const invalid: unknown[] = [undefined, null, [], {}, scope!.hostID, { hostID: scope!.hostID }, { lease: scope!.lease }, { ...scope, extra: true }, { hostID: 'other', lease: scope!.lease }, { hostID: scope!.hostID, lease: 'obsolete' }, { hostID: scope!.hostID, lease: 1 }, { hostID: scope!.hostID, lease: {} }, Object.create(scope)];
    for (const expectedHost of invalid) {
      expect(() => host.call('runtime.request', { path: '/api/config/settings', expectedHost })).toThrow();
      expect(() => host.call('runtime.request', { path: resource, method: 'PATCH', body, expectedHost })).toThrow();
    }
    expect(audit().writes).toEqual([]); expect(audit().mcpURL).toBe('https://mcp.example.invalid/original');
    expect(audit().requests).toHaveLength(2); expect(audit().rejected).toHaveLength(4 + invalid.length * 2);
  });

  it('uses the real JS binder to freeze captured scope and fail non-GET locally when the snapshot has no authority', async () => {
    const { runtime, scope, snapshot, audit } = isolatedHost();
    const supplied: { hostID: string; lease: string } = { ...scope! };
    const captured = runtime.bindRequest(supplied);
    supplied.lease = 'changed-after-capture';
    await captured('/api/config/settings');
    expect(audit().requests[0].expectedHost).toEqual(scope);
    await runtime.request('/api/config/themes');
    expect(audit().requests[1]).toEqual({ path: '/api/config/themes', resource: '/api/config/themes', method: 'GET' });
    const legacy = runtime.connectionSnapshotFrom({ ...snapshot(), runtimeScope: null });
    expect(legacy.selected).toBe(scope!.hostID);
    const legacyReadOnly = runtime.bindRequest(legacy.runtimeScope), before = audit().nativeCounts['runtime.request'];
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(legacyReadOnly('/api/config/settings', method, {})).rejects.toThrow('scope_required');
    expect(audit().nativeCounts['runtime.request']).toBe(before); expect(audit().writes).toEqual([]);
    const missing = isolatedHost({ selected: null });
    expect(missing.snapshot().selected).toBeNull(); expect(missing.snapshot().runtimeScope).toBeNull();
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) await expect(missing.send('/api/config/settings', method, {})).rejects.toThrow('scope_required');
    expect(missing.audit().nativeCounts['runtime.request']).toBeUndefined();
    expect(missing.audit().requests).toEqual([]); expect(missing.audit().writes).toEqual([]); expect(missing.audit().rejected).toEqual([]);
  });

  it.each([
    ['/api/config/agents/build', { native: { description: 'Saved in actual worktree' }, scope: 'project' }],
    ['/api/config/skills/scope-skill', { instructions: 'Actual worktree instructions edited', targetPath: actual + '/.agents/skills/scope-skill/SKILL.md' }],
    ['/api/config/mcp/scope-mcp', { url: 'https://mcp.example.invalid/edited', scope: 'project' }],
  ] as const)('rejects captured %s resumed across await after A→B→A, even though current Host ID is restored', async (path, body) => {
    const { host, scope, snapshot, send, bindRequest, audit } = isolatedHost();
    let resume!: () => void;
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const resource = scopedSettingsPath(path, actual);
    const pending = (async () => { await gate; return send(resource, 'PATCH', body); })();
    host.call('connection.select', { id: 'settings-navigation-production-secondary' });
    host.call('connection.select', { id: scope!.hostID });
    expect(snapshot().selected).toBe(scope!.hostID); expect(snapshot().runtimeScope?.lease).not.toBe(scope!.lease);
    resume();
    await expect(pending).rejects.toThrow();
    expect(audit().writes).toEqual([]); expect(audit().requests).toEqual([]); expect(audit().rejected).toHaveLength(1);
    expect(audit()).toMatchObject({ mcpURL: 'https://mcp.example.invalid/original', agentDescription: 'Actual worktree agent', instructions: 'Original worktree instructions' });
    await expect(send('/api/config/settings')).rejects.toThrow();
    const current = snapshot().runtimeScope;
    await bindRequest(current)(resource, 'PATCH', body);
    expect(audit().writes).toEqual([{ path, directory: actual, body }]);
    expect(audit().requests).toEqual([{ path, resource, method: 'PATCH', body, expectedHost: current }]);
  });

  it('queries files only for a nonblank query with actual Focus and returns the visible proof-file wire', async () => {
    const { send, audit, scope } = isolatedHost();
    const search = productionSearchCallbacks(send);
    let focus: string | undefined = actual;
    const controller = search.module.createProjectsSearchController(() => focus);
    try {
      await controller.search(''); await controller.search('   ');
      expect(audit().requests.filter(row => row.path === '/api/fs/find')).toEqual([]);
      focus = undefined;
      await controller.search('worktree-scope-proof');
      expect(audit().requests.filter(row => row.path === '/api/fs/find')).toEqual([]);
      focus = actual;
      await controller.search('worktree-scope-proof');
      expect(controller.files()).toEqual([{ path: 'notes/worktree-scope-proof.txt', directory: actual }]);
      expect(projectsSearchCore.projectSearchGroups({ query: 'worktree-scope-proof', commands: [], projects: [], sessions: controller.sessions(), messages: controller.messages(), files: controller.files() }).files).toEqual(controller.files());
      expect(controller.pending()).toEqual([]); expect(controller.errors()).toEqual({});
      expect(audit().requests.filter(row => row.path === '/api/fs/find')).toEqual([{ path: '/api/fs/find', resource: '/api/fs/find?location%5Bdirectory%5D=%2Ffixture%2Fsecond%2F.worktrees%2Ftopic&query=worktree-scope-proof&limit=40&type=file', method: 'GET', expectedHost: scope }]);
      expect(audit().rejected).toEqual([]);
    } finally { search.dispose(); }
  });

  it.each([undefined, actual])('the real page cancels local-command debounce without any file request (Focus: %s)', async focus => {
    vi.useFakeTimers();
    const { send, audit } = isolatedHost(), selected = vi.fn();
    const search = productionSearchCallbacks(send);
    try {
      const page = search.mountCallbacks(focus, selected);
      page.change('Open Settings');
      expect(audit().requests.filter(row => row.path === '/api/fs/find')).toEqual([]);
      page.select();
      await vi.runAllTimersAsync();
      expect(selected).toHaveBeenCalledOnce();
      expect(audit().requests.filter(row => ['/api/fs/find', '/api/yuri/content-search'].includes(row.path))).toEqual([]);
      expect(audit().rejected).toEqual([]);
    } finally { search.dispose(); vi.useRealTimers(); }
  });

  it('the real page debounces explicit file input and sends only the final query to actual Focus', async () => {
    vi.useFakeTimers();
    const { send, audit, scope } = isolatedHost(), search = productionSearchCallbacks(send);
    try {
      const page = search.mountCallbacks(actual, vi.fn());
      page.change('worktree');
      await vi.advanceTimersByTimeAsync(200);
      page.change('worktree-scope-proof');
      await vi.advanceTimersByTimeAsync(249);
      expect(audit().requests.filter(row => row.path === '/api/fs/find')).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(audit().requests.filter(row => row.path === '/api/fs/find')).toEqual([{ path: '/api/fs/find', resource: '/api/fs/find?location%5Bdirectory%5D=%2Ffixture%2Fsecond%2F.worktrees%2Ftopic&query=worktree-scope-proof&limit=40&type=file', method: 'GET', expectedHost: scope }]);
      expect(audit().rejected).toEqual([]);
    } finally { search.dispose(); vi.useRealTimers(); }
  });

  it('rejects empty or whitespace-only file queries rather than manufacturing search demand', async () => {
    const { send, audit } = isolatedHost();
    for (const query of ['', '   ']) await expect(send('/api/fs/find?location%5Bdirectory%5D=%2Ffixture%2Fsecond%2F.worktrees%2Ftopic&query=' + encodeURIComponent(query) + '&limit=40&type=file')).rejects.toThrow();
    expect(audit().rejected).toHaveLength(2); expect(audit().writes).toEqual([]);
  });

  it('constructs remote MCP editors as declarative component children, not reactive field factory expressions (static mount-boundary guard)', () => {
    const filename = path.join(root, 'settings-collections.tsx');
    const syntax = ts.createSourceFile(filename, readFileSync(filename, 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
    let remote: ts.JsxElement | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) && node.openingElement.tagName.getText(syntax) === 'If' && node.openingElement.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(syntax) === 'when' && prop.initializer?.getText(syntax) === "{draft().type === 'remote'}")) remote = node;
      ts.forEachChild(node, visit);
    };
    visit(syntax);
    expect(remote).toBeDefined();
    const inputs = remote!.children.filter(ts.isJsxSelfClosingElement).filter(node => node.tagName.getText(syntax) === 'SettingsInput');
    const props = inputs.map(node => Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map(prop => [prop.name.getText(syntax), prop.initializer?.getText(syntax)])));
    for (const key of ['url', 'timeout']) {
      expect(props).toContainEqual(expect.objectContaining({ testID: JSON.stringify(`settings-${key}`), value: `{value('${key}')}`, disabled: '{locked()}', onChange: `{next => set('${key}', next)}` }));
    }
    expect(remote!.children.filter(ts.isJsxExpression).map(node => node.expression?.getText(syntax)).filter(value => value?.startsWith('field('))).toEqual([]);
  });

  it('captures the actual production MCP editor callbacks: clear/type/save sends only the touched URL and the retained project scope', async () => {
    const fixture = isolatedHost(), { audit, scope } = fixture;
    const editor = collectionEditorCallbacks(fixture);
    for (let tick = 0; tick < 100 && (editor.lifetime.busy() || !editor.lifetime.ready()); tick++) await Promise.resolve();
    expect(editor.lifetime.ready()).toBe(true); expect(editor.lifetime.error()).toBe('');
    editor.edit('');
    const edited = 'https://mcp.example.invalid/edited';
    for (let index = 1; index <= edited.length; index++) editor.edit(edited.slice(0, index));
    expect(editor.value()).toBe(edited);
    editor.save();
    for (let tick = 0; tick < 100 && editor.lifetime.busy(); tick++) await Promise.resolve();
    expect(audit().requests.filter(row => row.method === 'PATCH')).toEqual([{ path: '/api/config/mcp/scope-mcp', resource: '/api/config/mcp/scope-mcp?directory=%2Ffixture%2Fsecond%2F.worktrees%2Ftopic', method: 'PATCH', body: { url: edited, scope: 'project' }, expectedHost: scope }]);
    expect(editor.lifetime.error()).toBe(''); expect(audit().rejected).toEqual([]);
    editor.dispose();
  });

  it.each([
    ['mcp', 'scope-mcp', 'url', 'https://mcp.example.invalid/edited', 1],
    ['agents', 'build', 'description', 'Saved in actual worktree', 2],
    ['skills.installed', 'scope-skill', 'instructions', 'Actual worktree instructions edited', 1],
  ] as const)('real %s page lifetime schedules scope renewal only from its dependencies and preserves the touched draft', async (page, entity, field, edited, renewalReads) => {
    const fixture = isolatedHost(), editor = collectionEditorCallbacks(fixture, page, entity, field);
    try {
      await flushCollectionEffects();
      expect(editor.lifetime.ready()).toBe(true); expect(editor.lifetime.error()).toBe('');
      const captured = editor.captureHostOperation(), oldLane = editor.lifetime.operation(), before = fixture.audit().requests.length;
      expect(Object.isFrozen(captured)).toBe(true); expect(captured.scope).toEqual(fixture.scope);
      editor.edit('');
      for (let index = 1; index <= edited.length; index++) editor.edit(edited.slice(0, index));
      await flushCollectionEffects();
      expect(editor.value()).toBe(edited); expect(editor.lifetime.operation()).toBe(oldLane);
      expect(fixture.audit().requests).toHaveLength(before); // Draft signals must not reschedule authority/load effects.
      editor.setForeground(false); await flushCollectionEffects();
      expect(captured.current()).toBe(false);
      await expect(captured.request('/api/config/settings', 'PATCH', {})).rejects.toThrow('host_operation_stale');
      expect(fixture.audit().requests).toHaveLength(before);
      fixture.host.call('connection.select', { id: fixture.scope!.hostID });
      editor.renew(); await flushCollectionEffects();
      expect(editor.lifetime.operation()).toBeNull(); expect(editor.value()).toBe(edited);
      editor.setForeground(true); editor.renew(); await flushCollectionEffects();
      expect(editor.lifetime.operation()).not.toBe(oldLane);
      expect(oldLane?.current()).toBe(false); expect(captured.current()).toBe(false);
      expect(editor.value()).toBe(edited); expect(editor.lifetime.error()).toBe('');
      expect(fixture.audit().requests).toHaveLength(before + renewalReads);
      expect(fixture.audit().writes).toEqual([]);
      editor.save(); await flushCollectionEffects();
      const path = page === 'agents' ? '/api/config/agents/build' : page === 'mcp' ? '/api/config/mcp/scope-mcp' : '/api/config/skills/scope-skill';
      const body = page === 'agents' ? { native: { description: edited }, scope: 'project' } : page === 'mcp' ? { url: edited, scope: 'project' } : { instructions: edited, targetPath: actual + '/.agents/skills/scope-skill/SKILL.md' };
      expect(fixture.audit().writes).toEqual([{ path, directory: actual, body }]);
      expect(fixture.audit().requests.at(-1)?.expectedHost).toEqual(fixture.snapshot().runtimeScope);
      expect(fixture.audit().rejected).toEqual([]); expect(editor.lifetime.error()).toBe('');
    } finally { editor.dispose(); }
  });

  it.each([
    ['agents', 'build', 'description', 'Saved in actual worktree', { native: { description: 'Saved in actual worktree' }, scope: 'project' }],
    ['skills.installed', 'scope-skill', 'instructions', 'Actual worktree instructions edited', { instructions: 'Actual worktree instructions edited', targetPath: actual + '/.agents/skills/scope-skill/SKILL.md' }],
  ] as const)('preserves the original %s editor clear/type/save callback wire', async (page, entity, field, edited, body) => {
    const fixture = isolatedHost(), { audit } = fixture;
    const editor = collectionEditorCallbacks(fixture, page, entity, field);
    for (let tick = 0; tick < 100 && (editor.lifetime.busy() || !editor.lifetime.ready()); tick++) await Promise.resolve();
    expect(editor.lifetime.ready()).toBe(true); expect(editor.lifetime.error()).toBe('');
    editor.edit('');
    for (let index = 1; index <= edited.length; index++) editor.edit(edited.slice(0, index));
    expect(editor.value()).toBe(edited);
    editor.save();
    for (let tick = 0; tick < 100 && editor.lifetime.busy(); tick++) await Promise.resolve();
    expect(audit().writes).toEqual([{ path: page === 'agents' ? '/api/config/agents/build' : '/api/config/skills/scope-skill', directory: actual, body }]);
    expect(editor.lifetime.error()).toBe(''); expect(audit().rejected).toEqual([]);
    editor.dispose();
  });

  it('feeds actual production collection/editor/mutation helpers at the non-first worktree scope', async () => {
    const { send, audit } = isolatedHost();
    const settings = await send('/api/config/settings') as { projects: Array<{ path: string }>; lastDirectory: string };
    expect(settings.projects[0].path).not.toBe(actual); expect(settings.projects[1].path).not.toBe(actual); expect(settings.lastDirectory).not.toBe(actual);
    const [agent] = await readSettingsCollection(send, 'agents', actual);
    const editor = await nativeAgentEditor(send, agent, actual);
    expect(editor).toMatchObject({ name: 'build', scope: 'project', system: 'Actual worktree prompt' });
    const [skill] = await readSettingsCollection(send, 'skills.installed', actual);
    const detail = await send(scopedSettingsPath('/api/config/skills/scope-skill', actual)) as { sources: { md: { path: string } } };
    expect(skill.name).toBe('scope-skill');
    const [mcp] = await readSettingsCollection(send, 'mcp', actual);
    expect(mcp).toMatchObject({ name: 'scope-mcp', scope: 'project' });
    for (const mutation of [
      settingsMutation('agents', 'build', { description: 'Saved in actual worktree', scope: editor.scope }, false, actual),
      settingsMutation('skills.installed', 'scope-skill', { instructions: 'Actual worktree instructions edited', targetPath: detail.sources.md.path }, false, actual),
      settingsMutation('mcp', 'scope-mcp', { url: 'https://mcp.example.invalid/edited', scope: mcp.scope }, false, actual),
    ]) await send(mutation.path, mutation.method, mutation.body);
    expect(audit()).toMatchObject({ agentDescription: 'Saved in actual worktree', instructions: 'Actual worktree instructions edited', mcpURL: 'https://mcp.example.invalid/edited', rejected: [] });
    expect(audit().writes.map(row => row.directory)).toEqual([actual, actual, actual]);
  });

  it('retains exact rejected MCP inputs for diagnosis without accepting user scope, a wrong URL or unrelated fields', async () => {
    const { send, audit, scope } = isolatedHost();
    const resource = scopedSettingsPath('/api/config/mcp/scope-mcp', actual);
    const bodies = [
      { url: 'https://mcp.example.invalid/edited', scope: 'user' },
      { url: 'https://mcp.example.invalid/original', scope: 'project' },
      { url: 'h', scope: 'project' },
      { url: 'https://mcp.example.invalid/edited', scope: 'project', enabled: true },
    ];
    for (const body of bodies) await expect(send(resource, 'PATCH', body)).rejects.toThrow();
    expect(audit().requests.filter(row => row.method === 'PATCH')).toEqual(bodies.map(body => ({ path: '/api/config/mcp/scope-mcp', resource, method: 'PATCH', body, expectedHost: scope })));
    expect(audit().rejected).toHaveLength(4);
    expect(audit().rejected.slice(0, 3)).toEqual(bodies.slice(0, 3).map(body => ({ name: 'runtime.request', resource, message: 'Unexpected MCP patch: ' + JSON.stringify({ fields: ['scope', 'url'], scope: body.scope, url: body.url }) })));
    expect(audit().writes).toEqual([]);
    expect(audit().mcpURL).toBe('https://mcp.example.invalid/original');
  });

  it('location-less settings remain global for lists and nested details; no saved-permission/project lookup is guessed', async () => {
    const { send, audit } = isolatedHost();
    const [agent] = await readSettingsCollection(send, 'agents');
    expect(agent.name).toBe('global-agent');
    expect(await nativeAgentEditor(send, agent)).toMatchObject({ scope: 'user', system: 'Global user prompt' });
    expect((await readSettingsCollection(send, 'skills.installed'))[0].name).toBe('global-skill');
    await send('/api/config/skills/global-skill');
    expect((await readSettingsCollection(send, 'mcp'))[0].name).toBe('global-mcp');
    await send('/api/mcp');
    expect(audit().requests.every(row => !row.resource.includes('directory'))).toBe(true);
    expect(audit().requests.some(row => ['/api/location', '/api/permission/saved'].includes(row.path))).toBe(false);
    expect(audit().writes).toEqual([]); expect(audit().rejected).toEqual([]);
  });

  it('supports the real notification root GET/configure and live-Location attention readers without OS effects', async () => {
    const { host, send, audit } = isolatedHost(), scope = { hostID: 'settings-navigation-production', generation: 1 };
    const transport = createNotificationSettingsTransport({ scope: () => scope, language: () => 'en', call: async (name, input) => host.call(name, input), read: () => send('/api/config/settings'), write: async () => { throw new Error('Unexpected notification write'); } });
    const notification = createNotificationRootController({ transport, scope: () => scope, sessions: () => [], resolve: () => [], open: () => { throw new Error('Unexpected notification route'); }, changed: () => {} });
    const attention = createProjectsAttention(), key = 'synthetic-scope';
    const source = createProjectsAttentionSource({ attention, sessions: () => [], request: send });
    attention.activate(key);
    try {
      notification.bind(scope, 'en', true);
      source.setActive(key, true);
      for (let attempt = 0; attempt < 100 && (!notification.state().ready || notification.state().refreshing || !readProjectsBlocking(attention.snapshot(key).blockingByDirectory, actual, 'ses_actual').permissionsKnown); attempt++) await Promise.resolve();
      expect(notification.state()).toEqual({ ready: true, refreshing: false, error: null, recovery: 'unsupported' });
      expect(readProjectsBlocking(attention.snapshot(key).blockingByDirectory, actual, 'ses_actual')).toMatchObject({ permissionsKnown: true, questionsKnown: true, hasPendingQuestion: false, hasPendingPermission: false });
      expect(audit().notification).toEqual({ configurations: [{ hostID: scope.hostID, enabled: false, mode: 'hidden-only', events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'], language: 'en' }], osAuthorization: 'unknown', scheduled: 0 });
      expect(audit().requests.filter(row => row.path === '/api/debug/location')).toHaveLength(1);
      expect(audit().requests.filter(row => ['/api/form', '/api/permission/request'].includes(row.path))).toHaveLength(4);
      expect(audit().writes).toEqual([]); expect(audit().rejected).toEqual([]);
    } finally { notification.dispose(); source.dispose(); attention.retire(key); }
  });

  it('authorizes only the read-only disabled schema-2 diagnostics status; the real root cannot acquire recording authority', async () => {
    const { host, audit } = isolatedHost();
    const scope = { hostID: 'settings-navigation-production', generation: 1 };
    const call = vi.fn(async (name: string, body?: Record<string, unknown>) => host.call(name, body ?? {}));
    const diagnostics = createAboutDiagnosticsRoot({ scope: () => scope, call });
    try {
      expect(settingsNavigationCapabilities.filter(name => name.startsWith('native.diagnostics.'))).toEqual(['native.diagnostics.status']);
      expect(host.call('native.diagnostics.status', {})).toEqual({ schemaVersion: 2, mode: 'event-recorder', enabled: false, recordingLease: null, eventCount: 0, maxEntries: 500, maxBytes: 256 * 1024 });
      await diagnostics.refresh();
      diagnostics.onEvent({ key: 'global', type: 'session.status', directory: actual, body: { sessionID: 'ses_actual' } }, scope);
      await diagnostics.flush();
      expect(call.mock.calls).toEqual([['native.diagnostics.status']]);
      expect(audit().rejected).toEqual([]);
      expect(audit().writes).toEqual([]);
      expect(() => host.call('native.diagnostics.status', { enabled: true })).toThrow();
      for (const name of ['native.diagnostics.setEnabled', 'native.diagnostics.append', 'native.diagnostics.export']) expect(() => host.call(name, {})).toThrow();
      expect(audit().rejected).toHaveLength(4);
    } finally { diagnostics.dispose(); }
  });

  it.each(['/fixture/first', '/fixture/second', '/fixture/recent-decoy', '', undefined])('rejects every guessed or absent mutation directory before accepting a write: %s', async directory => {
    const { send, audit } = isolatedHost();
    for (const mutation of [
      settingsMutation('agents', 'build', { description: 'Saved in actual worktree', scope: 'project' }, false, directory),
      settingsMutation('skills.installed', 'scope-skill', { instructions: 'Actual worktree instructions edited', targetPath: actual + '/.agents/skills/scope-skill/SKILL.md' }, false, directory),
      settingsMutation('mcp', 'scope-mcp', { url: 'https://mcp.example.invalid/edited', scope: 'project' }, false, directory),
    ]) await expect(send(mutation.path, mutation.method, mutation.body)).rejects.toThrow();
    expect(audit().writes).toEqual([]); expect(audit().rejected).toHaveLength(3);
  });

  it('rejects malformed resources, unknown calls, wrong bodies and extra/doubled scope instead of empty success', async () => {
    const { host, send, audit } = isolatedHost();
    const malformed = ['https://external.example.invalid/api/agent', '//external.example.invalid/api/agent', '/api/agent?', '/api/agent#fragment', '/api/agent?location%5Bdirectory%5D=%ZZ', '/api/agent?location%5Bdirectory%5D=%2Ffixture%2Fsecond%2F.worktrees%2Ftopic&location%5Bdirectory%5D=%2Ffixture%2Ffirst', '/api/config/mcp?directory=%2Ffixture%2Fsecond', '/api/unknown'];
    for (const path of malformed) await expect(send(path)).rejects.toThrow();
    await expect(send('/api/session', 'POST', { location: { directory: actual } })).rejects.toThrow();
    await expect(send('/api/config/settings', 'PUT', { lastDirectory: actual })).rejects.toThrow();
    await expect(send(scopedSettingsPath('/api/config/mcp/scope-mcp', actual), 'PATCH', { url: 'https://mcp.example.invalid/edited', scope: 'project', injected: true })).rejects.toThrow();
    await expect(send('/api/config/agents/metadata', 'POST', { names: ['build'] })).rejects.toThrow();
    await expect(send('/api/config/mcp', 'GET', {})).rejects.toThrow();
    for (const name of ['notification.request', 'notification.status', 'notification.openSettings', 'notification.live', 'notification.test', 'camera.scan', 'connection.select', 'unknown.call']) expect(() => host.call(name, {})).toThrow();
    expect(audit().writes).toEqual([]); expect(audit().rejected).toHaveLength(malformed.length + 13);
  });

  it('notification configuration is exact and requires a successful settings read; its lease grants no OS authority', async () => {
    const { host, send, audit } = isolatedHost();
    const configuration = { hostID: 'settings-navigation-production', enabled: false, mode: 'hidden-only', events: ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'], language: 'en' };
    expect(() => host.call('notification.configure', configuration)).toThrow();
    await send('/api/config/settings');
    expect(host.call('notification.configure', configuration)).toEqual({ lease: 'settings-navigation-memory-lease' });
    for (const input of [{ ...configuration, hostID: 'other' }, { ...configuration, enabled: true }, { ...configuration, events: [] }, { ...configuration, extra: true }]) expect(() => host.call('notification.configure', input)).toThrow();
    expect(audit().notification).toMatchObject({ osAuthorization: 'unknown', scheduled: 0 });
  });
});

it('isolates config, production mount entries, Storage identity and Host graph without changing the production config', () => {
  const production = readFileSync(path.join(root, 'nsh.json'), 'utf8');
  let first = '';
  withSettingsNavigationProductionFixture(root, (fixture: Fixture) => {
    first = fixture.directory;
    const config = JSON.parse(readFileSync(path.join(first, 'nsh.json'), 'utf8'));
    expect(config.capabilities).toEqual({ host: settingsNavigationCapabilities });
    expect(config.id).toMatch(/^example\.yuri\.settings-navigation\./);
    expect(config.id).not.toBe('com.yee94.yuri.nsh');
    expect(readFileSync(path.join(first, fixture.entry), 'utf8')).toBe(`import ${JSON.stringify(path.join(root, 'App.tsx'))};\n`);
    expect(path.dirname(fixture.host)).toBe(first);
    expect(evaluateHost(fixture).audit().rejected).toEqual([]);
  });
  expect(existsSync(first)).toBe(false);
  expect(() => withSettingsNavigationProductionFixture(root, (fixture: Fixture) => { expect(fixture.directory).not.toBe(first); throw new Error('Deliberate fixture failure'); })).toThrow('Deliberate fixture failure');
  expect(readFileSync(path.join(root, 'nsh.json'), 'utf8')).toBe(production);
});

it('compiles the actual production App/Settings/Chat and test driver graph with no runtime aliases or browser React graph (no NSH)', () => {
  withSettingsNavigationProductionFixture(root, (fixture: Fixture) => {
    const metadata = path.join(fixture.directory, 'graph.json');
    const result = spawnSync('bun', ['build', fixture.entry, 'RootSettings.tsx', '--target=browser', '--external=nsh', '--external=nsh/*', '--metafile=' + metadata, '--outdir', path.join(fixture.directory, 'graph')], { cwd: fixture.directory, encoding: 'utf8', timeout: 30_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
    const graph = JSON.parse(readFileSync(metadata, 'utf8')) as { inputs: Record<string, { imports: Array<{ original?: string }> }>; outputs: Record<string, { imports: Array<{ path: string; external?: boolean }> }> };
    const files = Object.keys(graph.inputs);
    for (const file of ['App.tsx', 'application.tsx', 'settings.tsx', 'settings-collections.tsx', 'projects-search.tsx', 'state.ts']) expect(files.some(value => value.endsWith('/' + file))).toBe(true);
    expect(files.filter(file => /\/node_modules\/(?:\.bun\/)?(?:react(?:-dom)?(?:@|\/)|zustand(?:@|\/)|@tanstack\/react-query\/)/.test(file))).toEqual([]);
    expect(Object.values(graph.inputs).flatMap(file => file.imports.filter(item => item.original?.startsWith('@/')))).toEqual([]);
    expect(Object.values(graph.outputs).flatMap(file => file.imports.filter(item => item.external && item.path !== 'nsh' && !item.path.startsWith('nsh/')))).toEqual([]);
    for (const scenario of ['chat-mcp', 'root-global', 'scoped-search', 'switcher-search'] as const) {
      const parsed = ts.transpileModule(engineScript(scenario, ''), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2023 }, reportDiagnostics: true });
      expect(parsed.diagnostics ?? []).toEqual([]);
    }
  });
});

type Scenario = 'chat-mcp' | 'root-global' | 'scoped-search' | 'switcher-search';
function engineScript(scenario: Scenario, selector: string) {
  const body = scenario === 'chat-mcp' ? 'await chatMcpScenario(app, audit, expect);' : scenario === 'root-global' ? 'await globalSettingsScenario(app, audit, expect);' : `await scopedSettingsScenario(app, audit, expect, ${JSON.stringify(selector)}, ${scenario === 'switcher-search'});`;
  return `import { test, open, expect } from 'nsh/test';
import { createHost } from './host.js';
${enterActualChat.toString()}
${verifyCommandPaletteToggle.toString()}
${verifySettingsHomeContent.toString()}
${verifySessionSwitcherBack.toString()}
${typeSettingsURL.toString()}
${verifyActualFileSearch.toString()}
${chatMcpScenario.toString()}
${scopedSettingsScenario.toString()}
${globalSettingsScenario.toString()}
test('production settings navigation: ${scenario}', async () => {
  const host = createHost();
  const audit = () => host.call('settingsNavigation.fixture.audit', {});
  const handlers = Object.fromEntries(${JSON.stringify(settingsNavigationCapabilities)}.map(name => [name, input => host.call(name, input)]));
  const app = await open(${JSON.stringify(scenario === 'root-global' ? './RootSettings.tsx' : './App.tsx')}, { storage: { language: 'en' }, host: { handlers } });
  await app.waitUntil(() => audit().notification.configurations.length === 1);
  try {
    ${body}
  } catch (error) {
    const failed = audit();
    console.error('settings-navigation-failure:' + JSON.stringify({ scenario: ${JSON.stringify(scenario)}, rejected: failed.rejected, mcpPatches: failed.requests.filter(row => row.path === '/api/config/mcp/scope-mcp' && row.method === 'PATCH') }));
    throw error;
  }
  expect(audit().rejected).toEqual([]);
  expect(audit().requests.filter(row => row.path === '/api/yuri/history-import/job')).toEqual([]);
  const expectedScope = audit().runtimeScope;
  expect(expectedScope?.hostID).toBe('settings-navigation-production');
  expect(typeof expectedScope?.lease).toBe('string');
  for (const request of audit().requests.filter(row => row.method !== 'GET' || row.path === '/api/agent' || row.path.startsWith('/api/config/agents/') || row.path.startsWith('/api/config/skills') || row.path.startsWith('/api/config/mcp') || row.path === '/api/fs/find')) expect(request.expectedHost).toEqual(expectedScope);
  expect(audit().notification.osAuthorization).toBe('unknown');
  expect(audit().notification.scheduled).toBe(0);
  expect(app.shows('id:notification-root-feedback')).toBe(false);
}, 90000);
`;
}

const engine = process.env.NSH_SETTINGS_NAVIGATION_PRODUCTION_ENGINE === '1' ? it : it.skip;
for (const scenario of ['chat-mcp', 'root-global', 'scoped-search', 'switcher-search'] as const) engine(`production public navigation: ${scenario} (opt-in headless engine; not UIKit evidence)`, () => {
  const selector = process.env.NSH_SETTINGS_NAVIGATION_CHAT_SEARCH_SELECTOR || '';
  withSettingsNavigationProductionFixture(root, (fixture: Fixture) => {
    const testEntry = 'navigation.test.ts';
    writeFileSync(path.join(fixture.directory, testEntry), engineScript(scenario, selector));
    const result = spawnSync(process.env.NSH_BIN || 'nsh', ['test', testEntry], { cwd: fixture.directory, encoding: 'utf8', timeout: 110_000 });
    expect(result.error, result.stdout + result.stderr).toBeUndefined(); expect(result.status, result.stdout + result.stderr).toBe(0);
  });
}, 125_000);
