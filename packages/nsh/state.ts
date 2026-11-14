import { batch, cleanup, computed, effect, host, lifecycle, signal, Storage, untracked } from 'nsh';
import { assistantPath, bindRequest, connectionSnapshotFrom, connections, native, query, sessionPath, type ConnectionSnapshot, type NativeMessageStreamTransport } from './runtime';
import { runtimeScopeFrom, sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import { openDraft, sameAttachment, localMagicSubmission, type DurableSubmission as ContextSubmission } from './drafts';
import { assistantAttachmentFilePart } from './assistant-attachment-model';
import { contactSendParts, pickedAttachmentFrom, sessionFiles } from './attachments';
import { currentLocale } from './i18n';
import { createContactOptimisticTurn, markContactOptimisticAdmitted, markContactOptimisticFailed, mergeContactTranscript, reconcileContactOptimisticTurns, type ContactOptimisticTurn } from '../ui/src/components/assistants/contactOptimisticTurns';
import type { AssistantContactPart } from '../ui/src/queries/assistantDTO';
import { contactMessageFrom } from './model';
import type { NativeLocalCommandInvocation, NativeLocalCommandOutcome } from './composer-local-commands';
import { inboxDraft } from './inbox';
import { openNativeHistoryLane } from './transcript-actions-lane';
import { nativeRevertFrom, type NativeRevert, type NativeSessionHistorySnapshot } from './transcript-actions-core';
import { createNativeCompactAction, type NativeCompactReceipt } from './transcript-actions-compaction';
import { nativeSessionActionStorageKey, inNativeSessionActionStorageLane } from './transcript-actions-storage';
import { compileNativePrompt } from './composer';
import { compileDesktopGitContext, desktopGitDraftAuthority, sameDesktopGitContext, type DesktopGitContextInput, type DesktopGitStageConfirmation, type DesktopGitStageResult } from './desktop-git-dispatch';
import { mergeHistoryMessages, stableHistoryMessages } from './history-messages';
import { createNativeHistoryCache, nativeHistoryCacheKey } from './history-cache';
import { nativeCatalogCache } from './catalog-cache';
import { sessionCatalogFrom, type SessionCatalogIssues } from './session-catalog';
import type { NativeHistoryPresentation } from './history-presentation';
import { desktopChatReadIdentity, desktopChatReadOnlyDraft, desktopChatReadSource, registerDesktopChatReadSource, rejectDesktopChatWrite, type DesktopPanelChatStream, type DesktopChatSessionIdentity } from './desktop-panel-chat-source';
import { createActivityMaterializer, materializedActivityMessage } from './transcript-materialization';
import { createGoalController, createGoalTransport, planGoalSubmission, type GoalArmSnapshot, type GoalCommandResult } from './chat-goal-model';
import { createTasksProjection, type NativeTask } from './chat-tasks-model';
import { createDesktopWorkStatusSourceProjection } from './desktop-work-status-source-projection';
import { readDesktopWorkStatusChildren } from './desktop-work-status-source-children';
import type { DesktopWorkStatusChat, DesktopWorkStatusChild, DesktopWorkStatusChildRead, DesktopWorkStatusScope } from './desktop-work-status-core';
import type { PageOperation } from './page-operations';
import { DesktopWriterError, desktopWriterNotDispatched, type VerifiedDesktopWriterGrant } from './desktop-writer-core';
import { createProjectsAttentionSource, isProjectsAttentionEvent, projectsAttention } from './projects-attention';
import { desktopSidebarScope } from './desktop-sidebar-model';
import { createDesktopSidebarAuthorityProjection, desktopSidebarAssistantSnapshot, type DesktopSidebarAssistantSnapshot, type DesktopSidebarScopedRows } from './desktop-sidebar-authority';
import { desktopSidebarSessionStateKey, type DesktopSidebarSessionState } from './desktop-sidebar-projection';
import { t } from './i18n';
import { createErrorFeedback, feedbackErrorKey, type ErrorFeedback } from './error-feedback';
import type { I18nKey } from '../ui/src/lib/i18n/messages/en';
import { sameReferenceScope, validateNativeReferences, type ReferenceCandidate, type ReferenceScope, type ScopedReferenceDocument } from './composer-references';
import { activeFrom, applySessionContent, eventBusy, eventSessionID, id, inboxFrom, isSessionContentEvent, list, mergeMessages, messagesFrom, projectsFrom, record, rowsFrom, runtimeEventFrom, slashCommand, text, unwrap, type Attachment, type ChatTarget, type CompiledSubmission, type Connection, type FormAnswer, type Message, type Project, type Row, type RuntimeEvent, type Session, type Submission } from './model';

const notificationCatalogAuthority = signal<NotificationCatalogState>({ scope: null, refreshGeneration: 0, complete: false, domains: { projects: 'unknown', sessions: 'unknown', bots: 'unknown', tasks: 'unknown' }, error: null });
const catalogSources: { projects?: readonly Project[]; sessions?: readonly Session[]; bots?: readonly Row[]; tasks?: readonly Row[] } = {};
const sidebarAssistants = signal<DesktopSidebarAssistantSnapshot | null>(null);
const assistantCatalogRevision = signal<Readonly<{ scope: string; revision: number }> | null>(null);
const sidebarSessions = signal<DesktopSidebarScopedRows<Session> | null>(null), sidebarSchedules = signal<DesktopSidebarScopedRows<Row> | null>(null);
const sidebarUnseen = signal<Readonly<Record<string, number>>>({});
const emptyContactCatalogRows = Object.freeze([]);
type ContactSessionStatus = Readonly<{ type: 'busy' | 'retry' | 'idle' }>;
const sidebarLive = signal<ReadonlyMap<string, DesktopSidebarSessionState & { workStatusScope?: RuntimeScope; contactStatus?: ContactSessionStatus; contactStatusScope?: RuntimeScope }>>(new Map());
const taskRows = signal<Row[]>([]);
function setTaskCatalog(rows: Row[]) {
  batch(() => {
    taskRows.set(rows);
    const scope = runtimeReady() && !switching ? desktopSidebarScope(app.connection(), generation) : null;
    if (scope) sidebarSchedules.set({ scope, rows });
  });
}
// Every existing schedule writer already commits through app.tasks. Preserve
// that sole source, stamping its Host scope without another schedule observer.
const taskCatalog = Object.assign(() => taskRows(), { set: setTaskCatalog, update: (update: (rows: Row[]) => Row[]) => setTaskCatalog(update(untracked(taskRows))) });
const projectSidebarAuthority = createDesktopSidebarAuthorityProjection();
/** Exact one-line root port: <DesktopSidebar authority={desktopSidebarAuthority()} ... />. */
export function desktopSidebarAuthority() {
  app.runtimeScope();
  return projectSidebarAuthority({ scope: runtimeReady() && !switching ? desktopSidebarScope(app.connection(), generation) : null,
    assistants: sidebarAssistants(), sessions: sidebarSessions(), schedules: sidebarSchedules(), unseen: sidebarUnseen(), live: sidebarLive() });
}
/** Raw display rows from the same scoped root producers, not another catalog or fallback to old authorization data. */
export function desktopContactCatalog() {
  const scope = runtimeReady() && !switching ? desktopSidebarScope(app.connection(), generation) : null;
  const sessions = sidebarSessions(), assistants = assistantCatalogRevision(), tasks = sidebarSchedules();
  return { sessions: scope && sessions?.scope === scope ? sessions.rows : emptyContactCatalogRows,
    assistants: scope && assistants?.scope === scope ? app.bots() : emptyContactCatalogRows,
    tasks: scope && tasks?.scope === scope ? tasks.rows : emptyContactCatalogRows };
}
/** Exact status already adopted by the root event owner. Missing execution metadata is not idle. */
export function desktopContactSessionStatus(scope: RuntimeScope | null, sessionID: string, directory: string): ContactSessionStatus | undefined {
  if (!scope || !runtimeReady() || switching || globalDisconnected || !sameRuntimeScope(scope, app.runtimeScope())) return;
  const live = sidebarLive().get(desktopSidebarSessionStateKey({ id: sessionID, directory }));
  return live?.contactStatusScope && sameRuntimeScope(live.contactStatusScope, scope) ? live.contactStatus : undefined;
}
/** Reuses the root's live cache without another active GET, event listener or catalog scan. */
export const readChatWorkStatusChildren: DesktopWorkStatusChildRead = (operation, scope) => readDesktopWorkStatusChildren(operation, scope, (id, directory) => {
  return chatWorkStatusChildActivity(operation, scope, id, directory);
});
function chatWorkStatusChildActivity(operation: PageOperation, scope: DesktopWorkStatusScope, id: string, directory: string): DesktopWorkStatusChild['activity'] {
  if (!operation.current() || !runtimeReady() || globalDisconnected || !sameRuntimeScope(operation.scope, scope.host) || !sameRuntimeScope(scope.host, app.runtimeScope())) return 'unknown';
  const live = sidebarLive().get(desktopSidebarSessionStateKey({ id, directory }));
  return live?.workStatusScope && sameRuntimeScope(live.workStatusScope, scope.host) ? live.running ? 'working' : 'idle' : 'unknown';
}
const workStatusChildListeners = new Map<string, Set<() => void>>();
function notifyWorkStatusChildren(key?: string) {
  const listeners = key === undefined ? new Set([...workStatusChildListeners.values()].flatMap(value => [...value])) : workStatusChildListeners.get(key);
  for (const listener of listeners ? [...listeners] : []) { try { listener(); } catch (failure) { report(failure); } }
}
/** Synchronous initial delivery, then only exact-child activity changes. Caller stops on close or replaces after a new child read. */
export function observeChatWorkStatusChildren(operation: PageOperation, scope: DesktopWorkStatusScope, children: readonly DesktopWorkStatusChild[], changed: (children: readonly DesktopWorkStatusChild[]) => void): () => void {
  const captured = { ...scope, host: { ...scope.host } };
  if (children.some(child => child.parentID !== captured.sessionID || child.directory !== captured.directory || !child.id) || new Set(children.map(child => child.id)).size !== children.length) throw new Error('work_status_children_invalid_scope');
  let rows = children, alive = true, initial = true;
  const keys = children.map(child => desktopSidebarSessionStateKey(child));
  const stop = () => {
    if (!alive) return;
    alive = false;
    for (const key of keys) { const listeners = workStatusChildListeners.get(key); listeners?.delete(publish); if (!listeners?.size) workStatusChildListeners.delete(key); }
  };
  const publish = () => {
    if (!alive) return;
    let different = false;
    const next = rows.map(child => { const activity = chatWorkStatusChildActivity(operation, captured, child.id, child.directory); if (activity === child.activity) return child; different = true; return { ...child, activity }; });
    if (different) rows = Object.freeze(next);
    if (!operation.current() || !sameRuntimeScope(operation.scope, captured.host) || !sameRuntimeScope(captured.host, app.runtimeScope())) stop();
    if (initial || different) { initial = false; changed(rows); }
  };
  for (const key of keys) { const listeners = workStatusChildListeners.get(key) ?? new Set(); listeners.add(publish); workStatusChildListeners.set(key, listeners); }
  try { publish(); } catch (failure) { stop(); throw failure; }
  return stop;
}
function revokeWorkStatusChildActivity() {
  const prior = sidebarLive();
  if ([...prior.values()].some(value => value.workStatusScope || value.contactStatusScope)) {
    sidebarLive.set(new Map([...prior].map(([key, value]) => [key, { running: value.running }])));
  }
  notifyWorkStatusChildren();
}
function workStatusEventScope(payload: unknown): RuntimeScope | null {
  try { return runtimeScopeFrom(record(payload).expectedHost); } catch { return null; }
}
/** Called only by the existing root/AssistantHome snapshot receiver, after its request fence. */
export function adoptAssistantCatalogSnapshot(snapshot: Row, scope = desktopSidebarScope(app.connection(), generation)) {
  if (!scope || !runtimeReady() || switching || scope !== desktopSidebarScope(app.connection(), generation)) return false;
  const knownMetadata = typeof snapshot.enabled === 'boolean' && Number.isSafeInteger(snapshot.revision) && Number(snapshot.revision) >= 0;
  const revision = assistantCatalogRevision(), prior = sidebarAssistants();
  if (knownMetadata && revision?.scope === scope && Number(snapshot.revision) < revision.revision) return false;
  let source = prior;
  try { source = desktopSidebarAssistantSnapshot(scope, snapshot); }
  catch {
    // Sidebar metadata is an optional reader, not a new Home validity gate.
    // Preserve prior contact authority on incomplete fields; never turn it into
    // empty unread/idle success or reject the original owner's valid snapshot.
    if (knownMetadata && (snapshot.enabled === false || prior?.scope === scope)) source = {
      scope, revision: Number(snapshot.revision), enabled: snapshot.enabled === true,
      contacts: prior?.scope === scope ? prior.contacts : [],
    };
  }
  batch(() => {
    if (knownMetadata) assistantCatalogRevision.set({ scope, revision: Number(snapshot.revision) });
    if (source !== prior) sidebarAssistants.set(source);
    app.bots.set(list(snapshot.assistants));
  });
  return true;
}
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
  projects: signal<Project[]>([]), sessions: signal<Session[]>([]), bots: signal<Row[]>([]), tasks: taskCatalog,
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
  sessionIssues?: SessionCatalogIssues;
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
  sidebarAssistants.set(null); sidebarSessions.set(null); sidebarSchedules.set(null); sidebarUnseen.set({}); sidebarLive.set(new Map());
  notifyWorkStatusChildren();
  assistantCatalogRevision.set(null);
  taskRows.set([]);
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
export const rootErrorFeedback = signal<ErrorFeedback | null>(null);
export const rootErrorActions = createErrorFeedback({ read: rootErrorFeedback, write: value => { rootErrorFeedback.set(value); app.error.set(value?.message ?? ''); } });
let captureFeedbackPage: (() => () => boolean) | undefined;
export function registerFeedbackPageOwner(capture: () => () => boolean) {
  captureFeedbackPage = capture;
  return () => { if (captureFeedbackPage === capture) captureFeedbackPage = undefined; };
}
function feedbackOwner() {
  const captured = generation, scope = app.runtimeScope(), connection = app.connection();
  return () => captured === generation && sameRuntimeScope(scope, app.runtimeScope()) && connection === app.connection() && lifecycle() === 'active';
}
export const report = (error: unknown, options: { current?: () => boolean; retry?: () => Promise<unknown> } = {}) => rootErrorActions.publish(t(feedbackErrorKey(error)), options.current ?? feedbackOwner(), options.retry);
/** Cleanup survives its page; admission still belongs to the original native lease and exact retirement owner. */
export function reportOwnedError(error: unknown, owner: Readonly<{ scope: RuntimeScope | null; current: () => boolean; retry?: () => Promise<unknown> }>, messageKey?: I18nKey) {
  const scope = runtimeScopeFrom(owner.scope);
  const current = () => !!scope && sameRuntimeScope(scope, app.runtimeScope()) && lifecycle() === 'active' && owner.current();
  rootErrorActions.publish(t(messageKey ?? feedbackErrorKey(error)), current, owner.retry);
}
export async function run(work: () => Promise<unknown>, options: { retry?: () => Promise<unknown>; current?: () => boolean } = {}) {
  const owner = feedbackOwner(), page = options.current ?? captureFeedbackPage?.() ?? (() => true), current = () => owner() && page();
  const previous = rootErrorFeedback();
  try {
    const result = await work();
    if (current() && previous?.retry === work) rootErrorActions.resolve(previous.id);
    return result;
  } catch (error) {
    rootErrorActions.publish(t(feedbackErrorKey(error)), current, options.retry);
  }
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
    rootErrorActions.retire();
    generation++; connectionRead++;
    if (reason === 'host') { historyCache.clearMemory(); nativeCatalogCache.clear(); }
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
  const priorScope = app.runtimeScope();
  const sameAuthorityLease = !!previous && !!next && !changed && !authorizationChanged && !!priorScope && !!saved.runtimeScope && priorScope.hostID === next.id && saved.runtimeScope.hostID === next.id;
  const sameHostResume = reconnectPending && pendingRetirement === 'suspend' && !changed && !authorizationChanged;
  batch(() => {
    if (authorityChanged) {
      rootErrorActions.retire();
      if (!sameHostResume) { historyCache.clearMemory(); nativeCatalogCache.clear(); }
      if (!reconnectPending) { generation++; retireCatalog(); chatAuthorityRetirements.forEach(retire => retire(sameAuthorityLease ? 'suspend' : 'host')); }
      else if (changed || authorizationChanged) chatAuthorityRetirements.forEach(retire => retire('host'));
      connectivityRevision++; globalDisconnected = false; refreshFlight = undefined; dirtyDomains.clear();
      if (changed) { app.projects.set([]); app.sessions.set([]); app.bots.set([]); app.tasks.set([]); }
      else if (authorizationChanged) taskRows.set([]);
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
  const sidebarScope = desktopSidebarScope(app.connection(), started)!;
  const connectivityAtStart = connectivityRevision;
  const selected = dirtyDomains.size ? [...dirtyDomains] : domains;
  dirtyDomains.clear();
  const previousCatalog = app.notificationCatalog();
  const status: Record<Domain, 'unknown' | 'pending' | 'complete' | 'failed'> = sameCatalogScope(scope, previousCatalog.scope) ? { ...previousCatalog.domains } : { projects: 'unknown', sessions: 'unknown', bots: 'unknown', tasks: 'unknown' };
  const revisions = { ...catalogDomainRevisions };
  let sessionIssues = sameCatalogScope(scope, previousCatalog.scope) ? previousCatalog.sessionIssues : undefined;
  selected.forEach(domain => { status[domain] = 'pending'; });
  notificationCatalogAuthority.set({ scope, refreshGeneration: turn, complete: false, domains: { ...status }, error: null, ...(sessionIssues ? { sessionIssues } : {}) });
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
        const raw = await request('/api/yuri/session-index');
        if (catalogCurrent()) {
          const value = sessionCatalogFrom(raw, app.sessions());
          app.sessions.set(value.sessions); catalogSources.sessions = value.sessions; sidebarSessions.set({ scope: sidebarScope, rows: value.sessions }); sessionIssues = value.issues;
          if (!value.complete) { status.sessions = catalogDomainRevisions.sessions === revisions.sessions ? 'failed' : 'unknown'; return; }
        }
      } else if (domain === 'bots') {
        const value = record(await request('/api/yuri/assistants/snapshot'));
        if (!Array.isArray(value.assistants) || value.partial === true || value.complete === false || value.assistants.some(item => !text(record(item).id))) throw new Error('Invalid assistants snapshot');
        if (started === generation && !switching) {
          // The older catalog consumer accepts an array-only response. That is
          // never enabled/revision authority for the desktop sidebar.
          if (value.enabled !== undefined || value.revision !== undefined) adoptAssistantCatalogSnapshot(value, sidebarScope);
          else app.bots.set(list(value.assistants));
          catalogSources.bots = app.bots();
        }
      } else {
        const value = record(await request('/api/yuri/scheduled-tasks'));
        if (!Array.isArray(value.tasks) || value.partial === true || value.complete === false || value.failedProjectIds !== undefined && !Array.isArray(value.failedProjectIds)
          || value.tasks.some(item => !text(record(item).projectId) || !text(record(record(item).task).id))) throw new Error('Invalid scheduled tasks snapshot');
        if (started === generation && !switching) {
          const failed = new Set(Array.isArray(value.failedProjectIds) ? value.failedProjectIds : []);
          const prior = sidebarSchedules();
          const rows = [...list(value.tasks).filter(item => !failed.has(item.projectId)), ...(prior?.scope === sidebarScope ? prior.rows.filter(item => failed.has(item.projectId)) : [])];
          batch(() => {
            taskRows.set([...list(value.tasks).filter(item => !failed.has(item.projectId)), ...app.tasks().filter(item => failed.has(item.projectId))]);
            sidebarSchedules.set({ scope: sidebarScope, rows });
          });
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
        error: failed?.status === 'rejected' ? failed.reason instanceof Error ? failed.reason.message : String(failed.reason) : null,
        ...(sessionIssues ? { sessionIssues } : {}) });
    }
    if (connectivityAtStart === connectivityRevision && !globalDisconnected) {
      app.online.set(results.some(result => result.status === 'fulfilled'));
    }
    const failed = results.find(result => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  })();
  refreshFlight = flight;
  try { await flight; }
  finally {
    if (started === generation) {
      refreshFlight = undefined; app.loading.set(false);
      if (dirtyDomains.size) void run(refresh, { retry: refresh, current: () => true });
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
  let stopSidebarAttention: (() => void) | undefined;
  let indexedSessions: readonly Session[] | undefined;
  const sessionDirectories = new Map<string, string>();
  const makeAttentionSource = () => createProjectsAttentionSource({ attention: projectsAttention, sessions: () => app.sessions(), request: captureHostRequest(),
    current: key => runtimeReady() && !switching && lifecycle() === 'active' && key === JSON.stringify([generation, app.connection()?.id]),
  });
  let attentionSource = makeAttentionSource();
  function syncAttentionScope() {
    const connection = app.connection(), key = runtimeReady() && connection ? JSON.stringify([generation, connection.id]) : undefined;
    if (key !== attentionScope) {
      stopSidebarAttention?.(); stopSidebarAttention = undefined;
      if (attentionScope) projectsAttention.retire(attentionScope);
      attentionSource.dispose(); attentionSource = makeAttentionSource(); attentionScope = key;
      if (key) {
        projectsAttention.activate(key);
        const publish = () => sidebarUnseen.set(projectsAttention.snapshot(key).unseenBySession);
        publish(); stopSidebarAttention = projectsAttention.observe(key, publish);
      }
    }
    return key;
  }
  const stop = host.on('runtime.event', payload => {
    const event = runtimeEventFrom(payload);
    if (!event || !runtimeReady() || lifecycle() !== 'active') return;
    if (event.key === 'global' && (event.type === 'reconnected' || event.type === 'server.connected') && (record(payload).expectedHost === undefined || sameRuntimeScope(workStatusEventScope(payload), app.runtimeScope()))) revokeWorkStatusChildActivity();
    if (!switching && event.key === 'global' && (event.type.startsWith('session.') || event.type === 'yuri:session-status')) {
      const busy = eventBusy(event), id = eventSessionID(event);
      if (busy !== undefined && id) {
        let directory = event.directory;
        if (!directory) {
          const rows = app.sessions();
          if (rows !== indexedSessions) { sessionDirectories.clear(); for (const row of rows) sessionDirectories.set(row.id, row.directory); indexedSessions = rows; }
          directory = sessionDirectories.get(id) || '';
        }
        const wireScope = workStatusEventScope(payload), scoped = wireScope && sameRuntimeScope(wireScope, app.runtimeScope()) ? wireScope : undefined;
        if (directory && (record(payload).expectedHost === undefined || scoped)) {
          const key = desktopSidebarSessionStateKey({ id, directory }), prior = sidebarLive();
          const rawStatus = event.type === 'session.status' || event.type === 'yuri:session-status'
            ? text(record(event.body.status).type) || text(event.body.status) || text(record(event.body.info).type) : '';
          const statusType = rawStatus === 'busy' || rawStatus === 'retry' || rawStatus === 'idle' ? rawStatus : undefined;
          const statusScope = statusType ? scoped ?? app.runtimeScope() ?? undefined : undefined;
          const previous = prior.get(key);
          if (previous?.running !== busy || !sameRuntimeScope(previous?.workStatusScope ?? null, scoped ?? null)
            || previous?.contactStatus?.type !== statusType || !sameRuntimeScope(previous?.contactStatusScope ?? null, statusScope ?? null)) {
            const next = new Map(prior);
            next.set(key, { running: busy, ...(scoped ? { workStatusScope: scoped } : {}),
              ...(statusType && statusScope ? { contactStatus: previous?.contactStatus?.type === statusType ? previous.contactStatus : { type: statusType }, contactStatusScope: statusScope } : {}) });
            sidebarLive.set(next); notifyWorkStatusChildren(key);
          }
        }
      }
    }
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
  cleanup(() => { stop(); stopSidebarAttention?.(); if (timer) clearTimeout(timer); attentionSource.dispose(); if (attentionScope) projectsAttention.retire(attentionScope); });
}
export function runtimeLifecycle() {
  effect(() => {
    const active = lifecycle() === 'active';
    untracked(() => {
      if (!active) { if (runtimeReady() || !reconnectPending) retireRuntimeAuthority('suspend'); return; }
      if (!runtimeReady()) {
        const resume = async () => { await loadConnections(); resumeChatOperations(); };
        void run(resume, { retry: resume, current: () => true });
      }
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
      if (record(payload).expectedHost === undefined || sameRuntimeScope(workStatusEventScope(payload), scope)) revokeWorkStatusChildActivity();
      app.online.set(false);
    });
    const reconnected = host.on('runtime.event', payload => {
      const event = runtimeEventFrom(payload);
      if (!current() || event?.key !== 'global' || event.type !== 'reconnected') return;
      connectivityRevision++; globalDisconnected = false;
      app.online.set(false);
      domains.forEach(domain => dirtyDomains.add(domain));
      void run(refresh, { retry: refresh, current });
    });
    untracked(() => { void run(refresh, { retry: refresh, current }); });
    const connectStream = async () => { if (!current()) return; await native('runtime.stream', { path: '/api/yuri/events', key: 'global', ...(scope ? { expectedHost: scope } : {}) }); };
    void connectStream().catch(failure => { if (current()) report(failure, { current, retry: connectStream }); });
    return () => {
      alive = false; disconnected(); reconnected();
      connectivityRevision++; app.online.set(false);
      void native('runtime.stop', { key: 'global', ...(scope ? { expectedHost: scope } : {}) }).catch(() => {});
    };
  });
}

export type SendPreparationInput = { text: string; files: Attachment[]; references: ScopedReferenceDocument; scope: ReferenceScope; isCurrentScope: () => boolean };
export type SendOptions = { inputMode?: 'normal' | 'shell'; prepare?: (input: SendPreparationInput) => Promise<CompiledSubmission>; goalArm?: GoalArmSnapshot };
export type ChatWriterRetirement = Readonly<{ canRelease: boolean; needsFlush: boolean; reasons: readonly string[] }>;
const chatOwners = signal<number[]>([]);
const historyCache = createNativeHistoryCache(Storage);
export const clearHistoryCache = (): Promise<void> => historyCache.clear();
export const retireHistoryAuthorization = (connectionID: string, authorizationID: string) =>
  historyCache.retireAuthorization(connectionID, authorizationID);
let nextChatOwner = 0;
export function createChat(target: ChatTarget, dependencies: { readOnly?: boolean; contactOptimistic?: boolean; displayConsumer?: { surfaceID: string; current: () => boolean; stream?: DesktopPanelChatStream }; draftAuthorityKey?: string; writerGrant?: () => VerifiedDesktopWriterGrant | null; writerUnknown?: (cause?: unknown) => void; recoveryReadOperation?: () => PageOperation | null; messageStreamTransport?: () => NativeMessageStreamTransport | null; followUpBehavior?: () => 'queue' | 'steer' | null; deviceChatPreferences?: () => { allowPromptingSubagentSessions: boolean; persistChatDraft: boolean } | null; beforeHistoryPresentationFlush?: (next: NativeHistoryPresentation) => void } = {}) {
  const readOnly = dependencies.readOnly === true;
  const writerRetiring = signal(false), writerWrites = signal(0), writerUnconfirmed = signal(false), writerFlushRevision = signal(-1);
  const retiredWriterHistory = signal(false);
  const writerNotDispatched = (failure: unknown) => failure instanceof DesktopWriterError && failure.outcome === 'not-dispatched' || desktopWriterNotDispatched(failure);
  function writerDomainResponse<T>(parse: () => T): T {
    try { return parse(); }
    catch (failure) {
      writerUnconfirmed.set(true);
      if (!readOnly) { try { dependencies.writerUnknown?.(failure); } catch { /* A consumer cannot turn a malformed admission into a confirmed receipt. */ } }
      throw failure;
    }
  }
  if (dependencies.displayConsumer && !readOnly) throw new Error('chat_display_requires_read_only');
  const draftConnection = app.connection() && { ...app.connection()! };
  const draftAuthorityValid = dependencies.draftAuthorityKey === undefined || !!draftConnection && desktopGitDraftAuthority(draftConnection) === dependencies.draftAuthorityKey;
  const draftAuthorityCurrent = () => {
    if (dependencies.draftAuthorityKey === undefined) return true;
    const connection = app.connection();
    return draftAuthorityValid && connection?.id === draftConnection?.id && connection?.url === draftConnection?.url && connection?.authorizationID === draftConnection?.authorizationID;
  };
  type OperationLane = Readonly<{ scope: RuntimeScope | null; generation: number; request: ReturnType<typeof bindRequest>; history: ReturnType<typeof openNativeHistoryLane> }>;
  const makeOperationLane = (): OperationLane => {
    const scope = runtimeScopeFrom(app.runtimeScope());
    const request = bindRequest(scope, readOnly ? undefined : dependencies.writerGrant);
    let lane: OperationLane;
    const send = readOnly ? (path: string, method = 'GET', body?: unknown) => {
      if (method.toUpperCase() !== 'GET' || body !== undefined) return Promise.reject(new Error('chat_read_only'));
      return request(path);
    } : async (path: string, method = 'GET', body?: unknown) => {
      if (method.toUpperCase() === 'GET' || method.toUpperCase() === 'POST' && path.split('?')[0] === '/api/rpc/opencode.goal/get') return request(path, method, body);
      if (writerRetiring() || !laneCurrent(lane)) throw new Error('chat_writer_retiring');
      writerWrites.set(writerWrites() + 1);
      try { return await request(path, method, body); }
      catch (failure) {
        const status = record(failure).status;
        if (!writerNotDispatched(failure) && !pendingSend() && !queueEdit() && !lane.history.historyBusy() && !(typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429)) writerUnconfirmed.set(true);
        throw failure;
      } finally { writerWrites.set(writerWrites() - 1); }
    };
    lane = Object.freeze({ scope, generation, request: send, history: openNativeHistoryLane(JSON.stringify([generation, scope?.lease ?? null, target.kind, target.directory, target.id, ...(readOnly ? ['display', dependencies.displayConsumer?.surfaceID] : [])])) });
    return lane;
  };
  let operationLane = makeOperationLane();
  const initialOperationLane = operationLane, laneRevision = signal(0);
  const cacheKey = nativeHistoryCacheKey(app.connection(), target);
  const cacheCurrent = () => !!cacheKey && cacheKey === nativeHistoryCacheKey(app.connection(), target) && !switching && runtimeReady();
  let rememberedRows: Message[] | undefined, rememberedCursor: string | null | undefined, rememberedRevert: NativeRevert | null | undefined;
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
    workStatusSource.resetLive();
    batch(() => { resolvedAuthority.set(false); clearStreamingSelection(); historyGeneration.set(historyGeneration() + 1); });
  }
  const loading = signal(false), sending = signal(false), busy = signal(false), more = signal(false), hasGap = signal(false);
  const olderLoading = signal(false), historyError = signal('');
  const durable = readOnly ? desktopChatReadOnlyDraft(app.connection()?.id ?? '', target) : openDraft(app.connection()?.id ?? `unconnected:${generation}`, target, dependencies.deviceChatPreferences ? { persistChatDraft: () => dependencies.deviceChatPreferences!()?.persistChatDraft ?? null } : dependencies.draftAuthorityKey);
  const parentAuthority = signal<string | null | undefined>(undefined);
  const { draft, attachments, pendingSend, queueEdit } = durable;
  const active = signal(true), syncActive = signal(false), syncDemand = signal(true);
  const retry = signal<Row | null>(null), streamState = signal<'inactive' | 'connecting' | 'live' | 'disconnected'>('inactive');
  const displayStreamError = signal('');
  const displayStreamRevision = signal(0), sessionIdentity = signal<DesktopChatSessionIdentity | null>(null);
  const executionError = signal('');
  const commands = signal<Row[]>([]);
  const queueBusy = signal(''), queueError = signal('');
  let compactionRevision = 0;
  const compactionInputs = new Set<string>();
  function setCompactionBarrier(running: boolean, inputID = '') {
    compactionRevision++;
    if (running) compactionInputs.add(inputID);
    else if (inputID) compactionInputs.delete(inputID);
    else compactionInputs.clear();
    compactionBarrier.set(compactionInputs.size > 0);
  }
  function compactionReceipt(payload: unknown) {
    const value = record(unwrap(payload));
    if (!text(value.id) || value.sessionID !== target.id || value.type !== 'compaction') throw new Error('Invalid compaction admission');
    return value;
  }
  function rememberCompactionInbox(rows: readonly Row[]) {
    const item = rows.find(item => item.type === 'compaction' && item.sessionID === target.id);
    if (item) setCompactionBarrier(true, text(compactionReceipt(item).id));
  }
  function rememberCompactionMessages(rows: readonly Message[]) {
    for (let index = rows.length - 1; index >= 0; index--) {
      const message = rows[index], card = message?.cards.find(part => part.type === 'compaction');
      if (!card) continue;
      if (card.status === 'running') setCompactionBarrier(true, message!.id);
      else if (card.status === 'completed' || card.status === 'failed') setCompactionBarrier(false, message!.id);
      return;
    }
  }
  const owner = ++nextChatOwner;
  let streamKey = readOnly ? `panel-chat:${owner}` : 'chat';
  const sourceIdentity = () => desktopChatReadIdentity(durable.scope.host, draftConnection ? desktopGitDraftAuthority(draftConnection) : '', operationLane.scope?.lease, target);
  const sharedSource = readOnly ? computed(() => { laneRevision(); return desktopChatReadSource(sourceIdentity()); }) : () => undefined;
  const makeMessageScope = () => Object.freeze({ hostID: durable.scope.host, generation: operationLane.generation, sessionID: target.kind === 'session' ? target.id : '', directory: target.directory });
  let messageScope = makeMessageScope();
  const historyBusy = Object.assign(() => { laneRevision(); return operationLane.history.historyBusy(); }, {
    set: (value: boolean) => { if (readOnly) rejectDesktopChatWrite(); if (value && writerRetiring()) throw new Error('chat_writer_retiring'); if (current()) operationLane.history.historyBusy.set(value); },
    update: (work: (value: boolean) => boolean) => { if (readOnly) rejectDesktopChatWrite(); historyBusy.set(work(historyBusy())); },
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
      if (boundaryChanged) { resetHistoryAuthority(); void historyCache.invalidate(cacheKey).catch(() => {}); rememberedRows = undefined; }
      if (revertSource() && !value) { historyNeedsReset = true; historyRepairPending.set(true); }
      historyRevision++; revertSource.set(value);
      if (boundaryChanged) updateTasks();
    });
    if (changed) snapshotCommitted();
  }
  const revert = Object.assign(() => revertSource(), { set: setRevert, update: (work: (value: NativeRevert | null) => NativeRevert | null) => setRevert(work(revertSource())) });
  const contactOptimistic = signal<ContactOptimisticTurn[]>([]);
  const contactIntents = new Map<string, ContextSubmission>();
  const contactOptimisticEnabled = !readOnly && target.kind === 'assistant' && dependencies.contactOptimistic === true;
  const contactDisplayMessages = computed(() => {
    const authoritative = messages();
    if (!contactOptimisticEnabled) return authoritative;
    const seen = new Set(authoritative.map(message => message.id));
    const pending = contactOptimistic().filter(turn => !seen.has(turn.messageID));
    if (!pending.length) return authoritative;
    return [...authoritative, ...mergeContactTranscript([], pending, target.id).map(value => contactMessageFrom({ ...value })!)];
  });
  const visibleMessages = () => {
    const rows = messages(), boundary = revert()?.messageID;
    if (historyRepairPending()) return [];
    if (!boundary) return contactOptimisticEnabled ? contactDisplayMessages() : rows;
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
  if (!readOnly) chatOwners.set([...chatOwners(), owner]);
  let alive = true, flight: Promise<void> | undefined, queued = false;
  let cursor: string | null = null, contactGeneration: number | undefined, contactRevision = -1;
  const contactPageGeneration = signal<number | null>(null);
  const contactReadPosition = () => {
    const generation = contactPageGeneration(), latest = messages().at(-1);
    if (target.kind !== 'assistant' || !messagesResolved() || messageReadError() || hasGap() || historyRepairPending() || generation === null
      || !latest?.contact || !Number.isSafeInteger(latest.ordinal) || latest.ordinal! < 0) return null;
    return { generation, ordinal: latest.ordinal!, messageID: latest.id };
  };
  let messagesLoaded = false;
  let authorityMessageIDs = new Set<string>();
  function rememberHistory() {
    if (!cacheKey || !cacheCurrent() || !messagesLoaded || !resolvedAuthority() || hasGap() || historyRepairPending() || historyNeedsReset) return;
    const rows = messages();
    if (rows === rememberedRows && cursor === rememberedCursor && revertSource() === rememberedRevert) return;
    rememberedRows = rows; rememberedCursor = cursor; rememberedRevert = revertSource();
    const pending = rows.findIndex(message => !authorityMessageIDs.has(message.id) || streaming.has(message.id));
    const writeGeneration = operationLane.generation;
    void historyCache.write(cacheKey, { messages: pending < 0 ? rows : rows.slice(0, pending), cursor, complete: !more(),
      ...(contactGeneration === undefined ? {} : { generation: contactGeneration }), ...(contactRevision < 0 ? {} : { revision: contactRevision }), revert: revertSource() }, () => cacheCurrent() && generation === writeGeneration).catch(() => {});
  }
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
  let nativeStreamReady = false;
  const seenEvents = new Set<string>();
  let latestStatusClock = -1;
  const inboxTerminals = new Map<string, 'delivered' | 'cancelled'>();
  let queueFlight: Promise<boolean> | undefined, recoveryFlight: Promise<boolean> | undefined;
  const laneCurrent = (lane: OperationLane) => alive && !retiredAuthority && lane === operationLane && runtimeReady() && !switching && lane.generation === generation && sameRuntimeScope(lane.scope, app.runtimeScope()) && draftAuthorityCurrent() && (!readOnly || !!lane.scope && dependencies.displayConsumer?.current() !== false && app.connection()?.id === draftConnection?.id && app.connection()?.url === draftConnection?.url && app.connection()?.authorizationID === draftConnection?.authorizationID);
  const current = () => laneCurrent(operationLane);
  const sendAdmission = (): 'allowed' | 'inactive' | 'session-authority-unknown' | 'subagent-preference-unknown' | 'subagent-prompting-disabled' => {
    if (!current() || !active() || lifecycle() !== 'active') return 'inactive';
    if (target.kind !== 'session') return 'allowed';
    const parent = parentAuthority();
    if (parent === undefined) return 'session-authority-unknown';
    if (!parent) return 'allowed';
    const preference = dependencies.deviceChatPreferences?.();
    return preference?.allowPromptingSubagentSessions === true ? 'allowed' : preference == null ? 'subagent-preference-unknown' : 'subagent-prompting-disabled';
  };
  const canSend = () => sendAdmission() === 'allowed';
  const compactReceipt = signal<NativeCompactReceipt | null>(null), compactionBarrier = signal(false), compactionInbox = signal<Row[]>([]);
  // Desktop panel compaction and the native compact receipt share one barrier.
  const historyActionStorageKey = app.connection() ? nativeSessionActionStorageKey(app.connection(), target) : null;
  const compactJournalKey = historyActionStorageKey ? `nsh:compact:v1:${historyActionStorageKey}` : null;
  const compactAction = createNativeCompactAction({ sessionID: target.id, directory: target.directory,
    capture: () => { const lane = operationLane; return { current: () => laneForeground(lane), send: lane.request }; },
    changed: (receipt, barrier) => batch(() => { compactReceipt.set(receipt); compactionBarrier.set(barrier); }),
    admitted: item => { if (!inboxTerminals.has(text(item.id)) && !compactionInbox().some(row => row.id === item.id)) compactionInbox.set([...compactionInbox(), item]); },
    journal: {
      key: compactJournalKey ?? undefined,
      read: async () => {
        if (!compactJournalKey) throw new Error('Compaction storage scope unavailable');
        const raw = await inNativeSessionActionStorageLane(compactJournalKey, () => Storage.getItem(compactJournalKey));
        if (!raw || raw === 'null') return null;
        const value = record(JSON.parse(raw));
        if (!['unknown', 'acknowledged'].includes(text(value.status)) || value.inboxID !== undefined && typeof value.inboxID !== 'string') throw new Error('Invalid compaction receipt');
        return { status: value.status as 'unknown' | 'acknowledged', ...(text(value.inboxID) ? { inboxID: text(value.inboxID) } : {}) };
      },
      write: value => compactJournalKey ? Storage.setItem(compactJournalKey, JSON.stringify(value)) : Promise.reject(new Error('Compaction storage scope unavailable')),
    },
  });
  async function compact() {
    const lane = operationLane;
    if (target.kind !== 'session' || !laneForeground(lane) || sending() || historyBusy() || pendingSend() || queueEdit()) return false;
    try {
      const accepted = await compactAction.compact(busy() && dependencies.followUpBehavior?.() !== 'steer' ? 'queue' : 'steer', async () => {
        if (!await admitNewInput(lane) || !laneForeground(lane)) throw new Error('Compaction source changed');
        // A staged tail must be resolved explicitly; compact cannot commit history as a side effect.
        if (await refreshHistory(() => laneForeground(lane), lane)) throw new Error('Restore or commit reverted history before compaction');
      });
      if (accepted && laneForeground(lane)) schedule(['inbox', 'status']);
      return accepted;
    } catch (failure) { if (laneCurrent(lane)) fail(failure); return false; }
  }
  async function reconcileCompaction(lane: OperationLane) {
    const revision = compactAction.revision();
    const value = record(await lane.request(`/api/sessions/${encodeURIComponent(target.id)}/delivery?${query(target.directory)}`));
    if (typeof value.compactionRunning !== 'boolean' || !Array.isArray(value.data)) throw new Error('Compaction delivery authority is unknown');
    const items = rowsFrom(value).filter(item => item.type === 'compaction');
    const running = activeFrom(await lane.request('/api/session/active'), target.id);
    if (!laneForeground(lane)) throw new Error('Compaction source changed');
    if (await compactAction.confirmAuthority({ items, running: value.compactionRunning, idle: !running }, revision) && laneForeground(lane)) compactionInbox.set(items);
  }
  async function readInbox(lane: OperationLane) {
    const payload = await lane.request(scoped('inbox'));
    if (laneForeground(lane) && compactReceipt()?.status !== 'pending' && (compactAction.receipt() || compactAction.barrier() || rowsFrom(payload).some(item => item.type === 'compaction'))) await reconcileCompaction(lane);
    return inboxFrom(payload);
  }
  async function admitNewInput(lane = operationLane) {
    if (target.kind === 'session' && parentAuthority() === undefined) await refreshHistory(() => laneCurrent(lane), lane);
    const admission = sendAdmission();
    if (admission === 'allowed') return true;
    error.set(admission); return false;
  }
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
    if (readOnly || writerRetiring() || !current()) return false;
    durable.setDraftText(value); return true;
  }
  function compareAndSetDraftText(revision: number, value: string) {
    if (readOnly || writerRetiring() || !active() || !foreground() || !Number.isSafeInteger(revision) || typeof value !== 'string' || durable.revision() !== revision) return false;
    durable.setDraftText(value); return true;
  }
  function stageContext(input: DesktopGitContextInput, confirmation?: DesktopGitStageConfirmation): Promise<DesktopGitStageResult> {
    if (writerRetiring()) return Promise.resolve({ status: 'blocked' });
    const lane = operationLane, lease = input.lease;
    return durable.stageContext(input, () => lane.scope?.lease === lease && laneForeground(lane) && active() && !sending(), confirmation);
  }
  // Like Web's pending synthetic parts, editing (including empty text) retains context.
  // Explicit removal affects only the next draft, never the captured pending receipt.
  function clearContext() { if (readOnly || writerRetiring() || !current() || !active()) return false; durable.context.set(undefined); return true; }
  function insertReference(candidate: ReferenceCandidate, start?: number, end?: number) {
    if (readOnly || writerRetiring() || !referenceCurrent()) return false;
    if (target.kind !== 'session') throw new Error('Assistant references are not supported by this client');
    durable.insertReference(candidate, start, end); return true;
  }
  function setReferenceDocument(next: ScopedReferenceDocument, expected?: ScopedReferenceDocument) {
    if (readOnly || writerRetiring() || !referenceCurrent()) return false;
    if (expected && (!sameReferenceScope(expected.scope, durable.scope) || !durable.matchesDocument(expected.text, expected.references))) return false;
    durable.setDocument(next); return true;
  }
  const foreground = () => current() && (active() || syncActive()) && lifecycle() === 'active' && (readOnly || chatOwners().at(-1) === owner);
  const laneForeground = (lane: OperationLane) => laneCurrent(lane) && foreground();
  let attachmentOperation = 0;
  /** Capture before native presentation. UI also retires its exact picker port on page retirement. */
  function captureAttachment(page?: Readonly<{ scope: RuntimeScope | null; current: () => boolean }>) {
    const lane = operationLane, expectedHost = lane.scope && Object.freeze({ ...lane.scope });
    const capturedTarget = Object.freeze({ ...target });
    const revision = durable.revision(), draftRevision = durable.draftRevision(), capturedGeneration = contactGeneration;
    const pageOperation = `attachment_${owner}_${++attachmentOperation}`;
    const authoritative = target.kind !== 'assistant' || messagesResolved() && typeof capturedGeneration === 'number' && Number.isSafeInteger(capturedGeneration) && capturedGeneration >= 0;
    let checkpoint: number | undefined;
    let adoptionWrite: Promise<void> | undefined;
    let settled = false;
    const valid = () => !settled && authoritative && !!expectedHost && expectedHost.hostID === durable.scope.host && laneForeground(lane) && active() && durable.status() === 'ready'
      && target.kind === capturedTarget.kind && target.id === capturedTarget.id && target.directory === capturedTarget.directory
      && (!page || page.current() && sameRuntimeScope(page.scope, expectedHost)) && durable.revision() === revision && durable.draftRevision() === draftRevision
      && (target.kind !== 'assistant' || messagesResolved() && contactGeneration === capturedGeneration);
    function adopt(value: unknown, restoringRevision?: number) {
      if (!valid() || value === null) return false;
      let file: Attachment;
      try { file = pickedAttachmentFrom(value, { hostID: durable.scope.host, target: capturedTarget, ...(capturedTarget.kind === 'assistant' ? { contactGeneration: capturedGeneration } : {}) }); }
      catch { return false; }
      if (restoringRevision !== undefined && restoringRevision !== checkpoint) {
        // An ACK/storage interruption may leave this exact descriptor already
        // persisted. Confirm it without appending a second attachment.
        if (!attachments().some(existing => sameAttachment(existing, file))) return false;
        settled = true; adoptionWrite = durable.flush(); void adoptionWrite.catch(() => {}); return true;
      }
      settled = true;
      attachments.set([...attachments(), file]);
      adoptionWrite = durable.flush(); void adoptionWrite.catch(() => {});
      return true;
    }
    return { expectedHost, target: capturedTarget, current: valid, retire() { settled = true; }, adopt,
      recover: (value: unknown, savedRevision: number) => adopt(value, savedRevision),
      async commit() {
        try { await adoptionWrite; } catch { await durable.retry(); }
        if (durable.status() !== 'ready') throw new Error('attachment_receipt_storage_failed');
      },
      async prepare() {
        if (!valid()) throw new Error('attachment_capture_stale');
        checkpoint = await durable.checkpoint();
        if (!valid()) throw new Error('attachment_capture_stale');
        return { contactGeneration: capturedGeneration, draftIdentity: durable.key, draftRevision: checkpoint, pageOperation };
      },
    };
  }
  let goalObservers = 0, goalNotice = 0;
  const goalRevision = signal(0);
  const goalCore = createGoalController({ sessionID: target.kind === 'session' ? target.id : '', directory: target.directory }, {
    get: scope => createGoalTransport(operationLane.request).get(scope),
    command: (scope, command) => createGoalTransport(operationLane.request).command(scope, command),
  }, () => !readOnly && target.kind === 'session' && !!operationLane.scope && active() && foreground() && referenceCurrent(), () => goalRevision.set(++goalNotice));
  const goalState = () => { goalRevision(); const state = goalCore.state(); return current() && (sending() || historyBusy()) ? { ...state, busy: true } : state; };
  let goalArmCapture: { submissionID: string; snapshot: GoalArmSnapshot } | undefined;
  const projectTasks = createTasksProjection(), taskSnapshot = signal<readonly NativeTask[]>([]);
  const tasks = () => taskSnapshot();
  const workStatusSource = createDesktopWorkStatusSourceProjection(value => workStatusSnapshot.set(value), tasks());
  const workStatusSnapshot = signal<DesktopWorkStatusChat>(workStatusSource.snapshot());
  const workStatus = () => workStatusSnapshot();
  const workStatusLiveCurrent = (payload: unknown) => !!operationLane.scope && sameRuntimeScope(workStatusEventScope(payload), operationLane.scope);
  function updateTasks() {
    if (target.kind !== 'session') return;
    const next = projectTasks(visibleMessages()) ?? [];
    const previous = tasks();
    if (next !== previous && (next.length || previous.length)) taskSnapshot.set(next);
    workStatusSource.commitTranscript(visibleMessages(), tasks());
  }
  async function goalControl(action: 'pause' | 'resume' | 'clear'): Promise<GoalCommandResult> {
    const lane = operationLane;
    if (readOnly || !active() || !foreground() || target.kind !== 'session' || sending() || historyBusy() || pendingSend() || queueEdit()) return 'blocked';
    const result = await send({}, false, action);
    return result ? 'acknowledged' : laneCurrent(lane) ? 'failed' : 'stale';
  }
  const toggleGoal = () => !goalCore.state().goal || goalCore.state().goal?.status === 'complete'
    ? Promise.resolve<GoalCommandResult>('blocked') : goalControl(goalCore.state().goal?.status === 'active' ? 'pause' : 'resume');
  const goal = {
    state: goalState,
    controller: { scope: goalCore.scope, refresh: goalCore.refresh, setArmed: readOnly ? () => {} : goalCore.setArmed, captureArm: goalCore.captureArm, toggle: toggleGoal, clear: () => goalControl('clear') },
    /** Observe once from the primary Chat; no new effect, socket or safety poll. */
    observe() {
      if (readOnly || target.kind !== 'session') return () => {};
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
      if (reason === 'host' && suspendedOperations) { suspendedOperations = false; historyPresentationListener = undefined; messageCommitListeners.clear(); goalCore.retire(); taskSnapshot.set([]); workStatusSource.retire(tasks()); }
      return;
    }
    retiredAuthority = true;
    parentAuthority.set(undefined);
    suspendedOperations = reason === 'suspend';
    previousHistoryPresentation = undefined;
    if (!suspendedOperations) { historyPresentationListener = undefined; messageCommitListeners.clear(); }
    resetHistoryAuthority();
    if (suspendedOperations) goalCore.cancel(); else { goalCore.retire(); taskSnapshot.set([]); }
    if (suspendedOperations) workStatusSource.suspend(); else workStatusSource.retire(tasks());
    goalArmCapture = undefined;
  };
  function rebuildOperationLane() {
    if (!alive || !(suspendedOperations || readOnly && retiredAuthority) || !runtimeReady() || switching || lifecycle() !== 'active' || app.connection()?.id !== durable.scope.host) return false;
    if (app.connection()?.url !== draftConnection?.url || app.connection()?.authorizationID !== draftConnection?.authorizationID || readOnly && dependencies.displayConsumer?.current() === false) return false;
    const next = makeOperationLane();
    if (next.scope && next.scope.hostID !== durable.scope.host) return false;
    batch(() => {
      if (!readOnly && operationLane.history.historyBusy()) retiredWriterHistory.set(true);
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
      const next = rows.slice(); next[index] = full; messages.set(next); updateTasks(); snapshotCommitted(); rememberHistory(); return true;
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
    if (readOnly && !laneForeground(lane)) return null;
    const revision = historyRevision;
    const session = record(unwrap(await request(`/api/session/${encodeURIComponent(target.id)}?${query(target.directory)}`)));
    if (!laneCurrent(lane) || !valid()) throw new Error('Session history source changed');
    if (session.id !== target.id) throw new Error('Invalid session history authority');
    if (session.parentID !== undefined && session.parentID !== null && typeof session.parentID !== 'string') throw new Error('Invalid session parent authority');
    if (readOnly && (record(session.location).directory ?? session.directory) !== target.directory) throw new Error('chat_directory_mismatch');
    const identity = { id: target.id, directory: text(record(session.location).directory ?? session.directory), ...(text(session.parentID) ? { parentID: text(session.parentID) } : {}) };
    if (JSON.stringify(sessionIdentity()) !== JSON.stringify(identity)) sessionIdentity.set(identity);
    parentAuthority.set(typeof session.parentID === 'string' && session.parentID ? session.parentID : null);
    const value = session.revert ? nativeRevertFrom(session.revert) : null;
    if (revision === historyRevision) setRevert(value);
    return revert();
  }
  function historyActionSnapshot(): NativeSessionHistorySnapshot {
    return { messages: messages(), revert: revert(), more: more(), cursor, revision: historyRevision,
      ready: messagesLoaded && resolvedAuthority() && !hasGap() && !historyRepairPending() && !messageReadError() && !historyError() && messages().every(message => authorityMessageIDs.has(message.id)) };
  }
  async function prepareHistoryAction(valid: () => boolean) {
    const lane = operationLane;
    await load(false, ['messages'], lane);
    if (!laneForeground(lane) || !valid()) throw new Error('Session history source changed');
    // load preserves display on failure; a mutation additionally requires a fresh successful marker read.
    await refreshHistory(valid, lane);
    if (historyError()) {
      // An explicit slash retry owns retrying the failed opaque page. Do not
      // require a separate scroll gesture or drop the pages already adopted.
      if (more() && cursor) await loadOlder(false, lane);
      else if (!more()) historyError.set('');
      if (!laneForeground(lane) || !valid()) throw new Error('Session history source changed');
    }
    if (!historyActionSnapshot().ready) throw new Error('Session history authority is unknown');
  }
  function trimCommitted(boundary: string) {
    if (committedHiddenIDs.has(boundary)) return;
    committedHiddenIDs.add(boundary);
    void historyCache.invalidate(cacheKey).catch(() => {}); rememberedRows = undefined;
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
    rememberHistory();
  }
  async function commitStagedRevertBeforeSend(lane: OperationLane, fence: () => boolean = () => true) {
    const request = lane.request, foreground = () => laneForeground(lane) && fence();
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
    if (!foreground() || timer || target.kind === 'session' && !nativeStreamReady) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!foreground() || target.kind === 'session' && !nativeStreamReady) return;
      const selected = [...pendingRefresh]; pendingRefresh.clear();
      void load(false, selected);
    }, 120);
  }
  async function loadOlder(automatic = false, lane = operationLane): Promise<void> {
    const foreground = () => laneForeground(lane), current = () => laneCurrent(lane);
    if (!foreground()) return;
    const source = sharedSource();
    if (source) return source.loadOlder();
    if (!cursor || automatic && historyError()) return;
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
    if (readOnly) {
      if (!foreground()) return;
      const source = sharedSource();
      if (source) return source.load(older, selected.filter((domain): domain is 'messages' | 'status' => domain === 'messages' || domain === 'status'));
      selected = selected.filter(domain => domain === 'messages' || domain === 'status');
    }
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
           if (readOnly && historyReadFailed) throw new Error('chat_session_authority_unavailable');
           const historyAtStart = historyRevision, barrierAtStart = compactionRevision;
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
               if (target.kind === 'assistant') contactPageGeneration.set(Number.isSafeInteger(page.generation) && page.generation! >= 0 ? page.generation! : null);
              const replacing = historyNeedsReset;
              // Preparing rows only reconciles the existing stream overlay; signals are still unchanged.
              if (reset || replacing) streaming.clear();
              let rows: Message[];
              if (replacing || !messagesLoaded || reset || !older && page.complete) rows = prepareMessages(page.messages, streamAtStart);
              else if (!older && target.kind === 'assistant' && page.messages.length) {
                rows = prepareMessages(mergeHistoryMessages(previous, page.messages), streamAtStart);
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
              if (contactOptimisticEnabled) {
                const prior = contactOptimistic();
                const remaining = reset ? [] : reconcileContactOptimisticTurns(prior, rows.map(message => ({ messageID: message.id })));
                if (remaining !== prior) {
                  const keep = new Set(remaining.map(turn => turn.messageID));
                  for (const id of contactIntents.keys()) if (!keep.has(id)) contactIntents.delete(id);
                  contactOptimistic.set(remaining);
                }
              }
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
             if (!older && barrierAtStart === compactionRevision) rememberCompactionMessages(page.messages);
             snapshotCommitted();
             if (!historyReadFailed) rememberHistory();
        })] : []),
        ...(!older && selected.includes('status') ? [apply(async () => {
          if (target.kind === 'session') {
            const value = activeFrom(await request('/api/session/active'), target.id);
            if (valid() && statusAtStart === liveRevision) { busy.set(value); if (!value) retry.set(null); workStatusSource.confirmActivity(value); }
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
            ...(selected.includes('inbox') ? [apply(async () => {
              const barrierRevision = compactionRevision;
              const value = await readInbox(lane);
              if (valid() && blockingAtStart === blockingRevision) {
                if (barrierRevision === compactionRevision) rememberCompactionInbox(value);
                inbox.set(value.filter(item => !inboxTerminals.has(text(item.id))));
              }
            })] : []),
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
  async function reconcile(submission: ContextSubmission, lane: OperationLane, admitted: () => boolean = () => true, strictScope = false): Promise<boolean> {
    const current = () => laneCurrent(lane) && admitted();
    const request = async (path: string) => {
      if (!current()) throw new Error('chat_recovery_read_stale');
      const value = await lane.request(path);
      if (!current()) throw new Error('chat_recovery_read_stale');
      return value;
    };
    if (submission.localCompact) {
      try {
        const pending = rowsFrom(await request(scoped('inbox'))).find(item => item.id === submission.id && item.sessionID === target.id && item.type === 'compaction');
        if (pending && current()) { setCompactionBarrier(true, submission.id); return true; }
      } catch { /* An exact promoted checkpoint may still prove admission when inbox cannot be read. */ }
      if (!current()) return false;
      const value = record(unwrap(await request(scoped(`message/${encodeURIComponent(submission.id)}`))));
      const info = record(value.info), parts = list(value.parts ?? value.content);
      const card = value.type === 'compaction' ? value : parts.find(part => part.type === 'compaction');
      if ((info.id ?? value.id) !== submission.id || (info.sessionID ?? value.sessionID) !== target.id || !card || !['running', 'completed', 'failed'].includes(text(card.status))) return false;
      if (current()) setCompactionBarrier(card.status === 'running', submission.id);
      return current();
    }
    if (inboxTerminals.get(submission.id) === 'delivered') return true;
    if (target.kind === 'assistant') {
      const page = messagesFrom(await request(`${assistantPath(target.id, 'contact/messages')}?messageID=${encodeURIComponent(submission.id)}&limit=1`), true, 1);
      return page.messages.some(message => message.id === submission.id && message.contact?.kind === 'user'
        && (message.contact.assistantID === undefined || message.contact.assistantID === target.id));
    }
    try {
      const pending = inboxFrom(await request(scoped('inbox')));
      if (pending.some(item => item.id === submission.id && item.sessionID === target.id)) return true;
    } catch { /* A failed inbox read must still allow exact promoted-message recovery. */ }
    if (!current()) return false;
    const value = record(unwrap(await request(scoped(`message/${encodeURIComponent(submission.id)}`))));
    const info = record(value.info);
    return (info.id ?? value.id) === submission.id && (!(strictScope || submission.localMagic) || (info.sessionID ?? value.sessionID) === target.id);
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
    const revision = blockingRevision, barrierRevision = compactionRevision;
    const payload = await request(scoped('inbox')), rows = inboxFrom(payload);
    if (!current()) throw new Error('Connection changed');
    if (barrierRevision === compactionRevision) rememberCompactionInbox(rowsFrom(payload));
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
    if (readOnly) return false;
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
    if (readOnly || writerRetiring() || !active() || !current() || target.kind !== 'session') return Promise.resolve(false);
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
    if (compactionBarrier() || pendingSend()?.localCompact) return false;
    if (!await queuedAuthority(inboxID, lane)) return false;
    if (compactionBarrier() || pendingSend()?.localCompact) return false;
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
    if (existing) {
      if (await recoverQueueEdit(lane)) return true;
      if (!current() || queueEdit() !== existing || inboxTerminals.get(inboxID) === 'delivered') return false;
      await durable.flush();
      if (!current() || queueEdit() !== existing) return false;
      error.set('');
    }
    if (!existing) {
      if (draft() || attachments().length || pendingSend() || durable.context()) throw new Error('请先处理当前草稿，队列编辑不会覆盖已有输入');
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
    if (readOnly) return false;
    const lane = operationLane, current = () => laneCurrent(lane);
    await durable.whenReady();
    if (!current() || !queueEdit() || queueFlight) return false;
    // Explicit UI action only: discard the recovered composer payload, not the server item.
    draft.set(''); attachments.set([]); queueEdit.set(null);
    await durable.flush(); return true;
  }
  function recoverPendingSend(): Promise<boolean> {
    if (readOnly) return Promise.resolve(false);
    const lane = operationLane;
    let readOperation: PageOperation | null = null;
    try { readOperation = dependencies.recoveryReadOperation?.() ?? null; } catch { return Promise.resolve(false); }
    const current = () => {
      if (!laneCurrent(lane) || lifecycle() !== 'active' || chatOwners().at(-1) !== owner || app.connection()?.id !== draftConnection?.id || app.connection()?.url !== draftConnection?.url || app.connection()?.authorizationID !== draftConnection?.authorizationID) return false;
      if (!dependencies.recoveryReadOperation) return active();
      try { return !!readOperation && readOperation === dependencies.recoveryReadOperation() && readOperation.current() && readOperation.generation === lane.generation && sameRuntimeScope(readOperation.scope, lane.scope); } catch { return false; }
    };
    if (!current()) return Promise.resolve(false);
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
      try { found = await reconcile(pending, lane, () => current() && pendingSend() === pending, !!dependencies.recoveryReadOperation); }
      catch (failure) { if (!current() || pendingSend() !== pending) return false; if (record(failure).status !== 404) throw failure; }
      if (references.references.length && !referenceCurrent()) throw new Error('native-reference-scope-changed');
      if (!found || !current() || pendingSend() !== pending) return false;
      admitted(pending, revision, lane);
      try { await durable.flush(); }
      catch (failure) { if ((pending.localMagic || pending.localCompact || target.kind === 'assistant') && !pendingSend()) pendingSend.set(pending); throw failure; }
      return true;
    })().finally(() => { if (recoveryFlight === flight) recoveryFlight = undefined; });
    recoveryFlight = flight; return flight;
  }
  async function loadCommands(lane = operationLane) {
    const request = lane.request, current = () => laneCurrent(lane);
    if (readOnly || !current() || target.kind !== 'session') return;
    const rows = rowsFrom(await request(`/api/command?location%5Bdirectory%5D=${encodeURIComponent(target.directory)}`));
    if (current()) commands.set(rows);
  }
  async function command(name: string, args = '') {
    const lane = operationLane;
    if (readOnly || writerRetiring() || !active() || !current() || target.kind !== 'session' || sending() || historyBusy()) return false;
    if (pendingSend()) { error.set('上一条发送尚未确认，请先确认其结果'); return false; }
    if (durable.context()) { error.set('请先处理当前 Git 上下文'); return false; }
    if (!/^[\w:-]+$/.test(name)) { error.set('无效的命令名称'); return false; }
    try { if (!await admitNewInput(lane) || !laneCurrent(lane) || !active()) return false; } catch (failure) { if (laneCurrent(lane)) fail(failure); return false; }
    draft.set(`/${name}${args ? ` ${args}` : ''}`);
    return send();
  }
  function admitted(submission: ContextSubmission, expectedDraftRevision: number, lane: OperationLane) {
    if (!laneCurrent(lane)) return;
    if (submission.localMagic || submission.localCompact) { pendingSend.set(null); return; }
    if (contactOptimisticEnabled) contactOptimistic.set(markContactOptimisticAdmitted(contactOptimistic(), submission.id));
    if (durable.draftRevision() === expectedDraftRevision && durable.matchesDocument(submission.text, submission.references?.references)) durable.setDocument({ text: '', references: [], scope: durable.scope });
    attachments.set(attachments().filter(file => !submission.files.some(capturedFile => sameAttachment(file, capturedFile))));
    if (submission.context && sameDesktopGitContext(durable.context(), submission.context)) durable.context.set(undefined);
    pendingSend.set(null);
  }
  type LocalDispatch = { submission: ContextSubmission; current: () => boolean; dispatched: boolean; accepted: boolean; rejected: boolean };
  /** The installed handoff and direct composer share exactly the ordinary writer's dispatch/history lane. */
  async function dispatchLocalSubmission(submission: ContextSubmission, valid: () => boolean): Promise<NativeLocalCommandOutcome> {
    const local: LocalDispatch = { submission, current: valid, dispatched: false, accepted: false, rejected: false };
    try { await send({}, true, undefined, operationLane, local); }
    catch { /* Presentation or cleanup failure never turns a dispatched request into a negative receipt. */ }
    return { status: local.accepted ? 'accepted' : local.dispatched && !local.rejected ? 'unknown' : 'rejected' };
  }
  async function admitLocalMagic(compiled: CompiledSubmission, invocation: NativeLocalCommandInvocation): Promise<NativeLocalCommandOutcome> {
    const lane = operationLane, snapshot = invocation.snapshot, capturedActivation = activation;
    const valid = () => !readOnly && activation === capturedActivation && active() && laneForeground(lane) && invocation.current();
    if (!valid() || target.kind !== 'session' || snapshot.target.kind !== 'session' || snapshot.target.id !== target.id || snapshot.target.directory !== target.directory || snapshot.revision !== durable.revision() || snapshot.text !== draft() || sending() || pendingSend() || queueEdit() || durable.status() !== 'ready') return { status: 'rejected' };
    const tokenEnd = /^\s*\/\u2003?[^\s]+/.exec(snapshot.text)?.[0].length ?? 0;
    if (durable.references().some(ref => ref.start < tokenEnd && ref.end > snapshot.text.indexOf('/'))) return { status: 'rejected' };
    try {
      const submission = { ...localMagicSubmission(compiled, invocation, durable.scope), id: id() };
      return await dispatchLocalSubmission(submission, valid);
    } catch { return { status: 'rejected' }; }
  }
  async function admitLocalCompact(invocation: NativeLocalCommandInvocation): Promise<NativeLocalCommandOutcome> {
    const snapshot = invocation.snapshot, lane = operationLane, capturedActivation = activation;
    const valid = () => !readOnly && activation === capturedActivation && active() && laneForeground(lane) && invocation.current();
    const command = slashCommand(snapshot.text.replace(/^(\s*)\/\u2003/, '$1/'));
    const original = snapshot.revision === durable.revision() && snapshot.text === draft();
    const consumedBare = snapshot.revision + 1 === durable.revision() && draft() === '' && !durable.references().length;
    if (!valid() || target.kind !== 'session' || invocation.command !== 'compact' || invocation.resourcePolicy !== 'preserve' || snapshot.inputMode !== 'normal' || snapshot.target.kind !== 'session' || snapshot.target.id !== target.id || snapshot.target.directory !== target.directory || !sameReferenceScope(snapshot.scope, durable.scope) || !Number.isSafeInteger(snapshot.revision) || (!original && !consumedBare) || command?.name.toLowerCase() !== 'compact' || command.text.trim() || snapshot.hasReferences || durable.references().length || pendingSend() || queueEdit() || sending() || compactionBarrier() || durable.status() !== 'ready') return { status: 'rejected' };
    const submission: ContextSubmission = { id: id(), text: '', files: [], inputMode: 'normal', delivery: 'steer', uncertain: false, references: { text: '', references: [], scope: { ...durable.scope } }, localCompact: { version: 1, resourcePolicy: 'preserve' } };
    return dispatchLocalSubmission(submission, valid);
  }
  async function dispatchLocalMagicHandoff(inputID: string): Promise<NativeLocalCommandOutcome> {
    if (readOnly || writerRetiring() || !active() || !foreground()) return { status: 'rejected' };
    await durable.whenReady();
    const submission = pendingSend(), lane = operationLane, capturedActivation = activation;
    if (!submission?.localMagic || submission.id !== inputID || submission.uncertain) return { status: 'rejected' };
    return dispatchLocalSubmission(submission, () => activation === capturedActivation && active() && laneForeground(lane));
  }
  async function send(options: SendOptions = {}, retryPending = false, goalAction?: 'pause' | 'resume' | 'clear', lane = operationLane, local?: LocalDispatch) {
    const request = lane.request, current = () => laneCurrent(lane), foreground = () => laneForeground(lane);
    const referenceCurrent = () => current() && app.connection()?.id === durable.scope.host;
    if (readOnly || writerRetiring() || !active() || sending() || !current()) return false;
    if (!local && (pendingSend()?.localMagic || pendingSend()?.localCompact)) { await recoverPendingSend(); return false; }
    if (!lane.scope) { error.set('scope_required'); return false; }
    const releaseHistory = lane.history.acquireSend();
    if (!releaseHistory) return false;
    sending.set(true); error.set('');
    let submission: ContextSubmission | null = null;
    let dispatched = false;
    let contactAdmitted = false;
    let historyFailed = false;
    let localRevision = durable.revision();
    const localCurrent = () => !local || local.current() && durable.revision() === localRevision;
    let newInput = false;
    const goalArm = { ...(options.goalArm ?? goalCore.captureArm()) };
    try {
      await durable.whenReady();
      if (!current() || !localCurrent()) return false;
      if (queueEdit()) { error.set('队列编辑尚未确认取消，不能重复发送'); return false; }
      submission = pendingSend();
      if ((submission?.localMagic || submission?.localCompact) && !local) return false;
      if (local) {
        if (submission && submission !== local.submission || local.submission.uncertain) return false;
        submission = local.submission;
      }
      newInput = !submission;
      if (newInput && !await admitNewInput(lane)) return false;
      if (goalAction && submission) { error.set('上一条发送尚未确认，请先确认其结果'); return false; }
      if (!goalAction && !submission && !draft().trim() && !attachments().length) return false;
      if (submission && !retryPending && !durable.matches(submission.text, submission.files, submission.references?.references)) { error.set('上一条发送结果未知，请先重试确认后再发送新草稿'); return false; }
      const draftAtStart = durable.draftRevision();
      if (!submission) {
        submission = goalAction
          ? { id: id(), text: '', files: [], delivery: 'steer', uncertain: false, inputMode: 'normal', references: { text: '', references: [], scope: { ...durable.scope } }, command: { name: 'goal', text: goalAction } }
          : { id: id(), text: draft(), files: attachments().map(file => ({ ...file })), delivery: (busy() || compactionBarrier()) && dependencies.followUpBehavior?.() !== 'steer' ? 'queue' : 'steer', uncertain: false, inputMode: options.inputMode ?? 'normal', references: referenceSnapshot(), ...(durable.context() ? { context: durable.context() } : {}) };
        const literal = submission.text.replace(/^(\s*)\/\u2003/, '$1/');
        const invocation = slashCommand(literal);
        const tokenEnd = /^\s*\/\u2003?[^\s]+/.exec(submission.text)?.[0].length ?? 0;
        const authoredToken = !submission.references!.references.some(ref => ref.start < tokenEnd && ref.end > submission!.text.indexOf('/'));
        const goalPlan = submission.context || goalAction || !goalArm.armed && !authoredToken ? null : planGoalSubmission({ text: literal, armed: goalArm.armed, objectiveOverride: goalArm.objectiveOverride,
          inputMode: submission.inputMode, sessionKind: target.kind });
        if (goalPlan?.kind === 'invalid') { error.set(t('chat.goal.toast.actionFailed')); return false; }
        if (goalPlan?.kind === 'command' && (goalArm.armed || authoredToken)) {
          submission = { ...submission, command: { name: 'goal', text: goalPlan.command.text },
            ...(goalArm.armed && goalArm.objectiveOverride?.trim() ? { preparedText: goalArm.objectiveOverride.trim() } : {}) };
          goalArmCapture = { submissionID: submission.id, snapshot: goalArm };
        }
        if (submission.inputMode === 'shell') {
          if (target.kind !== 'session' || submission.files.length || submission.references!.references.length) { error.set('Shell 仅支持会话中的文本命令'); return false; }
        } else if (!submission.context && !submission.command && !options.prepare && !submission.references!.references.length && target.kind === 'session') {
          if (invocation) submission = { ...submission, command: invocation };
        }
      }
      const nativeGoal = target.kind === 'session' && submission.inputMode !== 'shell' && submission.command?.name.toLowerCase() === 'goal';
      if (nativeGoal && !referenceCurrent()) throw new Error('Connection changed');
      // Empty owned document is the durable panel-control contract: never consume the composer's unrelated resources.
      const goalPanel = nativeGoal && submission.text === '' && !submission.files.length && !submission.references?.references.length;
      const references = submissionReferences(submission);
      if (submission.context && (!dependencies.draftAuthorityKey || target.kind !== 'session' || submission.inputMode === 'shell' || submission.command)) throw new Error('git-context-send-unsupported');
      if (references.references.length && !referenceCurrent()) throw new Error('native-reference-scope-changed');
      if (target.kind === 'assistant' && (references.references.length || submission.compiled?.agents?.length || submission.compiled?.skills?.length)) throw new Error('Assistant references are not supported by this client');
      if (target.kind === 'assistant') {
        const files = contactSendParts(submission.files, { hostID: durable.scope.host, target });
        if (submission.compiled?.files?.length || files.length > 64 || submission.files.reduce((total, file) => total + assistantAttachmentFilePart(file, target.id).size, 0) > 50 * 1024 * 1024) throw new Error('Invalid Assistant attachment references');
        if (submission.compiled?.files && JSON.stringify(files) !== JSON.stringify(contactSendParts(submission.compiled.files, { hostID: durable.scope.host, target }))) throw new Error('contact_attachment_snapshot_changed');
        if (contactOptimisticEnabled && !contactIntents.has(submission.id) && contactOptimistic().length >= 64) { error.set(t('chat.questionDelegate.uncertain')); return false; }
      }
      else { sessionFiles(submission.files); if (submission.compiled?.files) sessionFiles(submission.compiled.files); }
      if (submission.inputMode === 'shell' && references.references.length) throw new Error('Shell references are not supported by this client');
      if (submission.uncertain && (submission.command || submission.inputMode === 'shell')) { error.set('命令结果未知；服务端不支持命令幂等重试，请先核对会话状态'); return false; }
      // Persist the exact owned document before asynchronous preparation, not just its eventual wire output.
      pendingSend.set(submission);
      localRevision = durable.revision();
      await durable.flush();
      if (!current() || !localCurrent()) throw new Error('local-magic-stale');
      if (references.references.length && !referenceCurrent()) throw new Error('native-reference-scope-changed');
      if (!submission.localCompact && !submission.compiled && (!submission.command || nativeGoal && !goalPanel) && submission.inputMode !== 'shell' && (submission.context || options.prepare || references.references.length || retryPending && submission.references && target.kind === 'session')) {
        const input: SendPreparationInput = { text: submission.text, files: submission.files.map(file => ({ ...file })), references, scope: { ...durable.scope }, isCurrentScope: referenceCurrent };
        const context = submission.context;
        const prepared = await (options.prepare ? options.prepare(input) : compileNativePrompt(input, request));
        const compiled = context ? compileDesktopGitContext(prepared, context) : prepared;
        if (!current()) return false;
        if (nativeGoal && !referenceCurrent()) throw new Error('Connection changed');
        if (references.references.length && !referenceCurrent()) throw new Error('native-reference-scope-changed');
        if (!compiled || typeof compiled.text !== 'string') throw new Error('Invalid compiled submission');
        if (target.kind === 'assistant') {
          if (compiled.agents?.length || compiled.skills?.length) throw new Error('Assistant references are not supported by this client');
          const originalParts = contactSendParts(submission.files, { hostID: durable.scope.host, target });
          const compiledParts = contactSendParts(compiled.files ?? submission.files, { hostID: durable.scope.host, target });
          if (JSON.stringify(originalParts) !== JSON.stringify(compiledParts)) throw new Error('contact_attachment_snapshot_changed');
        } else sessionFiles(compiled.files ?? []);
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
        } else submission = { ...submission, compiled: target.kind === 'assistant' && compiled.files === undefined ? { ...compiled, files: submission.files.map(file => ({ ...file })) } : compiled, preparedText: compiled.text };
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
        if (target.kind === 'assistant' && submission.files.length) { error.set('contact_attachment_send_unknown'); return false; }
      }
      const compiled = submission.compiled;
      const sendText = compiled?.text ?? submission.text;
      const sendFiles = compiled?.files ?? submission.files;
      const writeAhead = async () => {
        if (!localCurrent()) throw new Error('local-magic-stale');
        if (!await compactAction.waitForAdmission(() => reconcileCompaction(lane))) throw new Error('Compaction admission is unknown; input was not dispatched');
        if (!current()) throw new Error('Connection changed');
        if (!await admitNewInput(lane)) throw new Error(sendAdmission());
        if (submission!.localMagic) {
          const selection = submission!.localMagic.selection;
          const authority = record(unwrap(await request(`/api/session/${encodeURIComponent(target.id)}?${query(target.directory)}`)));
          const model = record(authority.model);
          if (!localCurrent() || authority.id !== target.id || selection.agent && authority.agent !== selection.agent || selection.model && (model.providerID !== selection.model.providerID || model.id !== selection.model.modelID || text(model.variant) !== text(selection.model.variant))) throw new Error('local-magic-selection-changed');
        }
        if (nativeGoal && !referenceCurrent()) throw new Error('Connection changed');
        try { if (!goalPanel) await commitStagedRevertBeforeSend(lane, localCurrent); }
        catch (failure) { historyFailed = true; throw failure; }
        if (!current() || !localCurrent()) throw new Error('Connection changed');
        pendingSend.set({ ...submission!, uncertain: true });
        localRevision = durable.revision();
        await durable.flush();
        if (!current() || !localCurrent() || target.kind === 'session' && !foreground() || (nativeGoal || references.references.length) && !referenceCurrent()) throw new Error('Connection changed');
        const admission = sendAdmission();
        if (admission !== 'allowed') throw new Error(admission);
        dispatched = true;
        if (local) local.dispatched = true;
      };
      if (submission.localCompact) {
        await writeAhead();
        const payload = await request(scoped('compact'), 'POST', { id: submission.id, delivery: submission.delivery });
        writerDomainResponse(() => {
          const receipt = compactionReceipt(payload);
          if (current()) setCompactionBarrier(true, text(receipt.id));
          if (receipt.id !== submission!.id) throw new Error('Compaction admission identity changed');
          return receipt;
        });
        if (local) local.accepted = true;
      } else if (nativeGoal) {
        const planned = planGoalSubmission({ text: `/goal${submission.command!.text ? ` ${submission.command!.text}` : ''}`, armed: false, ...(goalPanel ? {} : { delivery: submission.delivery }),
          ...(goalPanel ? {} : { files: sessionFiles(sendFiles), agents: compiled?.agents, skills: compiled?.skills }) });
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
          ...(submission.files.length ? { files: sessionFiles(submission.files) } : {}),
        });
      } else if (submission.inputMode === 'shell') {
        await writeAhead();
        await request(scoped('shell'), 'POST', { command: submission.text });
      } else if (target.kind === 'assistant') {
        const parts: AssistantContactPart[] = [...(sendText.trim() ? [{ type: 'text' as const, text: sendText }] : []), ...submission.files.map(file => assistantAttachmentFilePart(file, target.id))];
        if (contactOptimisticEnabled) {
          const previous = contactOptimistic(), existing = previous.find(turn => turn.messageID === submission!.id);
          contactIntents.set(submission.id, submission);
          contactOptimistic.set(existing ? previous.map(turn => turn.messageID === submission!.id ? { ...turn, status: 'sending', error: undefined } : turn) : [...previous, createContactOptimisticTurn(target.id, submission.id, parts)]);
        }
        await writeAhead();
        const sentParts = contactSendParts(sendFiles, { hostID: durable.scope.host, target });
        const result = record(await request(assistantPath(target.id, 'messages'), 'POST', { messageID: submission.id,
          parts: [...(sendText.trim() ? [{ type: 'text' as const, text: sendText }] : []), ...sentParts], language: currentLocale() }));
        writerDomainResponse(() => { if (result.admitted !== true || result.messageID !== submission!.id) throw new Error('Invalid assistant admission'); });
        contactAdmitted = true;
      } else {
        await writeAhead();
        const payload = await request(scoped('prompt'), 'POST', {
          id: submission.id, text: sendText, delivery: submission.delivery,
          ...(sendFiles.length ? { files: sessionFiles(sendFiles) } : {}),
          ...(compiled?.agents?.length ? { agents: compiled.agents } : {}),
          ...(compiled?.skills?.length ? { skills: compiled.skills } : {}),
          ...(compiled?.metadata ? { metadata: compiled.metadata } : {}),
        });
        writerDomainResponse(() => {
          const result = inboxFrom([unwrap(payload)]);
          if (result[0]?.id !== submission!.id || result[0]?.sessionID !== target.id) throw new Error('Invalid prompt admission');
        });
        if (local) local.accepted = true;
      }
      if (!current()) return false;
      if (goalPanel) pendingSend.set(null);
      else admitted(submission, draftAtStart, lane);
      if (nativeGoal && goalArmCapture?.submissionID === submission.id) goalArmCapture = undefined;
      await durable.flush();
      await load(false, allChatDomains, lane);
      return true;
    } catch (failure) {
      const notDispatched = writerNotDispatched(failure);
      if (notDispatched) { dispatched = false; if (local) { local.dispatched = false; local.rejected = true; } }
      if (current()) {
        const status = record(failure).status;
        const rejected = !historyFailed && (notDispatched && !submission?.uncertain || typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429);
        if (local) local.rejected = rejected;
        if (submission && pendingSend()) {
          if (rejected || local && !dispatched) pendingSend.set(null);
          else pendingSend.set({ ...submission, uncertain: dispatched || submission.uncertain });
        }
        if (contactAdmitted && submission && !pendingSend()) pendingSend.set({ ...submission, uncertain: true });
        const messageFailure = contactOptimisticEnabled && !contactAdmitted && submission && contactOptimistic().some(turn => turn.messageID === submission!.id);
        if (local) error.set(t('chat.goal.toast.actionFailed'));
        else if (!messageFailure) fail(failure);
        if (messageFailure) contactOptimistic.set(markContactOptimisticFailed(contactOptimistic(), submission!.id, t(pendingSend()?.uncertain ? 'chat.questionDelegate.uncertain' : 'assistants.contact.sendFailed')));
        await durable.flush().catch(() => {});
      }
      return false;
    } finally {
      if (local && !dispatched && pendingSend()?.id === submission?.id) { pendingSend.set(null); await durable.flush().catch(() => {}); }
      releaseHistory(); if (current()) sending.set(false);
    }
  }
  /** Retry an unknown result even after the user has edited the visible draft. */
  async function retrySend(options: SendOptions = {}) {
    if (readOnly) return false;
    const lane = operationLane;
    await durable.whenReady();
    if (!laneCurrent(lane)) return false;
    const pending = pendingSend();
    if (!pending || sending()) return;
    if (pending.localMagic || pending.localCompact || target.kind === 'assistant' && pending.uncertain) return recoverPendingSend();
    return send(options, true, undefined, lane);
  }
  async function retryContactMessage(messageID: string) {
    if (!contactOptimisticEnabled || readOnly || sending()) return false;
    const pending = pendingSend();
    if (pending && (pending.id !== messageID || pending.uncertain)) return pending.id === messageID ? recoverPendingSend() : false;
    const intent = contactIntents.get(messageID);
    if (!intent || !contactOptimistic().some(turn => turn.messageID === messageID && turn.status === 'failed') || !active() || !foreground() || writerRetiring()) return false;
    if (!pending) pendingSend.set(intent);
    return send({}, true);
  }
  async function stop() {
    if (readOnly) return;
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
    if (readOnly) rejectDesktopChatWrite();
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
    if (readOnly) rejectDesktopChatWrite();
    const lane = operationLane, request = lane.request, current = () => laneCurrent(lane);
    if (!current() || target.kind !== 'session') throw new Error('Session unavailable');
    await request(scoped(`form/${encodeURIComponent(formID)}/${action}`), 'POST', body);
    if (!current()) return;
    blockingRevision++; forms.set(forms().filter(item => item.id !== formID));
    await load(false, allChatDomains, lane);
  }
  let streamOwnerID: string | undefined;
  function acceptsStream(payload: unknown) {
    const envelope = record(payload);
    try {
      const received = runtimeScopeFrom(envelope.expectedHost);
      if (!received || !sameRuntimeScope(received, operationLane.scope)) return false;
    } catch { return false; }
    if (envelope.key === 'global') return true;
    return envelope.key === 'chat' && target.kind === 'session' && !!streamOwnerID && envelope.ownerID === streamOwnerID;
  }
  const unsubscribe = host.on('runtime.event', payload => {
    if (!foreground() || sharedSource()) return;
    const envelope = record(payload);
    if (readOnly) {
      if (envelope.key !== streamKey && envelope.key !== 'global') return;
      if (envelope.expectedHost !== undefined && !workStatusLiveCurrent(payload)) return;
    } else if (!acceptsStream(payload)) return;
    // The native consumer key is a lease, not a wire-domain discriminator. Keep
    // model.ts's existing chat decoder; admit only this display's key beforehand.
    const event = runtimeEventFrom(readOnly && envelope.key === streamKey ? { ...envelope, key: 'chat' } : payload);
    if (!event) return;
    if (event.type === 'reconnected') {
      if (target.kind === 'session' && event.key === 'chat' && workStatusLiveCurrent(payload)) workStatusSource.suspend();
      if (event.key === (target.kind === 'session' ? 'chat' : 'global')) { publishStream(); nativeStreamReady = true; streamDisconnected = false; streamState.set('live'); schedule(); }
      if (target.kind === 'session' && goalObservers) { goalCore.invalidateRead(); schedule(['goal']); }
      return;
    }
    if (event.type === 'server.connected') {
      if (target.kind === 'session' && event.key === 'chat' && workStatusLiveCurrent(payload)) workStatusSource.suspend();
      if (event.key === (target.kind === 'session' ? 'chat' : 'global')) { streamDisconnected = false; streamState.set('live'); schedule(); }
      if (target.kind === 'session' && goalObservers) { goalCore.invalidateRead(); schedule(['goal']); }
      return;
    }
    if (event.type === 'global.disposed') { if (target.kind === 'session' && goalObservers) { goalCore.invalidateRead(); schedule(['goal']); } return; }
    // A current native ticket admits replay before ready; the barrier above
    // flushes these writes before scheduling authoritative GET compensation.
    if (target.kind === 'session' && goalCore.event(event.directory || event.key !== 'chat' ? event : { ...event, directory: target.directory })) return;
    const relevant = target.kind === 'assistant'
      ? text(event.body.assistantID) === target.id || event.type === 'yuri:assistants-changed'
      : eventSessionID(event) === target.id;
    if (!relevant) return;
    if (event.id) {
      if (seenEvents.has(event.id)) return;
      seenEvents.add(event.id);
      if (seenEvents.size > 4096) seenEvents.delete(seenEvents.values().next().value!);
    }
    if (target.kind === 'session' && event.type.startsWith('session.compaction.')) {
      const inputID = text(event.body.inputID);
      if (event.type === 'session.compaction.started') setCompactionBarrier(true, inputID);
      else if (event.type === 'session.compaction.ended' || event.type === 'session.compaction.failed') setCompactionBarrier(false, inputID);
      schedule(['messages', 'inbox']); return;
    }
    if (event.type === 'session.inbox.delivered' || event.type === 'session.inbox.cancelled') {
      const inboxID = text(event.body.inboxID);
      if (inboxID) terminalInbox(inboxID, event.type.endsWith('.delivered') ? 'delivered' : 'cancelled');
      if (event.type.endsWith('.cancelled') && pendingSend()?.id === inboxID) pendingSend.set(null);
    }
    if (target.kind === 'session' && compactAction.observe(event.type, event.body)) schedule(['inbox', 'status']);
    const status = eventBusy(event);
    if (status !== undefined && (event.created === undefined || event.created >= latestStatusClock)) {
      latestStatusClock = event.created ?? latestStatusClock;
      liveRevision++; busy.set(status);
      if (event.type === 'session.retry.scheduled') retry.set(event.body);
      else retry.set(null);
      if (target.kind === 'session') { if (workStatusLiveCurrent(payload)) workStatusSource.confirmActivity(status, event.created); else workStatusSource.suspend(); }
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
        if (next && next !== previous) { if (event.type.startsWith('session.tool.')) { tasksDirty = true; if (workStatusLiveCurrent(payload)) workStatusSource.acceptTool(event, next); } bufferStream(next); }
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
        void historyCache.invalidate(cacheKey).catch(() => {}); rememberedRows = undefined;
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
        const body = (previous?.text ?? '') + event.body.delta;
        const next: Message = { ...(previous ?? { id: messageID, role: 'assistant', reasoning: '', tools: [], cards: [], files: [], error: '' }), text: body,
          content: [{ type: 'text', text: body }],
          contact: { ...previous?.contact, kind: 'assistant', assistantID: target.id, turnID, bubbleIndex: index,
            ...(previous?.contact?.createdAt !== undefined ? {} : typeof event.body.occurredAt === 'number' && Number.isFinite(event.body.occurredAt) ? { createdAt: event.body.occurredAt } : {}),
            status: event.body.done === true ? 'complete' : 'streaming' },
        };
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
    else if (target.kind === 'session' && (event.type.startsWith('session.execution.') && event.type !== 'session.execution.started' || event.type === 'session.idle' || event.type === 'session.error')) {
      // Terminal authority must not wait on a live stream that never became
      // ready; the debounced scheduler is a no-op until that first ready.
      if (nativeStreamReady && !streamDisconnected) schedule(['messages', 'inbox']);
      else void load(false, ['messages', 'inbox', 'status'], operationLane);
    }
    else if (target.kind === 'session' && (event.type.startsWith('yuri:session-') || event.type === 'session.execution.started' || event.type === 'session.retry.scheduled' || event.type === 'session.instructions.updated' || event.type === 'session.metadata.updated' || event.type === 'session.status' || event.type === 'session.usage.updated')) return;
    else schedule(['messages']);
  });
  const disconnected = host.on('runtime.disconnected', payload => {
    const envelope = record(payload);
    if (!foreground() || sharedSource()) return;
    if (readOnly) {
      if (envelope.key !== streamKey && envelope.key !== 'global') return;
      if (envelope.expectedHost !== undefined && !workStatusLiveCurrent(payload)) return;
    } else if (!acceptsStream(payload) || envelope.key !== (target.kind === 'session' ? 'chat' : 'global')) return;
    streamDisconnected = true;
    nativeStreamReady = false;
    streamState.set('disconnected');
    workStatusSource.suspend();
    // Preserve last-known activity, but an older in-flight snapshot cannot settle it.
    liveRevision++; blockingRevision++;
  });
  const historySeedCurrent = historyCache.captureRead(cacheKey);
  function seedHistory(snapshot: ReturnType<typeof historyCache.peek>) {
    if (!snapshot || !current() || messagesLoaded || messages().length || historyNeedsReset || !snapshot.messages.length) return;
    if (historyRevision && revertSource()?.messageID !== snapshot.revert?.messageID) return;
    batch(() => {
      if (!historySeedCurrent()) return;
      messages.set(snapshot.messages); cursor = snapshot.cursor; more.set(!snapshot.complete); messagesLoaded = true;
      authorityMessageIDs = new Set(snapshot.messages.map(message => message.id));
      contactGeneration = snapshot.generation; contactRevision = snapshot.revision ?? -1;
      if (!historyRevision) revertSource.set(snapshot.revert);
    });
    // Deliberately not resolved, not streaming, and no task/status/auto-read admission.
  }
  seedHistory(historyCache.peek(cacheKey));
  if (!messagesLoaded) void historyCache.read(cacheKey).then(seedHistory).catch(() => {});
  // Narrow the canonical object subscription to its primitive mode before it
  // reaches the lifetime effect; unrelated appearance changes must not reconnect.
  const readMessageStreamTransport = dependencies.messageStreamTransport;
  const messageStreamMode = signal<NativeMessageStreamTransport | null>(readMessageStreamTransport ? null : 'sse');
  if (readMessageStreamTransport) effect(() => {
    const requested = readMessageStreamTransport();
    untracked(() => { if (messageStreamMode() !== requested) messageStreamMode.set(requested); });
  });
  effect(() => {
    laneRevision();
    if (readOnly) displayStreamRevision();
    // Only the most recently mounted chat owns foreground safety polling.
    const visible = runtimeReady() && syncDemand() && lifecycle() === 'active' && (readOnly || chatOwners().at(-1) === owner);
    const connection = app.connection();
    const mode = messageStreamMode();
    if (readOnly && sharedSource()) { displayStreamError.set(''); return; }
    if (!visible || !connection || !current()) { clearStreamingSelection(); goalCore.cancel(); activityFill.cancel(); void durable.flush().catch(() => {}); return; }
    activation++;
    const lane = operationLane;
    const streamActivation = activation;
    if (readOnly) streamKey = `panel-chat:${owner}:${streamActivation}`;
    const ownedStreamKey = streamKey;
    const ownerID = `chat-${owner}-${activation}`;
    let streamLeaseAlive = true;
    nativeStreamReady = false;
    if (!readOnly && target.kind === 'session' && mode !== null) streamOwnerID = ownerID;
    if (!readOnly && target.kind === 'session' && mode === null) streamDisconnected = true;
    streamState.set(!readOnly && target.kind === 'session' && mode === null ? 'inactive' : 'connecting');
    untracked(() => { void load(); if (goalObservers) void goalCore.refresh(); });
    let displayStreamStarted = false;
    if (target.kind === 'session') {
      if (readOnly && lane.scope && dependencies.displayConsumer?.stream) {
        displayStreamStarted = true; displayStreamError.set('');
        const port = dependencies.displayConsumer.stream, scope = lane.scope;
        void port.start({ path: `/api/event?${query(target.directory)}`, key: ownedStreamKey, expectedHost: scope }).then(() => {
          if (!streamLeaseAlive) void port.stop({ key: ownedStreamKey, expectedHost: scope }).catch(() => {});
        }).catch(() => { if (streamLeaseAlive && laneForeground(lane)) { streamDisconnected = true; displayStreamError.set('chat_display_stream_unavailable'); streamState.set('disconnected'); } });
      } else if (readOnly) { streamDisconnected = true; displayStreamError.set('chat_display_stream_unavailable'); streamState.set('disconnected'); }
      else if (mode !== null) void native('runtime.stream', { path: `/api/event?${query(target.directory)}`, key: 'chat', ownerID, mode, ...(lane.scope ? { expectedHost: lane.scope } : {}) }).catch(failure => {
        if (laneCurrent(lane) && streamOwnerID === ownerID) {
          // A rejected start is a dead live stream, not a pending one: let the
          // bounded content compensation take over instead of polling status only.
          streamDisconnected = true; streamState.set('disconnected'); fail(failure);
        }
      });
    }
    const interval = setInterval(() => {
      if (!laneForeground(lane)) return;
      // Live deltas own running text. Safety polls keep status/blocking authority without
      // racing token contents; disconnected/idle reads still recover missed output.
      // "Live" means the chat stream actually reached ready: a stream that was never
      // admitted (start rejection, missing event route, relay SSE refused) must keep
      // content compensation running instead of polling status only.
      const live = nativeStreamReady && !streamDisconnected;
      void load(false, target.kind === 'session' && busy() && live ? ['status', 'inbox', 'permissions', 'forms'] : allChatDomains, lane);
    }, 4000);
    return () => {
      streamLeaseAlive = false;
      if (streamOwnerID === ownerID) streamOwnerID = undefined;
      nativeStreamReady = false;
      void durable.flush().catch(() => {});
      activation++;
      streamState.set('inactive');
      goalCore.cancel();
      activityFill.cancel();
      clearStreamingSelection();
      workStatusSource.suspend();
      clearInterval(interval); if (timer) { clearTimeout(timer); timer = undefined; }
      if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = undefined; }
      if (target.kind === 'session') {
        if (readOnly && displayStreamStarted && lane.scope) void dependencies.displayConsumer?.stream?.stop({ key: ownedStreamKey, expectedHost: lane.scope }).catch(() => {});
        else if (!readOnly && mode !== null) void native('runtime.stop', { key: 'chat', ownerID, ...(lane.scope ? { expectedHost: lane.scope } : {}) }).catch(failure => { if (laneCurrent(lane)) fail(failure); });
      }
    };
  });
  // Display→overview changes retain one existing stream/poll owner while UI actions become inactive.
  effect(() => { const requested = active() || syncActive(); untracked(() => { if (!requested) { goalCore.cancel(); activityFill.cancel(); } if (syncDemand() !== requested) syncDemand.set(requested); }); });
  if (!readOnly) void durable.ready.then(async () => {
    if (!laneCurrent(initialOperationLane)) return;
    if (queueEdit()) await recoverQueueEdit(initialOperationLane);
    if (laneCurrent(initialOperationLane) && pendingSend()) await recoverPendingSend();
  }).catch(fail);
  let previouslyShared = false;
  effect(() => {
    const source = sharedSource();
    if (!source) {
      if (previouslyShared) untracked(() => { authorityMessageIDs = new Set(messages().map(message => message.id)); });
      previouslyShared = false; return;
    }
    if (!foreground()) return;
    previouslyShared = true;
    const snapshot = { messages: source.messages(), resolved: source.messagesResolved(), identity: source.sessionIdentity(), generation: source.historyGeneration(), cursor: source.historyCursor(), revert: source.revert(), repair: source.historyRepairPending(), more: source.more(), gap: source.hasGap(), loading: source.loading(), olderLoading: source.olderLoading(), error: source.error(), readError: source.messageReadError(), historyError: source.historyError(), busy: source.busy(), retry: source.retry(), streaming: source.streamingMessageIDs(), stream: source.streamState() };
    untracked(() => batch(() => {
      if (snapshot.resolved && snapshot.identity?.directory !== target.directory) { error.set('chat_directory_mismatch'); resolvedAuthority.set(false); return; }
      cursor = snapshot.cursor; messagesLoaded = snapshot.resolved;
      sessionIdentity.set(snapshot.identity);
      messages.set(snapshot.messages); resolvedAuthority.set(snapshot.resolved); historyGeneration.set(snapshot.generation); revertSource.set(snapshot.revert); historyRepairPending.set(snapshot.repair);
      more.set(snapshot.more); hasGap.set(snapshot.gap); loading.set(snapshot.loading); olderLoading.set(snapshot.olderLoading); error.set(snapshot.error); messageReadError.set(snapshot.readError); historyError.set(snapshot.historyError); busy.set(snapshot.busy); retry.set(snapshot.retry); streamingIDs.set(snapshot.streaming); streamState.set(snapshot.stream);
    }));
  });
  if (!readOnly) effect(() => {
    laneRevision();
    return untracked(() => registerDesktopChatReadSource(sourceIdentity(), { synchronizing: foreground, messages, messagesResolved, historyGeneration, historyCursor: () => cursor, sessionIdentity, revert, historyRepairPending, more, hasGap, loading, olderLoading, error, messageReadError, historyError, busy, retry, streamingMessageIDs, streamState, load, loadOlder, activityMaterialization }));
  });
  cleanup(() => { historyPresentationListener = undefined; previousHistoryPresentation = undefined; messageCommitListeners.clear(); void durable.close(); operationLane.history.close(); alive = false; activityFill.cancel(true); goalCore.retire(); taskSnapshot.set([]); workStatusSource.retire(tasks()); resolvedAuthority.set(false); clearStreamingSelection(); chatAuthorityRetirements.delete(retireAuthority); chatOperationResumptions.delete(rebuildOperationLane); unsubscribe(); disconnected(); if (timer) clearTimeout(timer); if (deltaTimer) clearTimeout(deltaTimer); if (!readOnly) chatOwners.set(chatOwners().filter(value => value !== owner)); });
  const displayActivityMaterialization = {
    state: (ids: readonly string[]) => (sharedSource()?.activityMaterialization ?? activityMaterialization).state(ids),
    request: (ids: readonly string[], options?: Parameters<typeof activityMaterialization.request>[1]) => foreground()
      ? (sharedSource()?.activityMaterialization ?? activityMaterialization).request(ids, options) : Promise.resolve(),
  };
  async function flushDraft() {
    const revision = durable.revision();
    await durable.flush();
    if (durable.status() === 'ready' && durable.revision() === revision) writerFlushRevision.set(revision);
  }
  function writerRetirement(): ChatWriterRetirement {
    if (readOnly) return { canRelease: true, needsFlush: false, reasons: [] };
    draft(); durable.references(); attachments(); durable.context(); laneRevision();
    const needsFlush = writerFlushRevision() !== durable.revision(), reasons: string[] = [];
    if (!alive) reasons.push('disposed');
    if (!writerRetiring()) reasons.push('not-prepared');
    if (durable.status() !== 'ready') reasons.push('draft-' + durable.status());
    if (needsFlush) reasons.push('draft-unflushed');
    if (pendingSend()) reasons.push('pending-send');
    if (queueEdit()) reasons.push('queue-edit');
    if (sending()) reasons.push('sending');
    if (historyBusy() || retiredWriterHistory()) reasons.push('history-unresolved');
    if (queueBusy() || queueFlight) reasons.push('queue-busy');
    if (recoveryFlight) reasons.push('recovery');
    if (writerWrites()) reasons.push('write-in-flight');
    if (writerUnconfirmed()) reasons.push('write-unconfirmed');
    return { canRelease: !reasons.length, needsFlush, reasons };
  }
  const canReleaseWriter = () => writerRetirement().canRelease;
  let writerPreparation: Promise<boolean> | undefined, writerPreparationSerial = 0;
  function cancelWriterRetirement() { writerPreparationSerial++; writerRetiring.set(false); }
  function prepareWriterRetirement(): Promise<boolean> {
    if (readOnly) return Promise.resolve(true);
    if (writerPreparation) return writerPreparation;
    const serial = ++writerPreparationSerial, lane = operationLane;
    writerRetiring.set(true);
    const valid = () => alive && serial === writerPreparationSerial && writerRetiring() && lane === operationLane;
    const prepared = (async () => {
      let accepted = false;
      try {
        await durable.whenReady();
        if (!valid() || writerRetirement().reasons.some(reason => reason !== 'draft-unflushed')) return false;
        await flushDraft();
        accepted = valid() && canReleaseWriter();
        return accepted;
      } catch { return false; }
      finally { if (serial === writerPreparationSerial && !accepted) writerRetiring.set(false); }
    })();
    writerPreparation = prepared;
    void prepared.finally(() => { if (writerPreparation === prepared) writerPreparation = undefined; });
    return prepared;
  }
  return { writerRetirement, canReleaseWriter, prepareWriterRetirement, cancelWriterRetirement, stageContext, context: () => durable.context(), clearContext, draftRevision: durable.draftRevision, draftAuthorityKey: dependencies.draftAuthorityKey, displayStreamError, sessionIdentity,
    composerRevision: durable.revision, compareAndSetDraftText, admitLocalMagic, admitLocalCompact, dispatchLocalMagicHandoff, compactionBarrier: () => compactionBarrier(),
    retryDisplayStream: () => { if (readOnly && foreground()) displayStreamRevision.set(displayStreamRevision() + 1); },
    contactReadPosition, contactOptimistic, retryContactMessage,
    rebuildOperationLane, goal, tasks, workStatus, activityMaterialization: readOnly ? displayActivityMaterialization : activityMaterialization, observeMessageCommits, messageReadError, get messageScope() { laneRevision(); return messageScope; }, messages, messagesResolved, historyGeneration, streamingMessageIDs, visibleMessages, revert: readOnly ? Object.assign(() => revert(), { set: rejectDesktopChatWrite, update: rejectDesktopChatWrite }) : revert, historyBusy, historyBoundaryMissing, historyRepairPending, refreshHistory, inbox, permissions, forms, error, executionError, loading, olderLoading, historyError, sending, busy, retry, streamState, commands, loadCommands, command, draft, references: durable.references, referenceDocument: durable.document, referenceScope: durable.scope, setReferenceDocument, setDraftText, insertReference, attachments, more, hasGap, active, syncActive, pendingSend, queueEdit, queueBusy, queueError, editInbox, cancelInbox, steerInbox, recoverQueueEdit, discardQueueEdit, recoverPendingSend, draftReady: durable.ready, draftStatus: durable.status, draftError: durable.error, flushDraft, restoreDraft: durable.restore, retryDraft: durable.retry, load, loadOlder, send, retrySend, stop, replyPermission, replyForm, cancelForm , historyActionStorageKey, compact, compactReceipt, prepareHistoryAction, captureAttachment, canSend, sendAdmission };
}
