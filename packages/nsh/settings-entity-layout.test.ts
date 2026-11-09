import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';

const root = path.dirname(fileURLToPath(import.meta.url));
type Node = { type: string; props: Record<string, unknown>; children: unknown[] };
function layout(desktop: boolean) {
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  const jsx = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Node => {
    const observed = { ...props };
    for (const key of ['class', 'style']) if (typeof observed[key] === 'function') Object.defineProperty(observed, key, { get: observed[key] as () => unknown });
    return { type, props: observed, children };
  };
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      if (ts.isJsxAttribute(node) && ['class', 'style'].includes(node.name.getText()) && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        return ts.factory.updateJsxAttribute(node, node.name, ts.factory.createJsxExpression(undefined, ts.factory.createArrowFunction(undefined, undefined, [], undefined, ts.factory.createToken(ts.SyntaxKind.EqualsGreaterThanToken), node.initializer.expression)));
      }
      return ts.visitEachChild(node, visit, context);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  const output = ts.transpileModule(readFileSync(path.join(root, 'settings-controls.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' }, transformers: { before: [lazy] } }).outputText;
  const modules: Record<string, unknown> = { nsh: { signal, View: 'View', Text: 'Text' }, 'nsh/base': {}, './native-select': {}, './state': {}, './settings-protocol': {},
    './i18n': { t: (key: string) => key }, './desktop-settings-publisher': { DesktopSettingsPublisher: () => desktop ? {} : null } };
  const exports: { SettingsEntityLayout?: (props: { editing: boolean; list(): Node; children: Node }) => Node } = {};
  vm.runInNewContext(output, { exports, jsx, If: 'If', require: (name: string) => { if (!(name in modules)) throw new Error('Unexpected layout dependency: ' + name); return modules[name]; } });
  return exports.SettingsEntityLayout!;
}

it('uses the same entity list and detail across measured wide/narrow transitions, without a second owner or loader', () => {
  const list: Node = { type: 'List', props: {}, children: [] }, detail: Node = { type: 'Editor', props: {}, children: [] }, factory = vi.fn(() => list);
  const node = layout(true)({ editing: true, list: factory, children: detail });
  const sidebar = node.children[0] as Node, body = node.children[1] as Node;
  const measure = node.props.onLayout as (event: { bounds: { size: { width: number } } }) => void;
  expect(node.props.class).toContain('flex-row'); expect(sidebar.props.style).toEqual({ width: 304 });
  for (const width of [768, 420, 767]) {
    measure({ bounds: { size: { width } } }); expect(node.props.class).toContain('flex-col'); expect(sidebar.props.style).toEqual({ height: '38%', width: '100%' });
    expect(sidebar.children[0]).toBe(list); expect(((body.children[0] as Node).children[0])).toBe(detail);
  }
  measure({ bounds: { size: { width: 900 } } }); expect(node.props.class).toContain('flex-row'); expect(factory).toHaveBeenCalledTimes(1);
});

it.each([false, true])('mobile preserves its original list-or-editor flow, editing=%s', editing => {
  const list = { type: 'List', props: {}, children: [] }, detail = { type: 'Editor', props: {}, children: [] }, factory = vi.fn(() => list);
  expect(layout(false)({ editing, list: factory, children: detail })).toBe(editing ? detail : list);
  expect(factory).toHaveBeenCalledTimes(editing ? 0 : 1);
});

it('provides a real select-item translation in every shipped locale', () => {
  const values = ['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'pl', 'pt-BR', 'uk'].map(locale => {
    const source = readFileSync(path.join(root, `../ui/src/lib/i18n/messages/${locale}.settings.ts`), 'utf8');
    const value = source.match(/'settings\.view\.entity\.selectHint':\s*'([^']+)'/g);
    expect(value).toHaveLength(1); return value![0];
  });
  expect(new Set(values).size).toBe(10);
});
