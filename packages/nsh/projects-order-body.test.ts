import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as touchOwner from './projects-order-touch';
import { nativeLayoutDensity } from './native-density';

const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'projects.tsx'), 'utf8');
const parsed = ts.createSourceFile('projects.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
type Touch = { identifier: number; pageX: number; pageY: number; touches: { identifier: number }[] };
const event = (y: number, fingers = 1): Touch => ({ identifier: 1, pageX: 30, pageY: y, touches: Array.from({ length: fingers }, (_, i) => ({ identifier: i + 1 })) });
function mount(scope: string) {
  let generation = 1, current = true;
  const nodes: Node[] = [], effects: Array<() => void> = [], cleanups: Array<() => void> = [], refs: Array<{ measure: ReturnType<typeof vi.fn> }> = [], leaves: Array<() => unknown> = [];
  const declarations = ['createProjectsScroll', 'ProjectsSessionGroup', 'SessionRow'].map(name => parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!.getText(parsed)).join('\n');
  const code = ts.transpileModule(`${declarations}\nresult = { createProjectsScroll, ProjectsSessionGroup };`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2023 } }).outputText;
  const context = vm.createContext({ ...touchOwner, signal: (value: unknown) => { const leaf = signal(value); leaves.push(leaf); return leaf; }, computed: (work: () => unknown) => work, untracked: (work: () => void) => work(), effect: (work: () => void) => { effects.push(work); work(); }, cleanup: (work: () => void) => cleanups.push(work), epoch: () => generation,
    React: { createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
      if (typeof type === 'function') return type({ ...props, children: children.length === 1 ? children[0] : children });
      const node = { type, props: props ?? {}, children }; nodes.push(node);
      if (type === 'View' && typeof node.props.ref === 'function') {
        const i = refs.length, ref = { measure: vi.fn(async () => ({ pagePosition: { x: 0, y: i * 68 }, bounds: { size: { width: 300, height: 56 } } })) }; refs.push(ref); node.props.ref(ref);
      }
      return node;
    } },
    Each: (props: { of: unknown[]; children: (row: () => unknown) => unknown }) => props.of.map(row => props.children(() => row)),
    If: (props: { when: unknown; children: unknown }) => props.when ? props.children : null,
    View: 'View', Text: 'Text', Button: 'Button', Input: 'Input', Sheet: 'Sheet', Overlay: 'Overlay', Icon: 'Icon', ProjectsSessionIndicator: 'Indicator',
    PanResponder: { create: (handlers: unknown) => ({ panHandlers: handlers }) },
    t: (key: string) => key, quiet: '', action: '', field: '', relative: () => '', resolveMobileSessionIndicator: () => 'idle', readProjectsBlocking: () => ({}),
    AlertDialog: { show: vi.fn(async () => ({ action: 'cancel' })) },
    nativeDensity: () => nativeLayoutDensity(),
    setTimeout, clearTimeout, Promise,
  });
  vm.runInContext(code, context);
  const module = context.result as { createProjectsScroll(): ReturnType<() => { drag: touchOwner.ProjectsOrderScroll; dragging(): boolean; register(stop: () => void): () => void; ref(node: unknown): void; contentRef(node: unknown): void; onScroll(value: unknown): void; onTouchStartCapture(value: unknown): void; onContentLayout(): void; onScrollDragStart(): void }>; ProjectsSessionGroup(props: unknown): unknown };
  const scroll = module.createProjectsScroll(), scrollTo = vi.fn();
  scroll.ref({ measure: async () => ({ pagePosition: { y: 0 }, bounds: { size: { height: 600 } } }), scrollTo });
  scroll.contentRef({ measure: async () => ({ bounds: { size: { height: 1400 } } }) });
  const reorder = vi.fn(), open = vi.fn(), viewed = vi.fn();
  const rows = ['a', 'b', 'c'].map((id, i) => ({ id, title: id, directory: '/repo', updated: 3 - i }));
  const controller = { current: () => current, pending: () => [], pins: () => [], running: () => [], attention: () => ({ blockingByDirectory: {}, unseenBySession: {} }), error: () => '', reorder, markViewed: viewed };
  const groupProps = { controller, scope, scroll, rows: () => rows, onOpen: open };
  module.ProjectsSessionGroup(groupProps);
  const body = nodes.find(node => node.props.testID === `project-session-touch-${scope}-a`)!;
  const button = nodes.find(node => node.props.testID === 'project-session-a')!;
  const menu = nodes.find(node => node.props.testID === 'project-session-menu-a')!;
  return { nodes, body, button, menu, reorder, open, viewed, refs, scroll, scrollTo, effects, leaves, changeScope: () => { groupProps.scope = '/different'; effects.forEach(work => work()); }, retire: () => { generation++; effects.forEach(work => work()); }, hide: () => { current = false; effects.forEach(work => work()); }, dispose: () => cleanups.forEach(stop => stop()) };
}
const invoke = (node: Node, name: string, arg?: unknown) => (node.props[name] as (value?: unknown) => unknown)(arg);
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('production group → SessionRow → touch owner → captured scope', () => {
  it.each(['/repo', '__pinned__'])('holds the actual body and drops once in %s without opening a session', async scope => {
    vi.useFakeTimers(); const f = mount(scope);
    invoke(f.body, 'onTouchStartCapture', event(28)); await vi.advanceTimersByTimeAsync(349);
    expect(invoke(f.body, 'onMoveShouldSetResponderCapture')).toBe(false); expect(f.reorder).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(invoke(f.body, 'onResponderGrant')).toBe(true); expect(f.scroll.dragging()).toBe(true);
    invoke(f.body, 'onResponderMove', event(96)); invoke(f.body, 'onResponderRelease', event(96, 0)); invoke(f.body, 'onTouchEndCapture', event(96, 0)); invoke(f.button, 'onPress');
    expect(f.reorder).toHaveBeenCalledExactlyOnceWith(scope, 'a', 'b', ['a', 'b', 'c']); expect(f.open).not.toHaveBeenCalled(); expect(f.viewed).not.toHaveBeenCalled(); expect(f.scroll.dragging()).toBe(false);
    invoke(f.button, 'onPress'); expect(f.open).toHaveBeenCalledOnce(); f.dispose();
  });
  it('leaves scroll/tap admission native before activation and cancels a raw scroll gesture', async () => {
    vi.useFakeTimers(); const f = mount('/repo');
    invoke(f.body, 'onTouchStartCapture', event(28)); invoke(f.body, 'onTouchMoveCapture', event(48)); await vi.advanceTimersByTimeAsync(500);
    expect(invoke(f.body, 'onMoveShouldSetResponderCapture')).toBe(false); expect(f.scroll.dragging()).toBe(false); expect(f.reorder).not.toHaveBeenCalled(); f.dispose();
  });
  it.each(['hide', 'retire', 'dispose', 'multitouch', 'layout', 'scrollstart', 'scope'])('cancels production %s without leaving root scrolling disabled', async reason => {
    vi.useFakeTimers(); const f = mount('/repo');
    invoke(f.body, 'onTouchStartCapture', event(28)); await vi.advanceTimersByTimeAsync(350); invoke(f.body, 'onResponderMove', event(96));
    if (reason === 'hide') f.hide(); if (reason === 'retire') f.retire(); if (reason === 'dispose') f.dispose();
    if (reason === 'multitouch') f.scroll.onTouchStartCapture(event(100, 2)); if (reason === 'layout') f.scroll.onContentLayout(); if (reason === 'scrollstart') f.scroll.onScrollDragStart();
    if (reason === 'scope') f.changeScope();
    invoke(f.body, 'onTouchEndCapture', event(96, 0)); expect(f.reorder).not.toHaveBeenCalled(); expect(f.scroll.dragging()).toBe(false); f.dispose();
  });
  it('measures initial scroll extent before any native onScroll event', async () => {
    const f = mount('/repo'); expect(await f.scroll.drag.viewport()).toEqual({ top: 0, height: 600 }); expect(f.scroll.drag.max()).toBe(800); f.dispose();
  });
  it('keeps the menu button outside all drag touch handlers and cancels a held body when chosen', async () => {
    vi.useFakeTimers(); const f = mount('/repo');
    expect(f.menu.props.onTouchStartCapture).toBeUndefined(); invoke(f.body, 'onTouchStartCapture', event(28)); await vi.advanceTimersByTimeAsync(350);
    await invoke(f.menu, 'onPress'); expect(f.scroll.dragging()).toBe(false); expect(f.reorder).not.toHaveBeenCalled(); f.dispose();
  });
  it('closes a previously revealed swipe rail when body sorting activates and suppresses only one click', async () => {
    vi.useFakeTimers(); const f = mount('/repo');
    const swipe = f.nodes.find(node => typeof node.props.onPanResponderGrant === 'function')!;
    invoke(swipe, 'onPanResponderGrant');
    (swipe.props.onPanResponderMove as (event: null, g: { dx: number; dy: number }) => void)(null, { dx: -80, dy: 0 }); invoke(swipe, 'onPanResponderRelease');
    expect(f.leaves.some(leaf => leaf() === -112)).toBe(true);
    invoke(f.body, 'onTouchStartCapture', event(28)); await vi.advanceTimersByTimeAsync(350); f.effects.forEach(work => work());
    expect(f.leaves.some(leaf => leaf() === -112)).toBe(false);
    invoke(f.body, 'onResponderMove', event(96)); invoke(f.body, 'onResponderRelease', event(96, 0)); invoke(f.button, 'onPress');
    expect(f.open).not.toHaveBeenCalled(); invoke(f.button, 'onPress'); expect(f.open).toHaveBeenCalledOnce(); f.dispose();
  });
});
