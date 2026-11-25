import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import { GuiPluginHost } from '@/lib/gui-plugins/host';
import { GuiPluginHostContext } from '@/lib/gui-plugins/react';
import { guiCommandShortcutId } from '@/lib/gui-plugins/command-shortcuts';
import type { FilesAPI } from '@/lib/api/types';
import { queryClient } from '@/lib/queryRuntime';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { UNASSIGNED_SHORTCUT } from '@/lib/shortcuts';
import * as shortcutBindings from '@/lib/shortcut-bindings';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';

const mocks = vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { headers: { 'Content-Type': 'application/json' } })));
  return { mac: false, native: { claim: vi.fn(async () => {}), fallback: vi.fn(async () => true) },
    ipc: vi.fn(), theme: { themeMode: 'dark', setThemeMode: vi.fn() }, status: { working: { canAbort: false } },
    t: (key: string) => key };
});
vi.mock('@/lib/utils', async (original) => ({ ...await original<typeof import('@/lib/utils')>(), isMacOS: () => mocks.mac }));
vi.mock('@/lib/desktop', async (original) => ({
  ...await original<typeof import('@/lib/desktop')>(), isDesktopShell: () => true, canUseElectronDesktopIPC: () => true, invokeDesktop: mocks.ipc,
  getDesktopMenuShortcutsBridge: () => mocks.native,
}));
vi.mock('@/lib/i18n', async (original) => ({ ...await original<typeof import('@/lib/i18n')>(), useI18n: () => ({ t: mocks.t }) }));
vi.mock('@/contexts/useThemeSystem', () => ({ useThemeSystem: () => mocks.theme }));
vi.mock('@/hooks/useAssistantStatus', () => ({ useAssistantStatus: () => mocks.status }));

let root: Root;
let container: HTMLDivElement;
let host: GuiPluginHost;
let textarea: HTMLTextAreaElement;
const calls = { count: 0 };
let revisionSequence = 0;
function Harness({ owner, tick = 0 }: { owner: GuiPluginHost | null; tick?: number }) {
  return <QueryClientProvider client={queryClient}>
    <GuiPluginHostContext.Provider value={owner}><Keys /><span>{tick}</span></GuiPluginHostContext.Provider>
  </QueryClientProvider>;
}
function Keys() {
  useKeyboardShortcuts();
  return <><textarea data-chat-input="true" /><div className="board" tabIndex={0} /><input data-shortcut-capture /></>;
}
function createHost() {
  return new GuiPluginHost({
    client: {} as OpenCodeClient, files: {} as FilesAPI, storage: localStorage, transport: 'test',
    queryClient: new QueryClient(), locale: 'en', mode: 'dark', narrow: false,
  });
}
function install(fields = '', run = 'globalThis.__shortcutCalls.count++;', revision = String(++revisionSequence)) {
  host.install('demo', { revision, options: {}, code: `
    const G = require('@opencode/plugin/gui');
    module.exports.default = G.Plugin.define({setup(ctx) {
      ctx.add(G.Command, {id:'board',title:'Board',bind:'mod+m',${fields} run(){${run}}});
    }});
  ` });
}
async function press(init: KeyboardEventInit, target: Element = textarea) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}
beforeEach(async () => {
  mocks.mac = false; calls.count = 0;
  mocks.native.claim.mockClear(); mocks.native.fallback.mockClear();
  Reflect.set(globalThis, '__shortcutCalls', calls);
  useUIStore.setState({ ...useUIStore.getInitialState(), activeMainTab: 'chat', shortcutOverrides: {} });
  useSessionUIStore.setState({ ...useSessionUIStore.getInitialState(), currentSessionId: null });
  container = document.createElement('div'); document.body.append(container);
  root = createRoot(container); host = createHost(); install();
  await act(async () => root.render(<Harness owner={host} />));
  textarea = container.querySelector('textarea')!; textarea.focus();
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.dispose(); localStorage.clear(); document.body.replaceChildren();
  Reflect.deleteProperty(globalThis, '__shortcutCalls'); vi.restoreAllMocks();
});
afterAll(() => vi.unstubAllGlobals());

test.each([false, true])('mod uses Ctrl elsewhere and only Command on macOS desktop (%s)', async (mac) => {
  mocks.mac = mac;
  await act(async () => install());
  expect((await press({ key: 'm', ctrlKey: !mac, metaKey: mac })).defaultPrevented).toBe(true);
  expect(calls.count).toBe(1);
  if (mac) {
    expect((await press({ key: 'm', ctrlKey: true })).defaultPrevented).toBe(false);
    expect(calls.count).toBe(1);
  }
});
test('hidden commands work; user remapping and unbinding take effect immediately', async () => {
  await act(async () => install('hidden:true,'));
  expect(host.getSnapshot().commands).toHaveLength(0);
  await press({ key: 'm', ctrlKey: true });
  const id = guiCommandShortcutId('demo', 'board');
  await act(async () => useUIStore.getState().setShortcutOverride(id, 'mod+k'));
  expect((await press({ key: 'm', ctrlKey: true })).defaultPrevented).toBe(false);
  await press({ key: 'k', ctrlKey: true });
  await act(async () => useUIStore.getState().setShortcutOverride(id, UNASSIGNED_SHORTCUT));
  expect((await press({ key: 'k', ctrlKey: true })).defaultPrevented).toBe(false);
  expect(calls.count).toBe(2);
});
test('developer priority overrides built-in defaults, but never explicit user choices', async () => {
  await act(async () => install("bind:'mod+p',priority:0,"));
  await press({ key: 'p', ctrlKey: true });
  expect(calls.count).toBe(0); expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
  await act(async () => { useUIStore.setState({ isCommandPaletteOpen: false }); install("bind:'mod+p',priority:100,"); });
  await press({ key: 'p', ctrlKey: true });
  expect(calls.count).toBe(1); expect(useUIStore.getState().isCommandPaletteOpen).toBe(false);
  await act(async () => useUIStore.getState().setShortcutOverride('open_command_palette', 'mod+p'));
  await press({ key: 'p', ctrlKey: true });
  expect(calls.count).toBe(1); expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
});
test('scope and editable preserve focused text input unless explicitly opted in', async () => {
  await act(async () => install("bind:'m',scope:'.board',"));
  expect((await press({ key: 'm' })).defaultPrevented).toBe(false);
  expect((await press({ key: 'm' }, container.querySelector('.board')!)).defaultPrevented).toBe(true);
  await act(async () => install("bind:'m',"));
  expect((await press({ key: 'm' })).defaultPrevented).toBe(false);
  await act(async () => install("bind:'m',editable:true,"));
  expect((await press({ key: 'm' })).defaultPrevented).toBe(true);
  expect(calls.count).toBe(2);
});
test('IME, local handlers, terminal ownership and shortcut recording keep their keys', async () => {
  expect((await press({ key: 'm', ctrlKey: true, isComposing: true })).defaultPrevented).toBe(false);
  expect((await press({ key: 'm', ctrlKey: true, keyCode: 229 })).defaultPrevented).toBe(false);
  textarea.addEventListener('keydown', (event) => event.preventDefault(), { once: true });
  await press({ key: 'm', ctrlKey: true });
  textarea.setAttribute('data-terminal-hidden-input', 'true');
  await press({ key: 'm', ctrlKey: true });
  await press({ key: 'm', ctrlKey: true }, container.querySelector('input')!);
  expect(calls.count).toBe(0);
});
test('a synchronous false leaves the event available and repeated keydown never repeats the command', async () => {
  await act(async () => install('', 'return false;'));
  expect((await press({ key: 'm', ctrlKey: true })).defaultPrevented).toBe(false);
  await act(async () => install());
  await press({ key: 'm', ctrlKey: true });
  expect((await press({ key: 'm', ctrlKey: true, repeat: true })).defaultPrevented).toBe(true);
  expect(calls.count).toBe(1);
});
test('disabled, replaced, uninstalled and old runtime commands never respond', async () => {
  await act(async () => install('enabled:false,'));
  expect((await press({ key: 'm', ctrlKey: true })).defaultPrevented).toBe(false);
  await act(async () => install("bind:'mod+k',", undefined, '2'));
  await press({ key: 'm', ctrlKey: true });
  await press({ key: 'k', ctrlKey: true });
  expect(calls.count).toBe(1);
  await act(async () => host.uninstall('demo'));
  expect((await press({ key: 'k', ctrlKey: true })).defaultPrevented).toBe(false);
  await act(async () => { install(); root.render(<Harness owner={null} />); });
  expect((await press({ key: 'm', ctrlKey: true })).defaultPrevented).toBe(false);
});
test('50 unrelated host and parent updates do not recompile the command catalog', async () => {
  const compile = vi.spyOn(shortcutBindings, 'compileShortcutBindings');
  mocks.native.claim.mockClear();
  for (let index = 0; index < 50; index += 1) {
    await act(async () => {
      host.setSession({ id: `session-${index}`, directory: '/workspace' });
      root.render(<Harness owner={host} tick={index} />);
    });
    await press({ key: 'a' });
  }
  expect(compile).not.toHaveBeenCalled();
  expect(mocks.native.claim).not.toHaveBeenCalled();
  await press({ key: 'm', ctrlKey: true });
  expect(calls.count).toBe(1);
});
test.each([false, true])('no plugin commands means no compilation, focus listeners or native IPC (%s)', async (noHost) => {
  await act(async () => {
    host.uninstall('demo');
    root.render(<Harness owner={noHost ? null : host} />);
  });
  const compile = vi.spyOn(shortcutBindings, 'compileShortcutBindings');
  const listen = vi.spyOn(window, 'addEventListener');
  mocks.native.claim.mockClear();
  for (let index = 0; index < 50; index++) {
    await act(async () => {
      useUIStore.getState().setShortcutOverride('open_command_palette', index % 2 ? 'mod+p' : 'mod+k');
      root.render(<Harness owner={noHost ? null : host} tick={index} />);
    });
    await press({ key: 'a' });
  }
  expect(compile).not.toHaveBeenCalled();
  expect(listen.mock.calls.filter(([event]) => ['focusin', 'focusout'].includes(String(event)))).toHaveLength(0);
  expect(mocks.native.claim).not.toHaveBeenCalled();
});
test('native menu claims follow winners and focused scope; disabled/unbound commands release them', async () => {
  expect(mocks.native.claim).toHaveBeenLastCalledWith(['mod+m']);
  await act(async () => install("bind:'mod+p',priority:0,"));
  expect(mocks.native.claim).toHaveBeenLastCalledWith([]);
  await act(async () => install("bind:'mod+p',priority:100,scope:'.board',"));
  expect(mocks.native.claim).toHaveBeenLastCalledWith([]);
  await act(async () => (container.querySelector('.board') as HTMLElement).focus());
  expect(mocks.native.claim).toHaveBeenLastCalledWith(['mod+p']);
  await act(async () => textarea.focus());
  expect(mocks.native.claim).toHaveBeenLastCalledWith([]);
  await act(async () => install());
  expect(mocks.native.claim).toHaveBeenLastCalledWith(['mod+m']);
  await act(async () => useUIStore.getState().setShortcutOverride(guiCommandShortcutId('demo', 'board'), UNASSIGNED_SHORTCUT));
  expect(mocks.native.claim).toHaveBeenLastCalledWith([]);
});
test('declined native shortcuts fall back only after the rest of DOM dispatch also declines', async () => {
  await act(async () => install('', 'return false;'));
  await press({ key: 'm', ctrlKey: true });
  expect(mocks.native.fallback).toHaveBeenCalledWith('mod+m');
  mocks.native.fallback.mockClear();
  await act(async () => install("bind:'mod+p',priority:100,", 'return false;'));
  await press({ key: 'p', ctrlKey: true });
  expect(useUIStore.getState().isCommandPaletteOpen).toBe(true);
  expect(mocks.native.fallback).not.toHaveBeenCalled();
});
test('a failed native claim releases stale menu ownership without disabling the command', async () => {
  mocks.native.claim.mockRejectedValueOnce(new Error('native claim failed'));
  await act(async () => install("bind:'mod+k',"));
  expect(mocks.native.claim).toHaveBeenLastCalledWith([]);
  await press({ key: 'k', ctrlKey: true });
  expect(calls.count).toBe(1);
});
