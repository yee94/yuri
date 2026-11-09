import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { HelpDialog } from './HelpDialog';
import { helpShortcutSections } from '@/lib/help-shortcuts-core';
import { dict } from '@/lib/i18n/messages/en';

const fixture = vi.hoisted(() => ({ overrides: {} as Record<string, string>, vscode: false, close: vi.fn() }));
vi.mock('@/lib/device', () => ({ useDeviceInfo: () => ({ isMobile: false }) }));
vi.mock('@/lib/desktop', () => ({ isVSCodeRuntime: () => fixture.vscode, isDesktopShell: () => false }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: keyof typeof dict) => dict[key] }) }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({ isHelpDialogOpen: true, setHelpDialogOpen: fixture.close, shortcutOverrides: fixture.overrides }) }));
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); fixture.overrides = {}; fixture.vscode = false; fixture.close.mockClear();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
test.each([false, true])('real Web HelpDialog consumes the shared ordered catalog and keeps its runtime filter (VS Code=%s)', async vscode => {
  fixture.vscode = vscode; await act(async () => root.render(<HelpDialog />));
  const expected = helpShortcutSections('Ctrl').flatMap(section => section.items).filter(row => !vscode || row.id !== 'toggle_prompt_navigator');
  expect([...document.querySelectorAll('.yuri-help-shortcut-row .yuri-picker-label')].map(node => node.textContent)).toEqual(expected.map(row => dict[row.descriptionKey]));
  expect(document.querySelectorAll('.yuri-picker-section')).toHaveLength(5);
  expect(document.querySelector('input')).toBeNull(); expect(document.querySelector('[data-slot="dialog-close"]')).toBeNull();
});
test('real Web help retains hint badges, remapped aliases and leader remap without adding settings controls', async () => {
  fixture.overrides = { open_help: 'mod+alt+k', leader_key: 'alt+l' }; await act(async () => root.render(<HelpDialog />));
  const rows = [...document.querySelectorAll('.yuri-help-shortcut-row')];
  const help = rows.find(row => row.textContent?.includes(dict['helpDialog.item.showKeyboardShortcuts']))!;
  expect(help.querySelector('kbd[aria-label="K"]')).not.toBeNull();
  const leader = rows.find(row => row.textContent?.includes(dict['helpDialog.item.leaderOpenModel']))!;
  expect(leader.querySelector('kbd[aria-label="L → M"]')).not.toBeNull();
  expect(document.querySelector('kbd[data-variant="default"]')).toBeNull();
  expect(document.querySelectorAll('.yuri-help-shortcut-row button')).toHaveLength(0);
});
