import { readAssistantSnapshot } from './assistants-core';
import { record, type ChatTarget, type Project } from './model';
import { resourceName, resourcePath } from './resources-model';
import { sameRuntimeScope, type RuntimeScope } from './runtime-scope';
import { desktopNavigationTargetFrom, type DesktopNavigationContext, type DesktopNavigationHomeSection, type DesktopNavigationRestoreDecision, type DesktopNavigationTarget } from './desktop-navigation-state-core';

export type ResolvedNavigation = Readonly<
  | { kind: 'home'; section: DesktopNavigationHomeSection }
  | { kind: 'session'; target: ChatTarget; messageID?: string }
  | { kind: 'assistant'; target: ChatTarget }
  | { kind: 'project'; project: Project }
  | { kind: 'new-session'; directory: string; project?: Project }
>;
export type DesktopNavigationOperation = Readonly<{
  scope: RuntimeScope | null; current: () => boolean; request: (path: string) => Promise<unknown>;
}>;
type Resolution = { status: 'ready'; resource: ResolvedNavigation; target: DesktopNavigationTarget } | { status: 'missing' | 'blocked' };
const stale = () => new Error('desktop_navigation_restore_stale');
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop_navigation_invalid_response');
  const row = value as Record<string, unknown>;
  if (row.ok === false || row.success === false || row.failed === true || row.partial === true) throw new Error('desktop_navigation_incomplete_response');
  return row;
}
function body(value: unknown) {
  const row = object(value);
  return row.data === undefined ? row : object(row.data);
}
const equalDirectory = (left: string, right: string) => resourcePath(left) === resourcePath(right);
function actualDirectory(row: Record<string, unknown>): string {
  const direct = row.directory, located = record(row.location).directory;
  if (direct !== undefined && (typeof direct !== 'string' || typeof located === 'string' && !equalDirectory(direct, located))) throw new Error('desktop_navigation_directory_mismatch');
  const value = located ?? direct;
  if (typeof value !== 'string') throw new Error('desktop_navigation_missing_directory');
  resourcePath(value); return value;
}
function timestamp(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('desktop_navigation_invalid_archive');
  return value;
}

/** Existing GET /api/fs/stat is FILE-ONLY (fs/routes.js); /api/fs/list performs actual
 * stat.isDirectory + readdir and returns canonical path. Its .opencode/plans ENOENT
 * exception reports empty success, so that one case additionally requires a real
 * directory entry in the parent listing. No mkdir, registration or model execution. */
async function verifyDirectory(directory: string, read: DesktopNavigationOperation['request']): Promise<boolean> {
  const expected = resourcePath(directory);
  const listing = object(await read(`/api/fs/list?path=${encodeURIComponent(directory)}`));
  if (typeof listing.path !== 'string' || !equalDirectory(listing.path, expected) || !Array.isArray(listing.entries)) throw new Error('desktop_navigation_directory_mismatch');
  if (expected.endsWith('.opencode/plans')) {
    const parent = expected.slice(0, expected.lastIndexOf('/'));
    const observed = object(await read(`/api/fs/list?path=${encodeURIComponent(parent)}`));
    if (typeof observed.path !== 'string' || !equalDirectory(observed.path, parent) || !Array.isArray(observed.entries)) throw new Error('desktop_navigation_invalid_directory_listing');
    const matches = observed.entries.map(object).filter(entry => typeof entry.path === 'string' && equalDirectory(entry.path, expected));
    if (matches.length > 1) throw new Error('desktop_navigation_ambiguous_directory');
    return matches.length === 1 && matches[0].isDirectory === true;
  }
  return true;
}
async function projectByID(projectID: string, read: DesktopNavigationOperation['request']): Promise<Project | null> {
  const settings = body(await read('/api/config/settings'));
  if (!Array.isArray(settings.projects)) throw new Error('desktop_navigation_invalid_projects');
  const rows = settings.projects.map(object), ids = new Set<string>();
  for (const row of rows) {
    if (typeof row.id !== 'string' || !row.id || typeof row.path !== 'string' || !row.path || ids.has(row.id)) throw new Error('desktop_navigation_invalid_projects');
    ids.add(row.id);
  }
  const row = rows.find(entry => entry.id === projectID);
  if (!row) return null;
  const path = resourcePath(String(row.path));
  return { id: projectID, path, name: typeof row.label === 'string' && row.label || typeof row.name === 'string' && row.name || resourceName(path) };
}

/** Same catalog wire as createScheduledCatalog, without constructing its live owner.
 * A failed project makes navigation validation incomplete; an empty complete catalog
 * still admits the section. No task/project identity is inferred for a home target. */
function verifySchedulesSnapshot(value: unknown) {
  const snapshot = object(value);
  if (snapshot.complete === false || !Array.isArray(snapshot.tasks) || snapshot.tasks.some(value => typeof record(value).projectId !== 'string' || !record(value).projectId || typeof record(record(value).task).id !== 'string' || !record(record(value).task).id)
    || snapshot.failedProjectIds !== undefined && (!Array.isArray(snapshot.failedProjectIds) || snapshot.failedProjectIds.length > 0)) throw new Error('desktop_navigation_incomplete_scheduled_catalog');
  const identities = snapshot.tasks.map(value => JSON.stringify([record(value).projectId, record(record(value).task).id]));
  if (new Set(identities).size !== identities.length) throw new Error('desktop_navigation_invalid_scheduled_catalog');
}

/** A projection is never existence authority. Every nonempty target is resolved through
 * captured authenticated GET wire, not app.sessions/projects/bots. Wrong identity/directory,
 * malformed/partial success and 401/5xx throw (preserve prior); only verified absence/404
 * or archived/tombstoned resources return missing. Workspace membership uses the exact
 * project's worktree catalog, never longest-prefix/first-project guessing. messageID is
 * only a reveal hint for the existing history-focus owner, not proof of a loaded message;
 * session restore does not fetch transcript bodies merely to validate an anchor. */
export async function resolveDesktopNavigation(target: DesktopNavigationTarget, context: DesktopNavigationContext, operation: DesktopNavigationOperation): Promise<Resolution> {
  target = desktopNavigationTargetFrom(target);
  const current = () => context.current() && operation.current() && operation.scope !== null && sameRuntimeScope(operation.scope, context.runtimeScope);
  const check = () => { if (!current()) throw stale(); };
  const read = async (path: string) => {
    check(); const result = await operation.request(path); check();
    if (result && typeof result === 'object' && !Array.isArray(result)) object(result);
    return result;
  };
  check();
  try {
    if (target.kind === 'home') {
      if (target.section === 'assistants') {
        const snapshot = await readAssistantSnapshot({ current, request: read });
        if (snapshot.complete === false) throw new Error('desktop_navigation_incomplete_response');
      } else verifySchedulesSnapshot(await read('/api/yuri/scheduled-tasks'));
      check();
      return { status: 'ready', resource: { kind: 'home', section: target.section }, target };
    }
    if (target.kind === 'session') {
      const row = body(await read(`/api/session/${encodeURIComponent(target.sessionID)}?directory=${encodeURIComponent(target.directory)}`));
      if (row.id !== target.sessionID) throw new Error('desktop_navigation_session_mismatch');
      const directory = actualDirectory(row);
      if (!equalDirectory(directory, target.directory)) throw new Error('desktop_navigation_directory_mismatch');
      const time = object(row.time);
      if (timestamp(time.archived) > 0) return { status: 'missing' };
      const resource: ResolvedNavigation = { kind: 'session', target: { kind: 'session', id: target.sessionID,
        title: typeof row.title === 'string' ? row.title : target.sessionID, directory }, ...(target.messageID ? { messageID: target.messageID } : {}) };
      return { status: 'ready', resource, target: { ...target, directory } };
    }
    if (target.kind === 'assistant') {
      const snapshot = await readAssistantSnapshot({ current, request: read });
      if (snapshot.enabled !== true) return { status: 'blocked' };
      const matches = (snapshot.assistants as unknown[]).map(object).filter(row => row.id === target.assistantID);
      if (!matches.length) return { status: 'missing' };
      const bot = matches[0];
      if (timestamp(bot.tombstoneAt) > 0) return { status: 'missing' };
      if (bot.enabled !== true) return { status: 'blocked' };
      if (typeof bot.effectiveWorkspacePath !== 'string' || !bot.effectiveWorkspacePath) throw new Error('desktop_navigation_missing_directory');
      const directory = bot.effectiveWorkspacePath; resourcePath(directory);
      if (target.directory && !equalDirectory(directory, target.directory)) throw new Error('desktop_navigation_directory_mismatch');
      const resource: ResolvedNavigation = { kind: 'assistant', target: { kind: 'assistant', id: target.assistantID,
        title: typeof bot.name === 'string' ? bot.name : target.assistantID, directory } };
      return { status: 'ready', resource, target: { ...target, directory } };
    }
    if (target.kind === 'new-session' && !target.directory) {
      if (target.projectID !== undefined) throw new Error('desktop_navigation_project_requires_directory');
      return { status: 'ready', resource: { kind: 'new-session', directory: '' }, target };
    }
    const project = target.projectID === undefined ? undefined : await projectByID(target.projectID, read);
    if (project === null) return { status: 'missing' };
    if (project && !equalDirectory(project.path, target.directory)) {
      if (target.kind === 'project') throw new Error('desktop_navigation_project_directory_mismatch');
      const worktrees = await read(`/api/git/worktrees?directory=${encodeURIComponent(project.path)}`);
      if (!Array.isArray(worktrees)) throw new Error('desktop_navigation_invalid_worktrees');
      const rows = worktrees.map(object);
      if (rows.some(row => typeof row.path !== 'string')) throw new Error('desktop_navigation_invalid_worktrees');
      if (rows.filter(row => equalDirectory(String(row.path), target.directory)).length !== 1) throw new Error('desktop_navigation_project_directory_mismatch');
    }
    if (!await verifyDirectory(target.directory, read)) return { status: 'missing' };
    check();
    if (target.kind === 'project') {
      if (!project) throw new Error('desktop_navigation_project_required');
      return { status: 'ready', resource: { kind: 'project', project }, target: { ...target, directory: project.path } };
    }
    return { status: 'ready', resource: { kind: 'new-session', directory: target.directory, ...(project ? { project } : {}) }, target };
  } catch (error) {
    check();
    if (target.kind !== 'home' && record(error).status === 404) return { status: 'missing' };
    throw error;
  }
}

/** Explicit nav mutation / actual draft-directory publication only. Not an Input.onChange
 * subscriber. Only root/new-session consume actualDraftDirectory; a project is never
 * selected by path. Unknown overlays return null so their underlying public route can
 * remain persisted. Root without a published directory is unknown, not an empty draft. */
export function projectDesktopNavigation(route: { kind: string; section?: DesktopNavigationHomeSection; target?: ChatTarget; messageID?: string; project?: Project; directory?: string }, actualDraftDirectory?: string): DesktopNavigationTarget | null {
  if (route.kind === 'home') return desktopNavigationTargetFrom({ kind: 'home', section: route.section });
  if (route.kind === 'chat' && route.target) return desktopNavigationTargetFrom(route.target.kind === 'session'
    ? { kind: 'session', sessionID: route.target.id, directory: route.target.directory, ...(route.messageID ? { messageID: route.messageID } : {}) }
    : { kind: 'assistant', assistantID: route.target.id, directory: route.target.directory });
  if (route.kind === 'project' && route.project) return desktopNavigationTargetFrom({ kind: 'project', projectID: route.project.id, directory: route.project.path });
  if (route.kind === 'new-session' || route.kind === 'root' && actualDraftDirectory !== undefined) {
    return desktopNavigationTargetFrom({ kind: 'new-session', directory: actualDraftDirectory ?? route.directory ?? route.project?.path ?? '',
      ...(route.project ? { projectID: route.project.id } : {}) });
  }
  return null;
}

/** Exactly one transient resolved resource, consumed once by the core's immediate CAS.
 * Nothing here is persisted; retire clears both pending data and await admission. */
export function createDesktopNavigationRestoreAdmission(options: {
  captureOperation: () => DesktopNavigationOperation;
  authorize?: (resource: ResolvedNavigation, context: DesktopNavigationContext) => boolean | Promise<boolean>;
  rawApply: (resource: ResolvedNavigation, context: DesktopNavigationContext) => boolean;
}) {
  let alive = true, revision = 0;
  let pending: { resource: ResolvedNavigation; target: string; context: DesktopNavigationContext; current: () => boolean } | null = null;
  const retire = () => { revision++; pending = null; };
  return {
    retire,
    pendingResolvedCount: () => pending ? 1 : 0,
    async requestRestore(target: DesktopNavigationTarget, context: DesktopNavigationContext): Promise<DesktopNavigationRestoreDecision> {
      retire(); const ticket = revision, operation = options.captureOperation();
      const current = () => alive && ticket === revision && context.current() && operation.current() && operation.scope !== null && sameRuntimeScope(operation.scope, context.runtimeScope);
      try {
        if (!current()) throw stale();
        const result = await resolveDesktopNavigation(target, { ...context, current }, operation);
        if (!current()) throw stale();
        if (result.status !== 'ready') return { status: result.status };
        if (options.authorize && await options.authorize(result.resource, { ...context, current }) !== true) {
          if (!current()) throw stale();
          return { status: 'blocked' };
        }
        if (!current()) throw stale();
        pending = { resource: result.resource, target: JSON.stringify(result.target), context, current };
        return { status: 'ready', target: result.target };
      } catch (error) { if (ticket === revision) pending = null; throw error; }
    },
    onRestore(target: DesktopNavigationTarget, context: DesktopNavigationContext): boolean {
      const resolved = pending;
      if (!resolved) return false;
      if (!resolved.current()) { pending = null; return false; }
      // A delayed old CAS must not consume a different, newly resolved resource.
      if (resolved.context !== context || resolved.target !== JSON.stringify(target)) return false;
      pending = null;
      return options.rawApply(resolved.resource, { ...context, current: resolved.current }) === true;
    },
    dispose() { alive = false; retire(); },
  };
}
