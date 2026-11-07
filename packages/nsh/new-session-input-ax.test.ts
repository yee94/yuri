import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import vm from 'node:vm';

const root = path.dirname(fileURLToPath(import.meta.url));
describe('new-session real Input AX registration call sites (static, not UIKit)', () => {
  it.each([
    ['new-session-models.tsx', 'new-session-selection-search', 'selection'],
    ['new-session-page.tsx', 'new-session-presets-search', 'presets'],
    ['new-session-page.tsx', 'new-session-directory', 'directory'],
  ])('%s: %s registers the actual sibling editor without a replacement AX control', (file, id, field) => {
    const source = ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let input: ts.JsxSelfClosingElement | undefined;
    const attr = (node: ts.JsxSelfClosingElement, name: string) => node.attributes.properties.find((prop): prop is ts.JsxAttribute => ts.isJsxAttribute(prop) && prop.name.getText(source) === name)?.initializer?.getText(source);
    const visit = (node: ts.Node) => { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Input' && attr(node, 'testID') === JSON.stringify(id)) input = node; ts.forEachChild(node, visit); };
    visit(source); expect(input).toBeDefined();
    const parent = input!.parent; if (!ts.isJsxElement(parent)) throw new Error('Expected existing input owner');
    const elements = parent.children.filter(ts.isJsxSelfClosingElement), index = elements.indexOf(input!);
    const registration = elements[index + 1];
    expect(registration?.tagName.getText(source)).toBe('NativeNewSessionInputAX');
    expect(attr(registration!, 'field')).toBe(JSON.stringify(field));
    expect(attr(input!, 'accessibilityLabel')).toBeDefined();
    expect(attr(registration!, 'label')).toBe(attr(input!, 'accessibilityLabel'));
    expect(attr(registration!, 'testID')).toBeUndefined();
    expect(attr(input!, 'onChange')).toContain('event.value');
  });
  it('keeps search/directory editor contracts and the Web mobile effort reset, with no native editor replacement', () => {
    const editors = (text: string, file: string) => {
      const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX), result: Record<string, Record<string, string>> = {};
      const visit = (node: ts.Node) => {
        if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(source) === 'Input') {
          const props = Object.fromEntries(node.attributes.properties.filter(ts.isJsxAttribute).map(prop => [prop.name.getText(source), prop.initializer?.getText(source) ?? 'true']));
          result[props.testID] = props;
        }
        ts.forEachChild(node, visit);
      }; visit(source); return result;
    };
    const all = { ...editors(readFileSync(path.join(root, 'new-session-models.tsx'), 'utf8'), 'models'), ...editors(readFileSync(path.join(root, 'new-session-page.tsx'), 'utf8'), 'page') };
    for (const [id, className, value, onChange] of [
      ['new-session-selection-search', 'flex-1 min-h-9 text-sm text-foreground', '{search()}', "{event => { search.set(event.value); effort.set(''); }}"],
      ['new-session-presets-search', 'min-h-9 rounded-xl bg-card px-3 text-foreground', '{search()}', '{event => { if (active()) search.set(event.value); }}'],
      ['new-session-directory', 'min-h-11 rounded-xl bg-card px-3 text-foreground', '{directory()}', '{event => directory.set(event.value)}'],
    ]) {
      const input = all[JSON.stringify(id)]!;
      expect(input).toMatchObject({ class: JSON.stringify(className), value, onChange });
      expect(input.accessibilityLabel).toBe(input.placeholder);
      expect(input.inputProps).toBeUndefined(); expect(input.style).toBeUndefined();
      if (id === 'new-session-selection-search') {
        const search = { set: (value: string) => { query = value; } }, effort = { set: (value: string) => { expanded = value; } };
        let query = '', expanded = 'favorite:provider/model';
        const exports: { change?: (event: { value: string }) => void } = {};
        const js = ts.transpileModule(`exports.change = ${input.onChange.slice(1, -1)};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
        vm.runInNewContext(js, { exports, search, effort });
        exports.change!({ value: 'reasoning model' }); expect(query).toBe('reasoning model'); expect(expanded).toBe('');
        expanded = 'all:provider/model'; exports.change!({ value: '' }); expect(query).toBe(''); expect(expanded).toBe('');
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
