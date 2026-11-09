import { expect, test, vi } from 'vitest';
import { createNativeDesktopTerminalShortcutOwner } from './desktop-terminal-actions';
import { nativeShortcutBindings } from './desktop-shortcuts-core';

test('terminal descriptors use only root bindings, honor remaps, focus/IME/modal admission and stale retirement', () => {
  let active = true, focused = true, composing = false;
  const create = vi.fn(), expand = vi.fn(), focus = vi.fn(), cycle = vi.fn();
  const { owner, retire } = createNativeDesktopTerminalShortcutOwner({ current: () => active, ready: () => true, focused: () => focused, composing: () => composing, create, expand, focus, cycle });
  const bindings = () => nativeShortcutBindings({ actions: owner.actions, overrides: { toggle_terminal_expanded: 'mod+alt+e' }, apple: false, settingsOpen: false });
  expect(bindings().find(b => b.actionId === 'toggle_terminal_expanded')?.keystroke).toBe('ctrl+alt+e');
  expect(bindings().some(b => b.keystroke === 'ctrl+shift+j')).toBe(false);
  owner.actions.toggle_terminal_expanded!.run(); expect(expand).toHaveBeenCalledTimes(1);
  owner.actions.new_terminal_tab!.run(); expect(create).toHaveBeenCalledTimes(1);
  focused = false; owner.actions.new_terminal_tab!.run(); expect(create).toHaveBeenCalledTimes(1);
  composing = true; owner.focus(); expect(focus).not.toHaveBeenCalled();
  composing = false; owner.focus(); expect(focus).toHaveBeenCalledTimes(1);
  active = false; owner.actions.toggle_terminal_expanded!.run(); expect(expand).toHaveBeenCalledTimes(1);
  active = true; retire(); owner.actions.next_terminal_tab!.run(); owner.focus();
  expect(cycle).not.toHaveBeenCalled(); expect(focus).toHaveBeenCalledTimes(1); expect(bindings()).toEqual([]);
});

test('child-WebView routing accepts only the current root registry binding and never dispatches after retirement or IME', () => {
  let composing = false;
  const dispatch = vi.fn(), configure = vi.fn();
  const owner = createNativeDesktopTerminalShortcutOwner({ current: () => true, ready: () => true, focused: () => true, composing: () => composing,
    create() {}, focus() {}, cycle() {}, expand() {}, configure,
  });
  const binding = { actionId: 'toggle_terminal_expanded', keystroke: 'ctrl+alt+e' };
  owner.owner.setKeyboardRouting([binding], dispatch);
  owner.dispatch(binding.actionId, 'ctrl+shift+j'); expect(dispatch).not.toHaveBeenCalled();
  owner.dispatch(binding.actionId, binding.keystroke); expect(dispatch).toHaveBeenCalledExactlyOnceWith(binding);
  composing = true; owner.dispatch(binding.actionId, binding.keystroke); expect(dispatch).toHaveBeenCalledTimes(1);
  composing = false; owner.retire(); owner.dispatch(binding.actionId, binding.keystroke); expect(dispatch).toHaveBeenCalledTimes(1);
  expect(configure).toHaveBeenLastCalledWith([]);
});
