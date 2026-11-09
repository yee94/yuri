import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as core from './assistants-core';
import * as model from './model';
import { createAssistantSwipe } from './assistants-swipe-core';
import { instrumentAssistantPage, instrumentListRow } from './tests/assistants-list-pointer/instrument.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
type Props = Record<string, unknown>;
type Node = { type: string | ((props: Props) => unknown); props: Props; children: Array<() => unknown> };
type Entry = { bot: model.Row; pinned: boolean };
type Pan = Record<string, (...args: unknown[]) => unknown>;

/** Node/VM component seam only: NSH lazy JSX props and one children call per
 * recycled cell; no engine, device, Host, layout or native gesture evidence. */
function fixture(instrument = false) {
  const trace: string[] = [];
  const pending = new Set<() => void>(), cleanups: Array<() => void> = [];
  let tracking: (() => void) | undefined;
  const signal = <T>(initial: T) => {
    let value = initial;
    const listeners = new Set<() => void>();
    return Object.assign(() => { if (tracking) listeners.add(tracking); return value; }, {
      set(next: T) { if (Object.is(value, next)) return; value = next; listeners.forEach(work => pending.add(work)); },
    });
  };
  const effect = (work: () => void) => {
    const run = () => { const prior = tracking; tracking = run; try { work(); } finally { tracking = prior; } };
    run();
  };
  const computed = <T>(read: () => T) => {
    const value = signal<T>(undefined as T);
    effect(() => value.set(read()));
    return value;
  };
  const untracked = <T>(work: () => T) => { const prior = tracking; tracking = undefined; try { return work(); } finally { tracking = prior; } };
  const tick = () => {
    for (let i = 0; pending.size; i++) {
      if (i > 100) throw new Error('Reactive fixture did not settle');
      const batch = [...pending]; pending.clear(); batch.forEach(work => work());
    }
  };
  const settle = async () => { for (let i = 0; i < 30; i++) { await Promise.resolve(); tick(); } };
  const app = { bots: signal<model.Row[]>([]), tab: signal(1) }, generation = signal(1), active = signal(true);
  const opened = vi.fn(), edited = vi.fn(), requests: Array<{ path: string; method: string; body: unknown }> = [];
  const dialogs: Array<{ title: string; actions: Array<{ id: string }> }> = [];
  let answer = 'cancel', revision = 1, seed: model.Row[] = [];
  const wire = async (resource: string, method = 'GET', body?: unknown) => {
    requests.push({ path: resource, method, body });
    if (resource.endsWith('/capability')) return { supported: true, enabled: true };
    if (resource.endsWith('/snapshot')) return { revision, enabled: true, assistants: seed };
    if (method === 'DELETE') return { assistantID: decodeURIComponent(resource.split('/').at(-1)!), tombstoneAt: 10 };
    throw new Error('Unexpected request ' + resource);
  };
  const operation = { current: () => active(), request: wire };
  const jsx = (type: Node['type'], props: Props | null, ...children: Node['children']): Node => ({ type, props: props ?? {}, children });
  // Same lazy-prop VM precedent as resource-html-viewer.test.ts. Mounting below
  // retains component instances instead of rerunning List.children on reads.
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
    nsh: { signal, computed, effect, untracked, cleanup: (work: () => void) => cleanups.push(work),
      host: { on: () => () => {} }, lifecycle: () => 'active', List: 'List', Text: 'Text', View: 'View',
      PanResponder: { create: (handlers: Pan) => ({ panHandlers: handlers }) } },
    'nsh/base': { Button: 'Button', Input: 'Input', AlertDialog: { show: async (options: typeof dialogs[number]) => { dialogs.push(options); return { action: answer }; } } },
    './appearance': { nativeDensity: () => ({ scale: 1, pages: { assistantCatalog: {} } }) },
    './i18n': { t: (key: string) => key }, './Icon': { Icon: 'Icon' }, './model': model,
    './state': { app, epoch: generation }, './assistants-core': core,
    './assistants-swipe-core': { createAssistantSwipe }, './assistants-avatar-live': { AssistantAvatar: 'Avatar' },
    './tests/assistants-list-pointer/trace': { recordPage: (event: string) => trace.push('page/' + event), recordRow: (event: string, pinned: () => boolean) => trace.push((pinned() ? 'pinned/' : 'normal/') + event) },
    './assistants-details': {}, './assistants-settings': {},
    './page-operations': { createPageOperations: () => ({ ...operation, capture: () => operation, onRetire() {} }) },
  };
  function evaluate<T>(filename: string): T {
    let source = readFileSync(path.join(root, filename), 'utf8');
    if (instrument && filename === 'assistants.tsx') source = instrumentAssistantPage(source);
    if (instrument && filename === 'assistants-swipe.tsx') source = instrumentListRow(source);
    const output = ts.transpileModule(source, { fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { after: [lazy] } }).outputText;
    const exports = {};
    vm.runInNewContext(output, { exports, jsx, If: 'If', setTimeout: () => 1, clearTimeout() {}, require: (id: string) => {
      if (!(id in modules)) throw new Error('Unexpected component dependency ' + id); return modules[id];
    } });
    return exports as T;
  }
  modules['./assistants-swipe'] = evaluate('assistants-swipe.tsx');
  const { AssistantHome } = evaluate<{ AssistantHome: (props: Props) => Node }>('assistants.tsx');
  const home = AssistantHome({ onOpenChat: opened, onEdit: edited, onCreate() {}, get active() { return active(); } });
  type Mounted = { node?: Node; read: () => unknown[] };
  const componentCounts = new Map<Node['type'], number>();
  const ancestors = new Map<Node, Node[]>();
  const mount = (value: unknown, parents: Node[] = []): Mounted => {
    if (Array.isArray(value)) { const children = value.map(child => mount(child, parents)); return { read: () => children.flatMap(child => child.read()) }; }
    if (!value || typeof value !== 'object' || !('type' in value)) return { read: () => [value] };
    const node = value as Node;
    if (typeof node.type === 'function') {
      componentCounts.set(node.type, (componentCounts.get(node.type) ?? 0) + 1);
      const props = Object.create(node.props) as Props;
      Object.defineProperty(props, 'children', { get: () => node.children.map(child => child()) });
      return mount(untracked(() => (node.type as (props: Props) => unknown)(props)), parents);
    }
    ancestors.set(node, parents);
    const children = node.children.map(read => {
      let mounted: Mounted | undefined;
      return () => { const next = read(); if (next && typeof next === 'object') return (mounted ??= mount(next, [...parents, node])).read(); return [next]; };
    });
    if (node.type === 'If') return { node, read: () => node.props.when ? children.flatMap(read => read()) : [] };
    return { node, read: () => [node, ...children.flatMap(read => read())] };
  };
  const mounted = mount(home);
  const nodes = (tree = mounted) => tree.read().filter((value): value is Node => !!value && typeof value === 'object' && 'type' in value);
  const list = () => nodes().find(node => node.type === 'List')!;
  let childrenCalls = 0;
  const cell = (initialIndex: number) => {
    const index = signal(initialIndex), catalog = list();
    const child = catalog.children[0]() as (entry: () => Entry) => Node;
    // NSH item_run retains its previous value while removal awaits unbinding.
    let last = (catalog.props.each as Entry[])[initialIndex];
    const entry = () => last = (catalog.props.each as Entry[])[index()] ?? last;
    childrenCalls++;
    const tree = mount(untracked(() => child(entry)));
    const find = (id: string) => { const node = nodes(tree).find(node => node.props.testID === id); if (!node) throw new Error('Missing cell node ' + id); return node; };
    const pan = () => nodes(tree).find(node => 'onStartShouldSetPanResponder' in node.props)!.props as Pan;
    const longPress = () => nodes(tree).find(node => 'onLongPress' in node.props)!.props.onLongPress as () => void;
    const accessibility = () => nodes(tree).find(node => 'accessibilityActions' in node.props)!;
    return { index, tree, entry, find, pan, nodes: () => nodes(tree), ancestors: (node: Node) => ancestors.get(node) ?? [],
      press: async (id: string) => { const node = find(id); if (node.props.disabled) return; await (node.props.onPress as () => unknown)(); await settle(); },
      longPress, accessibility,
      menu: async () => { longPress()(); await settle(); },
      ax: async (actionName: string) => { (accessibility().props.onAccessibilityAction as (event: { actionName: string }) => void)({ actionName }); await settle(); },
      // SDK boundary: Button's Rust root owns Press/Down/Up but exposes no
      // LongPress. iOS handled_deeper selects only the innermost pressable;
      // release() skips Press iff that same recognizer reported LongPress.
      pointer: async (kind: 'tap' | 'hold') => {
        pan().onStartShouldSetPanResponder();
        const hit = find(`assistant-open-${entry().bot.id}`);
        const target = [...(ancestors.get(hit) ?? []), hit].reverse().find(node => node.type === 'Button' || typeof node.props.onPress === 'function' || typeof node.props.onLongPress === 'function')!;
        const events = ['touch-start'];
        const hold = kind === 'hold' && target.type !== 'Button' && typeof target.props.onLongPress === 'function';
        if (hold) { events.push('long-press'); (target.props.onLongPress as () => void)(); }
        events.push('release');
        if (!hold && !target.props.disabled) { events.push('press'); (target.props.onPress as () => void)(); }
        await settle();
        return { target: target.type, events };
      },
      begin() { pan().onStartShouldSetPanResponder(); },
      drag(dx = -90) { const p = pan(), gesture = { dx, dy: 1, numberActiveTouches: 1 }; p.onMoveShouldSetPanResponder({}, gesture); p.onPanResponderGrant(); p.onPanResponderMove({}, gesture); },
      offset: () => ((nodes(tree).find(node => 'onStartShouldSetPanResponder' in node.props)!.props.style as { transform: Array<{ translateX: number }> }).transform[0].translateX),
    };
  };
  return { app, generation, opened, edited, requests, dialogs, list, cell, settle, tick, active, trace,
    counts: () => ({ children: childrenCalls, components: [...componentCounts.values()].reduce((a, b) => a + b, 0) }),
    answer(value: string) { answer = value; },
    async load(bots: model.Row[]) { seed = bots; revision++; app.bots.set(bots); await settle(); },
    visible(bot: model.Row) { (list().props.onViewableItemsChange as (info: unknown) => void)({ viewableItems: [{ item: { bot }, isViewable: true }] }); tick(); },
  };
}

const bot = (id: string, revision = 1, pinnedAt: number | null = null): model.Row => ({ id, revision, pinnedAt, name: `${id} name ${revision}`, avatarSeed: `${id}-avatar-${revision}`,
  effectiveWorkspacePath: `/fixture/${id}/${revision}`, latestMessagePreview: { text: `${id} preview ${revision}`, createdAt: revision }, unreadCount: revision, working: true });

describe('production AssistantHome recycled cell callbacks (Node/VM, no engine)', () => {
  it('staged page and row instrumentation preserve real List-cell behavior and binding stability during motion', async () => {
    async function run(instrument: boolean) {
      const f = fixture(instrument), first = bot('outer-bot-1', 1, 3), second = bot('outer-bot-2');
      await f.load([first, second]);
      const cell = f.cell(1), entry = cell.entry(); f.trace.length = 0;
      cell.begin(); cell.drag(-40); f.tick(); f.visible(second);
      expect(cell.entry()).toBe(entry); expect(cell.offset()).toBe(-40);
      cell.pan().onPanResponderMove({}, { dx: -110, dy: 0, numberActiveTouches: 1 }); f.tick();
      expect(cell.entry()).toBe(entry); expect(cell.offset()).toBe(-110);
      cell.pan().onPanResponderRelease(); f.tick();
      expect(cell.offset()).toBe(-128);
      const beforeRefresh = [...f.trace];
      await f.load([{ ...first }, { ...second }]);
      expect(cell.offset()).toBe(0);
      return { f, beforeRefresh, after: { offset: cell.offset(), entries: f.list().props.each, requests: f.requests } };
    }
    const plain = await run(false), traced = await run(true);
    expect(traced.after).toEqual(plain.after);
    expect(traced.beforeRefresh).toContain('normal/grant');
    expect(traced.beforeRefresh).toContain('page/page-reveal');
    expect(traced.beforeRefresh).not.toContain('normal/retire-binding');
    expect(traced.f.trace).toContain('normal/retire-binding');
  });

  it('rebinds the old bot-2 cell to pinned bot-1 and then normal bot-1 without recreating children; UI and actions use the displayed snapshot', async () => {
    const f = fixture(), first = bot('outer-bot-1', 1, 3), second = bot('outer-bot-2');
    await f.load([first, second]);
    const cell = f.cell(1); expect(cell.find('assistant-open-outer-bot-2').props.accessibilityLabel).toBe('outer-bot-2 name 1');
    const count = f.counts();
    cell.index.set(0); f.tick(); f.visible(first);
    expect(cell.find('assistant-open-outer-bot-1').props.accessibilityLabel).toBe('outer-bot-1 name 1');
    expect(cell.nodes().find(node => node.type === 'Avatar')!.props).toMatchObject({ bot: first, size: 64, active: true });
    const updated = bot('outer-bot-1', 7);
    await f.load([updated]); f.visible(updated);
    expect(cell.find('assistant-open-outer-bot-1').props.accessibilityLabel).toBe('outer-bot-1 name 7');
    expect(cell.nodes().find(node => node.type === 'Avatar')!.props).toMatchObject({ bot: updated, size: 44, active: true });
    expect(cell.tree.read()).toContain('outer-bot-1 preview 7');
    cell.begin(); await cell.press('assistant-open-outer-bot-1');
    expect(f.opened).toHaveBeenLastCalledWith({ kind: 'assistant', id: 'outer-bot-1', title: 'outer-bot-1 name 7', directory: '/fixture/outer-bot-1/7' });
    f.answer('edit'); cell.begin(); await cell.menu();
    expect(f.dialogs.at(-1)?.title).toBe('outer-bot-1 name 7'); expect(f.edited).toHaveBeenLastCalledWith(updated);
    cell.begin(); cell.drag(); cell.pan().onPanResponderRelease(); f.tick();
    await cell.press('assistant-swipe-edit-outer-bot-1'); expect(f.edited).toHaveBeenLastCalledWith(updated);
    f.answer('delete'); cell.begin(); cell.drag(); cell.pan().onPanResponderRelease(); f.tick();
    await cell.press('assistant-swipe-delete-outer-bot-1');
    expect(f.requests.filter(call => call.method === 'DELETE')).toEqual([{ path: '/api/yuri/assistants/outer-bot-1', method: 'DELETE', body: { expectedRevision: 7 } }]);
    expect(f.counts()).toEqual(count);
  });

  it.each(['binding', 'generation', 'disabled'] as const)('cancels a live rail on %s retirement, rejects late callbacks and permits only a new touch on the current snapshot', async retirement => {
    const f = fixture(), first = bot('outer-bot-1', 1, 3), second = bot('outer-bot-2');
    await f.load([first, second]);
    const cell = f.cell(1); cell.begin(); cell.drag(); f.tick();
    expect(cell.offset()).toBe(-90);
    const staleEdit = cell.find('assistant-swipe-edit-outer-bot-2').props.onPress as () => void;
    const staleDelete = cell.find('assistant-swipe-delete-outer-bot-2').props.onPress as () => void;
    const staleOpen = cell.find('assistant-open-outer-bot-2').props.onPress as () => void;
    const staleLongPress = cell.nodes().find(node => 'onLongPress' in node.props)!.props.onLongPress as () => void;
    const pan = cell.pan();
    if (retirement === 'binding') cell.index.set(0);
    if (retirement === 'generation') f.generation.set(2);
    if (retirement === 'disabled') f.active.set(false);
    f.tick();
    expect(cell.offset()).toBe(0);
    pan.onPanResponderMove({}, { dx: -120, dy: 0, numberActiveTouches: 1 }); pan.onPanResponderRelease();
    staleEdit(); staleDelete(); staleLongPress();
    staleOpen(); await f.settle();
    expect(f.opened).not.toHaveBeenCalled(); expect(f.edited).not.toHaveBeenCalled(); expect(f.dialogs).toEqual([]);
    expect(f.requests.filter(call => call.method !== 'GET')).toEqual([]);
    expect(cell.offset()).toBe(0);
    f.active.set(true); f.tick();
    cell.begin();
    const id = retirement === 'binding' ? 'outer-bot-1' : 'outer-bot-2';
    await cell.press(`assistant-open-${id}`); expect(f.opened.mock.lastCall?.[0].id).toBe(id);
    if (retirement === 'binding') {
      cell.begin(); expect(cell.pan().onMoveShouldSetPanResponder({}, { dx: -80, dy: 0, numberActiveTouches: 1 })).toBe(false);
    }
  });

  it('same-ID replacement and bot-2 → bot-1 → bot-2 ABA cannot inherit a rail or dispatch stale closures; visibility stays tied to the current ID', async () => {
    const f = fixture(), first = bot('outer-bot-1', 1, 3), second = bot('outer-bot-2');
    await f.load([first, second]);
    const cell = f.cell(1); cell.begin(); cell.drag(); f.tick();
    const oldMenu = cell.longPress();
    const oldOpen = cell.find('assistant-open-outer-bot-2').props.onPress as () => void;
    cell.index.set(0); f.tick(); cell.index.set(1); f.tick();
    const replacement = bot('outer-bot-2', 8);
    await f.load([first, replacement]); f.visible(first);
    oldMenu(); oldOpen(); await f.settle();
    expect(f.dialogs).toEqual([]); expect(f.opened).not.toHaveBeenCalled(); expect(cell.offset()).toBe(0);
    expect(cell.find('assistant-open-outer-bot-2').props.accessibilityLabel).toBe('outer-bot-2 name 8');
    expect(cell.nodes().find(node => node.type === 'Avatar')!.props).toMatchObject({ bot: replacement, active: false, size: 44 });
    const counts = f.counts();
    for (let i = 0; i < 50; i++) { f.visible(first); cell.nodes(); }
    expect(f.counts()).toEqual(counts);
    f.visible(replacement); expect(cell.nodes().find(node => node.type === 'Avatar')!.props.active).toBe(true);
    cell.begin(); f.answer('edit'); await cell.menu();
    expect(f.dialogs.at(-1)?.title).toBe('outer-bot-2 name 8'); expect(f.edited).toHaveBeenLastCalledWith(replacement);
  });

  it('completed touches do not block a later accessibility action after a same-ID refresh without another native touch', async () => {
    const f = fixture(), first = bot('outer-bot-1', 1, 3), second = bot('outer-bot-2');
    await f.load([first, second]); const cell = f.cell(1);
    cell.begin(); await cell.press('assistant-open-outer-bot-2');
    const replacement = bot('outer-bot-2', 9); await f.load([first, replacement]);
    f.answer('edit'); await cell.ax('menu');
    expect(f.edited).toHaveBeenLastCalledWith(replacement);
    await cell.ax('activate');
    expect(f.opened.mock.lastCall?.[0]).toEqual({ kind: 'assistant', id: 'outer-bot-2', title: 'outer-bot-2 name 9', directory: '/fixture/outer-bot-2/9' });
  });

  it('checks binding synchronously when a native callback arrives before the queued reactive effect', async () => {
    const f = fixture(); await f.load([bot('outer-bot-1', 1, 3), bot('outer-bot-2')]);
    const cell = f.cell(1); cell.begin(); cell.drag(); f.tick();
    const staleDelete = cell.find('assistant-swipe-delete-outer-bot-2').props.onPress as () => void;
    cell.index.set(0);
    staleDelete();
    expect(cell.offset()).toBe(0); expect(f.dialogs).toEqual([]);
    expect(f.requests.filter(call => call.method !== 'GET')).toEqual([]);
    f.tick(); expect(cell.find('assistant-open-outer-bot-1').props.accessibilityLabel).toBe('outer-bot-1 name 1');
  });

  it.each(['release', 'terminate'] as const)('%s ends a swipe without a Button click: fresh same-ID snapshot admits current AX actions but rejects old press callbacks', async end => {
    const f = fixture(), first = bot('outer-bot-1', 1, 3), second = bot('outer-bot-2');
    await f.load([first, second]); const cell = f.cell(1);
    cell.begin(); cell.drag(); f.tick();
    const staleMenu = cell.longPress();
    const staleOpen = cell.find('assistant-open-outer-bot-2').props.onPress as () => void;
    if (end === 'release') cell.pan().onPanResponderRelease(); else cell.pan().onPanResponderTerminate();
    staleOpen(); expect(f.opened).not.toHaveBeenCalled();
    const replacement = bot('outer-bot-2', 10); await f.load([first, replacement]);
    staleMenu(); staleOpen(); await f.settle();
    expect(f.dialogs).toEqual([]); expect(f.opened).not.toHaveBeenCalled();
    await cell.ax('activate');
    expect(f.opened.mock.lastCall?.[0]).toEqual({ kind: 'assistant', id: 'outer-bot-2', title: 'outer-bot-2 name 10', directory: '/fixture/outer-bot-2/10' });
    f.answer('edit'); await cell.ax('menu');
    expect(f.edited).toHaveBeenLastCalledWith(replacement);
    expect(f.counts()).toEqual({ children: 1, components: 1 });
  });

  it.each([0, 1])('cell %i exposes only the contact trigger, long-press menu and public AX actions; no extra more button or long-press release navigation', async index => {
    const f = fixture(), first = bot('outer-bot-1', 1, 3), second = bot('outer-bot-2');
    await f.load([first, second]); const cell = f.cell(index), displayed = index ? second : first;
    expect(cell.nodes().filter(node => typeof node.props.testID === 'string' && node.props.testID.startsWith('assistant-open-')).map(node => node.props.testID)).toEqual([`assistant-open-${displayed.id}`]);
    expect(cell.nodes().some(node => node.type === 'Icon' && node.props.name === 'more-2')).toBe(false);
    expect(cell.accessibility().props).toMatchObject({ accessible: true, role: 'button', accessibilityLabel: displayed.name,
      accessibilityActions: [{ name: 'activate' }, { name: 'menu', label: 'chat.timeline.actions.title' }] });
    cell.begin(); await cell.menu(); await cell.press(`assistant-open-${displayed.id}`);
    expect(f.dialogs.at(-1)?.title).toBe(displayed.name); expect(f.opened).not.toHaveBeenCalled();
    const calls = f.dialogs.length; await cell.ax('unknown'); expect(f.dialogs).toHaveLength(calls);
    f.answer('edit'); await cell.ax('menu'); expect(f.edited).toHaveBeenLastCalledWith(displayed);
    await cell.ax('activate'); expect(f.opened.mock.lastCall?.[0].id).toBe(displayed.id);
  });

  it('old AX custom actions and long-press callbacks cannot open a menu for a freshly rebound Bot or retired generation', async () => {
    const f = fixture(); await f.load([bot('outer-bot-1', 1, 3), bot('outer-bot-2')]); const cell = f.cell(1);
    cell.begin();
    const oldLongPress = cell.longPress(), oldAX = cell.accessibility().props.onAccessibilityAction as (event: { actionName: string }) => void;
    cell.index.set(0); f.generation.set(2); f.tick();
    oldLongPress(); oldAX({ actionName: 'menu' }); oldAX({ actionName: 'activate' }); await f.settle();
    expect(f.dialogs).toEqual([]); expect(f.opened).not.toHaveBeenCalled();
    await cell.ax('menu'); expect(f.dialogs.at(-1)?.title).toBe('outer-bot-1 name 1');
    cell.begin(); await cell.menu(); expect(f.dialogs.at(-1)?.title).toBe('outer-bot-1 name 1');
    expect(f.counts()).toEqual({ children: 1, components: 1 });
  });

  it.each(['release', 'terminate'] as const)('a panned or %s gesture cannot become a long-press menu; explicit current AX menu stays usable', async end => {
    const f = fixture(); await f.load([bot('outer-bot-1', 1, 3), bot('outer-bot-2')]); const cell = f.cell(1);
    cell.begin(); const lateLongPress = cell.longPress(); cell.drag(); f.tick();
    await cell.menu(); expect(f.dialogs).toEqual([]);
    if (end === 'release') cell.pan().onPanResponderRelease(); else cell.pan().onPanResponderTerminate();
    lateLongPress(); await f.settle(); expect(f.dialogs).toEqual([]);
    await cell.ax('menu'); expect(f.dialogs.at(-1)?.title).toBe('outer-bot-2 name 1');
    expect(f.opened).not.toHaveBeenCalled();
    f.active.set(false); f.tick(); const count = f.dialogs.length;
    await cell.ax('menu'); await cell.ax('activate');
    expect(f.dialogs).toHaveLength(count); expect(f.opened).not.toHaveBeenCalled();
  });

  it.each(['release', 'terminate'] as const)('AX takeover retires pointer callbacks permanently across late %s while successive current AX actions remain usable', async end => {
    const f = fixture(), first = bot('outer-bot-1', 1, 3), second = bot('outer-bot-2');
    await f.load([first, second]); const cell = f.cell(1);
    cell.begin(); cell.drag(); f.tick();
    const oldOpen = cell.find('assistant-open-outer-bot-2').props.onPress as () => void;
    const oldEdit = cell.find('assistant-swipe-edit-outer-bot-2').props.onPress as () => void;
    const oldDelete = cell.find('assistant-swipe-delete-outer-bot-2').props.onPress as () => void;
    await cell.ax('menu'); expect(f.dialogs).toHaveLength(1);
    if (end === 'release') cell.pan().onPanResponderRelease(); else cell.pan().onPanResponderTerminate();
    oldOpen(); oldEdit(); oldDelete(); await f.settle();
    expect(f.opened).not.toHaveBeenCalled(); expect(f.edited).not.toHaveBeenCalled(); expect(f.dialogs).toHaveLength(1);
    expect(f.requests.filter(call => call.method !== 'GET')).toEqual([]);
    f.answer('edit'); await cell.ax('menu'); expect(f.edited).toHaveBeenLastCalledWith(second);
    await cell.ax('activate'); expect(f.opened.mock.lastCall?.[0].id).toBe('outer-bot-2');
    await cell.ax('menu'); expect(f.dialogs).toHaveLength(3);
    const opened = f.opened.mock.calls.length, edited = f.edited.mock.calls.length;
    oldOpen(); oldEdit(); oldDelete(); await f.settle();
    expect(f.opened).toHaveBeenCalledTimes(opened); expect(f.edited).toHaveBeenCalledTimes(edited); expect(f.dialogs).toHaveLength(3);
    expect(f.counts()).toEqual({ children: 1, components: 1 });
  });

  it.each(['Synthetic Research Bot', 'A'.repeat(200), '这是一个很长的助理名称需要单行省略显示', '助手🌍e\u0301🧑🏽‍💻مرحبا'])('renders a bounded pinned caption and unchanged normal name for %j, including a recycled pinned→normal cell', async name => {
    const f = fixture(), first = { ...bot('outer-bot-1', 1, 3), name }, second = { ...bot('outer-bot-2'), name };
    await f.load([first, second]); const pinned = f.cell(0), normal = f.cell(1);
    const caption = (cell: ReturnType<typeof f.cell>, value: string) => {
      const node = cell.nodes().find(node => node.type === 'Text' && node.children.some(read => read() === value));
      if (!node) throw new Error('Missing rendered name Text'); return node;
    };
    const label = caption(pinned, name), lineage = pinned.ancestors(label);
    expect(label.props.class).not.toContain('flex-1');
    expect(label.props.class).toBe('text-base font-semibold text-foreground');
    expect(label.props.style).toEqual({ width: '100%', minWidth: 0, textAlign: 'center', numberOfLines: 1, textOverflow: 'ellipsis' });
    expect(lineage.at(-1)?.props.style).toEqual({ width: '100%', minWidth: 0 });
    // Web's max-w-28 tile (112) minus its two px-2 insets (8 each).
    expect(lineage.at(-2)?.props.style).toEqual({ width: 96, minWidth: 0, maxWidth: 96 });
    expect(label.props.adjustsFontSizeToFit).not.toBe(true);
    expect(label.children.map(read => read())).toEqual([name]);
    const ordinary = caption(normal, name);
    expect(ordinary.props.class).toBe('flex-1 text-base font-semibold text-foreground');
    expect(ordinary.props.style).toEqual({ numberOfLines: 1 });
    expect(normal.ancestors(ordinary).at(-2)?.props.style).toBeUndefined();
    const updated = name + ' updated 💫';
    await f.load([{ ...first, name: updated, pinnedAt: null, latestMessagePreview: { createdAt: 100 } }, second]);
    const recycled = caption(pinned, updated);
    expect(recycled.props.class).toBe('flex-1 text-base font-semibold text-foreground');
    expect(recycled.props.style).toEqual({ numberOfLines: 1 });
    expect(pinned.ancestors(recycled).at(-2)?.props.style).toBeUndefined();
    expect(recycled.children.map(read => read())).toEqual([updated]);
    expect(f.counts()).toEqual({ children: 2, components: 2 });
  });

  it.each([0, 1])('mounted contact target %i receives both native hold and release; the held touch opens only ActionSheet and a separate tap still opens Chat', async index => {
    const f = fixture(), first = bot('outer-bot-1', 1, 3), second = bot('outer-bot-2');
    await f.load([first, second]); const cell = f.cell(index), displayed = index ? second : first;
    const trace = await cell.pointer('hold');
    expect(f.dialogs).toHaveLength(1); expect(f.dialogs[0].title).toBe(displayed.name);
    expect(f.dialogs[0].actions.map(action => action.id)).toEqual(['pin', 'edit', 'delete', 'cancel']);
    expect(f.opened).not.toHaveBeenCalled(); expect(f.edited).not.toHaveBeenCalled();
    expect(f.requests.filter(call => call.method !== 'GET')).toEqual([]);
    expect(trace).toEqual({ target: 'View', events: ['touch-start', 'long-press', 'release'] });
    const target = cell.find(`assistant-open-${displayed.id}`);
    expect(target.props.role).toBe('button'); expect(target.props.disabled).toBe(false);
    expect(cell.ancestors(target).some(node => typeof node.props.onLongPress === 'function')).toBe(false);
    await cell.pointer('tap'); expect(f.opened.mock.lastCall?.[0].id).toBe(displayed.id);
    expect(f.counts()).toEqual({ children: 1, components: 1 });
  });
});
