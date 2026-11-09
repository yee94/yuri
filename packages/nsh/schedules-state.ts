import { cleanup, signal } from 'nsh';
import { t } from './i18n';
import { record, text, type ChatTarget, type Row } from './model';
import { app, epoch } from './state';
import { createPageOperations } from './page-operations';

export type TaskIdentity = { projectId: string; taskId: string };
/** Wire DTO from scheduled-tasks/run-history-store.js rowToDto, without browser runtime imports. */
export type ScheduledTaskRun = {
  id: string; projectId: string; taskId: string; taskName: string;
  trigger: 'scheduled' | 'manual'; status: 'running' | 'success' | 'error';
  sessionId: string | null; directory: string | null; error: string | null;
  startedAt: number; finishedAt: number | null; durationMs: number | null;
};
let catalogRevision = 0;
/** Call after any confirmed editor write, before refreshing the shared task catalog. */
export function noteScheduledCatalogWrite() { catalogRevision++; }
const projectWrites = signal<string[]>([]);
export const taskIdentity = (item: Row): TaskIdentity => ({ projectId: text(item.projectId), taskId: text(record(item.task).id) });
export const taskKey = (item: Row) => JSON.stringify([item.projectId, record(item.task).id]);
export function sortScheduledTasks(items: Row[]) {
  return [...items].sort((left, right) => {
    const a = record(left.task), b = record(right.task);
    return a.enabled !== b.enabled ? a.enabled ? -1 : 1 : text(a.name).localeCompare(text(b.name));
  });
}
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const validTime = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 8.64e15;

function scope() {
  const operations = createPageOperations();
  let alive = true;
  const dispose = () => { alive = false; };
  cleanup(dispose);
  function capture() {
    if (!alive) throw new Error('page_operation_stale');
    const lane = operations.capture();
    const current = () => alive && lane.current();
    return { ...lane, current, request: async (...args: Parameters<typeof lane.request>) => {
      if (!current()) throw new Error('page_operation_stale');
      const result = await lane.request(...args);
      if (!current()) throw new Error('page_operation_stale');
      return result;
    } };
  }
  return { current: () => alive && operations.current(), capture, onRetire: operations.onRetire, dispose };
}

function isRun(value: unknown): value is ScheduledTaskRun {
  const run = record(value);
  return !!text(run.id) && !!text(run.projectId) && !!text(run.taskId) && typeof run.taskName === 'string'
    && ['scheduled', 'manual'].includes(text(run.trigger)) && ['running', 'success', 'error'].includes(text(run.status))
    && ['sessionId', 'directory', 'error'].every(key => run[key] === null || typeof run[key] === 'string')
    && validTime(run.startedAt) && (run.finishedAt === null || validTime(run.finishedAt))
    && (run.durationMs === null || typeof run.durationMs === 'number' && Number.isFinite(run.durationMs) && run.durationMs >= 0);
}
const failedResponse = (value: Row) => value.ok === false || value.failed === true || value.partial === true;

/** Native history follows the Host DTO and keeps its cursor opaque. */
export function createScheduledHistory(identity?: TaskIdentity) {
  const owner = scope();
  const runs = signal<ScheduledTaskRun[]>([]), loading = signal(false), error = signal(''), complete = signal(false), loaded = signal(false);
  let sequence = 0, cursor: string | null = null, failedOlder = false;
  owner.onRetire(() => { sequence++; loading.set(false); });
  async function load(older = false) {
    if (!owner.current() || older && (loading() || !cursor)) return;
    const lane = owner.capture(), request = lane.request;
    const current = lane.current;
    const attempt = ++sequence, before = older ? cursor : null;
    loading.set(true); error.set('');
    try {
      const params = `limit=20${before ? `&before=${encodeURIComponent(before)}` : ''}${identity ? `&projectId=${encodeURIComponent(identity.projectId)}&taskId=${encodeURIComponent(identity.taskId)}` : ''}`;
      const page = record(await request(`/api/yuri/scheduled-task-runs?${params}`));
      if (!current() || attempt !== sequence) return;
      const pageRuns = page.runs;
      if (failedResponse(page) || !Array.isArray(pageRuns) || !pageRuns.every(isRun) || typeof page.complete !== 'boolean'
        || !(page.nextCursor === null || typeof page.nextCursor === 'string' && page.nextCursor.length > 0)
        || page.complete !== (page.nextCursor === null)
        || before !== null && page.nextCursor === before
        || identity && pageRuns.some(run => run.projectId !== identity.projectId || run.taskId !== identity.taskId)) {
        throw new Error(t('sessions.scheduledTasks.history.error.description'));
      }
      // A refreshed first page must not discard already loaded older pages. Only
      // retain a suffix when the page overlaps it, so a missing gap is never hidden.
      const previous = runs(), last = pageRuns[pageRuns.length - 1];
      const overlap = !older && page.nextCursor !== null && last ? previous.findIndex(run => run.id === last.id) : -1;
      const suffix = overlap >= 0 ? previous.slice(overlap + 1) : [];
      const existing = older ? previous : [];
      const known = new Set(existing.map(run => run.id));
      const merged = [...existing, ...pageRuns.filter(run => { if (known.has(run.id)) return false; known.add(run.id); return true; })];
      runs.set([...merged, ...suffix.filter(run => !known.has(run.id))]);
      if (!suffix.length) { cursor = typeof page.nextCursor === 'string' ? page.nextCursor : null; complete.set(page.complete); }
      loaded.set(true);
    } catch (failure) {
      if (current() && attempt === sequence) { failedOlder = older; error.set(message(failure)); }
    } finally {
      if (current() && attempt === sequence) loading.set(false);
    }
  }
  return { runs, loading, error, complete, loaded, load, suspend: () => { sequence++; loading.set(false); }, retry: () => load(failedOlder), current: owner.current, dispose: owner.dispose };
}

function taskRows(value: unknown): Row[] {
  if (!Array.isArray(value) || value.some(item => !text(record(item).id))) throw new Error(t('sessions.scheduledTasks.dialog.toast.loadFailed'));
  return value.map(record);
}

/** Only confirmed task writes update the shared catalog; stale reads cannot undo them. */
export function createScheduledCatalog() {
  const owner = scope();
  const loading = signal(false), error = signal(''), notice = signal(''), partial = signal<string[]>([]), pending = signal<string[]>([]), loaded = signal(false);
  let sequence = 0;
  owner.onRetire(() => { sequence++; loading.set(false); pending.set([]); });
  async function load() {
    if (!owner.current()) return;
    const lane = owner.capture(), request = lane.request;
    const current = lane.current;
    const attempt = ++sequence, revision = catalogRevision;
    loading.set(true); error.set('');
    try {
      const body = record(await request('/api/yuri/scheduled-tasks'));
      if (!current() || attempt !== sequence || revision !== catalogRevision) return;
      if (failedResponse(body) || !Array.isArray(body.tasks) || body.tasks.some(value => !text(record(value).projectId) || !text(record(record(value).task).id))
        || body.failedProjectIds !== undefined && (!Array.isArray(body.failedProjectIds) || body.failedProjectIds.some(value => typeof value !== 'string'))) {
        throw new Error(t('sessions.scheduledTasks.dialog.toast.loadFailed'));
      }
      const failed = Array.isArray(body.failedProjectIds) ? body.failedProjectIds.filter((value): value is string => typeof value === 'string') : [];
      const completeRows = body.tasks.map(record).filter(item => !failed.includes(text(item.projectId)));
      if (new Set(completeRows.map(taskKey)).size !== completeRows.length) throw new Error(t('sessions.scheduledTasks.dialog.toast.loadFailed'));
      app.tasks.set([...completeRows, ...app.tasks().filter(item => failed.includes(text(item.projectId)))]);
      partial.set(failed); loaded.set(true);
    } catch (failure) {
      if (current() && attempt === sequence) error.set(message(failure));
    } finally {
      if (current() && attempt === sequence) loading.set(false);
    }
  }
  const latest = (item: Row) => app.tasks().find(row => taskKey(row) === taskKey(item));
  const writeKey = (item: Row) => JSON.stringify([epoch(), app.connection()?.id, item.projectId]);
  const busy = (item: Row) => projectWrites().includes(writeKey(item));
  async function mutate(item: Row, kind: 'toggle' | 'delete' | 'run'): Promise<ChatTarget | undefined> {
    if (!owner.current() || busy(item)) return;
    const lane = owner.capture(), request = lane.request;
    const current = lane.current;
    const entry = latest(item);
    if (!entry) { error.set(t('sessions.scheduledTasks.dialog.empty.noTasks')); return; }
    const task = record(entry.task), identity = taskIdentity(entry), key = taskKey(entry);
    if (!identity.projectId || !identity.taskId) return;
    if (kind === 'run' && (task.enabled !== true || record(task.state).lastStatus === 'running')) { error.set(t('sessions.scheduledTasks.dialog.toast.runFailed')); return; }
    const directory = app.projects().find(project => project.id === identity.projectId)?.path;
    const base = `/api/projects/${encodeURIComponent(identity.projectId)}/scheduled-tasks`;
    const lock = writeKey(entry);
    projectWrites.set([...projectWrites(), lock]);
    pending.set([...pending(), key]); error.set(''); notice.set('');
    try {
      const response = record(await request(
        kind === 'toggle' ? base : `${base}/${encodeURIComponent(identity.taskId)}${kind === 'run' ? '/run' : ''}`,
        kind === 'toggle' ? 'PATCH' : kind === 'delete' ? 'DELETE' : 'POST',
        kind === 'toggle' ? { task: { id: identity.taskId, enabled: !task.enabled } } : undefined,
      ));
      if (!current()) return;
      if (failedResponse(response)) throw new Error(text(response.error) || text(response.message) || t('sessions.scheduledTasks.dialog.toast.updateFailed'));
      const tasks = kind === 'run' ? null : taskRows(response.tasks);
      if (kind === 'run' && (response.ok !== true || text(record(response.task).id) !== identity.taskId)) throw new Error(t('sessions.scheduledTasks.dialog.toast.runFailed'));
      noteScheduledCatalogWrite(); sequence++; loading.set(false);
      if (tasks) {
        app.tasks.set([...app.tasks().filter(row => row.projectId !== identity.projectId), ...tasks.map(task => ({ projectId: identity.projectId, task }))]);
        partial.set(partial().filter(id => id !== identity.projectId));
      } else app.tasks.set(app.tasks().map(row => taskKey(row) === key ? { ...row, task: record(response.task) } : row));
      const saved = t(kind === 'delete' ? 'sessions.scheduledTasks.dialog.toast.deleted' : kind === 'run' ? 'sessions.scheduledTasks.dialog.toast.started' : 'sessions.scheduledTasks.dialog.toast.saved');
      notice.set(response.schedulerSynced === false ? `${saved} · ${t('sessions.scheduledTasks.dialog.title')} · ${t('sessions.scheduledTasks.dialog.status.error')}` : saved);
      if (kind === 'run' && text(response.sessionId) && directory) return { kind: 'session', id: text(response.sessionId), title: text(task.name), directory };
    } catch (failure) {
      if (current()) error.set(message(failure));
    } finally {
      projectWrites.set(projectWrites().filter(value => value !== lock));
      if (current()) pending.set(pending().filter(value => value !== key));
    }
  }
  return { loading, error, notice, partial, pending, loaded, load, suspend: () => { sequence++; loading.set(false); }, latest, busy, mutate, capture: owner.capture, current: owner.current, dispose: owner.dispose };
}

export function scheduledRunTarget(run: ScheduledTaskRun): ChatTarget | undefined {
  const directory = run.directory;
  if (!run.sessionId || !directory) return;
  return { kind: 'session', id: run.sessionId, title: run.taskName, directory };
}
