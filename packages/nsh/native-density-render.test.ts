import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { nativeLayoutDensity } from './native-density';

type Node = { type: unknown; props: Record<string, unknown>; children: unknown[] };
const root = path.dirname(fileURLToPath(import.meta.url));
function load(file: string, padding: number) {
  const exports: Record<string, (...args: never[]) => Node> = {};
  const jsx = (type: unknown, props: Node['props'], ...children: unknown[]): Node => ({ type, props: props ?? {}, children });
  vm.runInNewContext(ts.transpileModule(readFileSync(path.join(root, file), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' },
  }).outputText, { exports, jsx, If: 'If', Each: 'Each', require(id: string) {
    if (id === 'nsh') return { View: 'View', Text: 'Text', signal: <T>(value: T) => Object.assign(() => value, { set(next: T) { value = next; } }) };
    if (id === 'nsh/base') return { Button: 'Button', Input: 'Input', Switch: 'Switch' };
    if (id === './native-select') return { NativeSelect: 'NativeSelect' };
    if (id === './appearance') return { nativeDensity: () => nativeLayoutDensity(padding) };
    if (id === './i18n') return { t: (key: string) => key };
    if (id === './Icon') return { Icon: 'Icon' };
    if (id === './state' || id === './settings-protocol') return {};
    if (id === './composer-surface') return { nativeComposerSurface: { glassEffect: 'regular' } };
    throw new Error('Unexpected density render dependency: ' + id);
  } });
  return exports;
}
function find(node: Node, type: string): Node {
  if (node.type === type) return node;
  for (const child of node.children) if (child && typeof child === 'object' && 'props' in child) {
    try { return find(child as Node, type); } catch { /* Try the next child. */ }
  }
  throw new Error('Missing render node: ' + type);
}

it.each([50, 100, 105, 200])('SettingsInput %s%% keeps the real input, font seam and exact edit callback', padding => {
  const controls = load('settings-controls.tsx', padding) as unknown as typeof import('./settings-controls');
  const change = vi.fn(), field = controls.SettingsInput({ title: 'title', value: 'draft', onChange: change, inputStyle: { fontFamily: 'monospace', fontSize: 18 }, testID: 'editor' }) as Node;
  const input = find(field, 'Input'), style = input.props.style as Record<string, number | string>;
  expect(style.paddingHorizontal).toBeCloseTo(12 * Math.sqrt(padding / 100));
  expect(style.minHeight).toBeGreaterThanOrEqual(44);
  expect(style.fontFamily).toBe('monospace'); expect(style.fontSize).toBe(18);
  expect(input.props.value).toBe('draft'); expect(input.props.testID).toBe('editor');
  (input.props.onChange as (event: { value: string }) => void)({ value: '编辑中' });
  expect(change.mock.calls).toEqual([['编辑中']]);
});

it.each([50, 100, 105, 200])('composer chrome %s%% retains its sole measured-height broadcast and fixed compact geometry', padding => {
  const controls = load('chat-chrome-surfaces.tsx', padding) as unknown as typeof import('./chat-chrome-surfaces');
  const onHeight = vi.fn();
  const tree = controls.NativeComposerChrome({ state: { swap: { progress: 0, phase: 'tracking' } } as Parameters<typeof controls.NativeComposerChrome>[0]['state'], bottom: 29, children: 'same-editor', compact: 'compact-controls', onHeight }) as Node;
  const expanded = tree.children[0] as Node, compact = tree.children[1] as Node;
  expect(expanded.children).toEqual(['same-editor']);
  const style = compact.props.style as Record<string, unknown>;
  expect(style.height).toBe(44); expect(style.bottom).toBe(29);
  expect(style.paddingHorizontal).toBeCloseTo(8 * Math.sqrt(padding / 100));
  expect(style.gap).toBeCloseTo(4 * Math.sqrt(padding / 100));
  (expanded.props.onLayout as (event: unknown) => void)({ bounds: { size: { height: 212.25 } } });
  expect(onHeight.mock.calls).toEqual([[212.25]]);
});

it.each([50, 100, 105, 200])('send/stop %s%% share spacing geometry and retain delivery callbacks with a 44pt effective target', padding => {
  const controls = load('composer-send.tsx', padding) as unknown as typeof import('./composer-send');
  const send = vi.fn(), stop = vi.fn();
  const tree = controls.NativeComposerSend({ disabled: false, inFlight: false, onPress: send, canAbort: true, hasContent: false, onStop: stop }) as Node;
  const sendButton = tree.props.else as Node, stopButton = tree.children[0] as Node;
  expect(tree.props.when).toBe(true);
  expect(sendButton.props.style).toEqual(stopButton.props.style);
  const size = sendButton.props.style as { width: number; height: number };
  expect(size.width).toBeCloseTo(32 * Math.sqrt(padding / 100));
  expect(size.height + 2 * Number(sendButton.props.hitSlop)).toBeGreaterThanOrEqual(44);
  expect(sendButton.props.onPress).toBe(send);
  (stopButton.props.onPress as () => void)(); expect(stop).toHaveBeenCalledOnce();
  const pending = controls.NativeComposerSend({ disabled: false, inFlight: true, onPress: send, canAbort: true, hasContent: true, onStop: stop }) as Node;
  expect(pending.props.when).toBe(false);
  expect((pending.props.else as Node).props.disabled).toBe(true);
  expect(send).not.toHaveBeenCalled();
});
