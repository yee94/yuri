/** Persisted Web folder shape; version:1 is a schema, not an optimistic revision. */
export interface SessionFolder { id: string; name: string; sessionIds: string[]; createdAt: number; parentId?: string | null }
export type FolderChange =
  | { kind: 'create'; folder: SessionFolder }
  | { kind: 'rename'; id: string; name: string }
  | { kind: 'delete'; id: string }
  | { kind: 'member'; sessionId: string; folderId: string | null; directory?: string }
  | { kind: 'reorder'; active: string; over: string }
  | { kind: 'parent'; id: string; parentId: string | null };
export function changeSessionFolders(folders: readonly SessionFolder[], change: FolderChange): SessionFolder[] {
  if (change.kind === 'create') {
    return [...folders, change.folder];
  }
  if (change.kind === 'member') {
    if (change.folderId && !folders.some(folder => folder.id === change.folderId)) throw new Error('Folder not found');
    return folders.map(folder => {
      const without = folder.sessionIds.filter(id => id !== change.sessionId);
      if (folder.id === change.folderId) return { ...folder, sessionIds: [...without, change.sessionId] };
      return without.length === folder.sessionIds.length ? folder : { ...folder, sessionIds: without };
    });
  }
  if (change.kind === 'reorder') {
    const next = [...folders], from = next.findIndex(folder => folder.id === change.active), to = next.findIndex(folder => folder.id === change.over);
    if (from < 0 || to < 0 || (next[from]?.parentId ?? null) !== (next[to]?.parentId ?? null)) throw new Error('Invalid folder rank');
    const [moved] = next.splice(from, 1); next.splice(to, 0, moved!); return next;
  }
  if (!folders.some(folder => folder.id === change.id)) throw new Error('Folder not found');
  if (change.kind === 'rename') {
    if (!change.name.trim()) throw new Error('Folder name required');
    return folders.map(folder => folder.id === change.id ? { ...folder, name: change.name.trim() } : folder);
  }
  const descendants = new Set([change.id]);
  for (let count = 0; count < folders.length; count++) for (const folder of folders) if (folder.parentId && descendants.has(folder.parentId)) descendants.add(folder.id);
  if (change.kind === 'parent') {
    if (change.parentId && (descendants.has(change.parentId) || !folders.some(folder => folder.id === change.parentId))) throw new Error('Invalid folder parent');
    return folders.map(folder => folder.id === change.id ? { ...folder, parentId: change.parentId } : folder);
  }
  return folders.filter(folder => !descendants.has(folder.id));
}

/** Folder-first depth-first order shared with the Web sortable projection. */
export function buildVisibleSortableSessionOrder<T extends { session: { id: string } }>({ folders, visibleUngroupedNodes, collapsedFolderIds, hasSessionSearchQuery }: {
  folders: Array<{ folder: SessionFolder; nodes: T[] }>; visibleUngroupedNodes: T[]; collapsedFolderIds: ReadonlySet<string>; hasSessionSearchQuery: boolean;
}) {
  const folderById = new Map(folders.map(entry => [entry.folder.id, entry]));
  const childrenByParentId = new Map<string | null, string[]>();
  folders.forEach(({ folder }) => { const parent = folder.parentId ?? null, rows = childrenByParentId.get(parent) ?? []; rows.push(folder.id); childrenByParentId.set(parent, rows); });
  const sessionIds: string[] = [], folderIdBySessionId = new Map<string, string | null>(), seen = new Set<string>();
  const append = (id: string) => {
    const entry = folderById.get(id); if (!entry || seen.has(id)) return; seen.add(id);
    if (!hasSessionSearchQuery && collapsedFolderIds.has(id)) return;
    (childrenByParentId.get(id) ?? []).forEach(append);
    for (const node of entry.nodes) { sessionIds.push(node.session.id); folderIdBySessionId.set(node.session.id, id); }
  };
  (childrenByParentId.get(null) ?? []).forEach(append);
  for (const node of visibleUngroupedNodes) { sessionIds.push(node.session.id); folderIdBySessionId.set(node.session.id, null); }
  return { sessionIds, folderIdBySessionId };
}
