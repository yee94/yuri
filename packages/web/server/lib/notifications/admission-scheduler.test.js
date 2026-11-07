import { afterEach, expect, it, vi } from 'vitest';
import { createScheduledTasksRuntime } from '../scheduled-tasks/runtime.js';

const runtimes = [];
afterEach(() => { runtimes.splice(0).forEach(runtime => runtime.stop()); vi.restoreAllMocks(); vi.useRealTimers(); });
it.each([
  { handled: true, trigger: 'manual' }, { handled: false, trigger: 'manual' },
  { handled: true, trigger: 'scheduled' }, { handled: false, trigger: 'scheduled' },
  { handled: undefined, trigger: 'scheduled' }, { handled: false, trigger: 'scheduled', ownerInstalled: false },
  { handled: false, trigger: 'scheduled', persistenceFailure: true },
])('passes actual run identity only through the unowned result decision ($trigger, taken over: $handled, owner: $ownerInstalled, persistence failure: $persistenceFailure)', async ({ handled, trigger, ownerInstalled = true, persistenceFailure = false }) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-01-01T12:00:00Z')); vi.spyOn(Math, 'random').mockReturnValue(0);
  let task = { id: 'task', name: 'Task', enabled: true, schedule: { kind: 'once', date: '2026-01-01', time: '12:01', timezone: 'UTC' }, execution: { prompt: 'unused', providerID: 'provider', modelID: 'model' }, state: { createdAt: 1, updatedAt: 1, lastStatus: 'idle' } };
  const rows = new Map(), notify = vi.fn(), owner = vi.fn(async () => handled);
  const runtime = createScheduledTasksRuntime({
    projectConfigRuntime: { listScheduledTasks: async () => [task], upsertScheduledTask: async (_project, patch) => { task = { ...task, ...patch }; return { task }; }, updateScheduledTaskState: async (_project, _id, state) => { task = { ...task, state: { ...task.state, ...state } }; return { task }; } },
    listProjects: async () => [{ id: 'project', path: '/project' }], buildOpenCodeUrl: () => 'http://unused.invalid', getOpenCodeAuthHeaders: () => ({}),
    waitForOpenCodeReady: async () => { throw new Error('Synthetic runner unavailable'); }, persistSessionMetadata: async () => ({}), logger: { warn: () => {}, info: () => {} },
    runHistoryStore: { startRun: row => rows.set(row.id, row), finishRun: (id, patch) => { if (persistenceFailure) throw new Error('history unavailable'); return { ...rows.get(id), ...patch }; }, acknowledgeResult: () => {} }, notifyTaskRun: notify,
  });
  runtimes.push(runtime); if (ownerInstalled) runtime.setTaskResultHandler(owner);
  let result;
  if (trigger === 'manual') { await runtime.syncProject('project'); result = await runtime.runNow('project', 'task'); }
  else { await runtime.start(); await vi.advanceTimersByTimeAsync(60_001); }
  for (let n = 0; n < 20; n++) await Promise.resolve();
  if (result) expect(result.status).toBe('error');
  const reviewed = ownerInstalled && !persistenceFailure;
  expect(owner).toHaveBeenCalledTimes(reviewed ? 1 : 0);
  const runID = [...rows.keys()][0]; expect(runID).toMatch(/^[a-f0-9-]{36}$/);
  if (reviewed) expect(owner.mock.calls[0][0].id).toBe(runID);
  if (handled && reviewed) expect(notify).not.toHaveBeenCalled();
  else expect(notify).toHaveBeenCalledWith(expect.objectContaining({ runID, resultOwner: !ownerInstalled || reviewed && handled === false ? 'unowned' : undefined, projectID: 'project', taskID: 'task', reason: trigger, status: 'error' }));
});
