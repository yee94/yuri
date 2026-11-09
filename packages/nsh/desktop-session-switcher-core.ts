import { normalizePath } from '../ui/src/lib/pathNormalization';
import type { ChatTarget, Project, Session } from './model';

export type DesktopSwitcherSession = Session & { pinned?: boolean; archived?: boolean; created?: number; activity?: number; changes?: string };
export type DesktopSwitcherSnapshot = {
  /** Already retained by the shared Projects owner; this is not a full-index loader. */
  sessions: readonly DesktopSwitcherSession[];
  projects: readonly Project[];
  pinnedSessionIDs: readonly string[];
  branches?: ReadonlyMap<string, string | null>;
  ready: boolean;
  loading: boolean;
  error: string;
};
export type DesktopSwitcherSource = {
  snapshot: () => DesktopSwitcherSnapshot;
  /** Live authority only. Never infer this from message/history timestamps. */
  status?: (session: DesktopSwitcherSession) => 'running' | 'unread' | null;
  /** Explicit recovery delegates to the existing owner, not another runtime stream. */
  retry?: () => Promise<unknown>;
};
export type DesktopSwitcherNode = {
  key: string;
  session: DesktopSwitcherSession;
  projectLabel: string | null;
  branchLabel: string | null;
  children: DesktopSwitcherNode[];
};
export type DesktopSwitcherRow = { node: DesktopSwitcherNode; depth: number };
export const desktopSwitcherKey = (session: Pick<Session, 'directory' | 'id'>) => JSON.stringify([normalizePath(session.directory), session.id]);

/** Web useSwitcherItems' ordering/tree contract. Its React hook and utils.tsx
 * import browser stores and cannot run in QuickJS; consume native projections of
 * exactly the same created/activity fields instead. No persisted drag rank. */
export function desktopSwitcherCatalog(snapshot: DesktopSwitcherSnapshot, scopeProjectId?: string | null): DesktopSwitcherNode[] {
  const pins = new Set(snapshot.pinnedSessionIDs);
  const projects = snapshot.projects.map(project => ({ project, path: normalizePath(project.path) })).filter(row => row.path)
    .sort((a, b) => b.path!.length - a.path!.length);
  const compare = (a: DesktopSwitcherSession, b: DesktopSwitcherSession) => {
    const ap = pins.has(a.id), bp = pins.has(b.id);
    return ap !== bp ? ap ? -1 : 1 : ap ? (b.created ?? 0) - (a.created ?? 0) : (b.activity ?? b.updated) - (a.activity ?? a.updated);
  };
  const sessions = [...new Map(snapshot.sessions.filter(row => !row.archived && row.id && normalizePath(row.directory)).map(row => [desktopSwitcherKey(row), row])).values()];
  const byID = new Map(sessions.map(row => [row.id, row]));
  const children = new Map<string, DesktopSwitcherSession[]>();
  for (const row of sessions) if (row.parentID && byID.has(row.parentID)) {
    const bucket = children.get(row.parentID) ?? []; bucket.push(row); children.set(row.parentID, bucket);
  }
  for (const bucket of children.values()) bucket.sort(compare);
  const roots: DesktopSwitcherNode[] = [];
  for (const row of sessions.filter(row => !row.parentID).sort(compare)) {
    const directory = normalizePath(row.directory)!;
    const project = projects.find(({ path }) => directory === path || directory.startsWith(path === '/' ? '/' : `${path}/`))?.project;
    if (scopeProjectId && project?.id !== scopeProjectId) continue;
    // Web deliberately uses the path basename, not a user project label.
    const projectLabel = project?.path.split(/[\\/]/).filter(Boolean).pop() ?? null;
    const rawBranch = snapshot.branches?.get(directory)?.trim();
    const branchLabel = rawBranch && rawBranch !== 'HEAD' && rawBranch !== projectLabel ? rawBranch : null;
    const build = (session: DesktopSwitcherSession, ancestors: ReadonlySet<string>): DesktopSwitcherNode => ({
      key: desktopSwitcherKey(session), session, projectLabel, branchLabel,
      children: (children.get(session.id) ?? []).filter(child => !ancestors.has(child.id)).map(child => build(child, new Set([...ancestors, child.id]))),
    });
    roots.push(build(row, new Set([row.id])));
  }
  return roots;
}

/** Web's seven-parent window, followed only by explicitly expanded children.
 * Menu typeahead moves focus within these rows; it never filters the catalog. */
export function desktopSwitcherRows(catalog: readonly DesktopSwitcherNode[], expanded: ReadonlySet<string>): DesktopSwitcherRow[] {
  const result: DesktopSwitcherRow[] = [];
  function visit(node: DesktopSwitcherNode, depth: number) {
    result.push({ node, depth });
    if (expanded.has(node.key)) for (const child of node.children) visit(child, depth + 1);
  }
  for (const root of catalog.slice(0, 7)) visit(root, 0);
  return result;
}

export function desktopSwitcherDate(timestamp: number, now = Date.now()) {
  const diff = Math.max(0, now - timestamp), minute = 60_000, hour = 60 * minute, day = 24 * hour, week = 7 * day, month = 30 * day, year = 365 * day;
  if (diff < hour) return { key: 'common.relative.minutesAgoCompact', count: Math.max(1, Math.floor(diff / minute)) } as const;
  if (diff < day) return { key: 'common.relative.hoursAgoCompact', count: Math.floor(diff / hour) } as const;
  if (diff < week) return { key: 'common.relative.daysAgoCompact', count: Math.floor(diff / day) } as const;
  if (diff < 5 * week) return { key: 'common.relative.weeksAgoCompact', count: Math.floor(diff / week) } as const;
  if (diff < year) return { key: 'common.relative.monthsAgoCompact', count: Math.floor(diff / month) } as const;
  return { key: 'common.relative.yearsAgoCompact', count: Math.floor(diff / year) } as const;
}

/** One presentation owner. Closing happens before navigation, while a retired
 * popup cannot close/navigate a replacement popup, even with colliding IDs. */
export function createDesktopSwitcherOwner(options: {
  owns: () => boolean; current: () => boolean;
  currentTarget: () => ChatTarget | undefined;
  /** Independent Host fence; unlike presentation demand it can stay true after close. */
  navigationCurrent?: () => boolean;
  close: () => void; openChat: (target: ChatTarget) => void; newSession: () => void;
  changed?: (state: { retrying: boolean; error: string }) => void;
}) {
  let alive = true, closed = false, retrying = false, flight = 0;
  const owns = () => alive && !closed && options.owns();
  const current = () => owns() && options.current();
  function close() { if (!owns()) return false; closed = true; flight++; options.close(); return true; }
  return {
    current, close,
    select(session: DesktopSwitcherSession) {
      if (!current()) return;
      const active = options.currentTarget();
      const same = active?.kind === 'session' && desktopSwitcherKey(active) === desktopSwitcherKey(session);
      if (close() && !same && options.navigationCurrent?.() !== false) options.openChat({ kind: 'session', id: session.id, title: session.title, directory: session.directory });
    },
    newSession() { if (current() && close() && options.navigationCurrent?.() !== false) options.newSession(); },
    async retry(work: (() => Promise<unknown>) | undefined) {
      if (!work || !current() || retrying) return;
      retrying = true; const ticket = ++flight;
      options.changed?.({ retrying: true, error: '' });
      let error = '';
      try { await work(); } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      if (ticket !== flight || !current()) return;
      retrying = false; options.changed?.({ retrying: false, error });
    },
    dispose() { alive = false; flight++; },
  };
}
