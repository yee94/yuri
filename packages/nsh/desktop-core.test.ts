import { describe, expect, it, vi } from 'vitest';
import type { MenuItem } from 'nsh/desktop';
import { dict as en } from '../ui/src/lib/i18n/messages/en';
import { dict as zh } from '../ui/src/lib/i18n/messages/zh-CN';
import { createNativeDesktopMenuOwner, nativeDesktopMenuItems, nativeDesktopMenuKeystrokes, nativeDesktopTitleBarLayout, type NativeDesktopMenuGroup } from './desktop-core';
import { nativeShortcutBindings, nativeShortcutKeystroke } from './desktop-shortcuts-core';
import { UNASSIGNED_SHORTCUT } from '../ui/src/lib/shortcuts-core';

const flat = (items: MenuItem[]): Exclude<MenuItem, { type: 'separator' }>[] => items.flatMap(item => 'type' in item ? [] : [item, ...flat((item.submenu ?? []).filter((child): child is MenuItem => !!child))]);
const menus = (os = 'macos') => nativeDesktopMenuItems(os, { newSession: { run() {} }, search: { run() {} }, switchSession: { run() {} }, settings: { run() {} } }, key => en[key]);

describe('native desktop menu contract', () => {
  it('reserves only actual native control insets, including fullscreen/browser zero areas', () => {
    expect(nativeDesktopTitleBarLayout({ height: 38, left: 78, right: 0 })).toEqual({ height: 38, paddingLeft: 86, paddingRight: 8 });
    expect(nativeDesktopTitleBarLayout({ height: 40, left: 0, right: 138 })).toEqual({ height: 40, paddingLeft: 8, paddingRight: 146 });
    expect(nativeDesktopTitleBarLayout({ height: 0, left: 0, right: 0 })).toEqual({ height: 40, paddingLeft: 8, paddingRight: 8 });
    expect(nativeDesktopTitleBarLayout({ height: 0, left: 0, right: 0 }, 44).height).toBe(44);
  });
  it.each(['macos', 'windows'])('uses the shared registry physical keys and lets %s resolve native edit shortcuts', os => {
    const items = flat(menus(os));
    expect(items.filter(item => item.onSelect).map(item => item.shortcut)).toEqual([...['mod+comma', 'mod+n', 'mod+p'].map(combo => nativeShortcutKeystroke(combo, os === 'macos')), undefined]);
    const edit = items.filter(item => item.role && ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll'].includes(item.role));
    expect(edit.map(item => item.role)).toEqual(['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']);
    for (const item of edit) expect(item).toEqual({ role: item.role });
    expect(items.some(item => item.shortcut?.includes('cmd'))).toBe(os === 'macos');
    expect(items.filter(item => item.role).map(item => item.role)).toEqual(expect.arrayContaining(['minimize', 'zoom', 'toggleFullScreen', 'close', 'quit']));
    expect(items.some(item => item.role === 'about')).toBe(os === 'macos');
    expect(items.some(item => item.role === 'hide')).toBe(os === 'macos');
    expect(items.some(item => item.role === 'showAll')).toBe(os === 'macos');
  });
  it('reuses locale labels without translating native roles or inventing missing headings', () => {
    const items = nativeDesktopMenuItems('windows', { search: { run() {} } }, key => zh[key]);
    expect(items.map(item => item.label)).toEqual(['Yuri', zh['header.sessions.title'], zh['mobile.instances.edit']]);
    expect(flat(items).find(item => item.shortcut === 'ctrl+p')?.label).toBe(zh['mobile.sessions.searchAria']);
    expect(items.every(item => item.label.length > 0)).toBe(true);
  });
  it('omits unwired flows and disables both menu and JS invocation', () => {
    const run = vi.fn();
    const items = nativeDesktopMenuItems('windows', { newSession: { run, disabled: true } }, key => en[key]);
    const action = flat(items).find(item => item.label === en['mobile.menu.newSession'])!;
    expect(action.disabled).toBe(true); action.onSelect!(); expect(run).not.toHaveBeenCalled();
    expect(action.shortcut).toBeUndefined();
    expect(flat(items).filter(item => item.onSelect)).toHaveLength(1);
    expect(nativeDesktopMenuItems('windows', {}, key => en[key])).toHaveLength(2);
  });
  it.each(['macos', 'windows'])('gives desktop workspace keys a single owner on %s, never closes the window with closeTab', os => {
    const sidebar = vi.fn(), panel = vi.fn(), terminal = vi.fn(), close = vi.fn(), switchSession = vi.fn();
    const items = flat(nativeDesktopMenuItems(os, {
      toggleSidebar: { run: sidebar }, togglePanel: { run: panel }, toggleTerminal: { run: terminal },
      closeTab: { run: close }, switchSession: { run: switchSession },
    }, key => en[key]));
    for (const [shortcut, run] of [['mod+b', sidebar], ['mod+alt+b', panel], ['ctrl+`', terminal], ['mod+w', close]] as const) {
      const matches = items.filter(item => item.shortcut === nativeShortcutKeystroke(shortcut, os === 'macos'));
      expect(matches).toHaveLength(1); matches[0].onSelect!(); expect(run).toHaveBeenCalledTimes(1);
    }
    expect(items.some(item => item.role === 'close')).toBe(false);
    const switcher = items.find(item => item.label === en['helpDialog.item.switchSession'])!;
    expect(switcher.shortcut).toBeUndefined(); switcher.onSelect!(); expect(switchSession).toHaveBeenCalledTimes(1);
  });
  it('does not fall back to native window close when closeTab is disabled', () => {
    const run = vi.fn();
    const items = flat(nativeDesktopMenuItems('windows', { closeTab: { run, disabled: true } }, key => en[key]));
    expect(items.some(item => item.role === 'close')).toBe(false);
    const close = items.find(item => item.label === en['helpDialog.item.closeContextPanelTab'])!;
    expect(close.disabled).toBe(true); close.onSelect!(); expect(run).not.toHaveBeenCalled();
    expect(close.shortcut).toBeUndefined();
  });
  it.each(['macos', 'windows'])('overrides, explicit empty/unassigned and readiness never reactivate default accelerators on %s', os => {
    const run = vi.fn(), actions = { newSession: { run }, search: { run }, settings: { run }, toggleTerminal: { run }, closeTab: { run } };
    const items = nativeDesktopMenuItems(os, actions, key => en[key], { userOverrides: {
      new_chat: 'alt+f8', open_command_palette: UNASSIGNED_SHORTCUT, open_settings: 'mod+shift+comma', toggle_terminal: 'ctrl+shift+backtick', close_context_panel_tab: UNASSIGNED_SHORTCUT,
    } });
    expect(nativeDesktopMenuKeystrokes(items)).toEqual(['mod+shift+comma', 'ctrl+shift+backtick', 'alt+f8'].map(combo => nativeShortcutKeystroke(combo, os === 'macos')));
    expect(flat(items).some(item => item.role === 'close')).toBe(false);
    expect(flat(items).filter(item => item.onSelect && !item.shortcut).map(item => item.label)).toEqual(expect.arrayContaining([en['mobile.sessions.searchAria'], en['helpDialog.item.closeContextPanelTab']]));
    for (const shortcut of [null, '', UNASSIGNED_SHORTCUT]) {
      const explicit = flat(nativeDesktopMenuItems(os, { search: { run, shortcut } }, key => en[key]));
      expect(explicit.find(item => item.onSelect)?.shortcut).toBeUndefined();
    }
    const pending = flat(nativeDesktopMenuItems(os, actions, key => en[key], { ready: false }));
    expect(pending.filter(item => item.onSelect).every(item => item.disabled && item.shortcut === undefined)).toBe(true);
    pending.find(item => item.onSelect)!.onSelect!(); expect(run).not.toHaveBeenCalled();
  });
  it.each(['macos', 'windows'])('native menu owns exactly its current stroke; keymap retains aliases and restored keys on %s', os => {
    const apple = os === 'macos', actions = { open_command_palette: { run() {} }, toggle_right_sidebar: { run() {} } };
    const menuActions = { search: { run() {} }, togglePanel: { run() {} } };
    const defaults = nativeDesktopMenuItems(os, menuActions, key => en[key]);
    const plan = nativeShortcutBindings({ actions, apple, settingsOpen: false, menuOwnedKeystrokes: nativeDesktopMenuKeystrokes(defaults) });
    expect(plan.map(value => value.keystroke)).toEqual([nativeShortcutKeystroke('mod+\\', apple)]);
    const overrides = { open_command_palette: 'alt+f8' };
    const changed = nativeDesktopMenuItems(os, menuActions, key => en[key], { userOverrides: overrides });
    expect(nativeDesktopMenuKeystrokes(changed)).toContain('alt+f8');
    expect(nativeDesktopMenuKeystrokes(changed)).not.toContain(nativeShortcutKeystroke('mod+p', apple));
    expect(nativeShortcutBindings({ actions, apple, overrides, settingsOpen: false, menuOwnedKeystrokes: nativeDesktopMenuKeystrokes(changed) }).map(value => value.keystroke)).toEqual([nativeShortcutKeystroke('mod+\\', apple)]);
    expect(nativeShortcutBindings({ actions, apple, overrides, settingsOpen: false, menuOwnedKeystrokes: [] }).some(value => value.keystroke === 'alt+f8')).toBe(true);
  });
  it.each(['macos', 'windows'])('text-editing remaps never become native menu accelerators on %s', os => {
    for (const combo of ['mod+c', 'ctrl+x', 'mod+arrowup', 'enter', 'a']) {
      const overrides = { open_command_palette: combo }, actions = { open_command_palette: { run() {} } };
      const menu = nativeDesktopMenuItems(os, { search: { run() {} } }, key => en[key], { userOverrides: overrides });
      expect(nativeDesktopMenuKeystrokes(menu)).toEqual([]);
      expect(flat(menu).find(item => item.onSelect)?.when).toBe('auto');
      const plan = nativeShortcutBindings({ actions, overrides, apple: os === 'macos', settingsOpen: false, menuOwnedKeystrokes: nativeDesktopMenuKeystrokes(menu) });
      expect(plan.map(value => value.keystroke)).toEqual([nativeShortcutKeystroke(combo, os === 'macos')]);
      expect(plan[0].when).toBeUndefined();
    }
  });
});

describe('native menu owner (injected API, not a platform test)', () => {
  const setup = (available = true) => {
    const setApplicationMenu = vi.fn<(items: NativeDesktopMenuGroup[] | null) => void>();
    const popup = vi.fn(async (_items: MenuItem[]) => {});
    return { setApplicationMenu, popup, owner: createNativeDesktopMenuOwner({ available, setApplicationMenu, popup }) };
  };
  it('desktop idiom alone never permits native API calls', async () => {
    const test = setup(false);
    test.owner.update(menus()); await test.owner.popup(0); await test.owner.popupApplication(); test.owner.dispose();
    expect(test.setApplicationMenu).not.toHaveBeenCalled(); expect(test.popup).not.toHaveBeenCalled();
  });
  it('replaces menus, fences stale callbacks and restores default exactly once on disposal', async () => {
    const test = setup(), first = vi.fn(), second = vi.fn();
    test.owner.update(nativeDesktopMenuItems('windows', { search: { run: first } }, key => en[key]));
    const previous = flat(test.setApplicationMenu.mock.calls[0][0]!).find(item => item.shortcut === 'ctrl+p')!;
    previous.onSelect!(); expect(first).toHaveBeenCalledTimes(1);
    test.owner.update(nativeDesktopMenuItems('windows', { search: { run: second } }, key => en[key]));
    const current = flat(test.setApplicationMenu.mock.calls[1][0]!).find(item => item.shortcut === 'ctrl+p')!;
    previous.onSelect!(); current.onSelect!();
    expect(first).toHaveBeenCalledTimes(1); expect(second).toHaveBeenCalledTimes(1);
    await test.owner.popup(1); expect(test.popup).toHaveBeenCalledWith(test.setApplicationMenu.mock.calls[1][0]![1].submenu);
    test.owner.dispose(); test.owner.dispose(); current.onSelect!();
    test.owner.update(menus()); await test.owner.popup(1);
    expect(second).toHaveBeenCalledTimes(1);
    expect(test.setApplicationMenu.mock.calls.map(([items]) => items === null)).toEqual([false, false, true]);
    expect(test.popup).toHaveBeenCalledTimes(1);
  });
  it('keeps prior callback authority if an update fails and surfaces popup failure', async () => {
    const test = setup(), run = vi.fn();
    test.owner.update(nativeDesktopMenuItems('windows', { search: { run } }, key => en[key]));
    const previous = flat(test.setApplicationMenu.mock.calls[0][0]!).find(item => item.shortcut === 'ctrl+p')!;
    test.setApplicationMenu.mockImplementationOnce(() => { throw new Error('native install failure'); });
    expect(() => test.owner.update(menus())).toThrow('native install failure');
    previous.onSelect!(); expect(run).toHaveBeenCalledTimes(1);
    test.popup.mockRejectedValueOnce(new Error('native popup failure'));
    await expect(test.owner.popup(0)).rejects.toThrow('native popup failure');
    test.owner.dispose(); expect(test.setApplicationMenu).toHaveBeenLastCalledWith(null);
  });
  it('does not clear another menu if never installed and ignores invalid popup indices', async () => {
    const test = setup(); await test.owner.popup(0); test.owner.dispose(); expect(test.setApplicationMenu).not.toHaveBeenCalled();
    const active = setup(); active.owner.update(menus()); await active.owner.popup(-1); await active.owner.popup(100); expect(active.popup).not.toHaveBeenCalled();
    active.owner.dispose();
  });
  it('opens a single native App popup with the installed submenu groups and fences its retired callbacks', async () => {
    const test = setup(), run = vi.fn();
    await test.owner.popupApplication(); expect(test.popup).not.toHaveBeenCalled();
    test.owner.update(nativeDesktopMenuItems('windows', { search: { run } }, key => en[key]));
    await test.owner.popupApplication();
    const groups = test.popup.mock.calls[0][0];
    expect(groups.map(item => 'label' in item ? item.label : '')).toEqual(['Yuri', 'Sessions', 'Edit']);
    expect(groups.every(item => 'submenu' in item && item.submenu?.length)).toBe(true);
    const search = flat(groups).find(item => item.shortcut === 'ctrl+p')!;
    search.onSelect!(); expect(run).toHaveBeenCalledTimes(1);
    test.owner.dispose(); search.onSelect!(); await test.owner.popupApplication();
    expect(run).toHaveBeenCalledTimes(1); expect(test.popup).toHaveBeenCalledTimes(1);
  });
});
