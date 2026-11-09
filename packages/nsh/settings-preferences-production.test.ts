import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import * as core from './settings-preferences-core';
import * as protocol from './settings-protocol';
import * as fonts from '../ui/src/lib/fontOptions';
import * as model from './model';
import { createDeviceChatPreferences } from './settings-preferences-device-core';
import * as scopeCore from './runtime-scope';
import * as attachments from './attachments';
import * as references from './composer-references';
import * as previewVisibility from './settings-preferences-preview-visibility';
import * as deviceAppearanceCore from './device-appearance-core';
import { nativeLayoutDensity } from './native-density';
import * as appearanceCore from './appearance-core';
import * as compatibilityCore from './local-compatibility-preferences-core';

const root = path.dirname(fileURLToPath(import.meta.url));
async function productionTranslations(locale: string) {
  const dictionaries: Record<string, unknown> = {};
  for (const name of ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk']) dictionaries[`../ui/src/lib/i18n/messages/${name}`] = await import(`../ui/src/lib/i18n/messages/${name}.ts`);
  const language = Object.assign(() => locale, { set() {} });
  const exports = {} as typeof import('./i18n');
  const source = ts.transpileModule(readFileSync(path.join(root, 'i18n.ts'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText;
  vm.runInNewContext(source, { exports, require: (id: string) => id === 'nsh' ? { locale: () => locale, signal: () => language } : dictionaries[id] });
  return { ...exports, dictionaries };
}
const flush = async () => { for (let index = 0; index < 160; index++) await Promise.resolve(); };
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
async function preferencesFixture(options: { compatibility?: { transportID?: string; disk?: Map<string, string>; readFailure?: (key: string) => boolean; writeFailure?: (key: string) => boolean; readWait?: Promise<void>; writeWait?: Promise<void>; brandReadWait?: Promise<void>; brandWriteWait?: Promise<void> }; page?: 'chat' | 'appearance'; realAppearance?: boolean; oldAppearanceApply?: Promise<void>; host?: Record<string, unknown>; acceptPatch?: (patch: Record<string, unknown>) => Record<string, unknown>; formatSettings?: (host: Record<string, unknown>) => Record<string, unknown>; readFailure?: () => boolean; writeFailure?: () => boolean; applyFailure?: () => boolean; applyWait?: Promise<void>; writeWait?: Promise<void>; clearHistoryCache?: () => Promise<void>; receiptStorage?: Map<string, string>; storageFailure?: () => boolean; receiptWrite?: (value: string) => Promise<void>; receiptModule?: unknown; animatePreview?: boolean; deviceRaw?: string | null; deviceReadFailure?: () => boolean; deviceWriteFailure?: () => boolean; deviceReadWait?: Promise<void>; deviceWriteWait?: Promise<void>; preloadDevice?: boolean } = {}, translations?: typeof import('./i18n')) {
  let observer: (() => void) | null = null;
  let mounted = true;
  const cleanups: (() => void)[] = [];
  const scheduled = new Set<() => void>();
  const schedule = (run: () => void) => { if (scheduled.has(run)) return; scheduled.add(run); queueMicrotask(() => { scheduled.delete(run); run(); }); };
  const signal = <T>(initial: T) => {
    let value = initial; const subscribers = new Set<() => void>();
    return Object.assign(() => { if (observer) subscribers.add(observer); return value; }, { set: (next: T) => {
      if (Object.is(value, next)) return;
      value = next; for (const run of subscribers) schedule(run);
    } });
  };
  const effect = (work: () => void | (() => void)) => {
    let release: void | (() => void);
    const run = () => { if (!mounted) return; release?.(); const previous = observer; observer = run; try { release = work(); } finally { observer = previous; } };
    cleanups.push(() => release?.()); run();
  };
  const untracked = <T>(work: () => T) => { const previous = observer; observer = null; try { return work(); } finally { observer = previous; } };
  const generation = signal(1), ready = signal(true), foreground = signal(true);
  const active = signal(true);
  const connection = signal({ id: 'synthetic-A', url: 'https://synthetic.invalid', authorizationID: 'synthetic-authorization', transportID: options.compatibility?.transportID });
  const scope = signal<scopeCore.RuntimeScope | null>({ hostID: 'synthetic-A', lease: 'synthetic-lease-1' });
  let raw: string | null = null;
  let deviceRaw = options.deviceRaw ?? null;
  const deviceRead = vi.fn(async () => { await options.deviceReadWait; if (options.deviceReadFailure?.()) throw new Error('fixture device read failed'); return deviceRaw; });
  const deviceWrite = vi.fn(async (value: string) => { await options.deviceWriteWait; if (options.deviceWriteFailure?.()) throw new Error('fixture device write failed'); deviceRaw = value; });
  const receiptStorage = options.receiptStorage ?? new Map<string, string>();
  const compatibilityDisk = options.compatibility?.disk ?? new Map<string, string>();
  const isBrandKey = (key: string) => key.startsWith('sidebar-brand-transport-v1.');
  const compatibilityRead = vi.fn(async (key: string) => { await options.compatibility?.readWait; if (isBrandKey(key)) await options.compatibility?.brandReadWait; if (options.compatibility?.readFailure?.(key)) throw new Error('synthetic compatibility read failure'); return compatibilityDisk.get(key) ?? null; });
  const compatibilityWrite = vi.fn(async (key: string, value: string) => { await options.compatibility?.writeWait; if (isBrandKey(key)) await options.compatibility?.brandWriteWait; if (options.compatibility?.writeFailure?.(key)) throw new Error('synthetic compatibility write failure'); compatibilityDisk.set(key, value); });
  const Storage = { getItem: async (key: string) => key === compatibilityCore.iosNativeUiPreferenceKey || isBrandKey(key) ? compatibilityRead(key) : key === deviceAppearanceCore.deviceAppearanceKey ? deviceRead() : receiptStorage.get(key) ?? null, setItem: async (key: string, value: string) => {
    if (key === compatibilityCore.iosNativeUiPreferenceKey || isBrandKey(key)) { await compatibilityWrite(key, value); return; }
    if (key === deviceAppearanceCore.deviceAppearanceKey) { await deviceWrite(value); return; }
    if (options.storageFailure?.()) throw new Error('fixture receipt storage failed'); receiptStorage.set(key, value); await options.receiptWrite?.(value);
  } };
  const preference = signal<ReturnType<ReturnType<typeof createDeviceChatPreferences>['snapshot']>>(null);
  const store = createDeviceChatPreferences({ get: async () => raw, set: async (_key, next) => { raw = next; }, changed: preference.set });
  let host = { ...options.host }, appearanceError = '';
  const request = vi.fn(async (_path: string, method?: string, body?: unknown) => {
    if (method === 'PUT') {
      if (options.writeFailure?.()) throw new Error('write failed');
      const patch = body as Record<string, unknown>;
      host = { ...host, ...(options.acceptPatch ? options.acceptPatch(patch) : patch) };
      if (options.writeWait) await options.writeWait;
      return {};
    }
    if (options.realAppearance && _path === '/api/config/themes') return { themes: [] };
    if (options.readFailure?.()) throw new Error('read failed');
    return options.formatSettings ? options.formatSettings(host) : host;
  });
  const refresh = vi.fn(async () => { await options.applyWait; appearanceError = options.applyFailure?.() ? 'apply failed' : ''; });
  const alert = vi.fn(async (_input: unknown) => ({ action: 'cancel' }));
  const defaultClear = vi.fn(async () => {}), injectedClear = options.clearHistoryCache ? vi.fn(options.clearHistoryCache) : undefined;
  let state!: ReturnType<typeof import('./settings-controls').settingsPageLifetime>;
  let appearanceRevision = 0, appearanceApplies = 0;
  const nativeCalls: { name: string; input: Record<string, unknown> }[] = [];
  const native = async (name: string, input: Record<string, unknown>) => {
    nativeCalls.push({ name, input });
    if (options.realAppearance && name === 'appearance.reset') return { revision: ++appearanceRevision };
    if (options.realAppearance && name === 'appearance.apply') {
      if (++appearanceApplies === 1) await options.oldAppearanceApply;
      return { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [], systemColorScheme: 'light' };
    }
    if (name !== 'runtime.request') throw new Error('Unexpected native call: ' + name);
    if (options.realAppearance && (!input.expectedHost || !scopeCore.sameRuntimeScope(scopeCore.runtimeScopeFrom(input.expectedHost), scope()))) throw new Error('strict fixture expectedHost mismatch');
    return { status: 200, body: await request(String(input.path), String(input.method), input.body) };
  };
  const lifecycle = () => foreground() ? 'active' : 'inactive';
  const appearanceTimers = new Map<number, () => void>(), cancelledAppearanceTimers: (() => void)[] = [];
  let appearanceTimerID = 0;
  const previewTimers = new Map<number, () => void>(), cancelledPreviewTimers: (() => void)[] = [];
  let previewTimerID = 0;
  const navigationScroll = vi.fn();
  const modules: Record<string, unknown> = {
    nsh: { signal, computed: (read: () => unknown) => read, colorScheme: () => 'light', setColorScheme() {}, effect, batch: (work: () => void) => work(), untracked, cleanup: (work: () => void) => cleanups.push(work), lifecycle, reduceMotion: () => !options.animatePreview, host: { available: () => true, call: native, on: () => () => {} }, Scroll: 'Scroll', Text: 'Text', View: 'View', Storage },
    'nsh/base': { Button: 'Button', Radio: 'Radio', RadioGroup: 'RadioGroup', AlertDialog: { show: alert } }, './i18n': translations ?? { t: (key: string) => key, language: signal('en') },
    './model': model, './settings-protocol': protocol, './settings-preferences-core': core,
    './settings-preferences-device': { deviceChatPreferences: preference, deviceChatPreferenceStore: store },
    './settings-preferences-device-core': await import('./settings-preferences-device-core'),
    './device-appearance-core': deviceAppearanceCore,
    './local-compatibility-preferences-core': compatibilityCore,
    './appearance': { nativeAppearance: { current: () => null, error: () => appearanceError, saving: () => false }, refreshNativeAppearance: refresh, saveNativeAppearanceMode: vi.fn(), nativeDensity: () => nativeLayoutDensity(100) },
    './appearance-core': options.realAppearance ? appearanceCore : { nativeAppearanceModeFromSettings: () => 'system' },
    './native-density': { nativeLayoutDensity },
    './native-select': { NativeSelect: 'Select' }, './runtime-scope': scopeCore,
    './attachments': attachments, './composer-references': references,
    './settings-target': { SettingsTarget: 'SettingsTarget' }, './settings-search-core': { createSettingsTargetNavigation: () => ({ onScroll: navigationScroll, reveal() {} }) },
    './settings-preferences-preview-visibility': previewVisibility,
    '../ui/src/lib/fontOptions': fonts, '../ui/src/lib/theme/themes': { themes: [] }, '../ui/src/contexts/theme-validation': { isValidTheme: () => false },
  };
  const jsx = (type: unknown, props: Node['props'], ...children: unknown[]) => ({ type, props: props ?? {}, children });
  function evaluate<T>(filename: string): T {
  const output = ts.transpileModule(readFileSync(path.join(root, filename), 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' },
    transformers: { after: [context => source => {
      const visit: ts.Visitor = node => {
        const next = ts.visitEachChild(node, visit, context);
        if (!ts.isCallExpression(next) || !ts.isIdentifier(next.expression) || next.expression.text !== 'jsx') return next;
        const props = next.arguments[1];
        if (!props || !ts.isObjectLiteralExpression(props)) return next;
        // NSH reads JSX properties reactively. Keep expressions live in this
        // callback-only fixture without mounting an engine or recreating owners.
        const reactive = ts.factory.updateObjectLiteralExpression(props, props.properties.map(property => ts.isPropertyAssignment(property)
          ? ts.factory.createGetAccessorDeclaration(undefined, property.name, [], undefined, ts.factory.createBlock([ts.factory.createReturnStatement(property.initializer)])) : property));
        return ts.factory.updateCallExpression(next, next.expression, next.typeArguments, [next.arguments[0], reactive, ...next.arguments.slice(2)]);
      };
      return ts.visitNode(source, visit) as ts.SourceFile;
    }] },
  }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, jsx, Error, setTimeout, clearTimeout,
    setInterval(work: () => void, period: number) { if (options.realAppearance && period === 30_000) { const id = --appearanceTimerID; appearanceTimers.set(id, work); return id; } if (period !== 420) throw new Error('Unexpected preview timer'); previewTimers.set(++previewTimerID, work); return previewTimerID; },
    clearInterval(id: number) { const appearance = appearanceTimers.get(id); if (appearance) cancelledAppearanceTimers.push(appearance); appearanceTimers.delete(id); const work = previewTimers.get(id); if (work) cancelledPreviewTimers.push(work); previewTimers.delete(id); },
    If: 'If', Each: 'Each', require: (id: string) => { if (!(id in modules)) throw new Error('Missing production fixture module: ' + id); return modules[id]; } });
  return exports as T;
  }
  const runtime = evaluate<typeof import('./runtime')>('runtime.ts');
  modules['./runtime'] = runtime;
  const stateSyntax = ts.createSourceFile('state.ts', readFileSync(path.join(root, 'state.ts'), 'utf8'), ts.ScriptTarget.ES2023, true);
  const declaration = stateSyntax.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'captureHostOperation');
  if (!declaration) throw new Error('Missing production captureHostOperation');
  const operationExports: { captureHostOperation?: typeof import('./state').captureHostOperation } = {};
  const context = vm.createContext({ exports: operationExports, Error, ...scopeCore, bindRequest: runtime.bindRequest, runtimeReady: ready, switching: false, lifecycle, app: { connection, runtimeScope: scope } });
  Object.defineProperty(context, 'generation', { get: generation });
  vm.runInContext(ts.transpileModule(declaration.getText(stateSyntax), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, context);
  modules['./state'] = { app: { connection, runtimeScope: scope }, epoch: generation, captureHostOperation: operationExports.captureHostOperation, captureHostRequest: () => runtime.bindRequest(scope()), clearHistoryCache: defaultClear };
  const controls = evaluate<typeof import('./settings-controls')>('settings-controls.tsx');
  modules['./settings-controls'] = { ...controls, settingsPageLifetime: (...args: Parameters<typeof controls.settingsPageLifetime>) => { state = controls.settingsPageLifetime(...args); return state; }, ...Object.fromEntries(['SettingsChoice', 'SettingsFeedback', 'SettingsGroup', 'SettingsInput', 'SettingsToggle'].map(name => [name, name])) };
  modules['./drafts'] = evaluate('drafts.ts');
  modules['./settings-preferences-receipt'] = options.receiptModule ?? evaluate('settings-preferences-receipt.ts');
  modules['./settings-preferences-fields'] = evaluate('settings-preferences-fields.tsx');
  modules['./local-compatibility-preferences'] = evaluate('local-compatibility-preferences.ts');
  const deviceAppearance = evaluate<typeof import('./device-appearance')>('device-appearance.ts');
  const loadDevice = vi.fn(deviceAppearance.loadDeviceAppearance), saveDevice = vi.fn(deviceAppearance.saveDeviceCodeFontSize), saveEditor = vi.fn(deviceAppearance.saveDeviceEditorFontSize), saveKeymap = vi.fn(deviceAppearance.saveDeviceFileEditorKeymap);
  modules['./device-appearance'] = { ...deviceAppearance, loadDeviceAppearance: loadDevice, saveDeviceCodeFontSize: saveDevice, saveDeviceEditorFontSize: saveEditor, saveDeviceFileEditorKeymap: saveKeymap };
  if (options.preloadDevice) await loadDevice();
  const realAppearance = options.realAppearance ? evaluate<typeof import('./appearance')>('appearance.tsx') : undefined;
  if (realAppearance) { modules['./appearance'] = realAppearance; realAppearance.NativeAppearanceSync(); }
  if (options.animatePreview) modules['./settings-target'] = evaluate('settings-target.tsx');
  const exports = evaluate<{ SettingsPreferences: (props: unknown) => Node }>('settings-preferences.tsx');
  const onBack = vi.fn(), onCollectionNavigation = vi.fn();
  const tree = exports.SettingsPreferences!({ page: options.page ?? 'chat', get active() { return active(); }, onBack, onCollectionNavigation, ...(injectedClear ? { clearHistoryCache: injectedClear } : {}) }); await flush();
  // Each children stay production callbacks; evaluating them builds the actual
  // field handlers with the current signal data instead of a copied save helper.
  const nodes = (value: unknown): Node[] => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object' || !('props' in value)) return [];
    const node = value as Node;
    if (typeof node.type === 'function') return nodes(node.type(Object.assign(Object.create(node.props), { children: node.children })));
    if (node.type === 'If') return node.props.when ? node.children.flatMap(nodes) : nodes(node.props.else);
    const children = node.children.flatMap(child => typeof child === 'function' && Array.isArray(node.props.of) ? node.props.of.map((item, index) => (child as (accessor: () => unknown, index: () => number) => unknown)(() => item, () => index)) : [child]);
    return [node, ...children.flatMap(nodes)];
  };
  return { nodes: () => nodes(tree), nativeCalls, appearanceTimers, cancelledAppearanceTimers, compatibilityDisk, compatibilityRead, compatibilityWrite, realAppearance, appearanceApplies: () => appearanceApplies, previewTimers, cancelledPreviewTimers, previewStarts: () => previewTimerID, navigationScroll, request, refresh, alert, onBack, onCollectionNavigation, state, preference, defaultClear, injectedClear, raw: () => raw, receiptStorage, receiptModule: modules['./settings-preferences-receipt'], deviceAppearance, loadDevice, saveDevice, saveEditor, saveKeymap, deviceRead, deviceWrite, deviceRaw: () => deviceRaw, host: () => ({ ...host }), setHost: (next: Record<string, unknown>) => { host = { ...host, ...next }; },
    dispose() { mounted = false; for (const work of cleanups) work(); },
    async hide() { active.set(false); await flush(); },
    async show() { active.set(true); await flush(); },
    async replaceTransport(transportID: string | undefined) { connection.set({ ...connection(), transportID }); await flush(); },
    async replaceLane() {
      foreground.set(false); ready.set(false); generation.set(generation() + 1); scope.set(null); await flush();
      scope.set({ hostID: connection().id, lease: `synthetic-lease-${generation()}` }); ready.set(true); foreground.set(true); await flush();
    },
  };
}

test('production iOS compatibility flag loads locally, saves both booleans and restores without Host or native UI changes', async () => {
  const disk = new Map<string, string>();
  const fixture = await preferencesFixture({ page: 'appearance', host: { iosNativeUiEnabled: true }, compatibility: { disk } });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  expect(find('settings-preference-iosNativeUiEnabled')).toBeDefined();
  expect(find('settings-preference-iosNativeUiEnabled').props.value).toBe(false);
  expect(fixture.compatibilityWrite).not.toHaveBeenCalled();
  for (const value of [true, false]) {
    (find('settings-preference-iosNativeUiEnabled').props.onChange as (value: boolean) => void)(value);
    (find('settings-preferences-save').props.onPress as () => void)(); await flush();
    expect(JSON.parse(disk.get(compatibilityCore.iosNativeUiPreferenceKey)!)).toEqual({ iosNativeUiEnabled: value });
    expect(fixture.state.notice()).toBe('filesView.editor.saved');
    expect(find('settings-preferences-save').props.disabled).toBe(true);
  }
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(fixture.refresh).not.toHaveBeenCalled(); fixture.dispose();
  const reopened = await preferencesFixture({ page: 'appearance', compatibility: { disk } });
  expect(reopened.nodes().find(node => node.props.testID === 'settings-preference-iosNativeUiEnabled')!.props.value).toBe(false); reopened.dispose();
});

test.each(['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk'])('actual NSH translator rejects missing/undefined keys and resolves production descriptions with working local Save in %s', async locale => {
    const translations = await productionTranslations(locale);
    // The real translator rejects missing keys and undefined optional keys;
    // the key-echo double concealed both while JSX constructed field children.
    expect(() => translations.t('settings.preferences.native.missingDescription' as Parameters<typeof translations.t>[0])).toThrow(/replace/);
    expect(() => translations.t(undefined as unknown as Parameters<typeof translations.t>[0])).toThrow(/replace/);
    for (const field of core.settingsPreferenceFields) {
      if (field.description) expect(translations.t(field.description), `${locale}: ${field.key}`).toBeTruthy();
    }
    const fixture = await preferencesFixture({ page: 'appearance', compatibility: { transportID: 'synthetic-translated-route' } }, translations);
    expect(fixture.state.error()).toBe(''); expect(fixture.state.ready()).toBe(true);
    for (const field of core.settingsPreferenceFields.filter(field => field.description)) {
      const description = fixture.nodes().find(node => node.props.testID === `settings-description-${field.key}`);
      expect(description?.children).toContain(translations.t(field.description!));
    }
    const code = fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize')!;
    (code.props.onChange as (value: string) => void)('150');
    const save = fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
    expect(save.props.disabled).toBe(false); (save.props.onPress as () => void)(); await flush();
    expect(fixture.state.error()).toBe(''); expect(JSON.parse(fixture.deviceRaw()!).codeFontSize).toBe(150);
    expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test.each(['read', 'invalid'] as const)('production iOS %s failure remains unknown and cannot write until explicit read retry', async failure => {
  let fail = true;
  const disk = new Map([[compatibilityCore.iosNativeUiPreferenceKey, failure === 'invalid' ? '{"iosNativeUiEnabled":"false"}' : '{"iosNativeUiEnabled":true}']]);
  const fixture = await preferencesFixture({ page: 'appearance', compatibility: { disk, readFailure: () => failure === 'read' && fail } });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  expect(find('settings-ios-native-ui-unknown')).toBeDefined();
  expect(find('settings-preference-iosNativeUiEnabled')).toBeUndefined();
  expect(find('settings-ios-native-ui-retry')).toBeDefined();
  expect(fixture.compatibilityWrite).not.toHaveBeenCalled();
  fail = false; disk.set(compatibilityCore.iosNativeUiPreferenceKey, '{"iosNativeUiEnabled":true}');
  (find('settings-ios-native-ui-retry').props.onPress as () => void)(); await flush();
  expect(find('settings-preference-iosNativeUiEnabled').props.value).toBe(true);
  expect(find('settings-ios-native-ui-unknown')).toBeUndefined(); fixture.dispose();
});

test('iOS write failure preserves prior and other local successes; retry saves only remaining flag before an unknown Host write', async () => {
  let fail = true;
  const disk = new Map([[compatibilityCore.iosNativeUiPreferenceKey, '{"iosNativeUiEnabled":false}']]);
  const fixture = await preferencesFixture({ page: 'appearance', compatibility: { disk, writeFailure: () => fail }, writeFailure: () => true });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  (find('settings-basics-codeFontSize').props.onChange as (value: string) => void)('150');
  (find('settings-preference-iosNativeUiEnabled').props.onChange as (value: boolean) => void)(true);
  (find('settings-basics-fontSize').props.onChange as (value: string) => void)('125');
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).toBe('settings.voice.volcengine.saveFailed');
  expect(JSON.parse(disk.get(compatibilityCore.iosNativeUiPreferenceKey)!)).toEqual({ iosNativeUiEnabled: false });
  expect(find('settings-preference-iosNativeUiEnabled').props.value).toBe(true);
  expect(JSON.parse(fixture.deviceRaw()!).codeFontSize).toBe(150); expect(fixture.deviceWrite).toHaveBeenCalledOnce();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  fail = false; (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(fixture.deviceWrite).toHaveBeenCalledOnce(); expect(fixture.compatibilityWrite).toHaveBeenCalledTimes(2);
  expect(find('settings-ios-native-ui-saved')).toBeDefined(); expect(fixture.state.error()).toBe('settings.github.native.unknown');
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: 125 }]);
  (find('settings-preference-iosNativeUiEnabled').props.onChange as (value: boolean) => void)(false);
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(JSON.parse(disk.get(compatibilityCore.iosNativeUiPreferenceKey)!)).toEqual({ iosNativeUiEnabled: false });
  expect(find('settings-preferences-unknown')).toBeDefined(); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1); fixture.dispose();
});

test('iOS handle retires across hide and lease renewal; delayed old write never dispatches its mixed Host patch or clears dirty', async () => {
  const write = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', compatibility: { writeWait: write.promise } });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  const retained = find('settings-preference-iosNativeUiEnabled');
  (retained.props.onChange as (value: boolean) => void)(true);
  (find('settings-basics-fontSize').props.onChange as (value: string) => void)('125');
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  await fixture.hide(); (retained.props.onChange as (value: boolean) => void)(false);
  await fixture.show(); await fixture.replaceLane(); write.resolve(); await flush();
  expect(find('settings-preference-iosNativeUiEnabled').props.value).toBe(true);
  expect(find('settings-preferences-save').props.disabled).toBe(false);
  expect(find('settings-ios-native-ui-saved')).toBeUndefined();
  expect(fixture.compatibilityWrite).toHaveBeenCalledOnce();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test('Host controls use successful missing defaults, normalize one patch and clear overrides through explicit reset', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', formatSettings: host => Object.fromEntries(Object.entries(host).filter(([key, value]) => !(key === 'pwaAppName' && value === '' || key === 'pwaOrientation' && value === 'system' || key === 'mobileKeyboardMode' && value === 'native'))) });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  const choice = (title: string) => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === `settings.yuri.visual.field.${title}`)!;
  expect(find('settings-basics-terminalFontSize').props.value).toBe('13'); expect(find('settings-basics-inputBarOffset').props.value).toBe('0');
  expect(find('settings-basics-pwaAppName').props.value).toBe(''); expect(choice('installOrientation').props.value).toBe('system');
  expect(choice('mobileKeyboardMode').props.value).toBe('native'); expect(find('settings-preference-reportUsage').props.value).toBe(false);
  expect(find('settings-basics-sidebarBrandName')).toBeUndefined(); expect(find('settings-description-sidebarBrandName')).toBeDefined();
  for (const [key, value] of Object.entries({ terminalFontSize: '20.6', inputBarOffset: '14.6', pwaAppName: '  Custom   PWA  ' })) (find(`settings-basics-${key}`).props.onChange as (value: string) => void)(value);
  (choice('installOrientation').props.onChange as (value: string) => void)('portrait');
  (choice('mobileKeyboardMode').props.onChange as (value: string) => void)('resize-content');
  (find('settings-preference-reportUsage').props.onChange as (value: boolean) => void)(true);
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ terminalFontSize: 21, inputBarOffset: 15, pwaAppName: 'Custom PWA', pwaOrientation: 'portrait', mobileKeyboardMode: 'resize-content', reportUsage: true }]);
  expect(find('settings-basics-pwaAppName').props.value).toBe('Custom PWA'); expect(find('settings-basics-terminalFontSize').props.value).toBe('21');
  for (const key of ['terminalFontSize', 'inputBarOffset', 'pwaAppName', 'pwaOrientation', 'mobileKeyboardMode']) (find(`settings-reset-${key}`).props.onPress as () => void)();
  (find('settings-preference-reportUsage').props.onChange as (value: boolean) => void)(false);
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').at(-1)?.[2]).toEqual({ terminalFontSize: 13, inputBarOffset: 0, pwaAppName: '', pwaOrientation: 'system', mobileKeyboardMode: 'native', reportUsage: false });
  expect(fixture.state.notice()).toBe('filesView.editor.saved'); expect(find('settings-preferences-save').props.disabled).toBe(true);
  expect(find('settings-basics-pwaAppName').props.value).toBe(''); expect(choice('installOrientation').props.value).toBe('system'); expect(choice('mobileKeyboardMode').props.value).toBe('native'); fixture.dispose();
});

test('failed Host load cannot publish default controls or accept edits and explicit retry adopts missing defaults', async () => {
  let fail = true;
  const fixture = await preferencesFixture({ page: 'appearance', readFailure: () => fail });
  expect(fixture.state.ready()).toBe(false); expect(fixture.nodes().some(node => node.props.testID === 'settings-preference-reportUsage')).toBe(false);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  fail = false; (fixture.nodes().find(node => node.props.state === fixture.state)!.props.retry as () => void)(); await flush();
  expect(fixture.state.ready()).toBe(true); expect(fixture.state.error()).toBe('');
  expect(fixture.nodes().find(node => node.props.testID === 'settings-preference-reportUsage')!.props.value).toBe(false); fixture.dispose();
});

test('production brand uses only captured transport identity, preserves blank/UTF-16 text and reopens the same scope independently of Host fields', async () => {
  const disk = new Map<string, string>([['sidebar-brand-transport-v1.other-route', '{"sidebarBrandName":"Other"}'], ['sidebarBrandName', 'Legacy must not migrate']]);
  const fixture = await preferencesFixture({ page: 'appearance', compatibility: { disk, transportID: 'opaque-route-A' }, host: { sidebarBrandName: 'Host must not import' } });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  expect(find('settings-basics-sidebarBrandName').props.value).toBe('Yuri');
  expect(fixture.compatibilityWrite).not.toHaveBeenCalled();
  for (const value of ['  Brand  ', '', '   ', 'x'.repeat(63) + '😀']) {
    (find('settings-basics-sidebarBrandName').props.onChange as (value: string) => void)(value);
    (find('settings-preferences-save').props.onPress as () => void)(); await flush();
    const expected = value.slice(0, 64);
    expect(JSON.parse(disk.get('sidebar-brand-transport-v1.opaque-route-A')!)).toEqual({ sidebarBrandName: expected });
    expect(find('settings-basics-sidebarBrandName').props.value).toBe(expected);
    expect(find('settings-sidebar-brand-saved')).toBeDefined();
    expect(find('settings-preferences-save').props.disabled).toBe(true);
  }
  expect(disk.get('sidebar-brand-transport-v1.other-route')).toBe('{"sidebarBrandName":"Other"}');
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); expect(fixture.refresh).not.toHaveBeenCalled(); fixture.dispose();
  const reopened = await preferencesFixture({ page: 'appearance', compatibility: { disk, transportID: 'opaque-route-A' } });
  expect(reopened.nodes().find(node => node.props.testID === 'settings-basics-sidebarBrandName')!.props.value).toBe('x'.repeat(63) + '\ud83d'); reopened.dispose();
  const other = await preferencesFixture({ page: 'appearance', compatibility: { disk, transportID: 'other-route' } });
  expect(other.nodes().find(node => node.props.testID === 'settings-basics-sidebarBrandName')!.props.value).toBe('Other'); other.dispose();
});

test('missing transport identity never falls back to record/authorization/Host URL/global Storage but leaves iOS and Host saves available', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', host: { sidebarBrandName: 'Host' }, compatibility: { disk: new Map([['sidebarBrandName', 'Global']]) } });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  expect(find('settings-basics-sidebarBrandName')).toBeUndefined(); expect(find('settings-sidebar-brand-scope-required')).toBeDefined();
  expect(fixture.compatibilityRead.mock.calls.every(([key]) => key === compatibilityCore.iosNativeUiPreferenceKey)).toBe(true);
  (find('settings-preference-iosNativeUiEnabled').props.onChange as (value: boolean) => void)(true);
  (find('settings-basics-terminalFontSize').props.onChange as (value: string) => void)('16');
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ terminalFontSize: 16 }]);
  expect(fixture.compatibilityWrite.mock.calls.map(([key]) => key)).toEqual([compatibilityCore.iosNativeUiPreferenceKey]); fixture.dispose();
});

test.each(['read', 'invalid'] as const)('brand %s failure stays unknown until explicit retry without overwriting an unread record', async failure => {
  let fail = true;
  const key = 'sidebar-brand-transport-v1.opaque-route-A';
  const disk = new Map([[key, failure === 'invalid' ? '{"sidebarBrandName":false}' : '{"sidebarBrandName":"Known"}']]);
  const fixture = await preferencesFixture({ page: 'appearance', compatibility: { disk, transportID: 'opaque-route-A', readFailure: key => failure === 'read' && key.startsWith('sidebar-') && fail } });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  expect(find('settings-sidebar-brand-unknown')).toBeDefined(); expect(find('settings-basics-sidebarBrandName')).toBeUndefined();
  expect(fixture.compatibilityWrite).not.toHaveBeenCalled(); fail = false; disk.set(key, '{"sidebarBrandName":"Known"}');
  (find('settings-sidebar-brand-retry').props.onPress as () => void)(); await flush();
  expect(find('settings-basics-sidebarBrandName').props.value).toBe('Known'); fixture.dispose();
});

test('brand write failure preserves prior and draft while iOS/fonts remain saved; unknown Host recovery never replays any local success', async () => {
  let failBrand = true;
  const key = 'sidebar-brand-transport-v1.opaque-route-A';
  const fixture = await preferencesFixture({ page: 'appearance', compatibility: { transportID: 'opaque-route-A', disk: new Map([[key, '{"sidebarBrandName":"Prior"}']]), writeFailure: key => key.startsWith('sidebar-') && failBrand }, writeFailure: () => true });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  (find('settings-basics-sidebarBrandName').props.onChange as (value: string) => void)('Next');
  (find('settings-preference-iosNativeUiEnabled').props.onChange as (value: boolean) => void)(true);
  for (const [key, value] of Object.entries({ codeFontSize: '175', editorFontSize: '24', fontSize: '125' })) (find(`settings-basics-${key}`).props.onChange as (value: string) => void)(value);
  (find('settings-preference-fileEditorKeymap-vim').props.onChange as () => void)();
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(fixture.compatibilityDisk.get(key)).toBe('{"sidebarBrandName":"Prior"}'); expect(find('settings-basics-sidebarBrandName').props.value).toBe('Next');
  expect(fixture.state.error()).toBe('settings.voice.volcengine.saveFailed'); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 24, fileEditorKeymap: 'vim' }); expect(find('settings-ios-native-ui-saved')).toBeDefined();
  failBrand = false; (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).toBe('settings.github.native.unknown'); expect(find('settings-sidebar-brand-saved')).toBeDefined();
  const writes = fixture.compatibilityWrite.mock.calls.length; expect(fixture.deviceWrite).toHaveBeenCalledTimes(3);
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(fixture.compatibilityWrite).toHaveBeenCalledTimes(writes); expect(fixture.deviceWrite).toHaveBeenCalledTimes(3);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: 125 }]); fixture.dispose();
});

test('transport switch during brand disk write retires old owner, keeps its draft dirty and never writes the new bucket or mixed Host patch', async () => {
  const write = deferred<void>(), disk = new Map<string, string>();
  const fixture = await preferencesFixture({ page: 'appearance', compatibility: { disk, transportID: 'opaque-route-A', brandWriteWait: write.promise } });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  const old = find('settings-basics-sidebarBrandName');
  (old.props.onChange as (value: string) => void)('A draft');
  (find('settings-basics-fontSize').props.onChange as (value: string) => void)('125');
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  await fixture.replaceTransport('opaque-route-B'); write.resolve(); await flush();
  expect(find('settings-basics-sidebarBrandName')).toBeUndefined(); expect(find('settings-sidebar-brand-scope-required')).toBeDefined();
  expect(find('settings-sidebar-brand-saved')).toBeUndefined();
  expect(disk.has('sidebar-brand-transport-v1.opaque-route-B')).toBe(false);
  expect(JSON.parse(disk.get('sidebar-brand-transport-v1.opaque-route-A')!)).toEqual({ sidebarBrandName: 'A draft' });
  (old.props.onChange as (value: string) => void)('Must not cross bucket');
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(fixture.onCollectionNavigation.mock.calls.at(-1)![0].blocked).toBe(true); fixture.dispose();
});

test('same transport lease renewal rereads the physical brand write without letting its retired owner clear the staged draft', async () => {
  const write = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', compatibility: { transportID: 'opaque-route-A', brandWriteWait: write.promise } });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  (find('settings-basics-sidebarBrandName').props.onChange as (value: string) => void)('Same');
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  await fixture.replaceLane(); write.resolve(); await flush();
  expect(find('settings-preferences-save').props.disabled).toBe(false);
  (find('settings-basics-sidebarBrandName').props.onChange as (value: string) => void)('Other');
  (find('settings-basics-sidebarBrandName').props.onChange as (value: string) => void)('Same');
  expect(find('settings-preferences-save').props.disabled).toBe(true);
  // Returning to the confirmed local value removes an ordinary unsent edit;
  // the retired old write never claims Saved or a new Host mutation.
  expect(find('settings-sidebar-brand-saved')).toBeUndefined();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test('cold Host GET failure leaves confirmed device fonts/keymap and iOS flag editable and locally saveable without journal or Host side effects', async () => {
  const journalValue = vi.fn(), journalClear = vi.fn(), journalPrepare = vi.fn();
  const fixture = await preferencesFixture({ page: 'appearance', readFailure: () => true, deviceRaw: '{"codeFontSize":125,"editorFontSize":24,"fileEditorKeymap":"vim"}', receiptModule: { openPreferenceReceipt: () => ({ ready: Promise.resolve(), current: () => true, value: journalValue, clear: journalClear, prepare: journalPrepare, close: async () => {} }) } });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  expect(fixture.state.ready()).toBe(false); expect(find('settings-basics-codeFontSize').props.value).toBe('125'); expect(find('settings-basics-editorFontSize').props.value).toBe('24');
  expect(find('settings-preference-fileEditorKeymap-vim').props.checked).toBe(true); expect(find('settings-basics-fontSize')).toBeUndefined();
  const hostError = fixture.state.error(), reads = fixture.request.mock.calls.length;
  for (const [key, value] of Object.entries({ codeFontSize: '150', editorFontSize: '26' })) {
    expect(find(`settings-basics-${key}`).props.disabled).toBe(false);
    (find(`settings-basics-${key}`).props.onChange as (value: string) => void)(value);
  }
  (find('settings-preference-fileEditorKeymap-default').props.onChange as () => void)();
  (find('settings-preference-iosNativeUiEnabled').props.onChange as (value: boolean) => void)(true);
  expect(find('settings-preferences-save').props.disabled).toBe(false); (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 150, editorFontSize: 26, fileEditorKeymap: 'default' });
  expect(JSON.parse(fixture.compatibilityDisk.get(compatibilityCore.iosNativeUiPreferenceKey)!)).toEqual({ iosNativeUiEnabled: true });
  expect(fixture.state.ready()).toBe(false); expect(fixture.state.error()).toBe(hostError);
  expect(fixture.request).toHaveBeenCalledTimes(reads); expect(fixture.refresh).not.toHaveBeenCalled();
  for (const spy of [journalValue, journalClear, journalPrepare]) expect(spy).not.toHaveBeenCalled(); fixture.dispose();
});

test('cold Host and device read failure cannot write defaults; explicit local retry restores real values and local Reset saves independently', async () => {
  let deviceFail = true;
  const fixture = await preferencesFixture({ page: 'appearance', readFailure: () => true, deviceReadFailure: () => deviceFail, deviceRaw: '{"codeFontSize":175,"editorFontSize":20,"fileEditorKeymap":"vim"}' });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  expect(find('settings-basics-codeFontSize').props.value).toBe(''); expect(find('settings-basics-codeFontSize').props.disabled).toBe(true);
  expect(find('settings-reset-codeFontSize').props.disabled).toBe(true);
  expect(find('settings-preference-fileEditorKeymap-vim').props.checked).toBe(false);
  (find('settings-preferences-save').props.onPress as () => void)(); await flush(); expect(fixture.deviceWrite).not.toHaveBeenCalled();
  deviceFail = false; expect(find('settings-code-font-size-retry').props.disabled).toBe(false);
  (find('settings-code-font-size-retry').props.onPress as () => void)(); await flush();
  expect(find('settings-basics-codeFontSize').props.value).toBe('175'); expect(find('settings-basics-editorFontSize').props.value).toBe('20'); expect(find('settings-preference-fileEditorKeymap-vim').props.checked).toBe(true);
  for (const key of ['codeFontSize', 'editorFontSize', 'fileEditorKeymap']) (find(`settings-reset-${key}`).props.onPress as () => void)();
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 100, editorFontSize: 13, fileEditorKeymap: 'default' });
  expect(fixture.state.ready()).toBe(false); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test('unready receipt cannot block device saves, and local save never reads, confirms, clears or prepares that Host journal', async () => {
  const ready = deferred<void>(), value = vi.fn(), confirm = vi.fn(), clear = vi.fn(), prepare = vi.fn();
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125}', receiptModule: { openPreferenceReceipt: () => ({ ready: ready.promise, current: () => true, value, confirm, clear, prepare, close: async () => {} }) } });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  expect(fixture.state.ready()).toBe(true); expect(fixture.state.busy()).toBe(true);
  (find('settings-basics-codeFontSize').props.onChange as (value: string) => void)('150');
  (find('settings-preference-iosNativeUiEnabled').props.onChange as (value: boolean) => void)(true);
  expect(find('settings-preferences-save').props.disabled).toBe(false); (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(JSON.parse(fixture.deviceRaw()!).codeFontSize).toBe(150);
  expect(fixture.state.busy()).toBe(true); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  for (const spy of [value, confirm, clear, prepare]) expect(spy).not.toHaveBeenCalled(); fixture.dispose(); ready.resolve(); await flush();
});

test('appearance error alone with no dirty field cannot enable Save; a confirmed device edit remains saveable', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', applyFailure: () => true });
  await fixture.refresh();
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  expect(find('settings-preferences-save').props.disabled).toBe(true);
  (find('settings-basics-editorFontSize').props.onChange as (value: string) => void)('22');
  expect(find('settings-preferences-save').props.disabled).toBe(false); (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(JSON.parse(fixture.deviceRaw()!).editorFontSize).toBe(22); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test('Host-unready local write failure preserves confirmed prior and Host error; explicit local retry commits without journal recovery', async () => {
  let failWrite = true;
  const fixture = await preferencesFixture({ page: 'appearance', readFailure: () => true, deviceRaw: '{"codeFontSize":125,"editorFontSize":20,"fileEditorKeymap":"vim"}', deviceWriteFailure: () => failWrite });
  const find = (id: string) => fixture.nodes().find(node => node.props.testID === id)!;
  const hostError = fixture.state.error(), reads = fixture.request.mock.calls.length;
  (find('settings-basics-codeFontSize').props.onChange as (value: string) => void)('175');
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(fixture.deviceAppearance.deviceAppearance()?.codeFontSize).toBe(125); expect(find('settings-basics-codeFontSize').props.value).toBe('175');
  expect(fixture.state.error()).toBe(hostError); expect(find('settings-device-save-error')).toBeDefined(); expect(fixture.state.ready()).toBe(false);
  failWrite = false; (find('settings-device-save-retry').props.onPress as () => void)(); await flush();
  expect(fixture.deviceAppearance.deviceAppearance()?.codeFontSize).toBe(175); expect(find('settings-device-save-error')).toBeUndefined();
  expect(fixture.state.error()).toBe(hostError); expect(fixture.request).toHaveBeenCalledTimes(reads); expect(fixture.state.ready()).toBe(false); fixture.dispose();
});

test('actual Preferences switch -> Save callback persists all three device fields and sends no Host PUT', async () => {
  const fixture = await preferencesFixture();
  const rendered = fixture.nodes();
  for (const [key, value] of Object.entries({ allowPromptingSubagentSessions: true, collapsibleUserMessages: false, persistChatDraft: false })) {
    const field = rendered.find(node => node.props.testID === `settings-preference-${key}`);
    expect(field).toBeDefined(); (field!.props.onChange as (value: boolean) => void)(value);
  }
  const save = rendered.find(node => node.props.testID === 'settings-preferences-save')!;
  (save.props.onPress as () => void)(); await flush();
  expect(JSON.parse(fixture.raw()!)).toEqual({ allowPromptingSubagentSessions: true, collapsibleUserMessages: false, persistChatDraft: false });
  expect(fixture.request.mock.calls.map(call => call[1] ?? 'GET')).toEqual(['GET']);
  expect(fixture.preference()).toEqual(JSON.parse(fixture.raw()!));
  expect(fixture.state.notice()).toBe('filesView.editor.saved');
});
test('production render cards, transport chips and Diff radios stage one exact patch and reject retained hidden-page callbacks', async () => {
  const fixture = await preferencesFixture({ host: { chatRenderMode: 'sorted', messageStreamTransport: 'sse', diffLayoutPreference: 'inline' } });
  const find = (testID: string) => {
    const node = fixture.nodes().find(node => node.props.testID === testID);
    if (!node) throw new Error('Missing production preference control: ' + testID);
    return node;
  };
  const sorted = find('settings-preference-chatRenderMode-sorted');
  const live = find('settings-preference-chatRenderMode-live');
  const ws = find('settings-preference-messageStreamTransport-ws');
  const split = find('settings-preference-diffLayoutPreference-side-by-side');
  expect(sorted.props.selected).toBe(true);
  (live.props.onPress as () => void)(); (ws.props.onPress as () => void)(); (split.props.onChange as () => void)();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toEqual([]);
  expect(find('settings-preference-chatRenderMode-live').props.selected).toBe(true);
  expect(find('settings-preference-messageStreamTransport-ws').props.selected).toBe(true);
  expect(find('settings-preference-diffLayoutPreference-side-by-side').props.checked).toBe(true);
  (find('settings-preferences-save').props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toEqual([['/api/config/settings', 'PUT', { chatRenderMode: 'live', messageStreamTransport: 'ws', diffLayoutPreference: 'side-by-side' }]]);
  await fixture.hide(); (sorted.props.onPress as () => void)();
  await fixture.show();
  expect(find('settings-preference-chatRenderMode-live').props.selected).toBe(true);
  expect(find('settings-preferences-save').props.disabled).toBe(true);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
});

test.each(['read', 'apply'] as const)('follow-up confirmed PUT survives %s failure; retry only reads/applies and preserves newer dirty edits', async failure => {
  let fail = false;
  const fixture = await preferencesFixture({ host: { followUpBehavior: 'queue' }, readFailure: () => failure === 'read' && fail, applyFailure: () => failure === 'apply' && fail });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (choice().props.onChange as (value: string) => void)('steer');
  fail = true;
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toEqual([['/api/config/settings', 'PUT', { followUpBehavior: 'steer' }]]);
  expect(fixture.state.error()).not.toBe(''); expect(fixture.state.notice()).toBe('');
  expect(choice().props.value).toBe('steer'); expect(save().props.disabled).toBe(false);
  (choice().props.onChange as (value: string) => void)('queue');
  const feedback = fixture.nodes().find(node => node.props.state === fixture.state)!;
  expect(feedback.props.retry).toBeTypeOf('function');
  fail = false;
  (feedback.props.retry as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
  expect(choice().props.value).toBe('queue'); expect(save().props.disabled).toBe(false);
  expect(fixture.state.error()).toBe(''); expect(fixture.state.notice()).toBe('filesView.editor.saved');
});

test('pre-dispatch validation retains dirty value; cancel/discard navigation and returning to initial value publish the correct guard', async () => {
  const fixture = await preferencesFixture({ host: { followUpBehavior: 'queue' } });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (choice().props.onChange as (value: string) => void)('invalid');
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).not.toBe(''); expect(choice().props.value).toBe('invalid'); expect(save().props.disabled).toBe(false);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  await flush();
  const navigation = fixture.onCollectionNavigation.mock.calls.at(-1)![0];
  expect(navigation.blocked).toBe(true);
  navigation.back(); await flush(); expect(fixture.onBack).not.toHaveBeenCalled();
  fixture.alert.mockResolvedValue({ action: 'discard' });
  navigation.back(); await flush(); expect(fixture.onBack).toHaveBeenCalledTimes(1);
  (choice().props.onChange as (value: string) => void)('queue'); await flush();
  expect(fixture.onCollectionNavigation.mock.calls.at(-1)![0].blocked).toBe(false);
  expect(save().props.disabled).toBe(true);
});

test('real page lifetime retains an unknown PUT across same-Host lease replacement and rejects late ACK without replay or dirty ABA loss', async () => {
  const write = deferred<void>();
  const fixture = await preferencesFixture({ host: { followUpBehavior: 'queue' }, writeWait: write.promise });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (choice().props.onChange as (value: string) => void)('steer');
  (save().props.onPress as () => void)(); await flush();
  const oldLane = fixture.state.operation();
  expect(fixture.state.busy()).toBe(true);
  await fixture.replaceLane();
  expect(oldLane!.current()).toBe(false); expect(fixture.state.operation()).not.toBe(oldLane);
  expect(fixture.state.busy()).toBe(false);
  const reads = fixture.request.mock.calls.filter(call => call[1] === 'GET').length;
  (choice().props.onChange as (value: string) => void)('queue');
  (choice().props.onChange as (value: string) => void)('steer');
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'GET').length).toBeGreaterThan(reads);
  expect(fixture.state.error()).toBe('settings.github.native.unknown');
  write.resolve(); await flush();
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
  expect(choice().props.value).toBe('steer');
  expect(fixture.state.error()).toBe('settings.github.native.unknown');
  const guard = fixture.onCollectionNavigation.mock.calls.at(-1)![0];
  expect(guard.blocked).toBe(true);
  fixture.alert.mockResolvedValue({ action: 'discard' }); guard.back(); await flush();
  expect(fixture.onBack).toHaveBeenCalledTimes(1); expect(fixture.alert).toHaveBeenCalledTimes(1);
  expect(fixture.receiptStorage.size).toBeGreaterThan(0); fixture.dispose();
});

test('confirmed PUT with failed application hands off on close and reopens for GET/application recovery without PUT', async () => {
  let fail = false;
  const fixture = await preferencesFixture({ host: { followUpBehavior: 'queue' }, applyFailure: () => fail });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (choice().props.onChange as (value: string) => void)('steer'); fail = true;
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).not.toBe('');
  let guard = fixture.onCollectionNavigation.mock.calls.at(-1)![0];
  expect(guard.blocked).toBe(true);
  guard.back(); await flush(); expect(fixture.onBack).toHaveBeenCalledTimes(1);
  fixture.dispose(); await flush();
  const next = await preferencesFixture({ host: fixture.host(), receiptStorage: fixture.receiptStorage, receiptModule: fixture.receiptModule, applyFailure: () => fail });
  await next.replaceLane();
  guard = next.onCollectionNavigation.mock.calls.at(-1)![0];
  expect(guard.blocked).toBe(true);
  fail = false;
  const feedback = next.nodes().find(node => node.props.state === next.state)!;
  (feedback.props.retry as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
  expect(next.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  guard = next.onCollectionNavigation.mock.calls.at(-1)![0];
  expect(guard.blocked).toBe(false);
  guard.back(); await flush(); expect(next.onBack).toHaveBeenCalledTimes(1); next.dispose();
});

test('acknowledged recovery uses edit revisions so a newer same-value ABA edit survives GET/application', async () => {
  let fail = false;
  const fixture = await preferencesFixture({ host: { followUpBehavior: 'queue' }, applyFailure: () => fail });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (choice().props.onChange as (value: string) => void)('steer'); fail = true;
  (save().props.onPress as () => void)(); await flush();
  await fixture.replaceLane();
  (choice().props.onChange as (value: string) => void)('queue');
  (choice().props.onChange as (value: string) => void)('steer');
  fail = false;
  const feedback = fixture.nodes().find(node => node.props.state === fixture.state)!;
  (feedback.props.retry as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
  expect(fixture.state.error()).toBe(''); expect(choice().props.value).toBe('steer');
  expect(save().props.disabled).toBe(false);
  const guard = fixture.onCollectionNavigation.mock.calls.at(-1)![0];
  expect(guard.blocked).toBe(true);
  guard.back(); await flush(); expect(fixture.alert).toHaveBeenCalledTimes(1); expect(fixture.onBack).not.toHaveBeenCalled();
});

test('a failed PUT remains explicit unknown through GET snapshots and is not cleared or replayed when leaving', async () => {
  const fixture = await preferencesFixture({ host: { followUpBehavior: 'queue' }, writeFailure: () => true });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (choice().props.onChange as (value: string) => void)('steer');
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).toBe('settings.github.native.unknown');
  await fixture.replaceLane();
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
  expect(choice().props.value).toBe('steer'); expect(fixture.state.error()).toBe('settings.github.native.unknown');
  const guard = fixture.onCollectionNavigation.mock.calls.at(-1)![0];
  fixture.alert.mockResolvedValue({ action: 'discard' }); guard.back(); await flush();
  expect(fixture.onBack).toHaveBeenCalledTimes(1); expect(fixture.alert).not.toHaveBeenCalled();
  expect(fixture.receiptStorage.size).toBeGreaterThan(0); fixture.dispose();
});

test('cache clear uses the existing default singleton port only after explicit confirmation and never PUTs cache settings', async () => {
  const fixture = await preferencesFixture({ page: 'appearance' });
  const clear = () => fixture.nodes().find(node => node.props.testID === 'settings-transcript-cache-clear');
  expect(clear()).toBeDefined();
  (clear()!.props.onPress as () => void)(); await flush();
  expect(fixture.alert.mock.calls[0][0]).toMatchObject({ title: 'settings.yuri.visual.transcriptCache.dialog.title', description: 'settings.yuri.visual.transcriptCache.dialog.description' });
  expect(fixture.defaultClear).not.toHaveBeenCalled();
  fixture.alert.mockResolvedValue({ action: 'clear' });
  (clear()!.props.onPress as () => void)(); await flush();
  expect(fixture.defaultClear).toHaveBeenCalledTimes(1);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-transcript-cache-cleared')).toBe(true);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
});

test('device-local clear keeps its one flight and navigation guard across Host lease renewal', async () => {
  const clearing = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', clearHistoryCache: () => clearing.promise });
  fixture.alert.mockResolvedValue({ action: 'clear' });
  const clear = () => fixture.nodes().find(node => node.props.testID === 'settings-transcript-cache-clear')!;
  expect(clear()).toBeDefined();
  (clear().props.onPress as () => void)(); await flush();
  expect(fixture.injectedClear).toHaveBeenCalledTimes(1); expect(fixture.defaultClear).not.toHaveBeenCalled();
  expect(clear().props.disabled).toBe(true);
  let guard = fixture.onCollectionNavigation.mock.calls.at(-1)![0];
  expect(guard.blocked).toBe(true); guard.back(); await flush(); expect(fixture.onBack).not.toHaveBeenCalled();
  await fixture.replaceLane();
  expect(fixture.injectedClear).toHaveBeenCalledTimes(1); expect(clear().props.disabled).toBe(true);
  guard = fixture.onCollectionNavigation.mock.calls.at(-1)![0];
  expect(guard.blocked).toBe(true); guard.back(); await flush(); expect(fixture.onBack).not.toHaveBeenCalled();
  (clear().props.onPress as () => void)(); await flush(); expect(fixture.injectedClear).toHaveBeenCalledTimes(1);
  clearing.resolve(); await flush();
  expect(fixture.nodes().some(node => node.props.testID === 'settings-transcript-cache-cleared')).toBe(true);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-transcript-cache-error')).toBe(false);
  expect(fixture.onCollectionNavigation.mock.calls.at(-1)![0].blocked).toBe(false);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
});

test('cache failure preserves draft and requires explicit retry; unmounted pages suppress late feedback', async () => {
  let fail = true;
  const done = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', clearHistoryCache: async () => { if (fail) throw new Error('fixture deletion failed; journal retained'); await done.promise; } });
  fixture.alert.mockResolvedValue({ action: 'clear' });
  const font = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!;
  (font().props.onChange as (value: string) => void)('125');
  const clear = fixture.nodes().find(node => node.props.testID === 'settings-transcript-cache-clear');
  expect(clear).toBeDefined(); (clear!.props.onPress as () => void)(); await flush();
  expect(fixture.nodes().some(node => node.props.testID === 'settings-transcript-cache-error')).toBe(true);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-transcript-cache-cleared')).toBe(false);
  await fixture.replaceLane(); expect(fixture.injectedClear).toHaveBeenCalledTimes(1); expect(font().props.value).toBe('125');
  const retry = fixture.nodes().find(node => node.props.testID === 'settings-transcript-cache-retry')!;
  fail = false; (retry.props.onPress as () => void)(); await flush();
  expect(fixture.injectedClear).toHaveBeenCalledTimes(2); expect(font().props.value).toBe('125');
  fixture.dispose(); done.resolve(); await flush();
  expect(fixture.nodes().some(node => node.props.testID === 'settings-transcript-cache-cleared')).toBe(false);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
});

test('late confirmation on a disposed page cannot start device cleanup', async () => {
  const confirmation = deferred<{ action: string }>();
  const fixture = await preferencesFixture({ page: 'appearance' });
  fixture.alert.mockImplementation(() => confirmation.promise);
  const clear = fixture.nodes().find(node => node.props.testID === 'settings-transcript-cache-clear')!;
  (clear.props.onPress as () => void)(); await flush();
  expect(fixture.onCollectionNavigation.mock.calls.at(-1)![0].blocked).toBe(true);
  fixture.dispose(); confirmation.resolve({ action: 'clear' }); await flush();
  expect(fixture.defaultClear).not.toHaveBeenCalled();
});

test('successful device cleanup cannot clear an unrelated unknown Host mutation receipt', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', writeFailure: () => true });
  const font = fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!;
  (font.props.onChange as (value: string) => void)('125');
  const save = fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (save.props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).toBe('settings.github.native.unknown');
  fixture.alert.mockResolvedValue({ action: 'clear' });
  const clear = fixture.nodes().find(node => node.props.testID === 'settings-transcript-cache-clear')!;
  (clear.props.onPress as () => void)(); await flush();
  expect(fixture.defaultClear).toHaveBeenCalledTimes(1);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-transcript-cache-cleared')).toBe(true);
  expect(fixture.state.error()).toBe('settings.github.native.unknown');
  expect(fixture.nodes().some(node => node.props.testID === 'settings-preferences-unknown')).toBe(true);
  const guard = fixture.onCollectionNavigation.mock.calls.at(-1)![0];
  expect(guard.blocked).toBe(true); guard.back(); await flush(); expect(fixture.onBack).toHaveBeenCalledTimes(1);
  expect(fixture.receiptStorage.size).toBeGreaterThan(0);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toEqual([['/api/config/settings', 'PUT', { fontSize: 125 }]]);
});

test('unknown handoff permits close and other settings pages; reopen restores the receipt without any PUT', async () => {
  const first = await preferencesFixture({ host: { followUpBehavior: 'queue' }, writeFailure: () => true });
  const choice = first.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  (choice.props.onChange as (value: string) => void)('steer');
  (first.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  first.alert.mockResolvedValue({ action: 'discard' });
  first.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(first.onBack).toHaveBeenCalledTimes(1);
  expect(first.receiptStorage.size).toBeGreaterThan(0);
  first.dispose(); await flush();
  const next = await preferencesFixture({ page: 'appearance', receiptStorage: first.receiptStorage, receiptModule: first.receiptModule });
  expect(next.nodes().some(node => node.props.testID === 'settings-preferences-unknown')).toBe(true);
  (next.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(next.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  next.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(next.onBack).toHaveBeenCalledTimes(1); expect(next.alert).not.toHaveBeenCalled();
  expect(next.receiptStorage.size).toBeGreaterThan(0); next.dispose();
  const restart = await preferencesFixture({ receiptStorage: first.receiptStorage });
  expect(restart.nodes().some(node => node.props.testID === 'settings-preferences-unknown')).toBe(true);
  (restart.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(restart.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); restart.dispose();
});

test('failed durable handoff preserves the page, receipt and new draft; retrying Back stores before discard consent', async () => {
  let storageFailure = false;
  const fixture = await preferencesFixture({ writeFailure: () => true, storageFailure: () => storageFailure });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  (choice().props.onChange as (value: string) => void)('steer');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  (choice().props.onChange as (value: string) => void)('queue');
  storageFailure = true; fixture.alert.mockResolvedValue({ action: 'discard' });
  fixture.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(fixture.onBack).not.toHaveBeenCalled(); expect(fixture.alert).not.toHaveBeenCalled();
  expect(choice().props.value).toBe('queue'); expect(fixture.state.error()).toBe('settings.voice.volcengine.saveFailed');
  storageFailure = false;
  fixture.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(fixture.onBack).toHaveBeenCalledTimes(1); expect(fixture.alert).toHaveBeenCalledTimes(1);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1); fixture.dispose();
});

test('late old PUT completion cannot clear the next page owner receipt', async () => {
  const write = deferred<void>();
  const first = await preferencesFixture({ writeWait: write.promise });
  const choice = first.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  (choice.props.onChange as (value: string) => void)('steer');
  (first.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  await first.replaceLane(); first.alert.mockResolvedValue({ action: 'discard' });
  first.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(first.onBack).toHaveBeenCalledTimes(1); first.dispose(); await flush();
  const next = await preferencesFixture({ receiptStorage: first.receiptStorage, receiptModule: first.receiptModule });
  const before = [...next.receiptStorage.entries()];
  write.resolve(); await flush();
  expect(next.nodes().some(node => node.props.testID === 'settings-preferences-unknown')).toBe(true);
  expect([...next.receiptStorage.entries()]).toEqual(before);
  (next.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(next.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); next.dispose();
});

test('retained covered page reacquires the durable owner on activation without losing its newer unsent draft', async () => {
  const first = await preferencesFixture({ writeFailure: () => true });
  const choice = () => first.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  (choice().props.onChange as (value: string) => void)('steer');
  (first.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  (choice().props.onChange as (value: string) => void)('queue'); await first.hide();
  const second = await preferencesFixture({ page: 'appearance', receiptStorage: first.receiptStorage, receiptModule: first.receiptModule });
  second.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(second.onBack).toHaveBeenCalledTimes(1); second.dispose(); await flush();
  await first.show();
  expect(choice().props.value).toBe('queue');
  expect(first.nodes().some(node => node.props.testID === 'settings-preferences-unknown')).toBe(true);
  first.alert.mockResolvedValue({ action: 'discard' });
  first.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(first.onBack).toHaveBeenCalledTimes(1); expect(first.alert).toHaveBeenCalledTimes(1);
  expect(first.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1); first.dispose();
});

test('receipt persistence failure admits no Host PUT, preserves edits and still allows independent local cache clearing', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', storageFailure: () => true });
  const font = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!;
  (font().props.onChange as (value: string) => void)('125');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(fixture.state.error()).toBe('settings.voice.volcengine.saveFailed'); expect(font().props.value).toBe('125');
  fixture.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(fixture.onBack).not.toHaveBeenCalled(); expect(fixture.receiptStorage.size).toBe(0);
  fixture.alert.mockResolvedValue({ action: 'clear' });
  const clear = fixture.nodes().find(node => node.props.testID === 'settings-transcript-cache-clear')!;
  expect(clear.props.disabled).toBe(false); (clear.props.onPress as () => void)(); await flush();
  expect(fixture.defaultClear).toHaveBeenCalledTimes(1); expect(font().props.value).toBe('125'); fixture.dispose();
});

test('prepare write failure recovers by safe local cleanup, then a separate explicit Save issues exactly one PUT', async () => {
  let storageFailure = true;
  const fixture = await preferencesFixture({ host: { followUpBehavior: 'queue' }, storageFailure: () => storageFailure });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (choice().props.onChange as (value: string) => void)('steer');
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  storageFailure = false;
  const feedback = fixture.nodes().find(node => node.props.state === fixture.state)!;
  (feedback.props.retry as () => void)(); await flush();
  expect(fixture.state.error()).toBe(''); expect(choice().props.value).toBe('steer'); expect(save().props.disabled).toBe(false);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-preferences-unknown')).toBe(false);
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toEqual([['/api/config/settings', 'PUT', { followUpBehavior: 'steer' }]]);
  expect(fixture.state.notice()).toBe('filesView.editor.saved'); fixture.dispose();
});

test('prepare completes after its lane retires: same owner cleans the definitely-unsent receipt and permits one explicit new-lane PUT', async () => {
  const prepared = deferred<void>(); let writes = 0;
  const fixture = await preferencesFixture({ host: { followUpBehavior: 'queue' }, receiptWrite: async () => { if (++writes === 1) await prepared.promise; } });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (choice().props.onChange as (value: string) => void)('steer');
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.receiptStorage.size).toBe(1); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  await fixture.replaceLane(); prepared.resolve(); await flush();
  (fixture.nodes().find(node => node.props.state === fixture.state)!.props.retry as (() => void) | undefined)?.(); await flush();
  expect(fixture.state.error()).toBe(''); expect(choice().props.value).toBe('steer'); expect(save().props.disabled).toBe(false);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1); fixture.dispose();
});

test('definitely-unsent cleanup failure preserves receipt and newer ABA edits, blocks handoff and retries without unsafe PUT', async () => {
  const prepared = deferred<void>(); let writes = 0, storageFailure = false;
  const fixture = await preferencesFixture({ host: { followUpBehavior: 'queue' }, storageFailure: () => storageFailure, receiptWrite: async () => { if (++writes === 1) await prepared.promise; } });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (choice().props.onChange as (value: string) => void)('steer');
  (save().props.onPress as () => void)(); await flush(); await fixture.replaceLane();
  storageFailure = true; prepared.resolve(); await flush();
  (choice().props.onChange as (value: string) => void)('queue'); (choice().props.onChange as (value: string) => void)('steer');
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).toBe('settings.voice.volcengine.saveFailed'); expect(choice().props.value).toBe('steer');
  fixture.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(fixture.onBack).not.toHaveBeenCalled(); expect(fixture.alert).not.toHaveBeenCalled();
  const envelope = JSON.parse(JSON.parse([...fixture.receiptStorage.values()][0]).draft);
  expect(envelope.handoffs).toBe(0); expect(envelope.receipt.acknowledged).toBe(false);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  storageFailure = false;
  (fixture.nodes().find(node => node.props.state === fixture.state)!.props.retry as () => void)(); await flush();
  expect(fixture.state.error()).toBe(''); expect(choice().props.value).toBe('steer'); expect(save().props.disabled).toBe(false);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1); fixture.dispose();
});

test('code font size edits the original device singleton and saves with zero Host PUTs', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":135}' });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize');
  expect(field()).toBeDefined(); expect(field()!.props.value).toBe('135'); expect(field()!.props.disabled).toBe(false);
  (field()!.props.onChange as (value: string) => void)('150');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.saveDevice.mock.calls).toEqual([[150]]); expect(fixture.deviceAppearance.deviceAppearance()).toEqual({ codeFontSize: 150, editorFontSize: 13, fileEditorKeymap: 'default' });
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 150, editorFontSize: 13, fileEditorKeymap: 'default' });
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.disabled).toBe(true); fixture.dispose();
});

test('cold device read does not display or save a fake 100 over an existing record', async () => {
  const read = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":175}', deviceReadWait: read.promise });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize');
  expect(field()).toBeDefined(); expect(field()!.props.value).toBe(''); expect(field()!.props.disabled).toBe(true);
  (field()!.props.onChange as (value: string) => void)('100');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.saveDevice).not.toHaveBeenCalled(); expect(fixture.deviceWrite).not.toHaveBeenCalled();
  read.resolve(); await flush(); expect(field()!.props.value).toBe('175'); expect(field()!.props.disabled).toBe(false); fixture.dispose();
});

test('only a successful empty device read supplies 100; failed reads stay unknown and explicitly retry without writing', async () => {
  let fail = true;
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":155}', deviceReadFailure: () => fail });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize');
  expect(field()).toBeDefined(); expect(field()!.props.value).toBe(''); expect(field()!.props.disabled).toBe(true);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-code-font-size-error')).toBe(true);
  fail = false;
  (fixture.nodes().find(node => node.props.testID === 'settings-code-font-size-retry')!.props.onPress as () => void)(); await flush();
  expect(field()!.props.value).toBe('155'); expect(fixture.deviceWrite).not.toHaveBeenCalled(); fixture.dispose();
  const empty = await preferencesFixture({ page: 'appearance', deviceRaw: null });
  expect(empty.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize')!.props.value).toBe('100');
  expect(empty.deviceWrite).not.toHaveBeenCalled(); empty.dispose();
});

test('device save failure retains prior and staged value; explicit retry commits it without Host writes', async () => {
  let fail = true;
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125}', deviceWriteFailure: () => fail });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize');
  expect(field()).toBeDefined(); (field()!.props.onChange as (value: string) => void)('160');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(field()!.props.value).toBe('160'); expect(fixture.deviceAppearance.deviceAppearance()).toEqual({ codeFontSize: 125, editorFontSize: 13, fileEditorKeymap: 'default' });
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 125 });
  expect(fixture.nodes().some(node => node.props.testID === 'settings-code-font-size-error')).toBe(true);
  fail = false;
  (fixture.nodes().find(node => node.props.testID === 'settings-code-font-size-retry')!.props.onPress as () => void)(); await flush();
  expect(fixture.deviceAppearance.deviceAppearance()).toEqual({ codeFontSize: 160, editorFontSize: 13, fileEditorKeymap: 'default' });
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test.each(['', ' ', '49', '201', '125.5'])('rejects invalid device code font size %j before any local or Host write', async invalid => {
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125}' });
  const field = fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize');
  expect(field).toBeDefined(); (field!.props.onChange as (value: string) => void)(invalid);
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).not.toBe(''); expect(fixture.saveDevice).not.toHaveBeenCalled();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test('device write across Host renewal preserves newer ABA edits and never dispatches the old mixed Host patch', async () => {
  const write = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125}', deviceWriteWait: write.promise });
  const code = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize');
  expect(code()).toBeDefined(); (code()!.props.onChange as (value: string) => void)('150');
  (fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!.props.onChange as (value: string) => void)('135');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  await fixture.replaceLane();
  (code()!.props.onChange as (value: string) => void)('160'); (code()!.props.onChange as (value: string) => void)('150');
  write.resolve(); await flush();
  expect(fixture.saveDevice.mock.calls).toEqual([[150]]); expect(code()!.props.value).toBe('150');
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.disabled).toBe(false);
  fixture.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(fixture.alert).toHaveBeenCalledTimes(1); expect(fixture.onBack).not.toHaveBeenCalled(); fixture.dispose();
});

test('mixed device failure does not start Host write; later local success is reported separately from unknown Host outcome', async () => {
  let failDevice = true;
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125}', deviceWriteFailure: () => failDevice, writeFailure: () => true });
  const code = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize');
  expect(code()).toBeDefined(); (code()!.props.onChange as (value: string) => void)('150');
  const font = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!;
  (font().props.onChange as (value: string) => void)('135');
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); expect(font().props.value).toBe('135');
  failDevice = false; (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
  expect(fixture.state.error()).toBe('settings.github.native.unknown'); expect(fixture.state.notice()).toBe('');
  expect(fixture.nodes().some(node => node.props.testID === 'settings-code-font-size-saved')).toBe(true);
  const original = [...fixture.receiptStorage.entries()];
  (code()!.props.onChange as (value: string) => void)('175'); (save().props.onPress as () => void)(); await flush();
  expect(fixture.deviceAppearance.deviceAppearance()).toEqual({ codeFontSize: 175, editorFontSize: 13, fileEditorKeymap: 'default' });
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
  expect([...fixture.receiptStorage.entries()]).toEqual(original);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-preferences-unknown')).toBe(true); fixture.dispose();
});

test('local edits while a confirmed Host apply is pending cannot replay its PUT or erase the receipt', async () => {
  let applyFail = true;
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125}', applyFailure: () => applyFail });
  const code = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize');
  expect(code()).toBeDefined(); (code()!.props.onChange as (value: string) => void)('150');
  (fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!.props.onChange as (value: string) => void)('135');
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (save().props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
  (code()!.props.onChange as (value: string) => void)('175'); (save().props.onPress as () => void)(); await flush();
  expect(fixture.saveDevice.mock.calls).toEqual([[150], [175]]);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1);
  expect(fixture.onCollectionNavigation.mock.calls.at(-1)![0].blocked).toBe(true);
  applyFail = false; (fixture.nodes().find(node => node.props.state === fixture.state)!.props.retry as () => void)(); await flush();
  expect(fixture.state.error()).toBe(''); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1); fixture.dispose();
});

test('failed device refresh preserves the prior and newer staged edit; read retry never overwrites the draft', async () => {
  let fail = false;
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":130}', preloadDevice: true, deviceReadFailure: () => fail });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize')!;
  (field().props.onChange as (value: string) => void)('165');
  fail = true; await expect(fixture.deviceAppearance.loadDeviceAppearance()).rejects.toThrow(); await flush();
  expect(fixture.deviceAppearance.deviceAppearance()).toEqual({ codeFontSize: 130, editorFontSize: 13, fileEditorKeymap: 'default' }); expect(field().props.value).toBe('165');
  (fixture.nodes().find(node => node.props.testID === 'settings-code-font-size-retry')!.props.onPress as () => void)(); await flush();
  expect(field().props.value).toBe('165'); expect(fixture.deviceWrite).not.toHaveBeenCalled();
  fail = false;
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.saveDevice.mock.calls).toEqual([[165]]); expect(fixture.nodes().some(node => node.props.testID === 'settings-code-font-size-error')).toBe(false);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test('mixed validation completes before any device write and preserves both invalid Host and valid device drafts', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":130}' });
  const code = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize')!;
  (code().props.onChange as (value: string) => void)('165');
  (fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!.props.onChange as (value: string) => void)('');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).not.toBe(''); expect(code().props.value).toBe('165');
  expect(fixture.saveDevice).not.toHaveBeenCalled(); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test('hidden-page code font callbacks cannot edit or save device preferences', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":130}' });
  const code = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize')!;
  const change = code().props.onChange as (value: string) => void;
  const save = fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void;
  await fixture.hide(); expect(code().props.disabled).toBe(true); change('175'); save(); await flush();
  expect(code().props.value).toBe('130'); expect(fixture.saveDevice).not.toHaveBeenCalled();
  await fixture.show(); expect(code().props.value).toBe('130'); fixture.dispose();
});

test('editor point size uses the shared singleton, rounds/clamps, resets to 13 and restores persistently with zero Host PUTs', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":175}' });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-editorFontSize')!;
  const save = () => (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)();
  expect(field()).toBeDefined(); expect(field().props.value).toBe('13'); expect(field().props.disabled).toBe(false);
  (field().props.onChange as (value: string) => void)('18.6'); save(); await flush();
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 19, fileEditorKeymap: 'default' });
  (field().props.onChange as (value: string) => void)('40'); save(); await flush(); expect(field().props.value).toBe('32');
  (fixture.nodes().find(node => node.props.testID === 'settings-reset-editorFontSize')!.props.onPress as () => void)();
  expect(field().props.value).toBe('13'); save(); await flush();
  expect(fixture.saveEditor.mock.calls).toEqual([[19], [32], [13]]);
  expect(fixture.saveDevice).not.toHaveBeenCalled(); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  const raw = fixture.deviceRaw(); fixture.dispose();
  const reopened = await preferencesFixture({ page: 'appearance', deviceRaw: raw });
  expect(reopened.nodes().find(node => node.props.testID === 'settings-basics-editorFontSize')!.props.value).toBe('13');
  expect(reopened.deviceAppearance.deviceAppearance()).toEqual({ codeFontSize: 175, editorFontSize: 13, fileEditorKeymap: 'default' }); reopened.dispose();
});

test('editor remains unknown and disables stale edit/reset callbacks until successful device read; explicit retry never writes', async () => {
  let fail = true;
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":155,"editorFontSize":22}', deviceReadFailure: () => fail });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-editorFontSize')!;
  expect(field()).toBeDefined(); expect(field().props.value).toBe(''); expect(field().props.disabled).toBe(true);
  const reset = fixture.nodes().find(node => node.props.testID === 'settings-reset-editorFontSize')!;
  expect(reset.props.disabled).toBe(true);
  (field().props.onChange as (value: string) => void)('13'); (reset.props.onPress as () => void)();
  expect(field().props.value).toBe(''); expect(fixture.deviceWrite).not.toHaveBeenCalled();
  fail = false;
  (fixture.nodes().find(node => node.props.testID === 'settings-editor-font-size-retry')!.props.onPress as () => void)(); await flush();
  expect(field().props.value).toBe('22'); expect(fixture.deviceWrite).not.toHaveBeenCalled();
  const change = field().props.onChange as (value: string) => void;
  const save = fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void;
  await fixture.hide(); change('30'); (reset.props.onPress as () => void)(); save(); await flush();
  expect(field().props.value).toBe('22'); expect(fixture.saveEditor).not.toHaveBeenCalled();
  fixture.dispose(); change('30'); save(); await flush(); expect(fixture.deviceWrite).not.toHaveBeenCalled();
});

test.each(['', ' ', 'NaN', 'Infinity'])('editor rejects blank/non-finite draft %j before either local field or Host writes', async invalid => {
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125,"editorFontSize":19}' });
  const field = fixture.nodes().find(node => node.props.testID === 'settings-basics-editorFontSize')!;
  expect(field).toBeDefined(); (field.props.onChange as (value: string) => void)(invalid);
  (fixture.nodes().find(node => node.props.testID === 'settings-basics-codeFontSize')!.props.onChange as (value: string) => void)('150');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).not.toBe(''); expect(fixture.deviceWrite).not.toHaveBeenCalled();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test('pending cold editor read never offers a default or admits captured Reset/Save callbacks', async () => {
  const read = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":175,"editorFontSize":27}', deviceReadWait: read.promise });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-editorFontSize')!;
  expect(field().props.value).toBe(''); expect(field().props.disabled).toBe(true);
  (field().props.onChange as (value: string) => void)('13');
  (fixture.nodes().find(node => node.props.testID === 'settings-reset-editorFontSize')!.props.onPress as () => void)();
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.deviceWrite).not.toHaveBeenCalled(); expect(fixture.saveEditor).not.toHaveBeenCalled();
  read.resolve(); await flush(); expect(field().props.value).toBe('27'); expect(field().props.disabled).toBe(false); fixture.dispose();
});

test('failed known editor refresh retains the prior and dirty draft; explicit read retry cannot overwrite the staged value', async () => {
  let fail = false;
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":175,"editorFontSize":19}', preloadDevice: true, deviceReadFailure: () => fail });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-editorFontSize')!;
  (field().props.onChange as (value: string) => void)('23');
  fail = true; await expect(fixture.deviceAppearance.loadDeviceAppearance()).rejects.toThrow(); await flush();
  expect(fixture.deviceAppearance.deviceAppearance()).toEqual({ codeFontSize: 175, editorFontSize: 19, fileEditorKeymap: 'default' }); expect(field().props.value).toBe('23');
  fail = false;
  (fixture.nodes().find(node => node.props.testID === 'settings-editor-font-size-retry')!.props.onPress as () => void)(); await flush();
  expect(field().props.value).toBe('23'); expect(fixture.deviceWrite).not.toHaveBeenCalled();
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 23, fileEditorKeymap: 'default' });
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); fixture.dispose();
});

test('partial local save preserves successful code size and editor draft; retry only saves editor before the mixed Host patch', async () => {
  let writes = 0, fail = true;
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125,"editorFontSize":19}', deviceWriteFailure: () => ++writes === 2 && fail });
  const field = (key: string) => fixture.nodes().find(node => node.props.testID === `settings-basics-${key}`)!;
  expect(field('editorFontSize')).toBeDefined();
  for (const [key, value] of Object.entries({ codeFontSize: '150', editorFontSize: '22', fontSize: '135' })) (field(key).props.onChange as (value: string) => void)(value);
  const save = () => (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)();
  save(); await flush();
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 150, editorFontSize: 19, fileEditorKeymap: 'default' });
  expect(field('editorFontSize').props.value).toBe('22'); expect(field('fontSize').props.value).toBe('135');
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-code-font-size-saved')).toBe(true);
  fail = false;
  (fixture.nodes().find(node => node.props.testID === 'settings-editor-font-size-retry')!.props.onPress as () => void)(); await flush();
  expect(fixture.saveDevice.mock.calls).toEqual([[150]]); expect(fixture.saveEditor.mock.calls).toEqual([[22], [22]]);
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 150, editorFontSize: 22, fileEditorKeymap: 'default' });
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: 135 }]); fixture.dispose();
});

test('editor write across lease renewal keeps each newer ABA dirty revision and fences the old mixed Host patch', async () => {
  const write = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125,"editorFontSize":19}', deviceWriteWait: write.promise });
  const field = (key: string) => fixture.nodes().find(node => node.props.testID === `settings-basics-${key}`)!;
  expect(field('editorFontSize')).toBeDefined();
  (field('editorFontSize').props.onChange as (value: string) => void)('22');
  (field('fontSize').props.onChange as (value: string) => void)('135');
  const save = () => (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)();
  save(); await flush(); await fixture.replaceLane();
  (field('editorFontSize').props.onChange as (value: string) => void)('23'); (field('editorFontSize').props.onChange as (value: string) => void)('22');
  (field('codeFontSize').props.onChange as (value: string) => void)('175');
  write.resolve(); await flush();
  expect(fixture.saveEditor.mock.calls).toEqual([[22]]); expect(fixture.saveDevice).not.toHaveBeenCalled();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-editor-font-size-saved')).toBe(false);
  expect(fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.disabled).toBe(false);
  save(); await flush();
  expect(fixture.saveEditor.mock.calls).toEqual([[22], [22]]); expect(fixture.saveDevice.mock.calls).toEqual([[175]]);
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 22, fileEditorKeymap: 'default' });
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: 135 }]); fixture.dispose();
});

test('editor and code saves remain outside an unknown Host receipt and never clear or replay it', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125,"editorFontSize":19}', writeFailure: () => true });
  const field = (key: string) => fixture.nodes().find(node => node.props.testID === `settings-basics-${key}`)!;
  expect(field('editorFontSize')).toBeDefined();
  (field('editorFontSize').props.onChange as (value: string) => void)('22'); (field('fontSize').props.onChange as (value: string) => void)('135');
  const save = () => (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)();
  save(); await flush();
  expect(fixture.state.error()).toBe('settings.github.native.unknown');
  const receipt = [...fixture.receiptStorage.entries()];
  for (const [key, value] of Object.entries({ codeFontSize: '175', editorFontSize: '24' })) (field(key).props.onChange as (value: string) => void)(value);
  save(); await flush();
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 24, fileEditorKeymap: 'default' });
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: 135 }]);
  expect([...fixture.receiptStorage.entries()]).toEqual(receipt);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-editor-font-size-saved')).toBe(true);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-preferences-unknown')).toBe(true); fixture.dispose();
});

test('mobile keymap real radio stages Vim, saves only locally, reopens and explicitly resets while preserving both font keys', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":175,"editorFontSize":24}' });
  const radio = (value: string) => fixture.nodes().find(node => node.props.testID === `settings-preference-fileEditorKeymap-${value}`)!;
  expect(radio('default')).toBeDefined(); expect(radio('default').props.checked).toBe(true); expect(radio('vim').props.checked).toBe(false);
  (radio('vim').props.onChange as () => void)();
  expect(radio('vim').props.checked).toBe(true); expect(fixture.deviceWrite).not.toHaveBeenCalled();
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.saveKeymap.mock.calls).toEqual([['vim']]);
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 24, fileEditorKeymap: 'vim' });
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  const raw = fixture.deviceRaw(); fixture.dispose();
  const reopened = await preferencesFixture({ page: 'appearance', deviceRaw: raw });
  expect(reopened.nodes().find(node => node.props.testID === 'settings-preference-fileEditorKeymap-vim')!.props.checked).toBe(true);
  (reopened.nodes().find(node => node.props.testID === 'settings-reset-fileEditorKeymap')!.props.onPress as () => void)();
  (reopened.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(JSON.parse(reopened.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 24, fileEditorKeymap: 'default' });
  expect(reopened.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); reopened.dispose();
});

test('cold keymap read has no selected default, disables retained radio/reset callbacks and only explicit read retry resolves it', async () => {
  let fail = true;
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":175,"editorFontSize":24,"fileEditorKeymap":"vim"}', deviceReadFailure: () => fail });
  const radios = () => fixture.nodes().filter(node => node.type === 'Radio' && String(node.props.testID).startsWith('settings-preference-fileEditorKeymap-'));
  expect(radios()).toHaveLength(2); expect(radios().every(node => node.props.checked === false && node.props.disabled === true)).toBe(true);
  const reset = fixture.nodes().find(node => node.props.testID === 'settings-reset-fileEditorKeymap')!;
  expect(reset.props.disabled).toBe(true);
  for (const radio of radios()) (radio.props.onChange as () => void)(); (reset.props.onPress as () => void)();
  expect(fixture.deviceWrite).not.toHaveBeenCalled();
  fail = false;
  (fixture.nodes().find(node => node.props.testID === 'settings-file-editor-keymap-retry')!.props.onPress as () => void)(); await flush();
  expect(radios().map(node => node.props.checked)).toEqual([false, true]); expect(fixture.deviceWrite).not.toHaveBeenCalled();
  const previous = radios(); const save = fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void;
  await fixture.hide(); for (const radio of previous) (radio.props.onChange as () => void)(); (reset.props.onPress as () => void)(); save(); await flush();
  expect(radios().map(node => node.props.checked)).toEqual([false, true]); expect(fixture.saveKeymap).not.toHaveBeenCalled();
  fixture.dispose(); for (const radio of previous) (radio.props.onChange as () => void)(); save(); await flush(); expect(fixture.deviceWrite).not.toHaveBeenCalled();
});

test('partial three-key save keeps both successful fonts, failed keymap draft and mixed Host draft; retry only persists keymap', async () => {
  let writes = 0, fail = true;
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":125,"editorFontSize":19}', deviceWriteFailure: () => ++writes === 3 && fail });
  const radio = () => fixture.nodes().find(node => node.props.testID === 'settings-preference-fileEditorKeymap-vim')!;
  expect(radio()).toBeDefined(); (radio().props.onChange as () => void)();
  for (const [key, value] of Object.entries({ codeFontSize: '175', editorFontSize: '24', fontSize: '135' })) (fixture.nodes().find(node => node.props.testID === `settings-basics-${key}`)!.props.onChange as (value: string) => void)(value);
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 24, fileEditorKeymap: 'default' });
  expect(radio().props.checked).toBe(true); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-editor-font-size-saved')).toBe(true);
  fail = false;
  (fixture.nodes().find(node => node.props.testID === 'settings-file-editor-keymap-retry')!.props.onPress as () => void)(); await flush();
  expect(fixture.saveDevice.mock.calls).toEqual([[175]]); expect(fixture.saveEditor.mock.calls).toEqual([[24]]); expect(fixture.saveKeymap.mock.calls).toEqual([['vim'], ['vim']]);
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 24, fileEditorKeymap: 'vim' });
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: 135 }]); fixture.dispose();
});

test('keymap ABA across lease renewal stays dirty and cannot dispatch the old mixed Host patch', async () => {
  const write = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":175,"editorFontSize":24}', deviceWriteWait: write.promise });
  const radio = (value: string) => fixture.nodes().find(node => node.props.testID === `settings-preference-fileEditorKeymap-${value}`)!;
  expect(radio('vim')).toBeDefined(); (radio('vim').props.onChange as () => void)();
  (fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!.props.onChange as (value: string) => void)('135');
  const save = () => (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)();
  save(); await flush(); await fixture.replaceLane();
  (radio('default').props.onChange as () => void)(); (radio('vim').props.onChange as () => void)();
  write.resolve(); await flush();
  expect(fixture.saveKeymap.mock.calls).toEqual([['vim']]); expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-file-editor-keymap-saved')).toBe(false);
  expect(fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.disabled).toBe(false);
  save(); await flush(); expect(fixture.saveKeymap.mock.calls).toEqual([['vim'], ['vim']]);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: 135 }]); fixture.dispose();
});

test('keymap local success is isolated from unknown Host receipt and does not replay or turn equal GET into ACK', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', deviceRaw: '{"codeFontSize":175,"editorFontSize":24}', writeFailure: () => true });
  const radio = (value: string) => fixture.nodes().find(node => node.props.testID === `settings-preference-fileEditorKeymap-${value}`)!;
  expect(radio('vim')).toBeDefined(); (radio('vim').props.onChange as () => void)();
  (fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!.props.onChange as (value: string) => void)('135');
  const save = () => (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)();
  save(); await flush(); expect(fixture.state.error()).toBe('settings.github.native.unknown');
  const receipt = [...fixture.receiptStorage.entries()];
  (radio('default').props.onChange as () => void)(); save(); await flush();
  expect(fixture.saveKeymap.mock.calls).toEqual([['vim'], ['default']]);
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 24, fileEditorKeymap: 'default' });
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: 135 }]);
  expect([...fixture.receiptStorage.entries()]).toEqual(receipt); expect(fixture.nodes().some(node => node.props.testID === 'settings-preferences-unknown')).toBe(true); fixture.dispose();
});

test.each(['filtered', 'different'] as const)('ACK %s field keeps submitted draft and acknowledged receipt; explicit retries only GET until the Host actually applies it', async mode => {
  const draft = mode === 'filtered' ? '125' : '125.6', expected = mode === 'filtered' ? 125 : 126;
  const fixture = await preferencesFixture({ page: 'appearance', host: { fontSize: 100 }, acceptPatch: () => mode === 'filtered' ? {} : { fontSize: 125 } });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!;
  const save = () => fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!;
  (field().props.onChange as (value: string) => void)(draft); (save().props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).toBe('settings.preferences.native.notApplied'); expect(fixture.state.notice()).toBe('');
  expect(field().props.value).toBe(draft); expect(save().props.disabled).toBe(false);
  expect(fixture.nodes().some(node => node.props.testID === 'settings-preferences-unknown')).toBe(false);
  expect(fixture.onCollectionNavigation.mock.calls.at(-1)![0].blocked).toBe(true);
  const receipt = [...fixture.receiptStorage.entries()]; expect(receipt.length).toBeGreaterThan(0);
  (fixture.nodes().find(node => node.props.state === fixture.state)!.props.retry as () => void)(); await flush();
  expect(fixture.state.error()).toBe('settings.preferences.native.notApplied'); expect([...fixture.receiptStorage.entries()]).toEqual(receipt);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: expected }]);
  fixture.setHost({ fontSize: expected });
  (fixture.nodes().find(node => node.props.state === fixture.state)!.props.retry as () => void)(); await flush();
  expect(fixture.state.error()).toBe(''); expect(fixture.state.notice()).toBe('filesView.editor.saved'); expect(save().props.disabled).toBe(true);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1); fixture.dispose();
});

test('ACK not-applied handoff/reopen restores its submitted dirty value and never resends PUT', async () => {
  const first = await preferencesFixture({ host: { followUpBehavior: 'queue' }, acceptPatch: () => ({}) });
  const choice = () => first.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  (choice().props.onChange as (value: string) => void)('steer');
  (first.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(first.state.error()).toBe('settings.preferences.native.notApplied');
  first.onCollectionNavigation.mock.calls.at(-1)![0].back(); await flush();
  expect(first.onBack).toHaveBeenCalledTimes(1); expect(first.alert).not.toHaveBeenCalled(); first.dispose(); await flush();
  const next = await preferencesFixture({ host: first.host(), receiptStorage: first.receiptStorage, receiptModule: first.receiptModule });
  const reopened = () => next.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  expect(next.state.error()).toBe('settings.preferences.native.notApplied'); expect(reopened().props.value).toBe('steer');
  (next.nodes().find(node => node.props.state === next.state)!.props.retry as () => void)(); await flush();
  expect(next.state.notice()).toBe(''); expect(next.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  next.setHost({ followUpBehavior: 'steer' });
  (next.nodes().find(node => node.props.state === next.state)!.props.retry as () => void)(); await flush();
  expect(next.state.notice()).toBe('filesView.editor.saved'); expect(next.onCollectionNavigation.mock.calls.at(-1)![0].blocked).toBe(false);
  expect(next.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); next.dispose();
});

test('ACK PWA clear accepts missing override after GET without persisting any display-name fallback', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', host: { pwaAppName: 'Custom name' }, formatSettings: host => Object.fromEntries(Object.entries(host).filter(([key, value]) => key !== 'pwaAppName' || value !== '')) });
  const field = () => fixture.nodes().find(node => node.props.testID === 'settings-basics-pwaAppName')!;
  (field().props.onChange as (value: string) => void)('  ');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ pwaAppName: '' }]);
  expect(fixture.state.error()).toBe(''); expect(fixture.state.notice()).toBe('filesView.editor.saved'); expect(field().props.value).toBe(''); fixture.dispose();
});

test('unknown PUT with equal GET remains unknown, retains submitted draft and cannot become ACK or unlock on retry', async () => {
  const fixture = await preferencesFixture({ host: { followUpBehavior: 'queue' }, writeFailure: () => { fixture.setHost({ followUpBehavior: 'steer' }); return true; } });
  const choice = () => fixture.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!;
  (choice().props.onChange as (value: string) => void)('steer');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  const receipt = [...fixture.receiptStorage.entries()];
  (fixture.nodes().find(node => node.props.state === fixture.state)!.props.retry as () => void)(); await flush();
  expect(fixture.state.error()).toBe('settings.github.native.unknown'); expect(fixture.state.notice()).toBe('');
  expect(choice().props.value).toBe('steer'); expect([...fixture.receiptStorage.entries()]).toEqual(receipt);
  expect(fixture.onCollectionNavigation.mock.calls.at(-1)![0].blocked).toBe(true);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1); fixture.dispose();
});

test('three local partial successes stay confirmed while ACK Host field is not applied; GET recovery never repeats any write', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', host: { fontSize: 100 }, acceptPatch: () => ({}) });
  for (const [key, value] of Object.entries({ codeFontSize: '175', editorFontSize: '24', fontSize: '135' })) (fixture.nodes().find(node => node.props.testID === `settings-basics-${key}`)!.props.onChange as (value: string) => void)(value);
  (fixture.nodes().find(node => node.props.testID === 'settings-preference-fileEditorKeymap-vim')!.props.onChange as () => void)();
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.state.error()).toBe('settings.preferences.native.notApplied'); expect(fixture.state.notice()).toBe('');
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 24, fileEditorKeymap: 'vim' });
  for (const id of ['code-font-size', 'editor-font-size', 'file-editor-keymap']) expect(fixture.nodes().some(node => node.props.testID === `settings-${id}-saved`)).toBe(true);
  expect(fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!.props.value).toBe('135');
  fixture.setHost({ fontSize: 135 });
  (fixture.nodes().find(node => node.props.state === fixture.state)!.props.retry as () => void)(); await flush();
  expect(fixture.state.notice()).toBe('filesView.editor.saved'); expect(fixture.deviceWrite).toHaveBeenCalledTimes(3);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: 135 }]); fixture.dispose();
});

test('late old ACK application cannot clear a reopened owner not-applied receipt or its restored submitted draft', async () => {
  const apply = deferred<void>();
  const first = await preferencesFixture({ host: { followUpBehavior: 'queue' }, applyWait: apply.promise });
  (first.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!.props.onChange as (value: string) => void)('steer');
  (first.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(first.state.busy()).toBe(true); expect(first.receiptStorage.size).toBeGreaterThan(0);
  first.dispose(); await flush();
  const next = await preferencesFixture({ host: { followUpBehavior: 'queue' }, receiptStorage: first.receiptStorage, receiptModule: first.receiptModule });
  expect(next.state.error()).toBe('settings.preferences.native.notApplied');
  const before = [...next.receiptStorage.entries()];
  apply.resolve(); await flush();
  expect([...next.receiptStorage.entries()]).toEqual(before);
  expect(next.nodes().find(node => node.type === 'SettingsChoice' && node.props.title === 'settings.yuri.visual.field.followUpBehavior')!.props.value).toBe('steer');
  expect(next.state.notice()).toBe(''); expect(next.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  next.setHost({ followUpBehavior: 'steer' });
  (next.nodes().find(node => node.props.state === next.state)!.props.retry as () => void)(); await flush();
  expect(next.state.notice()).toBe('filesView.editor.saved'); expect(next.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0); next.dispose();
});

test('real appearance root rebinds both readers after background null scope to new same-Host lease without clearing canonical prior or device/draft state', async () => {
  const fixture = await preferencesFixture({ page: 'appearance', realAppearance: true, host: { fontSize: 125 }, deviceRaw: '{"codeFontSize":150,"editorFontSize":20}' });
  const root = fixture.realAppearance!;
  expect(root.nativeAppearance.current()?.fontSize).toBe(125);
  expect(root.nativeAppearance.current()?.codeFontSize).toBe(150);
  (fixture.nodes().find(node => node.props.testID === 'settings-basics-editorFontSize')!.props.onChange as (value: string) => void)('24');
  const published = vi.spyOn(root.nativeAppearance.current, 'set'), before = fixture.nativeCalls.length;
  await fixture.replaceLane();
  expect(root.nativeAppearance.error()).toBe('');
  expect(root.nativeAppearance.current()?.fontSize).toBe(125); expect(root.nativeAppearance.current()?.codeFontSize).toBe(150);
  expect(published.mock.calls.some(([value]) => value === null)).toBe(false);
  expect(fixture.nodes().find(node => node.props.testID === 'settings-basics-editorFontSize')!.props.value).toBe('24');
  expect(fixture.appearanceTimers.size).toBe(1);
  const resumed = fixture.nativeCalls.slice(before).filter(call => call.name === 'runtime.request');
  expect(resumed.length).toBeGreaterThan(0);
  for (const call of resumed) expect(call.input.expectedHost).toEqual({ hostID: 'synthetic-A', lease: 'synthetic-lease-2' });
  const afterResume = fixture.nativeCalls.length;
  for (const callback of fixture.cancelledAppearanceTimers) callback(); await flush();
  expect(fixture.nativeCalls).toHaveLength(afterResume);
  fixture.setHost({ lightThemeId: 'synthetic-missing-theme' });
  for (const callback of fixture.appearanceTimers.values()) for (let tick = 0; tick < 50; tick++) callback(); await flush();
  const timerReads = fixture.nativeCalls.slice(afterResume).filter(call => call.name === 'runtime.request');
  expect(timerReads.map(call => call.input.path)).toEqual(['/api/config/settings', '/api/config/themes']);
  for (const call of timerReads) expect(call.input.expectedHost).toEqual({ hostID: 'synthetic-A', lease: 'synthetic-lease-2' });
  expect(root.nativeAppearance.current()?.fontSize).toBe(125); expect(root.nativeAppearance.error()).not.toBe(''); fixture.dispose();
});

test('appearance reader replacement retires the old ACK freshness barrier and delayed apply cannot publish across background resume', async () => {
  const oldApply = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', realAppearance: true, oldAppearanceApply: oldApply.promise, host: { fontSize: 100 } });
  const root = fixture.realAppearance!;
  const result = root.refreshNativeAppearance(() => true).then(() => 'accepted', () => 'retired');
  fixture.setHost({ fontSize: 125 }); await fixture.replaceLane(); oldApply.resolve(); await flush();
  expect(await result).toBe('retired'); expect(root.nativeAppearance.current()?.fontSize).toBe(125);
  expect(root.nativeAppearance.error()).toBe(''); fixture.dispose();
});

test('ACK confirmation waits for a real appearance refresh started after the old single-flight has applied its captured 100 snapshot', async () => {
  const oldApply = deferred<void>();
  const fixture = await preferencesFixture({ page: 'appearance', realAppearance: true, oldAppearanceApply: oldApply.promise, host: { fontSize: 100 } });
  expect(fixture.appearanceApplies()).toBe(1); expect(fixture.realAppearance!.nativeAppearance.current()).toBeNull();
  const published = vi.spyOn(fixture.realAppearance!.nativeAppearance.current, 'set');
  for (const [key, value] of Object.entries({ codeFontSize: '175', editorFontSize: '24' })) (fixture.nodes().find(node => node.props.testID === `settings-basics-${key}`)!.props.onChange as (value: string) => void)(value);
  (fixture.nodes().find(node => node.props.testID === 'settings-preference-fileEditorKeymap-vim')!.props.onChange as () => void)();
  (fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!.props.onChange as (value: string) => void)('125');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  expect(fixture.host().fontSize).toBe(125); expect(fixture.state.notice()).toBe(''); expect(fixture.state.busy()).toBe(true);
  const reads = fixture.request.mock.calls.filter(call => call[0] === '/api/config/settings' && call[1] === 'GET').length;
  expect(reads).toBe(3); expect(fixture.receiptStorage.size).toBeGreaterThan(0);
  oldApply.resolve(); await flush();
  expect(fixture.realAppearance!.nativeAppearance.current()?.fontSize).toBe(125);
  expect(published.mock.calls.map(call => call[0]?.fontSize).filter(Boolean)).toEqual([100, 125]);
  expect(fixture.appearanceApplies()).toBe(2);
  expect(fixture.request.mock.calls.filter(call => call[0] === '/api/config/settings' && call[1] === 'GET')).toHaveLength(reads + 1);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT').map(call => call[2])).toEqual([{ fontSize: 125 }]);
  expect(JSON.parse(fixture.deviceRaw()!)).toEqual({ codeFontSize: 175, editorFontSize: 24, fileEditorKeymap: 'vim' });
  expect(fixture.deviceWrite).toHaveBeenCalledTimes(3);
  expect(fixture.state.error()).toBe(''); expect(fixture.state.notice()).toBe('filesView.editor.saved');
  expect(fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.disabled).toBe(true); fixture.dispose();
});

test('real post-ACK appearance read failure retains submitted dirty and receipt, and explicit GET retry recovers without PUT replay', async () => {
  const oldApply = deferred<void>(); let readsAfterAck = 0;
  const fixture = await preferencesFixture({ page: 'appearance', realAppearance: true, oldAppearanceApply: oldApply.promise, host: { fontSize: 100 },
    formatSettings: host => { if (host.fontSize === 125 && ++readsAfterAck === 2) throw new Error('fresh appearance read failed'); return host; } });
  (fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!.props.onChange as (value: string) => void)('125');
  (fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.onPress as () => void)(); await flush();
  oldApply.resolve(); await flush();
  expect(fixture.realAppearance!.nativeAppearance.current()?.fontSize).toBe(100);
  expect(fixture.realAppearance!.nativeAppearance.error()).toBe('fresh appearance read failed');
  expect(fixture.state.notice()).toBe(''); expect(fixture.state.error()).not.toBe('');
  expect(fixture.nodes().find(node => node.props.testID === 'settings-basics-fontSize')!.props.value).toBe('125');
  expect(fixture.nodes().find(node => node.props.testID === 'settings-preferences-save')!.props.disabled).toBe(false);
  expect(fixture.receiptStorage.size).toBeGreaterThan(0);
  (fixture.nodes().find(node => node.props.state === fixture.state)!.props.retry as () => void)(); await flush();
  expect(fixture.realAppearance!.nativeAppearance.current()?.fontSize).toBe(125);
  expect(fixture.state.error()).toBe(''); expect(fixture.state.notice()).toBe('filesView.editor.saved');
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(1); fixture.dispose();
});

test('production Scroll and direct SettingsTarget layout stop offscreen work and restore one shared preview clock without writes or scroll measurement', async () => {
  const fixture = await preferencesFixture({ animatePreview: true });
  // Mount the real presentation once; subsequent events use these retained
  // callbacks and reactive props, not a newly constructed component owner.
  const rendered = fixture.nodes(); await flush();
  const scroll = rendered.find(node => node.type === 'Scroll')!;
  const target = rendered.find(node => node.props.testID === 'settings-target-chat.render-mode')!;
  const line = rendered.find(node => node.props.testID === 'settings-preference-preview-live-line-0')!;
  const onLayout = scroll.props.onLayout as (event: unknown) => void;
  const onScroll = scroll.props.onScroll as (event: unknown) => void;
  const onFieldLayout = target.props.onLayout as (event: unknown) => void;
  const layout = (y: number, height: number) => ({ bounds: { origin: { x: 0, y }, size: { width: 402, height } } });
  const event = (y: number, height = 600) => ({ offset: { x: 0, y }, size: { width: 402, height }, contentSize: { width: 402, height: 2200 }, zoomScale: 1 });
  const tick = async () => { for (const run of [...fixture.previewTimers.values()]) run(); await flush(); };
  const reads = fixture.request.mock.calls.length;
  expect(fixture.previewTimers.size).toBe(0);
  onLayout(layout(100, 600)); await flush(); expect(fixture.previewTimers.size).toBe(0);
  onFieldLayout(layout(20, 280)); await flush(); expect(fixture.previewTimers.size).toBe(1);
  await tick(); expect(line.props.style).toMatchObject({ width: '42%' });
  const firstClock = [...fixture.previewTimers.values()][0];
  for (let y = 0; y < 300; y++) onScroll(event(y));
  await flush(); expect(fixture.previewTimers.size).toBe(1); expect(fixture.previewStarts()).toBe(1);
  const outside = event(300); onScroll(outside); await flush();
  expect(fixture.navigationScroll).toHaveBeenLastCalledWith(outside);
  expect(fixture.previewTimers.size).toBe(0);
  for (let y = 301; y < 1000; y++) onScroll(event(y));
  await flush(); expect(fixture.previewTimers.size).toBe(0); expect(fixture.previewStarts()).toBe(1);
  firstClock(); await flush(); expect(line.props.style).toMatchObject({ width: '42%', transitionDuration: 0 });
  onScroll(event(0)); await flush(); expect(fixture.previewTimers.size).toBe(1);
  firstClock(); await flush(); expect(line.props.style).toMatchObject({ width: '42%' });
  await tick(); expect(line.props.style).toMatchObject({ width: '68%' });
  onFieldLayout(layout(700, 280)); await flush(); expect(fixture.previewTimers.size).toBe(0);
  onLayout(layout(100, 701)); await flush(); expect(fixture.previewTimers.size).toBe(1);
  onLayout(layout(100, 700)); await flush(); expect(fixture.previewTimers.size).toBe(0);
  onScroll(event(1, 700)); await flush(); expect(fixture.previewTimers.size).toBe(1);
  expect(fixture.request.mock.calls).toHaveLength(reads);
  expect(fixture.request.mock.calls.filter(call => call[1] === 'PUT')).toHaveLength(0);
  await fixture.hide(); expect(fixture.previewTimers.size).toBe(0);
  await fixture.show(); expect(fixture.previewTimers.size).toBe(1);
  fixture.dispose(); expect(fixture.previewTimers.size).toBe(0);
  for (const stale of fixture.cancelledPreviewTimers) stale();
  await flush(); expect(fixture.previewTimers.size).toBe(0);
  expect(line.props.style).toMatchObject({ width: '68%' });
});
