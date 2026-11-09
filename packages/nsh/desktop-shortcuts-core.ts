import {
  SHORTCUT_ACTIONS, UNASSIGNED_SHORTCUT, getEffectiveShortcutCombos, getShortcutAction,
  keyToShortcutToken, normalizeCombo, type ShortcutAction,
} from '../ui/src/lib/shortcuts-core';

export type ShortcutOverrides = Readonly<Record<string, string>>;
export type NativeShortcutIntent = { source: 'keyboard' | 'leader' | 'menu'; keystroke?: string; direction?: -1 | 1 };
export type NativeShortcutAction = {
  run: (intent?: NativeShortcutIntent) => void | Promise<unknown>;
  enabled?: boolean;
  /** Implementation support is independent of temporary focus/modal admission. */
  supported?: boolean;
  /** Only an actual focused composer/terminal owner should opt into always. */
  when?: 'always' | 'notEditing';
  /** Context-specific terminal/composer owners can outrank global navigation. */
  priority?: number;
};
export type NativeShortcutActions = Readonly<Record<string, NativeShortcutAction | undefined>>;
export type NativeShortcutRegistryEntry = ShortcutAction & { supported: boolean; enabled: boolean; combos: readonly string[] };
export type NativeShortcutBinding = Readonly<{ actionId: string; keystroke: string; when?: 'always' | 'notEditing'; direction?: -1 | 1 }>;
export type NativeShortcutCapture = { actionId: string; onCapture: (combo: string | null) => void };

const NATIVE_KEYS: Readonly<Record<string, string>> = {
  comma: ',', period: '.', backtick: '`', grave: '`', equal: '=', plus: '=', minus: '-',
  arrowup: 'up', arrowdown: 'down', arrowleft: 'left', arrowright: 'right',
};
const WEB_KEYS: Readonly<Record<string, string>> = { up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright' };

/** Canonical physical NSH stroke. Mac mod is Command; Windows/Linux mod is Control. */
export function nativeShortcutKeystroke(combo: string, apple: boolean): string | null {
  if (!combo.trim() || combo === UNASSIGNED_SHORTCUT) return null;
  const parts = normalizeCombo(combo).split('+'), key = parts.pop()!;
  const mapped = NATIVE_KEYS[key] ?? key;
  if (!/^[a-z0-9`\[\]\\;',./=\-]$/.test(mapped) && !/^(space|enter|escape|tab|backspace|delete|insert|up|down|left|right|home|end|pageup|pagedown|f([1-9]|1[0-9]|2[0-4]))$/.test(mapped)) return null;
  const mods = new Set(parts.map(part => part === 'mod' ? apple ? 'cmd' : 'ctrl' : part));
  if ([...mods].some(mod => !['cmd', 'ctrl', 'shift', 'alt'].includes(mod))) return null;
  return [...['cmd', 'ctrl', 'shift', 'alt'].filter(mod => mods.has(mod)), mapped].join('+');
}

export function shortcutFromNativeKeystroke(stroke: string, apple: boolean): string {
  const parts = stroke.toLowerCase().split('+'), raw = parts.pop()!;
  const mods = parts.map(mod => mod === 'cmd' || mod === 'command' || mod === 'meta' || mod === 'mod' ? 'mod' : mod === 'ctrl' && !apple ? 'mod' : mod);
  return normalizeCombo([...mods, WEB_KEYS[raw] ?? keyToShortcutToken(raw)].join('+'));
}

export function nativeShortcutReserved(stroke: string, apple: boolean): boolean {
  return (apple ? ['cmd+q', 'cmd+h', 'cmd+alt+h', 'cmd+m', 'cmd+ctrl+f'] : ['ctrl+q', 'alt+f4', 'f11']).includes(stroke);
}

/** NSH 0.4 Keystroke::edits_text admission. Native menu backends do not yet
 * honor MenuAction.when; these strokes stay with keymap Auto, not a menu. */
export function nativeShortcutEditsText(stroke: string): boolean {
  const parts = stroke.split('+'), key = parts.pop()!;
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(key)) return false;
  if (key.length === 1) return !parts.some(part => part === 'cmd' || part === 'ctrl') || /^[acvxyz]$/.test(key);
  return true;
}

export function nativeShortcutRegistry(actions: NativeShortcutActions, overrides: ShortcutOverrides = {}): readonly NativeShortcutRegistryEntry[] {
  const supported = (id: string) => !!actions[id] && actions[id]!.supported !== false;
  const enabled = (id: string) => supported(id) && actions[id]!.enabled !== false;
  const leaderActions = ['open_model_selector', 'new_chat', 'open_agent_selector', 'compact_session'];
  return SHORTCUT_ACTIONS.map(action => ({ ...action,
    supported: action.id === 'leader_key' ? leaderActions.some(supported) : supported(action.id),
    enabled: action.id === 'leader_key' ? leaderActions.some(enabled) : enabled(action.id),
    combos: getEffectiveShortcutCombos(action.id, overrides) }));
}

function expandedShortcutCombos(actionId: string, source: readonly string[]) {
  const combos: Array<{ combo: string; direction?: -1 | 1 }> = source.map(combo => ({ combo, direction: actionId === 'cycle_agent' ? 1 : undefined }));
  if (actionId === 'cycle_agent' && source[0] && !source[0].split('+').includes('shift')) combos.push({ combo: `shift+${source[0]}`, direction: -1 });
  if (actionId === 'zoom_in' && normalizeCombo(source[0] ?? '') === 'mod+=') combos.push({ combo: 'mod+shift+=', direction: undefined });
  if (actionId === 'zoom_out' && ['mod+-', 'mod+minus'].includes(normalizeCombo(source[0] ?? ''))) combos.push({ combo: 'mod+shift+minus', direction: undefined });
  return combos;
}

export function nativeShortcutActionCombos(actionId: string, overrides: ShortcutOverrides = {}): readonly string[] {
  return expandedShortcutCombos(actionId, getEffectiveShortcutCombos(actionId, overrides)).map(value => value.combo);
}

export function nativeShortcutActionAdmitted(actionId: string, options: { settingsOpen: boolean; settingsAllowedActions?: readonly string[]; blockingOverlay?: boolean }): boolean {
  if (options.settingsOpen) return (options.settingsAllowedActions ?? ['open_settings']).includes(actionId);
  return !options.blockingOverlay || actionId === 'open_command_palette' || actionId === 'open_settings';
}

/** One native binding per physical stroke; disabled/absent actions never consume a key. */
export function nativeShortcutBindings(options: {
  actions: NativeShortcutActions; overrides?: ShortcutOverrides; apple: boolean; settingsOpen: boolean;
  menuOwnedActions?: readonly string[]; leaderEnabled?: boolean;
  menuOwnedKeystrokes?: readonly string[];
  settingsAllowedActions?: readonly string[];
  blockingOverlay?: boolean;
}): readonly NativeShortcutBinding[] {
  const owned = new Set(options.menuOwnedActions ?? []), byStroke = new Map<string, NativeShortcutBinding & { priority: number }>();
  const ownedStrokes = new Set([...(options.menuOwnedKeystrokes ?? []), ...[...owned].flatMap(id => getEffectiveShortcutCombos(id, options.overrides).map(combo => nativeShortcutKeystroke(combo, options.apple)))]);
  for (const action of nativeShortcutRegistry(options.actions, options.overrides)) {
    if (!action.enabled || owned.has(action.id) || !nativeShortcutActionAdmitted(action.id, options) || action.id === 'leader_key' && !options.leaderEnabled) continue;
    const priority = options.actions[action.id]?.priority ?? (action.id === 'abort_run' ? 100 : action.id.startsWith('switch_tab_') ? 10 : 0);
    const combos = expandedShortcutCombos(action.id, action.combos);
    for (const { combo, direction } of combos) {
      const keystroke = nativeShortcutKeystroke(combo, options.apple);
      if (!keystroke || ownedStrokes.has(keystroke) || nativeShortcutReserved(keystroke, options.apple)) continue;
      const when = options.actions[action.id]?.when ?? (action.id === 'abort_run' || action.id === 'submit_message' || action.id === 'leader_key' ? 'always' : undefined);
      if (!byStroke.has(keystroke) || byStroke.get(keystroke)!.priority < priority) byStroke.set(keystroke, { actionId: action.id, keystroke, priority, when, direction });
    }
  }
  return [...byStroke.values()];
}

/** A routed event must return an original item from this admitted snapshot, not
 * an arbitrary native payload. Replacing a plan revokes even same-stroke items;
 * child WebViews validate id/stroke/direction and resolve back to these items. */
export function createNativeShortcutRoutingPlan() {
  const empty: readonly NativeShortcutBinding[] = Object.freeze([]);
  let bindings = empty, scope: unknown;
  let members = new Set<NativeShortcutBinding>();
  return {
    bindings: () => bindings,
    replace(plan: readonly NativeShortcutBinding[], nextScope: unknown) {
      bindings = plan.length ? Object.freeze(plan.map(binding => Object.freeze({
        actionId: binding.actionId, keystroke: binding.keystroke,
        ...(binding.when !== undefined ? { when: binding.when } : {}),
        ...(binding.direction !== undefined ? { direction: binding.direction } : {}),
      }))) : empty;
      scope = nextScope; members = new Set(bindings);
      return bindings;
    },
    resolve(binding: NativeShortcutBinding, currentScope: unknown): NativeShortcutBinding | null {
      // Identity includes the immutable exact fields and the plan generation.
      // It also rejects malformed/untrusted payloads without reading their fields.
      return scope === currentScope && members.has(binding) ? binding : null;
    },
    retire() { bindings = empty; scope = undefined; members.clear(); },
  };
}

export function nativeShortcutConflicts(actionId: string, combo: string, overrides: ShortcutOverrides, apple: boolean): readonly string[] {
  const stroke = nativeShortcutKeystroke(combo, apple);
  if (!stroke) return [];
  return SHORTCUT_ACTIONS.filter(action => action.id !== actionId && nativeShortcutActionCombos(action.id, overrides).some(other => nativeShortcutKeystroke(other, apple) === stroke)).map(action => action.id);
}

export const DESKTOP_SHORTCUT_STORAGE_KEY = 'desktop.shortcutOverrides.v1';
export type ShortcutStorage = { getItem: (key: string) => Promise<string | null>; setItem: (key: string, value: string) => Promise<unknown> };
export type ShortcutPreferenceState = Readonly<{ overrides: ShortcutOverrides; ready: boolean; busy: boolean; error: 'load' | 'save' | null }>;

function decodeOverrides(raw: string | null): ShortcutOverrides {
  if (raw === null) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('shortcut_preferences_invalid');
  const entries = Object.entries(parsed);
  if (entries.some(([, value]) => typeof value !== 'string')) throw new Error('shortcut_preferences_invalid');
  return Object.fromEntries(entries.map(([id, value]) => [id, normalizeCombo(value as string)]));
}

/** Root-owned device preferences. Writes serialize transforms against the last ACK.
 * A failed write retains prior authority and the exact operation for explicit retry. */
export function createDesktopShortcutPreferences(storage: ShortcutStorage) {
  let state: ShortcutPreferenceState = { overrides: {}, ready: false, busy: false, error: null }, alive = true;
  let serial: Promise<unknown> = Promise.resolve(), retryWrite: ((prior: ShortcutOverrides) => ShortcutOverrides) | null = null;
  const listeners = new Set<(value: ShortcutPreferenceState) => void>();
  function publish(patch: Partial<ShortcutPreferenceState>) {
    if (!alive) return;
    state = { ...state, ...patch };
    for (const listener of listeners) { try { listener(state); } catch { /* Observers do not own a successful storage ACK. */ } }
  }
  function enqueue(work: () => Promise<boolean>) {
    const next = serial.then(() => alive ? work() : false); serial = next.catch(() => {}); return next;
  }
  async function load() {
    publish({ busy: true, error: null });
    try { const overrides = decodeOverrides(await storage.getItem(DESKTOP_SHORTCUT_STORAGE_KEY)); publish({ overrides, ready: true }); return true; }
    catch { publish({ error: 'load' }); return false; }
    finally { publish({ busy: false }); }
  }
  async function write(transform: (prior: ShortcutOverrides) => ShortcutOverrides) {
    let next: ShortcutOverrides;
    try { next = transform(state.overrides); } catch { return false; }
    publish({ busy: true, error: null });
    try {
      await storage.setItem(DESKTOP_SHORTCUT_STORAGE_KEY, JSON.stringify(next));
      retryWrite = null; publish({ overrides: next }); return true;
    } catch { retryWrite = transform; publish({ error: 'save' }); return false; }
    finally { publish({ busy: false }); }
  }
  function change(transform: (prior: ShortcutOverrides) => ShortcutOverrides) {
    return enqueue(async () => state.ready && !retryWrite ? write(transform) : false);
  }
  return {
    state: () => state,
    subscribe(listener: (value: ShortcutPreferenceState) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    load: () => enqueue(async () => state.ready ? true : load()),
    set(actionId: string, combo: string, overwrite = false, apple = false) {
      if (!getShortcutAction(actionId)?.customizable) return Promise.resolve(false);
      const normalized = normalizeCombo(combo), stroke = nativeShortcutKeystroke(normalized, apple);
      if (normalized !== UNASSIGNED_SHORTCUT && (!stroke || nativeShortcutReserved(stroke, apple))) return Promise.resolve(false);
      return change(prior => {
        const next = { ...prior, [actionId]: normalized };
        const conflicts = new Set(nativeShortcutActionCombos(actionId, next).flatMap(combo => nativeShortcutConflicts(actionId, combo, prior, apple)));
        if (conflicts.size && !overwrite) throw new Error('shortcut_conflict');
        for (const id of conflicts) next[id] = UNASSIGNED_SHORTCUT;
        return next;
      });
    },
    reset(actionId?: string, overwrite = false, apple = false) { return change(prior => {
      if (!actionId) return {};
      if (!getShortcutAction(actionId)?.customizable) throw new Error('shortcut_not_customizable');
      const next = { ...prior }; delete next[actionId];
      const conflicts = new Set(nativeShortcutActionCombos(actionId, next).flatMap(combo => nativeShortcutConflicts(actionId, combo, next, apple)));
      if (conflicts.size && !overwrite) throw new Error('shortcut_conflict');
      for (const id of conflicts) next[id] = UNASSIGNED_SHORTCUT;
      return next;
    }); },
    retry: () => enqueue(async () => retryWrite ? write(retryWrite) : state.ready ? true : load()),
    dispose() { alive = false; listeners.clear(); },
  };
}
export type DesktopShortcutPreferences = ReturnType<typeof createDesktopShortcutPreferences>;

/** NSH exposes matched strokes, not a DOM keydown/wildcard listener. Capture is
 * a bounded temporary table, installed only while an explicit edit is armed. */
export function nativeShortcutCaptureStrokes(apple: boolean): readonly string[] {
  const keys = [...'abcdefghijklmnopqrstuvwxyz0123456789`[]\\;\',./=-', 'space', 'enter', 'escape', 'tab', 'backspace', 'delete', 'insert', 'up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', ...Array.from({ length: 24 }, (_, index) => `f${index + 1}`)];
  const result: string[] = [];
  for (let mask = 0; mask < 16; mask++) for (const key of keys) {
    // Web's portable mod represents Ctrl on Windows, not the OS/Super key.
    if (!apple && mask & 1) continue;
    const stroke = [...['cmd', 'ctrl', 'shift', 'alt'].filter((_, index) => mask & 1 << index), key].join('+');
    if (!nativeShortcutReserved(stroke, apple)) result.push(stroke);
  }
  return result;
}
