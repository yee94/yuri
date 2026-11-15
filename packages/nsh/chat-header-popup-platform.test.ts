import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';

const directory = path.dirname(fileURLToPath(import.meta.url));

function fixture(os: string, nativeSlot: boolean) {
  const calls = vi.fn(async () => null), changed = vi.fn(), error = vi.fn();
  const effects: Array<() => void> = [];
  const elements: Array<{ type: unknown; props: Record<string, unknown> }> = [];
  const jsx = (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => {
    const node = { type, props: props ?? {}, children };
    elements.push(node);
    return node;
  };
  const modules: Record<string, unknown> = {
    nsh: { platform: { os }, cleanup: () => {}, effect: (work: () => void) => effects.push(work),
      signal: (initial: unknown) => { let value = initial; return Object.assign(() => value, { set: (next: unknown) => { value = next; } }); },
      untracked: (work: () => void) => work(), windowSize: () => ({ width: 390, height: 844 }), Overlay: 'Overlay' },
    'nsh/base': { Popover: 'Popover' }, './runtime': { native: calls }, './glass-surface': { glassEdge: () => ({ boxShadow: 'glass' }) },
  };
  const exports: { ChatHeaderPopup?: (props: unknown) => unknown } = {};
  const source = ts.transpileModule(readFileSync(path.join(directory, 'chat-header-popup.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'jsx', target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(source, { exports, jsx, If: 'If', require: (key: string) => modules[key] });
  let triggerPress: (() => void) | undefined;
  const props = { native: nativeSlot, anchorID: 'chat-header-metadata', open: true, current: () => true,
    popupStyle: { width: 300 }, onError: error, onOpenChange: changed,
    trigger: (press?: () => void) => { triggerPress = press; return jsx('Button', { onPress: press }); } };
  const root = exports.ChatHeaderPopup!(props) as { props: { when: boolean } };
  effects.forEach(work => work());
  return { root, calls, changed, error, trigger: () => triggerPress?.(), elements };
}

test('Android header slot uses rendered Popover bounds and opens without the iOS anchor bridge', async () => {
  const page = fixture('android', true);
  expect(page.root.props.when).toBe(false);
  const popover = page.elements.find(node => node.type === 'Popover')!;
  (popover.props.onOpenChange as (event: unknown) => void)({ open: false, reason: 'triggerPress' });
  expect(page.changed).toHaveBeenCalledWith({ open: false, reason: 'triggerPress' });
  await Promise.resolve(); await Promise.resolve();
  expect(page.calls).not.toHaveBeenCalled();
  expect(page.error).not.toHaveBeenCalled();
});

test('iOS bar slot still requires its authoritative UIKit anchor', async () => {
  const page = fixture('ios', true);
  expect(page.root.props.when).toBe(true);
  await Promise.resolve(); await Promise.resolve();
  expect(page.calls).toHaveBeenCalledWith('navigation.anchor', { id: 'chat-header-metadata' });
  expect(page.changed).toHaveBeenCalledWith({ open: false, reason: 'cancel' });
  expect(page.error).toHaveBeenCalledOnce();
});
