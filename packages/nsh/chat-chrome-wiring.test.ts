import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';

test('production latest action targets inverted row zero, without a second occupancy compensation', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'application.tsx'), 'utf8');
  const file = ts.createSourceFile('application.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let handler: string | undefined;
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'testID' && attribute.initializer && ts.isStringLiteral(attribute.initializer) && attribute.initializer.text === 'compact-latest')) {
      const attribute = node.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(file) === 'onPress');
      if (attribute && ts.isJsxAttribute(attribute) && attribute.initializer && ts.isJsxExpression(attribute.initializer)) handler = attribute.initializer.expression?.getText(file);
    }
    ts.forEachChild(node, visit);
  }
  visit(file); expect(handler).toBeDefined();
  const scrollToIndex = vi.fn(), scrollToEnd = vi.fn(), expand = vi.fn();
  let active = true;
  const code = ts.transpileModule(`exports.press = ${handler};`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: { press?: () => void } = {};
  vm.runInNewContext(code, { exports, current: () => active, chat: { active: () => active }, chrome: { expand }, transcriptRef: () => ({ scrollToIndex, scrollToEnd }) });
  exports.press!(); expect(scrollToIndex).toHaveBeenCalledExactlyOnceWith({ index: 0, animated: true, viewPosition: 1 });
  expect(scrollToEnd).not.toHaveBeenCalled(); expect(expand).toHaveBeenCalledTimes(1);
  active = false; exports.press!(); expect(scrollToIndex).toHaveBeenCalledTimes(1);
});
