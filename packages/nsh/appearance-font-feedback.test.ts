import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';

type Node = { type: string; props: Record<string, unknown>; children: unknown[] };
function feedback(status: string, error = '', suppressed = false) {
  const retryFonts = vi.fn(async () => {}), refresh = vi.fn(async () => {});
  const notices: Array<{ message: string; severity?: string; onRetry: () => void }> = [];
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'appearance-feedback.tsx'), 'utf8');
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, jsxFactory: 'jsx', target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, (props?: { suppressed: boolean }) => Node> = {};
  const signal = (initial: unknown) => { let value = initial; return Object.assign(() => value, { set: (next: unknown) => { value = next; } }); };
  runInNewContext(code, { exports, If: 'If', jsx: (type: string, props: Record<string, unknown>, ...children: unknown[]) => ({ type, props: props ?? {}, children }),
    require: (name: string) => {
      if (name === 'nsh') return { signal, Text: 'Text', View: 'View' };
      if (name === 'nsh/base') return { Button: 'Button' };
      if (name === './i18n') return { t: (key: string) => key };
      if (name === './error-notice') return { NativeErrorNotice: (props: { message: string; severity?: string; onRetry: () => void }) => { notices.push(props); return { type: 'View', props: {}, children: [props.message, { type: 'Button', props: { onPress: props.onRetry }, children: [] }] }; } };
      if (name === './appearance') return { nativeAppearance: { error: () => error, saving: () => false, current: () => ({ fontStatus: status, unsupportedFonts: ['Raw Private Font Sentinel'] }) }, refreshNativeAppearance: refresh, retryNativeAppearanceFonts: retryFonts };
      throw new Error('Unexpected feedback dependency');
    } });
  const root = exports.NativeAppearanceFeedback({ suppressed });
  const nodes: Node[] = [], text: string[] = [];
  function visit(value: unknown) {
    if (value === undefined || value === null) return;
    if (typeof value === 'string') { text.push(value); return; }
    if (typeof value === 'function') { visit(value()); return; }
    if (typeof value !== 'object') return;
    const node = value as Node;
    if (typeof node.type === 'function') { visit((node.type as (props: unknown) => unknown)(node.props)); return; }
    if (node.type === 'If' && !node.props.when) return;
    nodes.push(node); node.children.forEach(visit);
  }
  visit(root);
  return { text: text.join(''), press: nodes.find(node => node.type === 'Button')?.props.onPress as (() => void) | undefined, retryFonts, refresh, notices };
}
test('actual feedback JSX shows safe unsupported/failure keys and never renders raw font names or Host errors', async () => {
  for (const status of ['unsupported', 'failed']) {
    const view = feedback(status);
    expect(view.text).toContain(status === 'failed' ? 'settings.appearance.fontLoadFailed' : 'settings.appearance.fontUnsupported');
    expect(view.text).not.toContain('Sentinel');
    view.press!(); view.press!(); await Promise.resolve();
    expect(view.retryFonts).toHaveBeenCalledTimes(1); expect(view.refresh).not.toHaveBeenCalled();
  }
  const failedRead = feedback('failed', 'https://secret.example/?bearer=sentinel');
  expect(failedRead.text).toContain('chat.chatInput.toast.reloadFailed'); expect(failedRead.text).not.toContain('secret');
  failedRead.press!(); await Promise.resolve(); expect(failedRead.refresh).toHaveBeenCalledTimes(1); expect(failedRead.retryFonts).not.toHaveBeenCalled();
});
test('pending fonts do not show an unsupported warning while selected faces are still loading', () => {
  const view = feedback('loading'); expect(view.text).toBe(''); expect(view.press).toBeUndefined();
});
test('actual appearance presenter uses warning severity for unsupported fonts and root suppression keeps it out of the shared host', () => {
  expect(feedback('unsupported').notices[0]?.severity).toBe('warning');
  expect(feedback('failed').notices[0]?.severity).toBe('error');
  expect(feedback('unsupported', 'private read failure').notices[0]?.severity).toBe('error');
  expect(feedback('unsupported', '', true).notices).toEqual([]);
});
