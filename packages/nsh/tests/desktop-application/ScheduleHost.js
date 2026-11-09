import { createHost } from './host.js';
import { desktopJournalMethods } from '../desktop-journal-host.js';

/** Strict synthetic schedules over the production-root Host. No real writes. */
export function createScheduleHost() {
  const base = createHost(), writes = [], rejected = [];
  let mode = 'ack';
  let tasks = ['alpha', 'beta'].map(id => ({ projectId: 'desktop-project', task: {
    id, name: 'Schedule ' + id, enabled: true,
    schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' },
    execution: { prompt: 'Full schedule prompt ' + id, providerID: 'fixture', modelID: 'model', agent: 'build', variant: '', goalEnabled: false },
    state: { lastStatus: 'success', lastRunAt: 1, nextRunAt: 2 },
  } }));
  const ok = body => ({ status: 200, body });
  const names = [...desktopJournalMethods, ...Object.keys(base.writer.handlers), 'appearance.reset', 'appearance.apply', 'native.diagnostics.status', 'notification.status', 'notification.launch.peek', 'connection.list', 'runtime.stream', 'runtime.stop', 'runtime.request', 'desktop.window.closeDecision'];
  const handlers = Object.fromEntries(names.map(name => [name, input => {
    if (name === 'desktop.window.closeDecision' && input.approved) throw new Error('Synthetic expired native ticket');
    if (name === 'runtime.request') {
      const path = input.path.split('?')[0];
      if (path === '/api/yuri/scheduled-tasks' && input.method === 'GET') return ok({ tasks, failedProjectIds: [] });
      if (path === '/api/yuri/scheduled-task-runs' && input.method === 'GET') return ok({ runs: [], complete: true, nextCursor: null });
      if (path === '/api/projects/desktop-project/scheduled-tasks' && input.method === 'GET') return ok({ tasks: tasks.map(item => item.task) });
      if (path === '/api/projects/desktop-project/scheduled-tasks' && input.method === 'PATCH') {
        if (JSON.stringify(input.expectedHost) !== JSON.stringify({ hostID: 'desktop-fixture', lease: 'desktop-fixture-lease-0' })) throw new Error('Wrong schedule authority');
        const task = input.body?.task;
        if (!task || !tasks.some(item => item.task.id === task.id)) throw new Error('Wrong schedule target');
        writes.push(input);
        if (mode === 'pending') return new Promise(() => {});
        if (mode === 'unknown') throw new Error('Synthetic lost schedule ACK');
        tasks = tasks.map(item => item.task.id === task.id ? { ...item, task } : item);
        return ok({ task, schedulerSynced: mode !== 'unsynced' });
      }
      if (input.method !== 'GET' && path !== '/api/config/commands/metadata') { rejected.push(input); throw new Error('Unexpected schedule mutation'); }
    }
    return base.call(name, input);
  }]));
  return { handlers, writes, rejected, mode: value => { mode = value; } };
}
