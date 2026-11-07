import { cleanup, computed, effect, host, lifecycle, List, Overlay, PanResponder, Scroll, signal, Text, untracked, View, type ScrollRef, type ScrollEvent } from 'nsh';
import { AlertDialog, Button, Input, NavPage } from 'nsh/base';
import { NativeSheet as Sheet } from './native-sheet';
import { Icon } from './Icon';
import { t } from './i18n';
import { activeFrom, eventBusy, eventSessionID, list, messagesFrom, nameOf, projectsFrom, record, runtimeEventFrom, text, unwrap, type ChatTarget, type Project, type Session } from './model';
import { query, sessionPath } from './runtime';
import { app, captureHostRequest, createSession, epoch } from './state';
import { createPageOperations } from './page-operations';
import { createProjectsDeletes } from './projects-delete';
import { projectsAttention, projectsInProgress } from './projects-attention';
import { readProjectsBlocking } from './projects-attention-blocking';
import { ProjectsSessionIndicator } from './projects-attention-indicator';
import { resolveMobileSessionIndicator } from '../ui/src/mobile/projects/mobileSessionIndicator';
import { formatSessionChangeCounts, readSessionChangeSummary } from '../ui/src/lib/sessionChangeSummary';
import { createProjectsOrderGesture, type ProjectsOrderGeometry } from './projects-order-gesture';
import { createProjectsSessionDrag, type ProjectsSessionGeometry, type ProjectsSessionDragProjection, type ProjectsOrderScroll } from './projects-order-touch';

export interface ProjectsNavigation {
  onOpenChat: (target: ChatTarget) => void;
  onOpenProject: (project: Project) => void;
  onOpenFiles: (directory: string) => void;
  onOpenChanges: (directory: string) => void;
  onAddProject: () => void;
  onEditProject: (project: Project) => void;
  onNewSession?: (project?: Project) => void;
  onScanQr?: () => void;
  onSwitchInstance?: (id?: string) => void;
  onRemoteDesktop?: () => void;
  onOpenSearch?: () => void;
  onNewWorktree?: (project: Project) => void;
  onWorktreeCreated?: (project: Project, directory: string) => void;
  onOpenArchivedSessions?: () => void;
  activeProjectId?: string;
  instanceOptions?: Array<{ id: string; label: string; active: boolean; disabled: boolean }>;
}
export type ProjectsHomeProps = ProjectsNavigation;
export type ProjectDetailProps = Omit<ProjectsNavigation, 'onOpenProject' | 'onAddProject'> & { project: Project; initialCreateWorktree?: boolean };
type ProjectSession = Session & { pinned: boolean; archived: boolean; activity?: number; created?: number; changes?: string };
type OrderSnapshot = { revision: number; sessionOrderByScope: Record<string, string[]>; sessionOrderActivityByScope: Record<string, Record<string, number>> };
type Page = { sessions: ProjectSession[]; cursor: string | null };
type Bucket = { sessions: ProjectSession[]; cursor: string | null; loaded: boolean; hasMore: boolean };
type Worktree = { path: string; name: string; branch: string };
type WorktreeOrder = { projectDirectory: string; revision: number; orderedPaths: string[] };
const treeOrderRoute = '/api/yuri/message-queue/worktrees/order';
const worktreeArchiveJournals = new Map<string, Map<string, ProjectSession[]>>();
const worktreeRemovalFlights = new Set<string>();
let deletionJournal: { key: string; controller: ReturnType<typeof createProjectsDeletes<ProjectSession>> } | undefined;
function projectsDeleteJournal() {
  const captured = epoch(), hostID = app.connection()?.id, key = JSON.stringify([captured, hostID]);
  if (deletionJournal?.key === key) return deletionJournal.controller;
  deletionJournal?.controller.cancelStale();
  const request = captureHostRequest();
  const controller = createProjectsDeletes<ProjectSession>({
    current: () => captured === epoch() && app.connection()?.id === hostID && !!hostID,
    async remove(row) {
      try {
        const result = unwrap(await request(`/api/session/${encodeURIComponent(row.id)}?${query(row.directory)}`, 'DELETE'));
        if (result !== true) throw new Error(t('sessions.sidebar.session.delete.error'));
      } catch (failure) { if (record(failure).status !== 404) throw failure; }
    },
    committed(rows) { const ids = new Set(rows.map(row => row.id)); app.sessions.set(app.sessions().filter(row => !ids.has(row.id))); },
  });
  deletionJournal = { key, controller }; return controller;
}
function archiveJournal() {
  const connectionID = app.connection()?.id;
  if (!connectionID) throw new Error('Worktree deletion requires a selected connection');
  let journal = worktreeArchiveJournals.get(connectionID);
  if (!journal) { journal = new Map(); worktreeArchiveJournals.set(connectionID, journal); }
  return journal;
}
const normalizePath = (path: string) => path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
function treeOrderFrom(value: unknown, directory: string): WorktreeOrder {
  const row = record(value);
  if (row.projectDirectory !== directory || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !Array.isArray(row.orderedPaths) || !row.orderedPaths.every(path => typeof path === 'string')) throw new Error('Invalid worktree order');
  return row as WorktreeOrder;
}
const quiet = 'min-h-11 px-3 py-2 rounded-xl active:bg-accent items-center justify-center';
const action = `${quiet} bg-secondary`;
const field = 'min-h-12 rounded-xl bg-secondary px-3 py-3 text-foreground';
const shell = 'rounded-3xl border border-border bg-card p-3 gap-2';
const sessionCount = (count: number) => count === 1 ? t('mobile.sessions.project.sessionsSingle') : t('mobile.sessions.project.sessionsPlural', { count });

function sessionFrom(value: unknown, directory = ''): ProjectSession {
  const row = record(value), time = record(row.time);
  const path = text(record(row.location).directory) || text(row.directory) || directory;
  if (!text(row.id) || !path) throw new Error('Invalid session identity');
  return { id: text(row.id), title: text(row.title), directory: path, updated: Number(time.updated) || Number(time.created) || 0,
    parentID: text(row.parentID) || undefined, pinned: !!time.pinned, archived: Number(time.archived) > 0,
    created: Number(time.created) || 0, changes: formatSessionChangeCounts(readSessionChangeSummary(row)) ?? undefined,
    activity: Number(record(record(record(row.metadata).yuri).titleRefresh).activityUpdatedAt) || Number(time.updated) || Number(time.created) || 0 };
}
function orderSnapshot(payload: unknown): OrderSnapshot {
  const value = record(payload), orders = record(value.sessionOrderByScope), activity = record(value.sessionOrderActivityByScope);
  if (!Number.isSafeInteger(value.revision) || Number(value.revision) < 0 || !value.sessionOrderByScope || !value.sessionOrderActivityByScope
    || typeof value.sessionOrderByScope !== 'object' || typeof value.sessionOrderActivityByScope !== 'object'
    || Array.isArray(value.sessionOrderByScope) || Array.isArray(value.sessionOrderActivityByScope)
    || !Object.values(orders).every(ids => Array.isArray(ids) && ids.every(id => typeof id === 'string'))
    || !Object.values(activity).every(entries => entries && typeof entries === 'object' && !Array.isArray(entries) && Object.values(entries).every(time => typeof time === 'number' && Number.isFinite(time)))) throw new Error('Invalid session order snapshot');
  return value as OrderSnapshot;
}
/** Native equivalent of Web's effective drag order: only newer activity promotes saved members. */
export function orderedProjectSessions(rows: ProjectSession[], scope: string, snapshot: OrderSnapshot | null, pinned: string[]): ProjectSession[] {
  const saved = snapshot?.sessionOrderByScope[scope], baseline = snapshot?.sessionOrderActivityByScope[scope];
  const activity = (row: ProjectSession) => row.activity ?? row.updated;
  const natural = [...rows].sort((a, b) => scope === '__pinned__' ? (b.created ?? 0) - (a.created ?? 0) : Number(pinned.includes(b.id)) - Number(pinned.includes(a.id)) || activity(b) - activity(a));
  if (!saved?.length) return natural;
  const ranks = new Map(saved.map((id, rank) => [id, rank]));
  const base = [...natural].sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
  if (scope === '__pinned__' || !baseline) return base;
  const bumped = (row: ProjectSession) => baseline[row.id] === undefined ? !ranks.has(row.id) : activity(row) > baseline[row.id]!;
  return [...base.filter(bumped).sort((a, b) => activity(b) - activity(a)), ...base.filter(row => !bumped(row))];
}
function visibleSession(value: unknown) {
  const row = record(value), yuri = record(record(row.metadata).yuri);
  if (text(row.parentID) || text(row.title) === 'smartfetch-secondary' || /^\[(Scheduled|Assistant|yuri-llm)\]/.test(text(row.title))) return false;
  return record(yuri.assigned).from === 'contact' || ![record(yuri.assistant).assistantID, record(yuri.scheduledTask).taskID, record(yuri.smallModel).purpose, record(yuri.llm).purpose].some(value => !!text(value));
}
export function projectsSessionPage(payload: unknown, directory = ''): Page {
  const value = record(payload);
  if (!Array.isArray(value.data)) throw new Error('Invalid session page');
  return { sessions: value.data.filter(visibleSession).map(row => sessionFrom(row, directory)), cursor: text(record(value.cursor).next) || null };
}
export function projectPathHint(path: string) {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = normalized.split('/').filter(Boolean);
  return parts.length <= 1 ? normalized : parts.length === 2 ? parts[0]! : parts.slice(-3, -1).join('/');
}
function relative(timestamp: number) {
  if (!timestamp) return '';
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000));
  return minutes < 1 ? t('agentManager.sidebar.relativeTime.now') : minutes < 60 ? t('agentManager.sidebar.relativeTime.minutes', { count: minutes }) : minutes < 1440 ? t('agentManager.sidebar.relativeTime.hours', { count: Math.floor(minutes / 60) }) : t('agentManager.sidebar.relativeTime.days', { count: Math.floor(minutes / 1440) });
}
function merge(previous: ProjectSession[], next: ProjectSession[]) {
  const rows = new Map(previous.map(row => [row.id, row]));
  next.forEach(row => rows.set(row.id, row));
  return [...rows.values()].sort((a, b) => b.updated - a.updated);
}

/** Page-owned authority: neither the twenty-row index nor failed reads mean a complete directory. */
export function createProjectsController() {
  const operations = createPageOperations();
  const buckets = signal<Record<string, Bucket>>({}), pins = signal<string[]>([]), running = signal<string[]>([]);
  const worktrees = signal<Record<string, Worktree[]>>({}), error = signal(''), loading = signal(false), pending = signal<string[]>([]);
  const branches = signal<string[]>([]);
  const treeOrders = signal<Record<string, WorktreeOrder>>({}), dirty = signal<Record<string, boolean>>({});
  const remoteDeletes = signal<Array<{ project: Project; tree: Worktree }>>([]);
  const order = signal<OrderSnapshot | null>(null), undoRows = signal<ProjectSession[]>([]);
  const notice = signal('');
  const archiveFailures = signal<ProjectSession[]>([]);
  const archiveOperations = new Map<string, ProjectSession[]>();
  const searchResults = signal<ProjectSession[]>([]), searchMore = signal(false), searching = signal(false);
  const deletes = projectsDeleteJournal();
  const deleteBatches = signal(deletes.batches()), deletedIDs = signal(deletes.hiddenIDs());
  const publishDeletes = () => { deleteBatches.set(deletes.batches()); deletedIDs.set(deletes.hiddenIDs()); };
  const stopDeletes = deletes.observe(publishDeletes);
  const captured = epoch(), hostID = app.connection()?.id;
  const attentionKey = () => JSON.stringify([captured, hostID]);
  const attention = signal(projectsAttention.snapshot(attentionKey()));
  const stopAttention = projectsAttention.observe(attentionKey(), () => attention.set(projectsAttention.snapshot(attentionKey())));
  let alive = true, searchRevision = 0, searchCursor: string | null = null, searchTerm = '';
  let refreshFlight: Promise<void> | undefined, activityRevision = 0, catalogRevision = 0;
  const flights = new Map<string, Promise<void>>();
  const treeOrderFlights = new Map<string, Promise<WorktreeOrder>>(), treeCatalogRevisions = new Map<string, number>();
  const current = () => alive && operations.current();
  const scope = () => { const lane = operations.capture(); return () => alive && lane.current(); };
  operations.onRetire(() => {
    searchRevision++; refreshFlight = undefined; flights.clear(); treeOrderFlights.clear();
    loading.set(false); searching.set(false); pending.set([]);
  });
  const fail = (failure: unknown) => { if (current()) error.set(failure instanceof Error ? failure.message : String(failure)); };
  const sessions = computed(() => {
    const seed = app.sessions().filter(row => !buckets()[row.directory]?.loaded).map(row => ({ ...row, pinned: pins().includes(row.id), archived: false }));
    const retained = deleteBatches().flatMap(batch => batch.rows);
    return merge(retained, merge(seed, Object.values(buckets()).flatMap(bucket => bucket.sessions))).filter(row => !row.archived && !row.parentID && !deletedIDs().has(row.id));
  });
  const byDirectory = computed(() => {
    const index = new Map<string, ProjectSession[]>();
    for (const row of sessions()) { const bucket = index.get(row.directory) ?? []; bucket.push(row); index.set(row.directory, bucket); }
    for (const [directory, rows] of index) index.set(directory, orderedProjectSessions(rows, directory, order(), pins()));
    return index;
  });
  async function loadOrder() {
    const request = operations.capture().request;
    const valid = scope(), value = orderSnapshot(await request('/api/session-folders/order'));
    if (valid() && (!order() || value.revision >= order()!.revision)) order.set(value);
  }
  async function reorder(scopeKey: string, activeID: string, overID: string) {
    const request = operations.capture().request;
    if (!current() || pending().includes(`order:${scopeKey}`) || activeID === overID) return;
    const valid = scope(); error.set(''); pending.set([...pending(), `order:${scopeKey}`]);
    try {
      // Read the shared Host rank before writing so unloaded/hidden ranks are retained.
      await loadOrder(); if (!valid()) return;
      const rows = scopeKey === '__pinned__' ? orderedProjectSessions(sessions().filter(row => pins().includes(row.id)), scopeKey, order(), pins()) : byDirectory().get(scopeKey) ?? [];
      const ids = rows.map(row => row.id), from = ids.indexOf(activeID), to = ids.indexOf(overID);
      if (from < 0 || to < 0) return;
      ids.splice(from, 1); ids.splice(to, 0, activeID);
      const hidden = (order()?.sessionOrderByScope[scopeKey] ?? []).filter(id => !ids.includes(id));
      const activity = scopeKey === '__pinned__' ? {} : Object.fromEntries(rows.map(row => [row.id, row.activity ?? row.updated]));
      const result = orderSnapshot(await request('/api/session-folders/order', 'POST', { scopeKey, order: [...ids, ...hidden], activity, onlyIfAbsent: false }));
      if (valid() && (!order() || result.revision >= order()!.revision)) order.set(result);
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (valid()) pending.set(pending().filter(key => key !== `order:${scopeKey}`)); }
  }
  function removeRows(ids: Set<string>) {
    catalogRevision++;
    const next = { ...buckets() };
    for (const [path, bucket] of Object.entries(next)) next[path] = { ...bucket, sessions: bucket.sessions.filter(item => !ids.has(item.id)) };
    buckets.set(next); pins.set(pins().filter(id => !ids.has(id)));
    app.sessions.set(app.sessions().filter(item => !ids.has(item.id)));
    searchResults.set(searchResults().filter(item => !ids.has(item.id)));
  }
  async function collectSessionTrees(seeds: ProjectSession[]) {
    const request = operations.capture().request;
    const valid = scope(), rows = [...seeds], positions = new Map(rows.map((row, index) => [row.id, index]));
    // A bounded index cannot enumerate descendants. Walk official parent-filtered pages first.
    for (let index = 0; index < rows.length; index++) {
      const parent = rows[index]!; let cursor: string | null = null;
      const cursors = new Set<string>();
      do {
        const result = record(await request(`/api/session?parentID=${encodeURIComponent(parent.id)}&limit=50&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        if (!valid()) return null;
        if (!Array.isArray(result.data)) throw new Error('Invalid child session page');
        for (const value of result.data) {
          const child = sessionFrom(value, parent.directory);
          if (child.parentID !== parent.id) throw new Error('Invalid child session parent');
          const position = positions.get(child.id);
          if (position === undefined) { positions.set(child.id, rows.length); rows.push(child); }
          else {
            if (rows[position]?.parentID !== child.parentID) throw new Error('Invalid cyclic session tree');
            rows[position] = child;
          }
        }
        cursor = text(record(result.cursor).next) || null;
        if (cursor && cursors.has(cursor)) throw new Error('Child session cursor did not advance');
        if (cursor) cursors.add(cursor);
      } while (cursor);
    }
    return rows;
  }
  async function scheduleDelete(root: ProjectSession) {
    if (!current() || pending().includes(root.id) || deletedIDs().has(root.id)) return;
    const valid = scope(); error.set(''); pending.set([...pending(), root.id]);
    try {
      const rows = await collectSessionTrees([root]);
      if (!rows || !valid()) return;
      // Keep the actual records/ranks/pins intact until commit; a mask makes Undo lossless.
      catalogRevision++;
      deletes.schedule(rows);
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (valid()) pending.set(pending().filter(id => id !== root.id)); }
  }
  function markViewed(id: string) { if (current()) projectsAttention.markSessionViewed(attentionKey(), id); }
  function undoDelete(id: string) {
    if (!current()) return false;
    const rows = deletes.batches().find(batch => batch.id === id)?.rows;
    if (!rows || !deletes.undo(id)) return false;
    catalogRevision++;
    const next = { ...buckets() };
    for (const row of rows) {
      const bucket = next[row.directory];
      next[row.directory] = { sessions: merge([row], bucket?.sessions ?? []), cursor: bucket?.cursor ?? null, loaded: bucket?.loaded ?? false, hasMore: bucket?.hasMore ?? true };
    }
    buckets.set(next); return true;
  }
  async function archiveRows(rows: ProjectSession[], onArchived?: (row: ProjectSession) => void) {
    const request = operations.capture().request;
    const valid = scope(), archived: ProjectSession[] = [], failures: unknown[] = [];
    catalogRevision++;
    for (const row of [...rows].reverse()) {
      if (!valid()) return;
      if (row.archived) continue;
      try {
        const result = record(await request(`/api/yuri/sessions/${encodeURIComponent(row.id)}/archive`, 'PUT', { archivedAt: Date.now(), directory: row.directory }));
        if (record(result.session).id !== row.id) throw new Error('Invalid archive response');
        const confirmed = sessionFrom(result.session, row.directory);
        if (!confirmed.archived || normalizePath(confirmed.directory) !== normalizePath(row.directory)) throw new Error('Session archive was not confirmed');
        if (valid()) { archived.push(row); removeRows(new Set([row.id])); onArchived?.(row); }
      } catch (failure) { failures.push(failure); }
    }
    if (!valid()) return;
    if (archived.length) undoRows.set(merge(undoRows(), archived));
    if (failures.length) fail(failures[0]);
    return failures.length === 0;
  }
  async function archiveTree(root: ProjectSession) {
    if (!current() || pending().includes(root.id)) return;
    const valid = scope(); error.set(''); pending.set([...pending(), root.id]);
    try {
      const rows = await collectSessionTrees(archiveOperations.get(root.id) ?? [root]);
      if (!rows || !valid()) return;
      archiveOperations.set(root.id, rows);
      const ok = await archiveRows(rows, archived => { const position = rows.findIndex(row => row.id === archived.id); rows[position] = { ...archived, archived: true }; });
      if (!valid()) return;
      archiveFailures.set(ok ? archiveFailures().filter(row => row.id !== root.id) : [...archiveFailures().filter(row => row.id !== root.id), root]);
      if (ok) archiveOperations.delete(root.id);
      return ok;
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (valid()) pending.set(pending().filter(id => id !== root.id)); }
  }
  async function undoArchive() {
    const request = operations.capture().request;
    if (!current() || pending().includes('undo-archive')) return;
    const valid = scope(); error.set(''); pending.set([...pending(), 'undo-archive']);
    try {
      // Parents first; each restored entity commits independently and failures remain retryable.
      const byID = new Map(undoRows().map(row => [row.id, row]));
      const depth = (row: ProjectSession) => { let count = 0, parent = row.parentID; const seen = new Set<string>(); while (parent && byID.has(parent) && !seen.has(parent)) { seen.add(parent); count++; parent = byID.get(parent)?.parentID; } return count; };
      catalogRevision++;
      for (const row of [...undoRows()].sort((a, b) => depth(a) - depth(b))) {
        if (!valid()) return;
        if (row.parentID && byID.has(row.parentID) && undoRows().some(parent => parent.id === row.parentID)) continue;
        try {
          const result = record(await request(`/api/yuri/sessions/${encodeURIComponent(row.id)}/archive`, 'PUT', { archivedAt: 0, directory: row.directory }));
          const restored = sessionFrom(result.session, row.directory);
          if (restored.id !== row.id || restored.archived) throw new Error('Invalid unarchive response');
          if (!valid()) return;
          catalogRevision++;
          const old = buckets()[restored.directory];
          buckets.set({ ...buckets(), [restored.directory]: { sessions: merge(old?.sessions ?? [], [restored]), cursor: old?.cursor ?? null, loaded: old?.loaded ?? false, hasMore: old?.hasMore ?? true } });
          undoRows.set(undoRows().filter(item => item.id !== row.id));
           const journal = archiveJournal();
           for (const [path, operation] of journal) journal.set(path, operation.map(item => item.id === restored.id ? restored : item));
           for (const [root, operation] of archiveOperations) archiveOperations.set(root, operation.map(item => item.id === restored.id ? restored : item));
           if (!restored.parentID) { archiveOperations.delete(restored.id); archiveFailures.set(archiveFailures().filter(root => root.id !== restored.id)); }
        } catch (failure) { if (valid()) fail(failure); }
      }
    } finally { if (valid()) pending.set(pending().filter(id => id !== 'undo-archive')); }
  }
  async function snapshot() {
    const request = operations.capture().request;
    const valid = scope(), revision = catalogRevision;
    const value = record(await request('/api/yuri/session-index'));
    if (value.available !== true || !Array.isArray(value.directories)) throw new Error('Session index unavailable');
    if (!valid() || revision !== catalogRevision) return;
    const failed = new Set(Array.isArray(record(value.sync).failedDirectories) ? record(value.sync).failedDirectories as string[] : []);
    const next = { ...buckets() };
    for (const directory of list(value.directories)) {
      const path = text(directory.directory); if (!path || failed.has(path) || !Array.isArray(directory.sessions)) continue;
      const head = directory.sessions.filter(visibleSession).map(row => sessionFrom(row, path));
      const old = next[path];
      if (old?.loaded && head.length === 0 && directory.hasMore === true) continue;
      const boundary = head.length ? Math.min(...head.map(row => row.updated)) : 0;
      const tail = old?.loaded ? old.sessions.filter(row => row.updated < boundary) : [];
      next[path] = { sessions: old?.loaded ? merge(tail, head) : head, cursor: old?.cursor ?? null, loaded: old?.loaded ?? false, hasMore: old?.loaded ? old.hasMore : directory.hasMore === true };
    }
    buckets.set(next);
    if (Array.isArray(value.pinnedSessionIds)) pins.set(value.pinnedSessionIds.filter((id): id is string => typeof id === 'string'));
    // Pins outside the bounded index are resolved explicitly; one miss never clears other rows.
    await Promise.allSettled(pins().filter(id => !sessions().some(row => row.id === id)).map(async id => {
      const hit = record(await request(`/api/yuri/session-index/session/${encodeURIComponent(id)}`));
      const row = sessionFrom(hit.session);
      if (!valid() || revision !== catalogRevision) return;
      const old = buckets()[row.directory];
      buckets.set({ ...buckets(), [row.directory]: { sessions: merge(old?.sessions ?? [], [row]), cursor: old?.cursor ?? null, loaded: old?.loaded ?? false, hasMore: old?.hasMore ?? true } });
    }));
  }
  async function refresh() {
    if (!current()) return;
    const request = operations.capture().request;
    const valid = scope();
    if (refreshFlight) return refreshFlight;
    loading.set(true); error.set('');
    const activityAtStart = activityRevision;
    const flight = (async () => {
      const results = await Promise.allSettled([snapshot(), loadOrder(), (async () => {
        const value = unwrap(await request('/api/session/active'));
        if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(item => record(item).type !== 'running')) throw new Error('Invalid active snapshot');
        if (valid() && activityAtStart === activityRevision) running.set(Object.keys(value));
      })()]);
      for (const result of results) if (valid() && result.status === 'rejected') fail(result.reason);
    })();
    refreshFlight = flight;
    try { await flight; } finally { if (valid()) loading.set(false); if (refreshFlight === flight) refreshFlight = undefined; }
  }
  async function loadDirectory(directory: string, reset = false) {
    const request = operations.capture().request;
    if (!current()) return;
    const valid = scope(), revision = catalogRevision;
    if (flights.has(directory)) return flights.get(directory);
    const old = buckets()[directory];
    if (!reset && old?.loaded && !old.hasMore) return;
    pending.set([...pending(), directory]);
    const flight = (async () => {
      try {
        const cursor = reset ? null : old?.cursor;
        const page = projectsSessionPage(await request(`/api/session?${query(directory)}&parentID=null&limit=20&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`), directory);
        if (!valid() || revision !== catalogRevision) return;
        if (page.cursor && page.cursor === cursor) throw new Error('Session cursor did not advance');
        const rows = page.sessions.filter(row => row.directory === directory && !row.archived);
        buckets.set({ ...buckets(), [directory]: { sessions: reset ? rows : merge(buckets()[directory]?.sessions ?? [], rows), loaded: true, cursor: page.cursor, hasMore: !!page.cursor } });
      } catch (failure) { if (valid()) fail(failure); }
      finally { if (valid()) { flights.delete(directory); pending.set(pending().filter(path => path !== directory)); } }
    })();
    flights.set(directory, flight); return flight;
  }
  async function search(term: string, more = false) {
    const lane = operations.capture(), request = lane.request;
    const current = lane.current;
    if (!current()) return;
    const valid = scope(), catalogAtStart = catalogRevision;
    const revision = ++searchRevision; const normalized = term.trim();
    if (!more) { searchTerm = normalized; searchCursor = null; }
    const cursor = more ? searchCursor : null;
    searching.set(true);
    try {
      const page = projectsSessionPage(await request(`/api/session?parentID=null&limit=30&order=desc${normalized ? `&search=${encodeURIComponent(normalized)}` : ''}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
      if (!valid() || catalogAtStart !== catalogRevision || revision !== searchRevision || normalized !== searchTerm) return;
      searchResults.set(more ? merge(searchResults(), page.sessions) : page.sessions);
      searchCursor = page.cursor; searchMore.set(!!page.cursor && cursor !== page.cursor);
    } catch (failure) { if (revision === searchRevision) fail(failure); }
    finally { if (current() && revision === searchRevision) searching.set(false); }
  }
  function cancelSearch() { searchRevision++; searchCursor = null; searchTerm = ''; searching.set(false); }
  async function loadWorktrees(project: Project) {
    const request = operations.capture().request;
    if (!current()) return;
    const valid = scope(), revision = treeCatalogRevisions.get(project.path) ?? 0;
    try {
      const value = await request(`/api/git/worktrees?${query(project.path)}`);
      if (!Array.isArray(value)) throw new Error('Invalid worktree catalog');
      const rows = list(value).map(row => ({ path: text(row.path), name: text(row.name), branch: text(row.branch) })).filter(row => row.path);
      if (valid() && revision === (treeCatalogRevisions.get(project.path) ?? 0)) worktrees.set({ ...worktrees(), [project.path]: rows });
    } catch (failure) { if (valid()) fail(failure); }
    if (valid()) { try { await loadTreeOrder(project); } catch (failure) { if (valid()) fail(failure); } }
  }
  function orderedWorktrees(project: Project) {
    const ranks = new Map((treeOrders()[normalizePath(project.path)]?.orderedPaths ?? []).map((path, index) => [normalizePath(path), index]));
    return (worktrees()[project.path] ?? []).filter(tree => normalizePath(tree.path) !== normalizePath(project.path)).slice().sort((a, b) => (ranks.get(normalizePath(a.path)) ?? Infinity) - (ranks.get(normalizePath(b.path)) ?? Infinity));
  }
  async function loadTreeOrder(project: Project) {
    const request = operations.capture().request;
    const valid = scope(), path = normalizePath(project.path);
    const existing = treeOrderFlights.get(path); if (existing) return existing;
    const flight = (async () => {
      const next = treeOrderFrom(await request(`${treeOrderRoute}?projectDirectory=${encodeURIComponent(path)}`), path);
      if (valid() && (!treeOrders()[path] || next.revision > treeOrders()[path]!.revision)) treeOrders.set({ ...treeOrders(), [path]: next });
      return next;
    })();
    treeOrderFlights.set(path, flight);
    try { return await flight; } finally { if (treeOrderFlights.get(path) === flight) treeOrderFlights.delete(path); }
  }
  async function reorderWorktree(project: Project, active: string, over: string) {
    const request = operations.capture().request;
    const key = `tree-order:${project.path}`;
    if (!current() || pending().includes(key) || active === over) return;
    const valid = scope(); pending.set([...pending(), key]); error.set('');
    try {
      // Read authority first, then rebase a conflicting gesture over the latest revision.
      for (let attempt = 0; attempt < 2; attempt++) {
        const snapshot = await loadTreeOrder(project); if (!valid()) return;
        const paths = orderedWorktrees(project).map(tree => tree.path), from = paths.indexOf(active), to = paths.indexOf(over);
        if (from < 0 || to < 0) return;
        paths.splice(from, 1); paths.splice(to, 0, active);
        const orderedPaths = [...paths, ...snapshot.orderedPaths.filter(path => !paths.some(visible => normalizePath(visible) === normalizePath(path)))];
        try {
          const result = record(await request(treeOrderRoute, 'PUT', { requestID: `nsh-tree-order-${Date.now()}-${Math.random().toString(36).slice(2)}`, projectDirectory: snapshot.projectDirectory, expectedRevision: snapshot.revision, orderedPaths }));
          if (!Number.isSafeInteger(result.revision) || Number(result.revision) < 0) throw new Error('Invalid worktree order result');
          if (valid()) { treeOrderFlights.delete(normalizePath(project.path)); await loadTreeOrder(project); }
          return;
        } catch (failure) { if (!valid()) return; if (record(failure).status !== 409 || attempt === 1) throw failure; }
      }
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (valid()) pending.set(pending().filter(item => item !== key)); }
  }
  async function loadWorktreeStatus(tree: Worktree) {
    const request = operations.capture().request;
    if (!current()) return;
    const valid = scope();
    try {
      const result = record(await request(`/api/git/status?${query(tree.path)}`));
      if (typeof result.isClean !== 'boolean') throw new Error('Invalid worktree status');
      if (valid()) { dirty.set({ ...dirty(), [tree.path]: !result.isClean }); return true; }
    } catch (failure) { if (valid()) fail(failure); }
  }
  async function deleteRemote(project: Project, tree: Worktree) {
    const request = operations.capture().request;
    const key = `remote:${tree.path}`;
    if (!current() || pending().includes(key) || !tree.branch.trim()) return;
    const valid = scope(); pending.set([...pending(), key]);
    try {
      const result = record(await request(`/api/git/remote-branches?${query(project.path)}`, 'DELETE', { branch: tree.branch.replace(/^refs\/heads\//, '').trim() }));
      if (result.success !== true) throw new Error('Remote branch removal failed');
      if (valid()) { remoteDeletes.set(remoteDeletes().filter(item => item.tree.path !== tree.path)); return true; }
    } catch (failure) { if (valid()) { fail(failure); if (!remoteDeletes().some(item => item.tree.path === tree.path)) remoteDeletes.set([...remoteDeletes(), { project, tree }]); } }
    finally { if (valid()) pending.set(pending().filter(item => item !== key)); }
  }
  async function mutate(row: ProjectSession, kind: 'pin' | 'archive' | 'stop' | 'delete' | 'rename', title?: string) {
    const request = operations.capture().request;
    if (kind === 'archive') return archiveTree(row);
    if (kind === 'delete') return scheduleDelete(row);
    if (!current() || pending().includes(row.id)) return;
    const valid = scope();
    error.set(''); pending.set([...pending(), row.id]);
    try {
      if (kind === 'pin') {
        const pinned = pins().includes(row.id);
        await request(`/api/yuri/session-index/session/${encodeURIComponent(row.id)}/pin`, pinned ? 'DELETE' : 'POST');
        if (valid()) pins.set(pinned ? pins().filter(id => id !== row.id) : [...pins(), row.id]);
      } else if (kind === 'stop') {
        await request(`${sessionPath(row.id, 'interrupt')}?${query(row.directory)}`, 'POST', {});
        if (valid()) await refresh();
      } else if (kind === 'rename') {
        if (!title?.trim()) return;
        const metadata = record(await request(`/api/yuri/sessions/${encodeURIComponent(row.id)}/metadata`, 'PUT', { directory: row.directory, patch: { yuri: {
          titleAuthority: { sessionID: row.id, title: title.trim(), revision: `nsh-title-${Date.now()}-${Math.random().toString(36).slice(2)}`, source: 'manual' },
          titleRefresh: { activityUpdatedAt: row.activity ?? row.updated, isGenerating: null, requestedAt: null, lastError: null, failedAt: null },
        } } }));
        if (!valid()) return;
        if (!metadata.metadata || typeof metadata.metadata !== 'object' || Array.isArray(metadata.metadata)) throw new Error('Invalid metadata response');
        await request(`/api/session/${encodeURIComponent(row.id)}`, 'PATCH', { title: title.trim() });
        if (!valid()) return;
        const next = { ...buckets() };
        for (const [path, bucket] of Object.entries(next)) next[path] = { ...bucket, sessions: bucket.sessions.map(item => item.id === row.id ? { ...item, title: title.trim() } : item) };
        buckets.set(next);
        app.sessions.set(app.sessions().map(item => item.id === row.id ? { ...item, title: title.trim() } : item));
        searchResults.set(searchResults().map(item => item.id === row.id ? { ...item, title: title.trim() } : item));
        return true;
      }
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (valid()) pending.set(pending().filter(id => id !== row.id)); }
  }
  async function loadBranches(project: Project) {
    const request = operations.capture().request;
    if (!current()) return;
    const valid = scope();
    try {
      const value = record(await request(`/api/git/branches?${query(project.path)}`));
      if (!Array.isArray(value.all)) throw new Error('Invalid branch catalog');
      if (valid()) branches.set(value.all.filter((branch): branch is string => typeof branch === 'string'));
    } catch (failure) { if (valid()) fail(failure); }
  }
  async function loadRepository(project: Project) {
    const request = operations.capture().request;
    if (!current()) return;
    const valid = scope();
    try {
      const result = record(await request(`/api/git/check?${query(project.path)}`));
      if (typeof result.isGitRepository !== 'boolean') throw new Error('Invalid repository status');
      if (valid()) return result.isGitRepository;
    } catch (failure) { if (valid()) fail(failure); }
  }
  async function smartTitle(row: ProjectSession) {
    const request = operations.capture().request;
    if (!current() || pending().includes(row.id)) return;
    const valid = scope(); error.set(''); pending.set([...pending(), row.id]);
    try {
      const titleRefresh = { ...(row.title.trim() ? { lastAutoTitle: row.title.trim() } : {}), requestedAt: Date.now(), isGenerating: null, lastError: null, failedAt: null };
      const result = record(await request(`/api/yuri/sessions/${encodeURIComponent(row.id)}/metadata`, 'PUT', { directory: row.directory, patch: { yuri: { titleRefresh } } }));
      if (!result.metadata || typeof result.metadata !== 'object' || Array.isArray(result.metadata)) throw new Error('Invalid metadata response');
      if (valid()) return true;
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (valid()) pending.set(pending().filter(id => id !== row.id)); }
  }
  async function syncMessages(row: ProjectSession) {
    const request = operations.capture().request;
    if (!current() || running().includes(row.id) || pending().includes(row.id)) return;
    const valid = scope(); error.set(''); pending.set([...pending(), row.id]);
    try {
      if (activeFrom(await request('/api/session/active'), row.id)) throw new Error(t('sessions.sidebar.session.status.active'));
      if (!valid()) return;
      // Native chats read authority on revisit; there is no separate browser transcript cache to clear.
      messagesFrom(await request(`${sessionPath(row.id, 'message')}?${query(row.directory)}&limit=20&order=desc`), false);
      if (valid()) notice.set(t('sessions.sidebar.session.menu.refreshTranscriptSuccess'));
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (valid()) pending.set(pending().filter(id => id !== row.id)); }
  }
  async function updateProjectCatalog(kind: 'close' | 'reorder', projectID: string, overID?: string) {
    const request = operations.capture().request;
    if (!current() || pending().includes('project-catalog')) return;
    const valid = scope(); error.set(''); pending.set([...pending(), 'project-catalog']);
    try {
      const settings = record(unwrap(await request('/api/config/settings')));
      if (!Array.isArray(settings.projects)) throw new Error('Invalid project catalog');
      if (!valid()) return;
      let projects = list(settings.projects);
      const from = projects.findIndex(project => project.id === projectID);
      if (from < 0) return;
      const label = text(projects[from]?.label) || text(projects[from]?.name) || nameOf(text(projects[from]?.path));
      if (kind === 'close') projects = projects.filter(project => project.id !== projectID);
      else { const to = projects.findIndex(project => project.id === overID); if (to < 0 || to === from) return; const [moved] = projects.splice(from, 1); projects.splice(to, 0, moved!); }
      const activeProjectId = projects.some(project => project.id === settings.activeProjectId) ? settings.activeProjectId : projects[0]?.id;
      const result = record(unwrap(await request('/api/config/settings', 'PUT', { projects, ...(activeProjectId ? { activeProjectId } : {}) })));
      if (!Array.isArray(result.projects)) throw new Error('Invalid saved project catalog');
      if (valid()) { app.projects.set(projectsFrom(result)); notice.set(kind === 'close' ? t('mobile.sessions.toast.projectRemoved', { label }) : ''); return true; }
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (valid()) pending.set(pending().filter(key => key !== 'project-catalog')); }
  }
  async function syncProject(project: Project) {
    const request = operations.capture().request;
    if (!current()) return;
    const valid = scope();
    await loadWorktrees(project); if (!valid()) return;
    const directories = [project.path, ...(worktrees()[project.path] ?? []).map(tree => tree.path)];
    try { await request('/api/yuri/session-index/sync', 'POST', { directories: [...new Set(directories)] }); if (valid()) await refresh(); }
    catch (failure) { if (valid()) fail(failure); }
  }
  async function removeWorktree(project: Project, tree: Worktree, deleteLocalBranch: boolean, deleteRemoteBranch = false) {
    const request = operations.capture().request;
    if (!current() || normalizePath(tree.path) === normalizePath(project.path) || pending().includes(tree.path)) return;
    const connectionID = app.connection()?.id;
    if (!connectionID) { fail(new Error('Worktree deletion requires a selected connection')); return; }
    const operationFlight = JSON.stringify([connectionID, normalizePath(tree.path)]);
    if (worktreeRemovalFlights.has(operationFlight)) { fail(new Error('Worktree deletion is already pending')); return; }
    worktreeRemovalFlights.add(operationFlight);
    const valid = scope(); pending.set([...pending(), tree.path]); error.set('');
    try {
      // Enumerate every root page before archiving; a bounded sidebar is not a deletion inventory.
      const roots: ProjectSession[] = []; let cursor: string | null = null; const seen = new Set<string>();
      do {
        const page = record(await request(`/api/session?${query(tree.path)}&parentID=null&limit=50&order=desc${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`));
        if (!valid()) return;
        if (!Array.isArray(page.data)) throw new Error('Invalid worktree session catalog');
        for (const value of page.data) { const row = sessionFrom(value, tree.path); if (normalizePath(row.directory) !== normalizePath(tree.path) || row.parentID) throw new Error('Invalid worktree session scope'); roots.push(row); }
        cursor = text(record(page.cursor).next) || null;
        if (cursor && seen.has(cursor)) throw new Error('Worktree session cursor did not advance');
        if (cursor) seen.add(cursor);
      } while (cursor);
      const operationKey = normalizePath(tree.path);
      const worktreeArchiveOperations = archiveJournal();
      const seeds = new Map((worktreeArchiveOperations.get(operationKey) ?? []).map(row => [row.id, row]));
      for (const root of roots) seeds.set(root.id, root);
      const operation = await collectSessionTrees([...seeds.values()]);
      if (!valid() || !operation) return;
      if (operation.some(row => normalizePath(row.directory) !== normalizePath(tree.path))) throw new Error('Invalid worktree descendant scope');
      // Retain the complete inventory until directory removal commits, including failed children of archived parents.
      worktreeArchiveOperations.set(operationKey, operation);
      const positions = new Map(operation.map((row, index) => [row.id, index]));
      if (!await archiveRows(operation, row => { operation[positions.get(row.id)!] = { ...row, archived: true }; })) return;
      if (!valid()) return;
      const removed = record(await request(`/api/git/worktrees?${query(project.path)}`, 'DELETE', { directory: tree.path, deleteLocalBranch: !!tree.branch.trim() && deleteLocalBranch }));
      if (removed.success !== true) throw new Error('Worktree removal failed');
      if (!valid()) return;
      worktreeArchiveOperations.delete(operationKey);
      treeCatalogRevisions.set(project.path, (treeCatalogRevisions.get(project.path) ?? 0) + 1);
      worktrees.set({ ...worktrees(), [project.path]: (worktrees()[project.path] ?? []).filter(row => row.path !== tree.path) });
      if (deleteRemoteBranch && tree.branch.trim()) await deleteRemote(project, tree);
      if (!valid()) return;
      await loadWorktrees(project); return valid();
    } catch (failure) { if (valid()) fail(failure); }
    finally { worktreeRemovalFlights.delete(operationFlight); if (valid()) pending.set(pending().filter(path => path !== tree.path)); }
  }
  async function createWorktree(project: Project, branch: string, folder: string, startRef: string, mode: 'new' | 'existing' = 'new') {
    const request = operations.capture().request;
    if (!current() || pending().includes('worktree')) return;
    const valid = scope();
    pending.set([...pending(), 'worktree']);
    try {
      const body = { mode, ...(mode === 'new' ? { branchName: branch.trim() } : { existingBranch: branch.trim() }), worktreeName: folder.trim(), ...(mode === 'new' && startRef.trim() ? { startRef: startRef.trim() } : {}) };
      const validation = record(await request(`/api/git/worktrees/validate?${query(project.path)}`, 'POST', body));
      if (!valid()) return;
      if (validation.ok !== true) throw new Error(list(validation.errors).map(row => text(row.message)).join('\n') || t('session.newWorktree.error.createWorktreeFailed'));
      const created = record(await request(`/api/git/worktrees?${query(project.path)}`, 'POST', body));
      if (!text(created.path)) throw new Error('Invalid created worktree');
      if (valid()) { treeCatalogRevisions.set(project.path, (treeCatalogRevisions.get(project.path) ?? 0) + 1); await loadWorktrees(project); if (valid()) return text(created.path); }
    } catch (failure) { if (valid()) fail(failure); }
    finally { if (valid()) pending.set(pending().filter(id => id !== 'worktree')); }
  }
  let timer: ReturnType<typeof setTimeout> | undefined, treeOrderTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = host.on('runtime.event', payload => {
    if (!current() || lifecycle() !== 'active') return;
    const event = runtimeEventFrom(payload); if (!event) return;
    const busy = eventBusy(event), id = eventSessionID(event);
    if (id && busy !== undefined) { activityRevision++; if (busy !== running().includes(id)) running.set(busy ? [...running(), id] : running().filter(item => item !== id)); }
    if (event.key === 'global' && ['yuri:message-queue-changed', 'reconnected'].includes(event.type) && !treeOrderTimer) {
      treeOrderTimer = setTimeout(() => {
        treeOrderTimer = undefined;
        if (!current() || lifecycle() !== 'active') return;
        const valid = scope();
        void (async () => { const paths = Object.keys(worktrees()); for (let i = 0; i < paths.length && valid(); i += 2) await Promise.all(paths.slice(i, i + 2).map(path => loadTreeOrder({ id: path, path, name: path }).catch(failure => { if (valid()) fail(failure); }))); })();
      }, 120);
    }
    if (event.key === 'global' && event.type === 'yuri:message-queue-changed') {
      return;
    }
    if (event.key === 'global' && event.type === 'yuri:session-order-changed') { const valid = scope(); void loadOrder().catch(failure => { if (valid()) fail(failure); }); return; }
    if (event.key !== 'global' || !['reconnected', 'yuri:session-index-changed'].includes(event.type) || timer) return;
    timer = setTimeout(() => { timer = undefined; if (current()) void refresh(); }, record(event.body.sync).active ? 1000 : 120);
  });
  const dispose = () => { alive = false; searchRevision++; stop(); stopDeletes(); stopAttention(); if (timer) clearTimeout(timer); if (treeOrderTimer) clearTimeout(treeOrderTimer); };
  cleanup(dispose);
  return { buckets, pins, running, worktrees, branches, order, treeOrders, dirty, remoteDeletes, orderedWorktrees, loadTreeOrder, reorderWorktree, loadWorktreeStatus, deleteRemote, undoRows, archiveFailures, deleteBatches, undoDelete, retryDelete: (id: string) => deletes.retry(id), attention, markViewed, notice, error, loading, pending, sessions, byDirectory, searchResults: () => searchResults().filter(row => !deletedIDs().has(row.id)), searchMore, searching, current, refresh, loadOrder, reorder, undoArchive, smartTitle, syncMessages, updateProjectCatalog, syncProject, loadDirectory, search, cancelSearch, loadWorktrees, loadBranches, loadRepository, removeWorktree, mutate, createWorktree, dispose };
}
type Controller = ReturnType<typeof createProjectsController>;

function WorktreeRow(props: { project: Project; tree: Worktree; controller: Controller; geometry?: ProjectsOrderGeometry; expanded?: boolean; onSelect: () => void; onNewSession: () => void; onRemoved?: () => void }) {
  const offset = signal(0), deleting = signal(false), local = signal(false), remote = signal(false), checked = signal(false), dragOffset = signal(0);
  let start = 0, suppress = false, checkRevision = 0;
  effect(() => { app.connection(); untracked(() => { checkRevision++; checked.set(false); deleting.set(false); offset.set(0); }); });
  const rows = () => props.controller.orderedWorktrees(props.project);
  const pending = () => props.controller.pending().includes(props.tree.path);
  const pan = PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => !pending() && Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderGrant: () => { start = offset(); suppress = true; },
    onPanResponderMove: (_, g) => offset.set(Math.max(-112, Math.min(0, start + g.dx))),
    onPanResponderRelease: () => offset.set(offset() < -39 ? -112 : 0),
    onPanResponderTerminate: () => offset.set(start),
  });
  const gesture = props.geometry ? createProjectsOrderGesture({
    id: props.tree.path, ids: () => rows().map(row => row.path), geometry: props.geometry,
    current: () => props.controller.current() && !props.controller.pending().includes(`tree-order:${props.project.path}`), generation: epoch,
    offset: value => dragOffset.set(value), started: () => { suppress = true; },
    commit: over => { void props.controller.reorderWorktree(props.project, props.tree.path, over); },
  }) : undefined;
  const drag = gesture ? PanResponder.create(gesture.handlers) : undefined;
  cleanup(() => { gesture?.cancel(); props.geometry?.delete(props.tree.path); });
  const check = async () => { const revision = ++checkRevision; checked.set(false); const result = await props.controller.loadWorktreeStatus(props.tree); if (props.controller.current() && revision === checkRevision) checked.set(result === true); };
  const openDelete = () => { offset.set(0); local.set(false); remote.set(false); deleting.set(true); void check(); };
  const menu = async () => {
    const started = epoch();
    const result = await AlertDialog.show({ title: props.tree.branch || props.tree.name, presentation: 'actionSheet', actions: [
      { id: 'new', label: t('mobile.sessions.startNewChat') },
      { id: 'delete', label: t('mobile.projectEdit.deleteWorktreeConfirmButton'), role: 'destructive' },
      { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
    ] });
    if (!props.controller.current() || started !== epoch()) return;
    if (result.action === 'new') props.onNewSession();
    if (result.action === 'delete') openDelete();
  };
  return <View class="gap-1" style={{ transform: [{ translateY: dragOffset() }], zIndex: dragOffset() ? 1 : 0 }}>
    <View class="overflow-hidden rounded-xl">
      <If when={offset() < 0}><View class="absolute right-0 top-0 bottom-0 flex-row" style={{ width: 112 }}>
        <Button class="flex-1 bg-secondary items-center justify-center" onPress={() => { offset.set(0); props.onNewSession(); }} accessibilityLabel={t('mobile.sessions.newSessionAria')}><Icon name="add" size={18} /></Button>
        <Button class="flex-1 bg-muted items-center justify-center" disabled={pending()} onPress={openDelete} accessibilityLabel={t('mobile.projectEdit.deleteWorktreeAria', { label: props.tree.branch || props.tree.name })}><Icon name="delete-bin" size={18} /></Button>
      </View></If>
      <View ref={node => props.geometry?.set(props.tree.path, node)} {...pan.panHandlers} class="flex-row items-center bg-card" style={{ transform: [{ translateX: offset() }], height: 56 }} onLongPress={() => { suppress = true; void menu(); }}>
        <If when={!!drag}><View testID={`project-worktree-drag-${props.tree.path}`} {...drag?.panHandlers} class="min-w-11 min-h-11 items-center justify-center" accessibilityLabel={t('mobile.projectEdit.dragWorktreeAria', { label: props.tree.branch || props.tree.name })}><Icon name="drag-move-2" size={15} /></View></If>
        <Button testID={`project-worktree-${props.tree.path}`} class={`flex-1 flex-row gap-2 ${quiet}`} onPress={() => { if (suppress) { suppress = false; return; } if (offset()) { offset.set(0); return; } props.onSelect(); }}><Icon name="git-branch" size={15} /><Text class="flex-1 text-sm text-foreground" style={{ numberOfLines: 1 }}>{props.tree.branch || props.tree.name}</Text><If when={props.expanded !== undefined}><Text class="text-xs text-muted-foreground">{sessionCount(props.controller.byDirectory().get(props.tree.path)?.length ?? 0)}</Text><Icon name={props.expanded ? 'arrow-down-s' : 'arrow-right-s'} size={14} /></If></Button>
        <Button class={quiet} accessibilityLabel={t('sessions.sidebar.project.actions.projectMenu')} onPress={() => { void menu(); }}><Icon name="more-2" size={16} /></Button>
      </View>
    </View>
    <Sheet open={deleting()} closeOnSwipe={!pending()} closeOnBackdropPress={!pending()} closeOnEscape={!pending()} onOpenChange={event => { if (!pending()) { deleting.set(event.open); if (!event.open) checkRevision++; } }} popupClass="bg-background rounded-t-3xl p-5 gap-3">
      <Text class="text-xl font-semibold text-foreground">{t('mobile.projectEdit.deleteWorktreeTitle')}</Text>
      <Text class="text-sm text-muted-foreground">{t('mobile.projectEdit.deleteWorktreeConfirm', { name: props.tree.branch || props.tree.name })}</Text>
      <If when={props.controller.dirty()[props.tree.path]}><Text class="text-sm text-foreground">{t('mobile.projectEdit.deleteWorktreeDirty')}</Text></If>
      <If when={props.controller.byDirectory().get(props.tree.path)?.length}><Text class="text-sm text-muted-foreground">{t('mobile.projectEdit.deleteWorktreeArchiveNote', { count: props.controller.byDirectory().get(props.tree.path)?.length ?? 0 })}</Text></If>
      <If when={!!props.tree.branch.trim()}><View><Button class={quiet} disabled={pending()} onPress={() => local.set(!local())}><Text class="text-foreground">{t('mobile.projectEdit.deleteLocalBranch')}{local() ? ' ✓' : ''}</Text></Button><Button class={quiet} disabled={pending()} onPress={() => remote.set(!remote())}><Text class="text-foreground">{t('mobile.projectEdit.deleteRemoteBranch')}{remote() ? ' ✓' : ''}</Text></Button></View></If>
      <If when={props.controller.error()}><Text class="text-sm text-destructive">{props.controller.error()}</Text></If>
      <If when={!checked()}><Button class={quiet} onPress={() => { void check(); }}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button></If>
      <Button class={action} disabled={!checked() || pending()} onPress={() => { void (async () => { if (await props.controller.removeWorktree(props.project, props.tree, local(), remote())) { deleting.set(false); props.onRemoved?.(); } })(); }}><Text class="text-destructive">{t('mobile.projectEdit.deleteWorktreeConfirmButton')}</Text></Button>
      <Button class={quiet} disabled={pending()} onPress={() => { checkRevision++; deleting.set(false); }}><Text class="text-muted-foreground">{t('gitView.common.cancel')}</Text></Button>
    </Sheet>
  </View>;
}

function RemoteDeleteRetries(props: { controller: Controller }) {
  return <View><Each of={props.controller.remoteDeletes()}>{item => <Button class={action} disabled={props.controller.pending().includes(`remote:${item().tree.path}`)} onPress={() => { void props.controller.deleteRemote(item().project, item().tree); }}><Text class="text-destructive">{t('mobile.projectEdit.deleteRemoteBranch')} · {item().tree.branch}</Text></Button>}</Each></View>;
}

function ArchiveUndo(props: { controller: Controller; onOpenArchivedSessions?: () => void }) {
  return <View class="gap-2"><Each of={props.controller.deleteBatches()}>{batch => <View class="gap-1 rounded-2xl bg-secondary px-3 py-2">
    <Text class="text-sm text-foreground">{batch().phase === 'failed' ? t('sessions.sidebar.session.delete.error') : batch().rows.length === 1 ? t('sessions.sidebar.session.delete.success') : t('sessions.sidebar.bulkActions.deletedPlural', { count: batch().rows.length })}</Text>
    <If when={batch().phase === 'failed'}><Text class="text-sm text-destructive">{batch().error}</Text></If>
    <Button testID={`projects-delete-${batch().phase}-${batch().id}`} class={quiet} disabled={batch().phase === 'committing'} onPress={() => { if (batch().phase === 'undo') props.controller.undoDelete(batch().id); else if (batch().phase === 'failed') void props.controller.retryDelete(batch().id); }}><Text class="text-foreground">{t(batch().phase === 'undo' ? 'sessions.sidebar.undo' : batch().phase === 'failed' ? 'layout.browserProvider.retry' : 'common.loading')}</Text></Button>
  </View>}</Each><Each of={props.controller.archiveFailures()}>{row => <Button class={action} disabled={props.controller.pending().includes(row().id)} onPress={() => { void props.controller.mutate(row(), 'archive'); }}><Text class="text-foreground">{t('sessions.sidebar.bulkActions.archive')} · {row().title} · {t('layout.browserProvider.retry')}</Text></Button>}</Each><If when={props.controller.undoRows().length > 0}><View class="flex-row items-center gap-2 bg-secondary rounded-2xl px-3 py-2">
    <Text class="flex-1 text-sm text-foreground">{t('sessions.sidebar.session.archive.success')}</Text>
    <Button class={quiet} disabled={props.controller.pending().includes('undo-archive')} onPress={() => { void props.controller.undoArchive(); }}><Text class="text-foreground">{t('sessions.sidebar.undo')}</Text></Button>
    <If when={props.onOpenArchivedSessions}><Button class={quiet} onPress={() => props.onOpenArchivedSessions?.()}><Text class="text-foreground">{t('settings.yuri.archivedSessions.actions.view')}</Text></Button></If>
  </View></If></View>;
}
function createProjectsScroll() {
  const dragging = signal(false);
  let node: ScrollRef | undefined, offset = 0, maximum = 0;
  const drag: ProjectsOrderScroll = {
    viewport: async () => { const measured = await node?.measure(); return measured ? { top: measured.pagePosition.y, height: measured.bounds.size.height } : null; },
    offset: () => offset, max: () => maximum,
    scrollTo: y => node?.scrollTo({ y, animated: false }),
    claim() { if (dragging()) return null; dragging.set(true); let released = false; return () => { if (!released) { released = true; dragging.set(false); } }; },
  };
  return { drag, dragging, ref: (ref: ScrollRef) => { node = ref; }, onScroll: (event: ScrollEvent) => { offset = Math.max(0, event.offset.y); maximum = Math.max(0, event.contentSize.height - event.size.height); } };
}
type ProjectsScroll = ReturnType<typeof createProjectsScroll>;

function ProjectsSessionGroup(props: { controller: Controller; scope: string; rows: () => ProjectSession[]; scroll: ProjectsScroll; onOpen: ProjectsNavigation['onOpenChat']; subtitle?: (row: ProjectSession) => string }) {
  const geometry: ProjectsSessionGeometry = new Map();
  const overlay = signal<ProjectsSessionDragProjection | null>(null), draggedID = signal<string | null>(null), shifts = signal<ReadonlyMap<string, number>>(new Map());
  const draggedTitle = computed(() => props.rows().find(row => row.id === draggedID())?.title ?? '');
  const ids = () => props.rows().map(row => row.id);
  const drag = createProjectsSessionDrag({ ids, geometry, scroll: props.scroll.drag, generation: epoch,
    current: () => props.controller.current() && !props.controller.pending().includes(`order:${props.scope}`),
    changed(value) { overlay.set(value); if (draggedID() !== (value?.id ?? null)) draggedID.set(value?.id ?? null); if (shifts() !== value?.shifts) shifts.set(value?.shifts ?? new Map()); },
    commit: (active, over) => { void props.controller.reorder(props.scope, active, over); },
  });
  effect(() => { const members = ids(), current = props.controller.current(); epoch(); untracked(() => { const retained = new Set(members); for (const id of geometry.keys()) if (!retained.has(id)) geometry.delete(id); if (!current) drag.cancel(); else drag.reconcile(members); }); });
  cleanup(() => { drag.dispose(); geometry.clear(); });
  return <View testID={`projects-session-group-${props.scope}`} class="gap-1">
    <Each of={props.rows()}>{row => <View ref={ref => geometry.set(row().id, ref)} style={{ opacity: draggedID() === row().id ? .3 : 1, transform: [{ translateY: shifts().get(row().id) ?? 0 }], transitionProperty: 'transform', transitionDuration: draggedID() ? 200 : 0 }}>
      <SessionRow row={row()} controller={props.controller} onOpen={props.onOpen} subtitle={props.subtitle?.(row())} drag={drag} dragScope={props.scope} />
    </View>}</Each>
    <If when={overlay() !== null}><Overlay testID={`projects-session-drag-overlay-${props.scope}`} onCancel={drag.cancel} style={{ position: 'absolute', top: overlay()?.y ?? 0, left: overlay()?.x ?? 0, width: overlay()?.width ?? 0, height: overlay()?.height ?? 0, pointerEvents: 'none' }}>
      <View class="flex-1 flex-row items-center gap-2 rounded-lg border border-border bg-card px-3"><Icon name="chat-thread" size={16} /><Text class="flex-1 text-sm text-foreground" style={{ numberOfLines: 1 }}>{draggedTitle()}</Text></View>
    </Overlay></If>
  </View>;
}

function SessionRow(props: { row: ProjectSession; controller: Controller; onOpen: (target: ChatTarget) => void; subtitle?: string; drag?: ReturnType<typeof createProjectsSessionDrag>; dragScope?: string }) {
  const offset = signal(0), renaming = signal(false), title = signal(props.row.title); let start = 0, swiped = false;
  const indicator = () => resolveMobileSessionIndicator({ ...readProjectsBlocking(props.controller.attention().blockingByDirectory, props.row.directory, props.row.id), running: props.controller.running().includes(props.row.id), unread: (props.controller.attention().unseenBySession[props.row.id] ?? 0) > 0 });
  const pinLabel = () => t(props.controller.pins().includes(props.row.id) ? 'sessions.sidebar.session.menu.unpin' : 'sessions.sidebar.session.menu.pin');
  const pan = PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => !props.drag?.claimed(props.row.id) && Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy),
    onPanResponderGrant: () => { start = offset(); swiped = true; },
    onPanResponderMove: (_, g) => offset.set(Math.max(-112, Math.min(0, start + g.dx))),
    onPanResponderRelease: () => offset.set(offset() < -39 ? -112 : 0),
    onPanResponderTerminate: () => offset.set(start),
  });
  const mutate = (kind: 'pin' | 'archive') => { offset.set(0); void props.controller.mutate(props.row, kind); };
  async function menu() {
    props.drag?.cancel();
    const started = epoch();
    const result = await AlertDialog.show({ title: props.row.title, presentation: 'actionSheet', actions: [
      { id: 'rename', label: t('sessions.sidebar.session.menu.rename') }, { id: 'pin', label: pinLabel() },
      ...(props.controller.running().includes(props.row.id) ? [{ id: 'stop', label: t('mobile.sessions.stopSessionAria', { title: props.row.title }) }] : []),
      ...(!props.controller.running().includes(props.row.id) ? [{ id: 'sync', label: t('sessions.sidebar.session.menu.refreshTranscript') }] : []),
      { id: 'archive', label: t('sessions.sidebar.bulkActions.archive'), role: 'destructive' },
      { id: 'delete', label: t('sessions.sidebar.dialogs.deleteSession.titleAction'), role: 'destructive' },
      { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
    ] });
    if (!props.controller.current() || started !== epoch()) return;
    if (result.action === 'pin' || result.action === 'archive') mutate(result.action);
    if (result.action === 'rename') { title.set(props.row.title); renaming.set(true); }
    if (result.action === 'stop') void props.controller.mutate(props.row, 'stop');
    if (result.action === 'sync') void props.controller.syncMessages(props.row);
    if (result.action === 'delete') {
      const confirmed = await AlertDialog.show({ title: t('sessions.sidebar.dialogs.deleteSession.title'), description: t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: props.row.title }), actions: [{ id: 'delete', label: t('sessions.sidebar.dialogs.deleteSession.titleAction'), role: 'destructive' }, { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' }] });
      if (confirmed.action === 'delete' && props.controller.current() && started === epoch()) void props.controller.mutate(props.row, 'delete');
    }
  }
  return <View class="overflow-hidden rounded-xl">
    <If when={offset() < 0}><View class="absolute right-0 top-0 bottom-0 flex-row" style={{ width: 112 }}>
      <Button class="flex-1 bg-secondary items-center justify-center gap-1" disabled={props.controller.pending().includes(props.row.id)} onPress={() => mutate('pin')}><Icon name="pushpin" size={17} /><Text class="text-xs text-foreground">{pinLabel()}</Text></Button>
      <Button class="flex-1 bg-muted items-center justify-center gap-1" disabled={props.controller.pending().includes(props.row.id)} onPress={() => mutate('archive')}><Icon name="archive" size={17} /><Text class="text-xs text-destructive">{t('sessions.sidebar.bulkActions.archive')}</Text></Button>
    </View></If>
    <View {...pan.panHandlers} class={`flex-row items-center min-h-12 ${props.controller.attention().currentSessionID === props.row.id ? 'bg-accent' : 'bg-card'}`} style={{ transform: [{ translateX: offset() }] }}>
      <View testID={`project-session-touch-${props.dragScope ?? 'plain'}-${props.row.id}`} class="flex-1"
        onTouchStartCapture={event => props.drag?.start(props.row.id, event)} onTouchMoveCapture={event => props.drag?.move(props.row.id, event)} onTouchEndCapture={event => props.drag?.finish(props.row.id, event)} onTouchCancelCapture={() => props.drag?.cancel()}
        onMoveShouldSetResponderCapture={() => props.drag?.claimed(props.row.id) ?? false} onResponderGrant={() => props.drag?.claimed(props.row.id) ?? false}
        onResponderMove={event => props.drag?.move(props.row.id, event)} onResponderRelease={event => props.drag?.finish(props.row.id, event)} onResponderTerminate={() => props.drag?.cancel()} onResponderTerminationRequest={() => !props.drag?.claimed(props.row.id)}>
      <Button testID={`project-session-${props.row.id}`} class="flex-1 flex-row items-center gap-2 px-3 py-3 min-h-12" onPressDown={() => { if (!props.drag?.claimed(props.row.id)) swiped = false; }} onPress={() => {
        if (props.drag?.consumeClick(props.row.id)) return;
        if (swiped) { swiped = false; return; } if (offset()) { offset.set(0); return; } props.controller.markViewed(props.row.id); props.onOpen({ kind: 'session', ...props.row });
      }}>
        <ProjectsSessionIndicator indicator={indicator()} sessionID={props.row.id} />
        <View class="flex-1 gap-1"><Text class={`text-sm font-medium ${props.controller.attention().currentSessionID === props.row.id ? 'text-primary' : 'text-foreground'}`} style={{ numberOfLines: 1 }}>{props.row.title || t('mobile.sessions.untitled')}</Text><If when={props.subtitle}><Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{props.subtitle}</Text></If><If when={props.row.changes}><Text class="text-xs text-muted-foreground">{props.row.changes}</Text></If></View>
        <Text class="text-xs text-muted-foreground">{relative(props.row.updated)}</Text>
      </Button>
      </View>
      <Button testID={`project-session-menu-${props.row.id}`} class="min-h-11 min-w-9 items-center justify-center" accessibilityLabel={t('sessions.sidebar.session.menu.label')} onPress={() => { void menu(); }}><Icon name="more-2" size={16} /></Button>
    </View>
    <Sheet open={renaming()} closeOnSwipe={!props.controller.pending().includes(props.row.id)} closeOnEscape={!props.controller.pending().includes(props.row.id)} closeOnBackdropPress={!props.controller.pending().includes(props.row.id)} onOpenChange={event => { if (!props.controller.pending().includes(props.row.id)) renaming.set(event.open); }} popupClass="bg-background rounded-t-3xl p-5 gap-3">
      <Text class="text-lg font-semibold text-foreground">{t('sessions.sidebar.session.menu.rename')}</Text>
      <Input class={field} value={title()} onChange={event => title.set(event.value)} accessibilityLabel={t('sessions.sidebar.session.menu.rename')} />
      <If when={props.controller.error()}><Text class="text-sm text-destructive">{props.controller.error()}</Text></If>
      <Button class={action} disabled={!title().trim() || props.controller.pending().includes(props.row.id)} onPress={() => { void (async () => { if (await props.controller.mutate(props.row, 'rename', title())) renaming.set(false); })(); }}><Text class="text-foreground">{t('sessions.sidebar.session.rename.save')}</Text></Button>
      <Button class={quiet} disabled={props.controller.pending().includes(props.row.id)} onPress={() => { void (async () => { if (await props.controller.smartTitle(props.row)) renaming.set(false); })(); }}><Icon name="pencil-ai" size={18} /><Text class="text-foreground">{t('sessions.sidebar.session.rename.smartTitle')}</Text></Button>
      <Button class={quiet} disabled={props.controller.pending().includes(props.row.id)} onPress={() => renaming.set(false)}><Text class="text-muted-foreground">{t('gitView.common.cancel')}</Text></Button>
    </Sheet>
  </View>;
}

function DirectoryRows(props: { directory: string; controller: Controller; scroll: ProjectsScroll; onOpenChat: ProjectsNavigation['onOpenChat'] }) {
  const count = signal(3);
  const rows = () => props.controller.byDirectory().get(props.directory) ?? [];
  const visible = () => rows().filter((row, index) => index < count() || props.controller.running().includes(row.id) || props.controller.attention().currentSessionID === row.id);
  return <View class="gap-1">
    <ProjectsSessionGroup controller={props.controller} scope={props.directory} rows={visible} scroll={props.scroll} onOpen={props.onOpenChat} />
    <If when={count() > 3}><Button class={quiet} onPress={() => count.set(3)}><Text class="text-sm text-muted-foreground">{t('sessions.sidebar.group.showFewer')}</Text></Button></If>
    <If when={rows().length > count() || props.controller.buckets()[props.directory]?.hasMore || !props.controller.buckets()[props.directory]?.loaded}>
      <Button class={quiet} disabled={props.controller.pending().includes(props.directory)} onPress={() => { count.set(count() + 7); if (rows().length <= count()) void props.controller.loadDirectory(props.directory); }}><Text class="text-sm text-muted-foreground">{props.controller.pending().includes(props.directory) ? t('common.loading') : rows().length > count() ? t('mobile.sessions.showMore', { count: Math.min(7, rows().length - count()) }) : t('sessions.sidebar.group.showMore')}</Text></Button>
    </If>
  </View>;
}

export function ProjectsHome(props: ProjectsHomeProps) {
  const scroll = createProjectsScroll();
  const controller = createProjectsController(), collapsed = signal<string[]>([]), expandedTrees = signal<string[]>([]), pinnedClosed = signal(false), searching = signal(false), term = signal(''), newChat = signal(false), newSessionPending = signal(false);
  let debounce: ReturnType<typeof setTimeout> | undefined;
  effect(() => { if (controller.current()) untracked(() => { newSessionPending.set(false); void controller.refresh(); }); });
  effect(() => { const projects = app.projects(); if (!controller.current()) return; untracked(() => { void (async () => { for (let i = 0; i < projects.length && controller.current(); i += 2) await Promise.all(projects.slice(i, i + 2).map(project => controller.loadWorktrees(project))); })(); }); });
  cleanup(() => { if (debounce) clearTimeout(debounce); });
  function closeSearch() { if (debounce) clearTimeout(debounce); debounce = undefined; controller.cancelSearch(); searching.set(false); }
  const pinnedRows = computed(() => orderedProjectSessions(controller.sessions().filter(row => controller.pins().includes(row.id)), '__pinned__', controller.order(), controller.pins()));
  const inProgressRows = computed(() => projectsInProgress(controller.sessions(), controller.pins(), controller.running(), controller.attention().unseenBySession));
  const special = computed(() => [...pinnedRows(), ...inProgressRows()]);
  const toggle = (project: Project) => collapsed.set(collapsed().includes(project.id) ? collapsed().filter(id => id !== project.id) : [...collapsed(), project.id]);
  const create = async (project: Project) => {
    if (newSessionPending() || !controller.current()) return;
    if (props.onNewSession) { newChat.set(false); props.onNewSession(project); return; }
    const started = epoch(); newSessionPending.set(true);
    try { const target = await createSession(project); if (controller.current() && started === epoch()) { newChat.set(false); props.onOpenChat(target); } }
    catch (failure) { if (controller.current() && started === epoch()) controller.error.set(String(failure)); }
    finally { if (controller.current() && started === epoch()) newSessionPending.set(false); }
  };
  async function projectMenu(project: Project) {
    const started = epoch();
    const gitRepository = await controller.loadRepository(project);
    if (!controller.current() || started !== epoch()) return;
    const result = await AlertDialog.show({ title: project.name, presentation: 'actionSheet', actions: [
      { id: 'new', label: t('mobile.sessions.startNewChat') }, ...(gitRepository === true ? [{ id: 'worktree', label: t('sessions.sidebar.project.actions.newWorktree') }] : []), { id: 'open', label: t('mobile.projectEdit.worktreesTitle') },
      { id: 'files', label: t('mobile.menu.files') }, { id: 'changes', label: t('mobile.menu.changes') },
      { id: 'sync', label: t('sessions.sidebar.project.actions.syncSessions') },
      { id: 'edit', label: t('sessions.sidebar.project.actions.edit') }, { id: 'close', label: t('sessions.sidebar.project.actions.closeProject'), role: 'destructive' }, { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
    ] });
    if (!controller.current() || started !== epoch()) return;
    if (result.action === 'new') void create(project);
    if (result.action === 'worktree') { if (props.onNewWorktree) props.onNewWorktree(project); else props.onOpenProject(project); }
    if (result.action === 'open') props.onOpenProject(project);
    if (result.action === 'files') props.onOpenFiles(project.path);
    if (result.action === 'changes') props.onOpenChanges(project.path);
    if (result.action === 'edit') props.onEditProject(project);
    if (result.action === 'sync') void controller.syncProject(project);
    if (result.action === 'close') {
      const result = await AlertDialog.show({ title: t('sessions.sidebar.project.actions.closeProject'), description: t('mobile.projects.closeConfirmMessage', { title: project.name }), actions: [{ id: 'close', label: t('mobile.sessions.confirmRemoveProject'), role: 'destructive' }, { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' }] });
      if (result.action === 'close' && controller.current() && started === epoch()) void controller.updateProjectCatalog('close', project.id);
    }
  }
  async function addMenu() {
    const started = epoch();
    const result = await AlertDialog.show({ title: t('mobile.projects.menu.label'), presentation: 'actionSheet', actions: [
      { id: 'chat', label: t('mobile.projects.menu.newChat') }, { id: 'project', label: t('mobile.projects.menu.newProject') },
      ...(props.onScanQr ? [{ id: 'scan', label: t('mobile.projects.menu.scanQr') }] : []),
      ...(props.onSwitchInstance ? [{ id: 'instance', label: t('mobile.projects.menu.switchInstance') }] : []),
      ...(props.onRemoteDesktop ? [{ id: 'desktop', label: t('remoteDesktop.title') }] : []),
      { id: 'cancel', label: t('gitView.common.cancel'), role: 'cancel' },
    ] });
    if (!controller.current() || started !== epoch()) return;
    if (result.action === 'chat') { if (props.onNewSession) props.onNewSession(); else newChat.set(true); }
    if (result.action === 'project') props.onAddProject();
    if (result.action === 'scan') props.onScanQr?.();
    if (result.action === 'desktop') props.onRemoteDesktop?.();
    if (result.action === 'instance') {
      const options = props.instanceOptions?.filter(option => !option.active && !option.disabled);
      if (!options?.length) { props.onSwitchInstance?.(); return; }
      const selected = await AlertDialog.show({ title: t('mobile.projects.menu.switchInstance'), presentation: 'actionSheet', actions: [...options.map(option => ({ id: option.id, label: option.label })), { id: '__cancel__', label: t('gitView.common.cancel'), role: 'cancel' }] });
      if (controller.current() && started === epoch() && options.some(option => option.id === selected.action)) props.onSwitchInstance?.(selected.action!);
    }
  }
  return <View class="flex-1 bg-background">
    <Scroll testID="projects-home-scroll" ref={scroll.ref} onScroll={scroll.onScroll} scrollEventThrottle={16} scrollable={!scroll.dragging()} class="flex-1" contentClass="px-4 pb-6 gap-5" refreshing={controller.loading()} onRefresh={() => { void controller.refresh(); }}>
      <View class="flex-row items-center gap-3 pt-3 pb-1 px-1">
        <Text class="flex-1 text-3xl font-bold text-foreground">{t('mobile.sessions.section.projects')}</Text>
        <Button testID="projects-open-search" class="w-10 h-10 rounded-full border border-border bg-secondary items-center justify-center" accessibilityLabel={t('mobile.sessions.searchAria')} onPress={() => { if (props.onOpenSearch) props.onOpenSearch(); else { searching.set(true); void controller.search(term()); } }}><Icon name="search" size={18} /></Button>
        <Button class="w-10 h-10 rounded-full bg-secondary items-center justify-center" accessibilityLabel={t('mobile.projects.menu.label')} onPress={() => { void addMenu(); }}><Icon name="add" size={20} /></Button>
      </View>
      <If when={controller.error()}><View><Text class="text-sm text-destructive px-2">{controller.error()}</Text><Button class={quiet} onPress={() => { void controller.refresh(); }}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button></View></If>
      <If when={controller.notice()}><Text class="text-sm text-muted-foreground px-2">{controller.notice()}</Text></If>
      <ArchiveUndo controller={controller} onOpenArchivedSessions={props.onOpenArchivedSessions} />
      <RemoteDeleteRetries controller={controller} />
      <If when={special().length > 0}><View class={shell}>
        <Button class="min-h-14 flex-row items-center gap-3 px-1" onPress={() => pinnedClosed.set(!pinnedClosed())}>
          <View class="h-10 w-10 rounded-full bg-secondary border border-border items-center justify-center"><Icon name="pushpin" size={19} /></View>
          <View class="flex-1 gap-1"><Text class="font-semibold text-foreground">{t('mobile.sessions.section.pinned')}</Text><Text class="text-xs text-muted-foreground">{sessionCount(special().length)}</Text></View><Icon name={pinnedClosed() ? 'arrow-right-s' : 'arrow-down-s'} size={15} />
        </Button>
        <If when={!pinnedClosed()}><View><ProjectsSessionGroup controller={controller} scope="__pinned__" rows={pinnedRows} scroll={scroll} onOpen={props.onOpenChat} subtitle={row => app.projects().find(project => project.path === row.directory)?.name || nameOf(row.directory)} /><Each of={inProgressRows()}>{row => <SessionRow row={row()} controller={controller} onOpen={props.onOpenChat} subtitle={app.projects().find(project => project.path === row().directory)?.name || nameOf(row().directory)} />}</Each></View></If>
      </View></If>
      <Each of={app.projects()}>{project => <View class={shell}>
        <View class="flex-row items-center gap-1" onLongPress={() => { void projectMenu(project()); }}>
          <Button class="flex-1 flex-row min-h-14 items-center gap-3 px-1" onPress={() => toggle(project())}>
            <View class="w-10 h-10 rounded-full border border-border bg-secondary items-center justify-center"><Icon name="code-box" size={19} /></View>
            <View class="flex-1 gap-1"><View class="flex-row items-center gap-2"><Text class="font-semibold text-foreground" style={{ numberOfLines: 1 }}>{project().name}</Text><If when={props.activeProjectId === project().id}><View class="w-2 h-2 rounded-full bg-ring" accessibilityLabel={t('mobile.sessions.activeProjectAria')} /></If></View>
              <Text class="text-xs text-muted-foreground" style={{ numberOfLines: 1 }}>{[sessionCount(controller.byDirectory().get(project().path)?.length ?? 0) + (controller.buckets()[project().path]?.hasMore ? '+' : ''), relative(controller.byDirectory().get(project().path)?.[0]?.updated ?? 0), projectPathHint(project().path)].filter(Boolean).join(' · ')}</Text>
            </View><Icon name={collapsed().includes(project().id) ? 'arrow-right-s' : 'arrow-down-s'} size={14} />
          </Button>
          <Button class="min-h-11 min-w-8 items-center justify-center" accessibilityLabel={t('sessions.sidebar.project.actions.projectMenu')} onPress={() => { void projectMenu(project()); }}><Icon name="more-2" size={16} /></Button>
        </View>
        <If when={!collapsed().includes(project().id)}><View class="gap-2"><DirectoryRows directory={project().path} controller={controller} scroll={scroll} onOpenChat={props.onOpenChat} />
          <Each of={controller.orderedWorktrees(project())}>{tree => <View class="gap-1">
            <WorktreeRow project={project()} tree={tree()} controller={controller} expanded={expandedTrees().includes(tree().path)} onSelect={() => { const open = !expandedTrees().includes(tree().path); expandedTrees.set(open ? [...expandedTrees(), tree().path] : expandedTrees().filter(path => path !== tree().path)); if (open) void controller.loadDirectory(tree().path); }} onNewSession={() => { void create({ ...project(), path: tree().path }); }} />
            <If when={expandedTrees().includes(tree().path)}><DirectoryRows directory={tree().path} controller={controller} scroll={scroll} onOpenChat={props.onOpenChat} /></If>
          </View>}</Each>
        </View></If>
      </View>}</Each>
      <If when={app.projects().length === 0}><View class="items-center gap-3 py-12"><Icon name="folder-add" size={36} /><Text class="text-lg text-foreground">{t('mobile.sessions.empty.noProjectsTitle')}</Text><Text class="text-sm text-muted-foreground">{t('mobile.sessions.empty.noProjectsDescription')}</Text><Button class={action} onPress={props.onAddProject}><Text class="text-foreground">{t('sessions.sidebar.header.actions.addProject')}</Text></Button></View></If>
    </Scroll>
    <Sheet open={searching()} onOpenChange={event => { if (!event.open) closeSearch(); }} closeOnSwipe popupClass="bg-background rounded-t-3xl p-4 gap-3" popupStyle={{ height: '85%' }}>
      <View class="flex-row items-center gap-2"><Input testID="projects-search" class={`flex-1 ${field}`} value={term()} placeholder={t('mobile.sessions.search.placeholder')} onChange={event => { term.set(event.value); if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { if (searching()) void controller.search(term()); }, 250); }} /><Button class={quiet} accessibilityLabel={t('mobile.surface.closeAria')} onPress={closeSearch}><Icon name="close" size={20} /></Button></View>
      <If when={controller.error()}><Text class="text-destructive text-sm">{controller.error()}</Text></If>
      <If when={controller.notice()}><Text class="text-sm text-muted-foreground">{controller.notice()}</Text></If>
      <ArchiveUndo controller={controller} />
      <List class="flex-1" each={controller.searchResults()} keyExtractor={row => row.id} onLoadMore={() => { if (controller.searchMore() && !controller.searching()) void controller.search(term(), true); }}>
        {row => <SessionRow row={row()} controller={controller} onOpen={target => { closeSearch(); props.onOpenChat(target); }} subtitle={row().directory} />}
      </List>
      <If when={controller.searching()}><Text class="text-muted-foreground">{t('common.loading')}</Text></If>
      <If when={!controller.searching() && !controller.error() && controller.searchResults().length === 0}><Text class="text-muted-foreground">{t('mobile.sessions.empty.searchTitle')}</Text></If>
      <If when={controller.error()}><Button class={quiet} onPress={() => { void controller.search(term()); }}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button></If>
    </Sheet>
    <Sheet open={newChat()} onOpenChange={event => newChat.set(event.open)} closeOnSwipe popupClass="bg-background rounded-t-3xl p-5 gap-3">
      <Text class="text-xl font-semibold text-foreground">{t('mobile.sessions.section.otherProjects')}</Text>
      <If when={controller.error()}><Text class="text-sm text-destructive">{controller.error()}</Text></If>
      <Each of={app.projects()}>{project => <Button class={action} disabled={newSessionPending()} onPress={() => { void create(project()); }}><Text class="text-foreground">{project().name}</Text><Text class="text-xs text-muted-foreground">{project().path}</Text></Button>}</Each>
      <Button class={quiet} onPress={() => newChat.set(false)}><Text class="text-muted-foreground">{t('gitView.common.cancel')}</Text></Button>
    </Sheet>
  </View>;
}

export function ProjectDetail(props: ProjectDetailProps) {
  const treeGeometry: ProjectsOrderGeometry = new Map();
  const scroll = createProjectsScroll();
  const controller = createProjectsController(), directory = signal(props.project.path), creating = signal(props.initialCreateWorktree === true), branch = signal(''), folder = signal(''), source = signal('');
  const mode = signal<'new' | 'existing'>('new');
  const sessionPending = signal(false);
  effect(() => { if (controller.current()) untracked(() => { void controller.refresh(); void controller.loadWorktrees(props.project); void controller.loadDirectory(directory(), true); if (creating()) void controller.loadBranches(props.project); }); });
  const select = (path: string) => { directory.set(path); void controller.loadDirectory(path); };
  async function create() {
    if (sessionPending() || !controller.current()) return;
    if (props.onNewSession) { props.onNewSession({ ...props.project, path: directory() }); return; }
    const started = epoch(); sessionPending.set(true);
    try { const target = await createSession({ ...props.project, path: directory() }); if (controller.current() && started === epoch()) props.onOpenChat(target); }
    catch (failure) { if (controller.current() && started === epoch()) controller.error.set(String(failure)); }
    finally { if (controller.current() && started === epoch()) sessionPending.set(false); }
  }
  return <NavPage title={props.project.name} headerBackTitle="" class="flex-1 bg-background" headerRight={<Button class={quiet} accessibilityLabel={t('mobile.sessions.newSessionAria')} disabled={sessionPending()} onPress={() => { void create(); }}><Icon name="add" /></Button>}>
    <Scroll ref={scroll.ref} onScroll={scroll.onScroll} scrollEventThrottle={16} scrollable={!scroll.dragging()} class="flex-1" contentClass="p-4 gap-4" refreshing={controller.loading()} onRefresh={() => { void controller.refresh(); void controller.loadDirectory(directory(), true); void controller.loadWorktrees(props.project); }}>
      <If when={controller.error()}><Text class="text-destructive text-sm">{controller.error()}</Text></If>
      <RemoteDeleteRetries controller={controller} />
      <ArchiveUndo controller={controller} onOpenArchivedSessions={props.onOpenArchivedSessions} />
      <View class="flex-row gap-2"><Button class={`flex-1 ${action}`} onPress={() => props.onOpenFiles(directory())}><Icon name="folder" size={17} /><Text class="text-foreground">{t('mobile.menu.files')}</Text></Button><Button class={`flex-1 ${action}`} onPress={() => props.onOpenChanges(directory())}><Icon name="git-branch" size={17} /><Text class="text-foreground">{t('mobile.menu.changes')}</Text></Button><Button class={action} onPress={() => props.onEditProject(props.project)}><Icon name="edit" size={17} /></Button></View>
      <View class={shell}><Text class="text-sm font-semibold text-foreground">{t('mobile.projectEdit.worktreesTitle')}</Text>
        <Button class={quiet} onPress={() => select(props.project.path)}><Text class="text-foreground">{t('mobile.sessions.mainWorkspace')}{directory() === props.project.path ? ' ✓' : ''}</Text><Text class="text-xs text-muted-foreground">{props.project.path}</Text></Button>
        <Each of={controller.orderedWorktrees(props.project)}>{tree => <WorktreeRow project={props.project} tree={tree()} controller={controller} geometry={treeGeometry} onSelect={() => select(tree().path)} onNewSession={() => { select(tree().path); void create(); }} onRemoved={() => { if (directory() === tree().path) select(props.project.path); }} />}</Each>
        <Button class={action} onPress={() => { creating.set(true); void controller.loadBranches(props.project); }}><Icon name="add" size={17} /><Text class="text-foreground">{t('session.newWorktree.actions.createWorktree')}</Text></Button>
      </View>
      <View class={shell}><DirectoryRows directory={directory()} controller={controller} scroll={scroll} onOpenChat={props.onOpenChat} /><Button class={action} disabled={sessionPending()} onPress={() => { void create(); }}><Text class="text-foreground">{t('mobile.sessions.startNewChat')}</Text></Button></View>
    </Scroll>
    <Sheet open={creating()} onOpenChange={event => { if (!controller.pending().includes('worktree')) creating.set(event.open); }} closeOnSwipe={!controller.pending().includes('worktree')} closeOnEscape={!controller.pending().includes('worktree')} closeOnBackdropPress={!controller.pending().includes('worktree')} popupClass="bg-background rounded-t-3xl p-5 gap-3">
      <Text class="text-xl font-semibold text-foreground">{t('session.newWorktree.title')}</Text>
      <View class="flex-row gap-2"><Button class={`flex-1 ${action}`} onPress={() => mode.set('new')}><Text class="text-foreground">{t('session.newWorktree.mode.newBranch')}{mode() === 'new' ? ' ✓' : ''}</Text></Button><Button class={`flex-1 ${action}`} onPress={() => mode.set('existing')}><Text class="text-foreground">{t('session.newWorktree.mode.existingBranch')}{mode() === 'existing' ? ' ✓' : ''}</Text></Button></View>
      <Input class={field} value={branch()} onChange={event => branch.set(event.value)} placeholder={t('session.newWorktree.branchName')} autoCapitalize="none" autoCorrect={false} />
      <Input class={field} value={folder()} onChange={event => folder.set(event.value)} placeholder={t('session.newWorktree.worktreeDirectory')} autoCapitalize="none" autoCorrect={false} />
      <If when={mode() === 'new'}><Input class={field} value={source()} onChange={event => source.set(event.value)} placeholder={t('session.newWorktree.sourceBranch')} autoCapitalize="none" autoCorrect={false} /></If>
      <List style={{ height: 160 }} each={controller.branches().filter(value => value.toLowerCase().includes((mode() === 'existing' ? branch() : source()).toLowerCase()))} keyExtractor={value => value}>{value => <Button class={quiet} onPress={() => mode() === 'existing' ? branch.set(value()) : source.set(value())}><Text class="text-foreground">{value()}</Text></Button>}</List>
      <If when={controller.error()}><Text class="text-sm text-destructive">{controller.error()}</Text></If>
      <Button class={action} disabled={!branch().trim() || !folder().trim() || controller.pending().includes('worktree')} onPress={() => { void (async () => { const path = await controller.createWorktree(props.project, branch(), folder(), source(), mode()); if (path && controller.current()) { creating.set(false); select(path); props.onWorktreeCreated?.(props.project, path); } })(); }}><Text class="text-foreground">{t(controller.pending().includes('worktree') ? 'session.newWorktree.actions.creating' : 'session.newWorktree.actions.createWorktree')}</Text></Button>
      <Button class={quiet} disabled={controller.pending().includes('worktree')} onPress={() => { void controller.loadBranches(props.project); }}><Text class="text-foreground">{t('layout.browserProvider.retry')}</Text></Button>
      <Button class={quiet} disabled={controller.pending().includes('worktree')} onPress={() => creating.set(false)}><Text class="text-muted-foreground">{t('gitView.common.cancel')}</Text></Button>
    </Sheet>
  </NavPage>;
}
