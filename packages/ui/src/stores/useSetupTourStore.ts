import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createInstanceScopedJSONStorage } from '@/lib/instanceScopedStorage';
import { isRuntimeInstanceChange, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

export type SetupTourStep = 0 | 1 | 2;
type SetupTourProgress = { step: SetupTourStep; dismissed: boolean };
type SetupTourStore = {
  progress: Record<string, SetupTourProgress>;
  openedRuntime: string | null;
  open: (runtime: string) => void;
  move: (runtime: string, step: SetupTourStep) => void;
  dismiss: (runtime: string) => void;
};

export const useSetupTourStore = create<SetupTourStore>()(persist((set) => ({
  progress: {},
  openedRuntime: null,
  open: (runtime) => set((state) => ({
    openedRuntime: runtime,
    progress: { ...state.progress, [runtime]: state.progress[runtime] ?? { step: 0, dismissed: false } },
  })),
  move: (runtime, step) => set((state) => ({
    progress: { ...state.progress, [runtime]: { step, dismissed: state.progress[runtime]?.dismissed ?? false } },
  })),
  dismiss: (runtime) => set((state) => ({
    openedRuntime: state.openedRuntime === runtime ? null : state.openedRuntime,
    progress: { ...state.progress, [runtime]: { step: state.progress[runtime]?.step ?? 0, dismissed: true } },
  })),
}), {
  name: 'yuri-setup-tour',
  storage: createInstanceScopedJSONStorage(),
  partialize: (state) => ({ progress: state.progress }),
  merge: (persisted, current) => {
    const value = persisted as { progress?: unknown } | undefined;
    const progress: Record<string, SetupTourProgress> = {};
    if (value?.progress && typeof value.progress === 'object') {
      for (const [runtime, entry] of Object.entries(value.progress)) {
        if (entry && [0, 1, 2].includes(entry.step) && typeof entry.dismissed === 'boolean') {
          progress[runtime] = { step: entry.step, dismissed: entry.dismissed };
        }
      }
    }
    return { ...current, progress, openedRuntime: null };
  },
}));

subscribeRuntimeEndpointChanged((detail) => {
  if (isRuntimeInstanceChange(detail)) void useSetupTourStore.persist.rehydrate();
});
