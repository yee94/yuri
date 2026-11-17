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
  return {
    mac: false,
    persist: vi.fn(async () => {}),
    t: (key: string, params?: Record<string, string | number>) => params ? `${key} ${Object.values(params).join(',')}` : key,
  };
});
vi.mock('@/lib/utils', async (original) => ({ ...await original<typeof import('@/lib/utils')>(), isMacOS: () => mocks.mac }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: mocks.persist }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mocks.t }) }));

const K = 'settings.yuri.keyboardShortcuts.';
const SAVE = 'settings.common.actions.saveChanges';
const CANCEL = 'settings.common.actions.cancel';
const RESET = 'settings.common.actions.reset';

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

const LABEL = '.yuri-settings-split-row-copy > .typography-ui-label';

function row(label: string) {
  return [...container.querySelectorAll<HTMLElement>('.yuri-settings-group-row')]
    .find((element) => element.querySelector(LABEL)?.textContent === label) ?? null;
}
function labels() {
  return [...container.querySelectorAll(LABEL)].map((element) => element.textContent);
}
function button(scope: ParentNode, text: string) {
  return [...scope.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent === text || candidate.getAttribute('aria-label') === text) ?? null;
}
async function click(target: HTMLButtonElement | null) {
  await act(async () => target!.click());
}
async function press(target: Element, key: string, init: KeyboardEventInit = { ctrlKey: true }) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
  });
}
async function startEdit(label: string) {
  await click(button(row(label)!, `${K}edit.aria ${label}`));
  return row(label)!.querySelector<HTMLElement>('[data-shortcut-capture]')!;
}
async function capture(label: string, key: string, init?: KeyboardEventInit) {
  await press(await startEdit(label), key, init);
}
async function capturedSave(label: string, key: string) {
  await capture(label, key);
  const scope = row(label)!;
  await click(button(scope, SAVE) ?? button(scope, `${K}actions.overwrite`));
}
async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const searchInput = () => container.querySelector<HTMLInputElement>(`input[aria-label="${K}search.placeholder"]`)!;

test('lists hidden and unbound commands without reintroducing disabled commands', () => {
  expect(row('Board')).not.toBeNull();
  expect(row('Unbound')).not.toBeNull();
  expect(row('Disabled')).toBeNull();
});

test('shows every current binding without entering edit mode', () => {
  expect(row('Board')!.querySelectorAll('kbd').length).toBeGreaterThan(0);
  expect(row('Unbound')!.textContent).toContain(`${K}field.unassigned`);
  expect(row('Previous session')!.querySelectorAll('[data-slot="shortcut-kbd"]').length).toBe(2);
});

test('saves, unbinds and resets a plugin command through the existing persisted settings', async () => {
  const id = guiCommandShortcutId('demo', 'board');
  const field = await startEdit('Board');
  expect(field.hasAttribute('data-shortcut-capture')).toBe(true);
  expect(document.activeElement).toBe(field);
  await press(field, 'k');
  await click(button(row('Board')!, SAVE));
  expect(useUIStore.getState().shortcutOverrides[id]).toBe('mod+k');
  expect(mocks.persist).toHaveBeenLastCalledWith({ shortcutOverrides: { [id]: 'mod+k' } });
  await startEdit('Board');
  await click(button(row('Board')!, `${K}actions.unassign`));
  expect(useUIStore.getState().shortcutOverrides[id]).toBe(UNASSIGNED_SHORTCUT);
  await click(button(row('Board')!, RESET));
  expect(useUIStore.getState().shortcutOverrides[id]).toBeUndefined();
  expect(mocks.persist).toHaveBeenLastCalledWith({ shortcutOverrides: {} });
});

test('Enter confirms a recorded combo and Escape abandons it', async () => {
  const id = guiCommandShortcutId('demo', 'board');
  let field = await startEdit('Board');
  await press(field, 'k');
  await press(field, 'Escape', {});
  expect(row('Board')!.querySelector('[data-shortcut-capture]')).toBeNull();
  expect(useUIStore.getState().shortcutOverrides[id]).toBeUndefined();
  field = await startEdit('Board');
  await press(field, 'Enter', {});
  expect(useUIStore.getState().shortcutOverrides[id]).toBeUndefined();
  await press(field, 'k');
  await press(field, 'Enter', {});
  expect(useUIStore.getState().shortcutOverrides[id]).toBe('mod+k');
});

test('macOS recording preserves Control as distinct from Command', async () => {
  mocks.mac = true;
  await capturedSave('Board', 'k');
  expect(useUIStore.getState().shortcutOverrides[guiCommandShortcutId('demo', 'board')]).toBe('ctrl+k');
});

test('shows conflicting bindings on the row', () => {
  expect(row('Board')!.textContent).toContain(`${K}conflict.alsoUsedBy`);
  expect(row('Board')!.textContent).toContain('Conflict');
  expect(row('Conflict')!.textContent).toContain('Board');
  expect(row('Unbound')!.textContent).not.toContain(`${K}conflict.alsoUsedBy`);
});

test('identical defaults only conflict when their contexts can overlap', () => {
  expect(row('New terminal tab')!.textContent).not.toContain(`${K}conflict.alsoUsedBy`);
  expect(row('Previous terminal tab')!.textContent).not.toContain(`${K}conflict.alsoUsedBy`);
  expect(row('Previous terminal tab')!.textContent).toContain(`${K}context.terminal`);
  expect(row('Open right sidebar Files tab')!.textContent).not.toContain(`${K}conflict.alsoUsedBy`);
  expect(row('Toggle terminal')!.querySelectorAll('[data-slot="shortcut-kbd"]').length).toBe(2);
});

test('previews conflicts while recording and only overwrites after confirmation', async () => {
  const id = guiCommandShortcutId('demo', 'unbound');
  await act(async () => useUIStore.getState().setShortcutOverride('open_settings', 'mod+m'));
  mocks.persist.mockClear();
  await capture('Unbound', 'm');
  expect(row('Unbound')!.querySelector('[role="alert"]')).not.toBeNull();
  expect(button(row('Unbound')!, SAVE)).toBeNull();
  await click(button(row('Unbound')!, CANCEL));
  expect(mocks.persist).not.toHaveBeenCalled();
  expect(useUIStore.getState().shortcutOverrides[id]).toBeUndefined();
  await capturedSave('Unbound', 'm');
  expect(useUIStore.getState().shortcutOverrides).toEqual({
    open_settings: UNASSIGNED_SHORTCUT,
    [guiCommandShortcutId('demo', 'board')]: UNASSIGNED_SHORTCUT,
    [guiCommandShortcutId('demo', 'conflict')]: UNASSIGNED_SHORTCUT,
    [id]: 'mod+m',
  });
  await capturedSave('Unbound', '\\');
  expect(useUIStore.getState().shortcutOverrides.toggle_right_sidebar).toBe('mod+alt+b');
});

test('editing one of several bindings keeps the others', async () => {
  const bindings = () => row('Previous session')!.querySelectorAll('[data-slot="shortcut-kbd"]').length;
  expect(bindings()).toBe(2);
  const second = [...row('Previous session')!.querySelectorAll<HTMLButtonElement>(`button[aria-label="${K}edit.aria Previous session"]`)][1];
  await click(second);
  await press(row('Previous session')!.querySelector('[data-shortcut-capture]')!, 'k');
  await click(button(row('Previous session')!, SAVE));
  expect(useUIStore.getState().shortcutOverrides.previous_session).toBe('mod+shift+[ mod+k');
  expect(bindings()).toBe(2);
  const first = row('Previous session')!.querySelector<HTMLButtonElement>(`button[aria-label="${K}edit.aria Previous session"]`);
  await click(first);
  await click(button(row('Previous session')!, `${K}actions.unassign`));
  expect(useUIStore.getState().shortcutOverrides.previous_session).toBe('mod+k');
  await click(button(row('Previous session')!, RESET));
  expect(useUIStore.getState().shortcutOverrides.previous_session).toBeUndefined();
});

test('searches by command name, keyword and key combination', async () => {
  await type(searchInput(), 'unbound');
  expect(labels()).toEqual(['Unbound']);
  await type(searchInput(), 'ctrl');
  expect(labels()).toContain('Board');
  await type(searchInput(), 'ctrl+m');
  expect(labels()).toEqual(['Board', 'Conflict']);
  await type(searchInput(), 'no-such-command');
  expect(labels()).toEqual([]);
  expect(container.textContent).toContain(`${K}empty`);
});

test('record-keys search lists every command using the pressed combination', async () => {
  await click(button(container, `${K}search.recordKeys`));
  const field = container.querySelector<HTMLInputElement>('input[data-shortcut-capture]')!;
  expect(document.activeElement).toBe(field);
  await press(field, 'm');
  expect(labels()).toEqual(['Board', 'Conflict']);
  await press(field, ',');
  expect(labels()).toEqual(['Open settings']);
  await press(field, 'Escape', {});
  expect(container.querySelector('input[data-shortcut-capture]')).toBeNull();
  expect(labels().length).toBeGreaterThan(5);
});
