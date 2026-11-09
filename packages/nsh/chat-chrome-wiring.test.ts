import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import { nativeLayoutDensity } from './native-density';

test('visible expanded composer controls keep touch admission while chrome begins to collapse', () => {
  const file = ts.createSourceFile('chat-chrome-surfaces.tsx', readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'chat-chrome-surfaces.tsx'), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const declaration = file.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'NativeComposerChrome')!;
  const output = ts.transpileModule(declaration.getText(file), { compilerOptions: { jsx: ts.JsxEmit.React, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports: { NativeComposerChrome?: (props: unknown) => { children: Array<{ props: { style: { opacity: number; pointerEvents: string } } }> } } = {};
  vm.runInNewContext(output, { exports, View: 'View', nativeComposerSurface: {}, nativeDensity: () => nativeLayoutDensity(), signal: (value: unknown) => Object.assign(() => value, { set: () => {} }), React: { createElement: (_type: unknown, props: unknown, ...children: unknown[]) => ({ props, children }) } });
  const result = exports.NativeComposerChrome!({ state: { swap: { progress: .1, phase: 'dragging' } }, bottom: 0 });
  expect(result.children[0].props.style.opacity).toBeGreaterThan(.5);
  expect(result.children[0].props.style.pointerEvents).not.toBe('none');
});

test('production latest action targets inverted row zero, without a second occupancy compensation', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'application.tsx'), 'utf8');
  const file = ts.createSourceFile('application.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler: string | undefined, resume: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'resumeLatest') resume = node.getText(file);
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'testID' && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === 'compact-latest')) {
      const attribute = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'onPress');
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) handler = attribute.initializer.expression?.getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file); expect(handler).toBeDefined(); expect(resume).toBeDefined();
  const scrollToIndex = vi.fn(), scrollToEnd = vi.fn(), expand = vi.fn();
  let active = true;
  const code = ts.transpileModule(`${resume}\nexports.press = ${handler};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { press?: () => void } = {};
  vm.runInNewContext(code, { exports, current: () => active, chat: { active: () => active }, chrome: { expand }, transcriptRef: () => ({ scrollToIndex, scrollToEnd }) });
  exports.press!(); expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 0, animated: true, viewPosition: 1 });
  expect(scrollToEnd).not.toHaveBeenCalled(); expect(expand).toHaveBeenCalledTimes(1);
  active = false; exports.press!(); expect(scrollToIndex).toHaveBeenCalledTimes(1);
});
