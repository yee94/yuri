import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import * as presentation from './attachment-presentation';
import * as scopes from './runtime-scope';
import { bindContactAttachmentRead, bindResourceRead } from './resources-request';

type Node = { type: string; props: Record<string, unknown>; children: unknown[] };
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture() {
  const scope = { hostID: 'fixture-host', lease: 'fixture-authority' };
  let active = true, file = { name: 'a.png', mime: 'image/png', uri: 'file:///work/a.png' };
  const effects: Array<() => void> = [], cleanup: Array<() => void> = [], reads: Array<(content: unknown) => void> = [];
  const native = vi.fn(async (name: string, _input: Record<string, unknown>) => name === 'resources.read'
    ? await new Promise(resolve => reads.push(resolve)) : true);
  const lazy: ts.TransformerFactory<ts.SourceFile> = context => file => {
    const visit: ts.Visitor = node => {
      const next = ts.visitEachChild(node, visit, context);
      if (!ts.isCallExpression(next) || !ts.isIdentifier(next.expression) || next.expression.text !== 'h') return next;
      const [type, props, ...children] = next.arguments;
      const getters = props && ts.isObjectLiteralExpression(props) ? ts.factory.updateObjectLiteralExpression(props, props.properties.map(property => ts.isPropertyAssignment(property)
        ? ts.factory.createGetAccessorDeclaration(undefined, property.name, [], undefined, ts.factory.createBlock([ts.factory.createReturnStatement(property.initializer)])) : property)) : props;
      return ts.factory.updateCallExpression(next, next.expression, next.typeArguments, [type, getters, ...children]);
    };
    return ts.visitNode(file, visit) as ts.SourceFile;
  };
  const modules: Record<string, unknown> = {
    nsh: { View: 'View', Text: 'Text', Image: 'Image', computed: (fn: () => unknown) => fn, lifecycle: () => 'active', windowSize: () => ({ width: 390, height: 844 }),
      signal: (initial: unknown) => { let value = initial; return Object.assign(() => value, { set(next: unknown) { value = next; } }); },
      effect: (fn: () => void) => effects.push(fn), cleanup: (fn: () => void) => cleanup.push(fn), untracked: (fn: () => unknown) => fn() },
    'nsh/base': { Button: 'Button' }, './Icon': { Icon: 'Icon' }, './attachment-presentation': presentation,
    './native-image-preview': { NativeContentImage: 'ContentImage' }, './resource-raster-presentation': { ResourceRasterPresentation: 'Raster' }, './resource-svg': { ResourceSVGImage: 'SVG' },
    './resources-request': { bindContactAttachmentRead, bindResourceRead }, './runtime': { native }, './runtime-scope': scopes,
    './state': { app: { runtimeScope: () => scope, connection: () => ({ url: 'https://host.example' }) } },
    './model': { id: (() => { let id = 0; return () => `read-${++id}`; })() }, './i18n': { t: (key: string) => key },
  };
  const output = ts.transpileModule(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'attachment-card.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'h' }, transformers: { after: [lazy] },
  }).outputText;
  const exports: { NativeAttachmentCard?: (props: object) => Node } = {};
  vm.runInNewContext(output, { exports, If: 'If', Each: 'Each', h: (type: string | ((props: object) => Node), props: Node['props'], ...children: unknown[]) => {
    if (typeof type === 'function') return type(props);
    if (type === 'Each') return { type: 'View', props: {}, children: (props.of as unknown[]).map(value => (children[0] as (read: () => unknown) => Node)(() => value)) };
    return { type, props, children };
  },
    require: (name: string) => { if (!(name in modules)) throw Error('Unexpected import: ' + name); return modules[name]; } });
  const tree = exports.NativeAttachmentCard!({ get file() { return file; }, target: { kind: 'session', id: 's', title: '', directory: '/work' }, current: () => active });
  const nodes = (value: unknown): Node[] => {
    if (!value || typeof value !== 'object') return [];
    const node = value as Node;
    if (node.type === 'If') return nodes(node.props.when ? node.children[0] : node.props.else);
    return [node, ...node.children.flatMap(child => Array.isArray(child) ? child.flatMap(entry => nodes(entry)) : nodes(child))];
  };
  return { native, reads, sync: () => effects.forEach(fn => fn()), image: () => nodes(tree).find(node => node.type === 'ContentImage')!,
    replace() { file = { ...file, name: 'b.png', uri: 'file:///work/b.png' }; }, hide() { active = false; }, dispose: () => cleanup.forEach(fn => fn()) };
}

it('retired source cannot adopt a late lease; the replacement owns its image and cleanup releases exactly the held lease', async () => {
  const f = fixture(); f.sync(); await flush();
  expect(f.native.mock.calls).toContainEqual(['resources.read', expect.objectContaining({ path: '/work/a.png' })]);
  f.replace(); f.sync();
  f.reads[0]({ kind: 'image', lease: 'old', thumbnail: 'old-thumbnail', width: 10, height: 20 }); await flush();
  expect(f.image().props.src).toBe('');
  expect(f.native.mock.calls).toContainEqual(['resources.release', { lease: 'old' }]);
  f.reads[1]({ kind: 'image', lease: 'new', thumbnail: 'new-thumbnail', width: 20, height: 10 }); await flush();
  expect(f.image().props.src).toBe('new-thumbnail');
  const renderer = f.image().props.renderImage as (fullscreen: boolean) => Node;
  expect(renderer(true).props.config).toMatchObject({ lease: 'new', active: true });
  f.hide(); f.sync(); await flush();
  expect(f.image().props.src).toBe('');
  expect(renderer(true).props.config).toMatchObject({ lease: 'new', active: false });
  expect(f.native.mock.calls.filter(([name, input]) => name === 'resources.release' && input.lease === 'new')).toHaveLength(1);
  f.dispose(); await flush();
});
