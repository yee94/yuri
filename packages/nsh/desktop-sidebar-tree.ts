import { buildSessionForest } from '../ui/src/components/session/sidebar/session-tree-core';
import { buildVisibleSortableSessionOrder, type SessionFolder } from '../ui/src/components/session/sidebar/session-folder-core';
import { sidebarSessionKey, type SidebarSession, type ProjectsSidebarSnapshot } from './projects-sidebar';
import { desktopSidebarWindow } from './desktop-sidebar-model';
import type { ChatTarget } from './model';

export type DesktopSidebarOutlineRow =
  | { kind: 'folder'; folder: SessionFolder; depth: number; scope: string }
  | { kind: 'session'; session: SidebarSession; depth: number; scope: string; folderId: string | null };
export function desktopSidebarOutline(input: {
  roots: readonly SidebarSession[]; scope: string; state: ProjectsSidebarSnapshot; expanded: ReadonlySet<string>;
  count: number; running: ReadonlySet<string>; pins: ReadonlySet<string>; selected?: ChatTarget | null;
  hidden?: ReadonlySet<string>;
}) {
  const retained = new Map(input.roots.map(row => [sidebarSessionKey(row), row]));
  const visit = (row: SidebarSession, seen: Set<string>) => {
    const key = sidebarSessionKey(row); if (seen.has(key)) return; seen.add(key);
    for (const child of input.state.children[key]?.rows ?? []) { if (input.hidden?.has(child.id)) continue; retained.set(sidebarSessionKey(child), child); visit(child, seen); }
  };
  for (const root of input.roots) visit(root, new Set());
  const forest = buildSessionForest([...retained.values()], { archived: row => row.archived });
  const pinnedAndLive = new Set([...input.pins, ...input.running]);
  const window = desktopSidebarWindow(forest.map(node => node.session), input.count, new Set(), pinnedAndLive, input.selected);
  const visible = new Set(window.rows.map(sidebarSessionKey));
  const nodes = forest.filter(node => visible.has(sidebarSessionKey(node.session)));
  const folders = input.state.folders?.foldersMap[input.scope] ?? [], collapsed = new Set(input.state.folders?.collapsedFolderIds ?? []);
  const membership = new Map<string, string>();
  for (const folder of folders) for (const id of folder.sessionIds) if (!membership.has(id)) membership.set(id, folder.id);
  const entries = folders.map(folder => ({ folder, nodes: nodes.filter(node => membership.get(node.session.id) === folder.id) }));
  const ungrouped = nodes.filter(node => !membership.has(node.session.id));
  const sortable = buildVisibleSortableSessionOrder({ folders: entries, visibleUngroupedNodes: ungrouped, collapsedFolderIds: collapsed, hasSessionSearchQuery: false });
  const rows: DesktopSidebarOutlineRow[] = [];
  const appendSession = (node: typeof forest[number], depth: number, folderId: string | null) => {
    rows.push({ kind: 'session', session: node.session, depth, scope: input.scope, folderId });
    if (input.expanded.has(sidebarSessionKey(node.session))) for (const child of node.children) appendSession(child, depth + 1, folderId);
  };
  const appendFolders = (parent: string | null, depth: number) => {
    for (const entry of entries.filter(entry => (entry.folder.parentId ?? null) === parent)) {
      rows.push({ kind: 'folder', folder: entry.folder, scope: input.scope, depth });
      if (collapsed.has(entry.folder.id)) continue;
      appendFolders(entry.folder.id, depth + 1);
      for (const node of entry.nodes) appendSession(node, depth + 1, entry.folder.id);
    }
  };
  appendFolders(null, 0); for (const node of ungrouped) appendSession(node, 0, null);
  return { rows, hidden: window.hidden, sortable };
}
