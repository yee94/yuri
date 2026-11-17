import { beforeEach, describe, expect, test, vi } from 'vitest';
import { compileShortcutBindings, findShortcutConflicts, shortcutCombosConflict } from './shortcut-bindings';
import { getEffectiveShortcutCombo, UNASSIGNED_SHORTCUT, type ShortcutAction } from './shortcuts';
import * as shortcuts from './shortcuts';

const platform = vi.hoisted(() => ({ mac: false, desktop: true }));
vi.mock('./utils', async (original) => ({ ...await original<typeof import('./utils')>(), isMacOS: () => platform.mac }));
vi.mock('./desktop', async (original) => ({ ...await original<typeof import('./desktop')>(), isDesktopShell: () => platform.desktop }));
beforeEach(() => { platform.mac = false; platform.desktop = true; });

const builtin: ShortcutAction = { id: 'open_command_palette', label: 'Palette', defaultCombo: 'mod+p' };
const plugin = (id = 'demo', priority = 0): ShortcutAction => ({
  id: `gui-plugin:${id}`, label: id, defaultCombo: 'mod+p', priority, customizable: true,
});
const press = (key = 'p', extra: KeyboardEventInit = {}) =>
  new KeyboardEvent('keydown', { key, ctrlKey: true, metaKey: true, ...extra });

describe('command shortcut arbitration', () => {
  // The matching platform is established by the shared shortcut matcher.
  const event = (key = 'p', extra: KeyboardEventInit = {}) => {
    const mac = platform.mac;
    return press(key, { metaKey: mac, ctrlKey: !mac, ...extra });
  };
  test('built-in defaults win ties, developers can explicitly override them', () => {
    expect(compileShortcutBindings([plugin(), builtin], {}).match(event())?.action.id).toBe(builtin.id);
    expect(compileShortcutBindings([builtin, plugin('demo', 1)], {}).match(event())?.action.id).toBe('gui-plugin:demo');
  });
  test('user choices outrank every developer priority', () => {
    expect(compileShortcutBindings([builtin, plugin('demo', Number.MAX_VALUE)], {
      [builtin.id]: 'mod+p',
    }).match(event())?.action.id).toBe(builtin.id);
    expect(compileShortcutBindings([builtin, plugin('demo', -100)], {
      'gui-plugin:demo': 'mod+p',
    }).match(event())?.action.id).toBe('gui-plugin:demo');
  });
  test('same-priority plugins resolve by stable identity, not load order', () => {
    for (const actions of [[plugin('b'), plugin('a')], [plugin('a'), plugin('b')]]) {
      expect(compileShortcutBindings(actions, {}).match(event())?.action.id).toBe('gui-plugin:a');
    }
  });
  test('dynamic commands accept overrides and explicit unassignment without entering the static catalog', () => {
    const action = plugin();
    expect(getEffectiveShortcutCombo(action, { [action.id]: 'mod+m' })).toBe('mod+m');
    expect(getEffectiveShortcutCombo(action, { [action.id]: UNASSIGNED_SHORTCUT })).toBe('');
    expect(compileShortcutBindings([action], { [action.id]: 'mod+m' }).match(event())).toBeUndefined();
    expect(compileShortcutBindings([action], { [action.id]: 'mod+m' }).match(event('m'))?.action.id).toBe(action.id);
    expect(compileShortcutBindings([action], { [action.id]: UNASSIGNED_SHORTCUT }).match(event())).toBeUndefined();
  });
  test('aliases participate in conflict arbitration', () => {
    const action = { ...builtin, defaultAliases: ['mod+m'] };
    expect(compileShortcutBindings([action, { ...plugin(), defaultCombo: 'mod+m' }], {})
      .match(event('m'))?.action.id).toBe(builtin.id);
    expect(compileShortcutBindings([action], { [action.id]: 'mod+x' }).match(event('m'))).toBeUndefined();
  });
  test('conflict detection normalizes key names and ignores unassigned bindings', () => {
    expect(shortcutCombosConflict('mod+,', 'mod+comma')).toBe(true);
    expect(shortcutCombosConflict('mod+{', 'mod+[')).toBe(true);
    expect(shortcutCombosConflict('mod+comma', 'mod+shift+comma')).toBe(false);
    expect(shortcutCombosConflict(UNASSIGNED_SHORTCUT, UNASSIGNED_SHORTCUT)).toBe(false);
    expect(shortcutCombosConflict('', '')).toBe(false);
  });
  test('conflict lookup honours overrides, aliases and contexts', () => {
    const open: ShortcutAction = { id: 'open', label: 'Open', defaultCombo: 'mod+o', defaultAliases: ['mod+k'] };
    const find: ShortcutAction = { id: 'find', label: 'Find', defaultCombo: 'mod+f' };
    const terminalFind: ShortcutAction = { id: 'terminal-find', label: 'Terminal find', defaultCombo: 'mod+f', context: 'terminal' };
    const terminalOpen: ShortcutAction = { id: 'terminal-open', label: 'Terminal open', defaultCombo: 'mod+o', context: 'terminal' };
    const all = [open, find, terminalFind, terminalOpen];
    expect(findShortcutConflicts(find, 'mod+k', all, {}).map((action) => action.id)).toEqual(['open']);
    expect(findShortcutConflicts(find, 'mod+o', all, { [open.id]: 'mod+x' }).map((action) => action.id)).toEqual([]);
    expect(findShortcutConflicts(find, 'mod+o', all, {}).map((action) => action.id)).toEqual(['open']);
    expect(findShortcutConflicts(find, 'mod+f', all, {})).toEqual([]);
    expect(findShortcutConflicts(terminalFind, 'mod+o', all, {}).map((action) => action.id)).toEqual(['terminal-open']);
    expect(findShortcutConflicts(find, UNASSIGNED_SHORTCUT, all, {})).toEqual([]);
    expect(findShortcutConflicts(find, 'mod+k', all, { [open.id]: UNASSIGNED_SHORTCUT })).toEqual([]);
  });
  test('ordinary typing only examines the matching key bucket, never the entire catalog', () => {
    let reads = 0;
    const actions = Array.from({ length: 1000 }, (_, index) => ({
      id: `gui-plugin:${index}`, label: String(index),
      get defaultCombo() { reads += 1; return `mod+f${index}`; },
    }));
    const bindings = compileShortcutBindings(actions, {});
    reads = 0;
    for (let index = 0; index < 50; index += 1) expect(bindings.match(event('a', { ctrlKey: false, metaKey: false }))).toBeUndefined();
    expect(reads).toBe(0);
  });
  test('50 plain input events do not scan or parse 1000 shortcuts sharing that same letter', () => {
    const bindings = compileShortcutBindings(Array.from({ length: 1000 }, (_, index) => plugin(String(index))), {});
    const match = vi.spyOn(shortcuts, 'eventMatchesShortcut');
    const accepts = vi.fn(() => true);
    try {
      for (let index = 0; index < 50; index++) {
        expect(bindings.match(event('p', { ctrlKey: false, metaKey: false }), accepts)).toBeUndefined();
      }
      expect(match).not.toHaveBeenCalled();
      expect(accepts).not.toHaveBeenCalled();
    } finally { match.mockRestore(); }
  });
  test.each([[false, true], [true, true], [true, false]])('compiled modifiers preserve the shared platform matcher (mac=%s desktop=%s)', (mac, desktop) => {
    platform.mac = mac; platform.desktop = desktop;
    for (const combo of ['mod+p', 'ctrl+p', 'mod+ctrl+p', 'mod+shift+p', 'alt+p', 'p']) {
      const bindings = compileShortcutBindings([{ ...plugin(), defaultCombo: combo }], {});
      for (const metaKey of [false, true]) for (const ctrlKey of [false, true]) {
        for (const shiftKey of [false, true]) for (const altKey of [false, true]) {
          const input = event('p', { metaKey, ctrlKey, shiftKey, altKey });
          expect(Boolean(bindings.match(input)), `${combo} ${JSON.stringify({ metaKey, ctrlKey, shiftKey, altKey })}`)
            .toBe(shortcuts.eventMatchesShortcut(input, combo));
        }
      }
    }
  });
});
