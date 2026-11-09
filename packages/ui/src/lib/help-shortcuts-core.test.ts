import { describe, expect, it } from 'vitest';
import { helpShortcutDisplayKeys, helpShortcutSections } from './help-shortcuts-core';
import { formatShortcutForDisplay, getShortcutAction, UNASSIGNED_SHORTCUT } from './shortcuts-core';
import { dict } from './i18n/messages/en';
import { iconSpriteData } from '../components/icon/sprite';

describe('shared Web/native help metadata', () => {
  it('keeps the exact five ordered Web groups and all 41 original descriptions', () => {
    expect(helpShortcutSections('Ctrl').map(section => [section.categoryKey.split('.').at(-1), section.items.map(row => row.descriptionKey.split('.').at(-1))])).toEqual([
      ['navigationCommands', ['openCommandPalette', 'showKeyboardShortcuts', 'toggleSessionSidebar', 'cycleAgent', 'openModelSelector', 'navigateModels', 'adjustThinkingMode', 'cycleThinkingVariant', 'newWindow']],
      ['sessionManagement', ['createNewSession', 'createNewWorktreeDraft', 'previousSession', 'nextSession', 'focusChatInput', 'togglePromptNavigator', 'abortActiveRun']],
      ['leaderChords', ['leaderOpenModel', 'leaderOpenAgent', 'leaderNewSession', 'leaderCompact']],
      ['panels', ['toggleRightSidebar', 'openRightSidebarGitTab', 'openRightSidebarFilesTab', 'cycleRightSidebarTab', 'closeContextPanelTab', 'toggleTerminal', 'newTerminalTab', 'openNewTerminal', 'previousTerminalTab', 'nextTerminalTab', 'toggleBottomPanel', 'toggleTerminalExpanded']],
      ['interface', ['cycleTheme', 'zoomIn', 'zoomOut', 'zoomReset', 'switchSession', 'toggleServicesMenu', 'openUsage', 'cycleServicesTab', 'openSettings']],
    ]);
    const items = helpShortcutSections('Ctrl').flatMap(section => section.items);
    expect(new Set(items.map(item => item.descriptionKey)).size).toBe(41);
    for (const item of items) {
      expect(dict[item.descriptionKey]).toBeTruthy(); if (item.icon) expect(iconSpriteData[item.icon]).toBeTruthy();
      if (item.id) { expect(getShortcutAction(item.id)).toBeDefined(); expect(item.keys).toBe(''); }
    }
  });
  it('takes aliases and remaps from the same action catalog as dispatch and updates all leader chords', () => {
    const rows = helpShortcutSections('⌘').flatMap(section => section.items);
    const format = (combo: string) => formatShortcutForDisplay(combo, true);
    const sidebar = rows.find(row => row.id === 'toggle_right_sidebar')!;
    expect(helpShortcutDisplayKeys(sidebar, {}, format)).toEqual(['⌘ + ⌥ + B', '⌘ + \\']);
    expect(helpShortcutDisplayKeys(sidebar, { toggle_right_sidebar: 'mod+k' }, format)).toEqual(['⌘ + K']);
    expect(helpShortcutDisplayKeys(sidebar, { toggle_right_sidebar: UNASSIGNED_SHORTCUT }, format)).toEqual([]);
    expect(rows.filter(row => row.leader).map(row => helpShortcutDisplayKeys(row, { leader_key: 'alt+l' }, format))).toEqual([['⌥ + L → M'], ['⌥ + L → A'], ['⌥ + L → N'], ['⌥ + L → C']]);
  });
  it('retains platform modifier templates for contextual window and numeric-session hints', () => {
    for (const mod of ['Ctrl', '⌘']) {
      const rows = helpShortcutSections(mod).flatMap(section => section.items);
      expect(rows.find(row => row.descriptionKey === 'helpDialog.item.newWindow')?.keys).toEqual([`Shift + ${mod} + N`]);
      expect(rows.find(row => row.descriptionKey === 'helpDialog.item.switchSession')?.keys).toEqual([`${mod} + 1...9`]);
    }
  });
});
