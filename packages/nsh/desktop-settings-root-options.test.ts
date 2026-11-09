import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it, vi } from 'vitest';
import { createDesktopSettingsRootOwner } from './desktop-settings-root-core';

type Node = { type: string | ((props: Record<string, unknown>) => Node); props: Record<string, unknown>; children: unknown[] };
function fixture() {
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  const jsx = (type: Node['type'], props: Node['props'] | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children });
  const cleanups: Array<() => void> = [], operation = { marker: 'captured-operation' };
  const modules: Record<string, unknown> = {
    nsh: { signal, computed: (read: () => unknown) => read, cleanup: (stop: () => void) => cleanups.push(stop), effect: (work: () => void) => work(), untracked: (work: () => unknown) => work(), lifecycle: () => 'active' },
    './state': { app: { connection: () => ({ id: 'synthetic-root', url: 'https://settings.example.invalid', authorizationID: 'synthetic-authorization' }) } },
    './page-operations': { createPageOperations: () => ({ operation: () => operation }) },
    './desktop-settings': { NativeDesktopSettingsWindow: 'Window' },
    './desktop-settings-content': { NativeDesktopSettingsContent: 'Content' },
    './desktop-settings-root-core': { createDesktopSettingsRootOwner },
  };
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop-settings-root.tsx'), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
  const exports: Record<string, unknown> = {};
  vm.runInNewContext(output, { exports, jsx, If: 'If', Each: 'Each', require: (name: string) => { if (!(name in modules)) throw new Error(`Unexpected root dependency: ${name}`); return modules[name]; } });
  const create = exports.createNativeDesktopSettingsRoot as typeof import('./desktop-settings-root').createNativeDesktopSettingsRoot;
  function window(root: ReturnType<typeof create>): Node {
    const each = (root.Root() as unknown as Node).children[0] as Node;
    const content = (each.children[0] as () => Node)();
    return (content.type as (props: Node['props']) => Node)(content.props);
  }
  return { create, window, operation, dispose: () => cleanups.reverse().forEach(stop => stop()) };
}

it.each([undefined, false, true])('root forwards codeTypographyReady=%s and the exact native slot without invoking it or changing default readiness', async ready => {
  const f = fixture(), remote = vi.fn(() => null), shortcuts = vi.fn(() => null), retention = {} as never;
  const root = f.create({ callbacks: { onConnect: vi.fn() }, retention: () => retention, codeTypographyReady: ready, remoteConnections: remote, shortcuts, onError: error => { throw error; } });
  try {
    await root.open({ page: 'appearance', directory: '/synthetic/selected' });
    const window = f.window(root);
    const render = window.props.renderPage as (context: Record<string, unknown>) => Node;
    const content = render({ route: { page: 'appearance', directory: '/synthetic/selected' }, active: true });
    expect(content.type).toBe('Content'); expect(content.props.codeTypographyReady).toBe(ready);
    expect(content.props.remoteConnections).toBe(remote); expect(content.props.shortcuts).toBe(shortcuts);
    expect(content.props.retention).toBe(retention); expect(content.props.operationToken).toBe(f.operation);
    expect(remote).not.toHaveBeenCalled(); expect(shortcuts).not.toHaveBeenCalled();
  } finally { f.dispose(); }
});
