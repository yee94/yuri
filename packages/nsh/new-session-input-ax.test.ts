import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { nativeLayoutDensity } from './native-density';

const root = path.dirname(fileURLToPath(import.meta.url));
type Element = { type: string; props: Record<string, unknown>; children: Element[] };
const sourceFile = (file: string) => ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const attribute = (node: ts.JsxSelfClosingElement, name: string) => node.attributes.properties.find((prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText(node.getSourceFile()) === name);
const attr = (node: ts.JsxSelfClosingElement, name: string) => attribute(node, name)?.initializer?.getText(node.getSourceFile());
function editor(file: string, id: string) {
  const source = sourceFile(file), found: ts.JsxSelfClosingElement[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxSelfClosingElement(node) && ['Input', 'NativeSheetSearch'].includes(node.tagName.getText(source)) && attr(node, 'testID') === JSON.stringify(id)) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(source); expect(found).toHaveLength(1); return found[0];
}
function jsxModule(file: string): Record<string, (props: Record<string, unknown>) => Element> {
  const exports = {};
  const h = (type: string | ((props: Record<string, unknown>) => Element), props: Record<string, unknown> | null, ...children: Element[]) => typeof type === 'function' ? type({ ...props, children }) : { type, props: props ?? {}, children };
  const js = ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
  vm.runInNewContext(js, { exports, h, If: 'If', require: (id: string) => {
    if (id === 'nsh') return { token: (name: string) => name, View: 'View', nativeComponent: (name: string) => name };
    if (id === 'nsh/base') return { Input: 'nsh/base.Input', Button: 'Button' };
    if (id === './Icon') return { Icon: 'Icon' };
    if (id === './i18n') return { t: (key: string) => key };
    if (id === './appearance') return { nativeDensity: () => nativeLayoutDensity() };
    throw new Error(`Unexpected editor module ${id}`);
  } });
  return exports;
}
function realSearch(props: Record<string, unknown>) {
  const tree = jsxModule('sheet-search.tsx').NativeSheetSearch(props);
  const inputs = tree.children.filter(node => node?.type === 'nsh/base.Input');
  expect(inputs).toHaveLength(1);
  return { tree, input: inputs[0], registration: tree.children[tree.children.indexOf(inputs[0]) + 1] };
}
describe('new-session real Input AX registration call sites (static, not UIKit)', () => {
  it.each([
    ['new-session-models.tsx', 'new-session-selection-search', 'selection'],
    ['new-session-page.tsx', 'new-session-presets-search', 'presets'],
    ['new-session-page.tsx', 'new-session-directory', 'directory'],
  ])('%s: %s registers the actual sibling editor without a replacement AX control', (file, id, field) => {
    const input = editor(file, id), source = input.getSourceFile();
    let registration: ts.JsxSelfClosingElement;
    if (input.tagName.getText(source) === 'NativeSheetSearch') {
      const initializer = attribute(input, 'registration')?.initializer;
      if (!initializer || !ts.isJsxExpression(initializer) || !initializer.expression || !ts.isJsxSelfClosingElement(initializer.expression)) throw new Error('Expected actual registration passed to the search leaf');
      registration = initializer.expression;
      expect(source.text).toContain("import { NativeSheetSearch } from './sheet-search'");
      const leaf = sourceFile('sheet-search.tsx');
      expect(leaf.text).toContain("import { Button, Input, type InputProps } from 'nsh/base'");
      const label = attr(input, 'accessibilityLabel');
      const actualRegistration = jsxModule('new-session-native-owners.tsx').NativeNewSessionInputAX({ field, label });
      const rendered = realSearch({ testID: id, accessibilityLabel: label, registration: actualRegistration });
      expect(rendered.input.props.testID).toBe(id);
      expect(rendered.input.props.registration).toBeUndefined();
      expect(rendered.input.props.onClear).toBeUndefined();
      expect(rendered.input.props.clearTestID).toBeUndefined();
      expect(rendered.registration).toBe(actualRegistration);
      expect(rendered.registration.type).toBe('yuri.newSession.inputAX');
      expect(rendered.registration.props).toMatchObject({ field, label, accessible: false, accessibilityElementsHidden: true });
    } else {
      const parent = input.parent; if (!ts.isJsxElement(parent)) throw new Error('Expected existing input owner');
      const elements = parent.children.filter(ts.isJsxSelfClosingElement), index = elements.indexOf(input);
      registration = elements[index + 1];
    }
    expect(registration.tagName.getText(source)).toBe('NativeNewSessionInputAX');
    expect(attr(registration!, 'field')).toBe(JSON.stringify(field));
    expect(attr(input!, 'accessibilityLabel')).toBeDefined();
    expect(attr(registration!, 'label')).toBe(attr(input!, 'accessibilityLabel'));
    expect(attr(registration!, 'testID')).toBeUndefined();
    expect(attr(input!, 'onChange')).toContain('event.value');
  });
  it('keeps search/directory editor contracts and the Web mobile effort reset, with no native editor replacement', () => {
    for (const [file, id, className, value, onChange] of [
      ['new-session-models.tsx', 'new-session-selection-search', undefined, '{search()}', "{event => { search.set(event.value); effort.set(''); }}"],
      ['new-session-page.tsx', 'new-session-presets-search', 'min-h-9 rounded-xl bg-card px-3 text-foreground', '{search()}', '{event => { if (active()) search.set(event.value); }}'],
      ['new-session-page.tsx', 'new-session-directory', 'min-h-11 rounded-xl bg-card px-3 text-foreground', '{directory()}', '{event => directory.set(event.value)}'],
    ]) {
      const node = editor(file!, id!), source = node.getSourceFile();
      const input = Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map(prop => [prop.name.getText(source), prop.initializer?.getText(source) ?? 'true']));
      expect(input.value).toBe(value); expect(input.onChange).toBe(onChange); expect(input.class).toBe(className === undefined ? undefined : JSON.stringify(className));
      expect(input.accessibilityLabel).toBe(input.placeholder);
      expect(input.inputProps).toBeUndefined(); expect(input.style).toBeUndefined();
      if (id === 'new-session-selection-search') {
        const search = { set: (value: string) => { query = value; } }, effort = { set: (value: string) => { expanded = value; } };
        let query = '', expanded = 'favorite:provider/model';
        const exports: { change?: (event: { value: string }) => void; clear?: () => void } = {};
        const js = ts.transpileModule(`exports.change = ${input.onChange.slice(1, -1)}; exports.clear = ${input.onClear.slice(1, -1)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        vm.runInNewContext(js, { exports, search, effort });
        const label = input.accessibilityLabel;
        const actualRegistration = jsxModule('new-session-native-owners.tsx').NativeNewSessionInputAX({ field: 'selection', label });
        const rendered = realSearch({ testID: id, value: query, accessibilityLabel: label, placeholder: label, onChange: exports.change, onClear: exports.clear, registration: actualRegistration });
        expect(rendered.input.props).toMatchObject({ testID: id, value: '', accessibilityLabel: label, placeholder: label,
          class: 'flex-1 bg-transparent text-foreground', returnKeyType: 'search', autoCapitalize: 'none', autoCorrect: false });
        expect(rendered.input.props.style).toEqual([{ minHeight: 50, fontSize: 17, placeholderColor: 'muted-foreground', paddingHorizontal: 0, borderWidth: 0 }, undefined]);
        expect(rendered.input.props.onChange).toBe(exports.change);
        exports.change!({ value: 'reasoning model' }); expect(query).toBe('reasoning model'); expect(expanded).toBe('');
        expanded = 'all:provider/model'; exports.change!({ value: '' }); expect(query).toBe(''); expect(expanded).toBe('');
        query = 'query to clear'; expanded = 'favorite:provider/model';
        const clearable = realSearch({ value: query, onChange: exports.change, onClear: exports.clear, clearTestID: 'new-session-search-clear', registration: actualRegistration });
        expect(clearable.input.props.value).toBe(query);
        const clearButton = clearable.tree.children.at(-1)!.children[0];
        expect(clearButton.type).toBe('Button');
        expect(clearButton.props).toMatchObject({ testID: 'new-session-search-clear', accessibilityLabel: 'chat.modelControls.clearSearch', style: { width: 44, height: 44 } });
        expect(clearButton.props.onPress).toBe(exports.clear);
        (clearButton.props.onPress as () => void)(); expect(query).toBe(''); expect(expanded).toBe('');
      }
    }
  });
  it('registers only nonvisual leaves, without a fake testID, interactive target, frame contribution or input replacement', () => {
    const registrations: unknown[] = [], exports: Record<string, (props: unknown) => unknown> = {};
    const js = ts.transpileModule(readFileSync(path.join(root, 'new-session-native-owners.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h' } }).outputText;
    const h = (type: string, props: object) => ({ type, props });
    vm.runInNewContext(js, { exports, h, require: (id: string) => {
      if (id !== 'nsh') throw new Error(`Unexpected owner import ${id}`);
      return { nativeComponent: (name: string, spec: unknown) => { registrations.push({ name, spec }); return name; } };
    } });
    const node = exports.NativeNewSessionInputAX!({ field: 'selection', label: 'localized search' }) as { type: string; props: Record<string, unknown> };
    expect(node.type).toBe('yuri.newSession.inputAX'); expect(node.props).toMatchObject({ field: 'selection', label: 'localized search', accessible: false, accessibilityElementsHidden: true, style: { position: 'absolute', width: 0, height: 0, pointerEvents: 'none' } });
    expect(node.props.testID).toBeUndefined(); expect(registrations).toHaveLength(1);
    const swift = readFileSync(path.join(root, 'ios/NewSessionPickerOwners.swift'), 'utf8');
    expect(swift).toContain('sibling.subviews.compactMap { $0 as? UITextField }');
    expect(swift).toContain('candidates.count == 1'); expect(swift).toContain('target.accessibilityIdentifier = id; target.accessibilityLabel = label');
    expect(swift).not.toMatch(/UIApplication|\.windows|NSClassFromString|method_exchangeImplementations|DispatchQueue|asyncAfter|scheduledTimer|becomeFirstResponder|\.text\s*=/);
  });
});
