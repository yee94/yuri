import { text, type Message } from './model';

export type NativeTimelineRow = { id: string; message: Message; fullText: string; preview: string; snippet: string | null; created?: number; index: number; previousCreated?: number };

/** Matches TimelineDialog: user-only, all text parts joined in source order, 80-character preview. */
export function nativeTimelineRows(messages: readonly Message[], rawQuery: string): NativeTimelineRow[] {
  const query = rawQuery.trim().toLowerCase();
  return messages.filter(message => message.role === 'user').flatMap(message => {
    const fullText = message.content?.length ? message.content.filter(part => part.type === 'text' && typeof part.text === 'string').map(part => text(part.text)).join('\n') : message.text;
    if (query && !fullText.toLowerCase().includes(query)) return [];
    const line = fullText.replace(/\n/g, ' '), preview = line.length > 80 ? `${line.slice(0, 80)}…` : line;
    const match = query ? fullText.toLowerCase().indexOf(rawQuery.toLowerCase()) : -1;
    const start = Math.max(0, match - 30), end = Math.min(fullText.length, match + rawQuery.length + 30);
    const snippet = match < 0 ? null : `${start ? '…' : ''}${fullText.slice(start, end).replace(/\n/g, ' ')}${end < fullText.length ? '…' : ''}`;
    return [{ id: message.id, message, fullText, preview, snippet, created: message.time?.created }];
  }).map((row, index, rows) => ({ ...row, index, previousCreated: rows[index - 1]?.created }));
}
