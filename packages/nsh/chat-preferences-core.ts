import { cleanReasoningText } from '../ui/src/components/chat/message/parts/reasoningPresentation';

/** Unknown snapshots do not opt into an optional metric; duration remains independent. */
export function nativeAssistantTps(tps: string | undefined, enabled: boolean | null | undefined): string | undefined {
  return enabled === true ? tps : undefined;
}

/** MessageBody bypasses Thought chrome only inline; ProgressiveGroup retains its own Thought blocks. */
export function nativeReasoningPresentation(source: string, collapsible: boolean | null | undefined, inActivity: boolean) {
  const fold = inActivity || collapsible !== false;
  return { collapsible: fold, content: fold ? cleanReasoningText(source) : source };
}
