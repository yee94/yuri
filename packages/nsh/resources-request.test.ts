import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import { bindResourceRead } from './resources-request';
import * as scopeModule from './runtime-scope';
import { bindResourceWebPreview, resourceWebPreviewIntent } from './resource-web-preview';

const scope = (hostID = 'A', suffix = '1') => ({ hostID, lease: `00000000-0000-4000-8000-${suffix.padStart(12, '0')}` });
test('resource reader retains a copied constructor receipt and never upgrades null authority', async () => {
  const receipt = scope(), call = vi.fn(async () => ({ lease: 'resource-lease' }));
  const read = bindResourceRead(receipt, call);
  receipt.hostID = 'B'; receipt.lease = scope('B', '2').lease;
  await read('/fixture/file', 'read-1'); await read('/fixture/file', 'read-2');
  expect(call.mock.calls.map(([, body]) => body.expectedHost)).toEqual([scope(), scope()]);
  const absentCall = vi.fn();
  await expect(bindResourceRead(null, absentCall)('/fixture/file', 'read-3')).rejects.toThrow('scope_required');
  expect(absentCall).not.toHaveBeenCalled();
});

type Node = { type: string; props: Record<string, unknown>; children: unknown[] };
/** Execute production component constructors/event handlers with declaration-only
 * JSX/signals, not an NSH engine. Native calls are an in-memory spy. */
function fixture(preloaded?: Record<string, unknown>) {
  let receipt: scopeModule.RuntimeScope | null = scope(), generation = 1, activeLifecycle = 'active';
  const cleanups: Array<() => void> = [], effects: Array<() => void> = [];
  let resolve!: (value: unknown) => void;
  const call = vi.fn((name: string, _body: Record<string, unknown>): Promise<unknown> => name === 'resources.read'
    ? new Promise(yes => { resolve = yes; }) : Promise.resolve(true));
  let loaded = false;
  const signal = (initial: unknown) => { let value = initial === null && preloaded && !loaded ? (loaded = true, preloaded) : initial; const read = () => value; read.set = (next: unknown) => { value = next; }; return read; };
  const model = {
    resourcePath: (value: string) => value, resourceName: (value: string) => value.split('/').pop(), resourceWithin: () => true,
    resourceCanPreview: () => true,
    resourceFence: (epoch: () => number) => { let turn = 0; return { cancel: () => { turn++; }, begin: () => { const token = ++turn, at = epoch(); return () => token === turn && at === epoch(); } }; },
  };
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'resources.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'h', jsxFragmentFactory: 'Fragment' } }).outputText;
  const exports: Record<string, (props: Record<string, unknown>) => Node> = {};
  const modules: Record<string, unknown> = {
    nsh: { signal, computed: (fn: () => unknown) => fn, cleanup: (fn: () => void) => cleanups.push(fn), effect: (fn: () => void) => effects.push(fn), untracked: (fn: () => void) => fn(), lifecycle: () => activeLifecycle,
      View: 'View', Text: 'Text', Button: 'Button', Scroll: 'Scroll', Image: 'Image', List: 'List', Clipboard: { writeText: vi.fn() } },
    'nsh/base': { Button: 'Button', Input: 'Input', TextView: 'TextView' },
    './runtime': { native: call, bindRequest: vi.fn(() => vi.fn()) },
    './state': { app: { runtimeScope: () => receipt, connection: () => ({ id: receipt?.hostID }) }, epoch: () => generation },
    './runtime-scope': scopeModule, './resources-request': { bindResourceRead }, './resources-model': model,
    './i18n': { t: (key: string) => key }, './appearance': { nativeChatTextStyle: () => ({}) },
    './resource-web-preview': { bindResourceWebPreview, resourceWebPreviewIntent }, './model': { id: () => 'fixture-read-id' },
  };
  const render = (type: string | ((props: Record<string, unknown>) => Node), props: Record<string, unknown> | null, ...children: unknown[]): Node => {
    if (typeof type === 'function') return type({ ...props, children: children.length === 1 ? children[0] : children });
    if (type === 'Each') {
      const values = props?.of as unknown[];
      return { type, props: props ?? {}, children: values.map(value => (children[0] as (accessor: () => unknown) => Node)(() => value)) };
    }
    return { type, props: props ?? {}, children };
  };
  runInNewContext(compiled, { exports, require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected import ${name}`); return modules[name]; },
    h: render, If: 'If', Each: 'Each', Fragment: 'Fragment', setTimeout, clearTimeout });
  const nodes = (node: unknown): Node[] => !node || typeof node !== 'object' || !('children' in node) ? [] : [node as Node, ...(node as Node).children.flat(Infinity).flatMap(nodes), ...nodes((node as Node).props.else)];
  return {
    mount: (props: Record<string, unknown> = {}) => exports.ResourcePreview({ directory: '/fixture', path: '/fixture/file', ...props }), call, effects, cleanups,
    mountBrowser: (props: Record<string, unknown> = {}) => exports.ResourcesBrowser({ directory: '/fixture', path: '/fixture/file', ...props }),
    nodes,
    refresh: (node: Node) => { const button = nodes(node).find(value => value.type === 'Button' && JSON.stringify(value.children).includes('mobile.files.refreshAria')); if (!button) throw new Error('Refresh action missing'); return button.props.onPress as () => void; },
    scope: (value: scopeModule.RuntimeScope | null) => { receipt = value; }, epoch: () => { generation++; }, background: () => { activeLifecycle = 'background'; }, foreground: () => { activeLifecycle = 'active'; },
    resolve: (value: unknown) => resolve(value),
  };
}
const flush = async () => { for (let index = 0; index < 8; index++) await Promise.resolve(); };
test('production ResourcePreview binds at construction; stale A-B-A cannot borrow a new lease', async () => {
  const f = fixture(), node = f.mount(), refresh = f.refresh(node);
  refresh(); expect(f.call.mock.calls[0]).toEqual(['resources.read', { path: '/fixture/file', requestId: 'fixture-read-id', expectedHost: scope() }]);
  f.resolve({ kind: 'text', lease: 'old-resource', text: 'fixture' }); await flush();
  f.scope(scope('B', '2')); f.scope(scope('A', '3'));
  refresh(); await flush();
  expect(f.call.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
  f.cleanups.forEach(fn => fn()); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.close', { lease: 'old-resource' }]);
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'old-resource' }]);
});
test('production late result releases the old lease; background cancels the old requestId without acquiring a new scope', async () => {
  const f = fixture(), node = f.mount(); f.refresh(node)();
  f.background(); f.effects.forEach(fn => fn());
  expect(f.call.mock.calls).toContainEqual(['resources.cancel', { requestId: 'fixture-read-id' }]);
  f.resolve({ kind: 'text', lease: 'late-old', text: 'late' }); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'late-old' }]);
  expect(f.call.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
});
test('production null authority stays failclosed; inherited preview scope is not replaced by current app scope', async () => {
  const f = fixture(); f.scope(null); const missing = f.mount(); f.scope(scope());
  expect(missing.children).toEqual([]); expect(f.call).not.toHaveBeenCalled();
  const inherited = f.mount({ expectedHost: scope('B', '2') }); expect(inherited.children).toEqual([]); expect(f.call).not.toHaveBeenCalled();
});
test('new foreground owner accepts a new receipt while retained old refresh remains rejected', async () => {
  const f = fixture(), previous = f.refresh(f.mount());
  f.background(); f.epoch(); f.scope(null); f.effects.forEach(fn => fn());
  f.foreground(); f.scope(scope('A', '4'));
  previous(); await flush(); expect(f.call).not.toHaveBeenCalled();
  f.refresh(f.mount())();
  expect(f.call.mock.calls).toEqual([['resources.read', { path: '/fixture/file', requestId: 'fixture-read-id', expectedHost: scope('A', '4') }]]);
});
test('late result checks current native scope even before the cleanup effect runs', async () => {
  const f = fixture(); f.refresh(f.mount())();
  f.scope(scope('B', '2'));
  f.resolve({ kind: 'text', lease: 'late-before-effect', text: 'private old Host' }); await flush();
  expect(f.call.mock.calls).toContainEqual(['resources.release', { lease: 'late-before-effect' }]);
});
test('production Browser child keeps its inherited receipt; late Markdown image cannot borrow the current Host', async () => {
  const browser = fixture(), node = browser.mountBrowser();
  browser.refresh(node)();
  expect(browser.call.mock.calls[0][1].expectedHost).toEqual(scope());
  browser.scope(scope('B', '2')); browser.refresh(node)();
  expect(browser.call.mock.calls.filter(([name]) => name === 'resources.read')).toHaveLength(1);
  const markdown = fixture({ kind: 'text', lease: 'markdown-parent', text: '![fixture](image.png)' });
  const parent = markdown.mount({ path: '/fixture/note.md' });
  const text = markdown.nodes(parent).find(value => value.type === 'TextView');
  expect(text).toBeDefined();
  markdown.scope(scope('B', '2'));
  const image = (text!.props.renderImage as (input: { src: string }) => Node)({ src: 'image.png' });
  expect(image.type).toBe('Each'); expect(image.children).toEqual([]);
  expect(markdown.call).not.toHaveBeenCalled();
});
test('production HTML and Markdown loopback use their constructor receipt; background and retained callbacks stay closed', async () => {
  const html = fixture({ kind: 'text', lease: 'html', text: '<p>fixture</p>' });
  const node = html.mount({ path: '/fixture/index.html' });
  const open = html.nodes(node).find(value => value.props.testID === 'resource-html-preview')!.props.onPress as () => void;
  open(); await flush();
  expect(html.call.mock.calls).toContainEqual(['resources.web.present', { kind: 'html', directory: '/fixture', path: '/fixture/index.html', expectedHost: scope(), owner: 'fixture-read-id' }]);
  html.scope(scope('B', '2')); html.scope(scope('A', '3')); open(); await flush();
  expect(html.call.mock.calls.filter(([name]) => name === 'resources.web.present')).toHaveLength(1);
  const markdown = fixture({ kind: 'text', lease: 'markdown', text: '[test](http://localhost:3000/)' });
  const text = markdown.nodes(markdown.mount({ path: '/fixture/note.md' })).find(value => value.type === 'TextView')!;
  const link = text.props.onLinkPress as (input: { url: string }) => void;
  link({ url: 'http://localhost:3000/' }); await flush();
  expect(markdown.call.mock.calls).toContainEqual(['resources.web.present', { kind: 'loopback', url: 'http://localhost:3000/', expectedHost: scope(), owner: 'fixture-read-id' }]);
  markdown.background(); link({ url: 'http://localhost:3000/' }); await flush();
  expect(markdown.call.mock.calls.filter(([name]) => name === 'resources.web.present')).toHaveLength(1);
  markdown.cleanups.forEach(fn => fn()); await flush();
  expect(markdown.call.mock.calls).toContainEqual(['resources.web.close', { expectedHost: scope(), owner: 'fixture-read-id' }]);
});
