import { record, text, type Row, type Session } from './model';
import { desktopSidebarSessionStateKey, type DesktopSidebarAuthority, type DesktopSidebarContact, type DesktopSidebarSessionState } from './desktop-sidebar-projection';

export type DesktopSidebarAssistantSnapshot = Readonly<{ scope: string; revision: number; enabled: boolean; contacts: readonly DesktopSidebarContact[] }>;
export type DesktopSidebarScopedRows<T> = Readonly<{ scope: string; rows: readonly T[] }>;

/** Metadata from the adopted snapshot, never a capability guessed from a nonempty array. */
export function desktopSidebarAssistantSnapshot(scope: string, snapshot: Row): DesktopSidebarAssistantSnapshot {
  if (snapshot.partial === true || snapshot.complete === false || typeof snapshot.enabled !== 'boolean' || !Number.isSafeInteger(snapshot.revision) || Number(snapshot.revision) < 0 || !Array.isArray(snapshot.assistants)) throw new Error('Invalid assistants snapshot');
  const contacts = snapshot.assistants.map(value => {
    const row = record(value), turn = row.activeContactTurn, preview = row.latestMessagePreview;
    if (!text(row.id) || typeof row.enabled !== 'boolean' || typeof row.working !== 'boolean'
      || turn !== undefined && turn !== null && (!text(record(turn).turnID) || !text(record(turn).messageID) || !['queued', 'running'].includes(text(record(turn).status)) || typeof record(turn).admittedAt !== 'number')
      || preview !== undefined && preview !== null && (!text(record(preview).messageID) || typeof record(preview).ordinal !== 'number' || !['user', 'assistant'].includes(text(record(preview).role)) || typeof record(preview).text !== 'string')
      || row.unreadCount !== undefined && (!Number.isSafeInteger(row.unreadCount) || Number(row.unreadCount) < 0)) throw new Error('Invalid assistant contact');
    // Validation above narrows the wire at this native SDK gap. No message body is copied.
    return { id: text(row.id), enabled: row.enabled, working: row.working,
      activeContactTurn: (turn ?? null) as DesktopSidebarContact['activeContactTurn'],
      ...(typeof row.avatarSeed === 'string' ? { avatarSeed: row.avatarSeed } : {}),
      ...(preview !== undefined ? { latestMessagePreview: preview as DesktopSidebarContact['latestMessagePreview'] } : {}),
      ...(row.unreadCount !== undefined ? { unreadCount: Number(row.unreadCount) } : {}),
    };
  });
  if (new Set(contacts.map(contact => contact.id)).size !== contacts.length) throw new Error('Invalid assistant contacts');
  return { scope, revision: Number(snapshot.revision), enabled: snapshot.enabled, contacts };
}

/** One derived map, invalidated only by the identities of its real sources. */
export function createDesktopSidebarAuthorityProjection() {
  let prior: { scope: string; assistants: DesktopSidebarAssistantSnapshot | null; schedules: DesktopSidebarScopedRows<Row> | null; sessions: DesktopSidebarScopedRows<Session> | null; unseen: Readonly<Record<string, number>>; live: ReadonlyMap<string, DesktopSidebarSessionState> } | undefined;
  let result: DesktopSidebarAuthority | null = null;
  const empty = new Map<string, DesktopSidebarSessionState>();
  return (input: { scope: string | null; assistants: DesktopSidebarAssistantSnapshot | null; schedules: DesktopSidebarScopedRows<Row> | null; sessions: DesktopSidebarScopedRows<Session> | null; unseen: Readonly<Record<string, number>>; live?: ReadonlyMap<string, DesktopSidebarSessionState> }): DesktopSidebarAuthority | null => {
    if (!input.scope) { prior = undefined; result = null; return null; }
    const live = input.live ?? empty;
    if (prior?.scope === input.scope && prior.assistants === input.assistants && prior.schedules === input.schedules && prior.sessions === input.sessions && prior.unseen === input.unseen && prior.live === live) return result;
    const sessions = new Map<string, DesktopSidebarSessionState>();
    if (input.sessions?.scope === input.scope) for (const row of input.sessions.rows) {
      const key = desktopSidebarSessionStateKey(row), activity = live.get(key), unread = input.unseen[row.id];
      sessions.set(key, { ...(typeof row.hasChildren === 'boolean' ? { hasChildren: row.hasChildren } : {}), ...activity,
        ...(typeof unread === 'number' ? { unreadCount: unread } : {}) });
    }
    // Live child sessions need not be in the root-only, newest-20 index window.
    for (const [key, value] of live) if (!sessions.has(key)) sessions.set(key, value);
    result = { scope: input.scope, sessions,
      ...(input.assistants?.scope === input.scope ? { assistants: input.assistants } : {}),
      ...(input.schedules?.scope === input.scope ? { schedules: input.schedules.rows.map(row => {
        const task = record(row.task), status = record(task.state).lastStatus ?? task.lastStatus;
        return { task: { ...(typeof status === 'string' ? { lastStatus: status } : {}) } };
      }) } : {}),
    };
    prior = { ...input, scope: input.scope, live }; return result;
  };
}
