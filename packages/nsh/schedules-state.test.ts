import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Connection, Row } from './model';

const harness = vi.hoisted(() => {
  const signal = <T>(initial: T) => { let value = initial; return Object.assign(() => value, { set: (next: T) => { value = next; } }); };
  return {
    signal, cleanups: [] as Array<() => void>, request: vi.fn(),
    app: { connection: signal<Connection | null>(null), tasks: signal<Row[]>([]), projects: signal([{ id: 'p /', name: 'Project', path: '/workspace/project' }]) },
  };
});
vi.mock('nsh', () => ({
  signal: harness.signal, cleanup: (work: () => void) => harness.cleanups.push(work),
  batch: <T>(work: () => T) => work(), untracked: <T>(work: () => T) => work(), lifecycle: () => 'active',
  effect: (work: () => unknown) => { const stop = work(); if (typeof stop === 'function') harness.cleanups.push(stop as () => void); },
  Storage: { getItem: async () => null, setItem: async () => undefined, removeItem: async () => undefined },
  host: {
    available: () => true,
    on: () => () => {},
    call: async (name: string, input: Row) => {
      if (name === 'connection.list') return {
        selected: 'host', connections: [{ id: 'host', url: 'https://fixture.example', authorizationID: 'fixture-authorization' }],
        runtimeScope: { hostID: 'host', lease: 'fixture-lease' },
      };
      if (name !== 'runtime.request') throw new Error(`unexpected_native_call:${name}`);
      expect(input.expectedHost).toEqual({ hostID: 'host', lease: 'fixture-lease' });
      const body = await (input.method === 'GET' ? harness.request(input.path) : harness.request(input.path, input.method, input.body));
      return { status: 200, body };
    },
  },
}));
vi.mock('./i18n', () => ({ t: (key: string) => key }));
const deferred = () => { let resolve!: (value: unknown) => void; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const task = (id = 't /', projectId = 'p /', enabled = true) => ({ projectId, task: { id, name: id, enabled, schedule: { kind: 'daily', time: '09:00' }, execution: { prompt: 'Review', providerID: 'test', modelID: 'test' }, state: {} } });
const run = (id = 'newest') => ({ id, projectId: 'p /', taskId: 't /', taskName: 'Daily', trigger: 'manual', status: 'success', sessionId: 'session', directory: '/old-worktree', error: null, startedAt: 1000, finishedAt: 2000, durationMs: 1000 });
beforeEach(async () => {
  vi.resetModules(); harness.request.mockReset(); harness.cleanups = [];
  const state = await import('./state');
  await state.loadConnections();
  harness.app = state.app;
  harness.app.tasks.set([task()]);
  harness.app.projects.set([{ id: 'p /', name: 'Project', path: '/workspace/project' }]);
});
afterEach(() => { harness.cleanups.forEach(stop => stop()); });

describe('scheduled task catalog native authority', () => {
  it.each(['read', 'write'] as const)('explicit dispose fences the captured %s lane without late catalog/loading/pending/notice writes', async kind => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog(), pending = deferred();
    const captured = catalog.capture();
    harness.request.mockReturnValueOnce(pending.promise);
    const flight = kind === 'read' ? catalog.load() : catalog.mutate(task(), 'toggle');
    catalog.dispose();
    const before = { tasks: harness.app.tasks(), loading: catalog.loading(), pending: catalog.pending(), notice: catalog.notice(), error: catalog.error() };
    expect(captured.current()).toBe(false); expect(() => catalog.capture()).toThrow('page_operation_stale');
    pending.resolve(kind === 'read' ? { tasks: [], failedProjectIds: [] } : { tasks: [], schedulerSynced: true }); await flight;
    expect({ tasks: harness.app.tasks(), loading: catalog.loading(), pending: catalog.pending(), notice: catalog.notice(), error: catalog.error() }).toEqual(before);
    harness.request.mockClear(); await expect(captured.request('/late')).rejects.toThrow('page_operation_stale');
    expect(harness.request).not.toHaveBeenCalled();
  });
  it('uses the Web enabled-first/name order without mutating authority or ordering by task id', async () => {
    const { sortScheduledTasks } = await import('./schedules-state');
    const source = [task('z', 'p /', false), task('later-id'), task('earlier-id')];
    source[1]!.task.name = 'Alpha'; source[2]!.task.name = 'Zulu'; source[0]!.task.name = 'A paused';
    expect(sortScheduledTasks(source).map(row => row.task)).toEqual([source[1]!.task, source[2]!.task, source[0]!.task]);
    expect(source.map(row => row.task.id)).toEqual(['z', 'later-id', 'earlier-id']);
  });
  it('preserves failed projects and replaces complete projects including authoritative empty', async () => {
    const { createScheduledCatalog } = await import('./schedules-state');
    harness.app.tasks.set([task(), task('other', 'failed')]);
    const catalog = createScheduledCatalog();
    harness.request.mockResolvedValueOnce({ tasks: [], failedProjectIds: ['failed'] });
    await catalog.load(); expect(harness.app.tasks()).toEqual([task('other', 'failed')]); expect(catalog.partial()).toEqual(['failed']);
    harness.request.mockResolvedValueOnce({ tasks: [], failedProjectIds: [] });
    await catalog.load(); expect(harness.app.tasks()).toEqual([]); expect(catalog.loaded()).toBe(true);
  });
  it('does not turn malformed response or refresh failure into an empty catalog', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog();
    for (const value of [{ tasks: null }, { tasks: [{}] }, { tasks: [], failedProjectIds: [1] }]) {
      harness.request.mockResolvedValueOnce(value); await catalog.load(); expect(harness.app.tasks()).toEqual([task()]); expect(catalog.error()).not.toBe('');
    }
    harness.request.mockRejectedValueOnce(new Error('offline')); await catalog.load(); expect(catalog.error()).toBe('offline'); expect(harness.app.tasks()).toEqual([task()]);
  });
  it('rejects logical failure and duplicate identities without destroying known tasks', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog();
    for (const response of [{ ok: false, tasks: [] }, { failed: true, tasks: [] }, { tasks: [task(), task()] }]) {
      harness.request.mockResolvedValueOnce(response); await catalog.load();
      expect(harness.app.tasks()).toEqual([task()]); expect(catalog.error()).not.toBe('');
    }
  });
  it('keeps one prior failed-project snapshot even when the response includes incomplete rows for it', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog();
    harness.app.tasks.set([task(), task('prior', 'failed')]);
    harness.request.mockResolvedValueOnce({ tasks: [task('fresh'), task('incomplete', 'failed')], failedProjectIds: ['failed'] });
    await catalog.load(); expect(harness.app.tasks()).toEqual([task('fresh'), task('prior', 'failed')]);
  });
  it('uses a minimal PATCH envelope and preserves committed writes with scheduler sync failure', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog();
    harness.request.mockResolvedValueOnce({ tasks: [task('t /', 'p /', false).task], schedulerSynced: false });
    await catalog.mutate(task(), 'toggle');
    expect(harness.request).toHaveBeenCalledWith('/api/projects/p%20%2F/scheduled-tasks', 'PATCH', { task: { id: 't /', enabled: false } });
    expect(harness.app.tasks()).toEqual([task('t /', 'p /', false)]); expect(catalog.error()).toBe(''); expect(catalog.notice()).toContain('saved'); expect(catalog.notice()).toContain('error');
  });
  it('deletes only its project after confirmation response and leaves other projects intact', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog();
    harness.app.tasks.set([task(), task('other', 'second')]); harness.request.mockResolvedValueOnce({ tasks: [], schedulerSynced: true });
    await catalog.mutate(task(), 'delete'); expect(harness.app.tasks()).toEqual([task('other', 'second')]);
    expect(harness.request).toHaveBeenCalledWith('/api/projects/p%20%2F/scheduled-tasks/t%20%2F', 'DELETE', undefined);
  });
  it('returns new sessions with captured project directory rather than guessing from task fields', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog();
    harness.request.mockResolvedValueOnce({ ok: true, task: task().task, sessionId: 'new-session' });
    expect(await catalog.mutate(task(), 'run')).toEqual({ kind: 'session', id: 'new-session', title: 't /', directory: '/workspace/project' });
    expect(harness.request).toHaveBeenCalledWith('/api/projects/p%20%2F/scheduled-tasks/t%20%2F/run', 'POST', undefined);
  });
  it('preserves state after failed or malformed mutations', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog();
    harness.request.mockRejectedValueOnce(new Error('conflict')); await catalog.mutate(task(), 'toggle');
    expect(catalog.error()).toBe('conflict'); expect(harness.app.tasks()).toEqual([task()]); expect(catalog.busy(task())).toBe(false);
    harness.request.mockResolvedValueOnce({ tasks: null }); await catalog.mutate(task(), 'delete'); expect(harness.app.tasks()).toEqual([task()]);
    harness.request.mockResolvedValueOnce({ ok: true, task: { id: 'wrong' } }); expect(await catalog.mutate(task(), 'run')).toBeUndefined(); expect(harness.app.tasks()).toEqual([task()]);
  });
  it('retains prior authority after an unknown write result and refreshes without replaying the mutation', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog();
    harness.request.mockRejectedValueOnce(new Error('response_lost'));
    await catalog.mutate(task(), 'toggle');
    expect(harness.app.tasks()).toEqual([task()]); expect(catalog.error()).toBe('response_lost'); expect(catalog.notice()).toBe('');
    harness.request.mockResolvedValueOnce({ tasks: [task('t /', 'p /', false)], failedProjectIds: [] });
    await catalog.load();
    expect(harness.app.tasks()).toEqual([task('t /', 'p /', false)]);
    expect(harness.request.mock.calls).toEqual([
      ['/api/projects/p%20%2F/scheduled-tasks', 'PATCH', { task: { id: 't /', enabled: false } }],
      ['/api/yuri/scheduled-tasks'],
    ]);
  });
  it('revokes an in-flight catalog write when explicitly disposed', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog(), pending = deferred();
    harness.request.mockReturnValueOnce(pending.promise); const write = catalog.mutate(task(), 'toggle');
    catalog.dispose();
    pending.resolve({ tasks: [task('t /', 'p /', false).task] }); await write;
    expect(harness.app.tasks()).toEqual([task()]); expect(catalog.notice()).toBe(''); expect(catalog.current()).toBe(false);
  });
  it.each([false, true])('core rejects an unavailable immediate run before making HTTP calls (running=%s)', async running => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog();
    const entry = task('t /', 'p /', running); entry.task.state = running ? { lastStatus: 'running' } : {};
    harness.app.tasks.set([entry]);
    expect(await catalog.mutate(entry, 'run')).toBeUndefined();
    expect(harness.request).not.toHaveBeenCalled(); expect(catalog.error()).toContain('runFailed');
  });
  it('does not accept a failed write envelope with an apparently empty tasks array', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog();
    harness.request.mockResolvedValueOnce({ ok: false, error: 'not_saved', tasks: [] });
    await catalog.mutate(task(), 'delete');
    expect(harness.app.tasks()).toEqual([task()]); expect(catalog.error()).toBe('not_saved');
  });
  it('fences old reads across separate page controllers after a committed write', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const old = createScheduledCatalog(), editor = createScheduledCatalog(), pending = deferred();
    harness.request.mockReturnValueOnce(pending.promise); const read = old.load();
    harness.request.mockResolvedValueOnce({ tasks: [task('t /', 'p /', false).task] }); await editor.mutate(task(), 'toggle');
    pending.resolve({ tasks: [task()], failedProjectIds: [] }); await read; expect(harness.app.tasks()).toEqual([task('t /', 'p /', false)]); expect(old.loading()).toBe(false);
  });
  it('lets the owning editor invalidate older catalog reads without issuing another mutation', async () => {
    const { createScheduledCatalog, noteScheduledCatalogWrite } = await import('./schedules-state');
    const catalog = createScheduledCatalog(), pending = deferred();
    harness.request.mockReturnValueOnce(pending.promise); const read = catalog.load();
    noteScheduledCatalogWrite(); harness.app.tasks.set([task('saved-by-editor')]);
    pending.resolve({ tasks: [task()], failedProjectIds: [] }); await read;
    expect(harness.app.tasks()).toEqual([task('saved-by-editor')]); expect(harness.request).toHaveBeenCalledTimes(1);
  });
  it('suspends a hidden page read and reloads on explicit foreground demand', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog(), pending = deferred();
    harness.request.mockReturnValueOnce(pending.promise); const read = catalog.load();
    catalog.suspend(); expect(catalog.loading()).toBe(false);
    pending.resolve({ tasks: [], failedProjectIds: [] }); await read; expect(harness.app.tasks()).toEqual([task()]);
    harness.request.mockResolvedValueOnce({ tasks: [task('foreground')], failedProjectIds: [] }); await catalog.load();
    expect(harness.app.tasks()).toEqual([task('foreground')]);
  });
  it('serializes project writes across controllers but allows independent projects', async () => {
    const { createScheduledCatalog } = await import('./schedules-state'); const one = createScheduledCatalog(), two = createScheduledCatalog(), pending = deferred();
    harness.app.tasks.set([task(), task('second'), task('independent', 'other')]);
    harness.request.mockReturnValueOnce(pending.promise); const write = one.mutate(task(), 'toggle');
    expect(two.busy(task('second'))).toBe(true); await two.mutate(task('second'), 'delete'); expect(harness.request).toHaveBeenCalledTimes(1);
    harness.request.mockResolvedValueOnce({ tasks: [] }); await two.mutate(task('independent', 'other'), 'delete'); expect(harness.request).toHaveBeenCalledTimes(2);
    pending.resolve({ tasks: [task('t /', 'p /', false).task, task('second').task] }); await write; expect(two.busy(task())).toBe(false);
  });
  it.each(['host', 'generation', 'unmount'] as const)('drops stale catalog reads and writes after %s changes', async mode => {
    const { createScheduledCatalog } = await import('./schedules-state'); const catalog = createScheduledCatalog(), pending = deferred();
    harness.request.mockReturnValueOnce(pending.promise); const write = catalog.mutate(task(), 'run');
    if (mode === 'host') harness.app.connection.set({ ...harness.app.connection()!, id: 'new' });
    if (mode === 'generation') await (await import('./state')).loadConnections({ forceReconnect: true });
    if (mode === 'unmount') harness.cleanups.forEach(stop => stop());
    pending.resolve({ ok: true, task: { ...task().task, enabled: false }, sessionId: 'late' });
    expect(await write).toBeUndefined(); expect(harness.app.tasks()).toEqual([task()]); expect(catalog.notice()).toBe('');
    harness.request.mockClear(); await catalog.load(); expect(harness.request).not.toHaveBeenCalled();
  });
});

describe('scheduled run history native paging', () => {
  it('explicit dispose fences both the captured wire and all late history publications', async () => {
    const { createScheduledHistory } = await import('./schedules-state'); const history = createScheduledHistory(), pending = deferred();
    harness.request.mockResolvedValueOnce({ runs: [run()], nextCursor: 'opaque', complete: false }); await history.load();
    harness.request.mockReturnValueOnce(pending.promise); const read = history.load(true);
    history.dispose();
    const before = { runs: history.runs(), loading: history.loading(), loaded: history.loaded(), complete: history.complete(), error: history.error() };
    pending.resolve({ runs: [run('late')], nextCursor: null, complete: true }); await read;
    expect({ runs: history.runs(), loading: history.loading(), loaded: history.loaded(), complete: history.complete(), error: history.error() }).toEqual(before);
    harness.request.mockClear(); await history.retry(); expect(harness.request).not.toHaveBeenCalled();
  });
  it('paginates global history with opaque encoded cursor, stable order and deduplication', async () => {
    const { createScheduledHistory } = await import('./schedules-state'); const history = createScheduledHistory();
    harness.request.mockResolvedValueOnce({ runs: [run()], nextCursor: 'opaque+/=', complete: false }); await history.load();
    harness.request.mockResolvedValueOnce({ runs: [run(), run('older')], nextCursor: null, complete: true }); await history.load(true);
    expect(harness.request).toHaveBeenLastCalledWith('/api/yuri/scheduled-task-runs?limit=20&before=opaque%2B%2F%3D', undefined, undefined);
    expect(history.runs().map(value => value.id)).toEqual(['newest', 'older']); expect(history.complete()).toBe(true);
  });
  it('scopes single-task history by both projectId and taskId', async () => {
    const { createScheduledHistory } = await import('./schedules-state'); const history = createScheduledHistory({ projectId: 'p /', taskId: 't /' });
    harness.request.mockResolvedValueOnce({ runs: [run()], nextCursor: null, complete: true }); await history.load();
    expect(harness.request).toHaveBeenCalledWith('/api/yuri/scheduled-task-runs?limit=20&projectId=p%20%2F&taskId=t%20%2F', undefined, undefined);
    harness.request.mockResolvedValueOnce({ runs: [{ ...run(), projectId: 'other' }], nextCursor: null, complete: true }); await history.load();
    expect(history.runs()).toEqual([run()]); expect(history.error()).not.toBe('');
  });
  it('preserves previous history after failed load-more and retries the same cursor', async () => {
    const { createScheduledHistory } = await import('./schedules-state'); const history = createScheduledHistory();
    harness.request.mockResolvedValueOnce({ runs: [run()], nextCursor: 'older', complete: false }); await history.load();
    harness.request.mockRejectedValueOnce(new Error('offline')); await history.load(true); expect(history.runs()).toEqual([run()]); expect(history.error()).toBe('offline');
    harness.request.mockResolvedValueOnce({ runs: [run('older')], nextCursor: null, complete: true }); await history.load(true);
    expect(harness.request.mock.calls.slice(-2).map(call => call[0])).toEqual(Array(2).fill('/api/yuri/scheduled-task-runs?limit=20&before=older'));
  });
  it('rejects inconsistent cursor, malformed DTO and invalid timestamps without clearing history', async () => {
    const { createScheduledHistory } = await import('./schedules-state'); const history = createScheduledHistory();
    harness.request.mockResolvedValueOnce({ runs: [run()], nextCursor: null, complete: true }); await history.load();
    for (const value of [
      { runs: [], nextCursor: 'more', complete: true }, { runs: [], nextCursor: '', complete: false },
      { runs: [{ ...run(), startedAt: -1 }], nextCursor: null, complete: true },
      { runs: [{ ...run(), directory: undefined }], nextCursor: null, complete: true },
    ]) { harness.request.mockResolvedValueOnce(value); await history.load(); expect(history.error()).not.toBe(''); expect(history.runs()).toEqual([run()]); }
  });
  it('refresh supersedes in-flight pagination and successful empty clears old history', async () => {
    const { createScheduledHistory } = await import('./schedules-state'); const history = createScheduledHistory(), pending = deferred();
    harness.request.mockResolvedValueOnce({ runs: [run()], nextCursor: 'more', complete: false }); await history.load();
    harness.request.mockReturnValueOnce(pending.promise); const older = history.load(true);
    harness.request.mockResolvedValueOnce({ runs: [], nextCursor: null, complete: true }); await history.load();
    pending.resolve({ runs: [run('old')], nextCursor: null, complete: true }); await older;
    expect(history.runs()).toEqual([]); expect(history.complete()).toBe(true);
  });
  it('keeps loaded older pages and their opaque continuation when a live first-page refresh overlaps', async () => {
    const { createScheduledHistory } = await import('./schedules-state'); const history = createScheduledHistory();
    harness.request.mockResolvedValueOnce({ runs: [run()], nextCursor: 'page-2', complete: false }); await history.load();
    harness.request.mockResolvedValueOnce({ runs: [run('older')], nextCursor: 'page-3', complete: false }); await history.load(true);
    harness.request.mockResolvedValueOnce({ runs: [run('latest'), { ...run(), status: 'error', error: 'updated' }], nextCursor: 'page-2-new', complete: false }); await history.load();
    expect(history.runs().map(value => value.id)).toEqual(['latest', 'newest', 'older']);
    expect(history.runs()[1]?.error).toBe('updated');
    harness.request.mockResolvedValueOnce({ runs: [run('oldest')], nextCursor: null, complete: true }); await history.load(true);
    expect(harness.request).toHaveBeenLastCalledWith('/api/yuri/scheduled-task-runs?limit=20&before=page-3', undefined, undefined);
    expect(history.runs().map(value => value.id)).toEqual(['latest', 'newest', 'older', 'oldest']);
  });
  it('does not silently bridge a missing refresh gap or revive history after an explicit logical failure', async () => {
    const { createScheduledHistory } = await import('./schedules-state'); const history = createScheduledHistory();
    harness.request.mockResolvedValueOnce({ runs: [run()], nextCursor: null, complete: true }); await history.load();
    harness.request.mockResolvedValueOnce({ ok: false, runs: [], nextCursor: null, complete: true }); await history.load();
    expect(history.runs()).toEqual([run()]); expect(history.error()).not.toBe('');
    harness.request.mockResolvedValueOnce({ runs: [run('replacement')], nextCursor: 'gap', complete: false }); await history.load();
    expect(history.runs().map(value => value.id)).toEqual(['replacement']); expect(history.complete()).toBe(false);
  });
  it.each(['host', 'generation', 'unmount'] as const)('drops history responses after %s', async mode => {
    const { createScheduledHistory } = await import('./schedules-state'); const history = createScheduledHistory(), pending = deferred();
    harness.request.mockReturnValueOnce(pending.promise); const read = history.load();
    if (mode === 'host') harness.app.connection.set({ ...harness.app.connection()!, id: 'new' });
    if (mode === 'generation') await (await import('./state')).loadConnections({ forceReconnect: true });
    if (mode === 'unmount') history.dispose();
    pending.resolve({ runs: [run()], nextCursor: null, complete: true }); await read;
    expect(history.runs()).toEqual([]); expect(history.error()).toBe('');
  });
  it('suspends hidden history without discarding its loaded rows or opaque cursor', async () => {
    const { createScheduledHistory } = await import('./schedules-state'); const history = createScheduledHistory(), pending = deferred();
    harness.request.mockResolvedValueOnce({ runs: [run()], nextCursor: 'opaque', complete: false }); await history.load();
    harness.request.mockReturnValueOnce(pending.promise); const read = history.load(); history.suspend();
    pending.resolve({ runs: [], nextCursor: null, complete: true }); await read;
    expect(history.runs()).toEqual([run()]); expect(history.loading()).toBe(false); expect(history.complete()).toBe(false);
    harness.request.mockResolvedValueOnce({ runs: [run('older')], nextCursor: null, complete: true }); await history.load(true);
    expect(harness.request).toHaveBeenLastCalledWith('/api/yuri/scheduled-task-runs?limit=20&before=opaque', undefined, undefined);
  });
  it('opens historical sessions using recorded directory first and never invents missing sessions', async () => {
    const { scheduledRunTarget } = await import('./schedules-state');
    expect(scheduledRunTarget(run())).toEqual({ kind: 'session', id: 'session', title: 'Daily', directory: '/old-worktree' });
    expect(scheduledRunTarget({ ...run(), directory: null })).toBeUndefined();
    expect(scheduledRunTarget({ ...run(), sessionId: null })).toBeUndefined();
    expect(scheduledRunTarget({ ...run(), directory: null, projectId: 'removed' })).toBeUndefined();
  });
});
