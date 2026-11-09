import type { NativeShortcutActions, NativeShortcutBinding } from './desktop-shortcuts-core';

/** Terminal is a separate owner, never registered as a composer. Root alone binds keys. */
export interface NativeDesktopTerminalShortcutOwner {
  current(): boolean;
  focused(): boolean;
  composing(): boolean;
  focus(): void;
  /** Child WebView keys are routed only through this exact root-computed list. */
  setKeyboardRouting(bindings: readonly NativeShortcutBinding[], dispatch: (binding: NativeShortcutBinding) => void): void;
  readonly actions: NativeShortcutActions;
}
export type NativeDesktopTerminalShortcutPublisher = (event: {
  type: 'register' | 'retire'; owner: NativeDesktopTerminalShortcutOwner;
}) => void;

export function createNativeDesktopTerminalShortcutOwner(options: {
  current(): boolean; ready(): boolean; focused(): boolean; composing(): boolean;
  focus(): void; create(): void; cycle(direction: -1 | 1): void; expand(): void;
  configure?: (bindings: readonly NativeShortcutBinding[]) => void;
}) {
  let alive = true;
  let bindings: readonly NativeShortcutBinding[] = [], dispatch: ((binding: NativeShortcutBinding) => void) | undefined;
  const current = () => alive && options.current();
  const admitted = (focused = false) => current() && options.ready() && !options.composing() && (!focused || options.focused());
  const action = (run: () => void, focused = false, ready = true) => {
    const enabled = () => ready ? admitted(focused) : current() && !options.composing();
    return { when: 'always' as const, priority: 60, get enabled() { return enabled(); }, run() { if (enabled()) run(); } };
  };
  const owner: NativeDesktopTerminalShortcutOwner = {
    current, focused: () => current() && options.focused(), composing: () => current() && options.composing(),
    focus() { if (admitted()) options.focus(); },
    setKeyboardRouting(next, callback) { if (!alive) return; bindings = [...next]; dispatch = callback; options.configure?.(bindings); },
    actions: {
      toggle_terminal_expanded: action(options.expand, false, false),
      new_terminal_tab: action(options.create, true),
      previous_terminal_tab: action(() => options.cycle(-1), true),
      next_terminal_tab: action(() => options.cycle(1), true),
    },
  };
  return { owner, dispatch(actionId: string, keystroke: string) {
    if (!admitted()) return;
    const binding = bindings.find(binding => binding.actionId === actionId && binding.keystroke === keystroke);
    if (binding) dispatch?.(binding);
  }, retire() { alive = false; bindings = []; dispatch = undefined; options.configure?.([]); } };
}
