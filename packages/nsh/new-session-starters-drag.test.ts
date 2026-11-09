import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as helpers from './new-session-ui-helpers';
import * as picker from './chat-models-helpers';
import * as model from './model';

type Node = { type: string; props: Record<string, any>; children: unknown[] };
const root = path.dirname(fileURLToPath(import.meta.url));
const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
const flush = async () => { for (let index = 0; index < 100; index++) await Promise.resolve(); };
const event = (x: number, y: number, fingers = 1) => ({ pageX: x, pageY: y, touches: Array.from({ length: fingers }, (_, index) => ({ identifier: index, pageX: x, pageY: y })) });
const call = (node: Node, name: string, value?: unknown) => { if (typeof node.props[name] !== 'function') throw new Error(`Missing production callback ${name}`); return node.props[name](value); };

/** Full production Starters JSX/controller; only native widgets and measurement are ports. */
async function fixture(options: { desktop?: boolean; global?: helpers.DraftStarterRef[]; project?: helpers.DraftStarterRef[]; commands?: model.Row[]; skills?: model.Row[]; catalog?: Promise<unknown> } = {}) {
  vi.useFakeTimers();
  const source = ts.createSourceFile('new-session-page.tsx', readFileSync(path.join(root, 'new-session-page.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === 'NativeNewSessionStarters')!;
  const effects: Array<() => void> = [], cleanups: Array<() => void> = [];
  const active = signal(true), visible = signal(true), submit = vi.fn(), gesture = vi.fn();
  let settings = { draftStarters: options.global ?? [{ type: 'command', name: 'explore' }, { type: 'command', name: 'weigh' }, { type: 'command', name: 'review-accessibility-and-keyboard-navigation' }] };
  let projectConfig = { projectPath: '/fixture/project', keep: { version: 7 }, draftStarters: options.project ?? [] };
  const request = vi.fn(async (url: string, method = 'GET', body?: any) => {
    if (url === '/api/config/settings') { if (method === 'PUT') settings = { ...settings, ...body }; return settings; }
    if (url === '/api/fs/home') return { home: '/fixture/home' };
    if (url.startsWith('/api/fs/read?')) return JSON.stringify(projectConfig);
    if (url === '/api/fs/mkdir') return { success: true };
    if (url === '/api/fs/write') { projectConfig = JSON.parse(body.content); return { success: true }; }
    if (url.startsWith('/api/config/commands/metadata?')) return options.catalog ?? { commands: [{ name: 'review-accessibility-and-keyboard-navigation', scope: 'user' }, ...(options.commands ?? [])] };
    if (url.startsWith('/api/config/skills?')) return { skills: options.skills ?? [] };
    throw new Error(`Unexpected synthetic route ${method} ${url}`);
  });
  const h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Node => {
    const observed = { ...props };
    for (const key of ['when', 'of', 'style', 'open', 'disabled', 'accessibilityElementsHidden']) if (typeof observed[key] === 'function') Object.defineProperty(observed, key, { get: observed[key] as () => unknown });
    return { type, props: observed, children };
  };
  const observe: ts.TransformerFactory<ts.SourceFile> = context => syntax => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && ['when', 'of', 'style', 'open', 'disabled', 'accessibilityElementsHidden'].includes(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node.initializer.expression)));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(syntax, visit) as ts.SourceFile;
  };
  const ports = { ...helpers, ...picker, ...model, signal, computed: (work: () => unknown) => work, untracked: (work: () => unknown) => work(), effect: (work: () => void) => { effects.push(work); work(); }, cleanup: (work: () => void) => cleanups.push(work),
    captureHostRequest: () => request, t: (key: string) => key, token: (key: string) => key, h, Fragment: 'Fragment', If: 'If', Each: 'Each', View: 'View', Text: 'Text', Input: 'Input', Scroll: 'Scroll', Button: 'Button', Icon: 'Icon',
    NativeNewSessionInputAX: 'InputAX', NativeNewSessionModal: 'ModalBoundary', Keyboard: { dismiss: vi.fn() }, windowSize: () => ({ width: 390, height: 844 }), safeArea: () => ({ top: 0, bottom: 0 }), action: '',
  };
  const js = ts.transpileModule(declaration.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' }, transformers: { before: [observe] } }).outputText;
  const create = new Function(...Object.keys(ports), `${js}; return NativeNewSessionStarters;`)(...Object.values(ports));
  const tree: Node = create({ owner: { project: { id: 'fixture', path: '/fixture/project' }, directory: '/fixture/project', current: () => true }, desktop: options.desktop, active, visible, onSubmit: submit, onGestureActiveChange: gesture });
  const instances = new WeakMap<Node, Map<unknown, unknown>>();
  const nodes = (value: unknown): Node[] => {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object' || !('type' in value)) return [];
    const node = value as Node;
    if (node.type === 'If') return nodes(node.props.when ? node.children : node.props.else);
    if (node.type === 'Each') {
      let cache = instances.get(node); if (!cache) { cache = new Map(); instances.set(node, cache); }
      return (node.props.of ?? []).flatMap((item: any) => { const key = item?.id ?? item; if (!cache!.has(key)) cache!.set(key, (node.children[0] as (item: () => unknown) => unknown)(() => item)); return nodes(cache!.get(key)); });
    }
    return [node, ...nodes(node.children)];
  };
  const all = () => nodes(tree);
  const find = (id: string) => { const node = all().find(node => node.props.testID === id); if (!node) throw new Error(`Missing production ID ${id}`); return node; };
  const contains = (node: Node, id: string) => nodes(node).some(child => child.props.testID === id);
  const chip = (name: string) => find(`new-session-preset-${name}`);
  const wrapper = (name: string) => { const node = all().find(node => node.props.onTouchStartCapture && contains(node, `new-session-preset-${name}`)); if (!node) throw new Error(`Missing touch wrapper ${name}`); return node; };
  const hover = (name: string) => { const node = all().find(node => node.props.onMouseEnter && contains(node, `new-session-preset-${name}`)); if (!node) throw new Error(`Missing hover wrapper ${name}`); call(node, 'onMouseEnter'); };
  await flush();
  const measures: Array<ReturnType<typeof vi.fn>> = [];
  const geometry = (name: string, x: number, y: number, width: number) => {
    const measure = vi.fn(async () => ({ pagePosition: { x, y }, bounds: { size: { width, height: 28 } } })); measures.push(measure);
    call(wrapper(name), 'ref', { measure }); call(wrapper(name), 'onLayout', { bounds: { origin: { x: x - 20, y: y - 425 }, size: { width, height: 28 } } }); return measure;
  };
  for (const [name, x, y, width] of [['explore', 20, 425, 90], ['weigh', 120, 425, 130], ['review-accessibility-and-keyboard-navigation', 30, 475, 290]] as const) if (all().some(node => node.props.testID === `new-session-preset-${name}`)) geometry(name, x, y, width);
  const trash = all().find(node => node.props.ref && !node.props.onTouchStartCapture && contains(node, 'new-session-presets-add'))!;
  call(trash, 'ref', { measure: async () => ({ pagePosition: { x: 354, y: 382 }, bounds: { size: { width: 24, height: 28 } } }) });
   const layout = all().find(node => node.props.onLayout && !node.props.onTouchStartCapture)!;
  call(layout, 'onLayout', { bounds: { size: { width: 350, height: 84 } } });
  return { all, find, chip, wrapper, hover, layout, geometry, measures, submit, request, gesture, active, visible,
    mouse: (x: number, y: number, pressedButton: string | null = 'left') => call(layout, 'onMouseMove', { pagePosition: { x, y }, pressedButton }),
    settings: () => settings, projectConfig: () => projectConfig, effects: () => effects.forEach(work => work()), dispose: () => cleanups.splice(0).forEach(work => work()) };
}
afterEach(() => vi.useRealTimers());

describe('homepage chips drag regression (actual production callbacks; synthetic geometry, not UIKit)', () => {
  it('desktop exposes the Web hover remove without replacing plus with the mobile trash or submitting', async () => {
    const f = await fixture({ desktop: true }); f.hover('explore');
    const remove = f.find('new-session-preset-remove-global:command:explore');
    call(f.wrapper('explore'), 'onTouchStartCapture', event(65, 439)); call(remove, 'onPressDown'); call(remove, 'onPress'); await flush();
    expect(f.settings().draftStarters.map(ref => ref.name)).toEqual(['weigh', 'review-accessibility-and-keyboard-navigation']);
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1); expect(f.submit).not.toHaveBeenCalled();
    const source = f.wrapper('weigh'); call(source, 'onTouchStartCapture', event(185, 439)); f.mouse(195, 439); await flush();
    expect(f.all().some(node => node.props.testID === 'new-session-presets-add')).toBe(true);
    expect(f.all().some(node => node.props.testID === 'new-session-presets-trash')).toBe(false); call(source, 'onTouchCancel'); f.dispose();
  });

  it('desktop project hover removal keeps the global group and unrelated project metadata, and stale modal callbacks cannot remove', async () => {
    const f = await fixture({ desktop: true, project: [{ type: 'skill', name: 'local-skill' }], skills: [{ name: 'local-skill', scope: 'project' }] });
    f.geometry('skill-local-skill', 20, 475, 100); call(f.find('new-session-presets-expand'), 'onPress'); f.hover('skill-local-skill');
    const remove = f.find('new-session-preset-remove-project:skill:local-skill'), globals = f.settings().draftStarters;
    call(remove, 'onPressDown'); call(remove, 'onPress'); await flush();
    expect(f.projectConfig()).toMatchObject({ projectPath: '/fixture/project', keep: { version: 7 }, draftStarters: [] });
    expect(f.settings().draftStarters).toBe(globals); expect(f.request.mock.calls.filter(([url]) => url === '/api/fs/write')).toHaveLength(1);
    f.hover('explore'); const stale = f.find('new-session-preset-remove-global:command:explore'); call(f.find('new-session-presets-add'), 'onPress'); f.effects();
    call(stale, 'onPressDown'); call(stale, 'onPress'); await flush();
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); expect(f.submit).not.toHaveBeenCalled(); f.dispose();
  });

  it('desktop mouse has no hold activation and preserves click at the exact eight-point boundary', async () => {
    const f = await fixture({ desktop: true }), source = f.wrapper('explore');
    call(source, 'onTouchStartCapture', event(65, 439)); call(f.chip('explore'), 'onPressDown');
    await vi.advanceTimersByTimeAsync(500); f.mouse(73, 439); await flush();
    expect(f.measures.every(measure => measure.mock.calls.length === 0)).toBe(true);
    call(source, 'onTouchEndCapture', event(73, 439, 0)); call(f.chip('explore'), 'onPress');
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); f.dispose();
  });

  it('desktop mouse starts immediately after eight points and commits the actual release once across wrapped rows', async () => {
    const f = await fixture({ desktop: true }); call(f.find('new-session-presets-expand'), 'onPress');
    const source = f.wrapper('explore'); call(source, 'onTouchStartCapture', event(65, 439)); call(f.chip('explore'), 'onPressDown');
    f.mouse(73.1, 439); await flush();
    expect(source.props.style.opacity).toBe(0.6); const reads = f.request.mock.calls.length;
    for (let index = 0; index < 100; index++) f.mouse(145 + index % 3, 439);
    expect(f.request).toHaveBeenCalledTimes(reads); f.measures.forEach(measure => expect(measure).toHaveBeenCalledTimes(1));
    call(source, 'onTouchEndCapture', event(145, 489, 0)); call(source, 'onPanEnd', { translation: { x: 80, y: 50 }, cancelled: false });
    call(f.chip('explore'), 'onPress'); await flush();
    expect(f.settings().draftStarters.map(ref => ref.name)).toEqual(['weigh', 'review-accessibility-and-keyboard-navigation', 'explore']);
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1); expect(f.submit).not.toHaveBeenCalled(); f.dispose();
  });

  it('desktop release waits for its single measurement and uses PanEnd translation if the final mouse move is absent', async () => {
    const f = await fixture({ desktop: true }), source = f.wrapper('explore'); let resolve!: (value: unknown) => void;
    call(source, 'ref', { measure: () => new Promise(done => { resolve = done; }) });
    call(source, 'onTouchStartCapture', event(65, 439)); f.mouse(75, 439);
    call(source, 'onPanEnd', { translation: { x: 120, y: 0 }, cancelled: false });
    call(f.chip('explore'), 'onPressDown'); call(f.chip('explore'), 'onPress');
    expect(f.submit).not.toHaveBeenCalled(); expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0);
    resolve({ pagePosition: { x: 20, y: 425 }, bounds: { size: { width: 90, height: 28 } } }); await flush();
    expect(f.settings().draftStarters.map(ref => ref.name)).toEqual(['weigh', 'explore', 'review-accessibility-and-keyboard-navigation']);
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1); f.dispose();
  });

  it.each(['cancel', 'button-up', 'modal', 'retired', 'reflow'] as const)('desktop %s fences pending geometry and cannot write or submit', async reason => {
    const f = await fixture({ desktop: true }), source = f.wrapper('explore'); let resolve!: (value: unknown) => void;
    call(source, 'ref', { measure: () => new Promise(done => { resolve = done; }) });
    call(source, 'onTouchStartCapture', event(65, 439)); f.mouse(185, 439);
    if (reason === 'cancel') { call(source, 'onTouchCancel'); call(source, 'onPanEnd', { translation: { x: 120, y: 0 }, cancelled: false }); }
    else if (reason === 'button-up') f.mouse(185, 439, null);
    else if (reason === 'modal') { call(f.find('new-session-presets-add'), 'onPress'); f.effects(); }
    else if (reason === 'retired') { f.active.set(false); f.effects(); }
    else call(f.layout, 'onLayout', { bounds: { size: { width: 250, height: 112 } } });
    resolve({ pagePosition: { x: 20, y: 425 }, bounds: { size: { width: 90, height: 28 } } }); await flush();
    call(source, 'onTouchEndCapture', event(185, 439, 0)); call(f.chip('explore'), 'onPress');
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); expect(f.submit).not.toHaveBeenCalled(); f.dispose();
  });
  it('keeps the ordinary short tap as one submit without any preset write', async () => {
    const f = await fixture(), source = f.wrapper('explore');
    call(source, 'onTouchStartCapture', event(65, 439)); call(f.chip('explore'), 'onPressDown');
    await vi.advanceTimersByTimeAsync(100); call(source, 'onTouchEndCapture', event(65, 439, 0)); call(f.chip('explore'), 'onPress');
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.submit.mock.calls[0]![0].id).toBe('global:command:explore');
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); f.dispose();
  });

  it('does not clip a lifted chip when the collapsed single row is dragged downward across wrapped rows', async () => {
    const f = await fixture(), source = f.wrapper('explore');
    const clip = f.all().find(node => node.props.style?.maxHeight === 28 && node.props.style?.overflow === 'hidden')!;
    expect(clip).toBeDefined();
    call(source, 'onTouchStartCapture', event(65, 439)); await vi.advanceTimersByTimeAsync(200);
    call(source, 'onResponderMove', event(100, 500));
    expect(clip.props.style.overflow).not.toBe('hidden');
    expect(clip.props.style.maxHeight).toBe(28);
    const offrow = f.wrapper('review-accessibility-and-keyboard-navigation');
    expect(offrow.props.style).toMatchObject({ opacity: 0, pointerEvents: 'none' });
    expect(f.submit).not.toHaveBeenCalled(); expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); f.dispose();
  });

  it('collapsed offrow chips are hidden from AX and disabled before any hold, and expanded restores them', async () => {
    const f = await fixture(), hidden = f.wrapper('review-accessibility-and-keyboard-navigation'), chip = f.chip('review-accessibility-and-keyboard-navigation');
    expect(hidden.props.accessibilityElementsHidden).toBe(true); expect(chip.props.disabled).toBe(true);
    call(hidden, 'onTouchStartCapture', event(175, 489)); call(chip, 'onPressDown'); call(chip, 'onPress'); await vi.advanceTimersByTimeAsync(200);
    expect(f.submit).not.toHaveBeenCalled(); expect(hidden.props.onMoveShouldSetResponderCapture()).toBe(false);
    call(hidden, 'onTouchEndCapture'); call(f.find('new-session-presets-expand'), 'onPress');
    expect(hidden.props.accessibilityElementsHidden).toBe(false); expect(chip.props.disabled).toBe(false);
    call(hidden, 'onTouchStartCapture', event(175, 489)); await vi.advanceTimersByTimeAsync(200);
    expect(hidden.props.onMoveShouldSetResponderCapture()).toBe(true); call(hidden, 'onTouchCancel'); f.dispose();
  });

  it('cancels a held gesture when the plus sheet opens, and rejects retained chip callbacks beneath it', async () => {
    const f = await fixture(), source = f.wrapper('explore'), chip = f.chip('explore'), add = f.find('new-session-presets-add');
    call(source, 'onTouchStartCapture', event(65, 439)); call(chip, 'onPressDown');
    call(add, 'onPress'); f.effects(); await vi.advanceTimersByTimeAsync(250);
    expect(f.gesture.mock.calls.at(-1)).toEqual([false]);
    expect(f.all().some(node => node.props.testID === 'new-session-presets-trash')).toBe(false);
    call(source, 'onTouchEndCapture', event(65, 439, 0)); call(chip, 'onPress'); expect(f.submit).not.toHaveBeenCalled(); f.dispose();
  });

  it('cannot rearm a cancelled multi-touch gesture through a later native pressDown', async () => {
    const f = await fixture(), source = f.wrapper('explore'), chip = f.chip('explore');
    call(source, 'onTouchStartCapture', event(65, 439, 2)); call(chip, 'onPressDown');
    call(source, 'onTouchEndCapture', event(65, 439, 0)); call(chip, 'onPress');
    expect(f.submit).not.toHaveBeenCalled(); expect(f.gesture.mock.calls.at(-1)?.[0]).not.toBe(true); f.dispose();
  });

  it('cancels frozen geometry on a real chips width reflow instead of persisting an obsolete target', async () => {
    const f = await fixture(), source = f.wrapper('explore');
    call(source, 'onTouchStartCapture', event(65, 439)); await vi.advanceTimersByTimeAsync(200);
    call(source, 'onResponderMove', event(185, 439));
    call(f.layout, 'onLayout', { bounds: { size: { width: 250, height: 112 } } });
    expect(f.gesture.mock.calls.at(-1)).toEqual([false]);
    call(source, 'onResponderRelease', event(185, 439, 0)); await flush();
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); expect(f.submit).not.toHaveBeenCalled(); f.dispose();
  });

  it('translates unequal-width neighbors across rows and persists only the global order once on release', async () => {
    const f = await fixture(); call(f.find('new-session-presets-expand'), 'onPress');
    const source = f.wrapper('explore'), next = f.wrapper('weigh'), last = f.wrapper('review-accessibility-and-keyboard-navigation');
    call(source, 'onTouchStartCapture', event(65, 439)); await vi.advanceTimersByTimeAsync(200);
    call(source, 'onResponderMove', event(145, 489));
    expect(next.props.style.transform).toEqual([{ translateX: -100 }, { translateY: 0 }]);
    expect(last.props.style.transform).toEqual([{ translateX: 90 }, { translateY: -50 }]);
    expect(source.props.style.transform).toEqual([{ translateX: 80 }, { translateY: 50 }]);
    expect(source.props.style.transform.every((value: object) => Object.keys(value).every(key => key.startsWith('translate')))).toBe(true);
    const reads = f.request.mock.calls.length;
    for (let index = 0; index < 100; index++) call(source, 'onResponderMove', event(145 + index % 3, 489));
    expect(f.request).toHaveBeenCalledTimes(reads); f.measures.forEach(measure => expect(measure).toHaveBeenCalledTimes(1));
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0);
    call(source, 'onResponderRelease'); call(source, 'onTouchEndCapture'); call(f.chip('explore'), 'onPress'); await flush();
    expect(f.settings().draftStarters.map(ref => ref.name)).toEqual(['weigh', 'review-accessibility-and-keyboard-navigation', 'explore']);
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(1); expect(f.submit).not.toHaveBeenCalled(); f.dispose();
  });

  it.each(['reorder', 'trash', 'cross-group'] as const)('keeps a project command/skill %s within its own source and preserves unrelated config', async intent => {
    const f = await fixture({ project: [{ type: 'command', name: 'local-command' }, { type: 'skill', name: 'local-skill' }], commands: [{ name: 'local-command', scope: 'project' }], skills: [{ name: 'local-skill', scope: 'project' }] });
    f.geometry('local-command', 20, 525, 220); f.geometry('skill-local-skill', 20, 575, 72);
    call(f.layout, 'onLayout', { bounds: { size: { width: 350, height: 178 } } }); call(f.find('new-session-presets-expand'), 'onPress');
    const source = f.wrapper('skill-local-skill'), globals = f.settings().draftStarters;
    call(source, 'onTouchStartCapture', event(56, 589)); await vi.advanceTimersByTimeAsync(200);
    const target = intent === 'reorder' ? event(130, 539) : intent === 'trash' ? event(366, 396) : event(65, 439);
    call(source, 'onResponderMove', target); call(source, 'onResponderRelease'); call(source, 'onTouchEndCapture'); call(f.chip('skill-local-skill'), 'onPress'); await flush();
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); expect(f.settings().draftStarters).toBe(globals);
    expect(f.projectConfig()).toMatchObject({ projectPath: '/fixture/project', keep: { version: 7 } });
    expect(f.projectConfig().draftStarters.map(ref => ref.name)).toEqual(intent === 'reorder' ? ['local-skill', 'local-command'] : intent === 'trash' ? ['local-command'] : ['local-command', 'local-skill']);
    expect(f.request.mock.calls.filter(([url]) => url === '/api/fs/write')).toHaveLength(intent === 'cross-group' ? 0 : 1); expect(f.submit).not.toHaveBeenCalled(); f.dispose();
  });

  it('keeps exact 200ms/6pt sensor boundaries and requires a fresh single-touch start after cancellation', async () => {
    const f = await fixture(), source = f.wrapper('explore'), chip = f.chip('explore');
    call(source, 'onTouchStartCapture', event(65, 439)); call(chip, 'onPressDown'); call(source, 'onTouchMoveCapture', event(71, 439));
    await vi.advanceTimersByTimeAsync(199); expect(source.props.onMoveShouldSetResponderCapture()).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(source.props.onMoveShouldSetResponderCapture()).toBe(true);
    call(source, 'onResponderTerminate'); call(chip, 'onPress'); expect(f.submit).not.toHaveBeenCalled();
    call(source, 'onTouchStartCapture', event(65, 439)); call(chip, 'onPressDown'); call(source, 'onTouchMoveCapture', event(71.1, 439));
    await vi.advanceTimersByTimeAsync(200); expect(source.props.onMoveShouldSetResponderCapture()).toBe(false); call(chip, 'onPress'); expect(f.submit).not.toHaveBeenCalled();
    call(source, 'onTouchStartCapture', event(65, 439)); call(chip, 'onPressDown'); call(source, 'onTouchEndCapture', event(65, 439, 0)); call(chip, 'onPress');
    expect(f.submit).toHaveBeenCalledTimes(1); f.dispose();
  });

  it('still admits fresh native pressDown/press activations without raw touches after expand, cancel and blur', async () => {
    const f = await fixture(), chip = f.chip('explore');
    call(f.find('new-session-presets-expand'), 'onPress');
    call(chip, 'onPressDown'); call(chip, 'onPress'); expect(f.submit).toHaveBeenCalledTimes(1);
    call(f.wrapper('explore'), 'onTouchStartCapture', event(65, 439)); await vi.advanceTimersByTimeAsync(200);
    call(f.wrapper('explore'), 'onBlur'); call(f.wrapper('explore'), 'onTouchEndCapture'); call(chip, 'onPress'); expect(f.submit).toHaveBeenCalledTimes(1);
    call(chip, 'onPressDown'); call(chip, 'onPress'); expect(f.submit).toHaveBeenCalledTimes(2);
    expect(f.gesture.mock.calls.at(-1)).toEqual([false]); f.dispose();
  });

  it('does not let delayed pressDown rearm a hold while the 200ms measurement is still pending', async () => {
    const f = await fixture(), source = f.wrapper('explore'), chip = f.chip('explore'); let resolve!: (value: unknown) => void;
    call(source, 'ref', { measure: () => new Promise(done => { resolve = done; }) });
    call(source, 'onTouchStartCapture', event(65, 439)); await vi.advanceTimersByTimeAsync(200);
    call(chip, 'onPressDown'); call(source, 'onTouchEndCapture'); call(chip, 'onPress'); expect(f.submit).not.toHaveBeenCalled();
    resolve({ pagePosition: { x: 20, y: 425 }, bounds: { size: { width: 90, height: 28 } } }); await flush();
    expect(source.props.onMoveShouldSetResponderCapture()).toBe(false); expect(f.submit).not.toHaveBeenCalled(); f.dispose();
  });

  it('a fresh B touch cannot lend its press admission to a retained A callback', async () => {
    const f = await fixture(), staleA = f.chip('explore');
    call(f.wrapper('explore'), 'onTouchStartCapture', event(65, 439)); call(f.wrapper('explore'), 'onTouchCancel');
    call(f.wrapper('weigh'), 'onTouchStartCapture', event(185, 439)); call(staleA, 'onPressDown'); call(staleA, 'onPress');
    expect(f.submit).not.toHaveBeenCalled(); call(f.wrapper('weigh'), 'onTouchEndCapture'); call(f.chip('weigh'), 'onPress');
    expect(f.submit).toHaveBeenCalledTimes(1); expect(f.submit.mock.calls[0]![0].id).toBe('global:command:weigh'); f.dispose();
  });

  it('retires measured positions when delayed catalog resolution changes the chips inside unchanged row bounds', async () => {
    let resolve!: (value: unknown) => void;
    const catalog = new Promise(done => { resolve = done; });
    const f = await fixture({ catalog }), source = f.wrapper('explore');
    call(source, 'onTouchStartCapture', event(65, 439)); await vi.advanceTimersByTimeAsync(200);
    expect(source.props.onMoveShouldSetResponderCapture()).toBe(true);
    resolve({ commands: [{ name: 'review-accessibility-and-keyboard-navigation', scope: 'user' }] }); await flush(); f.effects();
    expect(source.props.onMoveShouldSetResponderCapture()).toBe(false); expect(f.gesture.mock.calls.at(-1)).toEqual([false]);
    call(source, 'onResponderRelease'); call(f.chip('explore'), 'onPress'); await flush();
    expect(f.request.mock.calls.filter(([, method]) => method === 'PUT')).toHaveLength(0); expect(f.submit).not.toHaveBeenCalled(); f.dispose();
  });

  it('bounds a 128-chip activation to one measurement per chip and does zero catalog or write work during 100 moves', async () => {
    const globals: helpers.DraftStarterRef[] = [{ type: 'command', name: 'explore' }, ...Array.from({ length: 63 }, (_, index) => ({ type: 'command' as const, name: `global-${index}` }))];
    const project: helpers.DraftStarterRef[] = Array.from({ length: 64 }, (_, index) => ({ type: 'skill', name: `project-${index}` }));
    const f = await fixture({ global: globals, project, commands: globals.slice(1).map(ref => ({ name: ref.name, scope: 'user' })), skills: project.map(ref => ({ name: ref.name, scope: 'project' })) });
    globals.slice(1).forEach((ref, index) => f.geometry(ref.name, 20 + index % 2 * 160, 475 + Math.floor(index / 2) * 30, 80 + index % 3 * 20));
    project.forEach((ref, index) => f.geometry(`skill-${ref.name}`, 20 + index % 2 * 160, 1500 + Math.floor(index / 2) * 30, 90 + index % 3 * 20));
    call(f.layout, 'onLayout', { bounds: { size: { width: 350, height: 2500 } } }); call(f.find('new-session-presets-expand'), 'onPress');
    const source = f.wrapper('global-62'); call(source, 'onTouchStartCapture', event(60, 1405)); await vi.advanceTimersByTimeAsync(200);
    const reads = f.request.mock.calls.length; expect(f.measures).toHaveLength(128);
    for (let index = 0; index < 100; index++) call(source, 'onResponderMove', event(60 + index % 4, 1405 - index));
    f.measures.forEach(measure => expect(measure).toHaveBeenCalledTimes(1)); expect(f.request).toHaveBeenCalledTimes(reads);
    call(source, 'onResponderTerminate'); call(f.chip('global-62'), 'onPress'); expect(f.submit).not.toHaveBeenCalled(); f.dispose();
  });
});
