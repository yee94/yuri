import React from 'react';
import { useStore } from 'zustand';
import { createStore } from 'zustand/vanilla';

// Owned by one SessionSidebar instance. Rows read their own Mod+1…9 slot by
// Focus key, so a renumbering (a turn ending, a row moving above) re-renders
// only the rows whose slot changed, never the sections and groups above them.
export const createSidebarShortcutNumberStore = (numbers: ReadonlyMap<string, number>) => (
  createStore<{ numbers: ReadonlyMap<string, number> }>(() => ({ numbers }))
);

type SidebarShortcutNumberStore = ReturnType<typeof createSidebarShortcutNumberStore>;

export const SidebarShortcutNumberContext = React.createContext<SidebarShortcutNumberStore | null>(null);

const EMPTY_SHORTCUT_NUMBER_STORE = createSidebarShortcutNumberStore(new Map());

export function useSidebarShortcutNumber(focusKey: string): number | null {
  const store = React.useContext(SidebarShortcutNumberContext) ?? EMPTY_SHORTCUT_NUMBER_STORE;
  return useStore(store, (state) => (focusKey ? state.numbers.get(focusKey) ?? null : null));
}
