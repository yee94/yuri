import { expect, test } from 'vitest';
import { partitionAssistantContacts, sortAssistantContacts } from './sortAssistantContacts';
const contact = (id: string, createdAt?: number) => ({ id, unreadCount: 0, updatedAt: 0, latestMessagePreview: createdAt === undefined ? null : { createdAt, messageID: id, ordinal: 1, role: 'user' as const, text: id, fallbackKind: null } });
test('latest interaction leads regardless of unread state, marking read, or config changes', () => {
  const input = [{ ...contact('old', 10), unreadCount: 99, updatedAt: 999 }, contact('new', 20)];
  expect(sortAssistantContacts(input).map(item => item.id)).toEqual(['new', 'old']);
  const read = input.map(item => ({ ...item, unreadCount: 0, updatedAt: 1000 }));
  expect(sortAssistantContacts(read).map(item => item.id)).toEqual(['new', 'old']);
  expect(input.map(item => item.id)).toEqual(['old', 'new']);
});
test('a newly sent message leads older unread messages', () => {
  const input = [contact('read-old', 10), { ...contact('many-unread', 20), unreadCount: 99 },
    { ...contact('recent-unread', 30), unreadCount: 1 }, contact('sent-now', 40)];
  expect(sortAssistantContacts(input).map(item => item.id)).toEqual(['sent-now', 'recent-unread', 'many-unread', 'read-old']);
});
test('a new incoming message moves its contact first and reading it preserves that order', () => {
  const input = [contact('sent', 40), { ...contact('received', 50), unreadCount: 1 }];
  expect(sortAssistantContacts(input).map(item => item.id)).toEqual(['received', 'sent']);
  expect(sortAssistantContacts(input.map(item => ({ ...item, unreadCount: 0 }))).map(item => item.id)).toEqual(['received', 'sent']);
});
test('equal timestamps retain input order and empty or legacy histories remain at the bottom', () => {
  const input = [contact('empty'), contact('first', 20), contact('second', 20), contact('legacy')];
  expect(sortAssistantContacts(input).map(item => item.id)).toEqual(['first', 'second', 'empty', 'legacy']);
});

test('only the latest pin gets the large avatar, with stable source order on legacy ties', () => {
  const input = [
    { ...contact('late-pin', 100), pinnedAt: 20 },
    contact('recent', 200),
    { ...contact('first-pin', 10), pinnedAt: 0 },
    { ...contact('old', 20), pinnedAt: null },
    { ...contact('same-time', 300), pinnedAt: 20 },
  ];
  const groups = partitionAssistantContacts(input);
  expect(groups.pinned.map(item => item.id)).toEqual(['late-pin']);
  expect(groups.unpinned.map(item => item.id)).toEqual(['same-time', 'recent', 'old', 'first-pin']);
  expect(new Set([...groups.pinned, ...groups.unpinned]).size).toBe(input.length);
  expect(input.map(item => item.id)).toEqual(['late-pin', 'recent', 'first-pin', 'old', 'same-time']);
  const unpinned = partitionAssistantContacts(input.map(item => ({ ...item, pinnedAt: null })));
  expect(unpinned.pinned).toEqual([]);
  expect(unpinned.unpinned.map(item => item.id)).toEqual(['same-time', 'recent', 'late-pin', 'old', 'first-pin']);
});
