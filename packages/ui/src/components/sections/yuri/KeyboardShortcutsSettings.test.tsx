import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient } from '@tanstack/react-query';
import { afterAll, afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { OpenCodeClient } from '@yuriai/opencode-gui-client';
import type { FilesAPI } from '@/lib/api/types';
import { GuiPluginHost } from '@/lib/gui-plugins/host';
import { GuiPluginHostContext } from '@/lib/gui-plugins/react';
import { guiCommandShortcutId } from '@/lib/gui-plugins/command-shortcuts';
import { useUIStore } from '@/stores/useUIStore';
import { UNASSIGNED_SHORTCUT } from '@/lib/shortcuts';
import { TooltipProvider } from '@/components/ui/tooltip';
import { KeyboardShortcutsSettings } from './KeyboardShortcutsSettings';

const mocks = vi.hoisted(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  return { mac: false, persist: vi.fn(async () => {}), t: (key: string) => key };
});
vi.mock('@/lib/utils', async (original) => ({ ...await original<typeof import('@/lib/utils')>(), isMacOS: () => mocks.mac }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: mocks.persist }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));

let root: Root;
let container: HTMLDivElement;
let host: GuiPluginHost;
beforeEach(async () => {
  mocks.persist.mockClear();
  mocks.mac = false;
  useUIStore.setState({ ...useUIStore.getInitialState(), shortcutOverrides: {} });
  host = new GuiPluginHost({
    client: {} as OpenCodeClient, files: {} as FilesAPI, storage: localStorage,
    queryClient: new QueryClient(), transport: 'settings', locale: 'en', mode: 'dark', narrow: false,
  });
  host.install('demo', { revision: '1', options: {}, code: `
    const G=require('@opencode/plugin/gui');
    module.exports.default=G.Plugin.define({setup(ctx){
      ctx.add(G.Command,{id:'board',title:'Board',bind:'mod+m',hidden:true,run(){}});
      ctx.add(G.Command,{id:'unbound',title:'Unbound',run(){}});
      ctx.add(G.Command,{id:'disabled',title:'Disabled',enabled:false,run(){}});
      ctx.add(G.Command,{id:'conflict',title:'Conflict',bind:'mod+m',run(){}});
    }});
  ` });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(<GuiPluginHostContext.Provider value={host}>
    <TooltipProvider><KeyboardShortcutsSettings /></TooltipProvider>
  </GuiPluginHostContext.Provider>));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.dispose(); localStorage.clear(); document.body.replaceChildren();
});
afterAll(() => vi.unstubAllGlobals());
function input(label: string) {
  return container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
}
function action(label: string, key: string) {
  const row = input(label).closest('.yuri-settings-group-row')!;
  return [...row.querySelectorAll('button')].find((button) => button.textContent === key)!;
}
async function click(button: HTMLButtonElement) {
  await act(async () => button.click());
}
async function capture(label: string, key: string) {
  await act(async () => {
    input(label).focus();
    input(label).dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await click(action(label, 'settings.common.actions.saveChanges'));
}
test('lists hidden and unbound commands without reintroducing disabled commands', () => {
  expect(input('Board')).not.toBeNull();
  expect(input('Unbound')).not.toBeNull();
  expect(input('Disabled')).toBeNull();
  expect(input('Board').hasAttribute('data-shortcut-capture')).toBe(true);
});
test('saves, unbinds and resets a plugin command through the existing persisted settings', async () => {
  const id = guiCommandShortcutId('demo', 'board');
  await capture('Board', 'k');
  expect(useUIStore.getState().shortcutOverrides[id]).toBe('mod+k');
  expect(mocks.persist).toHaveBeenLastCalledWith({ shortcutOverrides: { [id]: 'mod+k' } });
  await click(action('Board', 'settings.yuri.keyboardShortcuts.actions.unassign'));
  expect(useUIStore.getState().shortcutOverrides[id]).toBe(UNASSIGNED_SHORTCUT);
  await click(action('Board', 'settings.common.actions.reset'));
  expect(useUIStore.getState().shortcutOverrides[id]).toBeUndefined();
  expect(mocks.persist).toHaveBeenLastCalledWith({ shortcutOverrides: {} });
});
test('macOS recording preserves Control as distinct from Command', async () => {
  mocks.mac = true;
  await capture('Board', 'k');
  expect(useUIStore.getState().shortcutOverrides[guiCommandShortcutId('demo', 'board')]).toBe('ctrl+k');
});
test('overwrite clears all conflicts, including a built-in alias, while cancellation writes nothing', async () => {
  const id = guiCommandShortcutId('demo', 'unbound');
  await act(async () => useUIStore.getState().setShortcutOverride('open_settings', 'mod+m'));
  mocks.persist.mockClear();
  await capture('Unbound', 'm');
  expect(mocks.persist).not.toHaveBeenCalled();
  const cancel = [...container.querySelectorAll('button')].find((button) => button.textContent === 'settings.common.actions.cancel')!;
  await click(cancel);
  expect(useUIStore.getState().shortcutOverrides[id]).toBeUndefined();
  await capture('Unbound', 'm');
  const overwrite = [...container.querySelectorAll('button')].find((button) => button.textContent === 'settings.yuri.keyboardShortcuts.actions.overwrite')!;
  await click(overwrite);
  expect(useUIStore.getState().shortcutOverrides).toEqual({
    open_settings: UNASSIGNED_SHORTCUT,
    [guiCommandShortcutId('demo', 'board')]: UNASSIGNED_SHORTCUT,
    [guiCommandShortcutId('demo', 'conflict')]: UNASSIGNED_SHORTCUT,
    [id]: 'mod+m',
  });
  await capture('Unbound', '\\');
  await click([...container.querySelectorAll('button')].find((button) => button.textContent === 'settings.yuri.keyboardShortcuts.actions.overwrite')!);
  expect(useUIStore.getState().shortcutOverrides.toggle_right_sidebar).toBe(UNASSIGNED_SHORTCUT);
});
