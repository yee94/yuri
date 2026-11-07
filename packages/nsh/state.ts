import { batch, cleanup, effect, host, lifecycle, signal, untracked } from 'nsh';
import { assistantPath, bindRequest, connectionSnapshotFrom, connections, native, query, sessionPath, type ConnectionSnapshot } from './runtime';
import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import { openDraft, sameAttachment } from './drafts';
import { inboxDraft } from './inbox';
import { openNativeHistoryLane } from './transcript-actions-lane';
import { nativeRevertFrom, type NativeRevert } from './transcript-actions-core';
import { compileNativePrompt } from './composer';
import { mergeHistoryMessages, stableHistoryMessages } from './history-messages';
import type { NativeHistoryPresentation } from './history-presentation';
import { createActivityMaterializer, materializedActivityMessage } from './transcript-materialization';
import { createGoalController, createGoalTransport, planGoalSubmission, type GoalArmSnapshot, type GoalCommandResult } from './chat-goal-model';
import { createTasksProjection, type NativeTask } from './chat-tasks-model';
import { createProjectsAttentionSource, isProjectsAttentionEvent, projectsAttention } from './projects-attention';
import { t } from './i18n';
import { sameReferenceScope, validateNativeReferences, type ReferenceCandidate, type ReferenceScope, type ScopedReferenceDocument } from './composer-references';
import { activeFrom, applySessionContent, eventBusy, eventSessionID, id, inboxFrom, isSessionContentEvent, list, mergeMessages, messagesFrom, projectsFrom, record, rowsFrom, runtimeEventFrom, sessionsFrom, slashCommand, text, unwrap, type Attachment, type ChatTarget, type CompiledSubmission, type Connection, type FormAnswer, type Message, type Project, type Row, type RuntimeEvent, type Session, type Submission } from './model';

const notificationCatalogAuthority = signal<NotificationCatalogState>({ scope: null, refreshGeneration: 0, complete: false, domains: { projects: 'unknown', sessions: 'unknown', bots: 'unknown', tasks: 'unknown' }, error: null });
const catalogSources: { projects?: readonly Project[]; sessions?: readonly Session[]; bots?: readonly Row[]; tasks?: readonly Row[] } = {};
function notificationCatalogState(): NotificationCatalogState {
  const receipt = notificationCatalogAuthority();
  if (!receipt.complete) return receipt;
  const changed = { projects: catalogSources.projects !== app.projects(), sessions: catalogSources.sessions !== app.sessions(), bots: catalogSources.bots !== app.bots(), tasks: catalogSources.tasks !== app.tasks() };
  if (!changed.projects && !changed.sessions && !changed.bots && !changed.tasks) return receipt;
  const status = { ...receipt.domains };
  for (const domain of domains) if (changed[domain]) status[domain] = 'unknown';
  return { ...receipt, domains: status, complete: false };
}
export const app = {
  connections: signal<Connection[]>([]), connection: signal<Connection | null>(null),
  runtimeScope: signal<RuntimeScope | null>(null),
  notificationCatalog: notificationCatalogState,
  projects: signal<Project[]>([]), sessions: signal<Session[]>([]), bots: signal<Row[]>([]), tasks: signal<Row[]>([]),
  tab: signal(0), error: signal(''), loading: signal(false), online: signal(false),
};
let generation = 0, connectionRead = 0, reconnectPending = false;
let pendingRetirement: 'suspend' | 'host' | undefined;
const chatAuthorityRetirements = new Set<(reason?: 'suspend' | 'host') => void>();
const chatOperationResumptions = new Set<() => boolean>();
const runtimeReady = signal(false);
let globalDisconnected = false, connectivityRevision = 0;
let refreshFlight: Promise<void> | undefined;
type Domain = 'projects' | 'sessions' | 'bots' | 'tasks';
export type NotificationCatalogScope = Readonly<{ hostID: string; generation: number }>;
type CatalogAuthorityScope = NotificationCatalogScope & Readonly<{ authorizationID: string | null; runtimeScope: RuntimeScope | null }>;
export type NotificationCatalogState = Readonly<{
  scope: CatalogAuthorityScope | null; refreshGeneration: number; complete: boolean;
  domains: Readonly<Record<Domain, 'unknown' | 'pending' | 'complete' | 'failed'>>; error: string | null;
}>;
let catalogRefreshGeneration = 0;
const catalogDomainRevisions: Record<Domain, number> = { projects: 0, sessions: 0, bots: 0, tasks: 0 };
const dirtyDomains = new Set<Domain>();
const domains: Domain[] = ['projects', 'sessions', 'bots', 'tasks'];
export const epoch = () => generation;
export const isCurrentHostScope = (captured: number, hostID: string) => !switching && captured === generation && app.connection()?.id === hostID;
export const captureHostRequest = () => bindRequest(app.runtimeScope());
/** Replace only a page's operation object after confirmed foreground adoption. */
export function captureHostOperation() {
  const scope = runtimeScopeFrom(app.runtimeScope()), captured = generation, connection = app.connection();
  const hostID = connection?.id, origin = connection?.url, authorizationID = connection?.authorizationID;
  const admitted = runtimeReady() && !switching && lifecycle() === 'active' && !!connection;
  const current = () => admitted && runtimeReady() && !switching && lifecycle() === 'active' && captured === generation
    && hostID === app.connection()?.id && origin === app.connection()?.url && authorizationID === app.connection()?.authorizationID && sameRuntimeScope(scope, app.runtimeScope());
  const send = bindRequest(scope);
  return Object.freeze({ scope, generation: captured, current,
    request: async (path: string, method = 'GET', body?: unknown) => {
      if (!current()) throw new Error('host_operation_stale');
      const value = await send(path, method, body);
      if (!current()) throw new Error('host_operation_stale');
      return value;
    },
  });
}
function currentCatalogScope(): CatalogAuthorityScope | null {
  const connection = app.connection();
  return connection ? { hostID: connection.id, generation, authorizationID: typeof connection.authorizationID === 'string' ? connection.authorizationID : null, runtimeScope: app.runtimeScope() } : null;
}
function sameCatalogScope(left: CatalogAuthorityScope | null, right: CatalogAuthorityScope | null) {
  return !!left && !!right && left.hostID === right.hostID && left.generation === right.generation && left.authorizationID === right.authorizationID && sameRuntimeScope(left.runtimeScope, right.runtimeScope);
}
function retireCatalog() {
  catalogRefreshGeneration++;
  for (const domain of domains) catalogDomainRevisions[domain]++;
  notificationCatalogAuthority.set({ scope: null, refreshGeneration: catalogRefreshGeneration, complete: false, domains: { projects: 'unknown', sessions: 'unknown', bots: 'unknown', tasks: 'unknown' }, error: null });
}
function invalidateCatalog(changed: readonly Domain[]) {
  if (!changed.length) return;
  const previous = app.notificationCatalog(), next = { ...previous.domains };
  for (const domain of changed) { catalogDomainRevisions[domain]++; next[domain] = 'unknown'; }
  notificationCatalogAuthority.set({ ...previous, domains: next, complete: false });
}
/** One attempt through the existing root writer; no independent transport, timer or retry loop. */
export async function awaitNotificationCatalogReady(scope: NotificationCatalogScope | null, current: () => boolean): Promise<void> {
  const expected = scope && { ...scope };
  const captured = currentCatalogScope();
  const valid = () => !!expected && !!captured && current() && runtimeReady() && !switching && lifecycle() === 'active'
    && expected.hostID === captured.hostID && expected.generation === captured.generation && sameCatalogScope(captured, currentCatalogScope());
  if (!valid()) throw new Error('notification_catalog_stale');
  if (!captured!.runtimeScope || !captured!.authorizationID || !/^[a-zA-Z0-9_-]{1,128}$/.test(captured!.authorizationID) || captured!.authorizationID === 'legacy') throw new Error('notification_catalog_unsupported');
  const before = app.notificationCatalog();
  const ready = before.complete && sameCatalogScope(before.scope, captured) && before.refreshGeneration === catalogRefreshGeneration && !dirtyDomains.size;
  const pending = refreshFlight ?? (ready ? undefined : refresh());
  if (pending) { try { await pending; } catch { /* The receipt below distinguishes failure from successful empty authority. */ } }
  if (!valid()) throw new Error('notification_catalog_stale');
  const receipt = app.notificationCatalog();
  if (!sameCatalogScope(receipt.scope, captured) || !receipt.complete || receipt.refreshGeneration !== catalogRefreshGeneration || dirtyDomains.size || domains.some(domain => receipt.domains[domain] !== 'complete')) throw new Error('notification_catalog_incomplete');
}
/** Root calls after adopting the foreground snapshot; does not remount Chat/UI/drafts. */
export function resumeChatOperations() { let resumed = 0; for (const resume of chatOperationResumptions) if (resume()) resumed++; return resumed; }
export const report = (error: unknown) => app.error.set(error instanceof Error ? error.message : String(error));
export async function run(work: () => Promise<unknown>) {
  app.error.set('');
  try { return await work(); } catch (error) { report(error); }
}
/** Call with forceReconnect only after native connection.connect succeeds. */
export async function loadConnections(options: { forceReconnect?: boolean } = {}) {
  if (options.forceReconnect) {
    // Native may have replaced credentials without changing public id/url.
    // Fence old work immediately, even while the public snapshot is loading.
    retireRuntimeAuthority();
  }
  const read = ++connectionRead;
  const saved = await connections();
  if (read !== connectionRead || lifecycle() !== 'active') return;
  adoptConnections(saved);
}
function retireRuntimeAuthority(reason: 'suspend' | 'host' = 'host') {
  batch(() => {
    generation++; connectionRead++;
    retireCatalog();
    chatAuthorityRetirements.forEach(retire => retire(reason));
    connectivityRevision++; globalDisconnected = false;
    pendingRetirement = reason;
    reconnectPending = true; refreshFlight = undefined; dirtyDomains.clear();
    runtimeReady.set(false); app.runtimeScope.set(null); app.online.set(false); app.loading.set(false);
  });
}
function adoptConnections(saved: ConnectionSnapshot) {
  const next = saved.connections.find(c => c.id === saved.selected) ?? null;
  const previous = app.connection();
  const changed = previous?.id !== next?.id || previous?.url !== next?.url;
  const authorizationChanged = previous?.authorizationID !== next?.authorizationID;
  const authorityChanged = changed || authorizationChanged || !sameRuntimeScope(saved.runtimeScope, app.runtimeScope());
  const sameHostResume = reconnectPending && pendingRetirement === 'suspend' && !changed && !authorizationChanged;
  batch(() => {
    if (authorityChanged) {
      if (!reconnectPending) { generation++; retireCatalog(); chatAuthorityRetirements.forEach(retire => retire()); }
      else if (changed || authorizationChanged) chatAuthorityRetirements.forEach(retire => retire('host'));
      connectivityRevision++; globalDisconnected = false; refreshFlight = undefined; dirtyDomains.clear();
      if (changed) { app.projects.set([]); app.sessions.set([]); app.bots.set([]); app.tasks.set([]); }
      app.online.set(false); app.loading.set(false);
    }
    app.connections.set(saved.connections);
    if (!sameRuntimeScope(saved.runtimeScope, app.runtimeScope())) app.runtimeScope.set(saved.runtimeScope);
    if (!sameHostResume && (changed || authorityChanged || reconnectPending)) app.connection.set(next ? { ...next } : null);
    reconnectPending = false; pendingRetirement = undefined; runtimeReady.set(true);
  });
}
let switching = false;
export async function switchConnection(connectionID: string) {
  if (switching) throw new Error('Connection switch in progress');
  // Native select stops every stream, including when selecting the same id.
  if (app.connection()?.id === connectionID) return;
  switching = true;
  const read = ++connectionRead;
  try {
    // Native selection is atomic; failed selection preserves the previous view.
    const saved = connectionSnapshotFrom(await native('connection.select', { id: connectionID }));
    if (read !== connectionRead || lifecycle() !== 'active') throw new Error('Connection changed');
    switching = false;
    adoptConnections(saved);
    await refresh();
  } catch (failure) {
    // Native selection can stop streams before rejecting an invalid saved id.
    // Rebind the preserved connection without discarding its snapshots.
    switching = false;
    // Re-read Native's actual lease; never synthesize one or clone the old
    // connection merely to make subscribers restart after a failed selection.
    if (read === connectionRead && lifecycle() === 'active') await loadConnections().catch(() => {});
    throw failure;
  } finally { switching = false; }
}
export async function refresh() {
  if (!runtimeReady() || lifecycle() !== 'active' || !app.connection()) return;
  if (refreshFlight) return refreshFlight;
  const started = generation;
  const request = captureHostRequest();
  const scope = currentCatalogScope(), turn = ++catalogRefreshGeneration;
  const connectivityAtStart = connectivityRevision;
  const selected = dirtyDomains.size ? [...dirtyDomains] : domains;
  dirtyDomains.clear();
  const previousCatalog = app.notificationCatalog();
  const status: Record<Domain, 'unknown' | 'pending' | 'complete' | 'failed'> = sameCatalogScope(scope, previousCatalog.scope) ? { ...previousCatalog.domains } : { projects: 'unknown', sessions: 'unknown', bots: 'unknown', tasks: 'unknown' };
  const revisions = { ...catalogDomainRevisions };
  selected.forEach(domain => { status[domain] = 'pending'; });
  notificationCatalogAuthority.set({ scope, refreshGeneration: turn, complete: false, domains: { ...status }, error: null });
  const catalogCurrent = () => started === generation && !switching && runtimeReady() && turn === catalogRefreshGeneration && sameCatalogScope(scope, currentCatalogScope());
  app.loading.set(true);
  const flight = (async () => {
    const results = await Promise.allSettled(selected.map(async domain => {
      try {
      if (domain === 'projects') {
        const raw = record(unwrap(await request('/api/config/settings')));
        if (!Array.isArray(raw.projects) || raw.partial === true || raw.complete === false || raw.projects.some(value => !text(record(value).id) || !text(record(value).path))) throw new Error('Invalid projects catalog');
        const value = projectsFrom(raw);
        if (started === generation && !switching) { app.projects.set(value); catalogSources.projects = value; }
      } else if (domain === 'sessions') {
        const raw = record(await request('/api/yuri/session-index')), sync = record(raw.sync);
        if (raw.partial === true || raw.complete === false || sync.active === true || typeof sync.completed === 'number' && typeof sync.total === 'number' && sync.completed < sync.total
          || ['pendingDirectories', 'failedDirectories'].some(key => sync[key] !== undefined && (!Array.isArray(sync[key]) || sync[key].length > 0))
          || !Array.isArray(raw.directories) || raw.directories.some(value => !text(record(value).directory) || !Array.isArray(record(value).sessions))) throw new Error('Incomplete sessions catalog');
        const value = sessionsFrom(raw);
        if (started === generation && !switching) { app.sessions.set(value); catalogSources.sessions = value; }
      } else if (domain === 'bots') {
        const value = record(await request('/api/yuri/assistants/snapshot'));
        if (!Array.isArray(value.assistants) || value.partial === true || value.complete === false || value.assistants.some(item => !text(record(item).id))) throw new Error('Invalid assistants snapshot');
        if (started === generation && !switching) { const rows = list(value.assistants); app.bots.set(rows); catalogSources.bots = rows; }
      } else {
        const value = record(await request('/api/yuri/scheduled-tasks'));
        if (!Array.isArray(value.tasks) || value.partial === true || value.complete === false || value.failedProjectIds !== undefined && !Array.isArray(value.failedProjectIds)
          || value.tasks.some(item => !text(record(item).projectId) || !text(record(record(item).task).id))) throw new Error('Invalid scheduled tasks snapshot');
        if (started === generation && !switching) {
          const failed = new Set(Array.isArray(value.failedProjectIds) ? value.failedProjectIds : []);
          app.tasks.set([...list(value.tasks), ...app.tasks().filter(item => failed.has(item.projectId))]);
          if (failed.size) throw new Error('部分项目的定时任务未能加载');
          catalogSources.tasks = app.tasks();
        }
      }
        status[domain] = catalogDomainRevisions[domain] === revisions[domain] ? 'complete' : 'unknown';
      } catch (failure) { status[domain] = catalogDomainRevisions[domain] === revisions[domain] ? 'failed' : 'unknown'; throw failure; }
    }));
    if (started !== generation) return;
    for (const domain of domains) if (catalogDomainRevisions[domain] !== revisions[domain]) status[domain] = 'unknown';
    if (catalogCurrent()) {
      const failed = results.find(result => result.status === 'rejected');
      notificationCatalogAuthority.set({ scope, refreshGeneration: turn, complete: !dirtyDomains.size && domains.every(domain => status[domain] === 'complete'), domains: { ...status },
        error: failed?.status === 'rejected' ? failed.reason instanceof Error ? failed.reason.message : String(failed.reason) : null });
    }
    if (connectivityAtStart === connectivityRevision && !globalDisconnected) {
      app.online.set(results.every(result => result.status === 'fulfilled'));
    }
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  })();
  refreshFlight = flight;
  try { await flight; }
  finally {
    if (started === generation) {
      refreshFlight = undefined; app.loading.set(false);
      if (dirtyDomains.size) void run(refresh);
    }
  }
}
export async function createSession(project: Project): Promise<ChatTarget> {
  const started = generation;
  const request = captureHostRequest();
  const value = record(unwrap(await request('/api/session', 'POST', { location: { directory: project.path } })));
  if (started !== generation) throw new Error('Connection changed');
  if (!text(value.id)) throw new Error('Server returned no session ID');
  return { kind: 'session', id: text(value.id), title: text(value.title) || project.name, directory: project.path };
}
function catalogDomains(event: RuntimeEvent): Domain[] {
  if (event.key !== 'global') return [];
  if (event.type === 'yuri:assistants-changed') return ['bots'];
  if (event.type === 'yuri:session-index-changed') return ['sessions'];
  if (event.type === 'yuri:project-order-changed' || event.type === 'yuri:worktree-topology-changed') return ['projects'];
  return [];
}
/** Root observer: catalog scheduling excludes token/status traffic; attention has a separate cheap gate. */
export function observeRuntime(onChange: () => void, onEvent?: (event: RuntimeEvent, scope: { hostID: string; generation: number }) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attentionScope: string | undefined;
  const makeAttentionSource = () => createProjectsAttentionSource({ attention: projectsAttention, sessions: () => app.sessions(), request: captureHostRequest(),
    current: key => runtimeReady() && !switching && lifecycle() === 'active' && key === JSON.stringify([generation, app.connection()?.id]),
  });
  let attentionSource = makeAttentionSource();
  function syncAttentionScope() {
    const connection = app.connection(), key = runtimeReady() && connection ? JSON.stringify([generation, connection.id]) : undefined;
    if (key !== attentionScope) {
      if (attentionScope) projectsAttention.retire(attentionScope);
      attentionSource.dispose(); attentionSource = makeAttentionSource(); attentionScope = key;
      if (key) projectsAttention.activate(key);
    }
    return key;
  }
  const stop = host.on('runtime.event', payload => {
    const event = runtimeEventFrom(payload);
    if (!event || !runtimeReady() || lifecycle() !== 'active') return;
    if (onEvent && !switching) {
      const hostID = app.connection()?.id;
      if (hostID) { try { onEvent(event, { hostID, generation }); } catch (error) { report(error); } }
    }
    if (!switching && isProjectsAttentionEvent(event)) {
      const key = syncAttentionScope();
      if (key) { attentionSource.setActive(key, true); attentionSource.accept(key, event); }
    }
    const changed = catalogDomains(event);
    if (!changed.length) return;
    invalidateCatalog(changed);
    changed.forEach(domain => dirtyDomains.add(domain));
    if (timer) return;
    const started = generation;
    timer = setTimeout(() => { timer = undefined; if (started === generation && lifecycle() === 'active') onChange(); }, 120);
  });
  effect(() => { app.connection(); runtimeReady(); const active = lifecycle() === 'active'; untracked(() => { const key = syncAttentionScope(); attentionSource.setActive(key, active && !switching); }); });
  cleanup(() => { stop(); if (timer) clearTimeout(timer); attentionSource.dispose(); if (attentionScope) projectsAttention.retire(attentionScope); });
}
export function runtimeLifecycle() {
  effect(() => {
    const active = lifecycle() === 'active';
    untracked(() => {
      if (!active) { if (runtimeReady() || !reconnectPending) retireRuntimeAuthority('suspend'); return; }
      if (!runtimeReady()) void loadConnections().then(() => { resumeChatOperations(); }).catch(report);
    });
  });
  effect(() => {
    const active = lifecycle() === 'active';
    const connection = app.connection();
    const ready = runtimeReady(), scope = app.runtimeScope();
    if (!active || !ready || !connection) return;
    const captured = generation;
    let alive = true;
    const current = () => alive && runtimeReady() && captured === generation && sameRuntimeScope(scope, app.runtimeScope()) && !switching && lifecycle() === 'active';
    const disconnected = host.on('runtime.disconnected', payload => {
      if (!current() || record(payload).key !== 'global') return;
      connectivityRevision++; globalDisconnected = true;
      app.online.set(false);
    });
    const reconnected = host.on('runtime.event', payload => {
      const event = runtimeEventFrom(payload);
      if (!current() || event?.key !== 'global' || event.type !== 'reconnected') return;
      connectivityRevision++; globalDisconnected = false;
      app.online.set(false);
      domains.forEach(domain => dirtyDomains.add(domain));
      void run(refresh);
    });
    untracked(() => { void run(refresh); });
    void native('runtime.stream', { path: '/api/yuri/events', key: 'global', ...(scope ? { expectedHost: scope } : {}) }).catch(failure => { if (current()) report(failure); });
    return () => {
      alive = false; disconnected(); reconnected();
      connectivityRevision++; app.online.set(false);
      void native('runtime.stop', { key: 'global', ...(scope ? { expectedHost: scope } : {}) }).catch(() => {});
    };
  });
}

export type SendPreparationInput = { text: string; files: Attachment[]; references: ScopedReferenceDocument; scope: ReferenceScope; isCurrentScope: () => boolean };
export type SendOptions = { inputMode?: 'normal' | 'shell'; prepare?: (input: SendPreparationInput) => Promise<CompiledSubmission>; goalArm?: GoalArmSnapshot };
const chatOwners = signal<number[]>([]);
let nextChatOwner = 0;
export function createChat(target: ChatTarget, dependencies: { followUpBehavior?: () => 'queue' | 'steer' | null; beforeHistoryPresentationFlush?: (next: NativeHistoryPresentation) => void } = {}) {
  type OperationLane = Readonly<{ scope: RuntimeScope | null; generation: number; request: ReturnType<typeof bindRequest>; history: ReturnType<typeof openNativeHistoryLane> }>;
  const makeOperationLane = (): OperationLane => {
    const scope = runtimeScopeFrom(app.runtimeScope());
    return Object.freeze({ scope, generation, request: bindRequest(scope), history: openNativeHistoryLane(JSON.stringify([generation, scope?.lease ?? null, target.kind, target.directory, target.id])) });
  };
  let operationLane = makeOperationLane();
  const initialOperationLane = operationLane, laneRevision = signal(0);
  const messages = signal<Message[]>([]), inbox = signal<Row[]>([]), permissions = signal<Row[]>([]), forms = signal<Row[]>([]), error = signal('');
  type MessageCommit = { kind: 'snapshot'; error?: string } | { kind: 'patch'; messages: readonly Message[] };
  const messageCommitListeners = new Set<(commit: MessageCommit) => void>();
  const messageReadError = signal('');
  function emitMessageCommit(commit: MessageCommit) {
    if (!foreground() || !messageCommitListeners.size) return;
    untracked(() => { for (const listener of messageCommitListeners) { try { listener(commit); } catch { /* A reader must never interrupt the authoritative writer or another reader. */ } } });
  }
  function snapshotCommitted(failure?: string) {
    if (messageCommitListeners.size) emitMessageCommit({ kind: 'snapshot', ...(failure ? { error: failure } : {}) });
  }
  function observeMessageCommits(listener: (commit: MessageCommit) => void) {
    if (!current()) return () => {};
    messageCommitListeners.add(listener);
    return () => { messageCommitListeners.delete(listener); };
  }
  // Hydration/reset authority is independent of request activity and the private read fence.
  const resolvedAuthority = signal(false), historyGeneration = signal(0);
  let cancelActivityFill: ((clear?: boolean) => void) | undefined;
  const emptyStreamingIDs: ReadonlySet<string> = new Set<string>();
  const streamingIDs = signal<ReadonlySet<string>>(emptyStreamingIDs);
  const streamingParts = new Map<string, Set<number>>(), endedParts = new Map<string, Set<number>>();
  function clearStreamingSelection(forgetEnded = true) {
    if (forgetEnded) endedParts.clear();
    else for (const [messageID, parts] of streamingParts) {
      const ended = endedParts.get(messageID) ?? new Set<number>();
      parts.forEach(ordinal => ended.add(ordinal)); endedParts.set(messageID, ended);
    }
    streamingParts.clear();
    if (streamingIDs().size) streamingIDs.set(emptyStreamingIDs);
  }
  function setStreamingPart(messageID: string, ordinal: number, active: boolean) {
    if (!messageID || !Number.isSafeInteger(ordinal) || ordinal < 0 || active && endedParts.get(messageID)?.has(ordinal)) return;
    const parts = streamingParts.get(messageID) ?? new Set<number>();
    const wasStreaming = parts.size > 0;
    if (active) parts.add(ordinal);
    else {
      parts.delete(ordinal);
      const ended = endedParts.get(messageID) ?? new Set<number>();
      ended.add(ordinal); endedParts.set(messageID, ended);
    }
    if (parts.size) streamingParts.set(messageID, parts); else streamingParts.delete(messageID);
    if (wasStreaming === (parts.size > 0)) return;
    const next = new Set(streamingIDs());
    if (parts.size) next.add(messageID); else next.delete(messageID);
    streamingIDs.set(next.size ? next : emptyStreamingIDs);
  }
  function resetHistoryAuthority() {
    cancelActivityFill?.(true);
    batch(() => { resolvedAuthority.set(false); clearStreamingSelection(); historyGeneration.set(historyGeneration() + 1); });
  }
  const loading = signal(false), sending = signal(false), busy = signal(false), more = signal(false), hasGap = signal(false);
  const olderLoading = signal(false), historyError = signal('');
  const durable = openDraft(app.connection()?.id ?? `unconnected:${generation}`, target);
  const { draft, attachments, pendingSend, queueEdit } = durable;
  const active = signal(true), syncActive = signal(false), syncDemand = signal(true);
  const retry = signal<Row | null>(null), streamState = signal<'inactive' | 'connecting' | 'live' | 'disconnected'>('inactive');
  const executionError = signal('');
  const commands = signal<Row[]>([]);
  const queueBusy = signal(''), queueError = signal('');
  const owner = ++nextChatOwner;
  const makeMessageScope = () => Object.freeze({ hostID: durable.scope.host, generation: operationLane.generation, sessionID: target.kind === 'session' ? target.id : '', directory: target.directory });
  let messageScope = makeMessageScope();
  const historyBusy = Object.assign(() => { laneRevision(); return operationLane.history.historyBusy(); }, {
    set: (value: boolean) => { if (current()) operationLane.history.historyBusy.set(value); },
    update: (work: (value: boolean) => boolean) => { if (current()) operationLane.history.historyBusy.update(work); },
  });
  const revertSource = signal<NativeRevert | null>(null), historyRepairPending = signal(false);
  let historyRevision = 0, historyNeedsReset = false;
  const committedHiddenIDs = new Set<string>();
  function setRevert(value: NativeRevert | null) {
    let changed = false;
    batch(() => {
      const boundaryChanged = revertSource()?.messageID !== value?.messageID;
      changed = boundaryChanged;
      if (boundaryChanged && historyPresentationListener) presentHistory('reset', { revert: value, historyGeneration: historyGeneration() + 1, resolved: false, repairPending: historyRepairPending() || !!revertSource() && !value });
      if (boundaryChanged) resetHistoryAuthority();
      if (revertSource() && !value) { historyNeedsReset = true; historyRepairPending.set(true); }
      historyRevision++; revertSource.set(value);
      if (boundaryChanged) updateTasks();
    });
    if (changed) snapshotCommitted();
  }
  const revert = Object.assign(() => revertSource(), { set: setRevert, update: (work: (value: NativeRevert | null) => NativeRevert | null) => setRevert(work(revertSource())) });
  const visibleMessages = () => {
    const rows = messages(), boundary = revert()?.messageID;
    if (historyRepairPending()) return [];
    if (!boundary) return rows;
    const index = rows.findIndex(message => message.id === boundary);
    return index < 0 ? [] : rows.slice(0, index);
  };
  const historyBoundaryMissing = () => !!revert() && !messages().some(message => message.id === revert()?.messageID);
  let historyPresentationListener = dependencies.beforeHistoryPresentationFlush;
  let previousHistoryPresentation: NativeHistoryPresentation | undefined;
  /** Only the history writers call this, inside their batch and before their writes. */
  function presentHistory(authority: NativeHistoryPresentation['authority'], next: Partial<Omit<NativeHistoryPresentation, 'authority' | 'scope' | 'boundaryMissing'>> & { rows?: readonly Message[]; revert?: NativeRevert | null; historyGeneration?: number } = {}) {
    if (!historyPresentationListener || !foreground() || retiredAuthority) return;
    untracked(() => {
      const boundary = ('revert' in next ? next.revert : revertSource())?.messageID;
      const scope = Object.freeze({ hostID: durable.scope.host, generation: operationLane.generation, owner, historyGeneration: next.historyGeneration ?? historyGeneration(), targetKind: target.kind, targetID: target.id, directory: target.directory });
      const value: NativeHistoryPresentation = Object.freeze({ authority, scope, more: next.more ?? more(), historyError: next.historyError ?? historyError(),
        boundaryMissing: !!boundary && !(next.rows ?? messages()).some(message => message.id === boundary), repairPending: next.repairPending ?? historyRepairPending(),
        hasGap: next.hasGap ?? hasGap(), readError: next.readError ?? messageReadError(), resolved: next.resolved ?? resolvedAuthority() });
      const previous = previousHistoryPresentation;
      if (previous && previous.authority === authority && previous.scope.historyGeneration === scope.historyGeneration && previous.more === value.more && previous.historyError === value.historyError && previous.boundaryMissing === value.boundaryMissing && previous.repairPending === value.repairPending && previous.hasGap === value.hasGap && previous.readError === value.readError && previous.resolved === value.resolved) return;
      previousHistoryPresentation = value;
      try { historyPresentationListener?.(value); } catch { /* Presentation must not interrupt the authoritative writer. */ }
    });
  }
  chatOwners.set([...chatOwners(), owner]);
  let alive = true, flight: Promise<void> | undefined, queued = false;
  let cursor: string | null = null, contactGeneration: number | undefined, contactRevision = -1;
  let messagesLoaded = false;
  let authorityMessageIDs = new Set<string>();
  const olderCursors = new Set<string>();
  let olderFlight: Promise<void> | undefined;
  let catchup: { page: ReturnType<typeof messagesFrom>; anchors: Set<string>; visited: Set<string> } | undefined;
  let liveRevision = 0, blockingRevision = 0, activation = 0;
  const streaming = new Map<string, { message: Message; revision: number }>();
  let streamRevision = 0, tasksDirty = false;
  type ChatDomain = 'messages' | 'status' | 'inbox' | 'permissions' | 'forms' | 'goal';
  const pendingRefresh = new Set<ChatDomain>();
  const allChatDomains: ChatDomain[] = ['messages', 'status', 'inbox', 'permissions', 'forms'];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deltaTimer: ReturnType<typeof setTimeout> | undefined;
  let streamDisconnected = false;
  const seenEvents = new Set<string>();
  let latestStatusClock = -1;
  const inboxTerminals = new Map<string, 'delivered' | 'cancelled'>();
  let queueFlight: Promise<boolean> | undefined, recoveryFlight: Promise<boolean> | undefined;
  const laneCurrent = (lane: OperationLane) => alive && !retiredAuthority && lane === operationLane && runtimeReady() && !switching && lane.generation === generation && sameRuntimeScope(lane.scope, app.runtimeScope());
  const current = () => laneCurrent(operationLane);
  const referenceCurrent = () => current() && app.connection()?.id === durable.scope.host;
  const referenceSnapshot = (): ScopedReferenceDocument => {
    const document = durable.document();
    return { text: document.text, scope: { ...document.scope }, references: document.references.map(ref => ({ ...ref, ...(ref.scope ? { scope: { ...ref.scope } } : {}) })) };
  };
  function submissionReferences(submission: Submission): ScopedReferenceDocument {
    const document = submission.references ?? { text: submission.text, references: [], scope: durable.scope };
    if (document.text !== submission.text || !sameReferenceScope(document.scope, durable.scope)) throw new Error('native-reference-scope-mismatch');
    validateNativeReferences(document);
    if (document.references.some(ref => ref.scope && !sameReferenceScope(ref.scope, durable.scope))) throw new Error('native-reference-scope-mismatch');
    return { text: document.text, scope: { ...document.scope }, references: document.references.map(ref => ({ ...ref, ...(ref.scope ? { scope: { ...ref.scope } } : {}) })) };
  }
  function setDraftText(value: string) {
    if (!current()) return false;
    durable.setDraftText(value); return true;
  }
  function insertReference(candidate: ReferenceCandidate, start?: number, end?: number) {
    if (!referenceCurrent()) return false;
    if (target.kind !== 'session') throw new Error('Assistant references are not supported by this client');
    durable.insertReference(candidate, start, end); return true;
  }
  function setReferenceDocument(next: ScopedReferenceDocument, expected?: ScopedReferenceDocument) {
    if (!referenceCurrent()) return false;
    if (expected && (!sameReferenceScope(expected.scope, durable.scope) || !durable.matchesDocument(expected.text, expected.references))) return false;
    durable.setDocument(next); return true;
  }
  const foreground = () => current() && (active() || syncActive()) && lifecycle() === 'active' && chatOwners().at(-1) === owner;
  const laneForeground = (lane: OperationLane) => laneCurrent(lane) && foreground();
  let goalObservers = 0, goalNotice = 0;
  const goalRevision = signal(0);
  const goalCore = createGoalController({ sessionID: target.kind === 'session' ? target.id : '', directory: target.directory }, {
    get: scope => createGoalTransport(operationLane.request).get(scope),
    command: (scope, command) => createGoalTransport(operationLane.request).command(scope, command),
  }, () => target.kind === 'session' && !!operationLane.scope && active() && foreground() && referenceCurrent(), () => goalRevision.set(++goalNotice));
  const goalState = () => { goalRevision(); const state = goalCore.state(); return current() && (sending() || historyBusy()) ? { ...state, busy: true } : state; };
  let goalArmCapture: { submissionID: string; snapshot: GoalArmSnapshot } | undefined;
  const projectTasks = createTasksProjection(), taskSnapshot = signal<readonly NativeTask[]>([]);
  const tasks = () => taskSnapshot();
  function updateTasks() {
    if (target.kind !== 'session') return;
    const next = projectTasks(visibleMessages()) ?? [];
    const previous = tasks();
    if (next !== previous && (next.length || previous.length)) taskSnapshot.set(next);
  }
  async function goalControl(action: 'pause' | 'resume' | 'clear'): Promise<GoalCommandResult> {
    const lane = operationLane;
    if (!active() || !foreground() || target.kind !== 'session' || sending() || historyBusy() || pendingSend() || queueEdit()) return 'blocked';
    const result = await send({}, false, action);
    return result ? 'acknowledged' : laneCurrent(lane) ? 'failed' : 'stale';
  }
  const toggleGoal = () => !goalCore.state().goal || goalCore.state().goal?.status === 'complete'
    ? Promise.resolve<GoalCommandResult>('blocked') : goalControl(goalCore.state().goal?.status === 'active' ? 'pause' : 'resume');
  const goal = {
    state: goalState,
    controller: { scope: goalCore.scope, refresh: goalCore.refresh, setArmed: goalCore.setArmed, captureArm: goalCore.captureArm, toggle: toggleGoal, clear: () => goalControl('clear') },
    /** Observe once from the primary Chat; no new effect, socket or safety poll. */
    observe() {
      if (target.kind !== 'session') return () => {};
      goalObservers++;
      if (goalObservers === 1) void goalCore.refresh();
      let observing = true;
      return () => { if (!observing) return; observing = false; goalObservers--; if (!goalObservers) goalCore.invalidateRead(); };
    },
  };
  const messagesResolved = () => { app.connection(); return current() && resolvedAuthority(); };
  const streamingMessageIDs = (): ReadonlySet<string> => foreground() ? streamingIDs() : emptyStreamingIDs;
  let retiredAuthority = false, suspendedOperations = false;
  const retireAuthority = (reason: 'suspend' | 'host' = 'host') => {
    if (retiredAuthority) {
      if (reason === 'host' && suspendedOperations) { suspendedOperations = false; historyPresentationListener = undefined; messageCommitListeners.clear(); goalCore.retire(); taskSnapshot.set([]); }
      return;
    }
    retiredAuthority = true;
    suspendedOperations = reason === 'suspend';
    previousHistoryPresentation = undefined;
    if (!suspendedOperations) { historyPresentationListener = undefined; messageCommitListeners.clear(); }
    resetHistoryAuthority();
    if (suspendedOperations) goalCore.cancel(); else { goalCore.retire(); taskSnapshot.set([]); }
    goalArmCapture = undefined;
  };
  function rebuildOperationLane() {
    if (!alive || !suspendedOperations || !runtimeReady() || switching || lifecycle() !== 'active' || app.connection()?.id !== durable.scope.host) return false;
    const next = makeOperationLane();
    if (next.scope && next.scope.hostID !== durable.scope.host) return false;
    batch(() => {
      operationLane.history.historyBusy.set(false);
      operationLane.history.close();
      operationLane = next; messageScope = makeMessageScope(); retiredAuthority = false; suspendedOperations = false;
      flight = undefined; olderFlight = undefined; queueFlight = undefined; recoveryFlight = undefined; queued = false;
      loading.set(false); olderLoading.set(false); sending.set(false); queueBusy.set('');
      laneRevision.set(laneRevision() + 1);
    });
    return true;
  }
  chatAuthorityRetirements.add(retireAuthority);
  chatOperationResumptions.add(rebuildOperationLane);
  const scoped = (suffix: string) => `${sessionPath(target.id, suffix)}?${query(target.directory)}`;
  const fail = (failure: unknown) => { if (current()) error.set(failure instanceof Error ? failure.message : String(failure)); };
  const activityRevision = signal(0);
  const activityFill = createActivityMaterializer({
    current: () => target.kind === 'session' && foreground(),
    message: id => streaming.has(id) || streamingIDs().has(id) ? undefined : visibleMessages().find(message => message.id === id),
    read: async (id, expected) => { const request = operationLane.request; return materializedActivityMessage(await request(`${sessionPath(target.id, `message/${encodeURIComponent(id)}`)}?${query(target.directory)}`), expected, target.id); },
    apply: (full, expected) => {
      if (!foreground() || streaming.has(expected.id)) return false;
      const rows = messages(), index = rows.findIndex(message => message.id === expected.id);
      if (rows[index] !== expected) return false;
      const next = rows.slice(); next[index] = full; messages.set(next); updateTasks(); snapshotCommitted(); return true;
    },
    changed: () => untracked(() => activityRevision.set(activityRevision() + 1)),
  });
  cancelActivityFill = activityFill.cancel;
  const activityMaterialization = {
    state: (ids: readonly string[]) => { activityRevision(); return activityFill.state(ids); },
    request: activityFill.request,
  };
  async function refreshHistory(valid: () => boolean = current, lane = operationLane) {
    const request = lane.request;
    if (target.kind !== 'session') return null;
    const revision = historyRevision;
    const session = record(unwrap(await request(`/api/session/${encodeURIComponent(target.id)}?${query(target.directory)}`)));
    if (!laneCurrent(lane) || !valid()) throw new Error('Session history source changed');
    if (session.id !== target.id) throw new Error('Invalid session history authority');
    const value = session.revert ? nativeRevertFrom(session.revert) : null;
    if (revision === historyRevision) setRevert(value);
    return revert();
  }
  function trimCommitted(boundary: string) {
    if (committedHiddenIDs.has(boundary)) return;
    committedHiddenIDs.add(boundary);
    const rows = messages(), index = rows.findIndex(message => message.id === boundary);
    batch(() => {
      if (historyPresentationListener) presentHistory('reset', { revert: null, hasGap: false, resolved: false, historyGeneration: historyGeneration() + 1, repairPending: historyRepairPending() || index < 0 });
      resetHistoryAuthority();
      streaming.clear(); catchup = undefined; hasGap.set(false);
      if (index >= 0) { rows.slice(index).forEach(message => committedHiddenIDs.add(message.id)); messages.set(rows.slice(0, index)); }
      else { historyNeedsReset = true; historyRepairPending.set(true); }
      authorityMessageIDs = new Set(messages().filter(message => authorityMessageIDs.has(message.id)).map(message => message.id));
      historyRevision++; revertSource.set(null); updateTasks();
    });
    snapshotCommitted();
  }
  async function repairCommittedHistory(lane = operationLane) {
    const request = lane.request, foreground = () => laneForeground(lane);
    if (!historyNeedsReset) return;
    const revision = historyRevision;
    let page: ReturnType<typeof messagesFrom>;
    try { page = messagesFrom(await request(`${scoped('message')}&limit=20&order=desc`), false); }
    catch (failure) {
      if (foreground() && revision === historyRevision) batch(() => { const message = failure instanceof Error ? failure.message : String(failure); if (historyPresentationListener) presentHistory('failure', { readError: message }); messageReadError.set(message); });
      throw failure;
    }
    if (!foreground()) throw new Error('Session history source changed');
    if (revision !== historyRevision) throw new Error('Session history source changed');
    const rows = stableHistoryMessages(messages(), page.messages);
    batch(() => {
      if (historyPresentationListener) presentHistory('successful-history', { rows, hasGap: false, more: !page.complete, repairPending: false, resolved: true, readError: '' });
      streaming.clear(); catchup = undefined; olderCursors.clear(); hasGap.set(false); messages.set(rows); cursor = page.cursor; more.set(!page.complete); messagesLoaded = true;
      authorityMessageIDs = new Set(page.messages.map(message => message.id));
      historyNeedsReset = false; historyRepairPending.set(false);
      resolvedAuthority.set(true);
      updateTasks();
      messageReadError.set('');
    });
    snapshotCommitted();
  }
  async function commitStagedRevertBeforeSend(lane: OperationLane) {
    const request = lane.request, foreground = () => laneForeground(lane);
    if (target.kind !== 'session') return;
    const marker = await refreshHistory(foreground, lane);
    if (!foreground()) throw new Error('Session history source changed');
    if (marker) {
      try { await request(scoped('revert/commit'), 'POST'); }
      catch (failure) {
        // A lost response may already have committed. Only fresh authority can clear it.
        if (foreground()) { try { await refreshHistory(foreground, lane); await repairCommittedHistory(lane); } catch { /* Retain the last valid marker and original write failure. */ } }
        throw failure;
      }
      if (!foreground()) throw new Error('Session history source changed');
      trimCommitted(marker.messageID);
    }
    await repairCommittedHistory(lane);
  }
  function publishStream() {
    if (!foreground()) return;
    // Token batches only replace touched rows; unchanged history keeps its identity.
    const replacements = new Map([...streaming].map(([key, entry]) => [key, entry.message]));
    const previous = messages();
    const committed: Message[] | undefined = messageCommitListeners.size ? [] : undefined;
    const replace = (message: Message) => { const value = replacements.get(message.id); replacements.delete(message.id); return value ?? message; };
    const next = previous.map(committed ? message => { const value = replace(message); if (value !== message) committed.push(value); return value; } : replace);
    const rows = hasGap() ? next : [...next, ...replacements.values()];
    if (committed && !hasGap()) for (const value of replacements.values()) committed.push(value);
    if (rows.length !== previous.length || rows.some((message, index) => message !== previous[index])) batch(() => {
      if (historyPresentationListener && rows.length !== previous.length && revertSource()) presentHistory('presentation', { rows });
      messages.set(rows);
    });
    if (tasksDirty) { tasksDirty = false; updateTasks(); }
    if (committed?.length) emitMessageCommit({ kind: 'patch', messages: committed });
  }
  function bufferStream(message: Message) {
    streaming.set(message.id, { message, revision: ++streamRevision });
    if (!deltaTimer) deltaTimer = setTimeout(() => { deltaTimer = undefined; publishStream(); }, 32);
  }
  function prepareMessages(next: Message[], streamAtStart: number) {
    for (const message of next) {
      const overlay = streaming.get(message.id);
      if (overlay && overlay.revision <= streamAtStart) streaming.delete(message.id);
    }
    const previous = messages();
    const rows = stableHistoryMessages(previous, mergeMessages(next, [...streaming.values()].map(entry => entry.message)));
    return rows;
  }
  function schedule(changed: ChatDomain[] = allChatDomains) {
    changed.forEach(domain => pendingRefresh.add(domain));
    if (!foreground() || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!foreground()) return;
      const selected = [...pendingRefresh]; pendingRefresh.clear();
      void load(false, selected);
    }, 120);
  }
  async function loadOlder(automatic = false, lane = operationLane): Promise<void> {
    const foreground = () => laneForeground(lane), current = () => laneCurrent(lane);
    if (!foreground() || !cursor || automatic && historyError()) return;
    if (olderFlight) return olderFlight;
    const activeAtStart = activation;
    const valid = () => foreground() && activeAtStart === activation;
    batch(() => { if (historyPresentationListener && historyError()) presentHistory('presentation', { historyError: '' }); olderLoading.set(true); historyError.set(''); });
    const work = (async () => {
      // A refresh and a prepend share a lane, but neither request may erase the other.
      while (flight) { await flight; if (!valid()) return; }
      if (valid() && cursor) await loadSnapshot(true, ['messages'], lane);
    })();
    olderFlight = work;
    try { await work; }
    finally { if (olderFlight === work) olderFlight = undefined; if (current()) olderLoading.set(false); }
  }
  function load(older = false, selected: ChatDomain[] = allChatDomains, lane = operationLane): Promise<void> {
    return older ? loadOlder(false, lane) : loadSnapshot(false, selected, lane);
  }
  async function loadSnapshot(older = false, selected: ChatDomain[] = allChatDomains, lane = operationLane): Promise<void> {
    const request = lane.request, current = () => laneCurrent(lane);
    if (!current() || older && !cursor) return;
    if (flight) { if (!older) { queued = true; selected.forEach(domain => pendingRefresh.add(domain)); } return flight; }
    const activeAtStart = activation;
    const valid = () => current() && activeAtStart === activation;
    const statusAtStart = liveRevision, blockingAtStart = blockingRevision;
    const streamAtStart = streamRevision;
    const errorAtStart = error();
    loading.set(messages().length === 0 || older);
    const errors: unknown[] = [];
    const apply = async (work: () => Promise<void>) => { try { await work(); } catch (failure) { errors.push(failure); } };
    const applyMessageRead = async (work: () => Promise<void>) => apply(async () => {
      try { await work(); }
      catch (failure) {
        if (valid()) { const message = failure instanceof Error ? failure.message : String(failure); batch(() => { if (historyPresentationListener) presentHistory('failure', { readError: message, ...(older ? { historyError: message } : {}) }); messageReadError.set(message); if (older) historyError.set(message); }); snapshotCommitted(message); }
        throw failure;
      }
    });
    let historyReadFailed = false;
    const historyRead = !older && target.kind === 'session' && (selected.includes('messages') || selected.includes('status'))
      ? apply(async () => {
        try { await refreshHistory(valid, lane); }
        catch (failure) { historyReadFailed = true; if (valid() && historyPresentationListener) batch(() => presentHistory('failure')); throw failure; }
      }) : Promise.resolve();
    const work = (async () => {
      await Promise.all([
        ...(!older && selected.includes('goal') && goalObservers ? [goalCore.refresh()] : []),
         ...(selected.includes('messages') ? [applyMessageRead(async () => {
          await historyRead;
          const historyAtStart = historyRevision;
          const path = target.kind === 'assistant'
            ? `${assistantPath(target.id, 'contact/messages')}?limit=30${older && cursor ? `&before=${encodeURIComponent(cursor)}` : ''}`
            : `${scoped('message')}&limit=20${older && cursor ? `&cursor=${encodeURIComponent(cursor)}` : '&order=desc'}`;
           let page = messagesFrom(await request(path), target.kind === 'assistant');
           if (!valid()) return;
          if (historyAtStart !== historyRevision) { queued = true; pendingRefresh.add('messages'); return; }
          if (page.generation !== undefined && contactGeneration !== undefined && page.generation < contactGeneration) return;
          if (page.generation === contactGeneration && page.revision !== undefined && page.revision < contactRevision) return;
           const reset = page.generation !== undefined && contactGeneration !== undefined && page.generation > contactGeneration;
           if (older && !reset && !page.complete && page.cursor && (page.cursor === cursor || olderCursors.has(page.cursor))) throw new Error('History cursor did not advance');
           if (reset || historyNeedsReset) catchup = undefined;
           // Bridge a sliding tail to the loaded window before presenting it as contiguous.
           if (!older && !reset && messagesLoaded && messages().length && !page.complete) {
             const known = catchup?.anchors ?? authorityMessageIDs;
             let boundary = page;
             let overlap = page.messages.some(message => known.has(message.id));
             const freshIDs = new Set(page.messages.map(message => message.id));
             let visited = new Set<string>();
             if (!overlap && catchup && catchup.page.generation === page.generation && catchup.page.messages.some(message => freshIDs.has(message.id))) {
               boundary = catchup.page;
               visited = new Set(catchup.visited);
               page = { ...page, messages: mergeHistoryMessages(catchup.page.messages, page.messages), cursor: catchup.page.cursor, complete: catchup.page.complete };
               overlap = page.messages.some(message => known.has(message.id));
             }
             for (let count = 0; !overlap && !boundary.complete && boundary.cursor && count < 5; count++) {
               if (visited.has(boundary.cursor)) throw new Error('History cursor did not advance');
               visited.add(boundary.cursor);
               const before = boundary.cursor;
               const nextPath = target.kind === 'assistant'
                ? `${assistantPath(target.id, 'contact/messages')}?limit=30&before=${encodeURIComponent(boundary.cursor)}`
                : `${scoped('message')}&limit=20&cursor=${encodeURIComponent(boundary.cursor)}`;
               boundary = messagesFrom(await request(nextPath), target.kind === 'assistant');
               if (!valid()) return;
               if (historyAtStart !== historyRevision) { catchup = undefined; queued = true; pendingRefresh.add('messages'); return; }
               if (boundary.generation !== page.generation) { catchup = undefined; queued = true; pendingRefresh.add('messages'); return; }
               if (!boundary.complete && boundary.cursor === before) throw new Error('History cursor did not advance');
               overlap = boundary.messages.some(message => known.has(message.id));
               page = { ...page, messages: mergeHistoryMessages(boundary.messages, page.messages), cursor: boundary.cursor, complete: boundary.complete };
             }
              if (!overlap && !boundary.complete) { catchup = { page, anchors: known, visited }; batch(() => { if (historyPresentationListener) presentHistory('presentation', { hasGap: true }); hasGap.set(true); }); return; }
           }
           if (!older) catchup = undefined;
          contactGeneration = page.generation;
          contactRevision = page.revision ?? contactRevision;
          if (historyAtStart !== historyRevision) { queued = true; pendingRefresh.add('messages'); return; }
           const previous = messages();
           const coverage = new Set(reset || historyNeedsReset || !messagesLoaded || !older && page.complete ? [] : authorityMessageIDs);
            page.messages.forEach(message => coverage.add(message.id));
            batch(() => {
              const replacing = historyNeedsReset;
              // Preparing rows only reconciles the existing stream overlay; signals are still unchanged.
              if (reset || replacing) streaming.clear();
              let rows: Message[];
              if (replacing || !messagesLoaded || reset || !older && page.complete) rows = prepareMessages(page.messages, streamAtStart);
              else if (!older && target.kind === 'assistant' && page.messages.length) {
                const first = page.messages[0]!;
                rows = prepareMessages([...previous.filter(message => (message.ordinal ?? 0) < (first.ordinal ?? 0) || message.ordinal === first.ordinal && message.id < first.id), ...page.messages], streamAtStart);
              } else if (!older) {
                const known = new Set(previous.map(message => message.id));
                const first = page.messages.find(message => known.has(message.id));
                const boundary = first ? previous.findIndex(message => message.id === first.id) : -1;
                rows = prepareMessages(boundary >= 0 ? [...previous.slice(0, boundary), ...page.messages] : mergeMessages(previous, page.messages), streamAtStart);
              } else rows = prepareMessages(mergeHistoryMessages(previous, page.messages, true), streamAtStart);
              const ownsCursor = older || !messagesLoaded || !previous.length || reset || page.complete;
              if (historyPresentationListener) presentHistory(historyReadFailed ? 'failure' : 'successful-history', { rows, more: ownsCursor ? !page.complete : more(), hasGap: reset || page.complete || !older ? false : hasGap(),
                repairPending: replacing ? false : historyRepairPending(), resolved: true, readError: '', historyError: older ? '' : historyError(), historyGeneration: historyGeneration() + (reset ? 1 : 0) });
              if (reset) { resetHistoryAuthority(); streaming.clear(); }
              if (rows !== previous) messages.set(rows);
              if (replacing) { historyNeedsReset = false; historyRepairPending.set(false); }
             if (reset) olderCursors.clear();
             else if (older && cursor) olderCursors.add(cursor);
             else if (!messagesLoaded || !previous.length || page.complete) olderCursors.clear();
             if (older || !messagesLoaded || !previous.length || reset || page.complete) { cursor = page.cursor; more.set(!page.complete); }
             messagesLoaded = true;
             authorityMessageIDs = new Set(messages().filter(message => coverage.has(message.id)).map(message => message.id));
              if (reset || page.complete || !older) hasGap.set(false);
               resolvedAuthority.set(true);
               messageReadError.set('');
               if (older) historyError.set('');
               updateTasks();
            });
            snapshotCommitted();
        })] : []),
        ...(!older && selected.includes('status') ? [apply(async () => {
          if (target.kind === 'session') {
            const value = activeFrom(await request('/api/session/active'), target.id);
            if (valid() && statusAtStart === liveRevision) { busy.set(value); if (!value) retry.set(null); }
          } else {
            const value = record(await request('/api/yuri/assistants/snapshot'));
            if (!Array.isArray(value.assistants)) throw new Error('Invalid assistants snapshot');
            const bot = list(value.assistants).find(item => item.id === target.id);
            if (!bot) throw new Error('Assistant unavailable');
            if (valid() && statusAtStart === liveRevision) busy.set(bot.working === true || !!bot.activeContactTurn);
          }
        })] : []),
        historyRead,
        ...(target.kind === 'session' && !older ? [
           ...(selected.includes('inbox') ? [apply(async () => { const value = inboxFrom(await request(scoped('inbox'))); if (valid() && blockingAtStart === blockingRevision) inbox.set(value.filter(item => !inboxTerminals.has(text(item.id)))); })] : []),
          ...(selected.includes('permissions') ? [apply(async () => { const value = rowsFrom(await request(`/api/permission/request?${query(target.directory)}`)).filter(item => item.sessionID === target.id); if (valid() && blockingAtStart === blockingRevision) permissions.set(value); })] : []),
          ...(selected.includes('forms') ? [apply(async () => { const value = rowsFrom(await request(scoped('form'))); if (valid() && blockingAtStart === blockingRevision) forms.set(value); })] : []),
        ] : []),
      ]);
        if (valid() && older) { const message = errors.map(failure => failure instanceof Error ? failure.message : String(failure)).join('\n'); if (message !== historyError()) batch(() => { if (historyPresentationListener) presentHistory(message ? 'failure' : 'presentation', { historyError: message }); historyError.set(message); }); }
       if (valid() && !older && (errors.length || error() === errorAtStart)) error.set(errors.length ? errors.map(failure => failure instanceof Error ? failure.message : String(failure)).join('\n') : executionError());
    })();
    flight = work;
    try { await work; }
    finally {
      if (flight === work) flight = undefined;
      if (current()) loading.set(false);
      if (current() && queued) { queued = false; schedule([]); }
    }
  }
  async function reconcile(submission: Submission, lane: OperationLane): Promise<boolean> {
    const request = lane.request, current = () => laneCurrent(lane);
    if (inboxTerminals.get(submission.id) === 'delivered') return true;
    if (target.kind === 'assistant') {
      const page = messagesFrom(await request(`${assistantPath(target.id, 'contact/messages')}?messageID=${encodeURIComponent(submission.id)}&limit=1`), true, 1);
      return page.messages.some(message => message.id === submission.id && message.role === 'user');
    }
    try {
      const pending = inboxFrom(await request(scoped('inbox')));
      if (pending.some(item => item.id === submission.id)) return true;
    } catch { /* A failed inbox read must still allow exact promoted-message recovery. */ }
    if (!current()) return false;
    const value = record(unwrap(await request(scoped(`message/${encodeURIComponent(submission.id)}`))));
    return (record(value.info).id ?? value.id) === submission.id;
  }
  function terminalInbox(inboxID: string, reason: 'delivered' | 'cancelled') {
    if (inboxTerminals.get(inboxID) === 'delivered') return;
    inboxTerminals.set(inboxID, reason);
    if (inboxTerminals.size > 4096) inboxTerminals.delete(inboxTerminals.keys().next().value!);
    blockingRevision++;
    inbox.set(inbox().filter(item => item.id !== inboxID));
  }
  async function queuedAuthority(inboxID: string, lane: OperationLane) {
    const request = lane.request, current = () => laneCurrent(lane);
    const revision = blockingRevision;
    const rows = inboxFrom(await request(scoped('inbox')));
    if (!current()) throw new Error('Connection changed');
    if (revision === blockingRevision) inbox.set(rows.filter(item => !inboxTerminals.has(text(item.id))));
    return inboxTerminals.has(inboxID) ? undefined : rows.find(item => item.id === inboxID);
  }
  async function exactDelivered(messageID: string, lane: OperationLane) {
    const request = lane.request;
    if (inboxTerminals.get(messageID) === 'delivered') return true;
    try {
      const value = record(unwrap(await request(scoped(`message/${encodeURIComponent(messageID)}`))));
      const found = text(record(value.info).id) || text(value.id);
      if (found !== messageID) throw new Error('Invalid exact message authority');
      return true;
    } catch (failure) {
      if (record(failure).status === 404) return false;
      throw failure;
    }
  }
  async function recoverQueueEdit(lane = operationLane) {
    const current = () => laneCurrent(lane);
    await durable.whenReady();
    const edit = queueEdit();
    if (!edit || !current() || target.kind !== 'session') return false;
    const delivered = await exactDelivered(edit.id, lane);
    if (!current() || queueEdit() !== edit) return false;
    if (delivered) {
      terminalInbox(edit.id, 'delivered');
      // Do not erase text the user changed while this transfer was being checked.
      if (durable.matches(edit.text, edit.files)) { draft.set(''); attachments.set([]); queueEdit.set(null); await durable.flush(); }
      if (!current()) return false;
      error.set('该队列输入已被消费，未重新发送；已保留后续编辑供核对');
      return false;
    }
    const pending = await queuedAuthority(edit.id, lane);
    if (!current() || queueEdit() !== edit) return false;
    if (pending) { error.set('队列项尚未确认取消，请重试编辑操作'); return false; }
    // DELETE settled and exact message authority confirms it was not consumed.
    terminalInbox(edit.id, 'cancelled'); queueEdit.set(null);
    await durable.flush();
    return true;
  }
  function mutateInbox(inboxID: string, work: (lane: OperationLane) => Promise<boolean>): Promise<boolean> {
    const lane = operationLane, current = () => laneCurrent(lane);
    if (!active() || !current() || target.kind !== 'session') return Promise.resolve(false);
    if (queueFlight) return queueBusy() === inboxID ? queueFlight : Promise.resolve(false);
    queueBusy.set(inboxID); queueError.set(''); error.set('');
    let flight: Promise<boolean> | undefined;
    flight = (async () => {
      try { await durable.whenReady(); if (!current()) return false; return await work(lane); }
      catch (failure) { if (current()) { queueError.set(failure instanceof Error ? failure.message : String(failure)); fail(failure); } return false; }
      finally { if (queueFlight === flight) queueFlight = undefined; if (current()) queueBusy.set(''); }
    })();
    queueFlight = flight;
    return flight;
  }
  const cancelInbox = (inboxID: string) => mutateInbox(inboxID, async lane => {
    const request = lane.request, current = () => laneCurrent(lane);
    if (!await queuedAuthority(inboxID, lane)) return false;
    await request(scoped(`inbox/${encodeURIComponent(inboxID)}`), 'DELETE');
    if (!current()) return false;
    terminalInbox(inboxID, 'cancelled');
    if (pendingSend()?.id === inboxID) { pendingSend.set(null); await durable.flush(); }
    return true;
  });
  const steerInbox = (inboxID: string) => mutateInbox(inboxID, async lane => {
    const request = lane.request, current = () => laneCurrent(lane);
    if (!await queuedAuthority(inboxID, lane)) return false;
    await request(scoped(`inbox/${encodeURIComponent(inboxID)}`), 'PATCH', { delivery: 'steer' });
    if (!current() || inboxTerminals.has(inboxID)) return false;
    blockingRevision++;
    inbox.set(inbox().map(item => item.id === inboxID ? { ...item, delivery: 'steer' } : item));
    schedule(['inbox', 'status']);
    return true;
  });
  const editInbox = (inboxID: string) => mutateInbox(inboxID, async lane => {
    const request = lane.request, current = () => laneCurrent(lane);
    const existing = queueEdit();
    if (existing && existing.id !== inboxID) throw new Error('请先确认上一项队列编辑的结果');
    if (!existing) {
      if (draft() || attachments().length || pendingSend()) throw new Error('请先处理当前草稿，队列编辑不会覆盖已有输入');
      const revision = durable.revision();
      const item = await queuedAuthority(inboxID, lane);
      if (!item || item.delivery !== 'queue') throw new Error('该项已不在待发送队列中');
      const restored = inboxDraft(item);
      if (!current() || durable.revision() !== revision) throw new Error('草稿已改变，未覆盖新输入');
      draft.set(restored.text); attachments.set(restored.files);
      queueEdit.set({ id: inboxID, ...restored });
      await durable.flush();
    }
    if (!current()) return false;
    if (inboxTerminals.get(inboxID) !== 'delivered') await request(scoped(`inbox/${encodeURIComponent(inboxID)}`), 'DELETE');
    if (!current()) return false;
    return recoverQueueEdit(lane);
  });
  async function discardQueueEdit() {
    const lane = operationLane, current = () => laneCurrent(lane);
    await durable.whenReady();
    if (!current() || !queueEdit() || queueFlight) return false;
    // Explicit UI action only: discard the recovered composer payload, not the server item.
    draft.set(''); attachments.set([]); queueEdit.set(null);
    await durable.flush(); return true;
  }
  function recoverPendingSend(): Promise<boolean> {
    const lane = operationLane, current = () => laneCurrent(lane);
    if (recoveryFlight) return recoveryFlight;
    const flight = (async () => {
      await durable.whenReady();
      const pending = pendingSend();
      if (!current() || !pending || sending()) return false;
      const references = submissionReferences(pending);
      if (references.references.length && !referenceCurrent()) throw new Error('native-reference-scope-changed');
      if (pending.command || pending.inputMode === 'shell') {
        error.set('上次命令结果未知，请核对会话；不会自动重复执行'); return false;
      }
      const revision = durable.draftRevision();
      let found = false;
      try { found = await reconcile(pending, lane); } catch (failure) { if (record(failure).status !== 404) throw failure; }
      if (references.references.length && !referenceCurrent()) throw new Error('native-reference-scope-changed');
      if (!found || !current() || pendingSend()?.id !== pending.id) return false;
      admitted(pending, revision, lane);
      await durable.flush();
      return true;
    })().finally(() => { if (recoveryFlight === flight) recoveryFlight = undefined; });
    recoveryFlight = flight; return flight;
  }
  async function loadCommands(lane = operationLane) {
    const request = lane.request, current = () => laneCurrent(lane);
    if (!current() || target.kind !== 'session') return;
    const rows = rowsFrom(await request(`/api/command?location%5Bdirectory%5D=${encodeURIComponent(target.directory)}`));
    if (current()) commands.set(rows);
  }
  async function command(name: string, args = '') {
    if (!active() || !current() || target.kind !== 'session' || sending() || historyBusy()) return false;
    if (pendingSend()) { error.set('上一条发送尚未确认，请先确认其结果'); return false; }
    if (!/^[\w:-]+$/.test(name)) { error.set('无效的命令名称'); return false; }
    draft.set(`/${name}${args ? ` ${args}` : ''}`);
    return send();
  }
  function admitted(submission: Submission, expectedDraftRevision: number, lane: OperationLane) {
    if (!laneCurrent(lane)) return;
    if (durable.draftRevision() === expectedDraftRevision && durable.matchesDocument(submission.text, submission.references?.references)) durable.setDocument({ text: '', references: [], scope: durable.scope });
    attachments.set(attachments().filter(file => !submission.files.some(capturedFile => sameAttachment(file, capturedFile))));
    pendingSend.set(null);
  }
  async function send(options: SendOptions = {}, retryPending = false, goalAction?: 'pause' | 'resume' | 'clear', lane = operationLane) {
    const request = lane.request, current = () => laneCurrent(lane), foreground = () => laneForeground(lane);
    const referenceCurrent = () => current() && app.connection()?.id === durable.scope.host;
    if (!active() || sending() || !current()) return false;
    if (!lane.scope) { error.set('scope_required'); return false; }
    const releaseHistory = lane.history.acquireSend();
    if (!releaseHistory) return false;
    sending.set(true); error.set('');
    let submission: Submission | null = null;
    let dispatched = false;
    let historyFailed = false;
    const goalArm = { ...(options.goalArm ?? goalCore.captureArm()) };
    try {
      await durable.whenReady();
      if (!current()) return false;
      if (queueEdit()) { error.set('队列编辑尚未确认取消，不能重复发送'); return false; }
      submission = pendingSend();
      if (goalAction && submission) { error.set('上一条发送尚未确认，请先确认其结果'); return false; }
      if (!goalAction && !submission && !draft().trim() && !attachments().length) return false;
      if (submission && !retryPending && !durable.matches(submission.text, submission.files, submission.references?.references)) { error.set('上一条发送结果未知，请先重试确认后再发送新草稿'); return false; }
      const draftAtStart = durable.draftRevision();
      if (!submission) {
        submission = goalAction
          ? { id: id(), text: '', files: [], delivery: 'steer', uncertain: false, inputMode: 'normal', references: { text: '', references: [], scope: { ...durable.scope } }, command: { name: 'goal', text: goalAction } }
          : { id: id(), text: draft(), files: attachments().map(file => ({ ...file })), delivery: busy() && dependencies.followUpBehavior?.() !== 'steer' ? 'queue' : 'steer', uncertain: false, inputMode: options.inputMode ?? 'normal', references: referenceSnapshot() };
        const literal = submission.text.replace(/^(\s*)\/\u2003/, '$1/');
        const invocation = slashCommand(literal);
        const tokenEnd = /^\s*\/\u2003?[^\s]+/.exec(submission.text)?.[0].length ?? 0;
        const authoredToken = !submission.references!.references.some(ref => ref.start < tokenEnd && ref.end > submission!.text.indexOf('/'));
        const goalPlan = goalAction || !goalArm.armed && !authoredToken ? null : planGoalSubmission({ text: literal, armed: goalArm.armed, objectiveOverride: goalArm.objectiveOverride,
          inputMode: submission.inputMode, sessionKind: target.kind });
        if (goalPlan?.kind === 'invalid') { error.set(t('chat.goal.toast.actionFailed')); return false; }
        if (goalPlan?.kind === 'command' && (goalArm.armed || authoredToken)) {
          submission = { ...submission, command: { name: 'goal', text: goalPlan.command.text },
            ...(goalArm.armed && goalArm.objectiveOverride?.trim() ? { preparedText: goalArm.objectiveOverride.trim() } : {}) };
          goalArmCapture = { submissionID: submission.id, snapshot: goalArm };
        }
        if (submission.inputMode === 'shell') {
          if (target.kind !== 'session' || submission.files.length || submission.references!.references.length) { error.set('Shell 仅支持会话中的文本命令'); return false; }
        } else if (!submission.command && !options.prepare && !submission.references!.references.length && target.kind === 'session') {
          if (invocation) submission = { ...submission, command: invocation };
        }
      }
      const nativeGoal = target.kind === 'session' && submission.inputMode !== 'shell' && submission.command?.name.toLowerCase() === 'goal';
      if (nativeGoal && !referenceCurrent()) throw new Error('Connection changed');
      // Empty owned document is the durable panel-control contract: never consume the composer's unrelated resources.
      const goalPanel = nativeGoal && submission.text === '' && !submission.files.length && !submission.references?.references.length;
      const references = submissionReferences(submission);
      if (references.references.length && !referenceCurrent()) throw new Error('native-reference-scope-changed');
      if (target.kind === 'assistant' && (references.references.length || submission.compiled?.agents?.length || submission.compiled?.skills?.length)) throw new Error('Assistant references are not supported by this client');
      if (target.kind === 'assistant' && (submission.files.length || submission.compiled?.files?.length)) throw new Error('Assistant attachments are not supported by this client');
      if (submission.inputMode === 'shell' && references.references.length) throw new Error('Shell references are not supported by this client');
      if (submission.uncertain && (submission.command || submission.inputMode === 'shell')) { error.set('命令结果未知；服务端不支持命令幂等重试，请先核对会话状态'); return false; }
      // Persist the exact owned document before asynchronous preparation, not just its eventual wire output.
      pendingSend.set(submission);
      await durable.flush();
      if (!current()) return false;
      if (references.references.length && !referenceCurrent()) throw new Error('native-reference-scope-changed');
      if (!submission.compiled && (!submission.command || nativeGoal && !goalPanel) && submission.inputMode !== 'shell' && (options.prepare || references.references.length || retryPending && submission.references)) {
        const input: SendPreparationInput = { text: submission.text, files: submission.files.map(file => ({ ...file })), references, scope: { ...durable.scope }, isCurrentScope: referenceCurrent };
        const compiled = await (options.prepare ? options.prepare(input) : compileNativePrompt(input, request));
        if (!current()) return false;
        if (nativeGoal && !referenceCurrent()) throw new Error('Connection changed');
        if (references.references.length && !referenceCurrent()) throw new Error('native-reference-scope-changed');
        if (!compiled || typeof compiled.text !== 'string') throw new Error('Invalid compiled submission');
        if (target.kind === 'assistant' && (compiled.files?.length || compiled.agents?.length || compiled.skills?.length)) throw new Error('Assistant references are not supported by this client');
        if (nativeGoal) {
          // Only an already captured Goal may reinterpret compiled text. Ordinary compiler output never promotes a command.
          const original = slashCommand(submission.text.replace(/^(\s*)\/\u2003/, '$1/'));
          const typedGoal = original?.name.toLowerCase() === 'goal' && submission.command?.text === original.text && submission.preparedText === undefined;
          const prepared = slashCommand(compiled.text.replace(/^(\s*)\/\u2003/, '$1/'));
          const objective = typedGoal && prepared?.name.toLowerCase() === 'goal' ? prepared.text : compiled.text;
          const plan = planGoalSubmission({ text: objective, armed: true, objectiveOverride: submission.preparedText });
          if (plan.kind !== 'command') throw new Error(t('chat.goal.toast.actionFailed'));
          const capturedCompiled = { ...compiled, ...(compiled.files ? { files: compiled.files.map(file => ({ ...file })) } : {}), ...(compiled.agents ? { agents: compiled.agents.map(agent => ({ ...agent })) } : {}), ...(compiled.skills ? { skills: compiled.skills.map(skill => ({ ...skill })) } : {}) };
          submission = { ...submission, compiled: capturedCompiled, command: { name: 'goal', text: plan.command.text }, preparedText: plan.command.text };
        } else submission = { ...submission, compiled, preparedText: compiled.text };
        pendingSend.set(submission);
      }
      if (submission.uncertain) {
        if (inboxTerminals.get(submission.id) === 'cancelled') { pendingSend.set(null); await durable.flush(); if (current()) error.set('该输入已取消，不会重复投递'); return false; }
        // Native command is 204 and has no caller id / admission receipt. Never
        // replay an ambiguous command as if prompt's stable-ID guarantee applied.
        if (submission.command || submission.inputMode === 'shell') { error.set('命令结果未知；服务端不支持命令幂等重试，请先核对会话状态'); return false; }
        let found = false;
        try { found = await reconcile(submission, lane); } catch { /* Unknown remains retryable with exactly the same input ID. */ }
        if (!current()) return;
        if (references.references.length && !referenceCurrent()) throw new Error('native-reference-scope-changed');
        if (found) { admitted(submission, draftAtStart, lane); await durable.flush(); await load(false, allChatDomains, lane); return true; }
      }
      const compiled = submission.compiled;
      const sendText = compiled?.text ?? submission.text;
      const sendFiles = compiled?.files ?? submission.files;
      const writeAhead = async () => {
        if (nativeGoal && !referenceCurrent()) throw new Error('Connection changed');
        try { if (!goalPanel) await commitStagedRevertBeforeSend(lane); }
        catch (failure) { historyFailed = true; throw failure; }
        if (!current()) throw new Error('Connection changed');
        pendingSend.set({ ...submission!, uncertain: true });
        await durable.flush();
        if (!current() || target.kind === 'session' && !foreground() || (nativeGoal || references.references.length) && !referenceCurrent()) throw new Error('Connection changed');
        dispatched = true;
      };
      if (nativeGoal) {
        const planned = planGoalSubmission({ text: `/goal${submission.command!.text ? ` ${submission.command!.text}` : ''}`, armed: false, ...(goalPanel ? {} : { delivery: submission.delivery }),
          ...(goalPanel ? {} : { files: sendFiles.map(file => ({ uri: file.uri, name: file.name })), agents: compiled?.agents, skills: compiled?.skills }) });
        // Panel controls already carry the canonical native command argument, not slash syntax.
        const goalCommand = goalPanel ? { name: 'goal' as const, text: submission.command!.text } : planned.kind === 'command' ? planned.command : null;
        if (!goalCommand) throw new Error(t('chat.goal.toast.actionFailed'));
        await writeAhead();
        if (!current()) return false;
        const capturedArm = goalArmCapture?.submissionID === submission.id ? goalArmCapture.snapshot : undefined;
        const result = await goalCore.command(goalCommand, capturedArm?.armed === true, { throwOnFailure: true, refreshAfter: goalObservers ? 'background' : false, ...(capturedArm ? { armSnapshot: capturedArm } : {}) });
        if (result !== 'acknowledged') throw new Error('Connection changed');
      } else if (submission.command) {
        await loadCommands(lane);
        if (!current()) return false;
        const registered = commands().find(item => text(item.name).toLowerCase() === submission!.command!.name.toLowerCase());
        if (!registered) {
          pendingSend.set(null); error.set('当前 Host 未注册此命令'); return false;
        }
        await writeAhead();
        await request(scoped('command'), 'POST', { name: text(registered.name), text: submission.command.text, delivery: submission.delivery,
          ...(submission.files.length ? { files: submission.files.map(file => ({ uri: file.uri, name: file.name })) } : {}),
        });
      } else if (submission.inputMode === 'shell') {
        await writeAhead();
        await request(scoped('shell'), 'POST', { command: submission.text });
      } else if (target.kind === 'assistant') {
        await writeAhead();
        const result = record(await request(assistantPath(target.id, 'messages'), 'POST', { messageID: submission.id, parts: [{ type: 'text', text: sendText }], language: 'zh-CN' }));
        if (result.admitted !== true || result.messageID !== submission.id) throw new Error('Invalid assistant admission');
      } else {
        await writeAhead();
        const result = inboxFrom([unwrap(await request(scoped('prompt'), 'POST', {
          id: submission.id, text: sendText, delivery: submission.delivery,
          ...(sendFiles.length ? { files: sendFiles.map(file => ({ uri: file.uri, name: file.name })) } : {}),
          ...(compiled?.agents?.length ? { agents: compiled.agents } : {}),
          ...(compiled?.skills?.length ? { skills: compiled.skills } : {}),
          ...(compiled?.metadata ? { metadata: compiled.metadata } : {}),
        }))]);
        if (result[0]?.id !== submission.id || result[0]?.sessionID !== target.id) throw new Error('Invalid prompt admission');
      }
      if (!current()) return false;
      if (goalPanel) pendingSend.set(null);
      else admitted(submission, draftAtStart, lane);
      if (nativeGoal && goalArmCapture?.submissionID === submission.id) goalArmCapture = undefined;
      await durable.flush();
      await load(false, allChatDomains, lane);
      return true;
    } catch (failure) {
      if (current()) {
        const status = record(failure).status;
        if (submission && pendingSend()) {
          if (!historyFailed && typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429) pendingSend.set(null);
          else pendingSend.set({ ...submission, uncertain: dispatched || submission.uncertain });
        }
        fail(failure);
        await durable.flush().catch(() => {});
      }
      return false;
    } finally { releaseHistory(); if (current()) sending.set(false); }
  }
  /** Retry an unknown result even after the user has edited the visible draft. */
  async function retrySend(options: SendOptions = {}) {
    const lane = operationLane;
    await durable.whenReady();
    if (!laneCurrent(lane)) return false;
    const pending = pendingSend();
    if (!pending || sending()) return;
    return send(options, true, undefined, lane);
  }
  async function stop() {
    const lane = operationLane, request = lane.request, current = () => laneCurrent(lane);
    if (!active()) return;
    if (!current()) return;
    if (target.kind === 'assistant') {
      const snapshot = record(await request('/api/yuri/assistants/snapshot'));
      const bot = list(snapshot.assistants).find(item => item.id === target.id);
      if (!current()) return;
      if (!bot || typeof bot.sessionGeneration !== 'number') throw new Error('Assistant binding unavailable');
      await request(assistantPath(target.id, 'session/abort'), 'POST', { sessionID: bot.sessionID, sessionGeneration: bot.sessionGeneration });
    } else await request(scoped('interrupt'), 'POST', {});
    if (current()) await load(false, allChatDomains, lane);
  }
  async function replyPermission(requestID: string, decision: 'once' | 'always' | 'reject', message?: string) {
    const lane = operationLane, request = lane.request, current = () => laneCurrent(lane);
    if (!current() || target.kind !== 'session') throw new Error('Session unavailable');
    await request(scoped(`permission/${encodeURIComponent(requestID)}/reply`), 'POST', { decision, ...(message ? { message } : {}) });
    if (!current()) return;
    blockingRevision++;
    permissions.set(decision === 'reject' ? [] : permissions().filter(item => item.id !== requestID));
    await load(false, allChatDomains, lane);
  }
  async function replyForm(formID: string, answer: FormAnswer) { await mutateForm(formID, 'reply', { answer }); }
  async function cancelForm(formID: string) { await mutateForm(formID, 'cancel'); }
  async function mutateForm(formID: string, action: string, body?: unknown) {
    const lane = operationLane, request = lane.request, current = () => laneCurrent(lane);
    if (!current() || target.kind !== 'session') throw new Error('Session unavailable');
    await request(scoped(`form/${encodeURIComponent(formID)}/${action}`), 'POST', body);
    if (!current()) return;
    blockingRevision++; forms.set(forms().filter(item => item.id !== formID));
    await load(false, allChatDomains, lane);
  }
  const unsubscribe = host.on('runtime.event', payload => {
    if (!foreground()) return;
    const event = runtimeEventFrom(payload);
    if (!event) return;
    if (event.type === 'reconnected') {
      if (event.key === (target.kind === 'session' ? 'chat' : 'global')) { streamDisconnected = false; streamState.set('live'); schedule(); }
      if (target.kind === 'session' && goalObservers) { goalCore.invalidateRead(); schedule(['goal']); }
      return;
    }
    if (event.type === 'server.connected') {
      if (event.key === (target.kind === 'session' ? 'chat' : 'global')) { streamDisconnected = false; streamState.set('live'); schedule(); }
      if (target.kind === 'session' && goalObservers) { goalCore.invalidateRead(); schedule(['goal']); }
      return;
    }
    if (event.type === 'global.disposed') { if (target.kind === 'session' && goalObservers) { goalCore.invalidateRead(); schedule(['goal']); } return; }
    if (streamDisconnected && event.key === (target.kind === 'session' ? 'chat' : 'global')) return;
    if (target.kind === 'session' && goalCore.event(event.directory || event.key !== 'chat' ? event : { ...event, directory: target.directory })) return;
    const relevant = target.kind === 'assistant'
      ? text(event.body.assistantID) === target.id || event.type === 'yuri:assistants-changed'
      : eventSessionID(event) === target.id && (!event.directory || event.directory === target.directory);
    if (!relevant) return;
    if (event.id) {
      if (seenEvents.has(event.id)) return;
      seenEvents.add(event.id);
      if (seenEvents.size > 4096) seenEvents.delete(seenEvents.values().next().value!);
    }
    if (event.type === 'session.inbox.delivered' || event.type === 'session.inbox.cancelled') {
      const inboxID = text(event.body.inboxID);
      if (inboxID) terminalInbox(inboxID, event.type.endsWith('.delivered') ? 'delivered' : 'cancelled');
      if (event.type.endsWith('.cancelled') && pendingSend()?.id === inboxID) pendingSend.set(null);
    }
    const status = eventBusy(event);
    if (status !== undefined && (event.created === undefined || event.created >= latestStatusClock)) {
      latestStatusClock = event.created ?? latestStatusClock;
      liveRevision++; busy.set(status);
      if (event.type === 'session.retry.scheduled') retry.set(event.body);
      else retry.set(null);
      if (event.type === 'session.execution.failed' || event.type === 'session.error') {
        const message = text(record(event.body.error).message) || text(event.body.error) || text(event.body.message);
        executionError.set(message); if (message) error.set(message);
      } else if (event.type === 'session.execution.started' || event.type === 'session.execution.succeeded') {
        if (executionError()) error.set('');
        executionError.set('');
      }
      if (target.kind === 'session' && ['session.execution.succeeded', 'session.execution.failed', 'session.execution.interrupted', 'session.idle', 'session.error'].includes(event.type)) {
        batch(() => { publishStream(); clearStreamingSelection(false); });
      }
      if (target.kind === 'assistant' && event.type === 'yuri:contact-turn-end') {
        const turnID = text(event.body.turnID);
        batch(() => {
          publishStream();
          for (const messageID of [...streamingParts.keys()]) if (!turnID || messageID.startsWith(`${turnID}:bubble:`)) setStreamingPart(messageID, 0, false);
        });
      }
    }
    if (target.kind === 'session' && isSessionContentEvent(event)) {
      if (event.type === 'session.text.delta' || event.type === 'session.reasoning.delta') retry.set(null);
      const messageID = text(event.body.assistantMessageID);
      if (committedHiddenIDs.has(messageID)) return;
      const previous = streaming.get(messageID)?.message ?? messages().find(message => message.id === messageID);
      const next = applySessionContent(previous, event);
      batch(() => {
        if (next && next !== previous) { if (event.type.startsWith('session.tool.')) tasksDirty = true; bufferStream(next); }
        if (event.type === 'session.text.started' || event.type === 'session.text.delta' && typeof event.body.delta === 'string') setStreamingPart(messageID, typeof event.body.ordinal === 'number' ? event.body.ordinal : 0, true);
        else if (event.type === 'session.text.ended') {
          publishStream();
          setStreamingPart(messageID, typeof event.body.ordinal === 'number' ? event.body.ordinal : 0, false);
        }
      });
      // Full-value end events settle parts locally; only execution boundaries reconcile history.
      return;
    }
    if (target.kind === 'session' && event.type.startsWith('session.revert.')) {
      if (event.type === 'session.revert.staged' && record(event.body.revert).messageID) {
        try { setRevert(nativeRevertFrom(event.body.revert)); } catch (failure) { fail(failure); }
      }
      else if (event.type === 'session.revert.committed' && text(event.body.to)) trimCommitted(text(event.body.to));
      else if (event.type === 'session.revert.committed') {
        batch(() => {
          if (historyPresentationListener) presentHistory('reset', { revert: null, repairPending: true, resolved: false, historyGeneration: historyGeneration() + (historyNeedsReset ? 0 : 1) });
          if (!historyNeedsReset) resetHistoryAuthority(); historyNeedsReset = true; historyRepairPending.set(true); historyRevision++; revertSource.set(null); updateTasks();
        });
        snapshotCommitted();
      }
      else if (event.type === 'session.revert.cleared') setRevert(null);
      schedule(['messages', 'status']); return;
    }
    if (/inbox|permission|form/.test(event.type)) blockingRevision++;
    if (target.kind === 'assistant' && event.type === 'yuri:contact-bubble-delta') {
      const turnID = text(event.body.turnID), index = event.body.bubbleIndex;
      if (turnID && typeof index === 'number' && Number.isSafeInteger(index) && index >= 0 && typeof event.body.delta === 'string') {
        const messageID = `${turnID}:bubble:${index + 1}`;
        const previous = streaming.get(messageID)?.message ?? messages().find(message => message.id === messageID);
        const next: Message = { id: messageID, role: 'assistant', text: (previous?.text ?? '') + event.body.delta, reasoning: '', tools: [], cards: [], files: [], error: '' };
        batch(() => {
          if (event.body.delta || event.body.done !== true) bufferStream(next);
          if (event.body.done === true) { publishStream(); setStreamingPart(messageID, 0, false); }
          else if (event.body.done === false) setStreamingPart(messageID, 0, true);
        });
      }
      if (event.body.done === true) schedule(['messages']);
      return;
    }
    if (event.type.includes('inbox')) schedule(['inbox', 'messages']);
    else if (event.type.includes('permission')) schedule(['permissions']);
    else if (event.type.includes('form')) schedule(['forms']);
    else if (event.type === 'yuri:assistants-changed') schedule(['messages', 'status']);
    else if (target.kind === 'session' && (event.type.startsWith('session.execution.') && event.type !== 'session.execution.started' || event.type === 'session.idle' || event.type === 'session.error')) schedule(['messages', 'inbox']);
    else if (target.kind === 'session' && (event.type.startsWith('yuri:session-') || event.type === 'session.execution.started' || event.type === 'session.retry.scheduled' || event.type === 'session.instructions.updated' || event.type === 'session.metadata.updated' || event.type === 'session.status' || event.type === 'session.usage.updated')) return;
    else schedule(['messages']);
  });
  const disconnected = host.on('runtime.disconnected', payload => {
    if (!foreground() || record(payload).key !== (target.kind === 'session' ? 'chat' : 'global')) return;
    streamDisconnected = true;
    streamState.set('disconnected');
    // Preserve last-known activity, but an older in-flight snapshot cannot settle it.
    liveRevision++; blockingRevision++;
  });
  effect(() => {
    laneRevision();
    // Only the most recently mounted chat owns foreground safety polling.
    const visible = runtimeReady() && syncDemand() && lifecycle() === 'active' && chatOwners().at(-1) === owner;
    const connection = app.connection();
    if (!visible || !connection || !current()) { clearStreamingSelection(); goalCore.cancel(); activityFill.cancel(); void durable.flush().catch(() => {}); return; }
    activation++;
    const lane = operationLane;
    streamState.set('connecting');
    untracked(() => { void load(); if (goalObservers) void goalCore.refresh(); });
    if (target.kind === 'session') void native('runtime.stream', { path: `/api/event?${query(target.directory)}`, key: 'chat', ...(lane.scope ? { expectedHost: lane.scope } : {}) }).catch(failure => { if (laneCurrent(lane)) fail(failure); });
    const interval = setInterval(() => {
      if (!laneForeground(lane)) return;
      // Live deltas own running text. Safety polls keep status/blocking authority without
      // racing token contents; disconnected/idle reads still recover missed output.
      void load(false, target.kind === 'session' && busy() && !streamDisconnected ? ['status', 'inbox', 'permissions', 'forms'] : allChatDomains, lane);
    }, 4000);
    return () => {
      void durable.flush().catch(() => {});
      activation++;
      streamState.set('inactive');
      goalCore.cancel();
      activityFill.cancel();
      clearStreamingSelection();
      clearInterval(interval); if (timer) { clearTimeout(timer); timer = undefined; }
      if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = undefined; }
      if (target.kind === 'session') void native('runtime.stop', { key: 'chat', ...(lane.scope ? { expectedHost: lane.scope } : {}) }).catch(failure => { if (laneCurrent(lane)) fail(failure); });
    };
  });
  // Display→overview changes retain one existing stream/poll owner while UI actions become inactive.
  effect(() => { const requested = active() || syncActive(); untracked(() => { if (!requested) { goalCore.cancel(); activityFill.cancel(); } if (syncDemand() !== requested) syncDemand.set(requested); }); });
  void durable.ready.then(async () => {
    if (!laneCurrent(initialOperationLane)) return;
    if (queueEdit()) await recoverQueueEdit(initialOperationLane);
    if (laneCurrent(initialOperationLane) && pendingSend()) await recoverPendingSend();
  }).catch(fail);
  cleanup(() => { historyPresentationListener = undefined; previousHistoryPresentation = undefined; messageCommitListeners.clear(); void durable.close(); operationLane.history.close(); alive = false; activityFill.cancel(true); goalCore.retire(); taskSnapshot.set([]); resolvedAuthority.set(false); clearStreamingSelection(); chatAuthorityRetirements.delete(retireAuthority); chatOperationResumptions.delete(rebuildOperationLane); unsubscribe(); disconnected(); if (timer) clearTimeout(timer); if (deltaTimer) clearTimeout(deltaTimer); chatOwners.set(chatOwners().filter(value => value !== owner)); });
  return { rebuildOperationLane, goal, tasks, activityMaterialization, observeMessageCommits, messageReadError, get messageScope() { laneRevision(); return messageScope; }, messages, messagesResolved, historyGeneration, streamingMessageIDs, visibleMessages, revert, historyBusy, historyBoundaryMissing, historyRepairPending, refreshHistory, inbox, permissions, forms, error, executionError, loading, olderLoading, historyError, sending, busy, retry, streamState, commands, loadCommands, command, draft, references: durable.references, referenceDocument: durable.document, referenceScope: durable.scope, setReferenceDocument, setDraftText, insertReference, attachments, more, hasGap, active, syncActive, pendingSend, queueEdit, queueBusy, queueError, editInbox, cancelInbox, steerInbox, recoverQueueEdit, discardQueueEdit, recoverPendingSend, draftReady: durable.ready, draftStatus: durable.status, draftError: durable.error, flushDraft: durable.flush, restoreDraft: durable.restore, retryDraft: durable.retry, load, loadOlder, send, retrySend, stop, replyPermission, replyForm, cancelForm };
}
