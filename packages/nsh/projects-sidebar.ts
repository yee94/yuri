import { id, messagesFrom, projectsFrom, record, text, unwrap, type Project, type Row, type Session } from './model';
import { normalizeDirectoryKey } from '../ui/src/lib/pathNormalization';
import { changeSessionFolders, type FolderChange, type SessionFolder } from '../ui/src/components/session/sidebar/session-folder-core';
import { buildExportFilename, formatSessionAsMarkdown, type ChildSessionExport, type SessionMessageRecord } from '../ui/src/lib/export-session-core';
import { messagesVisibleWithRevert } from '../ui/src/sync/conversation-order';
import { registerNativeNewSessionFolderOwner } from './new-session-folder';
import type { PageOperation } from './page-operations';

export type SidebarSession = Session & { pinned: boolean; archived: boolean; created?: number; activity?: number; changes?: string };
export type SidebarPage = { rows: SidebarSession[]; cursor: string | null; loaded: boolean };
export type FolderSnapshot = Row & { version: 1; foldersMap: Record<string, SessionFolder[]>; collapsedFolderIds: string[]; updatedAt: number };
export type SidebarLane = { current: () => boolean; request: (path: string, method?: string, body?: unknown) => Promise<unknown>; scope?: PageOperation['scope']; generation?: number };
export type NewSessionFolderWriteAdmission = { beforeSend: () => Promise<void>; acknowledged: () => Promise<void> };
type WriteReadResult = { confirmed: boolean; folders?: FolderSnapshot; projects?: Project[]; restored?: SidebarSession };
type UnknownWrite = { key: string; sent: boolean; read: (lane: SidebarLane) => Promise<WriteReadResult> };
export type SidebarWriteJournal = Map<string, UnknownWrite>;
export type ProjectsSidebarSnapshot = {
  children: Record<string, SidebarPage>; archived: Record<string, SidebarPage>; folders: FolderSnapshot | null;
  pending: string[]; errors: Record<string, string>; unknown: string[];
};
export const sidebarSessionKey = (row: Pick<Session, 'id' | 'directory'>) => JSON.stringify([normalizeDirectoryKey(row.directory), row.id]);
const folderRoute = '/api/session-folders', projectRoute = '/api/config/settings';
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const query = (directory: string) => `directory=${encodeURIComponent(directory)}`;
export function parseSidebarFolders(value: unknown): FolderSnapshot {
  const body = record(value), folders = record(body.foldersMap);
  if (body.version !== 1 || !body.foldersMap || typeof body.foldersMap !== 'object' || Array.isArray(body.foldersMap) || !Array.isArray(body.collapsedFolderIds) || !body.collapsedFolderIds.every(id => typeof id === 'string') || typeof body.updatedAt !== 'number' || !Number.isFinite(body.updatedAt)) throw new Error('Invalid session folder snapshot');
  const ids = new Set<string>();
  for (const entries of Object.values(folders)) {
    if (!Array.isArray(entries)) throw new Error('Invalid session folders');
    const scopeIds = new Set<string>();
    for (const entry of entries) {
      const folder = record(entry);
      if (!text(folder.id) || typeof folder.name !== 'string' || !Array.isArray(folder.sessionIds) || !folder.sessionIds.every(id => typeof id === 'string') || typeof folder.createdAt !== 'number' || !Number.isFinite(folder.createdAt) || folder.parentId != null && typeof folder.parentId !== 'string' || ids.has(text(folder.id))) throw new Error('Invalid session folder');
      scopeIds.add(text(folder.id)); ids.add(text(folder.id));
    }
    for (const entry of entries) {
      const seen = new Set<string>([entry.id]); let parent = entry.parentId;
      while (parent) {
        if (seen.has(parent) || !scopeIds.has(parent)) throw new Error('Invalid folder ancestry');
        seen.add(parent); parent = entries.find(folder => folder.id === parent)?.parentId;
      }
    }
  }
  return body as FolderSnapshot;
}

/** Extension of the Projects owner. All network access uses its captured page lane.
 * Folders/settings are legacy LWW snapshots: preflight/readback detects observed
 * conflicts, NOT CAS. Unknown writes are read-only until authority confirms them. */
export function createProjectsSidebar(input: {
  capture: () => SidebarLane; current: () => boolean; changed: () => void;
  session: (value: unknown, directory?: string) => SidebarSession;
  visible: (value: unknown) => boolean;
  restored: (row: SidebarSession) => void; projects: (rows: Project[]) => void;
  directories: (scope: string) => readonly string[];
  journal?: SidebarWriteJournal;
}) {
  let alive = true, serial = 0, sessionRevision = 0;
  let state: ProjectsSidebarSnapshot = { children: {}, archived: {}, folders: null, pending: [], errors: {}, unknown: [] };
  const flights = new Map<string, Promise<unknown>>(), journal = input.journal ?? new Map<string, UnknownWrite>();
  const sessionFrom = input.session;
  const current = () => alive && input.current();
  const publish = () => { state = { ...state, unknown: [...journal.keys()] }; if (alive) input.changed(); };
  const error = (key: string, failure: unknown) => { state = { ...state, errors: { ...state.errors, [key]: failure instanceof Error ? failure.message : String(failure) } }; };
  async function perform<T>(key: string, work: (lane: SidebarLane, valid: () => boolean) => Promise<T>): Promise<T | undefined> {
    if (!current()) return;
    const prior = flights.get(key); if (prior) return prior as Promise<T | undefined>;
    const captured = serial, lane = input.capture(), valid = () => current() && captured === serial && lane.current();
    state = { ...state, pending: [...state.pending, key], errors: { ...state.errors, [key]: '' } }; publish();
    const flight = (async () => {
      try { return await work(lane, valid); }
      catch (failure) { if (valid()) error(key, failure); return undefined; }
      finally { if (valid()) { state = { ...state, pending: state.pending.filter(item => item !== key) }; publish(); } }
    })();
    flights.set(key, flight);
    try { return await flight; } finally { if (flights.get(key) === flight) flights.delete(key); }
  }
  function decodePage(payload: unknown, directory: string, parentID: string | null, archived: boolean): SidebarPage {
    const body = record(payload); if (!Array.isArray(body.data)) throw new Error('Invalid session page');
    const rows: SidebarSession[] = [];
    for (const raw of body.data) {
      const row = input.session(raw, directory);
      if (!row.id || normalizeDirectoryKey(row.directory) !== normalizeDirectoryKey(directory) || (row.parentID ?? null) !== parentID) throw new Error('Session page scope mismatch');
      if (row.archived === archived && input.visible(raw)) rows.push(row);
    }
    return { rows, cursor: text(record(body.cursor).next) || null, loaded: true };
  }
  async function childrenAt(lane: SidebarLane, row: SidebarSession, valid: () => boolean) {
    const rows: SidebarSession[] = [], cursors = new Set<string>(); let cursor: string | null = null;
    do {
      const params = cursor ? `cursor=${encodeURIComponent(cursor)}&limit=50` : `${query(row.directory)}&parentID=${encodeURIComponent(row.id)}&limit=50`;
      const payload = await lane.request(`/api/session?${params}`);
      if (!valid()) return undefined;
      const page = decodePage(payload, row.directory, row.id, row.archived); rows.push(...page.rows); cursor = page.cursor;
      if (cursor && cursors.has(cursor)) throw new Error('Child session cursor did not advance');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...new Map(rows.map(row => [row.id, row])).values()];
  }
  function loadChildren(row: SidebarSession) {
    const key = sidebarSessionKey(row), revision = sessionRevision;
    return perform(`children:${key}`, async (lane, valid) => {
      const rows = await childrenAt(lane, row, valid); if (!valid() || !rows || revision !== sessionRevision) return;
      state = { ...state, children: { ...state.children, [key]: { rows, cursor: null, loaded: true } } }; publish(); return rows;
    });
  }
  function loadArchived(directory: string, more = false) {
    const revision = sessionRevision;
    return perform(`archived:${directory}`, async (lane, valid) => {
      const prior = state.archived[directory]; let cursor = more ? prior?.cursor ?? null : null;
      if (more && (!prior?.loaded || !cursor)) return;
      const cursors = new Set<string>(); if (cursor) cursors.add(cursor);
      let page: SidebarPage;
      do {
        const payload = await lane.request(`/api/session?${query(directory)}&parentID=null&limit=20${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        if (!valid() || revision !== sessionRevision) return;
        page = decodePage(payload, directory, null, true);
        cursor = page.cursor;
        if (cursor && cursors.has(cursor)) throw new Error('Archived cursor did not advance');
        if (cursor) cursors.add(cursor);
      } while (!page.rows.length && cursor);
      const rows = more ? [...new Map([...(prior?.rows ?? []), ...page.rows].map(row => [row.id, row])).values()] : page.rows;
      state = { ...state, archived: { ...state.archived, [directory]: { ...page, rows } } }; publish();
    });
  }
  function loadFolders() { return perform('folders', async (lane, valid) => {
    const value = parseSidebarFolders(await lane.request(folderRoute)); if (!valid()) return;
    state = { ...state, folders: value }; publish(); return value;
  }); }
  async function reconcile(key: string, lane: SidebarLane, valid: () => boolean) {
    const operation = journal.get(key); if (!operation) return false;
    const result = await operation.read(lane); if (!valid()) return false;
    if (!result.confirmed) throw new Error('write_result_unconfirmed: refresh authority; original mutation will not be resent');
    if (result.folders) state = { ...state, folders: result.folders };
    if (result.projects) input.projects(result.projects);
    if (result.restored) {
      sessionRevision++;
      const restored = result.restored;
      for (const [directory, page] of Object.entries(state.archived)) state = { ...state, archived: { ...state.archived, [directory]: { ...page, rows: page.rows.filter(item => sidebarSessionKey(item) !== sidebarSessionKey(restored)) } } };
      input.restored(restored);
    }
    if (journal.get(key) === operation) journal.delete(key); publish(); return true;
  }
  function write(key: string, prepare: (lane: SidebarLane, valid: () => boolean) => Promise<{ path: string; method: string; body: unknown; read: UnknownWrite['read'] } | null>, admission?: NewSessionFolderWriteAdmission) {
    if (flights.has(key)) return Promise.resolve(undefined);
    return perform(key, async (lane, valid) => {
      if (journal.has(key)) throw new Error('prior_write_unresolved: verify the original result before editing');
      const reservation: UnknownWrite = { key, sent: false, read: async () => { throw new Error('write_in_progress'); } };
      journal.set(key, reservation);
      let plan: Awaited<ReturnType<typeof prepare>>;
      try { plan = await prepare(lane, valid); }
      catch (failure) { if (journal.get(key) === reservation) journal.delete(key); throw failure; }
      if (!valid() || !plan) { if (journal.get(key) === reservation) journal.delete(key); return valid() ? true : undefined; }
      if (admission) {
        try { await admission.beforeSend(); if (!valid()) throw new Error('page_operation_stale'); }
        catch (failure) { if (journal.get(key) === reservation) journal.delete(key); throw failure; }
      }
      const operation: UnknownWrite = { key, sent: true, read: plan.read }; journal.set(key, operation); publish();
      try {
        const response = await lane.request(plan.path, plan.method, plan.body);
        if (admission) {
          if (record(response).success !== true) throw new Error('folder_acknowledgement_missing');
          // The response belongs to this exact awaited POST. GET equality below
          // cannot substitute for this causal ACK when admitting a new session.
          await admission.acknowledged();
        }
      }
      catch (failure) {
        const status = Number(record(failure).status);
        if (status >= 400 && status < 500 && status !== 408) { if (journal.get(key) === operation) journal.delete(key); throw failure; }
        if (!valid()) return;
        // An error may have followed a committed write. Reconcile once, never POST twice.
        try { if (await reconcile(key, lane, valid)) return true; } catch { /* Preserve the original failure and unknown journal. */ }
        throw failure;
      }
      if (!valid()) return;
      return reconcile(key, lane, valid);
    });
  }
  function folders(scope: string, change: FolderChange | { kind: 'collapse'; id: string }, admission?: NewSessionFolderWriteAdmission) {
    return write('folders-write', async (lane, valid) => {
      const before = state.folders; if (!before) throw new Error('Session folders must be loaded before editing');
      const latest = parseSidebarFolders(await lane.request(folderRoute)); if (!valid()) throw new Error('page_operation_stale');
      if (!same(latest, before)) throw new Error('session_folders_conflict: refresh before editing (Host has no CAS)');
      const directories = new Set(input.directories(scope).map(normalizeDirectoryKey));
      if (!directories.size) throw new Error('Folder scope is no longer registered');
      if (change.kind === 'member') {
        const hint = change.directory ?? (scope.startsWith('__archived__:') ? Object.values(state.archived).flatMap(page => page.rows).find(row => row.id === change.sessionId)?.directory : scope);
        if (!hint || !directories.has(normalizeDirectoryKey(hint))) throw new Error('Folder membership directory mismatch');
        const session = sessionFrom(unwrap(await lane.request(`/api/session/${encodeURIComponent(change.sessionId)}?${query(hint)}`)), hint);
        if (!valid()) throw new Error('page_operation_stale');
        if (session.id !== change.sessionId || session.parentID || normalizeDirectoryKey(session.directory) !== normalizeDirectoryKey(hint) || session.archived !== scope.startsWith('__archived__:')) throw new Error('Folder membership session moved');
      }
      const rows = before.foldersMap[scope] ?? [];
      if (change.kind === 'create' && (!change.folder.name.trim() || rows.some(row => row.id === change.folder.id) || change.folder.parentId && !rows.some(row => row.id === change.folder.parentId))) throw new Error('Invalid new folder');
      const nextRows = change.kind === 'collapse' ? rows : changeSessionFolders(rows, change);
      const retained = new Set(nextRows.map(folder => folder.id)), removed = new Set(rows.filter(folder => !retained.has(folder.id)).map(folder => folder.id));
      const collapsed = before.collapsedFolderIds.filter(id => !removed.has(id));
      if (change.kind === 'collapse') {
        if (!retained.has(change.id)) throw new Error('Folder not found');
        const position = collapsed.indexOf(change.id); if (position < 0) collapsed.push(change.id); else collapsed.splice(position, 1);
      }
      const next: FolderSnapshot = { ...latest, foldersMap: { ...latest.foldersMap, [scope]: nextRows }, collapsedFolderIds: collapsed, updatedAt: Date.now() };
      return { path: folderRoute, method: 'POST', body: next, read: async lane => {
        const observed = parseSidebarFolders(await lane.request(folderRoute));
        return { confirmed: same(observed, next), folders: observed };
      } };
    }, admission);
  }
  function loadProjects() { return perform('projects-read', async (lane, valid) => {
    const value = record(unwrap(await lane.request(projectRoute))); if (!Array.isArray(value.projects)) throw new Error('Invalid project catalog');
    if (valid()) input.projects(projectsFrom(value)); return value;
  }); }
  function reorderProjects(active: string, over: string) {
    return write('projects-write', async (lane, valid) => {
      const before = record(unwrap(await lane.request(projectRoute))); if (!valid() || !Array.isArray(before.projects)) throw new Error('Invalid project catalog');
      const rows = [...before.projects] as Row[], from = rows.findIndex(row => row.id === active), to = rows.findIndex(row => row.id === over);
      if (from < 0 || to < 0 || from === to) throw new Error('Project rank changed');
      const [moved] = rows.splice(from, 1); rows.splice(to, 0, moved!);
      return { path: projectRoute, method: 'PUT', body: { projects: rows }, read: async lane => {
        const observed = record(unwrap(await lane.request(projectRoute)));
        return { confirmed: same(observed.projects, rows), projects: projectsFrom(observed) };
      } };
    });
  }
  function restore(row: SidebarSession) {
    const key = `restore:${sidebarSessionKey(row)}`;
    const read = async (lane: SidebarLane) => {
      const value = sessionFrom(unwrap(await lane.request(`/api/session/${encodeURIComponent(row.id)}?${query(row.directory)}`)), row.directory);
      if (value.id !== row.id || normalizeDirectoryKey(value.directory) !== normalizeDirectoryKey(row.directory)) throw new Error('Restore identity mismatch');
      return { confirmed: !value.archived, restored: value };
    };
    return write(key, async (lane, valid) => {
      const prior = await read(lane);
      if (prior.confirmed) {
        if (valid() && prior.restored) {
          sessionRevision++;
          input.restored(prior.restored);
          state = { ...state, archived: Object.fromEntries(Object.entries(state.archived).map(([directory, page]) => [directory, { ...page, rows: page.rows.filter(item => sidebarSessionKey(item) !== sidebarSessionKey(row)) }])) }; publish();
        }
        return null;
      }
      if (!valid()) throw new Error('page_operation_stale');
      return { path: `/api/yuri/sessions/${encodeURIComponent(row.id)}/archive`, method: 'PUT', body: { archivedAt: 0, directory: row.directory }, read };
    });
  }
  function exportMarkdown(row: SidebarSession, includeChildren: boolean, locale?: string) {
    return perform(`export:${sidebarSessionKey(row)}`, async (lane, valid) => {
      const seen = new Set<string>();
      async function collect(session: SidebarSession): Promise<ChildSessionExport> {
        const key = sidebarSessionKey(session); if (seen.has(key)) throw new Error('Cyclic export tree'); seen.add(key);
        const metadata = record(unwrap(await lane.request(`/api/session/${encodeURIComponent(session.id)}?${query(session.directory)}`)));
        if (!valid()) throw new Error('page_operation_stale');
        const authority = sessionFrom(metadata, session.directory);
        if (authority.id !== session.id || normalizeDirectoryKey(authority.directory) !== normalizeDirectoryKey(session.directory)) throw new Error('Export identity mismatch');
        const cursors = new Set<string>(), messageIDs = new Set<string>(); let cursor: string | null = null;
        let records: Array<SessionMessageRecord & { id: string }> = [];
        do {
          const payload = await lane.request(`/api/session/${encodeURIComponent(session.id)}/message?${query(session.directory)}&limit=100&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
          if (!valid()) throw new Error('page_operation_stale');
          const body = record(payload); if (!Array.isArray(body.data)) throw new Error('Invalid export page');
          for (const raw of body.data) { const value = record(record(raw).info ?? raw); if (value.sessionID && value.sessionID !== session.id) throw new Error('Export session mismatch'); }
          const page = messagesFrom(payload, false, 100);
          const next: Array<SessionMessageRecord & { id: string }> = [];
          for (const message of page.messages) if (!messageIDs.has(message.id)) {
            messageIDs.add(message.id);
            const parts = (message.content ?? []).filter(part => part.type === 'text').map(part => ({ type: 'text', text: text(part.text) }));
            next.push({ id: message.id, info: { role: message.role, time: message.time, providerID: message.providerID, modelID: message.modelID }, parts: parts.length ? parts : [{ type: 'text', text: message.text }] });
          }
          records = [...next, ...records]; cursor = text(record(body.cursor).next) || null;
          if (cursor && cursors.has(cursor)) throw new Error('Export cursor did not advance'); if (cursor) cursors.add(cursor);
        } while (cursor);
        const children: ChildSessionExport[] = [];
        if (includeChildren) for (const child of await childrenAt(lane, session, valid) ?? []) children.push(await collect(child));
        return { title: authority.title, agent: text(metadata.agent) || undefined, records: messagesVisibleWithRevert(records, text(record(metadata.revert).messageID) || undefined), children };
      }
      const result = await collect(row); if (!valid()) return;
      return { filename: buildExportFilename(result.title), content: formatSessionAsMarkdown(result.records, result.title, result.children, locale) };
    });
  }
  const unregisterFolderOwner = registerNativeNewSessionFolderOwner({ owner: { snapshot: () => state, loadFolders, folders }, capture: input.capture, current });
  return { snapshot: () => { state = { ...state, unknown: [...journal.keys()] }; return state; }, loadChildren, loadArchived, loadFolders, folders, loadProjects, reorderProjects, restore, exportMarkdown,
    remove(ids: ReadonlySet<string>) {
      sessionRevision++;
      state = { ...state, children: Object.fromEntries(Object.entries(state.children).map(([key, page]) => [key, { ...page, rows: page.rows.filter(row => !ids.has(row.id)) }])) };
      publish();
    },
    newFolder: (name: string, parentId: string | null = null): SessionFolder => ({ id: `folder_${id()}`, name: name.trim(), parentId, sessionIds: [], createdAt: Date.now() }),
    retry: (key: string) => perform(key, (lane, valid) => reconcile(key, lane, valid)),
    share: () => perform('share', async () => { throw new Error('OpenCode 2: session.share/unshare unavailable'); }),
    pause() { serial++; flights.clear(); state = { ...state, pending: [] }; publish(); },
    dispose() { alive = false; unregisterFolderOwner(); serial++; flights.clear(); },
  };
}
