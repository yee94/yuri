import type { AssistantDTO } from '../../queries/assistantDTO';

/** Newest visible message first; read state and configuration never rank contacts. */
export function sortAssistantContacts<T extends Pick<AssistantDTO, 'latestMessagePreview'> & { unreadCount?: number }>(contacts: readonly T[]): T[] {
  return [...contacts].sort((a, b) => {
    const left = a.latestMessagePreview?.createdAt ?? Number.NEGATIVE_INFINITY;
    const right = b.latestMessagePreview?.createdAt ?? Number.NEGATIVE_INFINITY;
    return left === right ? 0 : right - left;
  });
}

/** The single pinned contact is independent of recency; legacy multiple pins keep the latest. */
export function partitionAssistantContacts<T extends Pick<AssistantDTO, 'latestMessagePreview' | 'pinnedAt'>>(contacts: readonly T[]) {
  let pinned: T | undefined;
  for (const contact of contacts) {
    if (contact.pinnedAt != null && (!pinned || contact.pinnedAt > pinned.pinnedAt!)) pinned = contact;
  }
  return { pinned: pinned ? [pinned] : [], unpinned: sortAssistantContacts(contacts.filter(contact => contact !== pinned)) };
}
