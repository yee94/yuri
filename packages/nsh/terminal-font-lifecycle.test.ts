import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import * as scopes from './runtime-scope';
import { createTerminalPresentation } from './terminal-presentation';

it('production terminal font/resize callbacks keep background, owner, scope and invalidation fences without opening a real surface', () => {
  let lifecycle = 'active', receive: (value: unknown) => void = () => {};
  const effects: Array<() => void> = [], calls: Array<{ name: string; body: Record<string, unknown> }> = [];
  const resize = vi.fn();
  const snapshot = { directory: '/fixture', tabs: [{ id: 'tab-a', phase: 'live', chunks: [] }], activeId: 'tab-a', invalidated: false };
  const props = { scope: { hostID: 'host-a', lease: 'lease-a' }, directory: '/fixture', active: true,
    palette: {}, fontFamily: 'Mono', fontSize: 13, onClose: vi.fn(),
    workspace: { snapshot: () => snapshot, controller: { setActive: vi.fn(), setDirectory: vi.fn(), resize } } };
  const modules: Record<string, unknown> = {
    nsh: {
      signal: <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); },
      lifecycle: () => lifecycle, effect: (work: () => void) => effects.push(work), cleanup() {}, untracked: (work: () => unknown) => work(),
      host: { on: (_name: string, listener: (value: unknown) => void) => { receive = listener; return () => {}; },
        call: (name: string, body: Record<string, unknown>) => { calls.push({ name, body }); return Promise.resolve(); } },
      View: 'View', Text: 'Text',
    },
    'nsh/base': { Button: 'Button' }, './i18n': { t: (key: string) => key }, './runtime-scope': scopes,
    './terminal-core': {}, './terminal-presentation': { createTerminalPresentation }, './terminal-discovery': { terminalAutoDiscoverID: 'discover' },
  };
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'terminal.tsx'), 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.React, jsxFactory: 'h', module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports: Record<string, (props: unknown) => unknown> = {};
  new Script(compiled).runInNewContext({ exports, If: 'If', h: () => null, setTimeout, clearTimeout,
    require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected runtime dependency ${name}`); return modules[name]; } });
  exports.NativeTerminalPage(props);
  const rerun = () => effects.forEach(work => work());
  rerun();
  const open = calls.find(call => call.name === 'terminal.preview.open')!;
  const event = (type: string, extra: Record<string, unknown> = {}) => receive({ type, owner: open.body.owner, expectedHost: open.body.expectedHost, ...extra });
  event('ready'); rerun();
  const fonts = () => calls.filter(call => call.name === 'terminal.preview.render' && call.body.fontPreferences);
  expect(fonts()).toHaveLength(1);
  props.fontSize = 26; rerun();
  expect(fonts().at(-1)?.body.fontPreferences).toEqual({ fontSize: 26, fontFamily: 'Mono' });
  event('resize', { key: 'tab-a', cols: 40, rows: 12 }); expect(resize).toHaveBeenCalledExactlyOnceWith({ cols: 40, rows: 12 });
  event('resize', { key: 'tab-a', cols: 10, rows: 5, owner: 'old-surface' }); expect(resize).toHaveBeenCalledTimes(1);
  const fontCalls = fonts().length;
  lifecycle = 'background'; props.fontSize = 39;
  event('resize', { key: 'tab-a', cols: 20, rows: 8 }); rerun();
  expect(fonts()).toHaveLength(fontCalls); expect(resize).toHaveBeenCalledTimes(1);
  lifecycle = 'active'; props.scope = { hostID: 'host-a', lease: 'lease-b' };
  event('resize', { key: 'tab-a', cols: 20, rows: 8 }); rerun();
  expect(fonts()).toHaveLength(fontCalls); expect(resize).toHaveBeenCalledTimes(1);
  props.scope = { hostID: 'host-a', lease: 'lease-a' }; snapshot.invalidated = true;
  event('ready'); rerun(); expect(fonts()).toHaveLength(fontCalls);
  expect(calls.filter(call => call.name === 'terminal.preview.open')).toHaveLength(1);
});
