/** Synthetic desktop schedule/catalog/history fixture, never loaded by production. */
export function createHost(player) {
  const requests = [];
  const makeTask = (id, name, enabled) => ({ id, name, enabled, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { prompt: `Draft for ${name}`, providerID: 'fixture', modelID: 'native' }, state: { lastStatus: 'success', lastRunAt: 1700000000000, nextRunAt: 1700007200000 } });
  let tasks = [makeTask('daily', 'Desktop daily schedule', true), makeTask('paused', 'Desktop paused schedule', false)], mode = '', historyFailed = false;
  const ok = body => ({ status: 200, body });
  const run = (index, projectId = 'project', taskId = 'daily') => ({ id: `run-${index}`, projectId, taskId, taskName: `History ${index}`, trigger: 'manual', status: 'success', sessionId: `session-${index}`, directory: '/workspace/recorded-worktree', error: null, startedAt: 1700000000000 + index * 1000, finishedAt: 1700000005000 + index * 1000, durationMs: 5000 });
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'desktop-schedules', connections: [{ id: 'desktop-schedules', label: 'Synthetic Host', url: 'https://host.example', lastUsedAt: 0 }], runtimeScope: { hostID: 'desktop-schedules', lease: 'synthetic-desktop-schedules' } };
    if (name !== 'runtime.request') throw new Error(`Unexpected schedule fixture native call: ${name}`);
    const { path, method, body } = input; requests.push({ path, method, body });
    if (path === '/fixture/audit') return ok(requests);
    if (path.startsWith('/fixture/')) { mode = path.slice('/fixture/'.length); player.hostEvent('runtime.event', { key: 'global', data: JSON.stringify({ type: 'yuri:scheduled-task-ran', data: {} }) }); return ok({}); }
    if (path === '/api/yuri/scheduled-tasks') {
      if (mode === 'fail') { mode = ''; return { status: 503, body: { error: 'synthetic_schedule_read_failed' } }; }
      return ok({ tasks: mode === 'empty' || mode === 'partial' ? [] : tasks.map(task => ({ projectId: 'project', task })), failedProjectIds: mode === 'partial' ? ['project'] : [] });
    }
    if (path.startsWith('/api/yuri/scheduled-task-runs?')) {
      const params = Object.fromEntries(path.slice(path.indexOf('?') + 1).split('&').map(pair => pair.split('=').map(decodeURIComponent)));
      const before = params.before, taskId = params.taskId || 'daily';
      if (before && before !== 'opaque+/=') throw new Error('Cursor was reinterpreted');
      if (before && !historyFailed) { historyFailed = true; return { status: 503, body: { error: 'synthetic_history_more_failed' } }; }
      return ok({ runs: before ? [run(20, 'project', taskId)] : Array.from({ length: 20 }, (_, index) => run(index, 'project', taskId)), complete: !!before, nextCursor: before ? null : 'opaque+/=' });
    }
    if (path === '/api/projects/project/scheduled-tasks' && method === 'PATCH') { tasks = tasks.map(task => task.id === body.task.id ? { ...task, enabled: body.task.enabled } : task); return ok({ tasks, schedulerSynced: true }); }
    if (path === '/api/projects/project/scheduled-tasks/daily/run' && method === 'POST') return ok({ ok: true, task: tasks.find(task => task.id === 'daily'), sessionId: 'started-but-not-navigated' });
    if (path === '/api/projects/project/scheduled-tasks/daily' && method === 'DELETE') { tasks = tasks.filter(task => task.id !== 'daily'); return ok({ tasks, schedulerSynced: true }); }
    throw new Error(`Unexpected desktop schedule request: ${method} ${path}`);
  } };
}
