import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeNewSessionPageHandoff } from './new-session';
import type { createNativeReferenceKeyboard } from './composer-reference-keyboard-native';

const harness = vi.hoisted(() => ({
  call: vi.fn(), get: vi.fn(), set: vi.fn(), storage: new Map<string, string>(),
  cleanups: [] as Array<() => void>, effects: [] as Array<() => void | (() => void)>, stops: [] as Array<() => void>,
}));
function source<T>(initial: T) { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); }
vi.mock('nsh', () => ({
  platform: { os: 'ios', desktop: false },
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(),
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
  effect: (work: () => void | (() => void)) => { harness.effects.push(work); const stop = work(); if (stop) harness.stops.push(stop); },
  cleanup: (work: () => void) => harness.cleanups.push(work), lifecycle: () => 'active',
  Storage: { getItem: harness.get, setItem: harness.set },
  host: { available: () => true, call: harness.call, on: () => () => {} },
}));
type Node = { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown>; children: unknown[] };
const project = { id: 'p', name: 'Project', path: '/repo' };
let receipt: NativeNewSessionPageHandoff | undefined;
const flush = async () => { for (let index = 0; index < 160; index++) await Promise.resolve(); };
const requests = () => harness.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input);
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); receipt = undefined; harness.storage.clear(); harness.cleanups = []; harness.effects = []; harness.stops = [];
  harness.get.mockReset().mockImplementation(async (key: string) => harness.storage.get(key) ?? null);
  harness.set.mockReset().mockImplementation(async (key: string, value: string) => { harness.storage.set(key, value); });
  harness.call.mockReset().mockImplementation(async (name, input) => {
    if (name === 'connection.list') return { selected: 'one', connections: [{ id: 'one', label: 'Host', url: 'https://host.example', lastUsedAt: 0 }], runtimeScope: { hostID: 'one', lease: 'page-fixture-lease' } };
    if (name !== 'runtime.request') return true;
    const path = input.path;
    const body = path === '/api/session' ? { id: 'created', location: { directory: '/repo' } }
      : path.startsWith('/api/session/created?') ? { id: 'created', location: { directory: '/repo' } }
      : path.includes('/message?') ? { data: [] }
      : path.includes('/prompt?') ? { id: input.body.id, sessionID: 'created', type: 'user', payload: { text: input.body.text } }
      : path === '/api/session/active' ? {} : [];
    return { status: 200, body };
  });
  await (await import('./state')).loadConnections();
  await flush(); harness.call.mockClear();
});
afterEach(async () => { harness.stops.forEach(stop => stop()); harness.cleanups.forEach(stop => stop()); await receipt?.release(); await flush(); vi.useRealTimers(); });

/** Actual production page callbacks, not an NSH renderer/layout simulation. */
async function pageFixture(uiResponse: (path: string, method?: string, body?: unknown) => unknown = () => [], attachment?: { call: (name: string, body: Record<string, unknown>) => Promise<unknown>; choose: () => Promise<{ action: string }> }) {
  const api = await import('./new-session'), model = await import('./model'), state = await import('./state');
  const mobileControls = await import('../ui/src/components/chat/mobileControlsUtils'), touchGestures = await import('../ui/src/lib/touch-gestures/tap');
  const pickerHelpers = await import('./chat-models-helpers'), starters = await import('./new-session-ui-helpers'), selection = await import('./new-session-selection');
  const density = await import('./native-density');
  const owners: ReturnType<typeof api.createNativeNewSessionOwnership>[] = [], callbacks: Array<() => void> = [], effects: Array<() => void> = [];
  const h = (type: Node['type'], props: Node['props'] | null, ...children: unknown[]): Node => {
    const observed = { ...props };
    for (const reactive of ['popOnSwipe', 'when', 'of', 'open', 'value']) if (typeof observed[reactive] === 'function') Object.defineProperty(observed, reactive, { get: observed[reactive] as () => unknown });
    if (typeof type === 'function' && children.length) observed.children = children[0];
    return { type, props: observed, children };
  };
  const active = source(true), keyboardHeight = source(0), lifecycle = source('active'), onBack = vi.fn(), nativeCommand = vi.fn();
  const uiRequest = vi.fn(async (path: string, method?: string, body?: unknown) => uiResponse(path, method, body));
  const keyboard = { trigger: () => null, commandTrigger: () => null, dismiss: () => {}, ref: () => {}, selectedRange: () => undefined, onFocus: () => {}, onBlur: () => {}, submitBehavior: () => 'newline', onSubmit: () => {}, onSelectionChange: () => {}, onCompositionChange: () => {}, beforeChange: () => {}, refresh: () => {} };
  const commandPorts: Array<Parameters<typeof createNativeReferenceKeyboard>[0]> = [];
  const imports: Record<string, unknown> = {
    nsh: { batch: <T>(work: () => T) => work(), keymap: { bind: () => () => {} }, signal: source, computed: (work: () => unknown) => work, untracked: (work: () => unknown) => work(), token: (name: string) => name, cleanup: (work: () => void) => callbacks.push(work), effect: (work: () => void) => { effects.push(work); work(); }, lifecycle, platform: { os: 'ios' }, nativeComponent: (name: string, spec: unknown) => {
      if (name !== 'yuri.sheet.presentation') throw new Error(`Unexpected native leaf ${name}`);
      expect(spec).toEqual({ props: ['generation', 'detents', 'initialDetent', 'viewportDetents', 'dismissible'], events: ['ready', 'opened', 'dismissed', 'cancel'] });
      return name;
    }, keyboardFrame: () => ({ height: keyboardHeight(), duration: 0 }), safeArea: () => ({ top: 0, bottom: 0 }), windowSize: () => ({ width: 390, height: 844 }), Keyboard: { dismiss: () => {} }, Speech: { available: async () => false }, Scroll: 'Scroll', Text: 'Text', View: 'View', Overlay: 'Overlay' },
    'nsh/base': { Button: 'Button', Input: 'Input', NavPage: 'NavPage', Sheet: 'Sheet', Dialog: 'Dialog', AlertDialog: { show: attachment?.choose ?? (async () => ({ action: 'cancel' })) } },
    './appearance': { nativeChatTextStyle: () => ({}), nativeDensity: () => density.nativeLayoutDensity() }, './native-density': density, './chat-identity': { NativeAgentAvatar: 'Avatar', NativeModelLogo: 'Logo', nativeAgentAccent: () => 'foreground' }, './chat-models-helpers': pickerHelpers,
    '../ui/src/components/chat/mobileControlsUtils': mobileControls, '../ui/src/lib/touch-gestures/tap': touchGestures, './new-session-ui-helpers': starters,
    './new-session-selection': { createNewSessionCatalog: (directory: string, current: () => boolean) => selection.createNewSessionCatalog(directory, current, uiRequest) },
    './composer-controls': { NativeCommandSuggestions: 'CommandSuggestions' }, './composer-reference-keyboard-native': { createNativeReferenceKeyboard: (options: Parameters<typeof createNativeReferenceKeyboard>[0]) => { commandPorts.push(options); return keyboard; } }, './composer-references-controls': { NativeReferencePicker: 'ReferencePicker' },
    './composer-surface': await import('./composer-surface'), './composer-commands-model': await import('./composer-commands-model'),
    './new-session-local-commands': {},
    './composer-command-router': await import('./composer-command-router'),
    './attachment-pick': await import('./attachment-pick'),
    './composer-send': { NativeComposerSend: (props: Node['props']) => h('Button', { ...props, testID: 'send' }) }, './Icon': { Icon: 'Icon' }, './i18n': { t: (key: string) => key }, './model': model,
    './new-session': { ...api, createNativeNewSessionOwnership: (...args: Parameters<typeof api.createNativeNewSessionOwnership>) => { const owner = api.createNativeNewSessionOwnership(...args); owners.push(owner); return owner; } },
    './new-session-copy': { newSessionText: (key: string) => key }, './new-session-models': { NativeNewSessionModels: 'Models' }, './runtime': { native: attachment?.call ?? (async () => null), request: uiRequest }, './state': { ...state, captureHostRequest: () => uiRequest },
    './new-session-native-owners': { NativeNewSessionPresentation: 'NativePresentation', NativeNewSessionInputAX: 'NativeInputAX' },
    './desktop-attachments': await import('./desktop-attachments'),
    './desktop-attachments-recovery': await import('./desktop-attachments-recovery'),
    './desktop-composer-actions': await import('./desktop-composer-actions'),
    './page-operations': await import('./page-operations'),
    './new-session-writer': await import('./new-session-writer'),
    './new-session-directory': await import('./new-session-directory'),
    './native-input-metadata': { NativeInputMetadata: 'NativeInputMetadata' }, './native-composer-spellcheck': { NativeComposerSpellcheck: 'NativeComposerSpellcheck' },
  };
  const sourceFile = readFileSync(fileURLToPath(new URL('./new-session-page.tsx', import.meta.url)), 'utf8');
  // Observe the actual production expressions lazily, as NSH's signal-bound
  // control props do. This does not simulate UIKit layout or gesture arbitration.
  const observeControlProps: ts.TransformerFactory<ts.SourceFile> = context => root => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && ['popOnSwipe', 'when', 'of', 'open', 'value'].includes(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        const expression = ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), ts.visitNode(node.initializer.expression, visit) as ts.Expression);
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, expression));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  };
  const transpile = (source: string) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' }, transformers: { before: [observeControlProps] } }).outputText;
  const ports = { require: (name: string) => { if (!(name in imports)) throw new Error(`Unmocked page import ${name}`); return imports[name]; }, h, Fragment: 'Fragment', If: 'If', Each: 'Each', console, Promise, Error, setTimeout, clearTimeout };
  imports['./new-session-modal-owner'] = await import('./new-session-modal-owner');
  const pickerPresentation = {};
  imports['../ui/src/components/ui/heightSnapPhysics'] = await import('../ui/src/components/ui/heightSnapPhysics');
  imports['./chat-models-helpers'] = await import('./chat-models-helpers');
  vm.runInNewContext(transpile(readFileSync(fileURLToPath(new URL('./model-picker-presentation.tsx', import.meta.url)), 'utf8')), { ...ports, exports: pickerPresentation }, { filename: 'model-picker-presentation.tsx' });
  imports['./model-picker-presentation'] = pickerPresentation;
  imports['./sheet-presentation'] = await import('./sheet-presentation');
  const nativeSheet: { NativeSheet?: Node['type'] } = {};
  vm.runInNewContext(transpile(readFileSync(fileURLToPath(new URL('./native-sheet.tsx', import.meta.url)), 'utf8')), { ...ports, exports: nativeSheet }, { filename: 'native-sheet.tsx' });
  imports['./native-sheet'] = nativeSheet;
  const modal = {};
  vm.runInNewContext(transpile(readFileSync(fileURLToPath(new URL('./new-session-modal.tsx', import.meta.url)), 'utf8')), { ...ports, exports: modal }, { filename: 'new-session-modal.tsx' });
  imports['./new-session-modal'] = modal;
  const js = transpile(sourceFile);
  const exports: { NativeNewSessionPage?: (props: Record<string, unknown>) => Node } = {};
  vm.runInNewContext(js, { exports, ...ports }, { filename: 'new-session-page.tsx' });
  const props = { project, get active() { return active(); }, onBack, onOpenChat: (_target: unknown, next: NativeNewSessionPageHandoff) => { receipt = next; } };
  const root = exports.NativeNewSessionPage!(props);
  const cache = new Map<Node['type'], Map<unknown, unknown>>();
  const eachCache = new WeakMap<Node, Map<unknown, unknown>>();
  const readyLeaves = new WeakSet<Node>();
  function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object' || !('type' in value)) return [];
    const node = value as Node;
    if (node.type === 'yuri.sheet.presentation' && !readyLeaves.has(node)) {
      readyLeaves.add(node);
      (node.props.ref as (ref: unknown) => void)({ command: nativeCommand });
      (node.props.onReady as (event: unknown) => void)({ generation: node.props.generation });
    }
    if (typeof node.type === 'function') {
      let instances = cache.get(node.type); if (!instances) { instances = new Map(); cache.set(node.type, instances); }
      const key = node.props.owner ?? node.props.ownership ?? node;
      if (!instances.has(key)) instances.set(key, node.type(node.props));
      const content = nodes(instances.get(key));
      return node.type === nativeSheet.NativeSheet ? [node, ...content] : content;
    }
    if (node.type === 'If') return nodes(node.props.when ? node.children : node.props.else);
    if (node.type === 'Each') {
      const child = node.children[0] as (item: () => unknown) => unknown;
      let items = eachCache.get(node); if (!items) { items = new Map(); eachCache.set(node, items); }
      return ((node.props.of ?? []) as unknown[]).flatMap(item => { if (!items.has(item)) items.set(item, child(() => item)); return nodes(items.get(item)); });
    }
    return [node, ...nodes(node.children)];
  }
  nodes(root);
  await owners[0]!.owner.ready;
  const tree = nodes(root);
  await flush();
  const find = (id: string) => { const result = nodes(root).find(node => node.props.testID === id); if (!result) throw new Error(`Missing page node: ${id}`); return result; };
  return { owners, active, keyboardHeight, lifecycle, onBack, nativeCommand, commandPorts, uiRequest, root, tree, find, render: () => nodes(root), runEffects: () => effects.forEach(work => work()), unmount: () => { callbacks.splice(0).forEach(work => work()); } };
}

describe('new-session production page callback boundary', () => {
  it.each(['hidden', 'unmount'])('actual attachment callback captures original session scope and exactly cancels on %s', async reason => {
    let resolve!: (value: unknown) => void; const result = new Promise<unknown>(done => { resolve = done; });
    const call = vi.fn(async (name: string, body: Record<string, unknown>) => {
      if (name === 'runtime.pickAttachment') return result;
      const original = call.mock.calls[0][1];
      if (name === 'runtime.cancelAttachment' && Object.keys(body).sort().join(',') === 'expectedHost,requestId'
        && body.requestId === original.requestId && JSON.stringify(body.expectedHost) === JSON.stringify(original.expectedHost)) return true;
      throw new Error('Unexpected attachment callback');
    });
    const page = await pageFixture(undefined, { call, choose: async () => ({ action: 'files' }) });
    (page.find('new-session-composer').props.onChange as (event: { value: string }) => void)({ value: 'Keep draft and owner' });
    const owner = page.owners[0]; (page.find('new-session-attach').props.onPress as () => void)(); await flush();
    expect(call.mock.calls[0][0]).toBe('runtime.pickAttachment');
    expect(call.mock.calls[0][1]).toMatchObject({ kind: 'files', expectedHost: { hostID: 'one', lease: 'page-fixture-lease' } });
    expect(Object.keys(call.mock.calls[0][1]).sort()).toEqual(['expectedHost', 'kind', 'requestId']);
    if (reason === 'hidden') { page.active.set(false); page.runEffects(); } else page.unmount();
    await flush(); expect(call.mock.calls[1][0]).toBe('runtime.cancelAttachment');
    resolve({ uri: 'attachment://late', name: 'late.txt', mime: 'text/plain' }); await flush();
    expect(owner.owner.durable.attachments()).toEqual([]); expect(owner.owner.durable.draft()).toBe('Keep draft and owner');
    expect(page.owners).toHaveLength(1); expect(requests()).toEqual([]);
    if (reason === 'hidden') page.unmount();
  });
  it.each(['/model ', '/MODEL keep this draft'])('typed or Tab-inserted %s opens local model picker without creating or sending', async value => {
    const page = await pageFixture();
    (page.find('new-session-composer').props.onChange as (event: { value: string }) => void)({ value });
    (page.find('send').props.onPress as () => void)(); await flush(); page.runEffects();
    expect(requests()).toEqual([]); expect(receipt).toBeUndefined();
    expect(page.owners[0]!.owner.durable.draft()).toBe(value);
    expect(page.render().some(node => node.type === 'Dialog')).toBe(true); page.unmount();
  });
  it.each([true, false])('production candidate model submit=%s replaces the body; later model submit preserves that inserted body and root attachments', async submit => {
    const page = await pageFixture(), owner = page.owners[0].owner;
    owner.setDraftText('/m\nkeep this'); owner.setAttachments([{ uri: 'attachment://keep', name: 'keep.txt', mime: 'text/plain' }]);
    const port = page.commandPorts[0];
    expect(port.chooseCommand?.({ id: 'yuri:model', name: 'model', source: 'yuri' }, submit, {
      owner: owner.operation()!, scope: owner.durable.scope, query: 'm', text: '/m\nkeep this', start: 0, end: 2, editing: true,
    })).toBe(true);
    expect(owner.durable.draft()).toBe('/\u2003model ');
    if (!submit) { expect(page.render().some(node => node.type === 'Dialog')).toBe(false); (page.find('send').props.onPress as () => void)(); }
    await flush(); page.runEffects(); expect(requests()).toEqual([]); expect(owner.durable.draft()).toBe('/\u2003model ');
    expect(owner.durable.attachments()).toEqual([{ uri: 'attachment://keep', name: 'keep.txt', mime: 'text/plain' }]);
    expect(page.render().some(node => node.type === 'Dialog')).toBe(true); page.unmount();
  });
  it.each(['submit', 'candidate'] as const)('production %s /new reopens the current unsent draft idempotently and preserves resources', async via => {
    const page = await pageFixture();
    const owner = page.owners[0].owner; owner.setDraftText(via === 'submit' ? '/new tail' : '/n\ntail');
    owner.setAttachments([{ uri: 'attachment://keep', mime: 'text/plain' }]);
    if (via === 'submit') (page.find('send').props.onPress as () => void)();
    else expect(page.commandPorts[0].chooseCommand?.({ id: 'yuri:new', name: 'new', source: 'yuri' }, true, {
      owner: owner.operation()!, scope: owner.durable.scope, query: 'n', text: '/n\ntail', start: 0, end: 2, editing: true,
    })).toBe(true);
    await flush(); expect(page.owners).toHaveLength(1); expect(page.owners[0].owner).toBe(owner); expect(owner.durable.draft()).toBe('');
    expect(owner.durable.attachments()).toHaveLength(1); expect(requests()).toEqual([]); expect(receipt).toBeUndefined();
    expect(owner.phase()).toBe('draft'); page.unmount();
  });
  it('unavailable session locals and wrong local identity cannot reach first session creation', async () => {
    const page = await pageFixture(), owner = page.owners[0].owner;
    for (const text of ['/btw Why?', '/undo', '/redo', '/fork', '/timeline', '/summary', '/init']) {
      owner.setDraftText(text); (page.find('send').props.onPress as () => void)(); await flush();
      expect(owner.durable.draft()).toBe(text); expect(requests()).toEqual([]); expect(receipt).toBeUndefined();
    }
    owner.setDraftText('/m');
    const port = page.commandPorts[0], context = { owner: owner.operation()!, scope: owner.durable.scope, query: 'm', text: '/m', start: 0, end: 2, editing: true };
    expect(port.chooseCommand?.({ id: 'yuri:invented', name: 'invented', source: 'yuri' }, true, context)).toBe(false);
    expect(owner.durable.draft()).toBe('/m');
    expect(port.chooseCommand?.({ id: 'opencode:model', name: 'model', source: 'opencode', isBuiltIn: true }, true, context)).toBe(true);
    expect(page.render().some(node => node.type === 'Dialog')).toBe(false); expect(requests()).toEqual([]); page.unmount();
  });
  it.each(['send', 'enter', 'tab'] as const)('new-draft compact %s takes the existing create/handoff route and ordinary prompt fallback when Host has no command', async via => {
    const page = await pageFixture(), owner = page.owners[0].owner;
    owner.setDraftText(via === 'send' ? '/compact optional topic' : '/c\nold tail');
    if (via === 'send') (page.find('send').props.onPress as () => void)();
    else {
      expect(page.commandPorts[0].chooseCommand?.({ id: 'yuri:compact', name: 'compact', source: 'yuri' }, via === 'enter', {
        owner: owner.operation()!, scope: owner.durable.scope, query: 'c', text: '/c\nold tail', start: 0, end: 2, editing: true,
      })).toBe(true);
      if (via === 'tab') { expect(receipt).toBeUndefined(); expect(requests()).toEqual([]); (page.find('send').props.onPress as () => void)(); }
    }
    await flush(); expect(receipt).toBeDefined(); expect(requests().filter(request => request.path === '/api/session')).toHaveLength(1);
    expect(requests().some(request => request.path.includes('/compact?'))).toBe(false);
    const state = await import('./state'), api = await import('./new-session'), chat = state.createChat(receipt!.receipt.target); await chat.draftReady; await flush();
    expect(await api.sendNewSessionHandoff(chat, receipt!.receipt)).toBe(true);
    const prompts = requests().filter(request => request.path.includes('/prompt?')); expect(prompts).toHaveLength(1);
    expect(requests().findIndex(request => request.path === '/api/session')).toBeLessThan(requests().findIndex(request => request.path.startsWith('/api/command?')));
    expect(prompts[0].body.text).toBe(via === 'send' ? '/compact optional topic' : via === 'enter' ? '/compact' : '/\u2003compact ');
    expect(requests().some(request => request.path.includes('/command?') && request.method === 'POST')).toBe(false);
    await receipt!.owner.complete(receipt!.receipt); expect(owner.durable.draft()).toBe(''); page.unmount();
  });
  it.each([true, false])('new-draft compact resolves actual Host metadata isBuiltIn=%s through the ordinary handoff without calling local compact', async isBuiltIn => {
    const base = harness.call.getMockImplementation()!;
    harness.call.mockImplementation(async (name, input) => name === 'runtime.request' && input.path.startsWith('/api/command?')
      ? { status: 200, body: [{ name: 'compact', isBuiltIn, reference: 'project:compact' }] } : base(name, input));
    const page = await pageFixture(), owner = page.owners[0].owner; owner.setDraftText('/compact topic'); (page.find('send').props.onPress as () => void)(); await flush();
    expect(receipt).toBeDefined(); const state = await import('./state'), api = await import('./new-session'), chat = state.createChat(receipt!.receipt.target); await chat.draftReady; await flush();
    expect(await api.sendNewSessionHandoff(chat, receipt!.receipt)).toBe(true);
    expect(requests().filter(request => request.path === '/api/session')).toHaveLength(1);
    expect(requests().filter(request => request.path.includes('/command?') && request.method === 'POST')).toHaveLength(isBuiltIn ? 1 : 0);
    if (!isBuiltIn) expect(requests().find(request => request.path.includes('/prompt?')).body.text).toBe('[command:project:compact] topic');
    expect(requests().some(request => request.path.includes('/compact?'))).toBe(false); page.unmount();
  });
  it.each(['malformed', 'failed'] as const)('new-draft compact %s metadata preserves the created receipt and does not become an empty-catalog prompt', async failure => {
    const base = harness.call.getMockImplementation()!;
    harness.call.mockImplementation(async (name, input) => name === 'runtime.request' && input.path.startsWith('/api/command?')
      ? failure === 'failed' ? { status: 503, body: { error: 'catalog unavailable' } } : { status: 200, body: { unexpected: [] } } : base(name, input));
    const page = await pageFixture(); page.owners[0].owner.setDraftText('/compact'); (page.find('send').props.onPress as () => void)(); await flush();
    expect(receipt).toBeDefined(); const state = await import('./state'), api = await import('./new-session'), chat = state.createChat(receipt!.receipt.target); await chat.draftReady; await flush();
    await expect(api.sendNewSessionHandoff(chat, receipt!.receipt)).rejects.toThrow();
    expect(chat.pendingSend()?.command?.name).toBe('compact'); expect(chat.pendingSend()?.uncertain).toBe(false);
    expect(requests().filter(request => request.path === '/api/session')).toHaveLength(1);
    expect(requests().filter(request => request.method === 'POST' && (request.path.includes('/prompt?') || request.path.includes('/command?') || request.path.includes('/compact?')))).toEqual([]);
    page.unmount();
  });
  it('new-draft compact follows Web skill-before-command resolution using the existing native skill attachment', async () => {
    const base = harness.call.getMockImplementation()!;
    harness.call.mockImplementation(async (name, input) => {
      if (name === 'runtime.request' && input.path.startsWith('/api/skill?')) return { status: 200, body: [{ id: 'skill-compact', name: 'compact' }] };
      if (name === 'runtime.request' && input.path.startsWith('/api/command?')) return { status: 200, body: [{ name: 'compact', isBuiltIn: true }] };
      return base(name, input);
    });
    const page = await pageFixture(); page.owners[0].owner.setDraftText('/compact topic'); (page.find('send').props.onPress as () => void)(); await flush();
    const state = await import('./state'), api = await import('./new-session'), chat = state.createChat(receipt!.receipt.target); await chat.draftReady; await flush();
    expect(await api.sendNewSessionHandoff(chat, receipt!.receipt)).toBe(true);
    const prompt = requests().find(request => request.path.includes('/prompt?'));
    expect(prompt.body.text).toBe('[skill:skill-compact] topic'); expect(prompt.body.skills).toEqual([{ id: 'skill-compact' }]);
    expect(requests().some(request => request.method === 'POST' && (request.path.includes('/command?') || request.path.includes('/compact?')))).toBe(false); page.unmount();
  });
  it('retained production candidate callback rejects a same-Host same-text ABA operation', async () => {
    const page = await pageFixture();
    const owner = page.owners[0].owner;
    owner.setDraftText('/m'); const previous = owner.operation()!;
    const context = { owner: previous, scope: owner.durable.scope, query: 'm', text: '/m', start: 0, end: 2, editing: true };
    expect(owner.replaceOperation({ ...previous, generation: previous.generation + 1 })).toBe(true);
    expect(page.commandPorts[0].chooseCommand?.({ id: 'yuri:model', name: 'model', source: 'yuri' }, true, context)).toBe(false);
    expect(owner.durable.draft()).toBe('/m'); expect(page.render().some(node => node.type === 'Dialog')).toBe(false);
    expect(requests()).toEqual([]); page.unmount();
  });
  it('200 actual onChange callbacks do no session create, sync Storage or global catalog scans', async () => {
    const page = await pageFixture(), { app } = await import('./state'); let scans = 0;
    app.projects.set(new Proxy(Array.from({ length: 300 }, (_, index) => ({ ...project, id: `${index}` })), { get(array, key, receiver) { if (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key)) scans++; return Reflect.get(array, key, receiver); } }));
    harness.get.mockClear(); harness.set.mockClear(); page.uiRequest.mockClear(); const change = page.find('new-session-composer').props.onChange as (event: { value: string }) => void;
    for (let index = 0; index < 200; index++) change({ value: `draft ${index}` });
    expect(page.owners[0]!.owner.durable.draft()).toBe('draft 199'); expect(requests()).toEqual([]); expect(scans).toBe(0); expect(harness.get).not.toHaveBeenCalled(); expect(harness.set).not.toHaveBeenCalled();
    expect(page.uiRequest).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(300); expect(harness.set).toHaveBeenCalledTimes(1); expect(requests()).toEqual([]); expect(page.uiRequest).not.toHaveBeenCalled(); page.unmount();
  });
  it('page send callback transfers its real owner, surviving unmount through actual Chat admission', async () => {
    const page = await pageFixture(); (page.find('new-session-composer').props.onChange as (event: { value: string }) => void)({ value: 'actual page send' });
    (page.find('send').props.onPress as () => void)(); await flush(); expect(receipt).toBeDefined();
    expect(requests().filter(request => request.path === '/api/session')).toHaveLength(1); page.unmount(); expect(receipt!.released()).toBe(false);
    const state = await import('./state'), api = await import('./new-session'), chat = state.createChat(receipt!.receipt.target); await chat.draftReady; await flush();
    expect(await api.sendNewSessionHandoff(chat, receipt!.receipt)).toBe(true); await receipt!.owner.complete(receipt!.receipt); expect(receipt!.owner.durable.draft()).toBe('');
  });
  it('native header owns Back and inactive page callbacks cannot edit or create', async () => {
    const page = await pageFixture(); expect(page.root.type).toBe('NavPage'); expect(page.root.props.headerLeft).toBeUndefined(); expect(page.root.props.popOnBack).toBeUndefined();
    page.active.set(false); (page.find('new-session-composer').props.onChange as (event: { value: string }) => void)({ value: 'stale' }); (page.find('send').props.onPress as () => void)(); await flush();
    expect(page.owners[0]!.owner.durable.draft()).toBe(''); expect(requests()).toEqual([]);
    (page.root.props.onDismiss as () => void)(); expect(page.onBack).toHaveBeenCalledTimes(1); page.unmount();
  });
});

describe('production page → system sheet native leaf callback boundary (not UIKit)', () => {
  const call = (node: Node, name: string, event?: unknown) => (node.props[name] as (event?: unknown) => void)(event);
  const modalNode = (page: Awaited<ReturnType<typeof pageFixture>>, type: string) => {
    const node = page.render().find(node => node.type === type || typeof node.type === 'function' && node.type.name === type); if (!node) throw new Error(`Missing real modal node: ${type}`); return node;
  };
  const nativeNode = (page: Awaited<ReturnType<typeof pageFixture>>) => modalNode(page, 'yuri.sheet.presentation');
  const opened = (page: Awaited<ReturnType<typeof pageFixture>>, native = nativeNode(page)) => { call(native, 'onOpened', { generation: native.props.generation }); page.runEffects(); };
  const dismissed = (page: Awaited<ReturnType<typeof pageFixture>>, native = nativeNode(page)) => { call(native, 'onDismissed', { generation: native.props.generation, interactive: false }); page.runEffects(); };
  async function openModel() {
    const page = await pageFixture(); call(page.find('new-session-model'), 'onPress'); page.runEffects();
    const dialog = modalNode(page, 'Dialog');
    const models = modalNode(page, 'Models');
    expect((models.props.active as () => boolean)()).toBe(false);
    expect(dialog.props).toMatchObject({ open: true, presentation: 'pageSheet', closeOnSwipe: false, closeOnBackdropPress: false, closeOnEscape: false });
    const native = nativeNode(page); expect(native.props.detents).toEqual([.72, .98]); expect(native.props.dismissible).toBe(true);
    opened(page, native); const sheet = modalNode(page, 'NativeSheet');
    return { page, dialog, sheet, native, models };
  }
  it('real Agent long-press → select-close → Model open repeats without any public Dialog.onClose', async () => {
    const page = await pageFixture();
    call(page.find('new-session-agent'), 'onPressDown'); await vi.advanceTimersByTimeAsync(650);
    call(page.find('new-session-agent'), 'onPressUp'); page.runEffects();
    let mode = 'agent';
    for (let generation = 1; generation <= 4; generation++) {
      const dialog = modalNode(page, 'Dialog'), native = nativeNode(page);
      opened(page, native); const sheet = modalNode(page, 'NativeSheet');
      const models = modalNode(page, 'Models'); expect(models.props.mode).toBe(mode);
      call(models, 'onDone'); page.runEffects();
      expect(sheet.props.open).toBe(false); expect((models.props.active as () => boolean)()).toBe(false);
      expect(page.nativeCommand).toHaveBeenCalledWith('dismiss', { generation: native.props.generation });
      expect(modalNode(page, 'Dialog')).toBe(dialog);
      // Model tap may queue while UIKit is dismissing. Public Dialog.onClose
      // deliberately never fires: reproduce the native Delete-path contract.
      call(page.find('new-session-model'), 'onPress'); page.runEffects();
      call(native, 'onDismissed', { generation: 999, interactive: false }); expect(modalNode(page, 'Dialog')).toBe(dialog);
      dismissed(page, native);
      call(models, 'onDone'); dismissed(page, native);
      expect(modalNode(page, 'Dialog')).not.toBe(dialog); mode = 'model';
    }
    expect(page.onBack).not.toHaveBeenCalled(); expect(requests()).toEqual([]); page.unmount();
  });
  it('retains original picker mode through exit, keeps one system sheet and ignores old selection/cancel callbacks after reopening', async () => {
    const { page, dialog, sheet, native, models } = await openModel();
    expect(models.props.mode).toBe('model'); expect((models.props.active as () => boolean)()).toBe(true);
    call(models, 'onDone'); page.runEffects();
    expect((models.props.active as () => boolean)()).toBe(false);
    expect(modalNode(page, 'Models')).toBe(models); expect(sheet.props.open).toBe(false); expect(dialog.props.open).toBe(true);
    call(page.find('new-session-project'), 'onPress'); page.runEffects();
    expect(modalNode(page, 'Models').props.mode).toBe('model');
    expect(dialog.props.open).toBe(true); expect(page.nativeCommand).toHaveBeenCalledWith('dismiss', { generation: native.props.generation });
    expect(dialog.props.onClose).toBeUndefined();
    dismissed(page, native); const next = modalNode(page, 'Dialog'); expect(next).not.toBe(dialog);
    opened(page); const nextSheet = modalNode(page, 'NativeSheet');
    expect(page.find('new-session-directory')).toBeDefined();
    call(models, 'onDone'); call(dialog, 'onCancel'); dismissed(page, native); call(sheet, 'onOpenChange', { open: false }); page.runEffects();
    expect(next.props.open).toBe(true); expect(nextSheet.props.open).toBe(true);
    expect(page.render().filter(node => node.type === 'Dialog')).toHaveLength(1);
    expect(page.render().filter(node => node.props.backdropClass !== undefined)).toHaveLength(0);
    expect(next.props.presentation).toBe('pageSheet'); expect(nativeNode(page).props.detents).toEqual([.5, 1]);
    expect(page.root.type).toBe('NavPage'); expect(page.onBack).not.toHaveBeenCalled(); expect(requests()).toEqual([]);
    page.unmount();
  });
  it.each(['inactive', 'background', 'host'] as const)('%s closes through real callbacks and fences retained picker without popping NavPage', async reason => {
    const { page, dialog, sheet, native, models } = await openModel();
    if (reason === 'inactive') page.active.set(false);
    else if (reason === 'background') page.lifecycle.set('background');
    else { const { app } = await import('./state'); app.connection.set({ id: 'another', label: 'Host', url: 'https://other.example', lastUsedAt: 0 }); }
    page.runEffects();
    expect((models.props.active as () => boolean)()).toBe(false); expect(sheet.props.open).toBe(false); expect(dialog.props.open).toBe(true);
    call(models, 'onDone'); dismissed(page, native);
    page.active.set(true); page.lifecycle.set('active'); page.runEffects();
    expect(page.render().some(node => node.type === 'Dialog')).toBe(false);
    expect(page.onBack).not.toHaveBeenCalled(); expect(requests()).toEqual([]); page.unmount();
  });
  it('cleanup requests native dismissal without waiting for a JS timer or restoring stale callbacks', async () => {
    const { page, native, models } = await openModel(); page.unmount();
    expect(page.nativeCommand).toHaveBeenCalledWith('dismiss', { generation: 1 }); expect((models.props.active as () => boolean)()).toBe(false);
    opened(page, native); dismissed(page, native); call(models, 'onDone');
    expect(page.render().some(node => node.type === 'Dialog')).toBe(false); expect(page.onBack).not.toHaveBeenCalled();
  });
  it('project selection retires the old draft partition only after the system sheet reports real native dismissal', async () => {
    const page = await pageFixture(); call(page.find('new-session-project'), 'onPress'); page.runEffects();
    const dialog = modalNode(page, 'Dialog'), native = nativeNode(page); opened(page, native); const sheet = modalNode(page, 'NativeSheet');
    call(page.find('new-session-directory-choose'), 'onPress'); await flush(); page.runEffects();
    expect(page.owners).toHaveLength(1); expect(sheet.props.open).toBe(false); expect(dialog.props.open).toBe(true);
    expect(page.nativeCommand).toHaveBeenCalledWith('dismiss', { generation: native.props.generation }); expect(page.owners).toHaveLength(1);
    expect(dialog.props.onClose).toBeUndefined(); dismissed(page, native); await flush(); page.render(); await flush(); expect(page.owners).toHaveLength(2);
    expect(page.onBack).not.toHaveBeenCalled(); expect(requests()).toEqual([]); page.unmount();
  });
  it('presets uses the same lifecycle and a retained add callback cannot write settings after cancellation', async () => {
    let blockRead = false, release!: (value: unknown) => void;
    const page = await pageFixture((path) => {
      if (path === '/api/config/settings') return blockRead ? new Promise(resolve => { release = resolve; }) : { draftStarters: [] };
      if (path === '/api/fs/home') return { home: '/fixture/home' };
      if (path.startsWith('/api/fs/read?')) return JSON.stringify({ draftStarters: [] });
      if (path.startsWith('/api/config/commands/metadata?')) return { commands: [] };
      if (path.startsWith('/api/config/skills?')) return { skills: [] };
      if (path.startsWith('/api/agent?')) return [];
      if (path.startsWith('/api/config/catalog/providers?')) return { schemaVersion: 1, providers: [] };
      throw new Error(`Unexpected modal route ${path}`);
    });
    call(page.find('new-session-presets-add'), 'onPress'); page.runEffects();
    const dialog = modalNode(page, 'Dialog'), native = nativeNode(page); opened(page, native); const sheet = modalNode(page, 'NativeSheet'); await flush();
    const search = page.find('new-session-presets-search'); call(search, 'onChange', { value: 'weigh' });
    const pin = page.find('new-session-pin-command-weigh'); blockRead = true; call(pin, 'onPress'); await flush();
    call(sheet, 'onOpenChange', { open: false }); page.runEffects();
    expect(page.find('new-session-presets-search')).toBe(search);
    call(search, 'onChange', { value: 'stale edit' }); release({ draftStarters: [] }); await flush();
    expect(page.uiRequest.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
    call(pin, 'onPress'); await flush(); expect(page.uiRequest.mock.calls.some(([, method]) => method === 'PUT')).toBe(false);
    expect(dialog.props.open).toBe(true); dismissed(page, native); expect(page.render().some(node => node.type === 'Dialog')).toBe(false);
    expect(requests()).toEqual([]); page.unmount();
  });
});

describe('production starter touch callbacks → unique NavPage swipe policy (pure, not UIKit)', () => {
  const reviewID = 'new-session-preset-review-accessibility-and-keyboard-navigation';
  const event = (x = 175, y = 489, fingers = 1) => ({ pageX: x, pageY: y, touches: Array.from({ length: fingers }, () => ({})) });
  const call = (node: Node, name: string, value?: unknown) => (node.props[name] as (value?: unknown) => void)(value);
  async function fixture() {
    let settings = { draftStarters: [{ type: 'command', name: 'explore' }, { type: 'command', name: 'weigh' }, { type: 'command', name: 'review-accessibility-and-keyboard-navigation' }] };
    const writes = vi.fn();
    const page = await pageFixture((path, method, body) => {
      if (path === '/api/config/settings') { if (method === 'PUT') { writes(body); settings = { ...settings, ...body as typeof settings }; } return settings; }
      if (path === '/api/fs/home') return { home: '/fixture/home' };
      if (path.startsWith('/api/fs/read?')) return JSON.stringify({ draftStarters: [] });
      if (path.startsWith('/api/config/commands/metadata?')) return { commands: [{ name: 'review-accessibility-and-keyboard-navigation', scope: 'user' }] };
      if (path.startsWith('/api/config/skills?')) return { skills: [] };
      if (path.startsWith('/api/agent?')) return [];
      if (path.startsWith('/api/config/catalog/providers?')) return { schemaVersion: 1, providers: [] };
      throw new Error(`Unexpected UI fixture route: ${method} ${path}`);
    });
    const hasID = (value: unknown, id: string): boolean => Array.isArray(value) ? value.some(child => hasID(child, id))
      : !!value && typeof value === 'object' && 'props' in value && ((value as Node).props.testID === id || hasID((value as Node).children, id));
    const wrapper = (id: string) => {
      const node = page.render().find(node => node.props.onTouchStartCapture && hasID(node.children, id));
      if (!node) throw new Error(`Missing real preset touch wrapper: ${id}`);
      return node;
    };
    // Synthetic measure() rectangles only. All touch/responder callbacks,
    // timers, callback forwarding and the NavPage policy are production code.
    for (const [id, x, y, width] of [
      ['new-session-preset-explore', 20, 425, 90], ['new-session-preset-weigh', 120, 425, 130], [reviewID, 30, 475, 290],
    ] as const) {
      call(wrapper(id), 'ref', { measure: async () => ({ pagePosition: { x, y }, bounds: { size: { width, height: 28 } } }) });
      call(wrapper(id), 'onLayout', { bounds: { origin: { x: x - 20, y: y - 425 }, size: { width, height: 28 } } });
    }
    const trashSlot = page.render().find(node => node.props.ref && !node.props.onTouchStartCapture && hasID(node.children, 'new-session-presets-trash'))!;
    call(trashSlot, 'ref', { measure: async () => ({ pagePosition: { x: 354, y: 382 }, bounds: { size: { width: 24, height: 28 } } }) });
    const layout = page.render().find(node => node.props.onLayout)!;
    call(layout, 'onLayout', { bounds: { size: { width: 350, height: 84 } } });
    call(page.find('new-session-presets-expand'), 'onPress');
    return { page, writes, wrapper, settings: () => settings };
  }
  it('blocks swipe from touch-down, publishes drag at exactly 200ms, deletes up/right on release and restores swipe without submitting', async () => {
    const { page, wrapper, writes, settings } = await fixture(), source = wrapper(reviewID);
    expect(page.root.props.popOnSwipe).toBe(true);
    call(source, 'onTouchStartCapture', event());
    expect(page.root.props.popOnSwipe).toBe(false);
    call(page.find(reviewID), 'onPressDown');
    await vi.advanceTimersByTimeAsync(199);
    expect(page.render().some(node => node.props.testID === 'new-session-presets-trash')).toBe(false);
    expect(page.root.props.popOnSwipe).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(page.find('new-session-presets-trash').type).toBe('View');
    expect((source.props.onMoveShouldSetResponderCapture as () => boolean)()).toBe(true);
    expect(page.root.props.popOnSwipe).toBe(false);
    call(source, 'onResponderMove', event(366, 396));
    expect(writes).not.toHaveBeenCalled();
    call(source, 'onResponderRelease');
    expect(page.root.props.popOnSwipe).toBe(true);
    call(source, 'onTouchEndCapture');
    call(page.find(reviewID), 'onPress');
    await flush();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(settings().draftStarters.map(ref => ref.name)).toEqual(['explore', 'weigh']);
    expect(requests()).toEqual([]); expect(page.onBack).not.toHaveBeenCalled();
    expect(page.root.props.headerLeft).toBeUndefined(); expect(page.root.props.popOnBack).toBeUndefined();
    page.unmount();
  });
  it.each(['touchCancel', 'responderTerminate', 'multiMove', 'multiStart', 'inactive', 'keyboardHidden', 'background', 'unmount'] as const)('%s restores swipe and never commits or resurrects a drag', async reason => {
    const { page, wrapper, writes } = await fixture(), source = wrapper(reviewID);
    call(source, 'onTouchStartCapture', event()); await vi.advanceTimersByTimeAsync(200);
    expect(page.root.props.popOnSwipe).toBe(false); expect(page.find('new-session-presets-trash')).toBeDefined();
    if (reason === 'touchCancel') call(source, 'onTouchCancel');
    else if (reason === 'responderTerminate') call(source, 'onResponderTerminate');
    else if (reason === 'multiMove') call(source, 'onTouchMoveCapture', event(180, 489, 2));
    else if (reason === 'multiStart') call(source, 'onTouchStartCapture', event(175, 489, 2));
    else if (reason === 'inactive') { page.active.set(false); page.runEffects(); page.active.set(true); }
    else if (reason === 'keyboardHidden') { page.keyboardHeight.set(300); page.runEffects(); page.keyboardHeight.set(0); }
    else if (reason === 'background') { page.lifecycle.set('background'); page.runEffects(); page.lifecycle.set('active'); }
    else page.unmount();
    expect(page.root.props.popOnSwipe).toBe(true);
    expect((source.props.onMoveShouldSetResponderCapture as () => boolean)()).toBe(false);
    call(source, 'onTouchEndCapture'); await vi.advanceTimersByTimeAsync(300);
    expect(page.root.props.popOnSwipe).toBe(true); expect(writes).not.toHaveBeenCalled(); expect(page.onBack).not.toHaveBeenCalled();
    page.unmount();
  });
  it('releases a short hold or pre-activation move and preserves the draft through ordinary native dismiss/reopen', async () => {
    const { page, wrapper, writes } = await fixture(), source = wrapper(reviewID);
    call(page.find('new-session-composer'), 'onChange', { value: 'Draft survives normal system Back after cancelled drag' });
    call(source, 'onTouchStartCapture', event()); expect(page.root.props.popOnSwipe).toBe(false);
    await vi.advanceTimersByTimeAsync(100); call(source, 'onTouchEndCapture'); expect(page.root.props.popOnSwipe).toBe(true);
    call(source, 'onTouchStartCapture', event()); call(source, 'onTouchMoveCapture', event(182, 489));
    expect(page.root.props.popOnSwipe).toBe(true);
    await vi.advanceTimersByTimeAsync(300); expect((source.props.onMoveShouldSetResponderCapture as () => boolean)()).toBe(false);
    expect(writes).not.toHaveBeenCalled(); expect(page.root.props.popOnBack).toBeUndefined();
    call(page.root, 'onDismiss'); await flush(); page.unmount(); await flush();
    expect(page.onBack).toHaveBeenCalledTimes(1);
    const reopened = await pageFixture();
    expect(reopened.root.props.popOnSwipe).toBe(true);
    expect(reopened.find('new-session-composer').props.value).toBe('Draft survives normal system Back after cancelled drag');
    expect(requests()).toEqual([]); reopened.unmount();
  });
  it('releases the gate on missing/failed geometry and fences a pending measurement after cancellation', async () => {
    const { page, wrapper, writes } = await fixture(), source = wrapper(reviewID);
    call(source, 'ref', { measure: async () => undefined });
    call(source, 'onTouchStartCapture', event()); await vi.advanceTimersByTimeAsync(200); expect(page.root.props.popOnSwipe).toBe(true);
    call(page.find(reviewID), 'onPress'); expect(requests()).toEqual([]);
    call(source, 'ref', { measure: async () => { throw new Error('measure failed'); } });
    call(source, 'onTouchStartCapture', event()); await vi.advanceTimersByTimeAsync(200); expect(page.root.props.popOnSwipe).toBe(true);
    call(page.find(reviewID), 'onPress'); expect(requests()).toEqual([]);
    let resolve!: (value: unknown) => void;
    call(source, 'ref', { measure: () => new Promise(done => { resolve = done; }) });
    call(source, 'onTouchStartCapture', event()); await vi.advanceTimersByTimeAsync(200);
    expect(page.root.props.popOnSwipe).toBe(false); call(source, 'onTouchCancel'); expect(page.root.props.popOnSwipe).toBe(true);
    call(source, 'ref', { measure: async () => ({ pagePosition: { x: 30, y: 475 }, bounds: { size: { width: 290, height: 28 } } }) });
    call(source, 'onTouchStartCapture', event());
    resolve({ pagePosition: { x: 30, y: 475 }, bounds: { size: { width: 290, height: 28 } } }); await flush();
    expect(page.root.props.popOnSwipe).toBe(false); expect((source.props.onMoveShouldSetResponderCapture as () => boolean)()).toBe(false);
    await vi.advanceTimersByTimeAsync(200); expect((source.props.onMoveShouldSetResponderCapture as () => boolean)()).toBe(true);
    call(source, 'onTouchCancel'); expect(page.root.props.popOnSwipe).toBe(true);
    expect(writes).not.toHaveBeenCalled(); page.unmount();
  });
});
