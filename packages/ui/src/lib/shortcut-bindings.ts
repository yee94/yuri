import {
  eventMatchesShortcut,
  getEffectiveShortcutCombos,
  keyToShortcutToken,
  normalizeCombo,
  UNASSIGNED_SHORTCUT,
  type ShortcutAction,
} from './shortcuts';
import { isMacOS } from './utils';

export type ShortcutBinding = Readonly<{
  action: ShortcutAction;
  combo: string;
  customized: boolean;
}>;

/** A matcher probe for settings/native arbitration, not a dispatched DOM event. */
export function shortcutComboToEvent(combo: string): KeyboardEvent {
  const parts = normalizeCombo(combo).split('+');
  const key = parts.pop() ?? '';
  return new KeyboardEvent('keydown', {
    key,
    metaKey: parts.includes('mod') && isMacOS(),
    ctrlKey: parts.includes('ctrl') || (parts.includes('mod') && !isMacOS()),
    shiftKey: parts.includes('shift'),
    altKey: parts.includes('alt'),
  });
}

export function shortcutCombosConflict(left: string, right: string): boolean {
  if (![left, right].every((combo) => combo && normalizeCombo(combo) !== UNASSIGNED_SHORTCUT)) return false;
  return eventMatchesShortcut(shortcutComboToEvent(left), right) || eventMatchesShortcut(shortcutComboToEvent(right), left);
}

function eventSignature(event: KeyboardEvent): string {
  let key = event.key;
  if ((!key || key === 'Dead') && event.code === 'Backquote') key = '`';
  if (event.altKey && /^(Key.|Digit.)$/.test(event.code)) key = event.code.replace(/^(Key|Digit)/, '');
  return `${Number(event.metaKey)}${Number(event.ctrlKey)}${Number(event.shiftKey)}${Number(event.altKey)}:${keyToShortcutToken(key)}`;
}

/** Compile on catalog/settings changes, never enumerate commands while typing. */
export function compileShortcutBindings(
  actions: readonly ShortcutAction[],
  overrides: Record<string, string>,
) {
  const byKey = new Map<string, ShortcutBinding[]>();
  for (const action of actions) {
    for (const combo of getEffectiveShortcutCombos(action, overrides)) {
      const normalized = normalizeCombo(combo);
      if (!normalized || normalized === UNASSIGNED_SHORTCUT) continue;
      const override = overrides[action.id];
      const binding = { action, combo: normalized, customized: typeof override === 'string' && normalizeCombo(override) === normalized };
      const parts = normalized.split('+');
      const key = parts.pop()!;
      // Ask the existing matcher once per physical modifier variant. Platform
      // policy stays there; ordinary typing never scans modified-key bindings.
      for (const metaKey of [false, true]) for (const ctrlKey of [false, true]) {
        const probe = new KeyboardEvent('keydown', { key, metaKey, ctrlKey,
          shiftKey: parts.includes('shift'), altKey: parts.includes('alt') });
        if (!eventMatchesShortcut(probe, normalized)) continue;
        const signature = eventSignature(probe);
        const bindings = byKey.get(signature) ?? [];
        bindings.push(binding);
        byKey.set(signature, bindings);
      }
    }
  }
  for (const bindings of byKey.values()) {
    bindings.sort((a, b) => Number(b.customized) - Number(a.customized)
      || (b.action.priority ?? 0) - (a.action.priority ?? 0)
      || Number(a.action.id.startsWith('gui-plugin:')) - Number(b.action.id.startsWith('gui-plugin:'))
      || (a.action.id < b.action.id ? -1 : a.action.id > b.action.id ? 1 : 0));
  }
  return {
    match(event: KeyboardEvent, accepts?: (action: ShortcutAction) => boolean): ShortcutBinding | undefined {
      return byKey.get(eventSignature(event))?.find((binding) => !accepts || accepts(binding.action));
    },
  };
}
