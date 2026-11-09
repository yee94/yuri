import { describe, expect, it } from 'vitest';
import { desktopSidebarNavigationStatus, desktopSidebarPadding, desktopSidebarRelativeTime, desktopSidebarRunning, desktopSidebarSessionStateKey, type DesktopSidebarAuthority, type DesktopSidebarContact } from './desktop-sidebar-projection';

const contact = (id: string, createdAt: number, extra: Partial<DesktopSidebarContact> = {}): DesktopSidebarContact => ({ id, enabled: true, working: false, activeContactTurn: null, latestMessagePreview: { createdAt, messageID: id, ordinal: 1, role: 'assistant', text: '', fallbackKind: null }, ...extra });
describe('sidebar authority-only projection', () => {
  it('uses the Web latest-visible-message avatar rank, not pin/unread/working order', () => {
    const value: DesktopSidebarAuthority = { scope: 'captured', assistants: { enabled: true, contacts: [contact('older', 1, { unreadCount: 101, working: true }), contact('latest', 9, { avatarSeed: 'saved-recipe' }), contact('disabled', 99, { enabled: false, unreadCount: 9 })] }, schedules: [{ task: { lastStatus: 'running' } }] };
    expect(desktopSidebarNavigationStatus(value, 'captured')).toEqual({ avatar: { id: 'latest', avatarSeed: 'saved-recipe' }, assistantUnread: 101, assistantRunning: true, scheduleRunning: true });
    expect(desktopSidebarNavigationStatus(value, 'other')).toBeNull();
    expect(desktopSidebarNavigationStatus(undefined, 'captured')).toBeNull();
  });
  it('never turns history, an unknown count or a disabled catalog into live activity', () => {
    const value: DesktopSidebarAuthority = { scope: 'scope', assistants: { enabled: false, contacts: [contact('a', 10, { working: true, unreadCount: 10 })] }, schedules: [{ task: { lastStatus: 'success' } }] };
    expect(desktopSidebarNavigationStatus(value, 'scope')).toEqual({ avatar: null, assistantUnread: 0, assistantRunning: false, scheduleRunning: false });
    expect(desktopSidebarNavigationStatus({ scope: 'scope', assistants: { enabled: true, contacts: [contact('a', 100, { unreadCount: NaN })] } }, 'scope')?.assistantUnread).toBe(0);
  });
  it('lifts only known live descendants/shell projections and respects explicit own idle', () => {
    const rows = [{ id: 'parent', directory: '/root' }, { id: 'child', directory: '/root', parentID: 'parent' }, { id: 'shell-owner', directory: '/other' }];
    const authority: DesktopSidebarAuthority = { scope: 'scope', sessions: new Map([[desktopSidebarSessionStateKey(rows[2]!), { navigationRunning: true }], [desktopSidebarSessionStateKey(rows[0]!), { running: false }]]) };
    expect([...desktopSidebarRunning(rows, new Set(['child']), authority, 'scope')].sort()).toEqual(['child', 'parent', 'shell-owner']);
    expect([...desktopSidebarRunning(rows, new Set(), authority, 'retired')]).toEqual([]);
    expect([...desktopSidebarRunning(rows, new Set(['parent']), authority, 'scope')]).toEqual(['shell-owner']);
    expect(desktopSidebarRunning([{ id: 'a', directory: '/', parentID: 'b' }, { id: 'b', directory: '/', parentID: 'a' }], new Set(['a']), undefined, 'scope').size).toBe(2);
  });
  it('keeps the Web chip edge and exact internal icon-column / subagent steps', () => {
    expect([0, 1, 2, 3, -1].map(desktopSidebarPadding)).toEqual([8, 30, 44, 58, 8]);
    expect(desktopSidebarSessionStateKey({ id: 'a', directory: 'c:\\Project\\' })).toBe(desktopSidebarSessionStateKey({ id: 'a', directory: 'C:/Project' }));
  });
  it('matches compact relative-time thresholds without manufacturing unknown dates', () => {
    const day = 86_400_000, now = 400 * day;
    for (const [age, unit, count] of [[-1, 'minutes', 1], [0, 'minutes', 1], [59 * 60_000, 'minutes', 59], [3_600_000, 'hours', 1], [day, 'days', 1], [7 * day, 'weeks', 1], [35 * day, 'months', 1], [365 * day, 'years', 1]] as const) {
      expect(desktopSidebarRelativeTime(now - age, now)).toEqual({ key: `common.relative.${unit}AgoCompact`, count });
    }
    expect(desktopSidebarRelativeTime(NaN, now)).toBeNull(); expect(desktopSidebarRelativeTime(0, now)).toBeNull();
  });
  it('handles a large fully-live deep tree without recursive traversal or stack growth', () => {
    const rows = Array.from({ length: 20_000 }, (_, index) => ({ id: String(index), directory: '/scale', parentID: index ? String(index - 1) : undefined }));
    const live = new Set(rows.map(row => row.id));
    expect(desktopSidebarRunning(rows, live, undefined, 'scope').size).toBe(rows.length);
    expect(desktopSidebarRunning(rows, new Set([rows.at(-1)!.id]), undefined, 'scope').size).toBe(rows.length);
  });
});
