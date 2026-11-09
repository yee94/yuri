import { afterEach, expect, test, vi } from 'vitest';
import { createDesktopTerminalBinding, desktopTerminalCapability, desktopTerminalRenderer, type DesktopTerminalWorkspace } from './desktop-terminal-core';
import { createTerminalWorkspace } from './terminal-core';
import type { RuntimeScope } from './runtime-scope';

const scope = { hostID: 'synthetic-host', lease: 'synthetic-lease' };
const capability = (authority = scope) => ({ expectedHost: authority, component: desktopTerminalRenderer, version: 1,
  native: true, inline: true, vt: true, inputReceipts: true, outputAcknowledgements: true, hostAppearance: true, selection: true, ime: true, bracketedPaste: true });
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const owners: Array<ReturnType<typeof createDesktopTerminalBinding>> = [];
afterEach(() => { owners.splice(0).forEach(owner => owner.dispose()); vi.useRealTimers(); });

function fixture(input: { capability?: unknown; create?: () => Promise<DesktopTerminalWorkspace>; preview?: (directory: string, url: string, mode: 'preview' | 'external') => Promise<void> } = {}) {
  let current = true, sessions = 0, inputStatus: unknown = true, close = true;
  const calls: Array<{ name: string; body: Record<string, unknown> }> = [], commands: typeof calls = [];
  let receive: (value: unknown) => void = () => {};
  const call = vi.fn(async (name: string, body: Record<string, unknown>) => {
    calls.push({ name, body });
    if (name === 'terminal.desktop.capabilities') return 'capability' in input ? input.capability : capability();
    if (name === 'terminal.create') return { sessionId: `synthetic-${++sessions}` };
    if (name === 'terminal.close') return { closed: close };
    if (name === 'terminal.input') return inputStatus;
    return true;
  });
  const create = vi.fn(input.create ?? (async () => {
    const controller = createTerminalWorkspace({ scope, call, openPreview: input.preview, subscribe: listener => { receive = listener; return () => { receive = () => {}; }; }, changed: () => {} });
    return { controller, snapshot: controller.snapshot };
  }));
  const binding = createDesktopTerminalBinding({ scope, call, current: () => current, createWorkspace: create, command: (name, body) => commands.push({ name, body }), changed: () => {} });
  owners.push(binding);
  const update = (active = true, directory = '/workspace', authority: RuntimeScope = scope) => binding.update({ active, directory, scope: authority });
  const event = (value: Record<string, unknown>) => binding.event({ owner: binding.owner, generation: binding.state().generation, expectedHost: scope, ...value });
  const connected = () => {
    const attach = calls.filter(call => call.name === 'terminal.attach').at(-1)!;
    receive({ ...attach.body, type: 'connected' });
  };
  async function open() { update(); await settle(); await event({ type: 'ready', version: 1 }); await event({ type: 'resize', key: binding.workspace()!.snapshot().activeId, cols: 90, rows: 20 }); await settle(); connected(); }
  return { binding, calls, commands, create, update, event, open, connected, receive: (value: Record<string, unknown>) => receive(value), retire: () => { current = false; }, unknown: () => { inputStatus = undefined; }, inputResult: (value: unknown) => { inputStatus = value; }, failClose: () => { close = false; } };
}

test('transport-only, incomplete, stale or absent native capabilities never construct a workspace', async () => {
  for (const value of [undefined, true, { scope: 'native-opaque', wsVersion: 2, durableMetadata: true }, { ...capability(), inline: false }, capability({ ...scope, lease: 'retired' })]) {
    expect(desktopTerminalCapability(value, scope)).toBe(false);
    const f = fixture({ capability: value }); f.update(); await settle();
    expect(f.binding.state().phase).toBe('unavailable'); expect(f.create).not.toHaveBeenCalled();
    f.update(); await settle(); expect(f.calls).toHaveLength(1);
    f.binding.retry(); await settle(); expect(f.calls).toHaveLength(2);
    expect(f.calls.every(call => call.name === 'terminal.desktop.capabilities')).toBe(true);
  }
});

test('scoped link events route through the original controller; stale/hidden tabs and unsafe URLs never open', async () => {
  const preview = vi.fn(async () => {}), f = fixture({ preview }); await f.open();
  const workspace = f.binding.workspace()!, key = workspace.snapshot().activeId!;
  await f.event({ type: 'openPreview', key, url: 'http://localhost:3000/app', mode: 'preview' });
  expect(preview).toHaveBeenLastCalledWith('/workspace', 'http://localhost:3000/app', 'preview');
  await f.event({ type: 'openPreview', key, url: 'https://example.invalid/docs', mode: 'external' });
  expect(preview).toHaveBeenLastCalledWith('/workspace', 'https://example.invalid/docs', 'external');
  for (const url of ['javascript:alert(1)', 'file:///private/file', 'https://user:password@example.invalid/', 'https://example.invalid/?token=credential']) {
    await f.event({ type: 'openPreview', key, url, mode: 'external' });
  }
  await f.event({ type: 'openPreview', key, url: 'https://example.invalid/', mode: 'external', generation: 0 });
  workspace.controller.createTab();
  await f.event({ type: 'openPreview', key, url: 'https://example.invalid/', mode: 'external' });
  f.update(false, '');
  await f.event({ type: 'openPreview', key, url: 'https://example.invalid/', mode: 'external' });
  expect(preview).toHaveBeenCalledTimes(2);
  expect(f.commands.some(command => command.name === 'navigate')).toBe(false);
});

test('preview callback failure preserves the tab and exposes original controller preview_failed, without navigation fallback', async () => {
  const preview = vi.fn(async () => { throw new Error('synthetic browser unavailable'); });
  const f = fixture({ preview }); await f.open(); const key = f.binding.workspace()!.snapshot().activeId!;
  await f.event({ type: 'openPreview', key, url: 'http://localhost:3000/', mode: 'preview' });
  expect(f.binding.workspace()!.snapshot().tabs[0]).toMatchObject({ id: key, phase: 'live', error: 'preview_failed' });
  expect(f.binding.state().phase).toBe('ready'); expect(preview).toHaveBeenCalledTimes(1);
});

test('native ready and measured cells precede PTY creation; old-scope/owner/generation events do nothing', async () => {
  const f = fixture(); f.update(); await settle();
  expect(f.binding.state().phase).toBe('mounting'); expect(f.create).not.toHaveBeenCalled();
  await f.event({ type: 'ready', version: 1, generation: 0 });
  await f.event({ type: 'ready', version: 1, expectedHost: { ...scope, lease: 'old' } });
  await f.event({ type: 'ready', version: 1, owner: 'another-dock' });
  expect(f.create).not.toHaveBeenCalled();
  await f.event({ type: 'ready', version: 1 });
  expect(f.create).toHaveBeenCalledTimes(1); expect(f.calls.some(call => call.name === 'terminal.create')).toBe(false);
  await f.event({ type: 'resize', key: 'wrong-tab', cols: 90, rows: 20 });
  expect(f.calls.some(call => call.name === 'terminal.create')).toBe(false);
  const key = f.binding.workspace()!.snapshot().activeId;
  await f.event({ type: 'resize', key, cols: 90, rows: 20 }); await settle(); f.connected();
  expect(f.binding.workspace()!.snapshot().tabs[0].phase).toBe('live');
  expect(f.calls.filter(call => call.name === 'terminal.create')).toHaveLength(1);
  f.binding.focus(); expect(f.commands.at(-1)?.name).toBe('focus');
});

test('multiple tabs and directories reuse the original workspace; hide detaches without closing and close failure preserves prior', async () => {
  const f = fixture(); await f.open();
  const workspace = f.binding.workspace()!, first = workspace.snapshot().activeId!;
  const second = workspace.controller.createTab()!;
  await f.event({ type: 'resize', key: second, cols: 100, rows: 30 }); await settle(); f.connected();
  expect(workspace.snapshot().tabs).toHaveLength(2);
  workspace.controller.selectTab(first); await settle(); f.connected();
  expect(f.calls.filter(call => call.name === 'terminal.create')).toHaveLength(2);
  f.update(false); expect(f.calls.filter(call => call.name === 'terminal.close')).toHaveLength(0);
  const count = f.calls.length; f.binding.focus(); await f.event({ type: 'input', key: first, data: 'NOT_A_SHELL_COMMAND', receipt: 1 }); expect(f.calls).toHaveLength(count);
  f.update(true); await settle(); f.connected();
  f.update(true, '/other'); expect(workspace.snapshot().tabs).toHaveLength(1);
  f.update(true, '/workspace'); expect(workspace.snapshot().tabs.map(tab => tab.id)).toEqual([first, second]);
  f.failClose(); expect(await f.binding.closeTab(first)).toBe(false);
  expect(workspace.snapshot().tabs.map(tab => tab.id)).toEqual([first, second]);
  expect(workspace.snapshot().tabs[0].error).toBe('close_unconfirmed'); expect(f.create).toHaveBeenCalledTimes(1);
});

test('output is incrementally ACKed; renderer failure preserves workspace and retries do not create parallel PTYs', async () => {
  const f = fixture(); await f.open(); const workspace = f.binding.workspace()!;
  const attach = f.calls.filter(call => call.name === 'terminal.attach').at(-1)!;
  f.receive({ ...attach.body, type: 'data', id: 1, data: 'SYNTHETIC_OUTPUT' });
  f.binding.present(workspace.snapshot()); const render = f.commands.at(-1)!;
  expect(render.body.chunks).toEqual([{ id: 1, data: 'SYNTHETIC_OUTPUT' }]);
  for (let i = 0; i < 100; i++) f.binding.present(workspace.snapshot());
  expect(f.commands.filter(command => command.name === 'render')).toHaveLength(1);
  await f.event({ type: 'ack', key: workspace.snapshot().activeId, serial: render.body.serial, cursor: 1 });
  f.receive({ ...attach.body, type: 'data', id: 2, data: 'NEXT' }); f.binding.present(workspace.snapshot());
  expect(f.commands.at(-1)!.body.chunks).toEqual([{ id: 2, data: 'NEXT' }]);
  await f.event({ type: 'error' });
  expect(workspace.snapshot().tabs[0].chunks).toHaveLength(2);
  f.binding.retry(); await settle(); await f.event({ type: 'ready', version: 1 }); await settle();
  expect(f.binding.workspace()).toBe(workspace); expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.calls.filter(call => call.name === 'terminal.create')).toHaveLength(1);
});

test('duplicate input receipts do not resend; unknown input is not replayed by retry or tab switches', async () => {
  const f = fixture(); await f.open(); f.unknown();
  const key = f.binding.workspace()!.snapshot().activeId;
  await f.event({ type: 'input', key, receipt: 1, data: 'SYNTHETIC_INPUT' });
  await f.event({ type: 'input', key, receipt: 1, data: 'SYNTHETIC_INPUT' });
  f.binding.retry();
  expect(f.calls.filter(call => call.name === 'terminal.input')).toHaveLength(1);
  expect(f.commands.some(command => command.name === 'inputResult' && command.body.status === 'unknown')).toBe(true);
  expect(f.binding.state().error).toBe('input_unknown');
  expect(await f.binding.restart()).toBe(true);
  expect(f.binding.state().error).toBeUndefined();
  expect(f.commands.some(command => command.name === 'inputResult' && command.body.status === 'closed' && command.body.key === key)).toBe(true);
  expect(f.calls.filter(call => call.name === 'terminal.input')).toHaveLength(1);
});

test('scope retirement fences pending catalog recovery and releases only the captured owner', async () => {
  let resolve!: (workspace: DesktopTerminalWorkspace) => void;
  const pending = new Promise<DesktopTerminalWorkspace>(done => { resolve = done; });
  const f = fixture({ create: () => pending }); f.update(); await settle();
  const opening = f.event({ type: 'ready', version: 1 }); await settle();
  f.retire(); f.update();
  const dispose = vi.fn();
  const controller = createTerminalWorkspace({ scope, call: async () => true, subscribe: () => () => {}, changed: () => {} });
  const originalDispose = controller.dispose; controller.dispose = () => { dispose(); originalDispose(); };
  resolve({ controller, snapshot: controller.snapshot }); await opening;
  expect(dispose).toHaveBeenCalledTimes(1); expect(f.binding.workspace()).toBeUndefined();
  expect(f.binding.state().phase).toBe('retired');
  expect(f.calls.some(call => call.name === 'terminal.create')).toBe(false);
});

test('missing ready/ACK fails explicitly and does not automatically retry', async () => {
  vi.useFakeTimers(); const f = fixture(); f.update(); await settle();
  vi.advanceTimersByTime(10_001);
  expect(f.binding.state().error).toBe('native_renderer_ready_timeout');
  expect(f.create).not.toHaveBeenCalled();
  f.update(); await settle(); expect(f.calls).toHaveLength(1);
  const live = fixture(); await live.open(); const attach = live.calls.filter(call => call.name === 'terminal.attach').at(-1)!;
  live.receive({ ...attach.body, type: 'data', id: 1, data: 'ACK_REQUIRED' }); live.binding.present(live.binding.workspace()!.snapshot());
  vi.advanceTimersByTime(10_001);
  expect(live.binding.state().error).toBe('native_renderer_ack_timeout');
  expect(live.binding.workspace()!.snapshot().tabs[0].chunks[0].data).toBe('ACK_REQUIRED');
});

test('hidden mounting is cancelled and capability is rechecked; late ready cannot construct a workspace', async () => {
  const f = fixture(); f.update(); await settle(); const generation = f.binding.state().generation;
  f.update(false); await f.event({ type: 'ready', version: 1, generation });
  expect(f.create).not.toHaveBeenCalled(); expect(f.binding.canMount()).toBe(false);
  f.update(true); await settle();
  expect(f.binding.state().generation).toBeGreaterThan(generation);
  await f.event({ type: 'ready', version: 1, generation }); expect(f.create).not.toHaveBeenCalled();
  await f.event({ type: 'ready', version: 1 }); expect(f.create).toHaveBeenCalledTimes(1);
});

test('inactive routes with an empty directory retain the last valid directory/tabs and resume without an invalid-directory error', async () => {
  const f = fixture(); await f.open();
  const workspace = f.binding.workspace()!, before = workspace.snapshot().tabs.map(tab => tab.id);
  f.update(false, '');
  expect(f.binding.state().error).toBeUndefined();
  expect(workspace.snapshot().directory).toBe('/workspace'); expect(workspace.snapshot().tabs.map(tab => tab.id)).toEqual(before);
  f.update(true, '/workspace'); await settle();
  expect(f.binding.state().phase).toBe('ready'); expect(workspace.snapshot().tabs.map(tab => tab.id)).toEqual(before);
  expect(f.calls.filter(call => call.name === 'terminal.create')).toHaveLength(1);
  const unopened = fixture(); unopened.update(false, ''); await settle();
  expect(unopened.binding.state().phase).toBe('idle'); expect(unopened.calls).toHaveLength(0);
});

test('input already emitted before hide or tab switch is settled without dispatch and cannot occupy the native receipt lane', async () => {
  const f = fixture(); await f.open();
  const workspace = f.binding.workspace()!, key = workspace.snapshot().activeId!;
  f.update(false, '');
  await f.event({ type: 'input', key, data: 'HIDDEN_DRAFT', receipt: 1 });
  expect(f.commands.at(-1)).toMatchObject({ name: 'inputResult', body: { key, receipt: 1, status: 'suspended' } });
  expect(f.calls.filter(call => call.name === 'terminal.input')).toHaveLength(0);
  f.update(true, '/workspace'); await settle(); f.connected();
  await f.event({ type: 'input', key, data: 'EXPLICIT_NEW_INPUT', receipt: 2 });
  expect(f.calls.filter(call => call.name === 'terminal.input')).toHaveLength(1);
  workspace.controller.createTab();
  await f.event({ type: 'input', key, data: 'OLD_TAB_DRAFT', receipt: 3 });
  expect(f.commands.at(-1)).toMatchObject({ name: 'inputResult', body: { key, receipt: 3, status: 'suspended' } });
  expect(f.calls.filter(call => call.name === 'terminal.input')).toHaveLength(1);
});

test('stalled capability cannot mount any native component, even after its deadline', async () => {
  vi.useFakeTimers();
  let resolve!: (value: unknown) => void;
  const pending = new Promise<unknown>(done => { resolve = done; });
  const f = fixture({ capability: pending }); f.update(); await settle();
  vi.advanceTimersByTime(10_001);
  expect(f.binding.state().error).toBe('native_capability_timeout'); expect(f.binding.canMount()).toBe(false);
  resolve(capability()); await settle();
  expect(f.binding.canMount()).toBe(false); expect(f.create).not.toHaveBeenCalled();
});

test('renderer failure during metadata recovery preserves the late workspace for explicit retry without activating it', async () => {
  let resolve!: (value: DesktopTerminalWorkspace) => void;
  const pending = new Promise<DesktopTerminalWorkspace>(done => { resolve = done; });
  const f = fixture({ create: () => pending }); f.update(); await settle();
  const flight = f.event({ type: 'ready', version: 1 }); await settle();
  await f.event({ type: 'error' });
  const controller = createTerminalWorkspace({ scope, call: async () => true, subscribe: () => () => {}, changed: () => {} });
  resolve({ controller, snapshot: controller.snapshot }); await flight;
  expect(f.binding.state().phase).toBe('failed'); expect(controller.snapshot().directory).toBe('');
  f.binding.retry(); await settle(); await f.event({ type: 'ready', version: 1 });
  expect(f.create).toHaveBeenCalledTimes(1); expect(controller.snapshot().directory).toBe('/workspace');
});

test('in-flight input prevents renderer remount; a late unknown receipt cannot resurrect a failed renderer or replay input', async () => {
  let resolve!: (value: unknown) => void;
  const pending = new Promise<unknown>(done => { resolve = done; });
  const f = fixture(); await f.open(); f.inputResult(pending);
  const key = f.binding.workspace()!.snapshot().activeId;
  const flight = f.event({ type: 'input', key, receipt: 1, data: 'SYNTHETIC_PENDING' }); await settle();
  expect(f.binding.state().inputPending).toBe(true);
  await f.event({ type: 'error' });
  const checks = f.calls.filter(call => call.name === 'terminal.desktop.capabilities').length;
  f.binding.retry(); await settle();
  expect(f.calls.filter(call => call.name === 'terminal.desktop.capabilities')).toHaveLength(checks);
  resolve(undefined); await flight;
  expect(f.binding.state().phase).toBe('failed'); expect(f.binding.state().inputPending).toBeUndefined();
  f.binding.retry(); await settle();
  expect(f.calls.filter(call => call.name === 'terminal.desktop.capabilities')).toHaveLength(checks);
  expect(await f.binding.closeTab(key!)).toBe(true);
  f.binding.retry(); await settle();
  expect(f.calls.filter(call => call.name === 'terminal.desktop.capabilities')).toHaveLength(checks + 1);
  expect(f.calls.filter(call => call.name === 'terminal.input')).toHaveLength(1);
});

test('late ACK from an old tab or renderer cannot settle the current flight or trigger input replay', async () => {
  vi.useFakeTimers();
  const f = fixture(); await f.open(); const workspace = f.binding.workspace()!;
  const first = workspace.snapshot().activeId!;
  let attach = f.calls.filter(call => call.name === 'terminal.attach').at(-1)!;
  f.receive({ ...attach.body, type: 'data', id: 1, data: 'FIRST' }); f.binding.present(workspace.snapshot());
  const old = f.commands.at(-1)!.body;
  const second = workspace.controller.createTab()!;
  await f.event({ type: 'resize', key: second, cols: 90, rows: 20 }); await settle(); f.connected();
  attach = f.calls.filter(call => call.name === 'terminal.attach').at(-1)!;
  f.receive({ ...attach.body, type: 'data', id: 1, data: 'SECOND' }); f.binding.present(workspace.snapshot());
  const pending = f.commands.at(-1)!.body;
  await f.event({ type: 'ack', key: first, serial: old.serial, cursor: 1 });
  vi.advanceTimersByTime(10_001); expect(f.binding.state().error).toBe('native_renderer_ack_timeout');
  const previousGeneration = f.binding.state().generation;
  f.binding.retry(); await settle(); await f.event({ type: 'ready', version: 1 }); await settle();
  f.connected(); f.binding.present(workspace.snapshot());
  await f.event({ type: 'ack', key: second, serial: pending.serial, cursor: 1, generation: previousGeneration });
  expect(f.calls.filter(call => call.name === 'terminal.input')).toHaveLength(0);
  vi.advanceTimersByTime(10_001); expect(f.binding.state().error).toBe('native_renderer_ack_timeout');
});

test('native focus/composition telemetry is scoped, and hide/failure clears interaction admission', async () => {
  const f = fixture(); await f.open();
  await f.event({ type: 'focus', focused: true }); await f.event({ type: 'composition', composing: true });
  expect(f.binding.state()).toMatchObject({ focused: true, composing: true });
  await f.event({ type: 'focus', focused: false, owner: 'stale-owner' });
  expect(f.binding.state().focused).toBe(true);
  f.update(false, ''); expect(f.binding.state().focused).toBeUndefined(); expect(f.binding.state().composing).toBeUndefined();
  await f.event({ type: 'focus', focused: true }); expect(f.binding.state().focused).toBeUndefined();
});
