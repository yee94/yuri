import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import type { SelectProps } from 'nsh/base';
import { createSelectKeyboard } from './select-keyboard';

type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
function mount(props: SelectProps) {
  const live = new Set(['open', 'value', 'when', 'each', 'selected', 'disabled', 'accessibilityLabel', 'placeholder', 'class', 'style', 'popupClass', 'popupStyle', 'backdropClass', 'backdropStyle']);
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => source => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && live.has(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node.initializer.expression)));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(source, visit) as ts.SourceFile;
  };
  const jsx = (type: unknown, input: Record<string, unknown> | null, ...children: unknown[]): Node => {
    const values = { ...input };
    for (const key of live) if (typeof values[key] === 'function') Object.defineProperty(values, key, { get: values[key] as () => unknown });
    return { type, props: values, children };
  };
  const signal = (initial: unknown) => { let value = initial; return Object.assign(() => value, { set: (next: unknown) => { value = next; } }); };
  const effects: Array<() => void> = [], cleanups: Array<() => void> = [], bindings = new Map<string, () => void>();
  const modules: Record<string, unknown> = {
    nsh: { signal, computed: (read: () => unknown) => read, token: (name: string) => name, untracked: (work: () => void) => work(), effect: (work: () => void) => { effects.push(work); work(); }, cleanup: (work: () => void) => cleanups.push(work), keymap: { bind: (values: Record<string, () => void>) => { for (const [key, handler] of Object.entries(values)) bindings.set(key, handler); return () => { for (const key of Object.keys(values)) bindings.delete(key); }; } }, platform: { os: 'ios' }, List: 'List', View: 'View', Text: 'Text' },
    'nsh/base': { Button: 'Button', Input: 'Input', Select: 'Select' }, './native-sheet': { NativeSheet: 'Sheet' },
    './Icon': { Icon: 'Icon' }, './i18n': { t: (key: string) => key },
    './select-keyboard': { createSelectKeyboard },
  };
  const filename = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native-select.tsx');
  const source = ts.transpileModule(readFileSync(filename, 'utf8'), { fileName: filename, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { before: [lazy] } }).outputText;
  const exports: { NativeSelect?: (props: SelectProps) => Node } = {};
  vm.runInNewContext(source, { exports, jsx, If: 'If', require: (key: string) => { if (!(key in modules)) throw new Error('Unexpected dependency ' + key); return modules[key]; } });
  const tree = exports.NativeSelect!(props), mounted = new Map<Node, Node>();
  function nodes(value: unknown): Node[] {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (!value || typeof value !== 'object' || !('type' in value)) return [];
    const node = value as Node;
    if (typeof node.type === 'function') {
      if (!mounted.has(node)) mounted.set(node, node.type(node.props));
      return nodes(mounted.get(node));
    }
    if (node.type === 'If') return node.props.when ? node.children.flatMap(nodes) : [];
    if (node.type === 'List') return [node, ...(node.props.each as unknown[]).flatMap(item => nodes((node.children[0] as (read: () => unknown) => Node)(() => item)))];
    return [node, ...node.children.flatMap(nodes)];
  }
  return { nodes: () => nodes(tree), find: (type: string) => nodes(tree).find(node => node.type === type)!, effects: () => effects.forEach(work => work()), key: (key: string) => bindings.get(key)?.(), dispose: () => cleanups.forEach(work => work()) };
}

describe('NativeSelect production callbacks without engine', () => {
  it('keeps controlled getters, search/groups/renderers, selection, clear and presentation styles', () => {
    let value: string | null = 'one', open = false;
    const onChange = vi.fn(event => { value = event.value; }), onOpenChange = vi.fn(event => { open = event.open; });
    const renderItem = vi.fn(() => null), renderGroup = vi.fn(() => null);
    const popupStyle = { height: 420 }, backdropStyle = { opacity: .5 }, onOpen = vi.fn(), onClose = vi.fn(), onCancel = vi.fn();
    const page = mount({ get value() { return value; }, get open() { return open; }, items: [{ value: 'one', title: 'One', group: 'Group' }, { value: 'two', title: 'Two', group: 'Group', disabled: true }], searchable: true, cleanable: true, accessibilityLabel: null, searchPlaceholder: null, searchAccessibilityLabel: null, renderItem, renderGroup, onChange, onOpenChange, onOpen, onClose, onCancel, popupClass: 'custom-popup', popupStyle, backdropClass: 'custom-backdrop', backdropStyle });
    (page.nodes().find(node => node.props.role === 'combobox')!.props.onPress as () => void)();
    const sheet = page.find('Sheet');
    expect(sheet.props).toMatchObject({ open: true, popupClass: 'custom-popup', popupStyle, backdropClass: 'custom-backdrop', backdropStyle, onCancel });
    (sheet.props.onOpen as () => void)(); expect(onOpen).toHaveBeenCalledTimes(1);
    expect(renderItem.mock.calls[0][0]).toMatchObject({ value: 'one', disabled: false, index: 0 });
    expect(renderGroup).toHaveBeenCalledWith({ title: 'Group' });
    const input = page.find('Input'); expect(input.props.accessibilityLabel).toBeUndefined(); expect(input.props.placeholder).toBeUndefined();
    (input.props.onChange as (event: { value: string }) => void)({ value: 'two' });
    expect((page.find('List').props.each as Array<{ value: string; disabled: boolean }>).map(item => [item.value, item.disabled])).toEqual([['two', true]]);
    (input.props.onChange as (event: { value: string }) => void)({ value: '' });
    value = 'two'; expect(page.nodes().find(node => node.props.role === 'option' && node.props.selected)?.props.disabled).toBe(true);
    const clear = page.nodes().find(node => node.type === 'Button' && node.props.accessibilityLabel === 'mobile.sessions.clearSearchAria')!;
    (clear.props.onPress as () => void)();
    expect(onChange).toHaveBeenLastCalledWith({ value: null }); expect(onOpenChange).toHaveBeenLastCalledWith({ open: false, reason: 'select' }); expect(sheet.props.open).toBe(false);
    (sheet.props.onClose as () => void)(); expect(onClose).toHaveBeenCalledTimes(1);
  });
  it('binds keyboard only after system presentation, skips disabled rows and releases on teardown', () => {
    let open = true, value: string | null = 'one';
    const changed = vi.fn(event => { value = event.value; });
    const page = mount({ get open() { return open; }, get value() { return value; }, items: [{ value: 'one', title: 'One' }, { value: 'two', title: 'Two', disabled: true }, { value: 'three', title: 'Three' }], onChange: changed, onOpenChange: event => { open = event.open; } });
    page.nodes(); page.key('down'); page.key('enter'); expect(changed).not.toHaveBeenCalled();
    (page.find('Sheet').props.onOpen as () => void)(); page.effects();
    page.key('down'); page.key('enter'); expect(changed).toHaveBeenCalledExactlyOnceWith({ value: 'three' }); expect(open).toBe(false);
    page.dispose(); page.key('enter'); expect(changed).toHaveBeenCalledTimes(1);
  });
});
