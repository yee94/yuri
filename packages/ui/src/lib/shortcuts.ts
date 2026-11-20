import { isMacOS } from '@/lib/utils';
import { isDesktopShell } from '@/lib/desktop';

type ShortcutModifier = 'mod' | 'shift' | 'alt' | 'option' | 'ctrl';
type ShortcutKey = string;
export type ShortcutCombo = string;

export const UNASSIGNED_SHORTCUT: ShortcutCombo = '__unassigned__';

export interface ShortcutAction {
  id: string;
  defaultCombo: ShortcutCombo;
  defaultAliases?: ReadonlyArray<ShortcutCombo>;
  label: string;
  description?: string;
  customizable?: boolean;
  priority?: number;
  /** Surface that owns the binding. Inside its context it shadows global actions, so it only conflicts with actions in the same context. */
  context?: 'terminal';
}

interface ParsedShortcut {
  modifiers: Set<ShortcutModifier>;
  key: ShortcutKey;
}

const MODIFIER_KEY_MAP: Record<string, ShortcutModifier> = {
  'mod': 'mod',
  'shift': 'shift',
  'alt': 'alt',
  'option': 'alt',
  'ctrl': 'ctrl',
  'meta': 'mod',
  'cmd': 'mod',
  'command': 'mod',
};

const DISPLAY_LABEL_MAP: Record<ShortcutModifier, string> = {
  'mod': isMacOS() ? '⌘' : 'Ctrl',
  'shift': '⇧',
  'alt': '⌥',
  'option': '⌥',
  'ctrl': '⌃',
};

const KEY_LABEL_MAP: Record<string, string> = {
  'comma': ',',
  'period': '.',
  'enter': 'Enter',
  'escape': 'Esc',
  'tab': 'Tab',
  'space': 'Space',
  'backspace': '⌫',
  'delete': '⌦',
  'arrowup': '↑',
  'arrowdown': '↓',
  'arrowleft': '←',
  'arrowright': '→',
  'home': 'Home',
  'end': 'End',
  'pageup': 'Page Up',
  'pagedown': 'Page Down',
  'backtick': '`',
  'grave': '`',
  '=': '=',
  'equal': '=',
  'plus': '+',
  'minus': '-',
  '-': '-',
};

const MODIFIER_PRIORITY: ShortcutModifier[] = ['mod', 'ctrl', 'shift', 'alt'];

const SHIFTED_KEY_BASE_MAP: Record<string, string> = {
  '{': '[',
  '}': ']',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
  '|': '\\',
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  '$': '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
};

function isUnassignedShortcut(combo: ShortcutCombo): boolean {
  return combo.trim().toLowerCase() === UNASSIGNED_SHORTCUT;
}

export function keyToShortcutToken(key: string): string {
  const lowered = key.toLowerCase();

  if (lowered === ',') return 'comma';
  if (lowered === '.') return 'period';
  if (lowered === ' ') return 'space';
  if (lowered === 'esc') return 'escape';
  if (lowered === '+') return 'plus';
  if (lowered === '-' || lowered === '_') return 'minus';
  if (lowered === 'arrowup') return 'arrowup';
  if (lowered === 'arrowdown') return 'arrowdown';
  if (lowered === 'arrowleft') return 'arrowleft';
  if (lowered === 'arrowright') return 'arrowright';
  if (lowered === '`') return 'backtick';

  return SHIFTED_KEY_BASE_MAP[lowered] ?? lowered;
}

const SHORTCUT_ACTIONS: ReadonlyArray<ShortcutAction> = [
  {
    id: 'open_command_palette',
    defaultCombo: 'mod+p',
    label: 'Open command palette',
    description: 'Open the command palette',
    customizable: true,
  },
  {
    id: 'focus_input',
    defaultCombo: 'mod+i',
    label: 'Focus input',
    description: 'Focus the chat input field',
    customizable: true,
  },
  {
    id: 'open_status',
    defaultCombo: 'mod+shift+o',
    label: 'Open OpenCode status',
    description: 'Open the OpenCode status dialog',
  },
  {
    id: 'open_settings',
    defaultCombo: 'mod+comma',
    label: 'Open settings',
    description: 'Open the settings panel',
    customizable: true,
  },
  {
    id: 'toggle_terminal',
    defaultCombo: 'ctrl+backtick',
    defaultAliases: ['mod+j'],
    label: 'Toggle terminal',
    description: 'Toggle the integrated terminal',
    customizable: true,
  },
  {
    id: 'toggle_terminal_expanded',
    defaultCombo: 'mod+shift+j',
    label: 'Toggle terminal expanded',
    description: 'Toggle terminal expanded or collapsed',
    customizable: true,
  },
  {
    id: 'new_terminal_tab',
    defaultCombo: 'mod+t',
    label: 'New terminal tab',
    description: 'Create a new terminal tab when the terminal is focused',
    customizable: true,
    context: 'terminal',
  },
  {
    id: 'open_new_terminal',
    defaultCombo: 'mod+shift+backtick',
    label: 'Open new terminal',
    description: 'Open the terminal panel and create a new terminal tab',
    customizable: true,
  },
  {
    id: 'previous_terminal_tab',
    defaultCombo: 'mod+shift+[',
    label: 'Previous terminal tab',
    description: 'Switch to the previous terminal tab when the terminal is focused',
    customizable: true,
    context: 'terminal',
  },
  {
    id: 'next_terminal_tab',
    defaultCombo: 'mod+shift+]',
    label: 'Next terminal tab',
    description: 'Switch to the next terminal tab when the terminal is focused',
    customizable: true,
    context: 'terminal',
  },
  {
    id: 'toggle_sidebar',
    defaultCombo: 'mod+b',
    label: 'Toggle sidebar',
    description: 'Toggle the session sidebar',
    customizable: true,
  },
  {
    id: 'open_timeline_dialog',
    defaultCombo: 'mod+t',
    label: 'Open conversation timeline',
    description: 'Search and navigate within current conversation',
    customizable: true,
  },
  {
    id: 'toggle_prompt_navigator',
    defaultCombo: 'mod+alt+p',
    label: 'Toggle prompt navigator',
    description: 'Show or hide the prompt navigator panel in chat',
    customizable: true,
  },
  {
    id: 'toggle_right_sidebar',
    defaultCombo: 'mod+alt+b',
    defaultAliases: ['mod+\\'],
    label: 'Toggle review panel',
    description: 'Toggle the review panel (right sidebar)',
    customizable: true,
  },
  {
    id: 'open_right_sidebar_git',
    defaultCombo: 'mod+shift+g',
    label: 'Open right sidebar Git tab',
    description: 'Open right sidebar and select Git',
    customizable: true,
  },
  {
    id: 'open_right_sidebar_files',
    defaultCombo: 'mod+shift+f',
    label: 'Open right sidebar Files tab',
    description: 'Open right sidebar and select Files',
    customizable: true,
  },
  {
    id: 'open_browser_panel',
    defaultCombo: 'mod+l',
    label: 'Open browser panel',
    description: 'Open the browser panel and focus its address bar',
    customizable: true,
  },
  {
    id: 'cycle_right_sidebar_tab',
    defaultCombo: 'mod+alt+shift+r',
    label: 'Cycle right sidebar tab',
    description: 'Cycle through right sidebar tabs',
    customizable: true,
  },
  {
    id: 'close_context_panel_tab',
    defaultCombo: 'mod+w',
    label: 'Close context panel tab',
    description: 'Close the active context panel tab (closes the panel when empty)',
    customizable: true,
  },
  {
    id: 'previous_session',
    defaultCombo: 'mod+shift+[',
    defaultAliases: ['mod+arrowup'],
    label: 'Previous session',
    description: 'Switch to the previous session',
    customizable: true,
  },
  {
    id: 'next_session',
    defaultCombo: 'mod+shift+]',
    defaultAliases: ['mod+arrowdown'],
    label: 'Next session',
    description: 'Switch to the next session',
    customizable: true,
  },
  {
    id: 'new_chat',
    defaultCombo: 'mod+n',
    label: 'New session',
    description: 'Start a new session',
    customizable: true,
  },
  {
    id: 'new_chat_worktree',
    // Keep free of New Window (mod+shift+n on desktop application menu).
    defaultCombo: 'mod+shift+alt+n',
    label: 'New worktree draft',
    description: 'Create a new worktree and open a draft in it',
    customizable: true,
  },
  {
    id: 'new_mini_chat',
    defaultCombo: 'mod+alt+n',
    label: 'New Mini Chat window',
    description: 'Open a new Mini Chat draft window',
    customizable: true,
  },
  {
    id: 'submit_message',
    defaultCombo: 'mod+enter',
    label: 'Submit message',
    description: 'Submit the current message',
  },
  {
    id: 'clear_input',
    defaultCombo: 'escape',
    label: 'Clear input',
    description: 'Clear the input field',
  },
  {
    id: 'clear_all_messages',
    defaultCombo: 'ctrl+c',
    label: 'Clear all messages',
    description: 'Clear the composer input and queued messages',
    customizable: true,
  },
  {
    id: 'open_diff_panel',
    defaultCombo: 'mod+2',
    label: 'Open diff panel',
    description: 'Switch to the diff panel',
  },
  {
    id: 'open_terminal_panel',
    defaultCombo: 'mod+3',
    label: 'Open terminal panel',
    description: 'Switch to the terminal panel',
  },
  {
    id: 'open_git_panel',
    defaultCombo: 'mod+4',
    label: 'Open git panel',
    description: 'Switch to the git panel',
  },
  {
    id: 'open_help',
    defaultCombo: 'mod+.',
    label: 'Open keyboard shortcuts',
    description: 'Show the keyboard shortcuts help',
    customizable: true,
  },
  {
    id: 'toggle_services_menu',
    defaultCombo: 'mod+shift+s',
    label: 'Toggle services menu',
    description: 'Open or close the services menu',
    customizable: true,
  },
  {
    id: 'open_usage',
    defaultCombo: 'mod+shift+c',
    label: 'Open usage',
    description: 'Open the usage panel',
    customizable: true,
  },
  {
    id: 'cycle_services_tab',
    defaultCombo: 'mod+alt+shift+s',
    label: 'Cycle services tab',
    description: 'Cycle through tabs in the services menu',
    customizable: true,
  },
  {
    id: 'cycle_theme',
    defaultCombo: 'mod+/',
    label: 'Cycle theme',
    description: 'Cycle between light, dark, and system theme',
    customizable: true,
  },
  {
    id: 'zoom_in',
    defaultCombo: 'mod+=',
    label: 'Zoom in',
    description: 'Increase the webview zoom level',
    customizable: true,
  },
  {
    id: 'zoom_out',
    defaultCombo: 'mod+-',
    label: 'Zoom out',
    description: 'Decrease the webview zoom level',
    customizable: true,
  },
  {
    id: 'zoom_reset',
    defaultCombo: 'mod+0',
    label: 'Reset zoom',
    description: 'Reset the webview zoom level to 100%',
    customizable: true,
  },
  {
    id: 'leader_key',
    defaultCombo: 'ctrl+x',
    label: 'Leader key',
    description: 'Start an OpenCode-style chord, then press M / A / N / C',
    customizable: true,
  },
  {
    id: 'open_model_selector',
    defaultCombo: 'mod+shift+m',
    label: 'Open model selector',
    description: 'Open model selector while in chat',
    customizable: true,
  },
  {
    id: 'cycle_thinking_variant',
    defaultCombo: 'mod+shift+t',
    label: 'Cycle thinking variant',
    description: 'Cycle thinking variant while in chat',
  },
  {
    id: 'cycle_agent',
    defaultCombo: 'tab',
    label: 'Cycle agent',
    description: 'Cycle agent while the model selector is open',
    customizable: true,
  },
  {
    id: 'cycle_favorite_model_forward',
    defaultCombo: 'ctrl+]',
    label: 'Cycle favorite model forward',
    description: 'Cycle forward through starred models without opening the picker',
    customizable: true,
  },
  {
    id: 'cycle_favorite_model_backward',
    defaultCombo: 'ctrl+[',
    label: 'Cycle favorite model backward',
    description: 'Cycle backward through starred models without opening the picker',
    customizable: true,
  },
  {
    id: 'toggle_sidebar_view',
    defaultCombo: 'mod+shift+e',
    label: 'Toggle sidebar view',
    description: 'Switch the session sidebar between the Tasks and Projects views',
    customizable: true,
  },
  {
    id: 'toggle_dictation',
    defaultCombo: 'mod+alt+v',
    label: 'Voice input',
    description: 'Start dictation; press again to confirm and insert the transcript',
    customizable: true,
  },
  {
    id: 'abort_run',
    defaultCombo: 'escape',
    label: 'Abort active run',
    description: 'Abort the currently running task (double press)',
  },
  {
    id: 'switch_tab_1',
    defaultCombo: 'mod+1',
    label: 'Switch to visible session 1',
    description: 'Switch to the first visible sidebar session',
  },
  {
    id: 'switch_tab_2',
    defaultCombo: 'mod+2',
    label: 'Switch to visible session 2',
    description: 'Switch to the second visible sidebar session',
  },
  {
    id: 'switch_tab_3',
    defaultCombo: 'mod+3',
    label: 'Switch to visible session 3',
    description: 'Switch to the third visible sidebar session',
  },
  {
    id: 'switch_tab_4',
    defaultCombo: 'mod+4',
    label: 'Switch to visible session 4',
    description: 'Switch to the fourth visible sidebar session',
  },
  {
    id: 'switch_tab_5',
    defaultCombo: 'mod+5',
    label: 'Switch to visible session 5',
    description: 'Switch to the fifth visible sidebar session',
  },
  {
    id: 'switch_tab_6',
    defaultCombo: 'mod+6',
    label: 'Switch to visible session 6',
    description: 'Switch to the sixth visible sidebar session',
  },
  {
    id: 'switch_tab_7',
    defaultCombo: 'mod+7',
    label: 'Switch to visible session 7',
    description: 'Switch to the seventh visible sidebar session',
  },
  {
    id: 'switch_tab_8',
    defaultCombo: 'mod+8',
    label: 'Switch to visible session 8',
    description: 'Switch to the eighth visible sidebar session',
  },
  {
    id: 'switch_tab_9',
    defaultCombo: 'mod+9',
    label: 'Switch to visible session 9',
    description: 'Switch to the ninth visible sidebar session',
  },
  {
    id: 'switch_assistant_1',
    defaultCombo: 'mod+shift+1',
    label: 'Switch to assistant 1',
    description: 'Open the first assistant conversation',
    customizable: true,
  },
  {
    id: 'switch_assistant_2',
    defaultCombo: 'mod+shift+2',
    label: 'Switch to assistant 2',
    description: 'Open the second assistant conversation',
    customizable: true,
  },
  {
    id: 'switch_assistant_3',
    defaultCombo: 'mod+shift+3',
    label: 'Switch to assistant 3',
    description: 'Open the third assistant conversation',
    customizable: true,
  },
  {
    id: 'switch_assistant_4',
    defaultCombo: 'mod+shift+4',
    label: 'Switch to assistant 4',
    description: 'Open the fourth assistant conversation',
    customizable: true,
  },
] as const;

export function normalizeCombo(combo: ShortcutCombo): ShortcutCombo {
  if (isUnassignedShortcut(combo)) {
    return UNASSIGNED_SHORTCUT;
  }

  const rawParts = combo
    .toLowerCase()
    .trim()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);

  const modifiers = new Set<ShortcutModifier>();
  let key = '';

  for (const rawPart of rawParts) {
    const part = rawPart === ',' ? 'comma' : rawPart === '.' ? 'period' : rawPart;
    const modifier = MODIFIER_KEY_MAP[part];
    if (modifier) {
      modifiers.add(modifier);
      continue;
    }
    key = part;
  }

  const orderedModifiers = MODIFIER_PRIORITY.filter((modifier) => modifiers.has(modifier));
  return [...orderedModifiers, key].filter(Boolean).join('+');
}

function isValidShortcutCombo(combo: ShortcutCombo): boolean {
  if (isUnassignedShortcut(combo)) {
    return true;
  }

  const parsed = parseShortcut(combo);
  // Option+letter on macOS reports a symbol such as "∫"; the matcher compares the physical key, so it can never match.
  if (parsed.modifiers.has('alt') && /^[^\p{ASCII}]$/u.test(parsed.key)) {
    return false;
  }
  return parsed.key.trim().length > 0;
}

function parseShortcut(combo: ShortcutCombo): ParsedShortcut {
  if (isUnassignedShortcut(combo)) {
    return { modifiers: new Set<ShortcutModifier>(), key: UNASSIGNED_SHORTCUT };
  }

  const normalized = normalizeCombo(combo);
  const parts = normalized.split('+');
  const modifiers: Set<ShortcutModifier> = new Set();
  let key: ShortcutKey = '';

  for (const part of parts) {
    const modifier = MODIFIER_KEY_MAP[part];
    if (modifier) {
      modifiers.add(modifier);
    } else {
      key = part;
    }
  }

  return { modifiers, key };
}

export function formatShortcutForDisplay(combo: ShortcutCombo): string {
  if (isUnassignedShortcut(combo)) {
    return 'Unassigned';
  }

  const parsed = parseShortcut(combo);

  if (!parsed.key && parsed.modifiers.size === 0) {
    return 'Unassigned';
  }

  const parts: string[] = [];

  for (const modifier of MODIFIER_PRIORITY) {
    if (parsed.modifiers.has(modifier)) {
      parts.push(DISPLAY_LABEL_MAP[modifier]);
    }
  }

  if (parsed.key) {
    const keyLabel = KEY_LABEL_MAP[parsed.key.toLowerCase()] || parsed.key.toUpperCase();
    parts.push(keyLabel);
  }

  return parts.join(' + ');
}

export function getShortcutAction(id: string): ShortcutAction | undefined {
  return SHORTCUT_ACTIONS.find((action) => action.id === id);
}

export function getShortcutActions(): ReadonlyArray<ShortcutAction> {
  return SHORTCUT_ACTIONS;
}

export function getCustomizableShortcutActions(): ReadonlyArray<ShortcutAction> {
  return SHORTCUT_ACTIONS.filter((action) => action.customizable === true);
}

/** Actions folded into another one; users' saved overrides for the old id still apply. */
const LEGACY_SHORTCUT_IDS: Readonly<Record<string, readonly string[]>> = {
  toggle_terminal: ['toggle_bottom_panel'],
};

export function getLegacyShortcutIds(actionId: string): readonly string[] {
  return LEGACY_SHORTCUT_IDS[actionId] ?? [];
}

export function getShortcutOverride(
  actionId: string,
  overrides?: Record<string, ShortcutCombo>,
): ShortcutCombo | undefined {
  for (const id of [actionId, ...getLegacyShortcutIds(actionId)]) {
    const value = overrides?.[id];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

export const SHORTCUT_COMBO_SEPARATOR = ' ';

export function getDefaultShortcutCombos(action: ShortcutAction): ShortcutCombo[] {
  return [action.defaultCombo, ...(action.defaultAliases ?? [])];
}

/** An override holds one or more combos separated by whitespace; a single combo is the legacy form. */
export function getEffectiveShortcutCombos(
  actionId: string | ShortcutAction,
  overrides?: Record<string, ShortcutCombo>,
): ReadonlyArray<ShortcutCombo> {
  const action = typeof actionId === 'string' ? getShortcutAction(actionId) : actionId;
  if (!action) {
    return [];
  }

  const override = getShortcutOverride(action.id, overrides);
  if (typeof override === 'string') {
    if (override.trim().toLowerCase() === UNASSIGNED_SHORTCUT) {
      return [];
    }
    const combos = [...new Set(override.split(/\s+/).filter(Boolean).map(normalizeCombo).filter(isValidShortcutCombo))];
    if (combos.length > 0) {
      return combos;
    }
  }

  return getDefaultShortcutCombos(action);
}

export function getEffectiveShortcutCombo(
  actionId: string | ShortcutAction,
  overrides?: Record<string, ShortcutCombo>
): ShortcutCombo {
  return getEffectiveShortcutCombos(actionId, overrides)[0] ?? '';
}

/** True only when the saved override changes what the action actually uses. */
export function isShortcutCustomized(action: ShortcutAction, overrides?: Record<string, ShortcutCombo>): boolean {
  if (getShortcutOverride(action.id, overrides) === undefined) return false;
  const effective = getEffectiveShortcutCombos(action, overrides);
  const defaults = getDefaultShortcutCombos(action).map(normalizeCombo);
  return effective.length !== defaults.length || effective.some((combo, index) => combo !== defaults[index]);
}

export function isRiskyBrowserShortcut(combo: ShortcutCombo): boolean {
  if (isUnassignedShortcut(combo)) {
    return false;
  }

  const parsed = parseShortcut(combo);
  if (!parsed.modifiers.has('mod')) {
    return false;
  }

  const key = parsed.key.toLowerCase();
  const dangerousPrimary = new Set(['w', 't', 'r', 'p', 's', 'f', 'l', 'n']);
  return dangerousPrimary.has(key) && !parsed.modifiers.has('shift') && !parsed.modifiers.has('alt');
}

export function eventMatchesShortcut(
  event: KeyboardEvent | React.KeyboardEvent,
  shortcut: ShortcutAction | ShortcutCombo
): boolean {
  const combo = typeof shortcut === 'string' ? shortcut : shortcut.defaultCombo;
  if (isUnassignedShortcut(combo)) {
    return false;
  }

  const parsed = parseShortcut(combo);

  const expectedMod = parsed.modifiers.has('mod');
  const expectedShift = parsed.modifiers.has('shift');
  const expectedAlt = parsed.modifiers.has('alt');
  const expectedCtrl = parsed.modifiers.has('ctrl');
  const isDesktopMac = isMacOS() && isDesktopShell();
  const isMac = isMacOS();

  const modMatches = isDesktopMac
    ? event.metaKey
    : isMac
      ? (event.metaKey || event.ctrlKey)
      : event.ctrlKey;

  if (expectedMod && !modMatches) {
    return false;
  }

  if (!expectedMod && event.metaKey) {
    return false;
  }

  if (expectedShift !== event.shiftKey) {
    return false;
  }

  if (expectedAlt !== event.altKey) {
    return false;
  }

  if (expectedCtrl) {
    if (!event.ctrlKey) {
      return false;
    }
  } else {
    const ctrlUsedAsMod = expectedMod && !isDesktopMac && event.ctrlKey;
    if (event.ctrlKey && !ctrlUsedAsMod) {
      return false;
    }
  }

  let eventKeyRaw = event.key;
  if ((!eventKeyRaw || eventKeyRaw === 'Dead') && event.code === 'Backquote') {
    eventKeyRaw = '`';
  }
  if (event.altKey) {
    if (event.code.startsWith('Key') && event.code.length === 4) {
      eventKeyRaw = event.code.slice(3).toLowerCase();
    } else if (event.code.startsWith('Digit') && event.code.length === 6) {
      eventKeyRaw = event.code.slice(5);
    }
  }

  const eventKey = keyToShortcutToken(eventKeyRaw);
  const expectedKey = keyToShortcutToken(parsed.key);

  return eventKey === expectedKey;
}

export function getModifierLabel(): string {
  return isMacOS() ? '⌘' : 'Ctrl';
}

/**
 * Zoom shortcuts accept both the unshifted and shifted key variants
 * (Mod+= / Mod++, Mod+- / Mod+_), matching browser/Codex conventions.
 */
export function eventMatchesZoomShortcut(
  event: KeyboardEvent | React.KeyboardEvent,
  direction: 'in' | 'out',
  effectiveCombo: ShortcutCombo,
): boolean {
  if (eventMatchesShortcut(event, effectiveCombo)) {
    return true;
  }

  const normalized = normalizeCombo(effectiveCombo);
  const isDesktopMac = isMacOS() && isDesktopShell();
  const isMac = isMacOS();
  const modMatches = isDesktopMac
    ? event.metaKey
    : isMac
      ? (event.metaKey || event.ctrlKey)
      : event.ctrlKey;

  if (!modMatches || event.altKey) {
    return false;
  }

  // Reject plain Ctrl on desktop Mac when the binding is Mod-only.
  if (isDesktopMac && event.ctrlKey && !event.metaKey) {
    return false;
  }

  if (direction === 'in' && normalized === 'mod+=') {
    return event.key === '+' || event.code === 'NumpadAdd';
  }

  if (direction === 'out' && (normalized === 'mod+-' || normalized === 'mod+minus')) {
    return event.key === '_' || event.code === 'NumpadSubtract';
  }

  return false;
}
