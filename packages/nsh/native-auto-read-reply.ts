import { text } from './model';
import type { NativeBodyRow, nativeBodyPlan } from './transcript-body-model';
import type { NativeAutoReadReply } from './native-auto-read-core';
import { getSortedBodyPartIndex } from '../ui/src/components/chat/lib/turns/assistantMessageLifecycle';

/** Feed the very plan rendered by this body; never reconstruct a reply from message.text. */
export function nativeAutoReadBody(input: {
  scope: string; sessionID: string; row: NativeBodyRow; plan: ReturnType<typeof nativeBodyPlan>;
  streaming: boolean; mode: string;
}): { reply: NativeAutoReadReply; streaming: boolean; completed: boolean } {
  const message = input.row.tail;
  const parts = [...input.plan.activity, ...input.plan.inline].flatMap(node => node.kind === 'part' ? [node.part] : node.parts).filter(part => part.messageID === message.id);
  const excluded = message.role !== 'assistant' || !!message.error || input.plan.compaction || message.cards.some(card => card.type === 'compaction') || (message.content ?? []).some(part => part.type === 'compaction');
  let source = '';
  if (!excluded) {
    if (input.mode === 'final') {
      const index = getSortedBodyPartIndex(parts.map(part => part.projection));
      const body = index < 0 ? undefined : parts[index];
      if (body && input.plan.inline.some(node => node.kind === 'part' && node.part.key === body.key)) source = text(body.source.text);
    } else source = parts.filter(part => part.source.type === 'text').map(part => text(part.source.text)).join('\n\n');
  }
  return {
    reply: { scope: input.scope, sessionID: input.sessionID, messageID: message.id, created: message.time?.created ?? 0, text: source },
    streaming: !excluded && input.streaming,
    completed: !excluded && !input.streaming && message.time?.completed != null,
  };
}
