import { create } from 'zustand';

const toRemovalKey = (directory: string): string => {
  const replaced = directory.replace(/\\/g, '/');
  return replaced.length > 1 ? replaced.replace(/\/+$/, '') : replaced;
};

type WorktreeRemovalStore = {
  removing: ReadonlySet<string>;
};

const useWorktreeRemovalStore = create<WorktreeRemovalStore>(() => ({ removing: new Set() }));

export const beginWorktreeRemoval = (directory: string): void => {
  const key = toRemovalKey(directory);
  useWorktreeRemovalStore.setState((state) => {
    if (state.removing.has(key)) return state;
    return { removing: new Set(state.removing).add(key) };
  });
};

export const endWorktreeRemoval = (directory: string): void => {
  const key = toRemovalKey(directory);
  useWorktreeRemovalStore.setState((state) => {
    if (!state.removing.has(key)) return state;
    const next = new Set(state.removing);
    next.delete(key);
    return { removing: next };
  });
};

export const useIsWorktreeRemoving = (directory: string | null | undefined): boolean =>
  useWorktreeRemovalStore((state) => (directory ? state.removing.has(toRemovalKey(directory)) : false));
