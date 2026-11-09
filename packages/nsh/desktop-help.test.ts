import { describe, expect, it } from 'vitest';
import { desktopHelpCatalog, desktopHelpGeometry, desktopHelpKeycaps } from './desktop-help-core';
import { helpShortcutSections } from '../ui/src/lib/help-shortcuts-core';
import { UNASSIGNED_SHORTCUT } from '../ui/src/lib/shortcuts-core';

describe('native Help reference catalog', () => {
  it('retains every Web section and row instead of reusing the customizable settings subset', () => {
    const sections = desktopHelpCatalog({}, {}, true, stroke => stroke);
    const source = helpShortcutSections('⌘');
    expect(sections.map(section => [section.categoryKey, section.items.map(row => row.descriptionKey)])).toEqual(source.map(section => [section.categoryKey, section.items.map(row => row.descriptionKey)]));
    expect(sections.map(section => section.items.length)).toEqual([9, 7, 4, 12, 9]);
    expect(sections.flatMap(section => section.items).every(row => row.supported === false)).toBe(true);
  });
  it('separates implementation support from temporary enabled state and leaves unsupported entries visible', () => {
    const rows = desktopHelpCatalog({ open_help: { run() {}, enabled: false }, toggle_terminal: { run() {}, supported: false } }, {}, true, stroke => stroke).flatMap(section => section.items);
    expect(rows.find(row => row.id === 'open_help')).toMatchObject({ supported: true, enabled: false });
    expect(rows.find(row => row.id === 'toggle_terminal')).toMatchObject({ supported: false, enabled: false });
    expect(rows).toHaveLength(41);
    const partial = desktopHelpCatalog({ switch_tab_1: { run() {} } }, {}, true, stroke => stroke).flatMap(section => section.items);
    expect(partial.find(row => row.descriptionKey === 'helpDialog.item.switchSession')?.supported).toBe(false);
    const complete = Object.fromEntries(Array.from({ length: 9 }, (_, index) => [`switch_tab_${index + 1}`, { run() {} }]));
    expect(desktopHelpCatalog(complete, {}, true, stroke => stroke).flatMap(section => section.items).find(row => row.descriptionKey === 'helpDialog.item.switchSession')?.supported).toBe(true);
  });
  it.each([true, false])('uses platform label callback with shared defaults, aliases and exact remaps (Apple=%s)', apple => {
    const label = (stroke: string) => `platform:${stroke}`;
    const all = desktopHelpCatalog({}, {}, apple, label).flatMap(section => section.items);
    expect(all.find(row => row.id === 'toggle_right_sidebar')?.displayKeys).toEqual(apple ? ['platform:cmd+alt+b', 'platform:cmd+\\'] : ['platform:ctrl+alt+b', 'platform:ctrl+\\']);
    const changed = desktopHelpCatalog({}, { open_help: 'mod+alt+k', leader_key: 'alt+l', toggle_right_sidebar: UNASSIGNED_SHORTCUT }, apple, label).flatMap(section => section.items);
    expect(changed.find(row => row.id === 'open_help')?.displayKeys).toEqual([apple ? 'platform:cmd+alt+k' : 'platform:ctrl+alt+k']);
    expect(changed.find(row => row.descriptionKey === 'helpDialog.item.leaderOpenModel')?.displayKeys).toEqual(['platform:alt+l → M']);
    expect(changed.find(row => row.id === 'toggle_right_sidebar')?.displayKeys).toEqual([]);
  });
  it('preserves compact platform labels, modifier tokens, aliases and chord separators as keycaps', () => {
    expect(desktopHelpKeycaps('⇧⌘M').map(part => part.text)).toEqual(['⇧', '+', '⌘', '+', 'M']);
    expect(desktopHelpKeycaps('Ctrl+Shift+M').map(part => part.text)).toEqual(['Ctrl', '+', 'Shift', '+', 'M']);
    expect(desktopHelpKeycaps('⌥L → M').map(part => part.text)).toEqual(['⌥', '+', 'L → M']);
    expect(desktopHelpKeycaps('↑↓').map(part => part.text)).toEqual(['↑↓']);
  });
  it('uses Web 672px/80vh bounds, 10vh top and 24px horizontal insets across window sizes', () => {
    expect(desktopHelpGeometry(1440, 900)).toEqual({ width: 672, height: 672, top: 90 });
    expect(desktopHelpGeometry(420, 360)).toEqual({ width: 372, height: 288, top: 36 });
    expect(desktopHelpGeometry(20, 20)).toEqual({ width: 0, height: 16, top: 2 });
  });
});
