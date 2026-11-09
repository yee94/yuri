import { isMacOS } from '@/lib/utils';
import { isDesktopShell } from '@/lib/desktop';
import * as core from './shortcuts-core';

export * from './shortcuts-core';

export function formatShortcutForDisplay(combo: core.ShortcutCombo): string {
  return core.formatShortcutForDisplay(combo, isMacOS());
}

export function getModifierLabel(): string {
  return core.getModifierLabel(isMacOS());
}

export function eventMatchesShortcut(event: core.ShortcutKeyEvent, shortcut: core.ShortcutAction | core.ShortcutCombo): boolean {
  return core.eventMatchesShortcut(event, shortcut, { isMac: isMacOS(), isDesktopShell: isDesktopShell() });
}

export function eventMatchesZoomShortcut(event: core.ShortcutKeyEvent, direction: 'in' | 'out', effectiveCombo: core.ShortcutCombo): boolean {
  return core.eventMatchesZoomShortcut(event, direction, effectiveCombo, { isMac: isMacOS(), isDesktopShell: isDesktopShell() });
}
