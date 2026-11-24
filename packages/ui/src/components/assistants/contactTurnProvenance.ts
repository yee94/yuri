import type { AssistantActiveContactTurn, AssistantContactMessage } from '@/queries/assistantDTO';

const REPLY_EXCERPT_MAX_CHARS = 48;

interface LateReplyOrigin {
  turnID: string;
  messageID: string;
  excerpt: string;
  hasText: boolean;
}

export const compactReplyExcerpt = (text: string, maxChars = REPLY_EXCERPT_MAX_CHARS): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars - 1)}…`;
};

const isBackgroundNotificationTurn = (message: Pick<AssistantContactMessage, 'assistantID' | 'turnID'>): boolean => (
  message.turnID.startsWith(`scheduled_${message.assistantID}_`)
  || message.turnID.startsWith(`resume_${message.assistantID}_`)
);

/**
 * Returns turn IDs that are genuinely waiting behind an earlier active turn.
 * A sole queued turn at the head of an otherwise idle lane is about to start
 * immediately, so it is not marked queued.
 */
export const getQueuedContactTurnIDs = (
  activeContactTurns?: readonly AssistantActiveContactTurn[] | null,
  activeContactTurn?: AssistantActiveContactTurn | null,
): ReadonlySet<string> => {
  if (!Array.isArray(activeContactTurns) || activeContactTurns.length <= 1) {
    return new Set();
  }
  const headTurnID = activeContactTurn?.turnID ?? activeContactTurns[0]?.turnID ?? null;
  const queued = new Set<string>();
  for (const turn of activeContactTurns) {
    if (turn.status !== 'queued') continue;
    if (headTurnID && turn.turnID === headTurnID) continue;
    queued.add(turn.turnID);
  }
  return queued;
};

/**
 * Identifies when an assistant reply appears below newer user messages and
 * therefore belongs to an earlier user turn. Returns null for normal adjacent
 * replies and background notifications.
 */
export const findLateReplyOrigin = (
  transcript: readonly AssistantContactMessage[],
  messageIndex: number,
): LateReplyOrigin | null => {
  const message = transcript[messageIndex];
  if (!message || message.role !== 'assistant' || message.status === 'error') return null;
  if (!message.turnID || isBackgroundNotificationTurn(message)) return null;

  let nearestUser: AssistantContactMessage | null = null;
  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const candidate = transcript[index];
    if (candidate.role === 'user') {
      nearestUser = candidate;
      break;
    }
  }
  if (!nearestUser || nearestUser.turnID === message.turnID) return null;

  for (let index = messageIndex - 1; index >= 0; index -= 1) {
    const candidate = transcript[index];
    if (candidate.role === 'user' && candidate.turnID === message.turnID) {
      const excerpt = compactReplyExcerpt(candidate.text);
      return {
        turnID: candidate.turnID,
        messageID: candidate.messageID,
        excerpt,
        hasText: excerpt.length > 0,
      };
    }
  }
  return null;
};
