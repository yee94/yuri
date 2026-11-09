import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import { createResourceConnectionClear } from './resource-retirement';

const root = path.dirname(fileURLToPath(import.meta.url));
type Node = { type: string | ((props: Record<string, unknown>) => Node); props: Record<string, unknown>; children: Node[] };
type Insets = { top: number; bottom: number; left: number; right: number };
const flush = async () => { for (let count = 0; count < 12; count++) await Promise.resolve(); };
function render(insets: Insets) {
  const signals: Array<() => unknown> = [];
  const signal = <T>(initial: T) => {
    let value = initial;
    const read = Object.assign(() => value, { set: (next: T) => { value = next; } }); signals.push(read); return read;
  };
  const native = vi.fn(async (name: string) => name === 'connection.list' ? {
    connections: [{ id: 'fixture', url: 'https://synthetic.invalid' }], selected: 'fixture', runtimeScope: null,
  } : { controlsEnabled: true });
  const safeArea = vi.fn(() => insets), post = vi.fn();
  let entry!: () => Node;
  const jsx = (type: Node['type'], props: Node['props'] | null, ...children: Node[]): Node => ({ type, props: props ?? {}, children });
  const modules: Record<string, unknown> = {
    nsh: { signal, safeArea, cleanup: () => {}, effect: () => {}, untracked: (work: () => unknown) => work(), mount: (value: () => Node) => { entry = value; },
      host: { params: { resourceGlobalClearSyntheticOnly: true }, on: () => () => {}, post }, Scroll: 'Scroll', Text: 'Text', View: 'View' },
    'nsh/base': { Button: 'Button', NavPage: 'NavPage', NavStack: 'NavStack', createNavStack: (initial: unknown[]) => {
      let routes = initial; return { routes: () => routes, setRoutes: (next: unknown[]) => { routes = next; }, popToRoot: () => { routes = routes.slice(0, 1); }, push: (value: unknown) => { routes = [...routes, value]; }, pop: () => { routes = routes.slice(0, -1); } };
    } },
    '../../resource-navigation': { ResourcePreviewPage: 'ResourcePreviewPage' }, '../../resource-retirement': { createResourceConnectionClear },
    '../../state': { app: { connection: { set: vi.fn() }, runtimeScope: { set: vi.fn() } } },
    '../../runtime': { native, connectionSnapshotFrom: (value: unknown) => value }, '../../i18n': { language: { set: vi.fn() } },
    './connection-effect': { installProductionConnectionEffect: vi.fn() },
  };
  const exports = {} as { GlobalClearFixtureToolbar(props: Record<string, unknown>): Node };
  const source = readFileSync(path.join(root, 'tests/resource-global-clear-uikit/fixture.tsx'), 'utf8');
  const output = ts.transpileModule(source, { fileName: 'fixture.tsx', compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
  vm.runInNewContext(output, { exports, jsx, If: 'If', require: (id: string) => { if (!(id in modules)) throw Error('Unexpected fixture import: ' + id); return modules[id]; } });
  const tree = entry(), toolbarProps = tree.children[0].props;
  const toolbar = (enabled = false) => exports.GlobalClearFixtureToolbar({ ...toolbarProps, enabled });
  const buttons = (enabled = false) => toolbar(enabled).children.flatMap(row => row.children);
  const press = (id: string, enabled = false) => {
    const button = buttons(enabled).find(value => value.props.testID === id)!;
    if (button.props.disabled) throw Error('Disabled fixture button');
    (button.props.onPress as () => void)();
  };
  return { tree, toolbar, buttons, press, native, post, signals, safeArea };
}

for (const viewport of [
  { width: 402, height: 874, insets: { top: 62, bottom: 34, left: 0, right: 0 } },
  { width: 320, height: 568, insets: { top: 20, bottom: 0, left: 0, right: 0 } },
  { width: 844, height: 390, insets: { top: 0, bottom: 21, left: 59, right: 59 } },
]) test(`fixture static layout constraints keep all four controls safe and 44pt at ${viewport.width}×${viewport.height}`, () => {
  const f = render(viewport.insets), padding = f.tree.props.style as Record<string, number>, toolbar = f.toolbar();
  expect(f.safeArea).toHaveBeenCalled();
  expect(padding).toEqual({ paddingTop: viewport.insets.top, paddingBottom: viewport.insets.bottom, paddingLeft: viewport.insets.left, paddingRight: viewport.insets.right });
  expect(toolbar.props.class).toContain('shrink-0'); expect(toolbar.children).toHaveLength(2);
  const units = (classes: unknown, prefix: string) => Number(String(classes).split(' ').find(value => value.startsWith(prefix + '-'))!.slice(prefix.length + 1)) * 4;
  const edge = units(toolbar.props.class, 'p'), rowGap = units(toolbar.props.class, 'gap');
  const available = viewport.width - padding.paddingLeft - padding.paddingRight;
  let y = padding.paddingTop + edge;
  for (const row of toolbar.children) {
    expect(row.children).toHaveLength(2); expect(row.props.class).toContain('flex-row');
    const gap = units(row.props.class, 'gap'), width = (available - 2 * edge - gap) / 2;
    for (const [column, button] of row.children.entries()) {
      const height = units(button.props.class, 'h'), x = padding.paddingLeft + edge + column * (width + gap);
      expect(height).toBe(44); expect(units(button.props.class, 'min-h')).toBe(44); expect(width).toBeGreaterThanOrEqual(44);
      expect(button.children[0].props.style).toEqual({ numberOfLines: 1 });
      expect(button.props.accessibilityLabel).toEqual(expect.any(String));
      expect(x).toBeGreaterThanOrEqual(viewport.insets.left); expect(x + width).toBeLessThanOrEqual(viewport.width - viewport.insets.right);
      expect(y).toBeGreaterThanOrEqual(viewport.insets.top); expect(y + height).toBeLessThanOrEqual(viewport.height - viewport.insets.bottom);
    }
    y += 44 + rowGap;
  }
  const toolbarHeight = y - rowGap + edge - padding.paddingTop;
  expect(toolbarHeight).toBe(112);
  expect(viewport.height - padding.paddingTop - padding.paddingBottom - toolbarHeight).toBeGreaterThanOrEqual(144);
  const nav = f.tree.children[1].children[0];
  expect(nav.type).toBe('NavStack'); expect(nav.props.class).toContain('flex-1'); expect(nav.props.class).toContain('min-h-0');
});

test('actual fixture TSX buttons preserve opt-in, audit and both arm callbacks with disabled gates before enable', async () => {
  const f = render({ top: 62, bottom: 34, left: 0, right: 0 }); await flush();
  expect(() => f.press('resource-global-arm')).toThrow('Disabled fixture button');
  expect(() => f.press('resource-global-arm-twice')).toThrow('Disabled fixture button');
  f.press('resource-global-enable'); await flush();
  expect(f.native).toHaveBeenCalledWith('fixture.globalClear.control', { action: 'enable' });
  expect(f.signals[1]()).toBe(true);
  expect(f.native).toHaveBeenCalledWith('fixture.globalClear.audit');
  f.press('resource-global-arm', true); await flush();
  f.press('resource-global-arm-twice', true); await flush();
  expect(f.native.mock.calls.filter(([name]) => name === 'fixture.globalClear.control')).toEqual([
    ['fixture.globalClear.control', { action: 'enable' }], ['fixture.globalClear.control', { action: 'arm' }], ['fixture.globalClear.control', { action: 'armTwice' }],
  ]);
  const before = f.native.mock.calls.length; f.press('resource-global-audit', true); await flush();
  expect(f.native.mock.calls.slice(before)).toEqual([['fixture.globalClear.audit']]);
  expect(f.post).not.toHaveBeenCalled();
});
