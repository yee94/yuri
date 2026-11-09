import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import ts from 'typescript';
import { beforeEach, expect, it, vi } from 'vitest';

const boundary = vi.hoisted(() => ({ device: null as { codeFontSize: number; editorFontSize: number } | null, family: 'Canonical Mono', scale: 200, load: vi.fn(), write: vi.fn() }));
vi.mock('./device-appearance', () => ({ deviceAppearance: () => boundary.device, loadDeviceAppearance: boundary.load, saveDeviceEditorFontSize: boundary.write }));
vi.mock('./appearance', () => ({ nativeChatTextStyle: () => ({ fontSize: 13 * boundary.scale / 100, fontFamily: boundary.family }) }));
import { nativeEditorTextStyle } from './native-editor-style';

const root = path.dirname(fileURLToPath(import.meta.url));
type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
function source(file: string) { return ts.createSourceFile(file, readFileSync(path.join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX); }
function declaration(file: string, name: string) {
  const tree = source(file); let result = '';
  const visit = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === name) result = node.getText(tree); ts.forEachChild(node, visit); };
  visit(tree); if (!result) throw new Error(`Missing actual ${name} declaration`); return result;
}
function compile(code: string) {
  return ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' },
    transformers: { after: [context => tree => {
      const visit: ts.Visitor = node => {
        const next = ts.visitEachChild(node, visit, context);
        if (!ts.isCallExpression(next) || !ts.isIdentifier(next.expression) || next.expression.text !== 'jsx') return next;
        const props = next.arguments[1]; if (!props || !ts.isObjectLiteralExpression(props)) return next;
        return ts.factory.updateCallExpression(next, next.expression, next.typeArguments, [next.arguments[0], ts.factory.updateObjectLiteralExpression(props,
          props.properties.map(property => ts.isPropertyAssignment(property) ? ts.factory.createGetAccessorDeclaration(undefined, property.name, [], undefined,
            ts.factory.createBlock([ts.factory.createReturnStatement(property.initializer)])) : property)), ...next.arguments.slice(2)]);
      };
      return ts.visitNode(tree, visit) as ts.SourceFile;
    }] },
  }).outputText;
}
function descendants(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(descendants);
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Node; return [node, ...node.children.flatMap(descendants)];
}
function inputFixture(kind: 'instructions' | 'supporting', domain = 'skills.installed', key = 'instructions') {
  const change = vi.fn(), contents = { value: 'original content' };
  const environment: Record<string, unknown> = {
    exports: {}, jsx: (type: unknown, props: Node['props'], ...children: unknown[]): Node => ({ type, props: props ?? {}, children }),
    View: 'View', Text: 'Text', Input: 'Input', nativeEditorTextStyle,
    nativeDensity: () => ({ scale: 1, settings: { section: { gap: 8 }, field: { padding: 12 } } }),
    settingsField: 'existing-field', t: (key: string) => key,
  };
  const controls = new Script(compile(declaration('settings-controls.tsx', 'SettingsInput') + '\nSettingsInput;')).runInNewContext(environment);
  Object.assign(environment, { SettingsInput: controls, readOnly: () => false, domain,
    value: () => contents.value, locked: () => false, anchor: () => () => {}, reveal: () => {},
    set: (_key: string, value: string) => { contents.value = value; change(value); },
    props: { target: '', disabled: false }, content: Object.assign(() => contents.value, { set: (value: string) => { contents.value = value; change(value); } }),
    state: { busy: () => false },
  });
  let code: string;
  if (kind === 'instructions') code = declaration('settings-collections.tsx', 'field') + `\nfield(${JSON.stringify(key)}, "instructions", true);`;
  else {
    const tree = source('settings-skill-files.tsx'); let expression = '';
    const visit = (node: ts.Node) => {
      if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === 'SettingsInput' && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(tree) === 'multiline')) expression = node.getText(tree);
      ts.forEachChild(node, visit);
    };
    visit(tree); if (!expression) throw new Error('Missing actual supporting-file multiline Input'); code = `(${expression});`;
  }
  const settings = descendants(new Script(compile(code)).runInNewContext(environment)).find(node => node.type === controls)!;
  const input = descendants(controls(settings.props)).find(node => node.type === 'Input')!;
  return { input, settings, contents, change };
}

beforeEach(() => { vi.clearAllMocks(); boundary.device = null; boundary.family = 'Canonical Mono'; boundary.scale = 200; });

it('editor style stays unknown until device read and uses canonical mono without inheriting code percentage', () => {
  expect(nativeEditorTextStyle()).toEqual({ fontFamily: 'Canonical Mono' });
  boundary.device = { codeFontSize: 200, editorFontSize: 13 };
  expect(nativeEditorTextStyle()).toEqual({ fontFamily: 'Canonical Mono', fontSize: 13, lineHeight: 19.5 });
  boundary.scale = 50; expect(nativeEditorTextStyle().fontSize).toBe(13);
  expect(boundary.load).not.toHaveBeenCalled(); expect(boundary.write).not.toHaveBeenCalled();
});

it.each(['instructions', 'supporting'] as const)('actual Skills %s keeps one original multiline Input and callbacks as device/editor font and canonical family change', kind => {
  const mounted = inputFixture(kind), input = mounted.input;
  expect(input.props.multiline).toBe(true); expect(input.props.value).toBe('original content');
  expect(input.props.style).toMatchObject({ fontFamily: 'Canonical Mono', padding: 12 });
  expect(input.props.style).not.toHaveProperty('fontSize');
  const onChange = input.props.onChange as (event: { value: string }) => void;
  onChange({ value: 'draft and IME text' }); expect(mounted.contents.value).toBe('draft and IME text');
  for (const size of [9, 13, 32]) {
    boundary.device = { codeFontSize: 50, editorFontSize: size }; boundary.scale = 50;
    expect(mounted.input).toBe(input);
    expect(input.props.style).toMatchObject({ fontSize: size, lineHeight: size * 1.5, fontFamily: 'Canonical Mono', padding: 12 });
    expect(input.props.value).toBe('draft and IME text'); expect(input.props.disabled).toBe(false);
    boundary.scale = 200; boundary.device = { codeFontSize: 200, editorFontSize: size };
    expect(input.props.style).toMatchObject({ fontSize: size, lineHeight: size * 1.5 });
  }
  boundary.family = 'Updated Canonical Mono'; expect(input.props.style).toMatchObject({ fontFamily: 'Updated Canonical Mono', fontSize: 32 });
  onChange({ value: 'still the same editor' }); expect(mounted.change.mock.calls).toEqual([['draft and IME text'], ['still the same editor']]);
  expect(boundary.load).not.toHaveBeenCalled(); expect(boundary.write).not.toHaveBeenCalled();
});

it.each([['agents', 'system'], ['commands', 'template'], ['skills.installed', 'description']])('editor preference does not restyle unrelated %s/%s collection fields', (domain, key) => {
  boundary.device = { codeFontSize: 200, editorFontSize: 32 };
  const { input, settings } = inputFixture('instructions', domain, key);
  expect(settings.props.inputStyle).toBeUndefined();
  expect(input.props.style).not.toHaveProperty('fontSize'); expect(input.props.style).not.toHaveProperty('fontFamily');
});
