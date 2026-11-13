import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import { createResourceHtmlViewer, type ResourceHtmlViewerController } from './resource-html-viewer-state';
import * as model from './resources-model';
import * as requests from './resources-request';
import * as scopes from './runtime-scope';
import { createResourceWatcher } from './resources-watcher';
import { createResourceGuiFile } from './resources-gui';
import { bindResourceWebPreview, resourceWebPreviewIntent } from './resource-web-preview';
import { createResourceRouteExit, createResourceConnectionClear } from './resource-retirement';
import { nativeAnchor, type NativeAnchorEvent } from './tests/resource-presentation-native';

const root = path.dirname(fileURLToPath(import.meta.url));
type Node = { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown>; children: unknown[] };
const flush = async () => { for (let index = 0; index < 60; index++) await Promise.resolve(); };
const pending = () => { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

/** Actual ResourcePreviewOwner -> viewer -> controller -> native display ports.
 * This small JSX evaluator replaces only NSH rendering/signals and native I/O;
 * it never executes the engine or treats a mock promise as native WK evidence. */
function production(options: { targetLine?: number; route?: 'files' | 'preview'; globalConnection?: boolean; content?: Partial<model.ResourceContent>; contact?: boolean; path?: string; pendingRead?: boolean } = {}) {
  const scope = { hostID: 'fixture', lease: '00000000-0000-4000-8000-000000000001' };
  let observing: (() => void) | undefined, serial = 0, reads = 0, controller!: ResourceHtmlViewerController;
  let rootLive = true, pops = 0, deadWrites = 0;
  const cleanups: Array<() => void> = [];
  const destroyRoot = () => { if (!rootLive) return; for (const close of cleanups.splice(0).reverse()) close(); rootLive = false; };
  const source = <T>(initial: T) => {
    let value = initial; const listeners = new Set<() => void>();
    const read = () => { if (!rootLive) throw Error('read from disposed signal owner'); if (observing) listeners.add(observing); return value; };
    return Object.assign(read, { set(this: unknown, next: T) {
      if (this !== read) throw Error('not a live signal: unbound native setter');
      if (!rootLive) { deadWrites++; throw Error('write to disposed signal owner'); }
      if (Object.is(value, next)) return; value = next; for (const run of [...listeners]) run();
    } });
  };
  const location = source(options.path ?? '/fixture/page.html'), visible = source(true);
  const receipt = source(scope);
  const connection = source({ id: scope.hostID, url: 'https://fixture.invalid' });
  const resourceRoute = { kind: options.route ?? 'preview' }, rootRoute = { kind: 'root' };
  let routes = [rootRoute, resourceRoute];
  const nav = { routes: () => routes, setRoutes(next: typeof routes) { routes = next; }, popToRoot() { routes = routes.slice(0, 1); } };
  const resourceConnectionClear = createResourceConnectionClear(nav);
  const guiResult = pending(), guiRetirement = pending();
  const guiPresent = vi.fn(() => guiResult.promise), guiClose = vi.fn(() => guiRetirement.promise);
  let failRead = false, failPresent = false, system: ReturnType<typeof pending> | undefined, htmlClose: ReturnType<typeof pending> | undefined, failClose = false;
  let readBarrier = options.pendingRead ? pending() : undefined;
  const native = vi.fn(async (name: string, _input: Record<string, unknown>) => {
    if (name === 'resources.read') { await readBarrier?.promise; if (failRead) throw Error('synthetic_read_failed'); return { kind: 'text', lease: `original-${++reads}`, text: '<p>original source</p>', stat: { size: 22, mtimeMs: reads, isBinary: false }, ...options.content }; }
    if (name === 'resources.present') { if (failPresent) throw Error('synthetic_permission_denied'); return system?.promise ?? { completed: true }; }
    if (name === 'resources.web.close') { if (failClose) { failClose = false; throw Error('exact_retirement_rejected'); } return htmlClose?.promise ?? true; }
    if (['resources.close', 'resources.release', 'resources.cancel', 'resources.web.close'].includes(name)) return true;
    throw Error('Unexpected native request: ' + name);
  });
  const request = vi.fn(async () => ({ isFile: true, size: 22, mtimeMs: reads, isBinary: false }));
  const effect = (work: () => void) => { const run = () => { const before = observing; observing = run; try { work(); } finally { observing = before; } }; run(); };
  const untracked = <T>(work: () => T): T => { const before = observing; observing = undefined; try { return work(); } finally { observing = before; } };
  const jsx = (type: Node['type'], props: Node['props'] | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children });
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      const next = ts.visitEachChild(node, visit, context);
      if (!ts.isCallExpression(next) || !ts.isIdentifier(next.expression) || next.expression.text !== 'jsx') return next;
      const [type, props, ...children] = next.arguments;
      const getters = props && ts.isObjectLiteralExpression(props) ? ts.factory.updateObjectLiteralExpression(props, props.properties.map(property => ts.isPropertyAssignment(property)
        ? ts.factory.createGetAccessorDeclaration(undefined, property.name, [], undefined, ts.factory.createBlock([ts.factory.createReturnStatement(property.initializer)])) : property)) : props;
      return ts.factory.updateCallExpression(next, next.expression, next.typeArguments, [type, getters, ...children.map(child => ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), child))]);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  const modules: Record<string, unknown> = {
    nsh: { View: 'View', Text: 'Text', Scroll: 'Scroll', Image: 'Image', List: 'List', signal: source, computed: (read: () => unknown) => read,
      effect, untracked, cleanup: (close: () => void) => cleanups.push(close), lifecycle: () => 'active', colorScheme: () => 'dark', locale: () => 'en', Clipboard: { writeText: vi.fn(async () => {}) } },
    'nsh/base': { Button: 'Button', Input: 'Input', TextView: 'TextView', Dialog: 'Dialog', NavPage: 'NavPage', NavStack: 'NavStack', createNavStack: (routes: string[]) => ({ routes: () => routes }) },
    './runtime': { native, bindRequest: () => request }, './state': { app: { runtimeScope: receipt, connection }, epoch: () => 1 },
    './runtime-scope': scopes, './resources-request': requests, './resources-model': model, './resources-watcher': { createResourceWatcher },
    './resource-svg': { ResourceSVGImage: 'NativeSVG' }, './resource-html-native': { ResourceHTMLView: 'HTMLNative', ResourceHTMLPresentationAnchor: 'HTMLAnchor' },
    './Icon': { Icon: 'Icon' },
    './resource-html-viewer-state': { createResourceHtmlViewer: (input: Parameters<typeof createResourceHtmlViewer>[0]) => { controller = createResourceHtmlViewer(input); return controller; } },
    './resource-retirement': { createResourceRouteExit },
    './resource-web-preview': { bindResourceWebPreview, resourceWebPreviewIntent }, './resources-gui': { createResourceGuiFile },
    './gui-plugin-native-context-factory': { bindNativeGuiPluginPreview: () => ({ present: guiPresent, close: guiClose }) },
    './i18n': { t: (key: string) => key, language: () => 'system' }, './model': { id: () => `fixture-${++serial}` },
    './appearance': { nativeAppearance: { current: () => null }, nativeChatTextStyle: () => ({}), nativeCodeTextViewStyles: () => ({}) },
  };
  function evaluate<T>(file: string, extra = ''): T {
    const exports = {};
    const output = ts.transpileModule(readFileSync(path.join(root, file), 'utf8') + extra, { fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx', jsxFragmentFactory: 'Fragment' }, transformers: { after: [lazy] } }).outputText;
    vm.runInNewContext(output, { exports, jsx, Fragment: 'Fragment', Each: 'Each', If: 'If', setTimeout: () => 1, clearTimeout: () => {},
      require: (id: string) => { if (!(id in modules)) throw Error('Unexpected production import: ' + id); return modules[id]; } });
    return exports as T;
  }
  modules['./resource-html-viewer'] = evaluate('resource-html-viewer.tsx');
  const owner = evaluate<typeof import('./resources') & { owner: (props: Record<string, unknown>) => Node }>('resources.tsx', '\nexport const owner = ResourcePreviewOwner;');
  modules['./resources'] = owner;
  const navigation = evaluate<typeof import('./resource-navigation')>('resource-navigation.tsx');
  const props = { kind: options.contact ? 'contact' : 'file', file: { type: 'file', kind: 'contact', hostID: scope.hostID, assistantID: 'fixture-bot', attachmentID: 'opaque-note', sha256: 'a'.repeat(64), size: 22, mime: 'text/plain', filename: 'note.txt', name: 'note.txt' }, directory: '/fixture', get path() { return location(); }, get active() { return visible(); }, targetLine: options.targetLine, expectedHost: scope };
  const tree = options.route ? jsx(navigation[options.route === 'files' ? 'ResourceFilesPage' : 'ResourcePreviewPage'] as Node['type'], { ...props, title: 'Files fixture', connectionExit: options.globalConnection ? (exit: Parameters<typeof resourceConnectionClear.register>[1]) => resourceConnectionClear.register(resourceRoute, exit) : undefined, onClose() { pops++; destroyRoot(); } }) : owner.owner(props);
  const evaluated = new WeakMap<object, unknown>(), components = new WeakMap<object, unknown>(), each = new WeakMap<object, Map<unknown, unknown>>();
  function nodes(): Node[] {
    const result: Node[] = [];
    const evaluateChild = (value: unknown): unknown => {
      if (typeof value !== 'function') return value;
      if (!evaluated.has(value) || evaluated.get(value) == null) evaluated.set(value, value()); return evaluated.get(value);
    };
    const walk = (value: unknown): void => {
      if (typeof value === 'function') { walk(evaluateChild(value)); return; }
      if (Array.isArray(value)) { value.forEach(walk); return; }
      if (!value || typeof value !== 'object' || !('type' in value)) return;
      const node = value as Node;
      if (typeof node.type === 'function') {
        if (!components.has(node)) {
          const props = Object.defineProperties({}, Object.getOwnPropertyDescriptors(node.props)) as Record<string, unknown>;
          if (node.children.length) Object.defineProperty(props, 'children', { get: () => node.children.length === 1 ? evaluateChild(node.children[0]) : node.children.map(evaluateChild) });
          components.set(node, node.type(props));
        }
        walk(components.get(node)); return;
      }
      if (node.type === 'If') { if (node.props.when) node.children.forEach(walk); else walk(node.props.else); return; }
      if (node.type === 'Each') {
        let cache = each.get(node); if (!cache) { cache = new Map(); each.set(node, cache); }
        for (const item of node.props.of as unknown[]) {
          const key = node.props.key ? (node.props.key as (value: unknown) => unknown)(item) : item;
          if (!cache.has(key)) cache.set(key, (evaluateChild(node.children[0]) as (value: () => unknown) => unknown)(() => item));
          walk(cache.get(key));
        }
        return;
      }
      result.push(node); if (node.type === 'List') return;
      for (const key of ['headerLeft', 'headerRight']) walk(node.props[key]); node.children.forEach(walk);
    };
    walk(tree); return result;
  }
  const find = (type: string) => { const value = nodes().find(node => node.type === type); if (!value) throw Error('Missing production node ' + type); return value; };
  const text = (value: unknown): string => {
    if (typeof value === 'function') return text(value());
    if (Array.isArray(value)) return value.map(text).join('');
    if (value && typeof value === 'object' && 'children' in value) return text((value as Node).children);
    return typeof value === 'string' ? value : '';
  };
  const button = (label: string) => { const value = nodes().find(node => node.type === 'Button' && (text(node).includes(label) || node.props.accessibilityLabel === label)); if (!value) throw Error('Missing production action ' + label); return value; };
  const press = (node: Node) => { if (node.props.disabled) throw Error('Disabled production action'); (node.props.onPress as () => void)(); };
  if (options.globalConnection) {
    // Execute the exact production global effect, including its stable Host identity dependency.
    const file = ts.createSourceFile('application.tsx', readFileSync(path.join(root, 'application.tsx'), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
    let entry: ts.CallExpression | undefined;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(file) === 'effect' && node.getText(file).includes('previous = selected')) entry = node;
      ts.forEachChild(node, visit);
    };
    visit(file); if (!entry) throw Error('Missing production connection clear effect');
    const desktopHostIdentity = () => { const value = connection(); return JSON.stringify([value.id, value.url, value.authorizationID]); };
    vm.runInNewContext('let previous; ' + entry.getText(file), { effect, untracked, desktopHostIdentity, resourceConnectionClear });
  }
  nodes();
  return { nodes, find, button, press, location, visible, scope: receipt, native, guiResult, guiRetirement, guiPresent, guiClose, controller: () => controller,
    failRead: () => { failRead = true; }, failPresent: () => { failPresent = true; }, system: () => { system = pending(); return system; },
    completeRead: () => { readBarrier?.resolve(undefined); readBarrier = undefined; }, delayRead: () => { readBarrier = pending(); },
    delayClose: () => { htmlClose = pending(); return htmlClose; }, failClose: () => { failClose = true; }, destroyRoot,
    pops: () => pops, rootLive: () => rootLive, deadWrites: () => deadWrites, connection, routes: () => routes,
    resourceRoute, registerRoute: resourceConnectionClear.register,
    pushRoute: (kind: string) => { const route = { kind }; routes.push(route); return route; } };
}

test('production GUI retirement admits inline HTML once; source watcher adoptions and failures keep the exact mounted WK configuration', async () => {
  const f = production(); await flush(); expect(f.guiPresent).toHaveBeenCalledOnce();
  expect(f.nodes().filter(node => node.type === 'HTMLNative')).toHaveLength(0);
  f.guiResult.resolve({ closed: true, matched: false }); await flush();
  expect(f.guiClose).toHaveBeenCalled(); expect(f.nodes().filter(node => node.type === 'HTMLNative')).toHaveLength(0);
  f.guiRetirement.resolve(undefined); await flush();
  const node = f.find('HTMLNative'), config = node.props.config;
  expect(config).toMatchObject({ lease: 'original-1', path: '/fixture/page.html' });
  const mount = f.controller().state().mount;
  f.press(f.button('mobile.files.refreshAria')); await flush();
  expect(f.native.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(2);
  expect(f.controller().state().mount).toBe(mount); expect(f.find('HTMLNative')).toBe(node); expect(f.find('HTMLNative').props.config).toBe(config);
  f.failRead(); f.press(f.button('mobile.files.refreshAria')); await flush();
  expect(f.controller().state().mount).toBe(mount); expect(f.find('HTMLNative').props.config).toBe(config);
  expect(f.native.mock.calls.filter(([name]) => name === 'resources.web.present')).toHaveLength(0);
});

test('production fullScreen registers the exact presenter, locks Back during save, and returns through real Dialog completion', async () => {
  const f = production(); await flush(); f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  f.press(f.nodes().find(node => node.props.testID === 'resource-html-fullscreen')!); await flush();
  const dialog = f.find('Dialog'); (dialog.props.onOpen as () => void)(); await flush();
  const anchor = f.find('HTMLAnchor'), anchorConfig = anchor.props.config as { owner: string };
  (anchor.props.onReady as (value: unknown) => void)({ owner: anchorConfig.owner });
  const system = f.system(); f.press(f.button('sessions.scheduledTasks.editor.actions.save')); await flush();
  expect(f.native.mock.calls.find(([name]) => name === 'resources.present')?.[1]).toMatchObject({ lease: 'original-1', action: 'save', presentationOwner: anchorConfig.owner });
  const generation = f.controller().state().dialog!.generation;
  await f.controller().back(generation); expect(f.controller().state().dialog?.open).toBe(true);
  system.resolve({ completed: true }); await flush();
  await f.controller().back(generation); expect(f.controller().state().dialog?.open).toBe(false); expect(f.controller().state().mount).toBeNull();
  (dialog.props.onClose as () => void)(); await flush(); expect(f.controller().state().mount?.presentation).toBe('inline');
});

test('actual read completion settles the caption after GUI prepare and admits the dedicated viewer', async () => {
  const f = production({ pendingRead: true }); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-read-loading')).toBe(true);
  f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-read-loading')).toBe(true);
  expect(f.nodes().some(node => node.type === 'HTMLNative')).toBe(false);
  f.completeRead(); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-read-loading')).toBe(false);
  expect(f.find('HTMLNative')).toBeDefined();
});

for (const action of ['save', 'share']) test(`fullscreen ${action} keeps the native action lock without mislabelling the loaded document as Loading`, async () => {
  const f = production(); await flush();
  f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  f.press(f.nodes().find(node => node.props.testID === 'resource-html-fullscreen')!); await flush();
  const anchor = f.find('HTMLAnchor'), owner = (anchor.props.config as { owner: string }).owner;
  (anchor.props.onReady as (event: { owner: string }) => void)({ owner });
  (anchor.props.onOpened as (event: { owner: string }) => void)({ owner }); await flush();
  const html = f.find('HTMLNative'), system = f.system();
  f.press(f.nodes().find(node => node.props.testID === `resource-html-${action}`)!); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-read-loading')).toBe(false);
  expect(f.find('HTMLNative')).toBe(html);
  for (const id of ['resource-html-back', 'resource-html-mode', 'resource-html-save', 'resource-html-share']) {
    expect(f.nodes().find(node => node.props.testID === id)?.props.disabled).toBe(true);
  }
  system.resolve({ completed: false }); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-read-loading')).toBe(false);
  expect(f.nodes().find(node => node.props.testID === 'resource-html-back')?.props.disabled).toBe(false);
  expect(f.nodes().find(node => node.props.testID === `resource-html-${action}`)?.props.disabled).toBe(false);
  expect(f.find('HTMLNative')).toBe(html);
});

test('late prior-generation ready/opened/closed callbacks cannot settle a current read or authorize the new fullscreen', async () => {
  const f = production(); await flush();
  f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  const refresh = f.button('mobile.files.refreshAria');
  f.press(f.nodes().find(node => node.props.testID === 'resource-html-fullscreen')!); await flush();
  const old = f.find('HTMLAnchor'), oldOwner = (old.props.config as { owner: string }).owner;
  (old.props.onOpened as (event: { owner: string }) => void)({ owner: oldOwner }); await flush();
  f.press(f.nodes().find(node => node.props.testID === 'resource-html-back')!); await flush();
  (old.props.onClosed as (event: { owner: string }) => void)({ owner: oldOwner }); await flush();
  f.press(f.nodes().find(node => node.props.testID === 'resource-html-fullscreen')!); await flush();
  const current = f.find('HTMLAnchor'), currentOwner = (current.props.config as { owner: string }).owner;
  (current.props.onOpened as (event: { owner: string }) => void)({ owner: currentOwner }); await flush();
  const generation = f.controller().state().dialog!.generation, html = f.find('HTMLNative');
  f.delayRead(); f.press(refresh); await flush();
  for (const callback of ['onReady', 'onOpened', 'onClosed']) (old.props[callback] as (event: { owner: string }) => void)({ owner: oldOwner });
  await flush();
  expect(f.controller().state().dialog?.generation).toBe(generation);
  expect(f.nodes().some(node => node.props.testID === 'resource-read-loading')).toBe(true);
  f.completeRead(); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-read-loading')).toBe(false);
  expect(f.nodes().find(node => node.props.testID === 'resource-html-share')?.props.disabled).toBe(true);
  expect(f.find('HTMLNative')).toBe(html);
  (current.props.onReady as (event: { owner: string }) => void)({ owner: currentOwner });
  expect(f.nodes().find(node => node.props.testID === 'resource-html-share')?.props.disabled).toBe(false);
});

test('failed read completion ends only its loading caption and preserves the real failure instead of creating a ready viewer', async () => {
  const f = production({ pendingRead: true }); await flush();
  f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-read-loading')).toBe(true);
  f.failRead(); f.completeRead(); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-read-loading')).toBe(false);
  expect(f.nodes().some(node => node.type === 'HTMLNative')).toBe(false);
  expect(f.nodes().some(node => node.type === 'Text' && node.children.some(child => typeof child === 'function' && String(child()).includes('synthetic_read_failed')))).toBe(true);
});

test('actual HTML content with unsupported generic presenter uses its dedicated viewer without duplicate fallback and retains WK/read errors', async () => {
  const f = production({ content: { preview: 'unsupported', previewError: 'preview_unavailable' } }); await flush();
  f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  const html = f.find('HTMLNative'); expect(f.nodes().some(node => node.props.testID === 'resource-preview-unavailable')).toBe(false);
  const row = f.nodes().find(node => node.props.testID === 'resource-html-actions')!;
  expect(row.props.class).toContain('w-full'); expect(row.props.class).not.toContain('flex-row');
  const common = f.nodes().find(node => node.props.testID === 'resource-inline-actions')!;
  expect(common.props.class).toContain('w-full'); expect(common.props.class).toContain('flex-wrap');
  for (const id of ['resource-html-mode', 'resource-html-fullscreen']) {
    const button = f.nodes().find(node => node.props.testID === id)!;
    expect(button.type).toBe('Button'); expect(button.props.class).toContain('min-h-11'); expect(button.props.class).toContain('min-w-11');
    expect(button.props.accessibilityLabel).toBe(id === 'resource-html-mode' ? 'mobile.files.html.viewSourceAria' : 'mobile.files.html.fullscreenAria');
  }
  f.failRead(); f.press(f.button('mobile.files.refreshAria')); await flush();
  expect(f.find('HTMLNative')).toBe(html);
  expect(f.nodes().some(node => node.type === 'Text' && node.children.some(child => typeof child === 'function' && String(child()).includes('synthetic_read_failed')))).toBe(true);
  (html.props.onFailed as (event: { owner: string }) => void)({ owner: f.controller().state().mount!.owner }); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-html-close-error')).toBe(true);
});

for (const contact of [false, true]) test(`${contact ? 'contact' : 'file'} source renderer owns unsupported generic metadata while native save permission errors stay visible`, async () => {
  const f = production({ contact, path: '/fixture/note.txt', targetLine: 1, content: { preview: 'unsupported', previewError: 'preview_unavailable' } }); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-preview-unavailable')).toBe(false);
  const actions = f.nodes().find(node => node.props.testID === 'resource-inline-actions')!;
  expect(actions.props.class).toContain('w-full'); expect(actions.props.class).toContain('flex-wrap');
  f.failPresent(); f.press(f.button('sessions.scheduledTasks.editor.actions.save')); await flush();
  expect(f.native.mock.calls.filter(([name]) => name === 'resources.present')).toHaveLength(1);
  expect(f.nodes().some(node => node.type === 'Text' && node.children.some(child => typeof child === 'function' && String(child()).includes('synthetic_permission_denied')))).toBe(true);
});

for (const kind of ['binary', 'image', 'pdf', 'video', 'audio'] as const) test(`${kind} without a dedicated renderer retains the true unsupported native fallback`, async () => {
  const f = production({ path: '/fixture/unsupported.dat', targetLine: 1, content: { kind, preview: 'unsupported' } }); await flush();
  expect(f.nodes().some(node => node.props.testID === 'resource-preview-unavailable')).toBe(true);
  expect(f.nodes().some(node => node.props.testID === 'resource-media-preview')).toBe(false);
});

test('exact native anchor completion, not Dialog.open removal, owns the fullscreen lifetime', async () => {
  const f = production(); await flush(); f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  f.press(f.nodes().find(node => node.props.testID === 'resource-html-fullscreen')!); await flush();
  const dialog = f.find('Dialog'), anchor = f.find('HTMLAnchor'), owner = (anchor.props.config as { owner: string }).owner;
  expect(dialog.props.open).toBe(true);
  (anchor.props.onOpened as (event: { owner: string }) => void)({ owner }); await flush();
  expect(f.controller().state().mount?.presentation).toBe('fullScreen');
  f.press(f.nodes().find(node => node.props.testID === 'resource-html-back')!); await flush();
  expect(anchor.props.closing).toBe(true); expect(dialog.props.open).toBe(true); expect(f.controller().state().mount).toBeNull();
  (anchor.props.onClosed as (event: { owner: string }) => void)({ owner: 'stale-owner' }); await flush();
  expect(f.controller().state().dialog).not.toBeNull();
  (anchor.props.onClosed as (event: { owner: string }) => void)({ owner }); await flush();
  expect(f.controller().state().dialog).toBeNull(); expect(f.controller().state().mount?.presentation).toBe('inline');
});

for (const source of [false, true]) test(`compiled production Swift anchor closes after pre-attach receipt rejection (${source ? 'source without WK' : 'preview'}), and global clear waits its completion`, async () => {
  const f = production({ route: 'preview', globalConnection: true }); await flush();
  f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  if (source) { f.press(f.nodes().find(node => node.props.testID === 'resource-html-mode')!); await flush(); }
  f.press(f.nodes().find(node => node.props.testID === 'resource-html-fullscreen')!); await flush();
  const anchor = f.find('HTMLAnchor'), owner = (anchor.props.config as { owner: string }).owner, events: NativeAnchorEvent[] = [];
  const native = nativeAnchor(event => {
    events.push(event);
    const handler = { ready: 'onReady', failed: 'onFailed', opened: 'onOpened', closed: 'onClosed', closeFailed: 'onCloseFailed' }[event.event];
    if (handler) (anchor.props[handler] as (event: NativeAnchorEvent) => void)(event);
  });
  try {
    await native.command(`configure ${owner}`);
    f.connection.set({ id: 'host-b', url: 'https://b.invalid' }); await flush();
    expect(anchor.props.closing).toBe(true);
    await native.command(`request ${anchor.props.closeAttempt}`);
    await native.command('revoke');
    const attached = await native.command('attach'); await flush();
    expect(attached).toMatchObject({ captures: 1, presenters: 0, dismissCalls: 0 });
    expect(events.map(event => event.event)).toContain('failed'); expect(events.map(event => event.event)).not.toContain('ready');
    expect(f.routes()).toContain(f.resourceRoute);
    const middle = f.pushRoute('host-b-business');
    f.connection.set({ id: 'host-c', url: 'https://c.invalid' }); await flush();
    const later = f.pushRoute('host-c-business');
    expect((await native.command('open')).dismissCalls).toBe(1); await flush();
    expect(f.routes()).toContain(f.resourceRoute); expect(events.map(event => event.event)).not.toContain('closed');
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.release')).toHaveLength(0);
    expect(f.button('sessions.scheduledTasks.editor.actions.save').props.disabled).toBe(true);
    expect(f.controller().state().mount).toBeNull();
    await native.command('restoreAuthority'); await native.command('replaceAncestry');
    const inspected = await native.command('layout');
    expect(inspected).toMatchObject({ captures: 1, presenters: 0, foreignDismissCalls: 0 });
    await native.command('complete'); await flush();
    expect(events.filter(event => event.event === 'closed')).toEqual([{ event: 'closed', owner }]);
    expect(f.routes()).not.toContain(f.resourceRoute); expect(f.routes()).not.toContain(middle); expect(f.routes()).toContain(later);
    expect(await native.command('complete')).toMatchObject({ dismissCalls: 1, foreignDismissCalls: 0 });
    expect(events.filter(event => event.event === 'closed')).toHaveLength(1); expect(f.routes()).toContain(later);
    expect(f.controller().state().mount).toBeNull();
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.release')).toHaveLength(1);
  } finally { native.close(); }
}, 150_000);

test('compiled native close failure rejects the production retirement and retries the same unauthorized controller', async () => {
  const f = production({ route: 'preview', globalConnection: true }); await flush();
  f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  f.press(f.nodes().find(node => node.props.testID === 'resource-html-fullscreen')!); await flush();
  const anchor = f.find('HTMLAnchor'), owner = (anchor.props.config as { owner: string }).owner, events: NativeAnchorEvent[] = [];
  const native = nativeAnchor(event => {
    events.push(event);
    const handler = { ready: 'onReady', failed: 'onFailed', opened: 'onOpened', closed: 'onClosed', closeFailed: 'onCloseFailed' }[event.event];
    if (handler) (anchor.props[handler] as (event: NativeAnchorEvent) => void)(event);
  });
  try {
    await native.command(`configure ${owner}`);
    f.connection.set({ id: 'host-b', url: 'https://b.invalid' }); await flush();
    await native.command(`request ${anchor.props.closeAttempt}`); await native.command('revoke'); await native.command('attach');
    await native.command('foreign'); await native.command('open'); await flush();
    expect(events).toContainEqual({ event: 'closeFailed', owner, attempt: 1, code: 'controller_not_dismissible' });
    expect(f.routes()).toContain(f.resourceRoute); expect(f.controller().state().dialog?.generation).toBe(1);
    expect(f.nodes().some(node => node.props.testID === 'resource-route-retire-retry')).toBe(true);
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.release')).toHaveLength(0);
    expect(events.map(event => event.event)).not.toContain('closed');
    await native.command('restoreController'); await native.command('restoreAuthority');
    f.press(f.nodes().find(node => node.props.testID === 'resource-route-retire-retry')!); await flush();
    expect(anchor.props.closeAttempt).toBe(2);
    expect(await native.command('request 2')).toMatchObject({ captures: 1, presenters: 0, dismissCalls: 1 });
    expect(f.routes()).toContain(f.resourceRoute);
    expect(f.button('sessions.scheduledTasks.editor.actions.save').props.disabled).toBe(true);
    await native.command('complete'); await flush();
    expect(f.routes()).not.toContain(f.resourceRoute); expect(f.controller().state().dialog).toBeNull();
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.release')).toHaveLength(1);
    expect(events.filter(event => event.event === 'closed')).toEqual([{ event: 'closed', owner }]);
  } finally { native.close(); }
}, 150_000);

test('production targetLine retains the original source List and never prepares either GUI or HTML WK', async () => {
  const f = production({ targetLine: 1 }); await flush();
  expect(f.guiPresent).not.toHaveBeenCalled(); expect(f.nodes().filter(node => node.type === 'HTMLNative')).toHaveLength(0);
  expect(f.nodes().find(node => node.props.testID === 'resource-source-lines')?.type).toBe('List');
  expect(f.controller().state().mode).toBe('source');
});

test('production path change keeps the lifecycle root and waits fullscreen onClose before the next GUI preparation or HTML mount', async () => {
  const f = production(); await flush(); f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  f.press(f.nodes().find(node => node.props.testID === 'resource-html-fullscreen')!); await flush();
  const dialog = f.find('Dialog'); (dialog.props.onOpen as () => void)(); await flush();
  const previous = f.find('HTMLNative').props.config;
  f.location.set('/fixture/next.html'); await flush();
  expect(previous).toMatchObject({ path: '/fixture/page.html', lease: 'original-1' });
  expect(f.controller().state().dialog?.open).toBe(false); expect(f.controller().state().mount).toBeNull(); expect(f.guiPresent).toHaveBeenCalledTimes(1);
  (dialog.props.onClose as () => void)(); await flush();
  expect(f.guiPresent).toHaveBeenCalledTimes(2); expect(f.find('HTMLNative').props.config).toMatchObject({ path: '/fixture/next.html', lease: 'original-2' });
});

for (const route of ['files', 'preview'] as const) {
  test(`${route} production native Back retains its parent root through delayed exact close and coalesces repeat Back`, async () => {
    const f = production({ route }); await flush();
    f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
    const page = f.find('NavPage'), old = f.controller().state().mount!;
    expect(page.props.popOnBack).toBe(false); expect(page.props.popOnSwipe).toBe(false);
    const close = f.delayClose();
    (page.props.onBackPress as () => void)(); (page.props.onBackPress as () => void)(); await flush();
    expect(f.rootLive()).toBe(true); expect(f.pops()).toBe(0); expect(f.controller().state().mount).toBe(old);
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.web.close')).toEqual([
      ['resources.web.close', { owner: old.owner, expectedHost: { hostID: 'fixture', lease: '00000000-0000-4000-8000-000000000001' } }],
    ]);
    close.resolve(true); await flush();
    expect(f.pops()).toBe(1); expect(f.rootLive()).toBe(false); expect(f.deadWrites()).toBe(0);
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
  });

  test(`${route} production native Back failure keeps the exact root/ticket and explicit retry never mounts a fresh WK`, async () => {
    const f = production({ route }); await flush();
    f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
    const page = f.find('NavPage'), old = f.controller().state().mount!;
    f.failClose(); (page.props.onBackPress as () => void)(); await flush();
    expect(f.rootLive()).toBe(true); expect(f.pops()).toBe(0); expect(f.controller().state().mount).toBe(old);
    expect(f.nodes().some(node => node.props.testID === 'resource-route-retire-retry')).toBe(true);
    const retry = f.delayClose(); f.press(f.nodes().find(node => node.props.testID === 'resource-route-retire-retry')!); await flush();
    expect(f.pops()).toBe(0); expect(f.controller().state().mount).toBe(old);
    retry.resolve(true); await flush();
    expect(f.pops()).toBe(1); expect(f.deadWrites()).toBe(0);
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.web.close').map(([, input]) => input.owner)).toEqual([old.owner, old.owner]);
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
  });

  test(`${route} production parent pop also waits the same fullscreen Dialog generation's actual onClose`, async () => {
    const f = production({ route }); await flush();
    f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
    const page = f.find('NavPage'); f.press(f.nodes().find(node => node.props.testID === 'resource-html-fullscreen')!); await flush();
    const dialog = f.find('Dialog'); (dialog.props.onOpen as () => void)(); await flush();
    const generation = f.controller().state().dialog!.generation, close = f.delayClose();
    (page.props.onBackPress as () => void)(); await flush(); expect(f.pops()).toBe(0);
    close.resolve(true); await flush();
    expect(f.rootLive()).toBe(true); expect(f.pops()).toBe(0); expect(f.controller().state().dialog?.open).toBe(false);
    await f.controller().dialogClosed(generation + 1); expect(f.pops()).toBe(0);
    (dialog.props.onClose as () => void)(); await flush();
    expect(f.pops()).toBe(1); expect(f.rootLive()).toBe(false); expect(f.deadWrites()).toBe(0);
  });

  test(`${route} production scope retirement retains the old root on rejection and revokes reads before retry`, async () => {
    const f = production({ route }); await flush();
    f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
    const old = f.controller().state().mount!;
    f.failClose(); f.scope.set({ hostID: 'fixture', lease: '00000000-0000-4000-8000-000000000002' }); await flush();
    expect(f.rootLive()).toBe(true); expect(f.controller().state().mount).toBe(old);
    expect(f.nodes().some(node => node.props.testID === 'resource-scope-retire-retry')).toBe(true);
    f.press(f.button('mobile.files.refreshAria')); await flush();
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
    const attempts = f.native.mock.calls.filter(([name]) => name === 'resources.web.close').length;
    f.scope.set({ hostID: 'fixture', lease: '00000000-0000-4000-8000-000000000003' }); await flush();
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.web.close')).toHaveLength(attempts);
    const retry = f.delayClose(); f.press(f.nodes().find(node => node.props.testID === 'resource-scope-retire-retry')!); await flush();
    expect(f.controller().state().mount).toBe(old); retry.resolve(true); await flush();
    expect(f.controller().state().mount).toBeNull(); expect(f.pops()).toBe(0);
    for (const [, input] of f.native.mock.calls.filter(([name]) => name === 'resources.web.close')) expect(input.expectedHost).toEqual({ hostID: 'fixture', lease: '00000000-0000-4000-8000-000000000001' });
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
  });
}

test('production connection effect discards an older successful clear when a newer captured resource gate rejects', async () => {
  const f = production({ route: 'preview', globalConnection: true }); await flush();
  f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  const close = f.delayClose();
  f.connection.set({ id: 'host-b', url: 'https://b.invalid' }); await flush();
  const newer = f.pushRoute('host-b-resource');
  let retry!: () => void, fail = true;
  f.registerRoute(newer, { async retireForConnection(next) { retry = next; if (fail) throw Error('newer_resource_close_failed'); } });
  f.connection.set({ id: 'host-c', url: 'https://c.invalid' }); await flush();
  const later = f.pushRoute('host-c-business');
  close.resolve(true); await flush();
  expect(f.routes()).toContain(f.resourceRoute); expect(f.routes()).toContain(newer); expect(f.routes()).toContain(later);
  fail = false; retry(); await flush();
  expect(f.routes()).not.toContain(f.resourceRoute); expect(f.routes()).not.toContain(newer); expect(f.routes()).toContain(later);
});

test('destroying the display root disconnects native signal setters while pending exact retirement still completes', async () => {
  const f = production(); await flush(); f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
  const old = f.controller().state().mount!, close = f.delayClose();
  f.destroyRoot(); await flush();
  expect(f.native.mock.calls.filter(([name]) => name === 'resources.web.close').map(([, input]) => input.owner)).toEqual([old.owner]);
  close.resolve(true); await flush();
  expect(f.controller().state().mount).toBeNull(); expect(f.deadWrites()).toBe(0);
  await f.controller().update({ identity: 'new-scope', active: true, htmlFile: true, gui: 'unmatched' });
  expect(f.controller().state().mount).toBeNull();
});

for (const route of ['files', 'preview'] as const) {
  test(`${route} production connection-ID clear retains exact root on reject and retries without restoring old authority`, async () => {
    const f = production({ route, globalConnection: true }); await flush();
    f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
    const old = f.controller().state().mount!;
    f.failClose(); f.connection.set({ id: 'new-host', url: 'https://new.invalid' }); await flush();
    expect(f.routes()).toContain(f.resourceRoute); expect(f.controller().state().mount).toBe(old);
    expect(f.nodes().some(node => node.props.testID === 'resource-route-retire-retry')).toBe(true);
    const reads = f.native.mock.calls.filter(([name]) => name === 'resources.read').length;
    expect(reads).toBe(1);
    f.press(f.button('mobile.files.refreshAria')); await flush();
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(reads);
    const close = f.delayClose(); f.press(f.nodes().find(node => node.props.testID === 'resource-route-retire-retry')!); await flush();
    expect(f.routes()).toContain(f.resourceRoute); close.resolve(true); await flush();
    expect(f.routes()).not.toContain(f.resourceRoute); expect(f.controller().state().mount).toBeNull();
    for (const [, input] of f.native.mock.calls.filter(([name]) => name === 'resources.web.close')) expect(input.expectedHost.hostID).toBe('fixture');
  });

  test(`${route} production connection clear waits real same-generation fullscreen close and preserves routes opened after two switches`, async () => {
    const f = production({ route, globalConnection: true }); await flush();
    f.guiResult.resolve({ closed: true, matched: false }); f.guiRetirement.resolve(undefined); await flush();
    f.press(f.nodes().find(node => node.props.testID === 'resource-html-fullscreen')!); await flush();
    const dialog = f.find('Dialog'); (dialog.props.onOpen as () => void)(); await flush();
    const generation = f.controller().state().dialog!.generation, close = f.delayClose();
    const previousCloses = f.native.mock.calls.filter(([name]) => name === 'resources.web.close').length;
    f.connection.set({ id: 'host-b', url: 'https://b.invalid' }); await flush();
    const middle = f.pushRoute('host-b-business');
    f.connection.set({ id: 'host-c', url: 'https://c.invalid' }); await flush();
    const later = f.pushRoute('host-c-business');
    close.resolve(true); await flush();
    expect(f.routes()).toContain(f.resourceRoute); expect(f.routes()).toContain(later);
    await f.controller().dialogClosed(generation + 1); await flush(); expect(f.routes()).toContain(f.resourceRoute);
    (dialog.props.onClose as () => void)(); await flush();
    expect(f.routes()).not.toContain(f.resourceRoute); expect(f.routes()).not.toContain(middle); expect(f.routes()).toContain(later);
    expect(f.connection().id).toBe('host-c');
    expect(f.native.mock.calls.filter(([name]) => name === 'resources.web.close')).toHaveLength(previousCloses + 1);
  });
}

test('application consumes the guarded Files and direct-preview pages as the actual native route roots', () => {
  const file = ts.createSourceFile('application.tsx', readFileSync(path.join(root, 'application.tsx'), 'utf8'), ts.ScriptTarget.ES2023, true, ts.ScriptKind.TSX);
  const pages = new Map<string, ts.JsxSelfClosingElement[]>();
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && ['ResourceFilesPage', 'ResourcePreviewPage'].includes(node.tagName.getText(file))) {
      const name = node.tagName.getText(file); pages.set(name, [...pages.get(name) ?? [], node]);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of ['ResourceFilesPage', 'ResourcePreviewPage']) {
    const matches = pages.get(name)!; expect(matches).toHaveLength(1);
    const page = matches[0]; expect(ts.isReturnStatement(page.parent)).toBe(true);
    const attrs = page.attributes.properties.filter(ts.isJsxAttribute);
    expect(attrs.find(attr => attr.name.getText(file) === 'connectionExit')?.getText(file)).toContain('resourceConnectionClear.register(route, owner)');
    const active = attrs.find(attr => attr.name.getText(file) === 'active')!, close = attrs.find(attr => attr.name.getText(file) === 'onClose')!;
    expect(active.getText(file)).toContain('nav.routes().at(-1) === route');
    expect(close.getText(file)).toContain('if (nav.routes().at(-1) === route) nav.pop()');
    if (name === 'ResourcePreviewPage') for (const key of ['expectedHost', 'targetLine', 'onOpen']) expect(attrs.some(attr => attr.name.getText(file) === key)).toBe(true);
  }
});
