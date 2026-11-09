import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as model from './model';
import * as protocol from './settings-protocol';
import * as basicCore from './settings-basics-core';
import * as confirmation from './settings-voice-confirm';
import * as recognition from './settings-voice-recognition';
import * as scopeCore from './runtime-scope';
import { speechDefaults, speechSecretFields } from '../ui/src/lib/voice/speechSettings';
import * as collectionCore from './settings-collections-core';
import * as projectSettings from './project-settings';
import * as projectCore from './settings-projects-core';
import * as voiceModels from './settings-voice-models-core';
import * as integrationForms from './settings-integration-form';
import * as providerRemoval from './settings-provider-removal';
import * as providerProtocols from '../web/shared/custom-provider-protocol';

const root = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let index = 0; index < 150; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
type Operation = ReturnType<typeof import('./state').captureHostOperation>;

/** Pure production callback harness. Runs actual SettingsBasics, lane lifetime,
 * Voice journal, recognition adapter, bindRequest and the original state's
 * captureHostOperation declaration. Inert JSX observes props; it is not an NSH
 * engine, UIKit renderer, lifecycle bridge, microphone or real Host. */
async function fixture(options: { covered?: boolean; rootToken?: boolean; legacy?: boolean; throughSettingsPage?: boolean; initialTokenGap?: boolean;
  surface?: 'collection' | 'integration' | 'git' | 'projects' | 'downloads' | 'archive' | 'providers'; props?: Record<string, unknown>;
  respond?: (path: string, method: string, body: unknown) => Promise<unknown>;
} = {}) {
  let observer: (() => void) | null = null;
  const scheduled = new Set<() => void>();
  const schedule = (run: () => void) => {
    if (scheduled.has(run)) return;
    scheduled.add(run); queueMicrotask(() => { scheduled.delete(run); run(); });
  };
  const source = <T>(initial: T) => {
    let value = initial; const subscribers = new Set<() => void>();
    return Object.assign(() => { if (observer) subscribers.add(observer); return value; }, {
      set(next: T) { if (Object.is(value, next)) return; value = next; for (const run of [...subscribers]) schedule(run); },
    });
  };
  const effects: Array<() => void> = [], cleanup: Array<() => void> = [];
  const effect = (work: () => void) => {
    const run = () => { const previous = observer; observer = run; try { work(); } finally { observer = previous; } };
    effects.push(run); run();
  };
  const untracked = <T>(work: () => T) => { const previous = observer; observer = null; try { return work(); } finally { observer = previous; } };
  const active = source(!options.covered), foreground = source(true), ready = source(true), generation = source(1);
  const connection = source({ id: 'synthetic-A', url: 'https://synthetic.invalid', authorizationID: 'synthetic-authorization' });
  const scope = source<scopeCore.RuntimeScope | null>(options.legacy ? null : { hostID: 'synthetic-A', lease: 'synthetic-lease-1' });
  const token = source<Operation | null>(null);
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const settings = { ...speechDefaults, configured: true, voiceProvider: 'say' as const };
  let delayedRead: (() => Promise<unknown>) | null = null, delayedWrite: (() => Promise<unknown>) | null = null;
  let delayedCapabilities: (() => Promise<unknown>) | null = null;
  let stopWait: Promise<unknown> | null = null;
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const native = async (name: string, input: Record<string, unknown>): Promise<unknown> => {
    calls.push({ name, input });
    const exact = (keys: string[]) => expect(Object.keys(input).sort()).toEqual(keys.sort());
    if (name === 'runtime.request') {
      exact(['path', 'method', ...(input.body === undefined ? [] : ['body']), ...(input.expectedHost ? ['expectedHost'] : [])]);
      if (input.expectedHost && !scopeCore.sameRuntimeScope(scopeCore.runtimeScopeFrom(input.expectedHost), scope())) throw new Error('retired-native-scope');
      if (options.respond) return { status: 200, body: await options.respond(String(input.path), String(input.method), input.body) };
      expect(input.path).toBe('/api/voice/settings');
      if (input.method === 'GET') return { status: 200, body: delayedRead ? await delayedRead() : { ...settings } };
      expect(input.method).toBe('PUT'); expect(input.expectedHost).toEqual(scope());
      for (const [key, value] of Object.entries(input.body as Record<string, unknown>)) {
        if (speechSecretFields.has(key)) Object.assign(settings, { [key === 'apiKey' ? 'configured' : `${key}Configured`]: !!String(value).trim() });
        else Object.assign(settings, { [key]: value });
      }
      return { status: 200, body: delayedWrite ? await delayedWrite() : { ...settings } };
    }
    if (name === 'voiceRecognition.capabilities') { exact([]); return delayedCapabilities ? delayedCapabilities() : { providers: ['local', 'volcengine', 'openai-compatible'], maximumSeconds: 60, maximumBytes: 1_920_000 }; }
    if (name === 'voiceRecognition.start') { exact(['owner', 'revision', 'provider', 'expectedHost']); expect(input.expectedHost).toEqual(scope()); return { owner: input.owner, revision: input.revision, provider: input.provider }; }
    if (name === 'voiceRecognition.cancel') { exact(['owner', 'revision']); return null; }
    if (name === 'speech.stop' || name === 'speech.release') { exact(['owner', 'revision']); return name === 'speech.stop' ? stopWait : null; }
    throw new Error('Unexpected native call: ' + name);
  };
  const on = (name: string, callback: (value: unknown) => void) => { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => { set.delete(callback); }; };
  const lazyKeys = ['when', 'of', 'value', 'disabled', 'active', 'operationToken', 'dirty', 'draftRevision', 'selectedModel', 'voice', 'stt', 'tts'];
  const jsx = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node => {
    const observed = Object.defineProperties({}, Object.getOwnPropertyDescriptors(props ?? {})) as Record<string, unknown>;
    for (const key of lazyKeys) if (typeof observed[key] === 'function') Object.defineProperty(observed, key, { get: observed[key] as () => unknown });
    return { type, props: observed, children };
  };
  const modules: Record<string, unknown> = {
    nsh: { signal: source, effect, untracked, context: (initial: unknown) => () => initial, platform: { os: 'macos' }, cleanup: (work: () => void) => cleanup.push(work), lifecycle: () => foreground() ? 'active' : 'inactive', host: { available: () => true, call: native, on }, Scroll: 'Scroll', Text: 'Text', View: 'View' },
    'nsh/base': Object.fromEntries(['AlertDialog', 'Button', 'Input', 'Select', 'Switch', 'Progress', 'Radio', 'RadioGroup', 'TextView', 'Sheet', 'NavPage'].map(key => [key, key])),
    './native-select': { NativeSelect: 'Select' },
    './native-sheet': { NativeSheet: 'Sheet' },
    './i18n': { t: (key: string) => key }, './model': model, './settings-protocol': protocol,
    './runtime-scope': scopeCore, './settings-basics-core': basicCore,
    './settings-voice-confirm': confirmation, './settings-voice-recognition': recognition,
    './settings-collections-core': collectionCore, './project-settings': projectSettings,
    './settings-projects-core': projectCore, './settings-voice-models-core': voiceModels,
    './Icon': { Icon: 'Icon' }, './settings-permissions': { SettingsPermissions: 'SettingsPermissions', SettingsSavedPermissions: 'SettingsSavedPermissions' },
    './settings-skill-files': { SettingsSkillFiles: 'SettingsSkillFiles' }, './settings-mcp-live': { SettingsMcpLive: 'SettingsMcpLive' },
    './settings-plugin-runtime': { SettingsPluginRuntime: 'SettingsPluginRuntime' }, './settings-mcp-import': { SettingsMcpImport: 'SettingsMcpImport' },
    './settings-providers': { SettingsProviders: 'SettingsProviders' }, './settings-integration-fields': { SettingsIntegrationFields: 'SettingsIntegrationFields' },
    './settings-github': { SettingsGitHub: 'SettingsGitHub' }, './settings-git-credentials': { SettingsGitCredentials: 'SettingsGitCredentials' },
    './settings-integration-form': integrationForms,
    './settings-provider-removal': providerRemoval, '../web/shared/custom-provider-protocol': providerProtocols,
    './settings-quota-credentials': { SettingsQuotaCredentials: 'SettingsQuotaCredentials' }, './settings-quota-credentials-core': { quotaCredentialProviderFor: () => null },
    './settings-integration': { SettingsIntegration: 'SettingsIntegration' },
    './settings-collections': { SettingsCollection: 'SettingsCollection' }, './settings-git': { SettingsGit: 'SettingsGit' },
    './settings-usage': { SettingsUsage: 'SettingsUsage' }, './settings-archive': { SettingsArchive: 'SettingsArchive' },
    './settings-magic-prompts': { SettingsMagicPrompts: 'SettingsMagicPrompts' }, './settings-projects': { SettingsProjectsPage: 'SettingsProjectsPage' },
    '../ui/src/lib/voice/speechSettings': { speechDefaults },
    './settings-search-core': { createSettingsTargetNavigation: () => ({ onScroll() {}, reveal() {} }) },
    './notification-settings': { SettingsNotifications: 'SettingsNotifications' },
    './settings-retention': { SettingsSessionRetentionSection: 'SettingsSessionRetentionSection' },
    './settings-voice-models': { SettingsVoiceModels: 'SettingsVoiceModels' }, './settings-voice-test': { SettingsVoiceTests: 'SettingsVoiceTests' },
    './settings-target': { SettingsTarget: 'SettingsTarget' }, './settings-defaults': { SettingsDefaults: 'SettingsDefaults' },
    './settings-preferences': { SettingsPreferences: 'SettingsPreferences' }, './settings-about': { SettingsAbout: 'SettingsAbout' }, './settings-global-config': { SettingsGlobalConfig: 'SettingsGlobalConfig' },
    './settings-skills-catalog': { SettingsSkillsCatalog: 'SettingsSkillsCatalog' }, './settings-remote-instances': { SettingsRemoteInstances: 'SettingsRemoteInstances' },
  };
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && lazyKeys.includes(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined,
          ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node.initializer.expression)));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  // NSH component spreads preserve getters; React JSX emit's object spread
  // snapshots them. Keep that production forwarding contract in this harness.
  const spreads: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'jsx') {
        const props = node.arguments[1];
        if (props && ts.isObjectLiteralExpression(props) && props.properties.some(ts.isSpreadAssignment)) {
          const sources = props.properties.map(property => ts.isSpreadAssignment(property)
            ? property.expression : ts.factory.createObjectLiteralExpression([property]));
          return ts.visitEachChild(ts.factory.updateCallExpression(node, node.expression, node.typeArguments,
            [node.arguments[0], ts.factory.createCallExpression(ts.factory.createIdentifier('mergeProps'), undefined, sources), ...node.arguments.slice(2)]), visit, context);
        }
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  const mergeProps = (...sources: Record<string, unknown>[]) => Object.defineProperties({},
    Object.assign({}, ...sources.map(value => Object.getOwnPropertyDescriptors(value))));
  function evaluate<T>(filename: string): T {
    const output = ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), { fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { before: [lazy], after: [spreads] } }).outputText;
    const exports = {};
    vm.runInNewContext(output, { exports, jsx, mergeProps, If: 'If', Each: 'Each', setTimeout, clearTimeout, require: (id: string) => { if (!(id in modules)) throw new Error('Unexpected dependency: ' + id); return modules[id]; } });
    return exports as T;
  }
  const runtime = evaluate<typeof import('./runtime')>('runtime.ts'); modules['./runtime'] = runtime;
  const stateSyntax = ts.createSourceFile('state.ts', readFileSync(path.join(root, 'state.ts'), 'utf8'), ts.ScriptTarget.ES2023, true);
  const captureDeclaration = stateSyntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'captureHostOperation');
  if (!captureDeclaration) throw new Error('Missing actual operation factory');
  const operationExports: { captureHostOperation?: () => Operation } = {};
  const context = vm.createContext({ exports: operationExports, ...scopeCore, bindRequest: runtime.bindRequest,
    runtimeReady: ready, switching: false, lifecycle: () => foreground() ? 'active' : 'inactive', app: { connection, runtimeScope: scope } });
  Object.defineProperty(context, 'generation', { get: generation });
  vm.runInContext(ts.transpileModule(captureDeclaration.getText(stateSyntax), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, context);
  const captureHostOperation = operationExports.captureHostOperation!;
  modules['./state'] = { captureHostOperation, captureHostRequest: () => runtime.bindRequest(scope()), epoch: generation, app: { connection, runtimeScope: scope }, loadConnections() { throw new Error('Page must not acquire root authority'); } };
  modules['./desktop-settings-content-core'] = evaluate('desktop-settings-content-core.ts');
  modules['./desktop-settings-publisher'] = evaluate('desktop-settings-publisher.tsx');
  modules['./settings-controls'] = evaluate('settings-controls.tsx');
  if (options.rootToken && !options.initialTokenGap) token.set(captureHostOperation());
  let basics: ((props: Record<string, unknown>) => Node) | undefined;
  if (options.throughSettingsPage) {
    const module = evaluate<Record<string, (props: Record<string, unknown>) => Node>>('settings-basics.tsx');
    basics = module.SettingsBasics; modules['./settings-basics'] = module;
  }
  const surfaces = { collection: ['settings-collections.tsx', 'SettingsCollection'], integration: ['settings-integration.tsx', 'SettingsIntegration'], git: ['settings-git.tsx', 'SettingsGit'], projects: ['settings-projects.tsx', 'SettingsProjects'], downloads: ['settings-voice-models.tsx', 'SettingsVoiceModels'], archive: ['settings-archive.tsx', 'SettingsArchive'], providers: ['settings-providers.tsx', 'SettingsProviders'] } as const;
  const [filename, exportName] = options.throughSettingsPage ? ['settings.tsx', 'SettingsPage'] : options.surface ? surfaces[options.surface] : ['settings-basics.tsx', 'SettingsBasics'];
  const pageModule = evaluate<Record<string, (props: Record<string, unknown>) => Node>>(filename);
  const page = pageModule[exportName], content = options.throughSettingsPage ? pageModule.SettingsPageContent : undefined;
  const tree = page({ page: 'voice', ...options.props, get active() { return active(); }, current: () => ready() && foreground(), get operationToken() { return options.rootToken ? token() : undefined; }, onOpen() {}, onBack() {} });
  const keyed = new Map<unknown, Node[]>();
  const mountedComponents = new Map<Node, Node>();
  const mountedContent = new Map<Node, Node>();
  function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object' || !('type' in value)) return [];
    const node = value as Node;
    if (content && node.type === content) {
      if (!mountedContent.has(node)) mountedContent.set(node, content(node.props));
      return nodes(mountedContent.get(node));
    }
    if (basics && node.type === basics) {
      if (!mountedComponents.has(node)) mountedComponents.set(node, basics(node.props));
      return nodes(mountedComponents.get(node));
    }
    if (node.type === 'If') return node.props.when ? node.children.flatMap(nodes) : [];
    if (node.type === 'Each') return (node.props.of as unknown[]).flatMap((item, index) => {
      if (node.props.key) {
        if (!keyed.has(item)) keyed.set(item, nodes((node.children[0] as (item: () => unknown, index: () => number) => unknown)(() => item, () => index)));
        return keyed.get(item)!;
      }
      return nodes((node.children[0] as (item: () => unknown, index: () => number) => unknown)(() => item, () => index));
    });
    return [node, ...node.children.flatMap(nodes)];
  }
  const one = (testID: string) => { const node = nodes(tree).find(node => node.props.testID === testID); if (!node) throw new Error('Missing production node ' + testID); return node; };
  const manager = () => { const node = nodes(tree).find(node => node.type === 'SettingsVoiceModels'); if (!node) throw new Error('Missing production model manager'); return node; };
  const tester = () => { const node = nodes(tree).find(node => node.type === 'SettingsVoiceTests'); if (!node) throw new Error('Missing transient tester'); return node; };
  if (options.throughSettingsPage) nodes(tree);
  await flush();
  return {
    tree, one, tester, calls, settings, listeners, manager, nodes: () => nodes(tree), basicsMounts: () => mountedComponents.size,
    confirm: (node = tester()) => (node.props.confirm as (kind: 'tts' | 'asr') => Promise<unknown>)('asr'),
    edit: (key: string, value: unknown) => (one(`settings-basics-${key}`).props.onChange as (value: unknown) => void)(value),
    data: (key: string) => one(`settings-basics-${key}`).props.value,
    hide: async () => { active.set(false); await flush(); }, show: async () => { active.set(true); await flush(); },
    suspend: async () => { foreground.set(false); ready.set(false); generation.set(generation() + 1); scope.set(null); token.set(null); await flush(); },
    pendingForeground: async () => { foreground.set(true); await flush(); },
    resume: async (lease = 'synthetic-lease-2') => { foreground.set(true); scope.set({ hostID: connection().id, lease }); ready.set(true); if (options.rootToken) token.set(captureHostOperation()); await flush(); },
    switchHost: async (id: string) => { generation.set(generation() + 1); connection.set({ ...connection(), id }); scope.set({ hostID: id, lease: 'lease-' + generation() }); if (options.rootToken) token.set(captureHostOperation()); await flush(); },
    read: (next: typeof delayedRead) => { delayedRead = next; }, write: (next: typeof delayedWrite) => { delayedWrite = next; },
    capabilities: (next: typeof delayedCapabilities) => { delayedCapabilities = next; },
    stop: (next: typeof stopWait) => { stopWait = next; },
    dispose: () => cleanup.forEach(work => work()),
  };
}

describe('retained Voice editor operation recovery (pure production callbacks)', () => {
  it('actual SettingsPage forwards an explicit null→confirmed operation and active gate without remounting Basics', async () => {
    const page = await fixture({ rootToken: true, throughSettingsPage: true, initialTokenGap: true });
    const root = page.tree;
    expect(page.calls).toEqual([]);
    await page.resume('synthetic-lease-1');
    expect(page.calls.filter(call => call.name === 'runtime.request' && call.input.path === '/api/voice/settings')).toHaveLength(1);
    expect(page.calls.filter(call => call.name === 'voiceRecognition.capabilities')).toHaveLength(1);
    const input = page.one('settings-basics-apiKey'); (input.props.onChange as (value: string) => void)('retained through route');
    await page.suspend(); const count = page.calls.length; await page.pendingForeground(); expect(page.calls).toHaveLength(count);
    await page.resume();
    expect(page.tree).toBe(root); expect(page.basicsMounts()).toBe(1); expect(page.one('settings-basics-apiKey').props.value).toBe('retained through route');
    expect(page.calls.filter(call => call.name === 'runtime.request' && call.input.path === '/api/voice/settings')).toHaveLength(2);
    expect(page.calls.filter(call => call.name === 'voiceRecognition.capabilities')).toHaveLength(2);
    expect(page.tester().props.disabled).toBe(false);
    page.dispose();
  });
  it.each([false, true])('reacquires GET/capabilities only after root confirmation, root-token=%s', async rootToken => {
    const page = await fixture({ rootToken });
    const tree = page.tree, tester = page.tester(), oldManager = page.manager();
    page.edit('apiKey', 'synthetic-credential'); (page.manager().props.onSelect as (id: string) => void)('unsaved-selection');
    expect(tester.props.disabled).toBe(false);
    const count = page.calls.length;
    await page.suspend(); expect((tester.props.current as () => boolean)()).toBe(false);
    await page.pendingForeground(); expect(page.calls).toHaveLength(count);
    await page.resume();
    expect(page.tree).toBe(tree); expect(page.data('apiKey')).toBe('synthetic-credential'); expect(page.manager().props.selectedModel).toBe('unsaved-selection');
    expect(page.tester()).not.toBe(tester); expect(page.tester().props.disabled).toBe(false);
    expect((oldManager.props.current as () => boolean)()).toBe(true);
    expect(page.manager().props.selectedModel).toBe('unsaved-selection');
    expect(page.calls.filter(call => call.name === 'voiceRecognition.capabilities')).toHaveLength(2);
    expect(page.calls.filter(call => call.name === 'runtime.request').map(call => call.input.method)).toEqual(['GET', 'GET']);
    expect(await page.confirm(tester)).toBeNull();
    const fresh = page.tester(), adapter = fresh.props.asrAdapter as import('./settings-voice-test-core').VoiceTestAsrAdapter;
    const session = await adapter.start({ owner: 'synthetic-asr', revision: 1, provider: 'local', partial() {} }); await session.cancel();
    expect(page.calls.find(call => call.name === 'voiceRecognition.start')?.input.expectedHost).toEqual({ hostID: 'synthetic-A', lease: 'synthetic-lease-2' });
    page.dispose();
  });

  it('a repeated lease still rebuilds generation authority; ordinary cover keeps the lane and draft', async () => {
    const page = await fixture(); page.edit('apiKey', 'synthetic-secret');
    const old = page.tester(); await page.hide(); await page.show();
    expect(page.data('apiKey')).toBe('synthetic-secret');
    expect(page.calls.filter(call => call.name === 'runtime.request')).toHaveLength(1);
    expect((old.props.current as () => boolean)()).toBe(true);
    await page.suspend(); await page.resume('synthetic-lease-1');
    expect((old.props.current as () => boolean)()).toBe(false);
    expect(page.tester().props.disabled).toBe(false);
    expect(page.calls.filter(call => call.name === 'runtime.request' && call.input.method === 'PUT')).toEqual([]);
    page.dispose();
  });

  it.each(['ack', 'unknown'])('retains %s journal across resume and performs no automatic PUT', async mode => {
    const page = await fixture(); page.edit('apiKey', 'synthetic-secret');
    if (mode === 'unknown') page.write(async () => { throw new Error('Synthetic dropped ACK'); });
    else page.read(async () => { throw new Error('Synthetic GET failure'); });
    expect(await page.confirm()).toBeNull();
    page.read(null); page.write(null);
    await page.suspend(); await page.resume();
    expect(page.data('apiKey')).toBe('synthetic-secret');
    expect(page.calls.filter(call => call.input.method === 'PUT')).toHaveLength(1);
    const receipt = await page.confirm();
    if (mode === 'ack') { expect(receipt).not.toBeNull(); expect(page.data('apiKey')).toBe(''); }
    else { expect(receipt).toBeNull(); expect(page.data('apiKey')).toBe('synthetic-secret'); }
    expect(page.calls.filter(call => call.input.method === 'PUT')).toHaveLength(1);
    page.dispose();
  });

  it('old delayed read/finally cannot clear the resumed draft or unlock its active flight', async () => {
    const page = await fixture(); page.edit('apiKey', 'synthetic-old');
    const oldRead = deferred<unknown>(); page.read(() => oldRead.promise);
    const old = page.confirm(); await flush();
    await page.suspend();
    const newRead = deferred<unknown>(); page.read(() => newRead.promise);
    await page.resume();
    oldRead.resolve({ ...page.settings }); expect(await old).toBeNull();
    expect(page.tester().props.disabled).toBe(true);
    newRead.resolve({ ...page.settings }); await flush();
    expect(page.tester().props.disabled).toBe(false); expect(page.data('apiKey')).toBe('synthetic-old');
    page.edit('apiKey', 'synthetic-new'); page.read(null);
    expect(await page.confirm()).toBeNull(); expect(page.data('apiKey')).toBe('synthetic-new');
    expect(page.calls.filter(call => call.input.method === 'PUT')).toHaveLength(1);
    page.dispose();
  });

  it('actual Host change permanently retires the mounted editor through A-B-A', async () => {
    const page = await fixture(); page.edit('apiKey', 'synthetic-secret'); const old = page.tester();
    const count = page.calls.length;
    await page.switchHost('synthetic-B'); await page.switchHost('synthetic-A');
    expect(page.calls).toHaveLength(count); expect(await page.confirm(old)).toBeNull();
    expect(page.tester().props.disabled).toBe(true); expect(page.data('apiKey')).toBe('synthetic-secret');
    page.dispose();
  });

  it('legacy foreground remains explicitly read-only and never certifies a preview or ASR start', async () => {
    const page = await fixture({ legacy: true });
    expect(page.calls.filter(call => call.name === 'runtime.request').map(call => call.input.method)).toEqual(['GET']);
    expect((page.tester().props.current as () => boolean)()).toBe(false);
    expect(await page.confirm()).toBeNull();
    const adapter = page.tester().props.asrAdapter as import('./settings-voice-test-core').VoiceTestAsrAdapter;
    expect(adapter.supports('local')).toBe(false);
    await expect(adapter.start({ owner: 'synthetic', revision: 1, provider: 'local', partial() {} })).rejects.toThrow('scope_required');
    expect(page.calls.some(call => call.name === 'voiceRecognition.start' || call.input.method === 'PUT')).toBe(false);
    page.dispose();
  });

  it('late retired capabilities cannot replace or disable the resumed adapter', async () => {
    const page = await fixture(), oldCapabilities = deferred<unknown>();
    await page.hide(); page.capabilities(() => oldCapabilities.promise);
    const show = page.show(); await flush();
    await page.suspend(); page.capabilities(null); await page.resume();
    const resumed = page.tester(); expect(resumed.props.disabled).toBe(false);
    oldCapabilities.resolve({ providers: ['local'], maximumSeconds: 60, maximumBytes: 1_920_000 }); await show; await flush();
    expect(page.tester()).toBe(resumed); expect(resumed.props.disabled).toBe(false);
    expect(page.listeners.get('voiceRecognition.partial')?.size).toBe(1);
    expect(page.listeners.get('voiceRecognition.invalidated')?.size).toBe(1);
    page.dispose();
  });

  it('new capability ownership waits for old tester stop/release; stale tester calls cannot borrow the new operation', async () => {
    const page = await fixture(), old = page.tester(), stop = deferred<unknown>();
    page.stop(stop.promise);
    const call = old.props.call as (name: string, input: Record<string, unknown>) => Promise<unknown>;
    const cleanup = call('speech.stop', { owner: 'synthetic-audio', revision: 1 }).then(() => call('speech.release', { owner: 'synthetic-audio', revision: 1 }));
    await page.suspend(); await page.resume();
    expect(page.calls.filter(value => value.name === 'voiceRecognition.capabilities')).toHaveLength(1);
    expect(page.tester().props.disabled).toBe(true);
    stop.resolve(null); await cleanup; await flush();
    expect(page.calls.filter(value => value.name === 'voiceRecognition.capabilities')).toHaveLength(2);
    expect(page.calls.map(value => value.name).lastIndexOf('speech.release')).toBeLessThan(page.calls.map(value => value.name).lastIndexOf('voiceRecognition.capabilities'));
    expect(page.tester().props.disabled).toBe(false);
    const count = page.calls.length;
    await expect(call('speech.prepare', { owner: 'retired-owner' })).rejects.toThrow('settings_operation_stale');
    expect(page.calls).toHaveLength(count);
    page.dispose();
  });

  it('failed old tester cleanup blocks reacquisition until explicit retry of that same audio owner', async () => {
    const page = await fixture(), old = page.tester(), stop = deferred<unknown>();
    page.stop(stop.promise);
    const call = old.props.call as (name: string, input: Record<string, unknown>) => Promise<unknown>;
    const cleanup = call('speech.stop', { owner: 'synthetic-old-audio', revision: 7 });
    stop.resolve(Promise.reject(new Error('Synthetic cleanup failure')));
    await expect(cleanup).rejects.toThrow('Synthetic cleanup failure');
    await page.suspend(); await page.resume();
    expect(page.calls.filter(value => value.name === 'voiceRecognition.capabilities')).toHaveLength(1);
    expect(page.tester().props.disabled).toBe(true);
    page.stop(null);
    (page.one('settings-voice-recognition-retry').props.onPress as () => void)(); await flush();
    expect(page.calls.filter(value => value.name === 'speech.stop').map(value => value.input)).toEqual([
      { owner: 'synthetic-old-audio', revision: 7 }, { owner: 'synthetic-old-audio', revision: 7 },
    ]);
    expect(page.calls.filter(value => value.name === 'voiceRecognition.capabilities')).toHaveLength(2);
    expect(page.tester().props.disabled).toBe(false);
    page.dispose();
  });
});

const press = (page: Awaited<ReturnType<typeof fixture>>, label: string) => {
  const node = page.nodes().find(node => node.type === 'Button' && node.children.some(child => (child as Node)?.children?.includes(label)));
  if (!node) throw new Error('Missing production action ' + label);
  (node.props.onPress as () => void)();
};

describe('persistent Settings page operation recovery (pure production callbacks)', () => {
  it('an unknown custom Provider create cannot allocate a second instance after resume and Save retry', async () => {
    const reply = deferred<unknown>(); let created = false;
    const page = await fixture({ surface: 'providers', props: { page: 'providers', create: true, directory: '/actual/worktree' }, respond: async (path, method, body) => {
      if (method === 'POST') { expect(path).toBe('/api/config/providers/custom'); expect(Object.keys(body as object).sort()).toEqual(['apiKey', 'config', 'directory']); created = true; return reply.promise; }
      expect(path).toBe('/api/config/catalog/providers?directory=%2Factual%2Fworktree');
      return { schemaVersion: 1, providers: created ? [{ id: 'server-generated-id', name: 'Provider Name', models: {} }] : [] };
    } });
    const change = (title: string, value: string) => {
      const node = page.nodes().find(node => node.props.title === title);
      if (!node) throw new Error('Missing Provider field ' + title);
      (node.props.onChange as (value: string) => void)(value);
    };
    change('settings.providers.custom.name', 'Provider Name'); change('settings.providers.custom.baseURL', 'https://provider.invalid/v1'); change('settings.voice.page.field.apiKey', 'synthetic-key');
    press(page, 'settings.providers.custom.addModel'); change('settings.providers.custom.modelId', 'model-id'); press(page, 'settings.plugins.page.action.save'); await flush();
    press(page, 'settings.plugins.page.action.save'); await flush(); expect(created).toBe(true);
    await page.suspend(); await page.resume(); reply.resolve({ providerId: 'server-generated-id' }); await flush();
    press(page, 'settings.plugins.page.action.save'); await flush();
    expect(page.calls.filter(call => call.input.method === 'POST')).toHaveLength(1);
    expect(page.calls.at(-1)?.input.method).toBe('GET');
    expect(page.nodes().find(node => node.props.title === 'settings.voice.page.field.apiKey')?.props.value).toBe('synthetic-key');
    page.dispose();
  });
  it('collection editor retains a long dirty template and same Scroll, then saves on the confirmed replacement scope', async () => {
    const calls: Array<{ path: string; method: string; body: unknown }> = [];
    const page = await fixture({ surface: 'collection', props: { page: 'commands', entity: 'example', directory: '/actual/worktree' }, respond: async (path, method, body) => {
      calls.push({ path, method, body });
      if (method === 'GET') { expect(path).toBe('/api/command?location%5Bdirectory%5D=%2Factual%2Fworktree'); return [{ name: 'example', template: 'Host template', scope: 'project' }]; }
      expect(path).toBe('/api/config/commands/example?directory=%2Factual%2Fworktree'); expect(method).toBe('PATCH'); return {};
    } });
    const tree = page.tree, value = 'long exact template\n'.repeat(500);
    (page.one('settings-template').props.onChange as (value: string) => void)(value);
    await page.hide(); await page.show(); expect(calls).toHaveLength(1);
    await page.suspend(); const before = calls.length; await page.pendingForeground(); expect(calls).toHaveLength(before);
    await page.resume();
    expect(page.tree).toBe(tree); expect(page.one('settings-template').props.value).toBe(value);
    expect(calls.map(call => call.method)).toEqual(['GET', 'GET']);
    press(page, 'settings.plugins.page.action.save'); await flush();
    expect(calls.at(-1)?.body).toEqual({ template: value });
    expect(page.calls.filter(call => call.input.method === 'PATCH').map(call => call.input.expectedHost)).toEqual([{ hostID: 'synthetic-A', lease: 'synthetic-lease-2' }]);
    page.dispose();
  });

  it('integration keeps an unsaved secret through resume, clears it on ACK, and later read failures cannot replay POST', async () => {
    let written = false, failRead = false;
    const page = await fixture({ surface: 'integration', props: { integrationID: 'example', directory: '/actual/worktree' }, respond: async (path, method, body) => {
      if (method === 'POST') { expect(path).toBe('/api/integration/example/connect/key?location%5Bdirectory%5D=%2Factual%2Fworktree'); expect(body).toEqual({ key: 'synthetic-secret', answer: {} }); written = true; failRead = true; return {}; }
      expect(method).toBe('GET'); if (failRead) throw new Error('Synthetic metadata read failure');
      return { data: { methods: [{ id: 'key', type: 'key' }] } };
    } });
    const input = page.one('integration-api-key'); (input.props.onChange as (value: string) => void)('synthetic-secret');
    await page.suspend(); await page.resume();
    expect(page.one('integration-api-key')).toBe(input); expect(input.props.value).toBe('synthetic-secret');
    (page.one('integration-save-key').props.onPress as () => void)(); await flush();
    expect(written).toBe(true); expect(input.props.value).toBe('');
    await page.suspend(); failRead = false; await page.resume('synthetic-lease-3');
    (page.one('integration-save-key').props.onPress as () => void)(); await flush();
    expect(page.calls.filter(call => call.input.method === 'POST')).toHaveLength(1);
    page.dispose();
  });

  it('archive restore retains its pending ACK across background and resumes only GET verification with the session directory', async () => {
    let written = false, failRead = false;
    const page = await fixture({ surface: 'archive', props: { page: 'archived-sessions', entity: 'archived', directory: '/route/context' }, respond: async (path, method, body) => {
      if (method === 'PUT') { expect(body).toEqual({ archivedAt: 0, directory: '/session/own-directory' }); written = true; failRead = true; return {}; }
      if (failRead) throw new Error('Synthetic restore readback failure');
      if (path.includes('/message?')) return { data: [] };
      return { id: 'archived', location: { directory: '/session/own-directory' }, time: { archived: written ? 0 : 123 } };
    } });
    press(page, 'settings.yuri.archivedSessions.actions.restore'); await flush();
    await page.suspend(); failRead = false; await page.resume();
    press(page, 'settings.yuri.archivedSessions.actions.restore'); await flush();
    expect(page.calls.filter(call => call.input.method === 'PUT')).toHaveLength(1);
    expect(page.calls.at(-1)?.input.path).toBe('/api/session/archived?directory=%2Fsession%2Fown-directory');
    page.dispose();
  });

  it('project setup retains command row identities and dirty fields without scheduling a write during foreground recovery', async () => {
    vi.useFakeTimers();
    try {
      let config: Record<string, unknown> = { 'setup-worktree': ['first', 'second'], 'setup-worktree-wait': false };
      const page = await fixture({ surface: 'projects', props: { page: 'projects', entity: 'example' }, respond: async (path, method, body) => {
        if (path === '/api/config/settings') return { projects: [{ id: 'example', path: '/actual/project', label: 'Host label' }] };
        if (path === '/api/fs/home') return { home: '/synthetic-home' };
        if (path.startsWith('/api/fs/read?')) return JSON.stringify(config);
        if (path.startsWith('/api/fs/write?')) { expect(method).toBe('POST'); config = JSON.parse((body as { content: string }).content); return { success: true }; }
        if (path.startsWith('/api/config/catalog/providers')) return { schemaVersion: 1, providers: [] };
        if (path.startsWith('/api/git/check?')) return { isGitRepository: true };
        throw new Error('Unexpected project request ' + path);
      } });
      const first = page.one('project-setup-command-0'), second = page.one('project-setup-command-1'), value = 'preserve exact setup\n'.repeat(400);
      (first.props.onChange as (value: string) => void)(value);
      (page.one('settings-project-label').props.onChange as (value: string) => void)('Unsaved label');
      await flush(); await page.suspend(); await page.resume(); await vi.advanceTimersByTimeAsync(1000);
      expect(page.one('project-setup-command-0')).toBe(first); expect(page.one('project-setup-command-1')).toBe(second);
      expect(first.props.value).toBe(value); expect(page.one('settings-project-label').props.value).toBe('Unsaved label');
      expect(page.calls.filter(call => call.input.method !== 'GET')).toEqual([]);
      (page.one('project-setup-save').props.onPress as () => void)(); await flush();
      expect(page.calls.filter(call => call.input.method === 'POST')).toHaveLength(1);
      expect(config['setup-worktree']).toEqual([value, 'second']);
      expect(page.one('project-setup-command-0')).toBe(first);
      page.dispose();
    } finally { vi.useRealTimers(); }
  });

  it('a download owner recovers status on its new lane while retaining progress and never replays an unknown POST', async () => {
    vi.useFakeTimers();
    try {
      const id = voiceModels.voiceLocalModels[0].id, reply = deferred<unknown>();
      const status = { id, installed: false, downloading: false, downloadProgress: null as number | null, downloadError: null };
      const page = await fixture({ surface: 'downloads', props: { stt: true, tts: false, selectedModel: id, voice: 0, disabled: false, onSelect() {}, onVoice() {} }, respond: async (path, method) => {
        if (method === 'POST') { expect(path).toBe(`/api/dictation/models/${id}/download`); status.downloading = true; status.downloadProgress = 7; return reply.promise; }
        expect(path).toBe('/api/dictation/status?provider=local'); expect(method).toBe('GET'); return { provider: 'local', models: [{ ...status }], ttsModels: [] };
      } });
      (page.one(`voice-local-download-${id}`).props.onPress as () => void)(); await flush();
      await page.suspend(); status.downloadProgress = 37; await page.resume();
      expect(page.one(`voice-local-progress-${id}`).props.value).toBe(37);
      const count = page.calls.length;
      reply.resolve({ ok: true }); await flush();
      expect(page.calls).toHaveLength(count);
      await vi.advanceTimersByTimeAsync(2000);
      expect(page.calls.filter(call => call.input.method === 'POST')).toHaveLength(1);
      expect(page.calls.filter(call => call.input.method === 'DELETE')).toHaveLength(0);
      expect(page.calls.at(-1)?.input.expectedHost).toEqual({ hostID: 'synthetic-A', lease: 'synthetic-lease-2' });
      page.dispose();
    } finally { vi.useRealTimers(); }
  });
});
