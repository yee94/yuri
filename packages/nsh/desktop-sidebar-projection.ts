import { sortAssistantContacts } from '../ui/src/components/assistants/sortAssistantContacts';
import type { AssistantDTO } from '../ui/src/queries/assistantDTO';
import { normalizeDirectoryKey } from '../ui/src/lib/pathNormalization';

export type DesktopSidebarContact = Pick<AssistantDTO, 'id' | 'enabled' | 'avatarSeed' | 'latestMessagePreview' | 'working' | 'activeContactTurn' | 'unreadCount'>;
export type DesktopSidebarSessionState = Readonly<{
  hasChildren?: boolean;
  /** Own execution, never the descendant/shell aggregate. */
  running?: boolean;
  /** Same live tree/shell projection as Web useSessionActivity. */
  navigationRunning?: boolean;
  unreadCount?: number;
}>;
/** Read-only projection from existing owners. Scope is desktopSidebarScope(connection, epoch).
 * Missing fields are unknown; this port never starts a catalog, timer or socket. */
export type DesktopSidebarAuthority = Readonly<{
  scope: string;
  assistants?: Readonly<{ enabled: boolean; contacts: readonly DesktopSidebarContact[] }>;
  schedules?: readonly Readonly<{ task: Readonly<{ lastStatus?: string }> }>[];
  sessions?: ReadonlyMap<string, DesktopSidebarSessionState>;
}>;
export const desktopSidebarSessionStateKey = (row: { id: string; directory: string }) => JSON.stringify([normalizeDirectoryKey(row.directory), row.id]);
export function desktopSidebarNavigationStatus(source: DesktopSidebarAuthority | null | undefined, scope: string) {
  if (!source || source.scope !== scope) return null;
  const contacts = source.assistants?.enabled ? source.assistants.contacts.filter(contact => contact.enabled) : [];
  const avatar = sortAssistantContacts(contacts)[0];
  return {
    avatar: avatar ? { id: avatar.id, avatarSeed: avatar.avatarSeed ?? avatar.id } : null,
    assistantRunning: contacts.some(contact => contact.working || !!contact.activeContactTurn),
    assistantUnread: contacts.reduce((count, contact) => count + (Number.isSafeInteger(contact.unreadCount) && Number(contact.unreadCount) > 0 ? Number(contact.unreadCount) : 0), 0),
    scheduleRunning: source.schedules?.some(item => item.task.lastStatus === 'running') ?? false,
  };
}

/** O(rows + parent edges), one shared projection. Only live IDs can promote an ancestor. */
export function desktopSidebarRunning(rows: readonly { id: string; parentID?: string; directory: string }[], own: ReadonlySet<string>, source: DesktopSidebarAuthority | null | undefined, scope: string) {
  const parents = new Map(rows.map(row => [row.id, row.parentID]));
  const live = new Set(own);
  if (source?.scope === scope) for (const row of rows) {
    const state = source.sessions?.get(desktopSidebarSessionStateKey(row));
    if (state?.running === false) live.delete(row.id);
    if (state?.running || state?.navigationRunning) live.add(row.id);
  }
  const result = new Set(live);
  const walked = new Set<string>();
  for (const id of live) {
    let cursor: string | undefined = id;
    while (cursor && !walked.has(cursor)) { walked.add(cursor); result.add(cursor); cursor = parents.get(cursor); }
  }
  return result;
}

/** Mirrors Web sidebar/utils.tsx without importing its React module. */
export function desktopSidebarPadding(depth: number) {
  const level = Math.max(0, Math.floor(depth));
  return level === 0 ? 8 : 30 + (level - 1) * 14;
}

export function desktopSidebarRelativeTime(updated: number, now: number) {
  if (!Number.isFinite(updated) || updated <= 0) return null;
  const diff = Math.max(0, now - updated), minute = 60_000, hour = minute * 60, day = hour * 24, week = day * 7;
  if (diff < hour) return { key: 'common.relative.minutesAgoCompact', count: Math.max(1, Math.floor(diff / minute)) } as const;
  if (diff < day) return { key: 'common.relative.hoursAgoCompact', count: Math.floor(diff / hour) } as const;
  if (diff < week) return { key: 'common.relative.daysAgoCompact', count: Math.floor(diff / day) } as const;
  if (diff < 5 * week) return { key: 'common.relative.weeksAgoCompact', count: Math.floor(diff / week) } as const;
  if (diff < 365 * day) return { key: 'common.relative.monthsAgoCompact', count: Math.floor(diff / (30 * day)) } as const;
  return { key: 'common.relative.yearsAgoCompact', count: Math.floor(diff / (365 * day)) } as const;
}
