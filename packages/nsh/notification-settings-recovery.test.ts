import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import ts from 'typescript';
import { expect, it } from 'vitest';
import * as preferences from './notification-preferences-core';
import * as protocol from './settings-protocol';
import * as search from './settings-search-core';
import * as notificationCore from './notification-core';

const root = path.dirname(fileURLToPath(import.meta.url));
const flush = async () => { for (let turn = 0; turn < 80; turn++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
type Node = { type: string; props: Record<string, unknown>; children: unknown[] };

/** Actual page/controller/lane owner with inert JSX and a synthetic, memory-only Host.
 * No NSH renderer, OS permission, credentials or production configuration is used. */
function fixture(target?: string) {
  let observer: (() => void) | null = null;
  const pending = new Set<() => void>(), cleanups: Array<() => void> = [];
  function signal<T>(initial: T) {
    let value = initial; const subscribers = new Set<() => void>();
    return Object.assign(() => { if (observer) subscribers.add(observer); return value; }, { set(next: T) {
      if (Object.is(next, value)) return; value = next;
      for (const run of subscribers) if (!pending.has(run)) { pending.add(run); queueMicrotask(() => { pending.delete(run); run(); }); }
    } });
  }
  const untracked = <T>(work: () => T) => { const previous = observer; observer = null; try { return work(); } finally { observer = previous; } };
  const effect = (work: () => void) => { const run = () => { const previous = observer; observer = run; try { work(); } finally { observer = previous; } }; run(); };
  const active = signal(true), foreground = signal(true), ready = signal(true), generation = signal(1);
  const connection = signal({ id: 'synthetic-notifications', url: 'https://notifications.example.invalid', authorizationID: 'synthetic-auth' });
  const scope = signal({ hostID: 'synthetic-notifications', lease: 'synthetic-lease-1' });
  const calls: string[] = [], writes: preferences.NotificationPreferences[] = [];
  let host: preferences.NotificationPreferences = { nativeNotificationsEnabled: false, notifyOnError: false };
  let read = async () => host, write = async (_changes: preferences.NotificationPreferences) => {};
  const currentScope = () => ready() && foreground() ? { hostID: connection().id, generation: generation() } : null;
  const transport = preferences.createNotificationSettingsTransport({ desktop: true, scope: currentScope, language: () => 'en',
    read: () => { calls.push('GET'); return read(); }, write: changes => { calls.push('PUT'); writes.push(changes); return write(changes); },
    call: async name => { calls.push(name); return { lease: 'synthetic-notification-lease' }; },
  });
  const app = { connection, runtimeScope: scope };
  function captureHostOperation() {
    const captured = generation(), identity = connection(), lease = scope(), admitted = ready() && foreground();
    return { generation: captured, scope: lease, hostID: identity.id, origin: identity.url, authorizationID: identity.authorizationID,
      current: () => admitted && ready() && foreground() && generation() === captured && connection() === identity && scope() === lease,
      request: async () => { throw new Error('Unexpected direct request outside shared notification transport'); },
    };
  }
  const jsx = (type: string, props: Record<string, unknown> | null, ...children: unknown[]): Node => ({ type, props: props ?? {}, children });
  const nsh = { signal, computed: (read: () => unknown) => read, effect, untracked, cleanup: (stop: () => void) => cleanups.push(stop), lifecycle: () => foreground() ? 'active' : 'background', platform: { os: 'macos', desktop: true }, host: { on: () => () => {} }, Scroll: 'Scroll', Text: 'Text', View: 'View' };
  const modules: Record<string, unknown> = { nsh, 'nsh/base': { Button: 'Button' }, './native-select': {}, './settings-protocol': protocol,
    './state': { app, epoch: generation, captureHostOperation, captureHostRequest: () => captureHostOperation().request },
    './i18n': { t: (key: string) => key }, './settings-target': { SettingsTarget: 'Target' }, './settings-search-core': search,
    './notification': { SettingsNativeNotifications: 'NativeNotifications' },
    './notification-runtime': { nativeNotificationScope: currentScope, nativeNotificationSettings: transport, currentNotificationLanguage: () => 'en' }, './notification-preferences-core': preferences,
    './notification-core': notificationCore, './runtime': { native: () => { throw new Error('Uninjected native call'); } },
    './desktop-settings-publisher': { publishSettingsPending: () => {}, publishSettingsEditor: () => {}, publishSettingsPicker: () => {} },
  };
  function load(file: string, observe = false) {
    let source = readFileSync(path.join(root, file), 'utf8');
    if (observe) {
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const component = ast.statements.find((node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === (file === 'notification.tsx' ? 'SettingsNativeNotifications' : 'SettingsNotifications'))!;
      const result = component.body!.statements.findLast(ts.isReturnStatement)!;
      const observations = file === 'notification.tsx' ? 'enable, busy, status, error' : 'controller, state, lifetime, current, blocked';
      source = source.slice(0, result.getStart(ast)) + `return { ${observations}, render: () => (${result.expression!.getText(ast)}) };` + source.slice(result.end);
    }
    const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023, jsx: ts.JsxEmit.React, jsxFactory: 'jsx' } }).outputText;
    const exports: Record<string, unknown> = {};
    vm.runInNewContext(output, { exports, jsx, If: 'If', Each: 'Each', require: (name: string) => { if (!(name in modules)) throw new Error('Unexpected notification dependency: ' + name); return modules[name]; } });
    return exports;
  }
  modules['./settings-controls'] = load('settings-controls.tsx');
  const component = load('notification-settings.tsx', true).SettingsNotifications as (props: object) => {
    controller: ReturnType<typeof preferences.createNotificationPreferencesController>; render(): Node; current(): boolean; blocked(): boolean;
    lifetime: { operation(): unknown };
  };
  const page = component({ target, get active() { return active(); } });
  return { page, active, foreground, ready, generation, connection, scope, calls, writes,
    permission(call: notificationCore.NotificationCall) {
      const edited: boolean[] = [], busy: boolean[] = [];
      const create = load('notification.tsx', true).SettingsNativeNotifications as (props: object) => { enable(value: boolean): Promise<void>; busy(): boolean };
      const child = create({ hostID: connection().id, enabled: false, current: page.current, get operationToken() { return page.lifetime.operation(); },
        get active() { return active(); }, onEnabledChange: (value: boolean) => edited.push(value), onBusyChange: (value: boolean) => busy.push(value), call });
      return { child, edited, busy };
    },
    setHost(value: preferences.NotificationPreferences) { host = value; }, setRead(next: typeof read) { read = next; }, setWrite(next: typeof write) { write = next; },
    dispose() { for (const stop of cleanups.reverse()) stop(); },
  };
}
function nodes(root: Node): Node[] {
  if (root.type === 'If' && !root.props.when) return [];
  return [root, ...root.children.flatMap(child => child && typeof child === 'object' && 'type' in child ? nodes(child as Node) : [])];
}

it('notification page recovers the actual same-Host lane after cover/background/readiness and lease gaps without losing the draft', async () => {
  const f = fixture();
  try {
    await flush(); expect(f.calls).toEqual(['GET', 'notification.configure']);
    f.page.controller.edit('nativeNotificationsEnabled', true);
    for (const source of [f.active, f.foreground, f.ready]) {
      source.set(false); await flush(); expect(f.page.current()).toBe(false); const count = f.calls.length;
      source.set(true); await flush(); expect(f.page.current()).toBe(true); expect(f.calls.length).toBe(count + 2);
      expect(f.page.controller.state().draft).toEqual({ nativeNotificationsEnabled: true });
    }
    f.scope.set({ hostID: 'synthetic-notifications', lease: 'synthetic-lease-2' }); f.generation.set(2); await flush();
    expect(f.page.current()).toBe(true); expect(f.page.controller.state().draft).toEqual({ nativeNotificationsEnabled: true }); expect(f.writes).toEqual([]);
    const count = f.calls.length;
    f.connection.set({ ...f.connection(), authorizationID: 'different-auth' }); await flush();
    expect(f.page.current()).toBe(false); expect(f.page.blocked()).toBe(true); expect(f.calls).toHaveLength(count);
  } finally { f.dispose(); }
});

it('actual page fences a late read and PUT ACK across replacement lanes and retains the unknown journal until read-back', async () => {
  const f = fixture(), ack = deferred<void>(), stale = deferred<preferences.NotificationPreferences>();
  try {
    await flush(); f.page.controller.edit('nativeNotificationsEnabled', true); f.setWrite(() => ack.promise);
    const saving = f.page.controller.save(); f.active.set(false); await flush();
    expect(f.page.controller.state()).toMatchObject({ pending: 'unknown', busy: false });
    f.active.set(true); await flush(); expect(f.writes).toHaveLength(1); expect(f.page.controller.state().pending).toBe('unknown');
    ack.resolve(); await saving; expect(f.page.controller.state().pending).toBe('unknown');
    f.setHost({ nativeNotificationsEnabled: true, notifyOnError: false }); await f.page.controller.refresh();
    expect(f.page.controller.state()).toMatchObject({ pending: null, saved: true, draft: {} });
    f.setRead(() => stale.promise); const old = f.page.controller.refresh();
    f.ready.set(false); await flush(); f.setRead(async () => ({ nativeNotificationsEnabled: true })); f.ready.set(true); await flush();
    const before = f.page.controller.state(); stale.resolve({ nativeNotificationsEnabled: false }); await old;
    expect(f.page.controller.state()).toBe(before); expect(f.writes).toHaveLength(1);
  } finally { f.dispose(); }
});

it('search renders an existing event target disabled when notifications are off, without changing the Host or draft', async () => {
  const f = fixture('notifications.notifyOnError');
  try {
    await flush(); const tree = nodes(f.page.render()), each = tree.find(node => node.type === 'Each')!;
    expect(each).toBeDefined();
    const row = (each.children[0] as (field: () => object) => Node)(() => preferences.notificationEventFields.find(field => field.key === 'notifyOnError')!);
    expect(row.props.id).toBe('notifications.notifyOnError');
    const toggle = row.children[0] as Node; expect(toggle.props.disabled).toBe(true); expect(toggle.props.value).toBe(false);
    expect(f.page.controller.state().draft).toEqual({}); expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});

it.each(['status', 'permission'] as const)('permission UI releases busy on a gap and fences late %s before it can enable the Host preference', async phase => {
  const f = fixture(), old = deferred<unknown>();
  try {
    await flush(); let delayed = false; const nativeCalls: string[] = [];
    const denied = { authorization: 'notDetermined', alert: 'disabled', sound: 'disabled', badge: 'disabled', backgroundPush: false };
    const allowed = { ...denied, authorization: 'authorized', alert: 'enabled' };
    const p = f.permission(async name => { nativeCalls.push(name); return delayed && name === (phase === 'status' ? 'notification.status' : 'notification.request') ? old.promise : denied; });
    await flush(); delayed = true; const enabling = p.child.enable(true); await flush(); expect(p.child.busy()).toBe(true);
    f.active.set(false); await flush(); expect(p.child.busy()).toBe(false); expect(p.busy.at(-1)).toBe(false);
    f.active.set(true); delayed = false; await flush(); const before = nativeCalls.length;
    old.resolve(phase === 'status' ? denied : allowed); await enabling;
    expect(nativeCalls).toHaveLength(before); expect(p.edited).toEqual([]); expect(p.child.busy()).toBe(false);
    expect(f.writes).toEqual([]);
  } finally { f.dispose(); }
});
