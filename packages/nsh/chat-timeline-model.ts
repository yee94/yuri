import type { Message } from './model';
import { nativeMessageEntry } from './transcript-body-model';
import { getFullText } from '../ui/src/components/chat/lib/messagePreview';

/** Same user-role filter, full text-part matching and authoritative order as Web. */
export function nativeTimelineEntries(messages: readonly Message[], search: string) {
  const query = search.trim().toLowerCase();
  return messages.flatMap(message => {
    const entry = nativeMessageEntry(message);
    if (entry.info.role !== 'user') return [];
    const text = getFullText(entry.parts);
    return query && !text.toLowerCase().includes(query) ? [] : [{ id: message.id, message, text, created: message.time?.created }];
  });
}

// Match intlFormatters' timeline options without importing its browser i18n runtime.
export function nativeTimelineDate(timestamp: number, locale: string) {
  return new Date(timestamp).toLocaleDateString(locale, { year: 'numeric', month: 'short', day: 'numeric' });
}
export function nativeTimelineTime(timestamp: number, locale: string) {
  return new Date(timestamp).toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}
