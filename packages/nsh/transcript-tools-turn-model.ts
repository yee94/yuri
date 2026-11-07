import type { Message } from './model';
import { computeAssistantTps, formatAssistantTps } from '../ui/src/components/chat/message/assistantTps';
import { formatTurnDuration } from '../ui/src/components/chat/message/turnDurationFormat';
import { nativeBodyRows, nativeMessageEntry, nativeMessageRole, nativeRowTurns, type NativeBodyRow } from './transcript-body-model';
import { resolveTurnSettledForPresentation } from '../ui/src/components/chat/lib/activityExpansion';
import { isUserShellMessage } from '../ui/src/components/chat/lib/shellBridge';
import { readUserMessageHeaderIdentity, resolveAssistantHeaderModel, shouldShowPendingAssistantHeader } from '../ui/src/components/chat/lib/pendingAssistantHeader';
import { normalizeUserDisplayParts } from '../ui/src/components/chat/message/normalizeUserDisplayParts';
import { getProviderModelDisplayName, type DisplayProvider } from '../ui/src/lib/modelDisplay';
import { resolveAssistantErrorPresentation } from '../ui/src/components/chat/message/assistantErrorPresentation';
import { isAssistantMessageCompleted } from '../ui/src/components/chat/lib/visibleSortedAssistants';
import { hasVisibleText } from '../ui/src/components/chat/message/partUtils';

export type NativeTurnPresentation = { header: boolean; footer: boolean; tps: string; duration: string };

/** Sequence is authoritative. Never consult mutable composer/session selections. */
export function nativeTurnPresentation(messages: readonly Message[], live = false, rows = nativeBodyRows(messages)): Map<string, NativeTurnPresentation> {
  const result = new Map<string, NativeTurnPresentation>();
  const turns = nativeRowTurns(rows);
  for (const [index, turn] of turns.entries()) {
    const assistants = turn.assistantMessages, last = assistants.at(-1);
    if (!last) continue;
    const settled = resolveTurnSettledForPresentation({ completionDisposition: turn.completionDisposition, isLastTurn: index === turns.length - 1, sessionIsWorking: live, hasConfirmedSettledAssistant: turn.hasConfirmedFinalBody });
    const duration = settled && turn.durationMs !== undefined ? formatTurnDuration(turn.durationMs) : '';
    const rate = settled ? computeAssistantTps(assistants.map(({ info }) => ({ createdAt: info.time?.created, streamedAt: info.time?.streamed, outputTokens: info.tokens?.output, reasoningTokens: info.tokens?.reasoning }))) : null;
    const error = resolveAssistantErrorPresentation(last.info.error, key => key);
    const footer = settled && error?.variant !== 'error' && (last.parts.some(part => part.type === 'text' && hasVisibleText(part.text)) || !!last.info.error || isAssistantMessageCompleted(last));
    assistants.forEach((message, at) => result.set(message.info.id, { header: at === 0 && !(turn.userMessage && isUserShellMessage(turn.userMessage)), footer: message === last && footer, tps: message === last && rate ? formatAssistantTps(rate) : '', duration: message === last ? duration : '' }));
  }
  return result;
}

export type NativeHeaderFallback = { active?: boolean; composer?: { providerId?: string; modelId?: string }; session?: { providerId?: string; modelId?: string }; agent?: string };
export function nativeTurnModelName(message: Message, providers: readonly (DisplayProvider & { id?: unknown })[]) {
  return getProviderModelDisplayName(providers.find(provider => provider?.id === message.providerID), message.modelID);
}
export function nativeUserActionsVisible(row: NativeBodyRow) {
  return nativeMessageRole(row.head) === 'user' && nativeMessageEntry(row.head).info.nativeType !== 'synthetic' && normalizeUserDisplayParts(nativeMessageEntry(row.head).parts).length > 0;
}
export function nativeTurnErrorPresentation(row: NativeBodyRow, translate: Parameters<typeof resolveAssistantErrorPresentation>[1]) {
  if (nativeMessageRole(row.tail) !== 'assistant') return undefined;
  const last = row.turn?.assistantMessageIds.at(-1);
  if (last && row.tail.id !== last) return undefined;
  return resolveAssistantErrorPresentation(nativeMessageEntry(row.tail).info.error, translate);
}
export function nativePendingHeader(row: NativeBodyRow, live: boolean, hasStreaming: boolean) {
  const turn = row.turn;
  return !!turn?.userMessage && row.head.id === turn.userMessageId && !isUserShellMessage(turn.userMessage) && shouldShowPendingAssistantHeader({
    isLastTurn: row.isLastTurn, sessionIsWorking: live, hasAssistantMessages: turn.assistantMessages.length > 0,
    activityPresentationKind: turn.activityPresentationKind, hasActiveStreamingMessage: hasStreaming,
  });
}
/** A shown pending header survives status gaps until its assistant takes ownership. */
export function createNativePendingHeaders() {
  let shown = new Set<string>();
  return (rows: readonly NativeBodyRow[], live: boolean, hasStreaming: boolean): ReadonlySet<string> => {
    const next = new Set<string>();
    for (const row of rows) {
      const turn = row.turn;
      if (!turn?.userMessage || turn.assistantMessages.length || turn.activityPresentationKind !== 'default' || row.head.id !== turn.userMessageId || isUserShellMessage(turn.userMessage)) continue;
      if (shown.has(row.head.id) || nativePendingHeader(row, live, hasStreaming)) next.add(row.head.id);
    }
    shown = next;
    return next;
  };
}
export function nativeTurnHeaderMessage(row: NativeBodyRow, fallback: NativeHeaderFallback = {}): Message {
  const assistant = row.turn?.assistantMessages[0];
  const userIdentity = row.turn?.userMessage ? readUserMessageHeaderIdentity(row.turn.userMessage.info) : null;
  const assistantIdentity = assistant ? readUserMessageHeaderIdentity(assistant.info) : null;
  const model = resolveAssistantHeaderModel({ assistantIdentity, userIdentity, composerSelection: fallback.composer ?? null,
    sessionSelection: fallback.session ?? null, allowComposerFallback: !assistant || fallback.active === true });
  return { ...row.head, modelID: model?.modelId, providerID: model?.providerId,
    agent: assistantIdentity?.agentName ?? userIdentity?.agentName ?? (assistant && fallback.active ? fallback.agent : undefined),
    variant: assistantIdentity?.variant ?? userIdentity?.variant };
}
