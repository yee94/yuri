/** Import-free NSH fixture Host. All resources and writes are private in-memory data. */
export function createHost() {
  const clone = value => JSON.parse(JSON.stringify(value));
  const connection = { id: 'features-memory', label: 'Memory fixture', url: 'https://features-memory.invalid', lastUsedAt: 1 };
  const runtimeScope = { hostID: connection.id, lease: 'features-memory-lease' };
  const project = { id: 'project', path: '/first-project', name: 'Fixture project' };
  let settings = { projects: [project], defaultModel: 'fixture/model', defaultVariant: '', favoriteModels: [], recentModels: [], hiddenModels: [], providerOrder: [], timeFormatPreference: '12h', weekStartPreference: 'monday', useSystemTheme: true, lightThemeId: 'jetbrains-light', darkThemeId: 'jetbrains-dark', uiFont: 'system', monoFont: 'system-mono', fontSize: 100 };
  let bots = [{ id: 'bot', revision: 1, name: 'Memory Bot', defaultPrompt: 'Saved prompt', workspacePath: null, managedWorkspacePath: '/managed', providerID: 'fixture', modelID: 'model', variant: null, agent: 'preserve', mode: 'continuous' }];
  let tasks = [{ id: 'task', name: 'Memory task', enabled: true, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { providerID: 'fixture', modelID: 'model', prompt: 'Saved prompt', agent: 'build', goalEnabled: false }, state: { createdAt: 1, updatedAt: 1, lastStatus: 'idle' } }];
  const requests = [], runs = [1, 2, 3].map(index => ({ id: `memory-history-${index}`, projectId: 'project', taskId: 'task', taskName: 'Memory task', trigger: 'manual', status: 'success', sessionId: `memory-history-session-${index}`, directory: project.path, error: null, startedAt: 1700000000000 - index * 1000, finishedAt: 1700000000100 - index * 1000, durationMs: 100 }));
  let auditSequence = 0;
  let appearanceRevision = 0;
  let lose = '', failRead = '', sequence = 1;
  const providers = [{ id: 'fixture', name: 'Fixture provider', models: { model: { id: 'model', name: 'Fixture model', variants: Object.fromEntries(['low', 'medium', 'high', 'max', 'xhigh', 'a', 'b', 'c', 'd'].map(key => [key, {}])), limit: { context: 128000 }, capabilities: { toolcall: true, reasoning: true, input: { text: true, image: true } } } } }];
  const result = (body, status = 200) => ({ status, body: clone(body) });
  function request(input) {
    const { path, method = 'GET', body, expectedHost } = input;
    if (!/^\/api\//.test(path) || expectedHost?.hostID !== runtimeScope.hostID || expectedHost?.lease !== runtimeScope.lease) throw new Error('Memory fixture lease required');
    requests.push({ path, method });
    if (method === 'GET' && path === failRead) { failRead = ''; return result({ error: 'fixture read failed' }, 503); }
    let response;
    if (method === 'GET') {
      if (path === '/api/config/settings') response = settings;
      else if (path === '/api/config/themes') response = { themes: [] };
      else if (path === '/api/config/settings/bootstrap') response = { schemaVersion: 1, ...settings };
      else if (path === '/api/config' || path === '/api/config?location%5Bdirectory%5D=%2Ffirst-project') response = [];
      else if (['/api/config/catalog/providers', '/api/config/catalog/providers?directory=%2Fmanaged', '/api/config/catalog/providers?directory=%2Ffirst-project'].includes(path)) response = { schemaVersion: 1, providers };
      else if (path === '/api/agent?location%5Bdirectory%5D=%2Ffirst-project') response = { data: [{ id: 'build', name: 'build', mode: 'primary' }] };
      else if (path === '/api/yuri/assistants/capability') response = { supported: true, enabled: true };
      else if (path === '/api/yuri/assistants/snapshot') response = { assistants: bots, revision: sequence, enabled: true };
      else if (path === '/api/projects/project/scheduled-tasks') response = { tasks };
      else if (path === '/api/yuri/scheduled-tasks') response = { tasks: tasks.map(task => ({ projectId: 'project', task })), failedProjectIds: [] };
      else if (path === '/api/yuri/session-index') response = { available: true, directories: [{ directory: project.path, sessions: [] }] };
      else if (path.startsWith('/api/yuri/scheduled-task-runs?')) {
        const values = Object.fromEntries(path.split('?')[1].split('&').map(pair => pair.split('=').map(decodeURIComponent)));
        if (values.projectId !== 'project' || !tasks.some(task => task.id === values.taskId) || values.limit !== '20' || Object.keys(values).some(key => !['projectId', 'taskId', 'limit', 'before'].includes(key))) throw new Error('Unknown fixture history scope');
        const all = runs.filter(run => run.taskId === values.taskId), offset = values.before === undefined ? 0 : values.before === 'memory-opaque-next' ? 2 : -1;
        if (offset < 0) throw new Error('Unknown fixture cursor');
        response = { runs: all.slice(offset, offset + 2), nextCursor: all.length > offset + 2 ? 'memory-opaque-next' : null, complete: all.length <= offset + 2 };
      } else throw new Error(`Unknown memory GET ${path}`);
    } else if (path === '/api/config/settings' && method === 'PUT') {
      if (!body || Object.keys(body).some(key => !['favoriteModels', 'recentModels'].includes(key))) throw new Error('Unknown memory preference');
      settings = { ...settings, ...clone(body) }; response = { ok: true };
    } else if (path === '/api/yuri/assistants' && method === 'POST') {
      if (!body?.name || !body.providerID || !body.modelID || 'agent' in body || 'mode' in body) return result({ error: 'invalid Bot' }, 400);
      const bot = { ...clone(body), id: `memory-bot-${++sequence}`, revision: 1, managedWorkspacePath: '/managed' }; bots.push(bot); response = bot;
    } else if (/^\/api\/yuri\/assistants\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split('/').at(-1)), bot = bots.find(bot => bot.id === id);
      if (!bot) return result({ error: 'missing Bot' }, 404);
      if (body?.expectedRevision !== bot.revision) return result({ error: 'revision conflict' }, 409);
      if (method === 'DELETE') { bots = bots.filter(bot => bot.id !== id); response = { assistantID: id, tombstoneAt: ++sequence }; }
      else if (method === 'PATCH' && !('agent' in body) && !('mode' in body)) { Object.assign(bot, clone(body), { revision: bot.revision + 1 }); delete bot.expectedRevision; response = bot; }
      else throw new Error('Unknown memory Bot write');
    } else if (path === '/api/projects/project/scheduled-tasks' && ['PUT', 'PATCH'].includes(method)) {
      const value = body?.task;
      if (!value?.id) return result({ error: 'missing task' }, 400);
      const existing = tasks.find(task => task.id === value.id);
      if (method === 'PATCH' && !existing) return result({ error: 'missing task' }, 404);
      const task = { ...existing, ...clone(value), state: existing?.state ?? { createdAt: ++sequence, updatedAt: sequence, lastStatus: 'idle' } };
      tasks = existing ? tasks.map(row => row.id === task.id ? task : row) : [...tasks, task]; response = { task, tasks, schedulerSynced: true };
    } else if (/^\/api\/projects\/project\/scheduled-tasks\/[^/]+(?:\/run)?$/.test(path)) {
      const parts = path.split('/'), id = decodeURIComponent(parts[5]), task = tasks.find(task => task.id === id);
      if (!task) return result({ error: 'missing task' }, 404);
      if (method === 'DELETE' && parts.length === 6) { tasks = tasks.filter(task => task.id !== id); response = { tasks, schedulerSynced: true }; }
      else if (method === 'POST' && parts[6] === 'run') {
        const at = 1800000000000 + ++sequence, sessionId = `memory-session-${sequence}`;
        task.state = { ...task.state, lastStatus: 'success', lastRunAt: at, lastSessionId: sessionId };
        runs.unshift({ id: `memory-run-${sequence}`, projectId: 'project', taskId: id, taskName: task.name, trigger: 'manual', status: 'success', sessionId, directory: project.path, error: null, startedAt: at, finishedAt: at + 100, durationMs: 100 });
        response = { ok: true, task, sessionId };
      } else throw new Error('Unknown memory task action');
    } else throw new Error(`Unknown memory write ${method} ${path}`);
    if (lose === `${method} ${path}`) { lose = ''; throw new Error('fixture ACK lost'); }
    return result(response);
  }
  return { call(name, input = {}) {
    if (name === 'features.fixture.identity') return 'features-memory-only';
    if (name === 'appearance.reset') {
      if (Object.keys(input).join(',') !== 'hostID' || input.hostID !== null && input.hostID !== connection.id) throw new Error('Unsafe memory appearance reset');
      return { revision: ++appearanceRevision };
    }
    if (name === 'appearance.apply') {
      if (Object.keys(input).sort().join(',') !== 'cssVars,fonts,hostID,mode,revision' || input.hostID !== connection.id || appearanceRevision < 1 || input.revision !== appearanceRevision || input.mode !== 'system' ||
        Object.keys(input.cssVars ?? {}).sort().join(',') !== 'dark,light' ||
        Object.keys(input.fonts ?? {}).sort().join(',') !== 'assistantDark,assistantLight,mono,ui' ||
        input.fonts.ui !== 'system-ui' || input.fonts.mono !== 'monospace' || input.fonts.assistantLight !== 'JetBrains Mono' || input.fonts.assistantDark !== 'JetBrains Mono') throw new Error('Unsafe memory appearance apply');
      return { uiFontFamily: input.fonts.ui, monoFontFamily: input.fonts.mono, assistantFontFamilies: { light: input.fonts.assistantLight, dark: input.fonts.assistantDark }, unsupportedFonts: [], systemColorScheme: 'dark' };
    }
    if (name === 'connection.list') return clone({ connections: [connection], selected: connection.id, runtimeScope });
    if (name === 'features.fixture.configure') { lose = input.lose ?? ''; failRead = input.failRead ?? ''; return true; }
    if (name === 'features.fixture.audit') return clone({ auditSequence: ++auditSequence, requests, bots, tasks, runs, settings });
    if (name === 'runtime.request') return request(input);
    throw new Error(`Unknown memory capability ${name}`);
  } };
}
