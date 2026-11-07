import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import * as lifecycle from './new-session-modal-owner';

type Node = { type: string; props: Record<string, unknown>; children: unknown[] };
const directory = path.dirname(fileURLToPath(import.meta.url));
function fixture() {
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  const value = signal<string | null>('agent'), active = signal(true), effects: Array<() => void> = [], cleanups: Array<() => void> = [];
  const close = vi.fn(() => value.set(null)), dismissed = vi.fn(), content = vi.fn((mode, enabled, requestClose) => ({ type: 'ActualContentPort', props: { mode, enabled, requestClose }, children: [] }));
  const h = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Node => {
    const attributes = { ...props };
    for (const key of ['open', 'of']) if (typeof attributes[key] === 'function') Object.defineProperty(attributes, key, { get: attributes[key] as () => unknown });
    return { type, props: attributes, children };
  };
  const observe: ts.TransformerFactory<ts.SourceFile> = context => root => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && ['open', 'of'].includes(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node.initializer.expression)));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(root, visit) as ts.SourceFile;
  };
  const source = readFileSync(path.join(directory, 'new-session-modal.tsx'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' }, transformers: { before: [observe] } }).outputText;
  const exports: { NativeNewSessionModal?: (props: Record<string, unknown>) => Node } = {};
  const imports: Record<string, unknown> = {
    nsh: { signal, untracked: (work: () => void) => work(), effect: (work: () => void) => { effects.push(work); work(); }, cleanup: (work: () => void) => cleanups.push(work) },
    './native-sheet': { NativeSheet: 'NativeSheet' }, './new-session-modal-owner': lifecycle,
    './model-picker-presentation': { createModelPickerSheet: () => ({ height: () => 594 }) },
  };
  vm.runInNewContext(js, { exports, h, Fragment: 'Fragment', Each: 'Each', require: (name: string) => { if (!(name in imports)) throw new Error(`Unexpected modal import: ${name}`); return imports[name]; } });
  const root = exports.NativeNewSessionModal!({ get value() { return value(); }, active, onClose: close, onDismiss: dismissed, height: 594, children: content });
  const instances = new WeakMap<Node, Map<unknown, unknown>>();
  function nodes(input: unknown): Node[] {
    if (Array.isArray(input)) return input.flatMap(nodes);
    if (!input || typeof input !== 'object' || !('type' in input)) return [];
    const node = input as Node;
    if (node.type === 'Each') {
      let cache = instances.get(node); if (!cache) { cache = new Map(); instances.set(node, cache); }
      return (node.props.of as unknown[]).flatMap(id => { if (!cache.has(id)) cache.set(id, (node.children[0] as (id: () => unknown) => unknown)(() => id)); return nodes(cache.get(id)); });
    }
    return [node, ...nodes(node.children)];
  }
  return { value, active, close, dismissed, content, render: () => nodes(root), effects: () => effects.forEach(work => work()), dispose: () => cleanups.forEach(work => work()) };
}
const call = (node: Node, name: string, event?: unknown) => (node.props[name] as (event?: unknown) => void)(event);

describe('production new-session system Sheet adapter (VM only, not UIKit)', () => {
  const surface = (page: ReturnType<typeof fixture>) => page.render().find(node => node.type === 'NativeSheet')!;
  it('uses one system surface and retains content until its actual dismissal', () => {
    const page = fixture(), sheet = surface(page);
    expect(sheet.props).toMatchObject({ open: true, closeOnSwipe: true, detents: [.72, .98] });
    expect(page.render().some(node => node.type === 'Dialog' || node.type === 'Sheet')).toBe(false);
    expect(page.content).toHaveBeenCalledTimes(1);
    const enabled = page.content.mock.calls[0]![1] as () => boolean;
    expect(enabled()).toBe(false); call(sheet, 'onOpen'); expect(enabled()).toBe(true);
    call(sheet, 'onOpenChange', { open: false }); page.effects();
    expect(sheet.props.open).toBe(false); expect(enabled()).toBe(false);
    expect(page.dismissed).not.toHaveBeenCalled();
    expect(page.render().some(node => node.type === 'ActualContentPort')).toBe(true);
    call(sheet, 'onClose'); expect(page.render()).toEqual([]);
    expect(page.dismissed).toHaveBeenCalledExactlyOnceWith('agent');
    call(sheet, 'onClose'); expect(page.dismissed).toHaveBeenCalledTimes(1);
    for (let index = 0; index < 200; index++) { page.effects(); expect(page.render()).toEqual([]); }
    expect(page.content).toHaveBeenCalledTimes(1);
  });
  it('serializes Agent → Model and rejects callbacks from the retired generation', () => {
    const page = fixture(), first = surface(page); call(first, 'onOpen');
    (page.content.mock.calls[0]![2] as () => void)(); page.effects();
    page.value.set('model'); page.effects();
    expect(surface(page)).toBe(first); expect(first.props.open).toBe(false);
    call(first, 'onClose'); const second = surface(page);
    expect(second).not.toBe(first); call(second, 'onOpen');
    call(first, 'onOpen'); call(first, 'onOpenChange', { open: false }); call(first, 'onClose');
    expect(second.props.open).toBe(true); expect(page.content.mock.calls.at(-1)![0]).toBe('model');
    expect(page.dismissed).toHaveBeenCalledExactlyOnceWith('agent');
  });
  it('drains cancellation before first native layout and preserves queued reopen intent', () => {
    const page = fixture(), first = surface(page);
    page.value.set(null); page.effects(); page.value.set('model'); page.effects();
    expect(first.props.open).toBe(true);
    call(first, 'onOpenChange', { open: false }); expect(page.close).not.toHaveBeenCalled();
    call(first, 'onOpen'); expect(first.props.open).toBe(false);
    call(first, 'onClose'); const second = surface(page); expect(second).not.toBe(first);
    call(second, 'onOpen'); expect(second.props.open).toBe(true);
  });
  it.each(['inactive', 'host', 'cleanup'] as const)('%s fences content and never clears a later intent', reason => {
    const page = fixture(), first = surface(page); call(first, 'onOpen');
    const enabled = page.content.mock.calls[0]![1] as () => boolean, close = page.content.mock.calls[0]![2] as () => void;
    if (reason === 'cleanup') page.dispose(); else { page.active.set(false); page.effects(); }
    expect(enabled()).toBe(false); expect(first.props.open).toBe(false);
    close(); expect(page.close).not.toHaveBeenCalled();
    if (reason !== 'cleanup') { page.value.set('model'); page.active.set(true); page.effects(); }
    call(first, 'onClose');
    if (reason === 'cleanup') expect(page.render()).toEqual([]);
    else { const second = surface(page); call(second, 'onOpen'); close(); call(first, 'onClose'); expect(second.props.open).toBe(true); }
    expect(page.close).not.toHaveBeenCalled();
  });
  it('native interruption clears current intent exactly once', () => {
    const page = fixture(), sheet = surface(page); call(sheet, 'onOpen'); call(sheet, 'onClose'); page.effects();
    expect(page.close).toHaveBeenCalledTimes(1); expect(page.render()).toEqual([]);
    call(sheet, 'onClose'); expect(page.close).toHaveBeenCalledTimes(1);
  });
});
