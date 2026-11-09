import { helpShortcutDisplayKeys, helpShortcutSections, type HelpShortcutItem } from '../ui/src/lib/help-shortcuts-core';
import { getModifierLabel } from '../ui/src/lib/shortcuts-core';
import { nativeShortcutKeystroke, nativeShortcutRegistry, type NativeShortcutActions, type ShortcutOverrides } from './desktop-shortcuts-core';

export type DesktopHelpRow = HelpShortcutItem & { supported: boolean; enabled: boolean; displayKeys: readonly string[] };

/** Reference help retains the entire Web scope. Temporary modal/focus disabling must
 * not label an implemented shortcut as unsupported or remove it from the catalog. */
export function desktopHelpCatalog(actions: NativeShortcutActions, overrides: ShortcutOverrides, apple: boolean, label: (stroke: string) => string) {
  const registry = new Map(nativeShortcutRegistry(actions, overrides).map(action => [action.id, action]));
  const supported = (id: string) => registry.get(id)?.supported ?? (!!actions[id] && actions[id]!.supported !== false);
  const enabled = (id: string) => supported(id) && actions[id]?.enabled !== false;
  const format = (combo: string) => { const stroke = nativeShortcutKeystroke(combo, apple); return stroke ? label(stroke) : '—'; };
  return helpShortcutSections(getModifierLabel(apple)).map(section => ({ categoryKey: section.categoryKey,
    items: section.items.map((item): DesktopHelpRow => {
      const owners = item.id ? [item.id] : item.leader ? [item.leader.actionID] : item.supportActions ?? [];
      return { ...item, supported: owners.length > 0 && owners.every(supported), enabled: owners.length > 0 && owners.every(enabled), displayKeys: helpShortcutDisplayKeys(item, overrides, format) };
    }),
  }));
}

/** NSH's platform label is authoritative (compact Apple glyphs, Ctrl+… on Windows).
 * Split it only for the Web hint-keycap presentation, never for event matching. */
export function desktopHelpKeycaps(label: string): readonly { text: string; separator?: boolean }[] {
  const tokens = label.includes('+') ? label.split('+').map(value => value.trim()).filter(Boolean)
    : [...(label.match(/^[⌘⌃⇧⌥]+/)?.[0] ?? ''), label.replace(/^[⌘⌃⇧⌥]+/, '')].filter(Boolean);
  return tokens.flatMap((text, index) => [...(index ? [{ text: '+', separator: true }] : []), { text }]);
}

/** Web picker dimensions, bounded by the actual native window rather than a phone layout. */
export function desktopHelpGeometry(width: number, height: number) {
  return { width: Math.max(0, Math.min(672, width - 48)), height: Math.max(0, Math.min(672, height * .8)), top: height * .1 };
}
