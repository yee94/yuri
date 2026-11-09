import { cleanup, effect, keymap, platform, signal, Storage, untracked } from 'nsh';
import {
  createDesktopShortcutPreferences, createNativeShortcutRoutingPlan, nativeShortcutActionAdmitted, nativeShortcutBindings, nativeShortcutCaptureStrokes,
  nativeShortcutKeystroke, shortcutFromNativeKeystroke,
  type DesktopShortcutPreferences, type NativeShortcutActions, type NativeShortcutBinding, type NativeShortcutCapture, type NativeShortcutIntent, type ShortcutOverrides,
} from './desktop-shortcuts-core';

export type NativeDesktopShortcutOptions = {
  /** Stable registry getter; action availability belongs to the actual feature owner. */
  actions: () => NativeShortcutActions;
  enabled: () => boolean;
  settingsOpen: () => boolean;
  /** Defaults to open_settings only. Explicit root close guards may opt in. */
  settingsAllowedActions?: () => readonly string[];
  preferences?: DesktopShortcutPreferences;
  userOverrides?: () => ShortcutOverrides;
  composing?: () => boolean;
  blockingOverlay?: () => boolean;
  chatActive?: () => boolean;
  /** Stable Host/window/route identity (not a newly allocated object per read).
   * Changing it retires leader/abort/capture callbacks. */
  scope?: () => unknown;
  /** The menu must consume the same effective overrides and dispatch callbacks.
   * Listed actions are NOT also installed in keymap. */
  menuOwnedActions?: () => readonly string[];
  /** Preferred: the installed native menu's actual physical accelerators.
   * Other aliases remain bound; an off-native/headless menu reports no ownership. */
  menuOwnedKeystrokes?: () => readonly string[];
  capture?: () => NativeShortcutCapture | null;
  onError?: (actionId: string, error: unknown) => void;
  onAbortPrimed?: (primed: boolean) => void;
  onLeaderPending?: (pending: boolean) => void;
};

/** Call once under the desktop root's NSH owner. No application/global state is read.
 * NSH default admission leaves focused-field cut/copy/paste/caret/typing to Input;
 * only an explicitly armed capture/leader owns ordinary keys. */
export function installNativeDesktopShortcuts(options: NativeDesktopShortcutOptions) {
  const apple = platform.os === 'macos' || platform.os === 'ios';
  const preferences = options.preferences ?? createDesktopShortcutPreferences(Storage), ownsPreferences = !options.preferences;
  const state = signal(preferences.state()), leader = signal(false);
  const routing = createNativeShortcutRoutingPlan(), emptyBindings = routing.bindings(), plan = signal(emptyBindings);
  const removers = new Set<() => void>();
  let lastCapture: NativeShortcutCapture | null = null, captureScope: unknown;
  let alive = true, leaderTimer: ReturnType<typeof setTimeout> | undefined, abortTimer: ReturnType<typeof setTimeout> | undefined;
  let abortPrimed = false;
  const unsubscribe = preferences.subscribe(value => state.set(value));
  if (!options.userOverrides) void preferences.load();
  function bind(bindings: Record<string, () => void>, when?: 'always' | 'notEditing') {
    if (!Object.keys(bindings).length) return;
    const release = keymap.bind(bindings, when ? { when } : undefined);
    const remove = () => { release(); removers.delete(remove); };
    removers.add(remove); cleanup(remove);
  }
  function clearLeader() {
    if (leaderTimer !== undefined) clearTimeout(leaderTimer);
    leaderTimer = undefined;
    if (leader()) { leader.set(false); options.onLeaderPending?.(false); }
  }
  function clearAbort() {
    if (abortTimer !== undefined) clearTimeout(abortTimer);
    abortTimer = undefined;
    if (abortPrimed) { abortPrimed = false; options.onAbortPrimed?.(false); }
  }
  function available() { return alive && (options.userOverrides !== undefined || state().ready) && options.enabled() && !options.composing?.() && !options.capture?.(); }
  function invoke(id: string, intent: NativeShortcutIntent = { source: 'keyboard' }): boolean {
    if (!available() || !nativeShortcutActionAdmitted(id, { settingsOpen: options.settingsOpen(), settingsAllowedActions: options.settingsAllowedActions?.(), blockingOverlay: options.blockingOverlay?.() })) return false;
    const action = options.actions()[id];
    if (!action || action.supported === false || action.enabled === false) return false;
    const scope = options.scope?.();
    try { Promise.resolve(action.run(intent)).catch(error => { if (alive && options.scope?.() === scope) options.onError?.(id, error); }); }
    catch (error) { if (alive && options.scope?.() === scope) options.onError?.(id, error); }
    return true;
  }
  function armLeader(): boolean {
    clearLeader();
    if (!available() || options.settingsOpen() || options.blockingOverlay?.() || options.chatActive?.() === false) return false;
    leader.set(true); options.onLeaderPending?.(true);
    leaderTimer = setTimeout(() => untracked(clearLeader), 2000);
    return true;
  }
  function dispatch(binding: NativeShortcutBinding): boolean {
    const id = binding.actionId, intent: NativeShortcutIntent = { source: 'keyboard', keystroke: binding.keystroke, direction: binding.direction };
    if (id === 'leader_key') return armLeader();
    clearLeader();
    if (id !== 'abort_run') { clearAbort(); return invoke(id, intent); }
    const action = options.actions()[id];
    if (!available() || options.settingsOpen() || options.blockingOverlay?.() || !action || action.supported === false || action.enabled === false) { clearAbort(); return false; }
    if (abortPrimed) { clearAbort(); return invoke(id, intent); }
    abortPrimed = true; options.onAbortPrimed?.(true);
    abortTimer = setTimeout(() => untracked(clearAbort), 3000);
    return true;
  }
  function dispatchBinding(binding: NativeShortcutBinding): boolean {
    return untracked(() => {
      if (!available() || !routing.resolve(binding, options.scope?.())) return false;
      if (!nativeShortcutActionAdmitted(binding.actionId, { settingsOpen: options.settingsOpen(), settingsAllowedActions: options.settingsAllowedActions?.(), blockingOverlay: options.blockingOverlay?.() })) return false;
      return dispatch(binding);
    });
  }
  effect(() => {
    const enabled = options.enabled(), composing = options.composing?.() === true, capture = options.capture?.();
    const settingsOpen = options.settingsOpen(), settingsAllowedActions = options.settingsAllowedActions?.(), blockingOverlay = options.blockingOverlay?.() === true, chat = options.chatActive?.() !== false;
    const actions = options.actions(), overrides = options.userOverrides?.() ?? state().overrides, ready = options.userOverrides !== undefined || state().ready;
    const menuOwnedActions = options.menuOwnedActions?.(), menuOwnedKeystrokes = options.menuOwnedKeystrokes?.(), scope = options.scope?.();
    untracked(() => { clearLeader(); clearAbort(); });
    const next = routing.replace(!alive || !enabled || composing || !ready || capture ? [] : nativeShortcutBindings({ actions, overrides, apple, settingsOpen, settingsAllowedActions, blockingOverlay, menuOwnedActions, menuOwnedKeystrokes, leaderEnabled: chat && !blockingOverlay }), scope);
    untracked(() => plan.set(next));
    const groups: Record<'auto' | 'always' | 'notEditing', Record<string, () => void>> = { auto: {}, always: {}, notEditing: {} };
    for (const item of next) {
      groups[item.when ?? 'auto'][item.keystroke] = () => { dispatchBinding(item); };
    }
    bind(groups.auto); bind(groups.always, 'always'); bind(groups.notEditing, 'notEditing');
  });
  effect(() => {
    if (!leader()) return;
    const scope = options.scope?.(), overrides = options.userOverrides?.() ?? state().overrides;
    const followups: Readonly<Record<string, string>> = { m: 'open_model_selector', a: 'open_agent_selector', n: 'new_chat', c: 'compact_session' };
    const bindings: Record<string, () => void> = {};
    // Unknown follow-up consumes exactly that key and exits, never types into Input.
    for (const key of nativeShortcutCaptureStrokes(apple)) bindings[key] = () => untracked(() => {
      if (!leader() || options.scope?.() !== scope) return;
      const leaderStroke = nativeShortcutKeystroke(overrides.leader_key ?? 'ctrl+x', apple);
      if (key === leaderStroke) { armLeader(); return; }
      const action = followups[key]; clearLeader();
      if (action && !options.blockingOverlay?.()) {
        // Finish the physical key before a picker mounts/focuses its search field.
        setTimeout(() => untracked(() => { if (alive && options.scope?.() === scope) invoke(action, { source: 'leader', keystroke: key }); }), 0);
      }
    });
    bind(bindings, 'always');
  });
  effect(() => {
    const capture = options.capture?.(), enabled = options.enabled(), composing = options.composing?.() === true, scope = options.scope?.(), settingsOpen = options.settingsOpen();
    const changedScope = capture && capture === lastCapture && scope !== captureScope;
    lastCapture = capture ?? null; captureScope = scope;
    if (!alive || !capture) return;
    if (!enabled || composing || !settingsOpen || changedScope) { untracked(() => capture.onCapture(null)); return; }
    const bindings: Record<string, () => void> = {};
    for (const stroke of nativeShortcutCaptureStrokes(apple)) bindings[stroke] = () => untracked(() => {
      if (!alive || !options.enabled() || options.composing?.() || options.scope?.() !== scope || options.capture?.() !== capture) return;
      capture.onCapture(stroke === 'escape' ? null : shortcutFromNativeKeystroke(stroke, apple));
    });
    bind(bindings, 'always');
  });
  function dispose() {
    if (!alive) return;
    alive = false; unsubscribe(); clearLeader(); clearAbort();
    routing.retire(); plan.set(routing.bindings());
    if (lastCapture && options.capture?.() === lastCapture) lastCapture.onCapture(null);
    for (const remove of [...removers]) remove();
    if (ownsPreferences) preferences.dispose();
  }
  cleanup(dispose);
  return { preferences, dispose,
    /** Stable admitted root plan, excluding menu-owned accelerators and capture.
     * Return its original item to dispatchBinding after validating a native event. */
    bindings: () => alive && available() ? plan() : emptyBindings,
    dispatchBinding,
    userOverrides: () => options.userOverrides?.() ?? state().overrides,
    ready: () => options.userOverrides !== undefined || state().ready,
    /** Native menu callbacks use this same admission path, not raw action.run. */
    execute: (actionId: string) => untracked(() => invoke(actionId, { source: 'menu' })),
  };
}
