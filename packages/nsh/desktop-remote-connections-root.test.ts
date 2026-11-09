import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';
import * as core from './desktop-remote-connections-core';
import * as projection from './desktop-header-instances-root-core';
import type { createNativeDesktopRemoteConnectionsRoot } from './desktop-remote-connections-root';

const row: core.DesktopSshInstance = { id: 'ssh-a', label: 'Synthetic', host: 'ssh.example.invalid', user: 'fixture', port: 22, remotePort: 3210, localPort: 0, managed: true };
async function settle() { for (let i = 0; i < 24; i++) await Promise.resolve(); }
function fixture(admission?: core.DesktopSshConnectionAdmission) {
  let controller!: core.DesktopRemoteConnectionsController, serial = 0, live = true;
  let value: core.DesktopSshSnapshot = { revision: 1, saving: false, instances: [row], statuses: [], receipts: [] };
  let finish!: (value: unknown) => void, fail!: (error: Error) => void;
  const read = vi.fn(async () => value), start = vi.fn((_input: { requestID: string; id: string }) => new Promise<unknown>((yes, no) => { finish = yes; fail = no; }));
  const port = { current: () => live, ready: () => true, refreshCapabilities: vi.fn(async () => {}), newID: () => `request-${++serial}`, read, start,
    save: vi.fn(), remove: vi.fn(), cancel: vi.fn(), syncSupported: false as const, dispose: vi.fn() };
  const discovery = vi.fn(async () => port), cleanups: (() => void)[] = [];
  const signal = <T,>(initial: T) => { let value = initial; return Object.assign(() => value, { set(next: T) { value = next; } }); };
  const imports: Record<string, unknown> = {
    nsh: { host: { call: () => {}, available: () => true }, lifecycle: () => 'active', signal, cleanup: (work: () => void) => cleanups.push(work), effect: (work: () => void) => work(), untracked: (work: () => unknown) => work(), Text: 'Text', View: 'View' },
    'nsh/base': { Button: 'Button' }, './desktop-remote-connections-native': { loadNativeDesktopRemoteConnections: discovery },
    './desktop-remote-connections': { createDesktopConnectionOnlyRemoteConnections(_port: core.DesktopRemoteConnectionsPort, options: core.DesktopRemoteConnectionsOptions) {
      controller = core.createDesktopRemoteConnectionsController(_port, options);
      return { controller, slot: () => null, dispose: controller.dispose };
    } },
    './desktop-settings-publisher': { publishSettingsEditor: () => {} }, './settings-controls': { settingsAction: '' }, './i18n': { t: (key: string) => key }, './desktop-header-instances-root-core': projection,
  };
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'desktop-remote-connections-root.tsx'), 'utf8');
  const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
  const exports: { createNativeDesktopRemoteConnectionsRoot?: typeof createNativeDesktopRemoteConnectionsRoot } = {};
  vm.runInNewContext(js, { exports, require: (key: string) => { if (!(key in imports)) throw new Error(`unexpected import ${key}`); return imports[key]; }, If: 'If',
    jsx: (type: unknown, props: unknown) => typeof type === 'function' ? type(props) : null,
  });
  const root = exports.createNativeDesktopRemoteConnectionsRoot!({ current: () => live, runtimeReady: () => true, connectionMutation: admission });
  return { root, read, start, discovery, port, controller: () => controller, set: (next: core.DesktopSshSnapshot) => { value = next; },
    mount() { root.slot({ active: true }); controller.setActive(true); },
    unmount() { controller.setActive(false); cleanups.splice(0).reverse().forEach(work => work()); },
    finish: (value: unknown) => finish(value), fail: () => fail(new Error('lost native start response')), retire: () => { live = false; },
  };
}

test('startup capability cache and 50 Header/input projections do not construct/read/activate another owner', async () => {
  const f = fixture(); await settle();
  expect(Object.isFrozen(f.root)).toBe(true); expect(Object.isFrozen(f.root.guard)).toBe(true);
  for (let i = 0; i < 50; i++) { expect(f.root.snapshot().snapshotReady).toBe(false); expect(f.root.header.projection().available).toBe(false); f.root.guard.canLeave(); }
  expect(f.discovery).toHaveBeenCalledTimes(1); expect(f.read).not.toHaveBeenCalled(); expect(f.start).not.toHaveBeenCalled();
  f.mount(); await settle(); expect(f.root.snapshot().snapshotReady).toBe(true); expect(f.root.snapshot().ready).toBe(true);
  f.unmount(); const reads = f.read.mock.calls.length;
  for (let i = 0; i < 50; i++) { f.root.snapshot(); f.root.header.projection(); }
  expect(f.read).toHaveBeenCalledTimes(reads); expect(f.discovery).toHaveBeenCalledTimes(1);
});

test('unknown start + Settings unmount leaves main guard veto; no popup disposal/late callback can unlock it', async () => {
  const f = fixture(mutation => mutation.dispatch()); await settle(); f.mount(); await settle();
  const connect = f.root.connectFromSettings(row, { current: () => true });
  expect(f.root.guard.canLeave()).toBe(false); expect(await f.root.guard.requestWindowClose()).toBe(false);
  f.unmount(); f.fail(); expect(await connect).toEqual({ status: 'unknown' });
  expect(f.root.guard.canLeave()).toBe(false); expect(f.root.guard.canWindowClose()).toBe(false);
  const calls = f.read.mock.calls.length;
  for (let i = 0; i < 50; i++) { f.root.header.projection(); f.root.snapshot(); expect(f.root.guard.canLeave()).toBe(false); }
  expect(f.read).toHaveBeenCalledTimes(calls); expect(f.start).toHaveBeenCalledTimes(1);
  await f.root.refresh(); expect(f.root.guard.canLeave()).toBe(false);
  f.root.dispose(); expect(f.root.guard.canLeave()).toBe(false);
});

test('Header and Settings share exact admission and release-ACK ordering without activating SSH polling', async () => {
  const order: string[] = []; let release!: () => void;
  const f = fixture(async mutation => {
    order.push(`prepare:${mutation.source}`); expect(mutation.current()).toBe(true); expect(mutation.canLeave()).toBe(true);
    await new Promise<void>(yes => { release = yes; }); order.push('old-writer-release-ACK');
    return mutation.dispatch();
  });
  await settle(); f.mount(); await settle(); f.unmount();
  const reads = f.read.mock.calls.length;
  const connect = f.root.connectFromHeader(row, { current: () => true });
  expect(order).toEqual(['prepare:header']); expect(f.start).not.toHaveBeenCalled(); expect(f.root.guard.canLeave()).toBe(false);
  release(); await settle(); expect(f.start).toHaveBeenCalledTimes(1);
  const requestID = f.start.mock.calls[0][0].requestID;
  f.finish({ revision: 1, saving: false, instances: [row], receipts: [requestID], statuses: [{ id: row.id, attempt: 1, requestID, phase: 'auth_check', running: true, retry: 0, error: null, connectionID: null }] });
  expect(await connect).toEqual({ status: 'accepted' }); expect(f.root.guard.canLeave()).toBe(false);
  expect(order).toEqual(['prepare:header', 'old-writer-release-ACK']); expect(f.read).toHaveBeenCalledTimes(reads);
  expect(f.root.snapshot().connection).toMatchObject({ source: 'header', dispatched: true, phase: 'running', requestID });
});

test('Settings cannot use Header-only callback or absent admission as a native authorization', async () => {
  const f = fixture(); await settle(); f.mount(); await settle();
  expect((await f.root.connectFromSettings(row, { current: () => true })).status).toBe('unsupported');
  expect(await f.controller().start(row.id, 'connect')).toBe(false); expect(f.start).not.toHaveBeenCalled();
});
