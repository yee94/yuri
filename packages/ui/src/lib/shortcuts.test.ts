import { describe, expect, test } from 'vitest';

import { getCustomizableShortcutActions, getEffectiveShortcutCombo, getEffectiveShortcutCombos, getShortcutAction } from './shortcuts';

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
});
