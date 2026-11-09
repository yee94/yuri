/** Scheduled-task native engine fixture; never loaded by the production Host. */
export function createHost() {
  const makeTask = (id, name, enabled) => ({
    id, name, enabled,
    schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
    execution: { prompt: 'Inspect native scheduled task history', providerID: 'test', modelID: 'native-model', agent: 'build', variant: 'high' },
    state: { lastStatus: 'success', lastRunAt: 1700000000000, nextRunAt: Date.now() + 7200000 },
  });
  let tasks = [makeTask('daily', 'Native daily schedule', true), makeTask('paused', 'Native paused schedule', false)];
  const run = id => ({ id, projectId: 'project', taskId: 'daily', taskName: `Native history ${id}`, trigger: 'manual', status: 'success', sessionId: `session-${id}`, directory: '/workspace/recorded-worktree', error: null, startedAt: 1700000000000, finishedAt: 1700000005000, durationMs: 5000 });
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'schedule-host', connections: [{ id: 'schedule-host', url: 'https://host.example', label: 'Test', lastUsedAt: 0 }], runtimeScope: { hostID: 'schedule-host', lease: 'synthetic-schedules-mobile' } };
    if (name !== 'runtime.request') throw new Error(`Unexpected native call: ${name}`);
    const { path, method, body } = input;
    if (path === '/api/yuri/scheduled-tasks') return { status: 200, body: { tasks: tasks.map(task => ({ projectId: 'project', task })), failedProjectIds: [] } };
    if (path.startsWith('/api/yuri/scheduled-task-runs?')) {
      const older = path.includes('before=');
      return { status: 200, body: { runs: [run(older ? 'older' : 'newest')], nextCursor: older ? null : 'opaque+/=', complete: older } };
    }
    if (path === '/api/projects/project/scheduled-tasks' && method === 'PATCH') {
      tasks = tasks.map(task => task.id === body.task.id ? { ...task, enabled: body.task.enabled } : task);
      return { status: 200, body: { tasks, task: tasks.find(task => task.id === body.task.id), schedulerSynced: true } };
    }
    if (path === '/api/projects/project/scheduled-tasks/daily/run' && method === 'POST') return { status: 200, body: { ok: true, task: tasks[0], sessionId: 'newly-started' } };
    if (path === '/api/projects/project/scheduled-tasks/daily' && method === 'DELETE') {
      tasks = tasks.filter(task => task.id !== 'daily');
      return { status: 200, body: { tasks, schedulerSynced: true } };
    }
    throw new Error(`Unexpected scheduled request: ${method} ${path}`);
  } };
}
