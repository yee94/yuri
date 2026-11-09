export function createHost() {
  let writes = 0;
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'task-fixture', connections: [{ id: 'task-fixture', label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 }], runtimeScope: { hostID: 'task-fixture', lease: 'synthetic-mobile-task-editor' } };
    if (name !== 'runtime.request' || !input || typeof input.path !== 'string') throw new Error('Unexpected task bridge');
    // Self-contained NSH Host: no URL/URLSearchParams, Node APIs or imported modules.
    const pieces = input.path.split('?'), path = pieces[0], query = Object.create(null);
    if (pieces.length > 2 || !/^\/api\/[a-zA-Z0-9_./-]+$/.test(path) || path.includes('//') || path.split('/').some(part => part === '.' || part === '..')) throw new Error('Invalid task fixture path');
    if (pieces.length === 2) {
      if (!pieces[1]) throw new Error('Empty task query');
      for (const part of pieces[1].split('&')) {
        const equals = part.indexOf('='); if (equals < 1) throw new Error('Invalid task query');
        const key = decodeURIComponent(part.slice(0, equals).replace(/\+/g, ' '));
        if (Object.prototype.hasOwnProperty.call(query, key)) throw new Error('Duplicate task query');
        query[key] = decodeURIComponent(part.slice(equals + 1).replace(/\+/g, ' '));
      }
    }
    const directory = query.directory || query['location[directory]'];
    const assertQuery = keys => { if (Object.keys(query).length !== keys.length || keys.some(key => !(key in query))) throw new Error('Wrong task query'); };
    const inScope = () => { if (!['/actual/worktree', '/other'].includes(directory)) throw new Error('Wrong task directory ' + directory); };
    const reply = body => ({ status: 200, body });
    if (path === '/api/config/catalog/providers' && input.method === 'GET') {
      assertQuery(['directory']); inScope();
      return reply({ schemaVersion: 1, providers: [{ id: 'actual-provider', name: 'Actual provider', models: { 'actual-model': { id: 'actual-model', name: 'Actual model', variants: { high: {} } } } }] });
    }
    if (path === '/api/agent' && input.method === 'GET') {
      assertQuery(['location[directory]']); inScope();
      return reply({ data: [{ name: 'plan', mode: 'primary' }, { name: 'general', mode: 'subagent', description: 'General work' }, { name: 'hidden', hidden: true }] });
    }
    if (path === '/api/config/commands/metadata' && input.method === 'POST') {
      assertQuery(['directory']); inScope();
      if (!input.body || input.body.catalog !== true || Object.keys(input.body).length !== 1) throw new Error('Not a compact command read');
      return reply({ commands: [{ name: 'check', description: 'Check the current project', scope: 'project', source: 'opencode' }] });
    }
    if (path === '/api/config/skills' && input.method === 'GET') {
      assertQuery(['summary', 'directory']); inScope(); if (query.summary !== 'true') throw new Error('Summary required');
      return reply({ skills: [{ name: 'generate', description: 'Generate files', scope: 'user' }] });
    }
    if (path === '/api/fs/find' && input.method === 'GET') {
      assertQuery(['location[directory]', 'query', 'type', 'limit']); inScope();
      if (query.type !== 'file' && query.type !== 'directory') throw new Error('Wrong path domain');
      return reply({ data: query.type === 'file' ? [{ type: 'file', path: directory + '/src/main.ts' }] : [] });
    }
    if (/^\/api\/projects\/(actual|other)\/scheduled-tasks$/.test(path) && input.method === 'PUT') {
      assertQuery([]); const task = input.body && input.body.task;
      if (!task || !task.id || task.execution.providerID !== 'actual-provider' || task.execution.modelID !== 'actual-model' || task.execution.variant !== 'high' || task.execution.agent !== 'plan') throw new Error('Wrong captured task tuple');
      if (++writes === 1) return { status: 409, body: { error: 'Fixture task save failed; draft retained' } };
      return reply({ task, schedulerSynced: true });
    }
    assertQuery([]);
    if (input.method !== 'GET') throw new Error('Fixture forbids mutation ' + path);
    if (path === '/api/config/settings') return reply({ projects: [] });
    if (path === '/api/yuri/session-index') return reply({ available: true, directories: [] });
    if (path === '/api/yuri/assistants/snapshot') return reply({ assistants: [] });
    if (path === '/api/yuri/scheduled-tasks') return reply({ tasks: [], failedProjectIds: [] });
    throw new Error('Unexpected task wire ' + input.method + ' ' + path);
  } };
}
