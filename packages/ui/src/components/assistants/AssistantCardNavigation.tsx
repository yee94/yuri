import React from 'react';

type AssistantCardTarget =
  | { assistantID: string }
  | { sessionId: string; directory: string }
  | { projectID: string; taskID: string };

export const AssistantCardNavigation = React.createContext<((target: AssistantCardTarget) => void) | null>(null);
