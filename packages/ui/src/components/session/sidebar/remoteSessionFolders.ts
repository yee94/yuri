import type { SessionIndexSession } from '@/lib/session-index-api';
import type { SessionFolder } from '@/stores/useSessionFoldersStore';
import { compareSessionsByPinnedAndTime } from './utils';

export type RemoteSessionRow = { session: SessionIndexSession; directory: string };
export type RemoteFolderNode = { folder: SessionFolder; children: RemoteFolderNode[]; rows: RemoteSessionRow[] };
export type RemoteFolderView = { folders: RemoteFolderNode[]; ungrouped: RemoteSessionRow[]; orderedRows: RemoteSessionRow[] };

/** One projection owns the DOM, keyboard targets and drag order; pinned sessions always win over manual order. */
export function buildRemoteFolderView(rows: RemoteSessionRow[], folders: SessionFolder[], order: readonly string[], pinned: ReadonlySet<string>): RemoteFolderView {
  const pinnedIds = new Set(pinned);
  for (const { session } of rows) if (session.time.pinned) pinnedIds.add(session.id);
  const ranks = new Map(order.map((id, index) => [id, index]));
  const orderedRows = [...rows].sort((a, b) => {
    if (pinnedIds.has(a.session.id) || pinnedIds.has(b.session.id)) return compareSessionsByPinnedAndTime(a.session, b.session, pinnedIds);
    const rank = (ranks.get(a.session.id) ?? Infinity) - (ranks.get(b.session.id) ?? Infinity);
    return (Number.isNaN(rank) ? 0 : rank) || compareSessionsByPinnedAndTime(a.session, b.session, pinnedIds);
  });
  const byId = new Map(folders.map((folder) => [folder.id, { folder, children: [], rows: [] } as RemoteFolderNode]));
  const roots: RemoteFolderNode[] = [];
  for (const node of byId.values()) {
    const ancestors = new Set([node.folder.id]);
    let parent = node.folder.parentId ? byId.get(node.folder.parentId) : undefined;
    let cursor = parent;
    while (cursor && !ancestors.has(cursor.folder.id)) {
      ancestors.add(cursor.folder.id);
      cursor = cursor.folder.parentId ? byId.get(cursor.folder.parentId) : undefined;
    }
    if (cursor) parent = undefined;
    if (parent) parent.children.push(node); else roots.push(node);
  }
  const owner = new Map<string, RemoteFolderNode>();
  for (const node of byId.values()) for (const id of node.folder.sessionIds) if (!owner.has(id)) owner.set(id, node);
  const ungrouped: RemoteSessionRow[] = [];
  for (const row of orderedRows) {
    const folder = owner.get(row.session.id);
    if (folder) folder.rows.push(row); else ungrouped.push(row);
  }
  return { folders: roots, ungrouped, orderedRows };
}

export function visibleRemoteRows(view: RemoteFolderView, collapsed: ReadonlySet<string>, limit: number, searching: boolean): RemoteSessionRow[] {
  const result: RemoteSessionRow[] = [];
  const visit = (nodes: RemoteFolderNode[]) => {
    for (const node of nodes) {
      if (!searching && collapsed.has(node.folder.id)) continue;
      visit(node.children);
      result.push(...node.rows.slice(0, limit));
    }
  };
  visit(view.folders);
  result.push(...view.ungrouped.slice(0, limit));
  return result;
}

export function canMoveRemoteFolder(folders: SessionFolder[], id: string, parentId: string | null): boolean {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  if (!byId.has(id) || (parentId && !byId.has(parentId))) return false;
  const seen = new Set([id]);
  let cursor = parentId;
  while (cursor) {
    if (seen.has(cursor)) return false;
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  return true;
}

export type RemoteDragItem = { kind: 'session' | 'folder' | 'folder-position' | 'root'; directory: string; id: string };
export const remoteDragId = (item: RemoteDragItem) => JSON.stringify([item.kind, item.directory, item.id]);
