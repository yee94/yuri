import { buildSidebarNumberedSessionTargets } from '../ui/src/sync/sidebar-numbered-navigation';
import { cycleNavigationTargets, type SessionNavigationTarget } from '../ui/src/sync/session-navigation-core';
import type { ChatTarget, Session } from './model';
import { desktopSidebarSelected, desktopSidebarWindow, type DesktopSidebarProject } from './desktop-sidebar-model';
import type { DesktopSwitcherSource } from './desktop-session-switcher-core';

/** Read only on demand. Presentation/navigation gates must not revoke this data owner. */
export function createDesktopSidebarSwitcherSource(input: DesktopSwitcherSource & { current: () => boolean }): DesktopSwitcherSource {
  return {
    snapshot: () => input.current() ? input.snapshot() : { sessions: [], projects: [], pinnedSessionIDs: [], ready: false, loading: false, error: '' },
    status: row => input.current() ? input.status?.(row) ?? null : null,
    retry: async () => { if (input.current()) return input.retry?.(); },
  };
}

export type DesktopSidebarNavigationTarget = SessionNavigationTarget & { context: string; row: ChatTarget };
export type DesktopSidebarNavigationSnapshot = { all: readonly DesktopSidebarNavigationTarget[]; numbered: readonly DesktopSidebarNavigationTarget[] };
export interface DesktopSidebarActions {
  readonly switcherSource: DesktopSwitcherSource;
  /** The shell owns key registration (Mod+1…9 / previous / next); these never bind global keys. */
  numbered(slot: number): boolean;
  adjacent(direction: -1 | 1): boolean;
  targets(): readonly DesktopSidebarNavigationTarget[];
}
export type DesktopSidebarActionsRef = { current: DesktopSidebarActions | null; set?: (actions: DesktopSidebarActions | null) => void };

/** Build once per structural change from precisely the same folds/ranks used by the rows.
 * In-progress duplicates retain their own visual focus, like Web's pinned/project scopes. */
export function desktopSidebarNavigation<T extends Session>(input: {
  pinned: readonly T[]; inProgress: readonly T[]; sections: readonly DesktopSidebarProject<T>[];
  pinnedClosed: boolean; progressClosed: boolean; collapsed: ReadonlySet<string>; expandedTrees: ReadonlySet<string>;
  counts: Readonly<Record<string, number>>; initialCount: number; pins: ReadonlySet<string>; running: ReadonlySet<string>;
  selected: ChatTarget | null | undefined;
  projectTargets?: readonly DesktopSidebarNavigationTarget[];
}): DesktopSidebarNavigationSnapshot {
  const top: DesktopSidebarNavigationTarget[] = [], project: DesktopSidebarNavigationTarget[] = [];
  const append = (rows: readonly T[], context: string, projectId: string | null, scope: 'pinned' | 'project', target: DesktopSidebarNavigationTarget[]) => {
    for (const row of rows) target.push({ scope, context, sessionId: row.id, projectId, directory: row.directory, row: { kind: 'session', ...row } });
  };
  if (!input.pinnedClosed) append(input.pinned, 'pinned', null, 'pinned', top);
  if (!input.progressClosed) append(input.inProgress, 'running', null, 'pinned', top);
  for (const section of input.projectTargets === undefined ? input.sections : []) {
    if (input.collapsed.has(section.project.id)) continue;
    for (const group of section.groups) {
      if (group.tree && !input.expandedTrees.has(group.directory)) continue;
      const visible = desktopSidebarWindow(group.rows, input.counts[group.directory] ?? input.initialCount, input.pins, input.running, input.selected);
      append(visible.rows, group.directory, section.project.id, 'project', project);
    }
  }
  if (input.projectTargets) project.push(...input.projectTargets);
  const all = [...top, ...project];
  const identities = new Map<SessionNavigationTarget, DesktopSidebarNavigationTarget>(all.map(row => [row, row]));
  const numbered = buildSidebarNumberedSessionTargets({ pinnedTargets: top, projectTargets: project })
    .flatMap(row => { const target = identities.get(row); return target ? [target] : []; });
  return { all, numbered };
}

/** Instance-local navigation owner. No browser global publisher/store or network fallback. */
export function createDesktopSidebarNavigation(input: {
  current: () => boolean;
  snapshot: () => DesktopSidebarNavigationSnapshot;
  selected: () => ChatTarget | null | undefined;
  activate: (target: DesktopSidebarNavigationTarget) => void;
  switcherSource: DesktopSwitcherSource;
  focusChanged?: () => void;
}) {
  let alive = true, focus: DesktopSidebarNavigationTarget | undefined;
  const current = () => alive && input.current();
  const activate = (target: DesktopSidebarNavigationTarget | undefined) => {
    if (!current() || !target) return false;
    focus = target;
    input.focusChanged?.();
    input.activate(target);
    return true;
  };
  const actions: DesktopSidebarActions = {
    switcherSource: input.switcherSource,
    targets: () => current() ? input.snapshot().all : [],
    numbered(slot) {
      if (!current() || !Number.isInteger(slot) || slot < 1 || slot > 9) return false;
      return activate(input.snapshot().numbered[slot - 1]);
    },
    adjacent(direction) {
      if (!current() || direction !== -1 && direction !== 1) return false;
      const rows = input.snapshot().all;
      if (!rows.length) return false;
      const selected = input.selected();
      const matching = (row: DesktopSidebarNavigationTarget) => desktopSidebarSelected(row.row, selected);
      const focusedIndex = focus && matching(focus) ? rows.findIndex(row => row.context === focus!.context && row.projectId === focus!.projectId && matching(row)) : -1;
      const index = focusedIndex >= 0 ? focusedIndex : rows.findIndex(matching);
      return activate(cycleNavigationTargets(rows, direction, selected?.kind === 'session' ? selected.id : null, focus ?? null, index) ?? undefined);
    },
  };
  return { actions,
    focused: () => alive ? focus : undefined,
    open(context: string, row: Session) {
      if (!current()) return false;
      return activate(input.snapshot().all.find(target => target.context === context && target.sessionId === row.id && desktopSidebarSelected(row, target.row)));
    },
    dispose() { alive = false; focus = undefined; },
  };
}
