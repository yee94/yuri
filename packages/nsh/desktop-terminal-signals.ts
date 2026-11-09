import { signal } from 'nsh';
import type { DesktopTerminalState } from './desktop-terminal-core';

/** Root shortcut consumers never subscribe to presentation/receipt revisions. */
export function createDesktopTerminalSignals() {
  let previous: DesktopTerminalState = { phase: 'idle', generation: 0 };
  const state = signal(previous), focused = signal(false), composing = signal(false), ready = signal(false), generation = signal(0);
  return { state, focused, composing, ready, generation,
    changed(next: DesktopTerminalState) {
      // Compare plain fields before setting: even reading a signal here could
      // accidentally subscribe an external producer to the root's plan.
      if (!!next.focused !== !!previous.focused) focused.set(!!next.focused);
      if (!!next.composing !== !!previous.composing) composing.set(!!next.composing);
      if ((next.phase === 'ready') !== (previous.phase === 'ready')) ready.set(next.phase === 'ready');
      if (next.generation !== previous.generation) generation.set(next.generation);
      previous = next;
      state.set(next);
    },
  };
}
