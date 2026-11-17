import { describe, expect, test } from 'vitest';

import { getCustomizableShortcutActions, getEffectiveShortcutCombo, getEffectiveShortcutCombos, getShortcutAction, isShortcutCustomized } from './shortcuts';

describe('getEffectiveShortcutCombo', () => {
  test('does not expose or reactivate the removed go-to-line action from a saved override', () => {
    expect(getShortcutAction('open_go_to_line')).toBeUndefined();
    expect(getCustomizableShortcutActions().some((action) => action.id === 'open_go_to_line')).toBe(false);
    expect(getEffectiveShortcutCombo('open_go_to_line', { open_go_to_line: 'alt+g' })).toBe('');
    expect(getEffectiveShortcutCombos('open_go_to_line', { open_go_to_line: 'alt+g' })).toEqual([]);
  });

  test('uses Ctrl+backtick as the default terminal shortcut', () => {
    expect(getEffectiveShortcutCombo('toggle_terminal')).toBe('ctrl+backtick');
  });

  test('uses mod+shift+c as the default open usage shortcut', () => {
    expect(getEffectiveShortcutCombo('open_usage')).toBe('mod+shift+c');
  });
});

describe('getEffectiveShortcutCombos', () => {
  test('returns the default session navigation shortcut and its alias', () => {
    expect(getEffectiveShortcutCombos('previous_session')).toEqual(['mod+shift+[', 'mod+arrowup']);
    expect(getEffectiveShortcutCombos('next_session')).toEqual(['mod+shift+]', 'mod+arrowdown']);
  });

  test('uses only the configured shortcut when an action is customized', () => {
    expect(getEffectiveShortcutCombos('previous_session', {
      previous_session: 'mod+shift+arrowup',
    })).toEqual(['mod+shift+arrowup']);
  });

  test('returns the toggle_right_sidebar default combo and its Cmd+\\ alias', () => {
    expect(getEffectiveShortcutCombos('toggle_right_sidebar')).toEqual(['mod+alt+b', 'mod+\\']);
  });

  test('merges the former bottom-panel shortcut into the terminal toggle as an alias', () => {
    expect(getShortcutAction('toggle_bottom_panel')).toBeUndefined();
    expect(getEffectiveShortcutCombos('toggle_terminal')).toEqual(['ctrl+backtick', 'mod+j']);
    expect(getEffectiveShortcutCombos('toggle_terminal', { toggle_terminal: 'ctrl+backtick mod+j' })).toEqual(['ctrl+backtick', 'mod+j']);
    expect(getEffectiveShortcutCombos('toggle_terminal', { toggle_terminal: 'mod+j' })).toEqual(['mod+j']);
    expect(getEffectiveShortcutCombos('toggle_terminal', { toggle_bottom_panel: 'mod+k' })).toEqual(['mod+k']);
  });
});

describe('isShortcutCustomized', () => {
  const action = (id: string) => getShortcutAction(id)!;

  test('is false without an override or when the override restates a default', () => {
    expect(isShortcutCustomized(action('toggle_sidebar'), {})).toBe(false);
    expect(isShortcutCustomized(action('toggle_sidebar'), { toggle_sidebar: 'mod+b' })).toBe(false);
    expect(isShortcutCustomized(action('toggle_terminal'), { toggle_terminal: 'ctrl+backtick mod+j' })).toBe(false);
    expect(isShortcutCustomized(action('toggle_terminal'), { toggle_terminal: 'mod+j' })).toBe(true);
  });

  test('ignores an Option-produced symbol key that can never match', () => {
    const overrides = { toggle_right_sidebar: 'mod+alt+∫' };
    expect(isShortcutCustomized(action('toggle_right_sidebar'), overrides)).toBe(false);
    expect(getEffectiveShortcutCombos('toggle_right_sidebar', overrides)).toEqual(['mod+alt+b', 'mod+\\']);
  });

  test('is true for a real change or an explicit unassignment', () => {
    expect(isShortcutCustomized(action('toggle_sidebar'), { toggle_sidebar: 'mod+k' })).toBe(true);
    expect(isShortcutCustomized(action('toggle_sidebar'), { toggle_sidebar: '__unassigned__' })).toBe(true);
  });
});
