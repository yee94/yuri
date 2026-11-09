import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeLayoutDensity } from './native-density';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test } from 'vitest';
import * as basicCore from './settings-basics-core';
import * as confirm from './settings-voice-confirm';
import * as recognition from './settings-voice-recognition';
import * as protocol from './settings-protocol';
import * as testCore from './settings-voice-test-core';
import * as labels from './settings-voice-test-labels';
import * as presentation from './settings-voice-test-presentation';
import * as speech from '../ui/src/lib/voice/speechSettings';
import * as model from './model';
import * as runtimeScopeProtocol from './runtime-scope';
import { createDesktopSettingsContentProtection } from './desktop-settings-content-core';

const root = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
type Node = { type: string | ((props: Record<string, unknown>) => Node); props: Record<string, unknown>; children: unknown[] };

/** Execute actual SettingsBasics + SettingsVoiceTests callbacks and actual save,
 * lifetime, test controller and recognition adapter. JSX is inert/lazily observed;
 * this proves production callback wiring, NOT NSH rendering or navigation. Only
 * transport, signals/effect scheduling and unrelated component leaves are ports. */
async function productionFixture(initialActive = true) {
  let observer: (() => void) | null = null;
  const scheduled = new Set<() => void>();
  const source = <T>(initial: T) => {
    let value = initial; const subscribers = new Set<() => void>();
    return Object.assign(() => { if (observer) subscribers.add(observer); return value; }, { set(next: T) {
      if (Object.is(value, next)) return; value = next;
      for (const run of subscribers) if (!scheduled.has(run)) { scheduled.add(run); queueMicrotask(() => { scheduled.delete(run); run(); }); }
    } });
  };
  const untracked = <T>(work: () => T) => { const previous = observer; observer = null; try { return work(); } finally { observer = previous; } };
  const cleanups: Array<() => void> = [];
  const effect = (work: () => void) => {
    let alive = true;
    const run = () => { if (!alive) return; const previous = observer; observer = run; try { work(); } finally { observer = previous; } };
    cleanups.push(() => { alive = false; }); run();
  };
  const settings = { ...speech.speechDefaults, configured: true, voiceProvider: 'say' as const, sayVoice: 'Authority not in page fields' };
  const wire: Array<{ method: string; body?: unknown }> = [], nativeCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  const runtimeWire: Array<Record<string, unknown>> = [], rejectedAdmissions: string[] = [];
  const originalScope = Object.freeze({ hostID: 'fixture-host', lease: '22222222-2222-4222-8222-222222222222' });
  const replacementScope = Object.freeze({ hostID: 'other-host', lease: '33333333-3333-4333-8333-333333333333' });
  let nativeAdmissionScope: runtimeScopeProtocol.RuntimeScope = originalScope;
  let get: (() => Promise<unknown>) | null = null, put: (() => Promise<unknown>) | null = null;
  let capabilities: (() => Promise<unknown>) | null = null;
  let segment: Promise<unknown> | null = null;
  const active = source(initialActive), foreground = source(true), ready = source(true), generation = source(1);
  const protection = createDesktopSettingsContentProtection({ page: 'voice', active: () => active() && foreground(), changed() {}, unavailable: async () => { throw new Error('Voice owner must publish real protection'); } });
  const connection = source({ id: 'fixture-host', url: 'https://fixture.example.invalid', authorizationID: 'fixture-authorization' });
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  const emit = (name: string, value: unknown) => [...listeners.get(name) ?? []].forEach(callback => callback(value));
  const request = async (resource: string, method = 'GET', body?: unknown) => {
    if (resource !== '/api/voice/settings' || !['GET', 'PUT'].includes(method)) throw new Error(`Unexpected production confirmation request: ${method} ${resource}`);
    wire.push({ method, ...(body === undefined ? {} : { body }) });
    if (method === 'GET') return get ? get() : { ...settings, apiKey: '********' };
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid patch');
    for (const [key, value] of Object.entries(body)) {
      if (!(key in speech.speechDefaults)) throw new Error('Unknown patch key');
      Object.assign(settings, speech.speechSecretFields.has(key) ? { [key === 'apiKey' ? 'configured' : `${key}Configured`]: !!String(value).trim() } : { [key]: value });
    }
    return put ? put() : { ...settings };
  };
  const exact = (input: Record<string, unknown>, keys: string) => { if (Object.keys(input).sort().join(',') !== keys) throw new Error('Unexpected native payload'); };
  const admit = (input: unknown) => {
    const scope = runtimeScopeProtocol.runtimeScopeFrom(input);
    if (!scope || !runtimeScopeProtocol.sameRuntimeScope(scope, nativeAdmissionScope)) { rejectedAdmissions.push('scope_mismatch'); throw new Error('scope_mismatch'); }
  };
  const native = async (name: string, input: Record<string, unknown>) => {
    if (name === 'runtime.request') {
      const method = input.method;
      exact(input, ['expectedHost', 'method', 'path', ...(input.body === undefined ? [] : ['body'])].sort().join(',')); admit(input.expectedHost);
      if (typeof input.path !== 'string' || !['GET', 'PUT'].includes(String(method))) throw new Error('Unexpected runtime wire');
      runtimeWire.push(input); return { status: 200, body: await request(input.path, String(method), input.body) };
    }
    if (name === 'voiceRecognition.start') { exact(input, 'expectedHost,owner,provider,revision'); admit(input.expectedHost); }
    nativeCalls.push({ name, input });
    if (name === 'voiceRecognition.capabilities') { exact(input, ''); return capabilities ? capabilities() : { providers: ['local', 'volcengine', 'openai-compatible'], maximumSeconds: 60, maximumBytes: 1_920_000 }; }
    if (name === 'voiceRecognition.start') { if (input.provider !== settings.sttProvider) throw new Error('Unexpected provider'); return { owner: input.owner, revision: input.revision, provider: input.provider }; }
    if (name === 'voiceRecognition.cancel') { exact(input, 'owner,revision'); return null; }
    if (name === 'voiceRecognition.finish') { exact(input, 'owner,revision'); return { text: 'Synthetic authoritative transcript' }; }
    if (name === 'speech.prepare') { exact(input, 'owner'); return { visible: false, provider: settings.voiceProvider, mode: settings.ttsInputMode }; }
    if (name === 'speech.segment') { exact(input, 'owner,revision,source,text'); if (input.source !== 'settings-preview') throw new Error('Unexpected speech source'); return segment ? await segment : null; }
    if (name === 'speech.stop') { exact(input, 'owner,revision'); return null; }
    if (name === 'speech.release') { exact(input, 'owner'); return null; }
    throw new Error(`Unexpected production confirmation native call: ${name}`);
  };
  const runtimeScope = source<runtimeScopeProtocol.RuntimeScope | null>(originalScope);
  const reactive = ['when', 'of', 'value', 'disabled', 'active', 'dirty', 'draftRevision', 'tts', 'asr', 'selectedModel', 'voice'];
  const jsx = (type: Node['type'], props: Record<string, unknown> | null, ...children: unknown[]): Node => {
    const observed = { ...props };
    for (const key of reactive) if (typeof observed[key] === 'function') Object.defineProperty(observed, key, { get: observed[key] as () => unknown });
    return { type, props: observed, children };
  };
  const modules: Record<string, unknown> = {
    nsh: { signal: source, Scroll: 'Scroll', Text: 'Text', View: 'View', cleanup: (work: () => void) => cleanups.push(work),
      effect, untracked, context: () => () => protection, lifecycle: () => foreground() ? 'active' : 'inactive',
      host: { available: () => true, call: native, on: (name: string, callback: (value: unknown) => void) => { const set = listeners.get(name) ?? new Set(); set.add(callback); listeners.set(name, set); return () => set.delete(callback); } } },
    'nsh/base': Object.fromEntries(['AlertDialog', 'Button', 'Input', 'Select', 'Switch', 'Dialog', 'NavPage', 'NavStack', 'TextView'].map(name => [name, name])),
    './native-select': { NativeSelect: 'NativeSelect' },
    './model': model, './settings-protocol': protocol, './runtime-scope': runtimeScopeProtocol,
    './state': { epoch: generation, app: { connection, runtimeScope } },
    './i18n': { t: (key: string) => key }, './settings-basics-core': basicCore, './settings-voice-confirm': confirm,
    './settings-voice-recognition': recognition, '../ui/src/lib/voice/speechSettings': speech,
    './settings-search-core': { createSettingsTargetNavigation: () => ({ onScroll() {}, reveal() {} }) },
    './settings-defaults': { SettingsDefaults: 'SettingsDefaults' }, './settings-target': { SettingsTarget: 'SettingsTarget' },
    './settings-sessions': { SettingsSessions: 'SettingsSessions' }, './settings-voice-catalog': { SettingsVoiceCatalog: 'SettingsVoiceCatalog' },
    './settings-preferences': { SettingsPreferences: 'SettingsPreferences' }, './settings-about': { SettingsAbout: 'SettingsAbout' },
    './notification-settings': { SettingsNotifications: 'SettingsNotifications' }, './settings-voice-models': { SettingsVoiceModels: 'SettingsVoiceModels' },
    './settings-retention': { SettingsSessionRetentionSection: 'SettingsSessionRetentionSection' }, './settings-voice-test': { SettingsVoiceTests: 'SettingsVoiceTests' },
    './settings-voice-test-core': testCore, './settings-voice-test-labels': labels, './settings-voice-test-presentation': presentation,
    './Icon': { Icon: 'Icon' },
    './appearance': { nativeDensity: () => nativeLayoutDensity(100) },
  };
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && reactive.includes(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        const getter = ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), ts.visitNode(node.initializer.expression, visit) as ts.Expression);
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, getter));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  const evaluate = (filename: string) => {
    const output = ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), { fileName: filename,
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { before: [lazy] } }).outputText;
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(output, { exports, jsx, If: 'If', Each: 'Each', require: (id: string) => { if (!(id in modules)) throw new Error('Unexpected production component import: ' + id); return modules[id]; } });
    return exports;
  };
  const runtime = evaluate('runtime.ts'); modules['./runtime'] = runtime;
  (modules['./state'] as Record<string, unknown>).captureHostRequest = () => (runtime.bindRequest as (scope: runtimeScopeProtocol.RuntimeScope | null) => unknown)(runtimeScope());
  // Evaluate the actual production declaration with only its root-owned inputs
  // replaced. Each result owns one fixed sender/scope/generation; no latest proxy.
  const stateSyntax = ts.createSourceFile('state.ts', readFileSync(path.join(root, 'state.ts'), 'utf8'), ts.ScriptTarget.ES2023, true);
  const declaration = stateSyntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'captureHostOperation');
  if (!declaration) throw new Error('Missing production captureHostOperation');
  const operationExports: { captureHostOperation?: typeof import('./state').captureHostOperation } = {};
  const operationContext = vm.createContext({ exports: operationExports, ...runtimeScopeProtocol, bindRequest: runtime.bindRequest,
    runtimeReady: ready, switching: false, lifecycle: () => foreground() ? 'active' : 'inactive', app: { connection, runtimeScope } });
  Object.defineProperty(operationContext, 'generation', { get: generation });
  vm.runInContext(ts.transpileModule(declaration.getText(stateSyntax), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, operationContext);
  const captureHostOperation = operationExports.captureHostOperation!;
  (modules['./state'] as Record<string, unknown>).captureHostOperation = captureHostOperation;
  modules['./desktop-settings-content-core'] = evaluate('desktop-settings-content-core.ts');
  modules['./desktop-settings-publisher'] = evaluate('desktop-settings-publisher.tsx');
  modules['./settings-controls'] = evaluate('settings-controls.tsx');
  const page = evaluate('settings-basics.tsx').SettingsBasics as (props: Record<string, unknown>) => Node;
  const tree = page({ page: 'voice', get active() { return active(); }, onBack() {} });
  await flush();
  const keyed = new WeakMap<Node, Map<unknown, unknown>>();
  function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object' || !('type' in value)) return [];
    const node = value as Node;
    if (node.type === 'If') return node.props.when ? node.children.flatMap(nodes) : [];
    if (node.type === 'Each') return (node.props.of as unknown[]).flatMap(item => {
      if (!node.props.key) return nodes((node.children[0] as (item: () => unknown) => unknown)(() => item));
      const key = (node.props.key as (item: unknown) => unknown)(item), cache = keyed.get(node) ?? new Map(); keyed.set(node, cache);
      if (!cache.has(key)) cache.set(key, (node.children[0] as (item: () => unknown) => unknown)(() => item));
      return nodes(cache.get(key));
    });
    if (node.type === 'NavStack') return node.children.flatMap(child => nodes(typeof child === 'function' ? child() : child));
    if (typeof node.type === 'function' && node.type.name === 'SettingsVoiceAsrTestDialog') return nodes(node.type(node.props));
    return [node, ...node.children.flatMap(nodes)];
  }
  const one = (type: string) => { const found = nodes(tree).find(node => node.type === type); if (!found) throw new Error('Production node not found: ' + type); return found; };
  let tester: Node | null = null, testerCleanup: Array<() => void> = [];
  const voiceKey = () => {
    const source = readFileSync(path.join(root, 'settings-basics.tsx'), 'utf8');
    expect(source).toContain('key={version => version}');
    // The actual keyed list value, not a test-invented owner revision.
    const visit = (value: unknown): Node | undefined => {
      if (Array.isArray(value)) return value.map(visit).find(Boolean);
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      const node = value as Node;
      if (node.type === 'Each' && typeof node.props.key === 'function' && (node.props.of as unknown[]).every(item => typeof item === 'number')) return node;
      return node.children.map(visit).find(Boolean);
    };
    // The parent field list is lazily built; traverse its rendered nodes too.
    const keyed = visit(tree) ?? nodes(tree).map(node => visit(node.children)).find(Boolean);
    if (!keyed) throw new Error('Production Voice keyed owner not found');
    return (keyed.props.of as number[])[0];
  };
  const mountTester = () => {
    const start = cleanups.length;
    const component = evaluate('settings-voice-test.tsx').SettingsVoiceTests as (props: Record<string, unknown>) => Node;
    // Real NSH primitives are not invoked: createNavStack only owns the dialog's
    // independent route data, and this fixture does not assert its presentation.
    (modules['nsh/base'] as Record<string, unknown>).createNavStack = () => ({});
    tester = component(one('SettingsVoiceTests').props); testerCleanup = cleanups.slice(start);
  };
  const button = (id: string) => {
    const found = nodes(tester ?? tree).find(node => node.props.testID === id);
    if (!found) throw new Error('Production action not found: ' + id);
    return found;
  };
  return { protection, settings, wire, runtimeWire, rejectedAdmissions, originalScope, nativeCalls, listeners, emit, voiceKey, mountTester,
    props: () => one('SettingsVoiceTests').props,
    edit: (key: string, value: unknown) => {
      const field = nodes(tree).find(node => node.props.testID === `settings-basics-${key}`);
      if (!field) throw new Error('Production field not found: ' + key);
      (field.props.onChange as (value: unknown) => void)(value);
    },
    models: () => one('SettingsVoiceModels').props,
    catalog: () => one('SettingsVoiceCatalog').props,
    confirm: (kind: testCore.VoiceTestKind) => (one('SettingsVoiceTests').props.confirm as (kind: testCore.VoiceTestKind) => Promise<testCore.VoiceTestConfirmation | null>)(kind),
    press: async (id: string) => { const action = button(id); expect(action.props.disabled).not.toBe(true); (action.props.onPress as () => void)(); await flush(); },
    button, get: (next: typeof get) => { get = next; }, put: (next: typeof put) => { put = next; },
    capabilities: (next: typeof capabilities) => { capabilities = next; }, refreshDiscovery: async () => { await flush(); },
    segment: (next: typeof segment) => { segment = next; },
    setActive: async (value: boolean) => { active.set(value); await flush(); },
    setForeground: async (value: boolean) => {
      if (!value) { foreground.set(false); ready.set(false); generation.set(generation() + 1); runtimeScope.set(null); }
      else { foreground.set(true); runtimeScope.set(nativeAdmissionScope); ready.set(true); }
      await flush();
    },
    switchHost: async () => { generation.set(generation() + 1); connection.set({ ...connection(), id: 'other-host' }); runtimeScope.set(replacementScope); nativeAdmissionScope = replacementScope; await flush(); },
    captureHostOperation,
    retireNativeAdmission: () => { nativeAdmissionScope = { ...originalScope, lease: '44444444-4444-4444-8444-444444444444' }; },
    rawNative: native,
    unmountTester: async () => { testerCleanup.forEach(stop => stop()); tester = null; await flush(); },
    dispose: async () => { cleanups.slice().reverse().forEach(stop => stop()); await flush(); },
  };
}

test('real Voice publishers aggregate delayed save, ASR dialog and playback without inventing clean state', async () => {
  const h = await productionFixture();
  expect(h.protection.snapshot()).toMatchObject({ status: 'ready', dirty: false, pending: false, nestedPickerOpen: false });
  h.edit('speechRate', 1.2); expect(h.protection.snapshot().dirty).toBe(true);
  const gate = deferred<unknown>(); h.put(() => gate.promise);
  const saving = h.confirm('tts'); await flush();
  expect(h.protection.snapshot().pending).toBe(true); expect(await h.protection.requestLeave()).toBe(false);
  gate.resolve({ ...h.settings }); await saving; await flush();
  expect(h.protection.snapshot()).toMatchObject({ dirty: false, pending: false });
  h.mountTester(); await h.press('settings-voice-asr-open');
  expect(h.protection.snapshot().nestedPickerOpen).toBe(true); expect(await h.protection.requestLeave()).toBe(false);
  (h.button('settings-voice-asr-dialog').props.onOpenChange as (event: { open: boolean }) => void)({ open: false }); await flush();
  expect(h.protection.snapshot().nestedPickerOpen).toBe(false);
  const audio = deferred<unknown>(); h.segment(audio.promise);
  await h.press('settings-voice-preview'); expect(h.protection.snapshot().pending).toBe(true);
  audio.resolve(null); await flush(); expect(h.protection.snapshot().pending).toBe(false);
  await h.dispose();
});

test('actual Voice production field -> confirm prop -> complete receipt -> actual tester preview (no mocked save helper)', async () => {
  const h = await productionFixture();
  h.edit('speechRate', '1.25'); const receipt = await h.confirm('tts');
  expect(receipt).toEqual({ settings: speech.parseSpeechSettings(h.settings), draftRevision: 1 });
  expect(receipt!.settings.sayVoice).toBe('Authority not in page fields');
  expect(h.props().dirty).toBe(false); h.mountTester(); await h.press('settings-voice-preview');
  expect(h.wire.map(call => call.method)).toEqual(['GET', 'PUT', 'GET', 'GET']);
  expect(h.nativeCalls.map(call => call.name)).toEqual(['voiceRecognition.capabilities', 'speech.prepare', 'speech.segment', 'speech.stop', 'speech.release']);
  await h.dispose();
});

test.each(['sayVoice', 'browserVoice'])('production directory callback edits %s through the retained Voice ACK journal', async key => {
  const h = await productionFixture();
  (h.catalog().onChange as (key: string, value: string) => void)(key, 'Samantha');
  expect(h.props().dirty).toBe(true);
  const receipt = await h.confirm('tts');
  expect(receipt?.settings[key as 'sayVoice' | 'browserVoice']).toBe('Samantha');
  expect(h.wire.filter(call => call.method === 'PUT')).toHaveLength(1);
  expect(h.props().dirty).toBe(false);
  await h.dispose();
});

test('actual tester preview saves the current dirty production draft itself before preparing any audio', async () => {
  const h = await productionFixture(); h.edit('speechRate', '1.4'); h.edit('apiKey', 'synthetic-current-key'); h.mountTester();
  await h.press('settings-voice-preview');
  expect(h.wire).toEqual([{ method: 'GET' }, { method: 'PUT', body: { speechRate: 1.4, apiKey: 'synthetic-current-key' } }, { method: 'GET' }]);
  expect(h.props()).toMatchObject({ dirty: false, draftRevision: 2 });
  expect(h.nativeCalls.map(call => call.name)).toEqual(['voiceRecognition.capabilities', 'speech.prepare', 'speech.segment', 'speech.stop', 'speech.release']); await h.dispose();
});

test('production Save button and test confirmation share the same ACK journal; failed read never repeats PUT', async () => {
  const h = await productionFixture(); h.edit('apiKey', 'synthetic-snapshot-secret');
  h.get(async () => { throw new Error('Synthetic GET failure'); }); await h.press('settings-basics-save');
  expect(h.props().dirty).toBe(true); expect(h.wire.map(call => call.method)).toEqual(['GET', 'PUT', 'GET']);
  h.get(null); const receipt = await h.confirm('asr'); expect(receipt!.settings.apiKey).toBe('');
  expect(h.props().dirty).toBe(false); expect(h.wire.map(call => call.method)).toEqual(['GET', 'PUT', 'GET', 'GET']);
  await h.dispose();
});

test('actual tester preview cannot prepare audio after unknown credential ACK or an incomplete authority GET', async () => {
  const h = await productionFixture(); h.edit('apiKey', 'synthetic-snapshot-secret'); h.put(async () => ({})); h.mountTester();
  await h.press('settings-voice-preview'); await h.press('settings-voice-preview');
  expect(h.wire.map(call => call.method)).toEqual(['GET', 'PUT', 'GET']); expect(h.props().dirty).toBe(true);
  expect(h.nativeCalls.map(call => call.name)).toEqual(['voiceRecognition.capabilities']); await h.dispose();
  const incomplete = await productionFixture(); incomplete.mountTester(); incomplete.get(async () => ({ voiceProvider: 'say', configured: true }));
  await incomplete.press('settings-voice-preview'); expect(incomplete.nativeCalls.map(call => call.name)).toEqual(['voiceRecognition.capabilities']); await incomplete.dispose();
});

test('actual production edit during delayed GET keeps new secret dirty and returns no receipt', async () => {
  const h = await productionFixture(); h.edit('apiKey', 'synthetic-first'); const gate = deferred<unknown>(); h.get(() => gate.promise);
  const saving = h.confirm('tts'); await flush(); h.edit('apiKey', 'synthetic-second'); gate.resolve({ ...h.settings });
  expect(await saving).toBeNull(); expect(h.props()).toMatchObject({ dirty: true, draftRevision: 2 });
  h.get(null); expect((await h.confirm('asr'))!.draftRevision).toBe(2);
  expect(h.wire.filter(call => call.method === 'PUT').map(call => call.body)).toEqual([{ apiKey: 'synthetic-first' }, { apiKey: 'synthetic-second' }]); await h.dispose();
});

test('production local-model manager callbacks still select the saved STT model and TTS speaker', async () => {
  const h = await productionFixture(), manager = h.models();
  (manager.onSelect as (id: string) => void)('synthetic-selected-model'); (manager.onVoice as (id: number) => void)(7);
  expect(h.models()).toMatchObject({ selectedModel: 'synthetic-selected-model', voice: 7 });
  const receipt = await h.confirm('asr'); expect(receipt!.settings).toMatchObject({ sttLocalModel: 'synthetic-selected-model', localTtsVoiceId: 7 }); await h.dispose();
});

test('actual production ASR uses capabilities + configured native adapter, and matching native invalidation retires the keyed tester only', async () => {
  const h = await productionFixture(); h.mountTester(); await h.press('settings-voice-asr-open'); await h.press('settings-voice-asr-primary');
  const start = h.nativeCalls.find(call => call.name === 'voiceRecognition.start')!; expect(start.input.provider).toBe('local');
  const version = h.voiceKey(); h.emit('voiceRecognition.invalidated', { ...start.input, revision: Number(start.input.revision) + 1 }); expect(h.voiceKey()).toBe(version);
  h.emit('voiceRecognition.invalidated', start.input); expect(h.voiceKey()).toBe(version + 1);
  // Execute cleanup/remount of the actual keyed production child explicitly;
  // there is no claim that this pure fixture exercised NSH reconciliation.
  await h.unmountTester(); expect(h.nativeCalls.at(-1)).toEqual({ name: 'voiceRecognition.cancel', input: { owner: start.input.owner, revision: start.input.revision } });
  h.mountTester(); expect(() => h.button('settings-voice-asr-primary')).toThrow('Production action not found');
  expect(h.nativeCalls.some(call => /Speech|speech\.start|system/i.test(call.name))).toBe(false); await h.dispose();
});

test.each(['hidden', 'background', 'host'] as const)('actual %s boundary closes ASR and cleans the capability subscriptions', async boundary => {
  const h = await productionFixture(); h.mountTester(); await h.press('settings-voice-asr-open'); await h.press('settings-voice-asr-primary');
  if (boundary === 'hidden') await h.setActive(false); else if (boundary === 'background') await h.setForeground(false); else await h.switchHost();
  expect(h.nativeCalls.some(call => call.name === 'voiceRecognition.cancel')).toBe(true);
  expect(h.listeners.get('voiceRecognition.invalidated')?.size).toBe(0); expect(h.listeners.get('voiceRecognition.partial')?.size).toBe(0);
  expect(await h.confirm('tts')).toBeNull(); await h.dispose();
});

test('a covered production Voice page does not read settings, discover capabilities or save until it is actually active', async () => {
  const h = await productionFixture(false); expect(h.wire).toEqual([]); expect(h.nativeCalls).toEqual([]);
  await h.setActive(true); // Signal dependencies schedule the ready-dependent acquisition after load.
  await h.setActive(true); expect(h.wire.map(call => call.method)).toEqual(['GET']);
  expect(h.nativeCalls.map(call => call.name)).toEqual(['voiceRecognition.capabilities']); await h.dispose();
});

test('production capability discovery failure remains a retryable failure, not authoritative unsupported success', async () => {
  const h = await productionFixture(false); h.capabilities(async () => { throw new Error('Synthetic unavailable bridge'); });
  await h.setActive(true); await h.refreshDiscovery(); expect(h.props().disabled).toBe(true);
  h.capabilities(null); await h.press('settings-voice-recognition-retry'); await h.refreshDiscovery();
  expect(h.props().disabled).toBe(false); h.mountTester(); await h.press('settings-voice-asr-open'); await h.press('settings-voice-asr-primary');
  expect(h.nativeCalls.filter(call => call.name === 'voiceRecognition.start')).toHaveLength(1); await h.dispose();
});

test('a late capability response after hiding does not install subscriptions or enable the inactive tester', async () => {
  const h = await productionFixture(false), gate = deferred<unknown>(); h.capabilities(() => gate.promise);
  await h.setActive(true); await h.refreshDiscovery(); await h.setActive(false);
  gate.resolve({ providers: ['local'], maximumSeconds: 60, maximumBytes: 1_920_000 }); await flush();
  expect(h.listeners.get('voiceRecognition.invalidated')?.size ?? 0).toBe(0); expect(h.props().disabled).toBe(true);
  expect(h.nativeCalls.filter(call => call.name === 'voiceRecognition.start')).toHaveLength(0); await h.dispose();
});

test('production settingsLifetime uses the real bound runtime sender and ASR start forwards the construction-time synthetic scope exactly', async () => {
  const h = await productionFixture(); h.edit('speechRate', '1.2'); expect(await h.confirm('tts')).not.toBeNull();
  expect(h.runtimeWire.map(input => [input.method, input.expectedHost])).toEqual([['GET', h.originalScope], ['PUT', h.originalScope], ['GET', h.originalScope]]);
  expect(h.runtimeWire[1]).toEqual({ path: '/api/voice/settings', method: 'PUT', body: { speechRate: 1.2 }, expectedHost: h.originalScope });
  h.mountTester(); await h.press('settings-voice-asr-open'); await h.press('settings-voice-asr-primary');
  expect(h.nativeCalls.find(call => call.name === 'voiceRecognition.start')!.input.expectedHost).toEqual(h.originalScope);
  expect(h.nativeCalls.filter(call => call.name === 'voiceRecognition.capabilities').every(call => Object.keys(call.input).length === 0)).toBe(true);
  await h.dispose();
  expect(h.nativeCalls.filter(call => call.name === 'voiceRecognition.cancel').every(call => Object.keys(call.input).sort().join(',') === 'owner,revision')).toBe(true);
});

test('stale/missing synthetic scope is rejected at native admission before any write, TTS/audio or ASR capture fake', async () => {
  const h = await productionFixture(); h.edit('apiKey', 'synthetic-current-key'); h.mountTester(); h.retireNativeAdmission();
  await h.press('settings-voice-preview'); expect(h.wire.map(call => call.method)).toEqual(['GET']);
  expect(h.nativeCalls.map(call => call.name)).toEqual(['voiceRecognition.capabilities']); expect(h.rejectedAdmissions).toEqual(['scope_mismatch']);
  for (const expectedHost of [undefined, null, { hostID: 'fixture-host', lease: '44444444-4444-4444-8444-444444444444', extra: true }]) {
    await expect(h.rawNative('runtime.request', { path: '/api/voice/settings', method: 'PUT', body: { apiKey: 'synthetic-current-key' }, ...(expectedHost === undefined ? {} : { expectedHost }) })).rejects.toThrow();
    await expect(h.rawNative('voiceRecognition.start', { owner: 'settings-voice-admission', revision: 1, provider: 'local', ...(expectedHost === undefined ? {} : { expectedHost }) })).rejects.toThrow();
  }
  await expect(h.rawNative('voiceRecognition.start', { owner: 'settings-voice-admission', revision: 1, provider: 'local', expectedHost: h.originalScope })).rejects.toThrow('scope_mismatch');
  expect(h.wire.map(call => call.method)).toEqual(['GET']); expect(h.nativeCalls.map(call => call.name)).toEqual(['voiceRecognition.capabilities']); await h.dispose();
});

test.each(['ack', 'unknown'] as const)('real operation factory + reactive page retains %s journal across renewal without a latest-request proxy', async mode => {
  const h = await productionFixture(), old = h.props(), captured = h.captureHostOperation();
  expect(Object.isFrozen(captured)).toBe(true); expect(captured.scope).toEqual(h.originalScope);
  h.edit('apiKey', 'synthetic-first');
  if (mode === 'ack') h.get(async () => { throw new Error('Synthetic GET failed'); });
  else h.put(async () => ({}));
  expect(await h.confirm('tts')).toBeNull(); expect(h.props().dirty).toBe(true);
  h.get(null); h.put(null); await h.setForeground(false);
  expect(captured.current()).toBe(false); expect((old.current as () => boolean)()).toBe(false);
  const count = h.runtimeWire.length;
  await expect(captured.request('/api/voice/settings', 'PUT', { apiKey: 'retired-callback-must-not-send' })).rejects.toThrow('host_operation_stale');
  expect(h.runtimeWire).toHaveLength(count);
  await h.setForeground(true);
  expect(captured.current()).toBe(false); expect(h.props().disabled).toBe(false); expect(h.props().dirty).toBe(true);
  expect(h.wire.filter(call => call.method === 'PUT').map(call => call.body)).toEqual([{ apiKey: 'synthetic-first' }]);
  expect(h.wire.map(call => call.method)).toEqual(mode === 'ack' ? ['GET', 'PUT', 'GET', 'GET'] : ['GET', 'PUT', 'GET']);
  expect(h.nativeCalls.filter(call => call.name === 'voiceRecognition.capabilities')).toHaveLength(2);
  const receipt = await h.confirm('tts');
  if (mode === 'ack') { expect(receipt).not.toBeNull(); expect(h.props().dirty).toBe(false); }
  else { expect(receipt).toBeNull(); expect(h.props().dirty).toBe(true); }
  expect(h.wire.filter(call => call.method === 'PUT')).toHaveLength(1); expect(h.rejectedAdmissions).toEqual([]); await h.dispose();
});

test('reactive lane replacement preserves new secret edits and rejects an old delayed GET/finally without unlocking the new flight', async () => {
  const h = await productionFixture(); h.edit('apiKey', 'synthetic-old');
  const oldGet = deferred<unknown>(); h.get(() => oldGet.promise); const oldConfirm = h.confirm('tts'); await flush();
  await h.setForeground(false);
  const newGet = deferred<unknown>(); h.get(() => newGet.promise); await h.setForeground(true);
  expect(h.props().disabled).toBe(true);
  oldGet.resolve({ ...h.settings }); expect(await oldConfirm).toBeNull(); expect(h.props().disabled).toBe(true);
  newGet.resolve({ ...h.settings }); await flush(); expect(h.props().disabled).toBe(false);
  h.edit('apiKey', 'synthetic-new'); h.get(null);
  expect(await h.confirm('tts')).toBeNull(); expect(h.props()).toMatchObject({ dirty: true, draftRevision: 2 });
  expect(h.wire.filter(call => call.method === 'PUT').map(call => call.body)).toEqual([{ apiKey: 'synthetic-old' }]);
  expect((await h.confirm('tts'))!.draftRevision).toBe(2);
  expect(h.wire.filter(call => call.method === 'PUT').map(call => call.body)).toEqual([{ apiKey: 'synthetic-old' }, { apiKey: 'synthetic-new' }]);
  expect(h.rejectedAdmissions).toEqual([]); await h.dispose();
});
