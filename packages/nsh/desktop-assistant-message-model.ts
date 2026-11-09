import { createContactTimeFormatter, getContactTimeSeparators } from '../ui/src/components/assistants/contactMessageTime';
import type { AssistantContactMessage } from '../ui/src/queries/assistantDTO';
import { text, type ContactMessageMetadata, type Message, type Row } from './model';

export type DesktopContactMessageRow = {
  message: Message;
  kind: ContactMessageMetadata['kind'];
  alignment: 'left' | 'right';
  showAvatar: boolean;
  sameAssistantRun: boolean;
  startsTurn: boolean;
  separatorTimestamp?: number;
  separatorLabel?: string;
  errorRow: boolean;
  visible: boolean;
};

const internalText = (value: string) => value.trim().startsWith('yuri.settle.') || value.trim().startsWith('oc.settle.');
const errorRow = (message: Message) => message.contact?.status === 'error'
  || message.contact?.status === 'failed' && message.id.endsWith(':preview:failed');
const partsOf = (message: Message): Row[] => message.content?.length ? message.content : [
  ...(message.text ? [{ type: 'text', text: message.text }] : []), ...message.cards, ...message.files,
];

/** Read-only presentation for the existing List; never groups or rewrites message bodies. */
export function desktopContactMessageRows(messages: readonly Message[], options: { locale: string; todayLabel: string; now: Date }): DesktopContactMessageRow[] {
  const candidates = messages.filter(message => message.contact && !(message.contact.status === 'admitted' && message.id.endsWith(':preview:admitted'))
    && (!partsOf(message).length || partsOf(message).some(part => part.type !== 'text' || !internalText(text(part.text)))));
  let latest = candidates.length - 1;
  while (latest >= 0 && errorRow(candidates[latest]!)) latest--;
  const transcript = candidates.filter((message, index) => !errorRow(message) || index > latest);
  // Only type/text are inspected by the shared time helper. All original wire parts
  // remain on Message; Session tools/reasoning do not enter this contact-only view.
  const clockMessages: AssistantContactMessage[] = transcript.map(message => ({
    messageID: message.id, assistantID: message.contact!.assistantID ?? '', role: message.contact!.kind,
    turnID: message.contact!.turnID ?? '', bubbleIndex: message.contact!.bubbleIndex ?? 0,
    createdAt: message.contact!.createdAt ?? NaN, ordinal: message.ordinal ?? 0, status: message.contact!.status ?? '',
    fromAssistantID: message.contact!.fromAssistantID ?? null, fromAssistantName: message.contact!.fromAssistantName ?? null,
    parts: partsOf(message).map(part => part.type === 'text' ? { ...part, type: 'text', text: text(part.text) } : part) as AssistantContactMessage['parts'], text: message.text, cards: [],
  }));
  const separators = getContactTimeSeparators(clockMessages);
  const format = createContactTimeFormatter(options.locale, options.todayLabel, options.now);
  const visible = new Set(transcript);
  const previous = new Map(transcript.map((message, index) => [message, transcript[index - 1]]));
  return messages.flatMap(message => {
    const contact = message.contact;
    if (!contact) return [];
    const before = previous.get(message)?.contact;
    const separatorTimestamp = separators.get(message.id);
    const sameAssistantRun = contact.kind === 'assistant' && separatorTimestamp === undefined
      && contact.turnID !== undefined && before?.kind === 'assistant' && before.turnID === contact.turnID;
    return [{
      message, kind: contact.kind, alignment: contact.kind === 'user' ? 'right' : 'left',
      showAvatar: visible.has(message) && !errorRow(message) && contact.kind !== 'user' && (contact.kind === 'peer' || !sameAssistantRun),
      sameAssistantRun, startsTurn: before?.turnID !== contact.turnID,
      ...(separatorTimestamp === undefined ? {} : { separatorTimestamp, separatorLabel: format(separatorTimestamp) }),
      errorRow: errorRow(message), visible: visible.has(message),
    }];
  });
}
