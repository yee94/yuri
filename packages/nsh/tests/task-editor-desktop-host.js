/** Synthetic TaskEditor Host. No real configuration, provider, native window or task execution. */
export function createHost() {
  const requests = [];
  const task = id => ({ id, name: `Task ${id}`, enabled: true, schedule: { kind: 'daily', times: ['09:00', '18:30'], timezone: 'UTC' }, execution: { prompt: 'Existing full prompt', providerID: 'provider', modelID: 'model', agent: 'build', variant: 'high', goalEnabled: true } });
  let tasks = [task('a'), task('b')], mode = 'normal', release;
  const ok = body => ({ status: 200, body });
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'task-host', connections: [{ id: 'task-host', url: 'https://host.example', label: 'Synthetic', lastUsedAt: 0 }], runtimeScope: { hostID: 'task-host', lease: 'synthetic-editor-lease' } };
    if (name !== 'runtime.request') throw new Error(`Unexpected fixture native call ${name}`);
    const { path, method, body } = input; requests.push({ path, method, body });
    if (path === '/fixture/audit') return ok(requests);
    if (path.startsWith('/fixture/')) { mode = path.slice(9); if (mode === 'release') { release?.(); release = undefined; mode = 'normal'; } return ok({}); }
    if (path.startsWith('/api/config/catalog/providers')) return ok({ schemaVersion: 1, providers: [{ id: 'provider', name: 'Provider', models: { model: { id: 'model', name: 'Model', variants: { high: {}, low: {} } }, other: { id: 'other', name: 'Other model', variants: {} } } }] });
    if (path.startsWith('/api/agent')) return ok([{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }, { name: 'hidden-sub', mode: 'subagent' }]);
    if (path === '/api/config/settings') return ok({ projects: [{ id: 'project', path: '/workspace/project', name: 'Project' }, { id: 'other', path: '/workspace/other', name: 'Other project' }] });
    if (path === '/api/yuri/session-index') return ok({ available: true, directories: [], complete: true });
    if (path === '/api/yuri/assistants/snapshot') return ok({ enabled: true, revision: 1, assistants: [] });
    if (path === '/api/yuri/scheduled-tasks') return ok({ tasks: tasks.map(task => ({ projectId: 'project', task })), failedProjectIds: [] });
    if (path.startsWith('/api/config/commands')) return ok({ commands: [] });
    if (path.startsWith('/api/command')) return ok([]);
    if (path.startsWith('/api/config/skills')) return ok({ skills: [] });
    if (path.startsWith('/api/find/file')) return ok([]);
    if (path === '/api/projects/project/scheduled-tasks' && method === 'GET') return ok({ tasks });
    if (path.startsWith('/api/projects/project/scheduled-tasks') && method !== 'GET') {
      if (mode === 'refuse') { mode = 'normal'; return { status: 409, body: { error: 'synthetic_task_refused' } }; }
      const next = body?.task, id = next?.id || path.split('/')[5], previous = tasks.find(task => task.id === id);
      const apply = () => {
        if (method === 'DELETE') { tasks = tasks.filter(task => task.id !== id); return ok({ tasks, schedulerSynced: mode !== 'unsynced' }); }
        if (path.endsWith('/run')) return ok({ ok: true, task: previous, sessionId: 'synthetic-run' });
        const saved = { ...previous, ...next };
        if (next?.execution) { saved.execution = { ...next.execution }; if (!saved.execution.variant) delete saved.execution.variant; if (!saved.execution.agent) delete saved.execution.agent; if (saved.execution.goalEnabled !== true) delete saved.execution.goalEnabled; }
        tasks = [...tasks.filter(task => task.id !== id), saved]; return ok({ task: saved, tasks, schedulerSynced: mode !== 'unsynced' });
      };
      if (mode === 'pending') return new Promise(resolve => { release = () => resolve(apply()); });
      if (mode === 'missing') return { status: 500, body: { error: 'synthetic_unknown_not_applied' } };
      const response = apply();
      if (mode === 'unknown') return { status: 500, body: { error: 'synthetic_ack_lost' } };
      return response;
    }
    throw new Error(`Unexpected editor request ${method} ${path}`);
  } };
}
