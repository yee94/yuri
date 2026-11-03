import { create } from 'zustand';

// Transient UI flag for run-as-goal flows (fork dialog, plan send), including
// session drafts. After confirmed native command delivery, sendMessage consumes
// the flag. Rejected delivery leaves it available for retry. The sent prompt
// becomes the objective unless the arming flow supplied a richer objective
// override (e.g. the plan content instead of "Implement this plan: X").
interface SessionGoalArmStore {
  armed: boolean;
  objectiveOverride: string | null;
  setArmed: (armed: boolean, objectiveOverride?: string | null) => void;
  /** Read-and-clear after confirmed native command delivery, or explicit cancel. */
  consume: () => { armed: boolean; objectiveOverride: string | null };
}

export const useSessionGoalArmStore = create<SessionGoalArmStore>((set, get) => ({
  armed: false,
  objectiveOverride: null,
  setArmed: (armed, objectiveOverride = null) => set({
    armed,
    objectiveOverride: armed ? objectiveOverride : null,
  }),
  consume: () => {
    const { armed, objectiveOverride } = get();
    if (armed) set({ armed: false, objectiveOverride: null });
    return { armed, objectiveOverride };
  },
}));
