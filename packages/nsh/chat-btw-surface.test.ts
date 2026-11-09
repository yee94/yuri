import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as btw from './chat-btw-model';
import * as presentation from './chat-btw-presentation';
import * as sheets from './sheet-presentation';

type Props = Record<string, any>;
type Node = { type: string | ((props: Props) => unknown); props: Props; children: Array<() => unknown> };
const directory = path.dirname(fileURLToPath(import.meta.url));

/** Production lazy JSX callback seam, including NativeSheet's real iOS finish.
 * No UIKit geometry, device, Host or model execution is represented here. */
function fixture(immediate = false) {
  let tracking: (() => void) | undefined;
  const pending = new Set<() => void>();
  function signal<T>(initial: T) {
    let value = initial;
    const listeners = new Set<() => void>();
    return Object.assign(() => { if (tracking) listeners.add(tracking); return value; }, {
      set(next: T) { if (next === value) return; value = next; listeners.forEach(work => pending.add(work)); },
    });
  }
  function effect(work: () => void) {
    const run = () => { const prior = tracking; tracking = run; try { work(); } finally { tracking = prior; } };
    run();
  }
  function untracked<T>(read: () => T) { const prior = tracking; tracking = undefined; try { return read(); } finally { tracking = prior; } }
  function tick() {
    for (let count = 0; pending.size; count++) {
      if (count > 100) throw new Error('BTW surface did not settle');
      const batch = [...pending]; pending.clear(); batch.forEach(work => work());
    }
  }
  const jsx = (type: Node['type'], props: Props | null, ...children: Node['children']): Node => ({ type, props: props ?? {}, children });
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
  const font = signal({ fontStatus: 'loading', unsupportedFonts: [] as string[] });
  const modules: Record<string, unknown> = {
    nsh: { signal, effect, computed: (read: () => unknown) => read, untracked, cleanup() {}, Scroll: 'Scroll', Text: 'Text', View: 'View',
      platform: { os: 'ios' }, keymap: { bind: () => () => {} }, nativeComponent: () => 'Presentation' },
    'nsh/base': { Button: 'Button', Input: 'Input', TextView: 'TextView', Dialog: 'Dialog', Sheet: 'FallbackSheet' },
    './appearance': { nativeChatTextStyle: () => { font(); return {}; }, nativeCodeTextViewStyles: () => { font(); return {}; }, nativeDensity: () => { font(); return { forms: { action: {}, stack: {} }, sheetSpacing: {} }; },
      nativeAppearance: { current: font, error: () => '', saving: () => false }, refreshNativeAppearance: async () => {}, retryNativeAppearanceFonts: async () => {} },
    './native-density': { nativeSheetSpacing: () => [] }, './sheet-presentation': sheets,
    './i18n': { t: (key: string) => key }, './runtime': { bindRequest: () => { throw new Error('No Host access'); } },
    './chat-btw-model': btw, './chat-btw-presentation': presentation,
  };
  function evaluate(filename: string): Props {
    const output = ts.transpileModule(readFileSync(path.join(directory, filename), 'utf8'), { fileName: filename,
      compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { after: [lazy] } }).outputText;
    const exports = {};
    vm.runInNewContext(output, { exports, jsx, Each: 'Each', If: 'If', require: (id: string) => {
      if (!(id in modules)) throw new Error('Unexpected BTW dependency: ' + id);
      return modules[id];
    } });
    return exports;
  }
  modules['./native-sheet'] = evaluate('native-sheet.tsx');
  const surface = evaluate('chat-btw.tsx');
  modules['./error-notice'] = { NativeErrorNotice: 'NativeErrorNotice' };
  const feedback = evaluate('appearance-feedback.tsx');
  const revision = signal(0); let serial = 0;
  const generate = vi.fn(() => immediate ? Promise.resolve('Synthetic answer `code`\n\n```swift\nlet count = 2\n```') : new Promise<string>(() => {}));
  const active = signal(true);
  const makeOwner = (hostID = 'host', lease = 'lease') => btw.createBtwOwner({ runtime: { hostID, lease }, sessionID: 'session', directory: '/project' }, generate, active, () => revision.set(++serial));
  const owner = signal(makeOwner());
  type Mounted = { read: () => Node[] };
  function mount(value: unknown): Mounted {
    if (Array.isArray(value)) { const children = value.map(mount); return { read: () => children.flatMap(child => child.read()) }; }
    if (!value || typeof value !== 'object' || !('type' in value)) return { read: () => [] };
    const node = value as Node;
    if (typeof node.type === 'function') {
      const props = Object.create(node.props);
      Object.defineProperty(props, 'children', { get: () => node.children.map(child => child()) });
      const child = mount(untracked(() => (node.type as (props: Props) => unknown)(props)));
      return { read: () => [node, ...child.read()] };
    }
    if (node.type === 'Each') {
      const items = new Map<unknown, Mounted>();
      return { read: () => {
        const keys = node.props.of as unknown[];
        for (const key of items.keys()) if (!keys.includes(key)) items.delete(key);
        return keys.flatMap(key => {
          if (!items.has(key)) items.set(key, mount((node.children[0]!() as (item: () => unknown) => unknown)(() => key)));
          return items.get(key)!.read();
        });
      } };
    }
    const children = node.children.map(read => { let mounted: Mounted | undefined; return () => (mounted ??= mount(read())).read(); });
    return { read: () => node.type === 'If' && !node.props.when ? [] : [node, ...children.flatMap(read => read())] };
  }
  const mounted = mount(surface.NativeBtwSheet({ get owner() { return owner(); }, state: () => { revision(); return owner().snapshot(); }, get active() { return active(); } }));
  const notice = mount(feedback.NativeAppearanceFeedback());
  const nodes = () => { tick(); const result = mounted.read(); tick(); return result; };
  const nativeSheet = () => nodes().find(node => node.type === (modules['./native-sheet'] as Props).NativeSheet)!;
  const nativePresentation = () => nodes().find(node => node.type === 'Presentation')!;
  const intent = (question: string) => { const result = btw.acceptBtwIntent(owner(), { question }, false); tick(); return result; };
  return { owner, makeOwner, generate, intent, tick, nodes, nativeSheet, nativePresentation, font, notice, active };
}

describe('BTW real NativeSheet props and completion callback ownership', () => {
  it('keeps the actual Sheet/Dialog/answer root across immediate generation and actual font-feedback completion without invented native opened events', async () => {
    const f = fixture(true);
    expect(f.intent('fixture code question')).toBe('accepted');
    const sheet = f.nativeSheet(), native = f.nativePresentation();
    const dialog = f.nodes().find(node => node.type === 'Dialog');
    expect(dialog?.props.open).toBe(true);
    await Promise.resolve(); await Promise.resolve(); f.tick();
    expect(f.owner().snapshot().turns[0]?.status).toBe('complete');
    f.font.set({ fontStatus: 'unsupported', unsupportedFonts: ['fixture-font'] }); f.tick();
    expect(f.notice.read().some(node => node.type === 'NativeErrorNotice')).toBe(true);
    expect(f.nativeSheet()).toBe(sheet); expect(f.nativePresentation()).toBe(native);
    expect(f.nodes().find(node => node.type === 'Dialog')).toBe(dialog);
    expect(f.nodes().find(node => node.type === 'TextView')?.props.markdown).toContain('Synthetic answer `code`');
    expect(native.props.diagnostic).toMatchObject({ owner: f.owner().diagnosticID, ticket: 1, intent: 1, ownerGeneration: 1, open: true, active: true, current: true, status: 'complete' });
    expect(Object.keys(native.props.diagnostic).sort()).toEqual(['active', 'current', 'intent', 'open', 'owner', 'ownerGeneration', 'revision', 'status', 'ticket']);
    expect(JSON.stringify(native.props.diagnostic)).not.toContain('Synthetic');
    expect(sheet.props.open).toBe(true);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('reports real active/current retirement separately from content and native presentation events', () => {
    const f = fixture(); f.intent('fixed question');
    const native = f.nativePresentation();
    f.active.set(false); f.tick();
    expect(native.props.diagnostic).toMatchObject({ active: false, current: false, status: 'pending' });
    expect(f.nativeSheet().props.open).toBe(false);
    expect(JSON.stringify(native.props.diagnostic)).not.toContain('fixed question');
  });
  it('old onOpenChange(false) cannot close a newly accepted question; current close still works', () => {
    const f = fixture(); f.intent('');
    const old = f.nativeSheet(); const oldFalse = old.props.onOpenChange, oldClose = old.props.onClose;
    expect(f.intent('new question')).toBe('accepted');
    expect(old.props.open).toBe(false);
    oldFalse({ open: false, reason: 'swipe' }); f.tick();
    expect(f.owner().snapshot()).toMatchObject({ open: true, turns: [{ question: 'new question', status: 'pending' }] });
    oldClose(); f.tick();
    const current = f.nativeSheet(); expect(current).not.toBe(old); expect(current.props.open).toBe(true);
    oldFalse({ open: false }); oldClose();
    expect(f.owner().snapshot().turns).toHaveLength(1);
    current.props.onOpenChange({ open: false }); f.tick();
    expect(f.owner().snapshot()).toMatchObject({ open: false, turns: [] });
  });

  it('real NativeSheet iOS dismissed finish cannot clear a replacement owner', () => {
    const f = fixture(); f.intent('');
    const native = f.nativePresentation(), oldFinish = native.props.onDismissed, generation = native.props.generation;
    const oldOwner = f.owner();
    const next = f.makeOwner('other-host', 'other-lease'); f.owner.set(next);
    expect(f.intent('replacement question')).toBe('accepted');
    oldFinish({ generation, interactive: true }); f.tick();
    expect(next.snapshot()).toMatchObject({ open: true, turns: [{ question: 'replacement question', status: 'pending' }] });
    expect(oldOwner.snapshot().open).toBe(false);
    const current = f.nativePresentation(); expect(current).not.toBe(native);
    oldFinish({ generation, interactive: true });
    expect(next.snapshot().open).toBe(true);
    current.props.onDismissed({ generation: current.props.generation, interactive: true }); f.tick();
    expect(next.snapshot()).toMatchObject({ open: false, turns: [] });
  });

  it('real NativeSheet interactive completion preserves a new question on the same owner', () => {
    const f = fixture(); f.intent('');
    const native = f.nativePresentation(), finish = native.props.onDismissed, generation = native.props.generation;
    expect(f.intent('new same-owner question')).toBe('accepted');
    finish({ generation, interactive: true }); f.tick();
    expect(f.owner().snapshot()).toMatchObject({ open: true, turns: [{ question: 'new same-owner question', status: 'pending' }] });
    expect(f.nativePresentation()).not.toBe(native);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('serial close/clear/reopen keeps the latest admitted question and never revives cleared turns', () => {
    const f = fixture(); f.intent('old question');
    const old = f.nativeSheet(), oldFalse = old.props.onOpenChange, oldClose = old.props.onClose;
    f.owner().close(); f.tick();
    expect(f.intent('first reopen')).toBe('accepted');
    f.owner().close(); f.tick();
    expect(f.intent('second reopen')).toBe('accepted');
    expect(f.nodes().filter(node => node.type === old.type)).toHaveLength(1);
    oldFalse({ open: false }); oldClose(); f.tick();
    expect(f.owner().snapshot()).toMatchObject({ open: true, turns: [{ question: 'second reopen', status: 'pending' }] });
    expect(f.nativeSheet().props.open).toBe(true);
    expect(f.generate).toHaveBeenCalledTimes(3);
  });

  it('coalesces bare reopen presentation intents, preserves accepted question, and explicitly blocks concurrent questions', () => {
    const f = fixture(); f.intent(''); const old = f.nativeSheet();
    f.owner().close(); f.tick();
    expect(f.intent('')).toBe('accepted');
    expect(f.intent('accepted while closing')).toBe('accepted');
    expect(f.intent('must stay in main composer')).toBe('blocked');
    old.props.onOpenChange({ open: false }); old.props.onClose(); f.tick();
    expect(f.owner().snapshot()).toMatchObject({ open: true, turns: [{ question: 'accepted while closing', status: 'pending' }] });
    expect(f.nativeSheet().props.open).toBe(true);
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('ordinary input edits do not invalidate the currently presented close ticket', () => {
    const f = fixture(); f.intent(''); const sheet = f.nativeSheet();
    f.owner().edit('typing'); f.tick();
    sheet.props.onOpenChange({ open: false }); sheet.props.onClose(); f.tick();
    expect(f.owner().snapshot()).toMatchObject({ open: false, draft: '', turns: [] });
    expect(f.nativeSheet()).toBeUndefined();
  });
});
