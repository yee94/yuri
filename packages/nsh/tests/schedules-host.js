import { settingsEngineFixtureScope } from './settings-engine-fixture-scope.js';
import { fixtureRequest } from './new-session-request.js';
/** Scheduled-task native engine fixture; never loaded by the production Host. */
export function createHost() {
  const scope = settingsEngineFixtureScope('schedule-host');
  let requests = 0, toggles = 0, runs = 0, deletes = 0, auditReads = 0;
  const makeTask = (id, name, enabled) => ({
    id, name, enabled,
    schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
    execution: { prompt: 'Inspect native scheduled task history', providerID: 'test', modelID: 'native-model', agent: 'build', variant: 'high' },
    state: { lastStatus: 'success', lastRunAt: 1700000000000, nextRunAt: Date.now() + 7200000 },
  });
  let tasks = [makeTask('daily', 'Native daily schedule', true), makeTask('paused', 'Native paused schedule', false)];
  const run = id => ({ id, projectId: 'project', taskId: 'daily', taskName: `Native history ${id}`, trigger: 'manual', status: 'success', sessionId: `session-${id}`, directory: '/workspace/recorded-worktree', error: null, startedAt: 1700000000000, finishedAt: 1700000005000, durationMs: 5000 });
  return { call(name, input) {
    if (name === 'connection.list') return scope.connection(input);
    if (name === 'settings.fixture.scope') return scope.control(input);
    if (name === 'settings.fixture.scopeAudit') return scope.audit(input);
    if (name !== 'runtime.request') throw new Error(`Unexpected native call: ${name}`);
    scope.admit(input);
    const route = fixtureRequest(input), { path, method, params } = route, { body } = input;
    if ((method === 'GET' || method === 'DELETE') && body !== undefined) throw new Error('Unexpected scheduled fixture body');
    if (path === '/fixture/schedules/audit') { route.expect('GET'); return { status: 200, body: { requests, toggles, runs, deletes, auditReads: ++auditReads } }; }
    requests++;
    if (path === '/api/yuri/scheduled-tasks') { route.expect('GET'); return { status: 200, body: { tasks: tasks.map(task => ({ projectId: 'project', task })), failedProjectIds: [] } }; }
    if (path === '/api/yuri/scheduled-task-runs') {
      route.expect('GET', ['limit', 'before', 'projectId', 'taskId'], ['limit']);
      if (params.get('limit') !== '20' || params.has('before') && params.get('before') !== 'opaque+/='
        || params.has('projectId') !== params.has('taskId') || params.has('projectId') && (params.get('projectId') !== 'project' || params.get('taskId') !== 'daily')) throw new Error('Invalid scheduled history scope/cursor');
      const older = params.has('before');
      return { status: 200, body: { runs: [run(older ? 'older' : 'newest')], nextCursor: older ? null : 'opaque+/=', complete: older } };
    }
    if (path === '/api/projects/project/scheduled-tasks' && method === 'PATCH') {
      route.expect('PATCH');
      if (!body || Object.keys(body).join(',') !== 'task' || !body.task || Object.keys(body.task).sort().join(',') !== 'enabled,id'
        || body.task.id !== 'daily' || typeof body.task.enabled !== 'boolean' || !tasks.some(task => task.id === body.task.id && task.enabled !== body.task.enabled)) throw new Error('Invalid scheduled toggle payload');
      toggles++;
      tasks = tasks.map(task => task.id === body.task.id ? { ...task, enabled: body.task.enabled } : task);
      return { status: 200, body: { tasks, task: tasks.find(task => task.id === body.task.id), schedulerSynced: true } };
    }
    if (path === '/api/projects/project/scheduled-tasks/daily/run' && method === 'POST') {
      route.expect('POST'); if (body !== undefined || !tasks.some(task => task.id === 'daily' && task.enabled)) throw new Error('Invalid scheduled run payload');
      runs++; return { status: 200, body: { ok: true, task: tasks.find(task => task.id === 'daily'), sessionId: 'newly-started' } };
    }
    if (path === '/api/projects/project/scheduled-tasks/daily' && method === 'DELETE') {
      route.expect('DELETE'); if (!tasks.some(task => task.id === 'daily')) throw new Error('Repeated scheduled deletion'); deletes++;
      tasks = tasks.filter(task => task.id !== 'daily');
      return { status: 200, body: { tasks, schedulerSynced: true } };
    }
    throw new Error(`Unexpected scheduled request: ${method} ${path}`);
  } };
}
