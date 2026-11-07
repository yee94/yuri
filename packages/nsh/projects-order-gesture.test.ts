import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createHost } from './projects-order-host.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(root, 'projects.tsx'), 'utf8');
const parsed = ts.createSourceFile('projects.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
type Element = { type: string; props: Record<string, unknown> & { testID?: string; onPress?: () => void }; children: Element[] };
type Gesture = { dx: number; dy: number };
type Pan = { onPanResponderGrant(): void; onPanResponderMove(event: null, gesture: Gesture): void; onPanResponderRelease(event: null, gesture: Gesture): void; onPanResponderTerminate(): void; onMoveShouldSetPanResponder(event: null, gesture: Gesture): boolean };
function fixture(name: string, ids = ['/a', '/b', '/c'], centers = [28, 328, 388]) {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const pans: Pan[] = [], cleanups: Array<() => void> = [], effects: Array<() => void> = [];
  let epoch = 1, current = true, pending: string[] = [];
  const commit = vi.fn(), measured = vi.fn(async (id: string) => ({ pagePosition: { x: 0, y: centers[ids.indexOf(id)]! - 28 }, bounds: { size: { width: 300, height: 56 } } }));
  const refs = new Map(ids.map(id => [id, { measure: () => measured(id) }]));
  const rows = ids.map(id => ({ id, path: id, title: id, branch: id, directory: '/repo' }));
  const globals: Record<string, unknown> = {
    signal, effect: (fn: () => void) => { effects.push(fn); }, cleanup: (fn: () => void) => cleanups.push(fn), epoch: () => epoch,
    PanResponder: { create: (handlers: Pan) => { pans.push(handlers); return { panHandlers: handlers }; } },
    React: { createElement: (type: string, props: Element['props'], ...children: Element[]) => ({ type, props: props ?? {}, children }) },
    View: 'View', Text: 'Text', Button: 'Button', If: 'If', Sheet: 'Sheet', Icon: 'Icon', t: (key: string) => key,
    quiet: '', action: '', field: '', sessionCount: String,
    relative: () => '', resolveMobileSessionIndicator: () => 'idle', readProjectsBlocking: () => ({}), ProjectsSessionIndicator: 'Indicator', Input: 'Input',
  };
  // Load the same import-free gesture implementation used by production, when present.
  const helperPath = path.join(root, 'projects-order-gesture.ts');
  try {
    const exports = {};
    vm.runInNewContext(ts.transpileModule(readFileSync(helperPath, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } }).outputText, { exports });
    Object.assign(globals, exports);
  } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
  const compiled = ts.transpileModule(`${declaration.getText(parsed)}\nresult = ${name};`, { compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2023 } }).outputText;
  const context = vm.createContext({ ...globals, result: undefined }); vm.runInContext(compiled, context);
  const props = { project: { path: '/repo' }, tree: rows[0], row: rows[0], rows: () => rows, scope: '/repo', geometry: refs, active: () => current,
    controller: { current: () => current, pins: () => [], running: () => [], attention: () => ({ blockingByDirectory: {}, unseenBySession: {} }), markViewed: vi.fn(), pending: () => pending, byDirectory: () => new Map(), dirty: () => ({}), error: () => '', orderedWorktrees: () => rows, reorderWorktree: commit, reorder: commit }, onOpen: vi.fn(), onSelect: vi.fn(), onNewSession: vi.fn(), drag: { start: vi.fn(), move: vi.fn(), finish: vi.fn(), cancel: vi.fn(), claimed: () => true, consumeClick: () => false } };
  const tree = context.result(props) as Element;
  return { pan: pans.at(-1)!, tree, props, commit, measured, refs, rows, retire: () => { epoch++; }, close: () => { current = false; if (name === 'SessionOrderRow') effects.forEach(fn => fn()); }, reopen: () => { current = true; }, pending: (keys: string[]) => { pending = keys; }, dispose: () => cleanups.forEach(fn => fn()) };
}
const g = (dy: number) => ({ dx: 0, dy });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('production Projects drag closures', () => {
  it('routes a homepage session body touch to its group drag owner rather than a long-press menu', () => {
    const f = fixture('SessionRow');
    const find = (node: Element): Element | undefined => node?.props?.testID === 'project-session-touch-plain-/a' ? node : node?.children?.flat(Infinity).map(child => find(child as Element)).find(Boolean);
    const body = find(f.tree)!;
    expect(body.props.onTouchStartCapture).toBeTypeOf('function');
    (body.props.onTouchStartCapture as (event: unknown) => void)({ pageX: 20, pageY: 30, touches: [{ identifier: 1 }] });
    expect(f.props.drag.start).toHaveBeenCalledWith('/a', expect.objectContaining({ pageY: 30 }));
    const collect = (node: Element): Element[] => node && typeof node === 'object' && node.props ? [node, ...node.children.flat(Infinity).flatMap(child => collect(child as Element))] : [];
    expect(collect(f.tree).some(node => typeof node.props.onLongPress === 'function')).toBe(false);
  });
  it('does not mount the extra homepage sorting Sheet or project move menu entries', () => {
    const home = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ProjectsHome')!.getText(parsed);
    const directory = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'DirectoryRows')!.getText(parsed);
    expect(home + directory).not.toContain('<SessionOrderControl');
    expect(home).not.toContain("id: 'up'"); expect(home).not.toContain("id: 'down'");
  });
  it('does not skip over an expanded worktree group based on a guessed 56pt stride', async () => {
    const f = fixture('WorktreeRow');
    f.pan.onPanResponderGrant(); f.pan.onPanResponderMove(null, g(150)); f.pan.onPanResponderRelease(null, g(150)); await settle();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('selects the closest measured header across expanded groups', async () => {
    const f = fixture('WorktreeRow');
    f.pan.onPanResponderGrant(); f.pan.onPanResponderRelease(null, g(300)); await settle();
    expect(f.commit).toHaveBeenCalledWith(f.props.project, '/a', '/b');
  });
  it.each(['WorktreeRow'])('%s discards a gesture from a retired Host generation', async name => {
    const f = fixture(name);
    f.pan.onPanResponderGrant(); f.retire(); f.pan.onPanResponderRelease(null, g(300)); await settle();
    expect(f.commit).not.toHaveBeenCalled();
  });
  it.each(['WorktreeRow'])('%s makes one measurement per row and at most one drop, never per move', async name => {
    const ids = Array.from({ length: 500 }, (_, i) => `/tree-${i}`);
    const f = fixture(name, ids, ids.map((_, i) => 28 + i * 64));
    f.pan.onPanResponderGrant();
    for (let i = 0; i < 240; i++) f.pan.onPanResponderMove(null, g(i));
    expect(f.measured).toHaveBeenCalledTimes(500); expect(f.commit).not.toHaveBeenCalled();
    f.pan.onPanResponderRelease(null, g(128)); f.pan.onPanResponderRelease(null, g(128)); await settle();
    expect(f.commit).toHaveBeenCalledOnce(); expect(f.measured).toHaveBeenCalledTimes(500);
  });
  it.each(['WorktreeRow'])('%s cancels on termination or unmount instead of committing late geometry', async name => {
    for (const dispose of [false, true]) {
      const f = fixture(name);
      f.pan.onPanResponderGrant(); f.pan.onPanResponderRelease(null, g(300));
      if (dispose) f.dispose(); else f.pan.onPanResponderTerminate();
      await settle(); expect(f.commit).not.toHaveBeenCalled();
    }
  });
  it.each(['WorktreeRow'])('%s rejects changed membership/order and missing geometry', async name => {
    const f = fixture(name); f.refs.delete('/b');
    f.pan.onPanResponderGrant(); f.pan.onPanResponderRelease(null, g(300)); await settle();
    expect(f.commit).not.toHaveBeenCalled();
    const changed = fixture(name); changed.pan.onPanResponderGrant(); changed.rows.reverse();
    changed.pan.onPanResponderRelease(null, g(300)); await settle(); expect(changed.commit).not.toHaveBeenCalled();
  });
  it('does not claim horizontal scrolling or a pending order gesture', () => {
    const f = fixture('WorktreeRow');
    expect(f.pan.onMoveShouldSetPanResponder(null, { dx: 40, dy: 3 })).toBe(false);
    f.pending(['tree-order:/repo']); expect(f.pan.onMoveShouldSetPanResponder(null, g(30))).toBe(false);
  });
  it('suppresses the selection click following a worktree drag', async () => {
    const f = fixture('WorktreeRow');
    const find = (node: Element): Element | undefined => node?.props?.testID === 'project-worktree-/a' ? node : node?.children?.flat(Infinity).map(child => find(child as Element)).find(Boolean);
    const button = find(f.tree)!;
    f.pan.onPanResponderGrant(); f.pan.onPanResponderRelease(null, g(300)); await settle();
    button.props.onPress!(); expect(f.props.onSelect).not.toHaveBeenCalled();
    button.props.onPress!(); expect(f.props.onSelect).toHaveBeenCalledOnce();
  });
});

describe('isolated Projects UIKit fixture Host', () => {
  it('grants only a synthetic lease and audits exact scoped ordering without real services', () => {
    const host = createHost();
    const snapshot = host.call('connection.list', {});
    const expectedHost = snapshot.runtimeScope;
    const read = (path: string) => host.call('runtime.request', { path });
    expect(read('/api/yuri/session-index').body.directories).toHaveLength(4);
    expect(() => host.call('runtime.request', { path: '/api/yuri/message-queue/worktrees/order', method: 'PUT', body: {} })).toThrow('Missing exact fixture lease');
    const body = { projectDirectory: '/fixture/repo', expectedRevision: 1, orderedPaths: ['/fixture/b', '/fixture/a', '/fixture/c'] };
    host.call('runtime.request', { path: '/api/yuri/message-queue/worktrees/order', method: 'PUT', expectedHost, body });
    expect(host.call('projects.order.audit', {}).writes).toEqual([{ kind: 'worktrees', scope: '/fixture/repo', ids: body.orderedPaths }]);
    expect(() => host.call('runtime.request', { path: '/api/fs/write', method: 'POST', expectedHost })).toThrow('Unexpected order fixture request');
    host.call('projects.order.failRead', {});
    expect(read('/api/yuri/message-queue/worktrees/order?projectDirectory=%2Ffixture%2Frepo').status).toBe(503);
    expect(read('/api/yuri/message-queue/worktrees/order?projectDirectory=%2Ffixture%2Frepo').body.orderedPaths).toEqual(body.orderedPaths);
  });
});
