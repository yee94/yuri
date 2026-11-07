import { messageFrom, record, type Message, type Row } from './model';
import { mergeTranscriptOrder } from '../ui/src/sync/transcript-order';

/** A slim summary may update metadata, but must not erase a previously exact-filled settled body. */
function retainFullActivity(previous: Message | undefined, incoming: Message): Message {
  if (!previous?.content?.length || !incoming.content?.some(part => part.slim === true)) return incoming;
  const key = (part: Row, index: number) => String(part.id || `${part.type}:${part.ordinal ?? index}`);
  const known = new Map(previous.content.map((part, index) => [key(part, index), part]));
  let changed = false;
  const content = incoming.content.map((part, index) => {
    const old = known.get(key(part, index));
    if (part.slim !== true || !old || old.slim === true || old.type !== part.type) return part;
    const nextState = record(part.state), oldState = record(old.state);
    if (JSON.stringify(part.time ?? nextState.time) !== JSON.stringify(old.time ?? oldState.time)) return part;
    if (part.type === 'tool' && (nextState.status !== oldState.status || !['completed', 'error'].includes(String(nextState.status)))) return part;
    const { slim: _slim, ...summary } = part;
    changed = true;
    return { ...old, ...summary, ...(part.type === 'tool' ? { state: { ...oldState, ...nextState,
      ...('input' in oldState ? { input: oldState.input } : {}),
      ...(oldState.metadata || nextState.metadata ? { metadata: { ...record(oldState.metadata), ...record(nextState.metadata) } } : {}),
    } } : {}) };
  });
  if (!changed) return incoming;
  const externalFiles = incoming.files.filter(file => !incoming.content!.includes(file));
  const parsed = messageFrom({ id: incoming.id, type: incoming.role, content, files: externalFiles })!;
  return { ...incoming, content: parsed.content, text: incoming.text || parsed.text, reasoning: parsed.reasoning, tools: parsed.tools, cards: parsed.cards, files: parsed.files };
}

/** Reconcile identity independently of order; a no-op read publishes nothing new. */
export function stableHistoryMessages(previous: Message[], incoming: Message[]): Message[] {
  const known = new Map(previous.map(message => [message.id, message]));
  const seen = new Set<string>();
  const next: Message[] = [];
  for (const message of incoming) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    const old = known.get(message.id), full = retainFullActivity(old, message);
    next.push(old && (old === full || JSON.stringify(old) === JSON.stringify(full)) ? old : full);
  }
  return next.length === previous.length && next.every((message, index) => message === previous[index]) ? previous : next;
}

/** Page order is authority. Disjoint pages need an explicit older/newer placement. */
export function mergeHistoryMessages(previous: Message[], incoming: Message[], older = false): Message[] {
  if (!incoming.length) return previous;
  const known = new Map(previous.map(message => [message.id, message]));
  const overlap = incoming.some(message => known.has(message.id));
  const order = overlap
    ? mergeTranscriptOrder(previous.map(message => message.id), incoming.map(message => message.id))
    : (older ? [...incoming, ...previous] : [...previous, ...incoming]).map(message => message.id);
  for (const message of incoming) if (!older || !known.has(message.id)) known.set(message.id, message);
  return stableHistoryMessages(previous, order.map(id => known.get(id)!));
}
