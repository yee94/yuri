import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NativeNewSessionPageHandoff } from './new-session';
import { StrictWriterHost } from './desktop-writer-test-host';
import type { RuntimeScope } from './runtime-scope';

const h = vi.hoisted(() => ({ call: vi.fn(), alert: vi.fn(), storage: new Map<string, string>(), cleanups: [] as Array<() => void>, effects: [] as Array<() => void>, keys: [] as Array<Record<string, () => void>>, stops: [] as Array<() => void> }));
vi.mock('nsh/base', () => ({ AlertDialog: { show: h.alert } }));
vi.mock('nsh', () => ({
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(), computed: <T>(work: () => T) => work,
  signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; }, update: (work: (previous: T) => T) => { value = work(value); } }); },
  cleanup: (work: () => void) => h.cleanups.push(work), effect: (work: () => void | (() => void)) => { h.effects.push(work); const stop = work(); if (stop) h.stops.push(stop); },
  lifecycle: () => 'active', locale: () => 'en', platform: { os: 'macos', desktop: true },
  token: (key: string) => key,
  keymap: { bind: (keys: Record<string, () => void>) => { h.keys.push(keys); return () => { const index = h.keys.indexOf(keys); if (index >= 0) h.keys.splice(index, 1); }; } },
  Storage: { getItem: async (key: string) => h.storage.get(key) ?? null, setItem: async (key: string, value: string) => { h.storage.set(key, value); } },
  host: { available: () => true, call: h.call, on: () => () => {} },
}));
type Node = { type: string | ((props: Record<string, unknown>) => unknown); props: Record<string, unknown>; children: unknown[] };
const flush = async () => { for (let index = 0; index < 180; index++) await Promise.resolve(); };
const project = { id: 'p', name: 'Project', path: '/repo' };
let handoff: NativeNewSessionPageHandoff | undefined, authority: Record<string, unknown>, inbox: unknown[], handle: (path: string, method: string, body: Record<string, unknown>) => unknown;
const requests = () => h.call.mock.calls.filter(([name]) => name === 'runtime.request').map(([, input]) => input as { path: string; method: string; body: Record<string, unknown> });
const creates = () => requests().filter(input => input.path === '/api/session' && input.method === 'POST');
const prompts = () => requests().filter(input => input.path.includes('/prompt?'));
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); h.storage.clear(); h.cleanups = []; h.effects = []; h.keys = []; h.stops = []; handoff = undefined; authority = { id: 'created', location: { directory: '/repo' } }; inbox = [];
  h.alert.mockReset().mockResolvedValue({ action: 'cancel' });
  handle = (path, method, body) => {
    if (path.startsWith('/api/fs/list?')) return { path: '/repo', entries: [] };
    if (path === '/api/session' && method === 'POST') return authority;
    if (path.startsWith('/api/session/created?') && method === 'GET') return { ...authority };
    if (path.includes('/model?') && method === 'POST') { authority.model = body.model; return null; }
    if (path.includes('/agent?') && method === 'POST') { authority.agent = body.agent; return null; }
    if (path.includes('/prompt?') && method === 'POST') { const row = { id: body.id, sessionID: 'created', type: 'user', payload: { text: body.text } }; inbox.push(row); return row; }
    if (path.includes('/inbox?')) return inbox;
    if (path.includes('/message?')) return { data: [], complete: true };
    if (path.includes('/message/')) return null;
    if (path === '/api/session/active') return {};
    if (path === '/api/voice/settings') return { dictationEnabled: false };
    if (path.includes('/permission/request?') || path.includes('/form?')) return [];
    if (path === '/api/magic-prompts') return { version: 1, overrides: { 'session.explore.visible': 'captured visible', 'session.explore.instructions': 'captured instructions' } };
    if (path.startsWith('/api/command?')) return [{ name: 'explore' }, { name: 'compact' }, { name: 'fork' }, { name: 'custom' }, { name: 'init' }, { name: 'reload' }];
    throw new Error(`Unexpected strict fake Host request ${method} ${path}`);
  };
  const writerHost: Omit<StrictWriterHost, 'scope'> & { scope: RuntimeScope } = new StrictWriterHost(); writerHost.scope = { hostID: 'one', lease: 'test-lease' };
  h.call.mockReset().mockImplementation(async (name, input, options) => {
    if (name.startsWith('desktop.writer.')) return writerHost.call(name, input, options);
    if (name === 'connection.list') return { selected: 'one', connections: [{ id: 'one', label: 'Host', url: 'https://host.example', lastUsedAt: 0 }], runtimeScope: { hostID: 'one', lease: 'test-lease' } };
    if (name === 'runtime.request') return { status: 200, body: await handle(input.path, input.method, input.body ?? {}) };
    if (name === 'runtime.stream' || name === 'runtime.stop') return true;
    throw new Error(`Unexpected native API ${name}`);
  });
  await (await import('./state')).loadConnections();
});
afterEach(async () => { h.stops.forEach(stop => stop()); h.cleanups.splice(0).forEach(stop => stop()); await handoff?.release().catch(() => {}); await flush(); vi.useRealTimers(); });

/** Runs the actual page, registry, native keyboard adapter and writer; leaf layout is not a native-engine claim. */
async function page() {
  const nsh = await import('nsh'), writer = await import('./new-session'), adapter = await import('./new-session-local-commands');
  const owners: ReturnType<typeof writer.createNativeNewSessionOwnership>[] = [], locals: ReturnType<typeof adapter.createNativeNewSessionLocalCommands>[] = [];
  let active = true;
  const jsx = (type: Node['type'], props: Node['props'] | null, ...children: unknown[]): Node => {
    const observed = { ...props };
    for (const key of ['when', 'of', 'each', 'value', 'readonly', 'disabled', 'catalog', 'commands', 'selectedRange', 'hasContent', 'inFlight']) if (typeof observed[key] === 'function') Object.defineProperty(observed, key, { get: observed[key] as () => unknown });
    if (typeof type === 'function' && children.length) observed.children = children[0];
    return { type, props: observed, children };
  };
  const native = { ...nsh, View: 'View', Text: 'Text', Scroll: 'Scroll', Overlay: 'Overlay', List: 'List', token: (key: string) => key,
    Keyboard: { dismiss: () => {} }, Speech: { available: async () => false }, keyboardFrame: () => ({ height: 0 }), safeArea: () => ({ top: 0, bottom: 0 }), windowSize: () => ({ width: 1200, height: 800 }) };
  const imports: Record<string, unknown> = {
    nsh: native, 'nsh/base': { Button: 'Button', Input: 'Input', NavPage: 'NavPage' }, './appearance': { nativeChatTextStyle: () => ({}) },
    './chat-identity': { NativeAgentAvatar: 'Avatar', NativeModelLogo: 'Logo', nativeAgentAccent: () => 'foreground' }, './chat-models-helpers': await import('./chat-models-helpers'),
    './composer-surface': await import('./composer-surface'), './composer-commands-model': await import('./composer-commands-model'),
    './composer-reference-keyboard-native': await import('./composer-reference-keyboard-native'), './composer-references-controls': { NativeReferencePicker: 'ReferencePicker', NativeAutocompleteRowText: 'RowText' },
    './composer-references-presentation': await import('./composer-references-presentation'), './composer-send': { NativeComposerSend: (props: Node['props']) => jsx('Button', { ...props, testID: 'send' }) },
    './Icon': { Icon: 'Icon' }, './i18n': await import('./i18n'), './model': await import('./model'),
    './new-session': { ...writer, createNativeNewSessionOwnership: (...args: Parameters<typeof writer.createNativeNewSessionOwnership>) => { const owner = writer.createNativeNewSessionOwnership(...args); owners.push(owner); return owner; } },
    './new-session-local-commands': { ...adapter, createNativeNewSessionLocalCommands: (...args: Parameters<typeof adapter.createNativeNewSessionLocalCommands>) => { const local = adapter.createNativeNewSessionLocalCommands(...args); locals.push(local); return local; } },
    './new-session-copy': await import('./new-session-copy'), './new-session-models': { NativeNewSessionModels: 'Models' }, './new-session-modal': { NativeNewSessionModal: 'Modal' }, './new-session-native-owners': { NativeNewSessionInputAX: 'AX' },
    './runtime': await import('./runtime'), './state': await import('./state'), '../ui/src/components/chat/mobileControlsUtils': await import('../ui/src/components/chat/mobileControlsUtils'),
    '../ui/src/lib/touch-gestures/tap': await import('../ui/src/lib/touch-gestures/tap'), './new-session-selection': await import('./new-session-selection'), './desktop-composer-actions': await import('./desktop-composer-actions'),
    './new-session-ui-helpers': await import('./new-session-ui-helpers'), './desktop-attachments': await import('./desktop-attachments'), './desktop-attachments-recovery': await import('./desktop-attachments-recovery'),
    './page-operations': await import('./page-operations'), './new-session-writer': await import('./new-session-writer'),
    './new-session-directory': await import('./new-session-directory'),
  };
  const observe: ts.TransformerFactory<ts.SourceFile> = context => root => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && ['when', 'of', 'each', 'value', 'readonly', 'disabled', 'catalog', 'commands', 'selectedRange', 'hasContent', 'inFlight'].includes(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), ts.visitNode(node.initializer.expression, visit) as ts.Expression)));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  };
  const load = (name: string) => {
    const source = readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'jsx', jsxFragmentFactory: 'Fragment' }, transformers: { before: [observe] } }).outputText;
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(output, { exports, require: (id: string) => { if (!(id in imports)) throw new Error(`Unmocked actual page module ${id}`); return imports[id]; }, jsx, Fragment: 'Fragment', If: 'If', Each: 'Each', console, Promise, Error, setTimeout, clearTimeout }, { filename: name });
    return exports;
  };
  imports['./composer-controls'] = load('./composer-controls.tsx');
  const exports = load('./new-session-page.tsx');
  const { loadDesktopWriterClient } = await import('./desktop-writer-core');
  const writerSource = { available: () => true, call: h.call };
  const desktopWriter = await loadDesktopWriterClient({ source: () => writerSource, current: () => true });
  const root = (exports.NativeNewSessionPage as (props: Record<string, unknown>) => Node)({ project, desktopWriter: () => desktopWriter, get active() { return active; }, onOpenChat: (_target: unknown, value: NativeNewSessionPageHandoff) => { handoff = value; } });
  const instances = new WeakMap<Node, unknown>(), each = new WeakMap<Node, Map<unknown, unknown>>();
  const leaves = new Set(['NativeNewSessionAgent', 'NativeNewSessionStarters', 'NewSessionBranchSelector']);
  function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object' || !('type' in value)) return [];
    const node = value as Node;
    if (typeof node.type === 'function') {
      if (leaves.has(node.type.name)) return [];
      if (!instances.has(node)) instances.set(node, node.type(node.props));
      return nodes(instances.get(node));
    }
    if (node.type === 'If') return nodes(node.props.when ? node.children : node.props.else);
    if (node.type === 'Each' || node.type === 'List') {
      const child = node.children[0] as (item: () => unknown) => unknown;
      let items = each.get(node); if (!items) { items = new Map(); each.set(node, items); }
      return ((node.props.of ?? node.props.each ?? []) as unknown[]).flatMap(item => { if (!items.has(item)) items.set(item, child(() => item)); return nodes(items.get(item)); });
    }
    return [node, ...nodes(node.children)];
  }
  const render = () => nodes(root), find = (id: string) => { const node = render().find(node => node.props.testID === id); if (!node) throw new Error(`Missing actual page node ${id}`); return node; };
  render(); await flush(); render(); await owners[0]!.owner.ready; await flush();
  (find('new-session-composer-glass').props.ref as (node: unknown) => void)({});
  const input = find('new-session-composer');
  (input.props.ref as (node: unknown) => void)({ focus: () => (input.props.onFocus as () => void)(), setSelection: (start: number) => (input.props.onSelectionChange as (range: unknown) => void)({ start, end: start }) });
  return { owners, locals, find, render, currentOwner: () => owners.at(-1)!.owner, hide: () => { active = false; },
    change: (value: string) => (find('new-session-composer').props.onChange as (event: { value: string }) => void)({ value }),
    pressSend: () => (find('send').props.onPress as () => void)(),
    focus: () => (find('new-session-composer').props.onFocus as () => void)(),
    select: (start: number, end = start) => (find('new-session-composer').props.onSelectionChange as (range: unknown) => void)({ start, end }),
    compose: (composing: boolean) => (find('new-session-composer').props.onCompositionChange as (event: unknown) => void)({ composing }),
    enter: () => (find('new-session-composer').props.onSubmit as () => void)(),
    refresh: async () => { render(); [...h.effects].forEach(work => work()); await flush(); render(); [...h.effects].forEach(work => work()); await flush(); },
  };
}

describe('desktop actual new-session page local command boundary', () => {
  it('magic follows real owner transfer and createNewSessionAdmission without consuming source resources or a second create', async () => {
    const p = await page(); p.change('/explore idea'); const owner = p.currentOwner();
    owner.setAttachments([{ uri: 'attachment://keep', name: 'keep', mime: 'text/plain' }]); owner.durable.context.set({ kind: 'checks', instructionsText: 'keep', payloadText: '{}' });
    await owner.select({ agent: 'build', model: { providerID: 'p', id: 'm', variant: 'high' } });
    const original = owner.durable.document(); p.pressSend(); await flush(); expect(handoff).toBeDefined(); expect(creates()).toHaveLength(1); expect(prompts()).toEqual([]);
    const { createChat } = await import('./state'); const dependencies = { draftAuthorityKey: handoff!.receipt.draftAuthorityKey, writerGrant: handoff!.desktopWriter!.grant }; const chat = createChat(handoff!.receipt.target, dependencies); await chat.draftReady; await flush();
    const { createNewSessionAdmission } = await import('./new-session-admission'); const states: string[] = [];
    const admission = createNewSessionAdmission({ chat, handoff: handoff!, current: () => true, changed: state => states.push(state) }); await admission.run();
    expect(states.at(-1)).toBe('complete'); expect(prompts()).toHaveLength(1); expect(prompts()[0]!.body).toMatchObject({ text: 'captured visible\ncaptured instructions', delivery: 'steer' });
    expect(prompts()[0]!.body.files).toBeUndefined(); expect(prompts()[0]!.body.skills).toBeUndefined(); expect(creates()).toHaveLength(1);
    expect(owner.durable.document()).toEqual(original); expect(owner.durable.attachments()).toHaveLength(1); expect(owner.durable.context()?.instructionsText).toBe('keep');
  });
  it.each(['compact', 'fork', 'undo', 'redo', 'timeline', 'summary', 'btw'])('typed /%s is claimed and never falls back to a same-name Host command/create', async command => {
    const p = await page(); p.change(`/${command}`); p.pressSend(); await flush();
    expect(creates()).toEqual([]); expect(prompts()).toEqual([]); expect(handoff).toBeUndefined(); expect(p.currentOwner().durable.draft()).toBe(`/${command}`);
  });
  it('desktop /model preserves the full document and opens the actual model modal slot', async () => {
    const p = await page(); p.change('/model keep this tail'); p.pressSend(); await flush();
    expect(p.currentOwner().durable.draft()).toBe('/model keep this tail'); expect(p.render().find(node => node.type === 'Modal')?.props.value).toBe('model'); expect(creates()).toEqual([]);
  });
  it('new with a tail asks native confirmation, Cancel preserves input and confirm routes through the real draft owner', async () => {
    const p = await page(); p.currentOwner().setAttachments([{ uri: 'attachment://keep', name: 'keep', mime: 'text/plain' }]);
    p.currentOwner().durable.context.set({ kind: 'checks', instructionsText: 'preserved context', payloadText: '{}' });
    p.change('/new keep this tail'); p.pressSend(); await flush();
    expect(h.alert).toHaveBeenCalledOnce(); expect(p.currentOwner().durable.draft()).toBe('/new keep this tail'); expect(p.owners).toHaveLength(1);
    h.alert.mockResolvedValue({ action: 'discard' }); p.pressSend(); await flush(); p.render(); await flush();
    expect(p.owners).toHaveLength(1); expect(p.currentOwner().durable.draft()).toBe(''); expect(p.currentOwner().durable.attachments()).toHaveLength(1); expect(p.currentOwner().durable.context()?.instructionsText).toBe('preserved context'); expect(creates()).toEqual([]);
  });
  it('compile-time document ABA and unknown creation never navigate or replay', async () => {
    const p = await page(); let release!: (value: unknown) => void; const gate = new Promise(resolve => { release = resolve; }), normal = handle;
    handle = (path, method, body) => path === '/api/magic-prompts' ? gate : normal(path, method, body);
    p.change('/explore'); p.pressSend(); await flush(); p.change('new edit'); p.change('/explore'); release({ version: 1, overrides: {} }); await flush();
    expect(creates()).toEqual([]); expect(handoff).toBeUndefined(); expect(p.currentOwner().durable.draft()).toBe('/explore');
    handle = (path, method, body) => { if (path === '/api/session') throw new Error('private lost receipt'); return normal(path, method, body); };
    p.pressSend(); await flush(); expect(creates()).toHaveLength(1); expect(handoff).toBeUndefined(); expect(p.currentOwner().creationUnknown()).toBe(true);
    p.pressSend(); await flush(); expect(creates()).toHaveLength(1); expect(handoff).toBeUndefined();
  });
  it('actual Input IME/selection fences suppress suggestions, Tab inserts only, and magic needs explicit submission', async () => {
    const p = await page(); p.focus(); p.change('/expl'); p.select(5); await p.refresh();
    expect(p.render().some(node => node.props.testID === 'command-explore')).toBe(true);
    p.compose(true); p.enter(); p.pressSend(); await flush(); expect(creates()).toEqual([]); expect(p.currentOwner().durable.draft()).toBe('/expl');
    p.compose(false); p.select(1, 5); await p.refresh(); expect(p.render().some(node => node.props.testID === 'command-explore')).toBe(false);
    p.select(5); await p.refresh(); h.keys.at(-1)?.tab?.(); await p.refresh();
    expect(p.currentOwner().durable.draft()).toBe('/explore '); expect(creates()).toEqual([]);
    p.enter(); await flush(); expect(creates()).toHaveLength(1); expect(handoff).toBeDefined();
  });
  it('one registry survives 50 edits and closed/open/closed pickers with no global catalog/history scans', async () => {
    const p = await page(), { app } = await import('./state'); let scans = 0;
    const guarded = <T>(rows: T[]) => new Proxy(rows, { get(array, key, receiver) { if (key === Symbol.iterator || typeof key === 'string' && /^\d+$/.test(key)) scans++; return Reflect.get(array, key, receiver); } });
    app.projects.set(guarded(Array.from({ length: 300 }, (_, index) => ({ ...project, id: String(index) })))); app.sessions.set(guarded([]));
    const before = requests().length;
    for (let index = 0; index < 50; index++) { p.change(`draft ${index}`); p.locals[0]!.readSnapshot(); }
    expect(p.locals).toHaveLength(1); expect(scans).toBe(0); expect(requests()).toHaveLength(before);
    p.focus(); p.change('/mod'); p.select(4); await p.refresh(); p.select(0, 4); await p.refresh(); const after = requests().length;
    for (let index = 0; index < 50; index++) { p.change(`after dismissal ${index}`); p.locals[0]!.readSnapshot(); }
    expect(p.locals).toHaveLength(1); expect(scans).toBe(0); expect(requests()).toHaveLength(after); expect(creates()).toEqual([]);
  });
  it.each(['goal keep native semantics', 'init', 'reload', 'auth'])('/%s is not promoted into the local registry on a draft', async command => {
    const p = await page(); p.change(`/${command}`);
    expect(p.locals[0]!.trySubmit()).toBe(false); expect(p.currentOwner().durable.draft()).toBe(`/${command}`); expect(creates()).toEqual([]);
  });
  it('late confirmation cannot discard a newer document, and references are blocked without consuming any resource', async () => {
    const p = await page(); let release!: (value: unknown) => void;
    h.alert.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    p.change('/new old tail'); p.pressSend(); await flush(); p.change('/new new tail'); release({ action: 'discard' }); await flush(); p.render();
    expect(p.owners).toHaveLength(1); expect(p.currentOwner().durable.draft()).toBe('/new new tail');
    p.change('/explore '); p.currentOwner().insertReference({ kind: 'skill', value: 'keep', label: 'Keep' }); const before = p.currentOwner().durable.document();
    p.pressSend(); await flush(); expect(p.currentOwner().durable.document()).toEqual(before); expect(creates()).toEqual([]); expect(handoff).toBeUndefined();
  });
});
