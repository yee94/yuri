import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createHost } from './projects-order-host.js';
import { createProjectsScopeVM } from './tests/projects-scope-vm';
import { nativeLayoutDensity } from './native-density';

const root = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(root, 'projects.tsx'), 'utf8');
const parsed = ts.createSourceFile('projects.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
type Element = { type: string; props: Record<string, unknown> & { testID?: string; onPress?: () => void }; children: Element[] };
type Gesture = { dx: number; dy: number };
type Pan = { onPanResponderGrant(): void; onPanResponderMove(event: null, gesture: Gesture): void; onPanResponderRelease(event: null, gesture: Gesture): void; onPanResponderTerminate(): void; onMoveShouldSetPanResponder(event: null, gesture: Gesture): boolean };
function fixture(name: string, ids = ['/a', '/b', '/c'], centers = [28, 328, 388], sharedRefs?: Map<string, { measure(): Promise<{ pagePosition: { x: number; y: number }; bounds: { size: { width: number; height: number } } }> }>) {
  const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  const pans: Pan[] = [], cleanups: Array<() => void> = [], effects: Array<() => void> = [];
  let epoch = 1, current = true, pending: string[] = [];
  let leased = false;
  const stops = new Set<() => void>(), audit = vi.fn();
  const scroll = { dragging: () => leased, drag: { claim: () => { if (leased) return null; leased = true; return () => { leased = false; }; } }, register: (stop: () => void) => { stops.add(stop); return () => stops.delete(stop); } };
  const commit = vi.fn(), measured = vi.fn(async (id: string) => ({ pagePosition: { x: 0, y: centers[ids.indexOf(id)]! - 28 }, bounds: { size: { width: 300, height: 56 } } }));
  const refs = sharedRefs ?? new Map(ids.map(id => [id, { measure: () => measured(id) }]));
  const rows = ids.map(id => ({ id, path: id, title: id, branch: id, directory: '/repo' }));
  const globals: Record<string, unknown> = {
    app: { connection: () => 'fixture' },
    signal, untracked: (fn: () => void) => fn(), effect: (fn: () => void) => { effects.push(fn); }, cleanup: (fn: () => void) => cleanups.push(fn), epoch: () => epoch,
    PanResponder: { create: (handlers: Pan) => { pans.push(handlers); return { panHandlers: handlers }; } },
    React: { createElement: (type: string, props: Element['props'], ...children: Element[]) => ({ type, props: props ?? {}, children }) },
    View: 'View', Text: 'Text', Button: 'Button', If: 'If', Sheet: 'Sheet', Icon: 'Icon', t: (key: string) => key,
    quiet: '', action: '', field: '', sessionCount: String,
    nativeDensity: () => nativeLayoutDensity(),
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
  const props = { project: { path: '/repo' }, tree: rows[0], row: rows[0], rows: () => rows, scope: '/repo', geometry: refs, scroll, onOrderGesture: audit, active: () => current,
    controller: { current: () => current, worktrees: () => ({}), treeOrders: () => ({}), pins: () => [], running: () => [], attention: () => ({ blockingByDirectory: {}, unseenBySession: {} }), markViewed: vi.fn(), pending: () => pending, byDirectory: () => new Map(), dirty: () => ({}), error: () => '', orderedWorktrees: () => rows, reorderWorktree: commit, reorder: commit }, onOpen: vi.fn(), onSelect: vi.fn(), onNewSession: vi.fn(), drag: { start: vi.fn(), move: vi.fn(), finish: vi.fn(), cancel: vi.fn(), claimed: () => true, consumeClick: () => false } };
  const tree = context.result(props) as Element;
  const find = (node: Element): Element | undefined => node?.props?.testID === `project-worktree-drag-${ids[0]}` ? node : node?.children?.flat(Infinity).map(child => find(child as Element)).find(Boolean);
  const handle = find(tree);
  const touch = (dy = 0, dx = 0, count = 1) => ({ identifier: 1, pageX: 51 + dx, pageY: 356 + dy, touches: Array.from({ length: count }, (_, i) => ({ identifier: i + 1 })) });
  const invoke = (key: string, event = touch()) => (handle?.props[key] as ((event: unknown) => unknown) | undefined)?.(event);
  const raw = handle?.props.onTouchStartCapture ? {
    onPanResponderGrant: () => { invoke('onTouchStartCapture'); invoke('onResponderGrant'); },
    onPanResponderMove: (_: unknown, g: Gesture) => invoke('onResponderMove', touch(g.dy, g.dx)),
    onPanResponderRelease: (_: unknown, g: Gesture) => invoke('onResponderRelease', touch(g.dy, g.dx, 0)),
    onPanResponderTerminate: () => invoke('onResponderTerminate'),
  } : undefined;
  return { pan: (raw ?? pans.at(-1)) as Pan, swipe: pans[0]!, handle, invoke, touch, leased: () => leased, audit, cancelScroll: () => stops.forEach(stop => stop()), tree, props, commit, measured, refs, rows, reconcile: () => effects.forEach(fn => fn()), retire: () => { epoch++; effects.forEach(fn => fn()); }, close: () => { current = false; effects.forEach(fn => fn()); }, reopen: () => { current = true; }, pending: (keys: string[]) => { pending = keys; }, dispose: () => cleanups.forEach(fn => fn()) };
}
const g = (dy: number) => ({ dx: 0, dy });
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe('production Projects drag closures', () => {
  it('claims the actual Detail handle before Scroll/Back compete, returns native grant true and releases on a tap', () => {
    const f = fixture('WorktreeRow');
    expect(f.handle?.props.onTouchStartCapture).toBeTypeOf('function');
    f.invoke('onTouchStartCapture'); expect(f.leased()).toBe(true);
    expect(f.invoke('onStartShouldSetResponder')).toBe(true);
    expect(f.invoke('onResponderGrant')).toBe(true);
    expect(f.invoke('onResponderTerminationRequest')).toBe(false);
    f.invoke('onTouchEndCapture', f.touch(0, 0, 0)); expect(f.leased()).toBe(false);
    expect(f.commit).not.toHaveBeenCalled();
  });
  it('the actual Detail gates native swipe-back and root scrolling with the same handle lease, never permanently disables Back', () => {
    const declaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'ProjectDetail')!;
    const expressions: Record<string, string> = {};
    const visit = (node: ts.Node) => {
      if (ts.isJsxOpeningElement(node)) {
        const tag = node.tagName.getText(parsed);
        for (const attribute of node.attributes.properties) if (ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
          const key = attribute.name.getText(parsed);
          if ((tag === 'NavPage' && key === 'popOnSwipe') || (tag === 'Scroll' && key === 'scrollable')) expressions[key] = attribute.initializer.expression.getText(parsed);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(declaration);
    const scrollDeclaration = parsed.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'createProjectsScroll')!;
    const context = vm.createContext({ signal, result: undefined });
    vm.runInContext(ts.transpileModule(`${scrollDeclaration.getText(parsed)}\nresult = createProjectsScroll();`, { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, context);
    const scroll = context.result as { drag: { claim(): () => void }; dragging(): boolean };
    for (const key of ['popOnSwipe', 'scrollable']) {
      expect(expressions[key]).toBeDefined(); expect(vm.runInNewContext(expressions[key]!, { scroll })).toBe(true);
      const release = scroll.drag.claim(); expect(vm.runInNewContext(expressions[key]!, { scroll })).toBe(false);
      release(); expect(vm.runInNewContext(expressions[key]!, { scroll })).toBe(true);
    }
  });
  it('routes a real raw vertical handle drag to one write after delayed measurement, restores the lease before ACK', async () => {
    const f = fixture('WorktreeRow', ['/a', '/b', '/c'], [362, 426, 490]);
    f.invoke('onTouchStartCapture'); f.invoke('onResponderGrant');
    for (let i = 1; i <= 18; i++) f.invoke('onResponderMove', f.touch(i * 64 / 18));
    f.invoke('onTouchEndCapture', f.touch(64, 0, 0));
    f.invoke('onResponderRelease', f.touch(64, 0, 0));
    expect(f.leased()).toBe(false); await settle();
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(f.props.project, '/a', '/b');
  });
  it.each(['cancelScroll', 'close', 'retire', 'dispose'] as const)('restores the handle lease on %s and fences delayed geometry', async action => {
    const f = fixture('WorktreeRow'); f.invoke('onTouchStartCapture'); f.invoke('onResponderGrant');
    f.invoke('onResponderMove', f.touch(300)); f[action]();
    expect(f.leased()).toBe(false); f.invoke('onResponderRelease', f.touch(300, 0, 0));
    await settle(); expect(f.commit).not.toHaveBeenCalled();
  });
  it('does not commit a raw gesture which never received native grant', async () => {
    const f = fixture('WorktreeRow'); f.invoke('onTouchStartCapture'); f.invoke('onTouchMoveCapture', f.touch(300));
    f.invoke('onTouchEndCapture', f.touch(300, 0, 0)); await settle();
    expect(f.leased()).toBe(false); expect(f.commit).not.toHaveBeenCalled();
    expect(f.audit).not.toHaveBeenCalledWith('grant');
  });
  it('keeps a diagonal handle gesture out of the parent swipe owner and restores Back after release', async () => {
    const f = fixture('WorktreeRow', ['/a', '/b', '/c'], [362, 426, 490]);
    f.invoke('onTouchStartCapture'); expect(f.leased()).toBe(true); f.invoke('onResponderGrant');
    f.invoke('onResponderMove', f.touch(64, 152));
    expect(f.swipe.onMoveShouldSetPanResponder(null, { dx: 152, dy: 64 })).toBe(false);
    expect(f.invoke('onResponderTerminationRequest')).toBe(false);
    f.invoke('onResponderRelease', f.touch(64, 152, 0)); await settle();
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(f.props.project, '/a', '/b'); expect(f.leased()).toBe(false);
    expect(f.swipe.onMoveShouldSetPanResponder(null, { dx: 152, dy: 64 })).toBe(true);
  });
  it('uses the final lift coordinate when geometry arrived before release, then ignores duplicate native release', async () => {
    const f = fixture('WorktreeRow', ['/a', '/b', '/c'], [362, 426, 490]);
    f.pan.onPanResponderGrant(); await settle(); f.invoke('onTouchMoveCapture', f.touch(128));
    f.invoke('onTouchEndCapture', f.touch(64, 0, 0)); f.invoke('onResponderRelease', f.touch(64, 0, 0)); await settle();
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(f.props.project, '/a', '/b');
    for (const phase of ['start', 'claim', 'grant', 'measured', 'activate', 'release', 'drop']) expect(f.audit).toHaveBeenCalledWith(phase);
    expect(f.audit.mock.calls.filter(([phase]) => phase === 'drop')).toHaveLength(1);
  });
  it('a resumed same-path replacement keeps its new header ref when the old row cleanup runs after registration', async () => {
    const old = fixture('WorktreeRow');
    const header = (node: Element): Element | undefined => typeof node?.props?.ref === 'function' ? node : node?.children?.flat(Infinity).map(child => header(child as Element)).find(Boolean);
    const oldRef = { measure: () => old.measured('/a') };
    (header(old.tree)!.props.ref as (ref: typeof oldRef) => void)(oldRef);
    const resumed = fixture('WorktreeRow', ['/a', '/b', '/c'], [28, 328, 388], old.refs);
    const newRef = { measure: () => resumed.measured('/a') };
    (header(resumed.tree)!.props.ref as (ref: typeof newRef) => void)(newRef);
    old.dispose();
    expect(resumed.refs.get('/a')).toBe(newRef);
    resumed.pan.onPanResponderGrant(); resumed.pan.onPanResponderMove(null, g(300)); resumed.pan.onPanResponderRelease(null, g(300)); await settle();
    expect(resumed.commit).toHaveBeenCalledExactlyOnceWith(resumed.props.project, '/a', '/b');
    expect(resumed.audit).not.toHaveBeenCalledWith('unmeasured');
    resumed.dispose(); expect(resumed.refs.has('/a')).toBe(false);
  });
  it('production page operations retire the held gesture, wait for root confirmation and admit a fresh same-Host gesture with a new sender', async () => {
    const scope = createProjectsScopeVM(() => ({ status: 200, body: {} }));
    const operations = scope.operations.createPageOperations(), before = operations.capture();
    const f = fixture('WorktreeRow'); f.props.controller.current = operations.current;
    f.pan.onPanResponderGrant(); expect(f.leased()).toBe(true);
    scope.context.active = false; scope.context.runtimeReady.set(false); scope.advanceGeneration(); scope.flush(); f.reconcile();
    expect(f.leased()).toBe(false); expect(before.current()).toBe(false);
    f.invoke('onTouchEndCapture', f.touch(300, 0, 0)); await settle(); expect(f.commit).not.toHaveBeenCalled();
    scope.context.active = true; scope.flush(); f.reconcile();
    expect(operations.current()).toBe(false); f.invoke('onTouchStartCapture'); expect(f.leased()).toBe(false);
    scope.state.app.runtimeScope.set({ hostID: 'projects-fixture', lease: 'confirmed-resume-lease' });
    scope.context.runtimeReady.set(true); scope.flush(); f.reconcile();
    const after = operations.capture(); expect(after).not.toBe(before); expect(after.request).not.toBe(before.request);
    expect(before.current()).toBe(false); expect(after.current()).toBe(true);
    f.pan.onPanResponderGrant(); f.pan.onPanResponderMove(null, g(300)); f.pan.onPanResponderRelease(null, g(300)); await settle();
    expect(f.commit).toHaveBeenCalledExactlyOnceWith(f.props.project, '/a', '/b');
    f.dispose(); scope.dispose();
  });
  it('cancels a second finger or native cancellation and never admits their release', async () => {
    for (const multi of [false, true]) {
      const f = fixture('WorktreeRow'); f.invoke('onTouchStartCapture'); f.invoke('onResponderGrant');
      f.invoke('onResponderMove', f.touch(300));
      if (multi) f.invoke('onTouchStartCapture', f.touch(300, 0, 2)); else f.invoke('onTouchCancelCapture');
      expect(f.leased()).toBe(false); f.invoke('onResponderRelease', f.touch(300, 0, 0)); await settle();
      expect(f.commit).not.toHaveBeenCalled();
    }
  });
  it('awaits a genuinely delayed native measure after release but fences page close/reopen before it resolves', async () => {
    for (const close of [false, true]) {
      const f = fixture('WorktreeRow'); let resolve!: (value: Awaited<ReturnType<typeof f.measured>>) => void;
      f.refs.set('/b', { measure: () => new Promise(done => { resolve = done; }) });
      f.pan.onPanResponderGrant(); f.pan.onPanResponderMove(null, g(300)); f.pan.onPanResponderRelease(null, g(300));
      expect(f.leased()).toBe(false); expect(f.commit).not.toHaveBeenCalled();
      if (close) { f.close(); f.reopen(); }
      resolve({ pagePosition: { x: 0, y: 300 }, bounds: { size: { width: 300, height: 56 } } }); await settle();
      expect(f.commit).toHaveBeenCalledTimes(close ? 0 : 1);
    }
  });
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
    f.pan.onPanResponderGrant(); f.pan.onPanResponderMove(null, g(300)); f.pan.onPanResponderRelease(null, g(300)); await settle();
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
      f.pan.onPanResponderGrant(); f.pan.onPanResponderMove(null, g(300)); f.pan.onPanResponderRelease(null, g(300));
      if (dispose) f.dispose(); else f.pan.onPanResponderTerminate();
      await settle(); expect(f.commit).not.toHaveBeenCalled();
    }
  });
  it.each(['WorktreeRow'])('%s rejects changed membership/order and missing geometry', async name => {
    const f = fixture(name); f.refs.delete('/b');
    f.pan.onPanResponderGrant(); f.pan.onPanResponderMove(null, g(300)); f.pan.onPanResponderRelease(null, g(300)); await settle();
    expect(f.commit).not.toHaveBeenCalled();
    const changed = fixture(name); changed.pan.onPanResponderGrant(); changed.rows.reverse();
    changed.pan.onPanResponderRelease(null, g(300)); await settle(); expect(changed.commit).not.toHaveBeenCalled();
  });
  it('matches the editor handle distance 8 sensor while rejecting a pending order gesture', async () => {
    for (const distance of [8, 9]) {
      const f = fixture('WorktreeRow', ['/a', '/b'], [28, 37]);
      f.pan.onPanResponderGrant(); f.pan.onPanResponderMove(null, g(distance)); f.pan.onPanResponderRelease(null, g(distance)); await settle();
      expect(f.commit).toHaveBeenCalledTimes(distance === 8 ? 0 : 1);
    }
    const f = fixture('WorktreeRow'); f.pending(['tree-order:/repo']);
    f.invoke('onTouchStartCapture'); expect(f.invoke('onStartShouldSetResponder')).toBe(false); expect(f.leased()).toBe(false);
  });
  it('suppresses the selection click following a worktree drag', async () => {
    const f = fixture('WorktreeRow');
    const find = (node: Element): Element | undefined => node?.props?.testID === 'project-worktree-/a' ? node : node?.children?.flat(Infinity).map(child => find(child as Element)).find(Boolean);
    const button = find(f.tree)!;
    f.pan.onPanResponderGrant(); f.pan.onPanResponderMove(null, g(300)); f.pan.onPanResponderRelease(null, g(300)); await settle();
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
