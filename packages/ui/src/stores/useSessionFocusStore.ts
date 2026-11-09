import { create } from 'zustand';

import type { SessionFocusIdentity } from '../sync/session-navigation-core';
export type { SessionFocusIdentity, SessionFocusScope } from '../sync/session-navigation-core';

type SessionFocusState = {
  focus: SessionFocusIdentity | null;
  setFocus: (focus: SessionFocusIdentity | null) => void;
};

export const isSessionFocusEqual = (
  left: SessionFocusIdentity | null,
  right: SessionFocusIdentity | null,
): boolean => {
  if (left === right) return true;
  if (!left || !right) return false;
  return left.scope === right.scope
    && left.sessionId === right.sessionId
    && left.projectId === right.projectId;
};

export const getSessionFocusKey = (focus: SessionFocusIdentity | null): string | null => {
  if (!focus) return null;
  return `${focus.scope}:${focus.projectId ?? ''}:${focus.sessionId}`;
};

export const createDefaultProjectSessionFocus = (sessionId: string): SessionFocusIdentity => ({
  scope: 'project',
  sessionId,
  projectId: null,
});

export const useSessionFocusStore = create<SessionFocusState>()((set) => ({
  focus: null,
  setFocus: (focus) => set((state) => (
    isSessionFocusEqual(state.focus, focus) ? state : { focus }
  )),
}));
