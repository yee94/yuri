import React from 'react';
import type { AssistantContactSessionCardPart } from '@/queries/assistantDTO';

type AssistantCardTarget =
  | { assistantID: string }
  | { sessionId: string; directory: string; target?: AssistantContactSessionCardPart['target'] }
  | { projectID: string; taskID: string };

export const AssistantCardNavigation = React.createContext<((target: AssistantCardTarget) => void) | null>(null);
