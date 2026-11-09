import { fixtureRequest } from './new-session-request.js';

const settingsNavigationIdentity = Object.freeze({
  hostID: 'settings-navigation-production', first: '/fixture/first', project: '/fixture/second',
  actual: '/fixture/second/.worktrees/topic', recent: '/fixture/recent-decoy', sessionID: 'ses_actual',
});

/** Exact in-memory wire for YuriNativeApp. No filesystem, HTTP, process or OS notification access. */
export function createHost(initial = {}) {
  const { hostID, first, project, actual, recent, sessionID } = settingsNavigationIdentity;
  const secondaryID = hostID + '-secondary';
  const connections = [{ id: hostID, label: 'Synthetic settings Host', url: 'https://host.example.invalid', lastUsedAt: 1 }, { id: secondaryID, label: 'Synthetic handoff Host', url: 'https://secondary.example.invalid', lastUsedAt: 0 }];
  const versions = new Map(connections.map(row => [row.id, 'legacy']));
  let selected = initial.selected === undefined ? hostID : initial.selected, leaseRevision = 1, metadataRevision = 0;
  if (selected !== null && !connections.some(row => row.id === selected)) throw new Error('Unknown initial settings navigation Host');
  const lease = () => '00000000-0000-4000-8000-' + String(leaseRevision).padStart(12, '0');
  const runtimeScope = () => selected === null ? null : { hostID: selected, lease: lease() };
  const projects = [{ id: 'first', name: 'First project decoy', path: first }, { id: 'second', name: 'Actual parent project', path: project }];
  const session = { id: sessionID, title: 'Actual worktree conversation', location: { directory: actual }, time: { created: 1, updated: 2 }, execution: { type: 'idle' }, agent: 'build', model: { providerID: 'fixture', id: 'model' } };
  const decoy = { id: 'ses_recent', title: 'Recent directory decoy', location: { directory: recent }, time: { created: 10, updated: 20 } };
  const requests = [], writes = [], rejected = [], configurations = [], nativeCounts = {};
  let appearanceRevision = 0, settingsReads = 0;
  let agentDescription = 'Actual worktree agent', instructions = 'Original worktree instructions', mcpURL = 'https://mcp.example.invalid/original';
  const skillPath = actual + '/.agents/skills/scope-skill/SKILL.md';
  const clone = value => JSON.parse(JSON.stringify(value));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const ok = body => ({ status: 200, body: clone(body) });
  function keys(value, allowed, required = allowed) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.prototype.hasOwnProperty.call(value, key))) throw new Error('Unexpected settings navigation fixture payload');
  }
  const snapshot = () => clone({ connections, selected, runtimeScope: runtimeScope() });
  function expected(input, method) {
    if (selected === null) throw new Error('Missing settings navigation runtime scope');
    if (Object.prototype.hasOwnProperty.call(input, 'expectedHost')) {
      keys(input.expectedHost, ['hostID', 'lease']);
      if (input.expectedHost.hostID !== selected || input.expectedHost.lease !== lease()) throw new Error('Stale settings navigation runtime scope');
    } else if (method !== 'GET') throw new Error('Missing settings navigation expectedHost');
    // The secondary connection models a handoff only; no second Host's domain wire is fabricated.
    if (selected !== hostID) throw new Error('Unexpected settings navigation domain Host');
  }
  function scoped(params, key = 'directory', required = false) {
    const directory = params.get(key);
    if (directory !== undefined && directory !== actual || required && directory !== actual) throw new Error('Unexpected settings navigation directory');
    return directory === actual;
  }
  const scopedAgent = () => ({ name: 'build', description: agentDescription, mode: 'primary' });
  const globalAgent = { name: 'global-agent', description: 'Unscoped user agent', mode: 'primary' };
  const scopedSkill = () => ({ name: 'scope-skill', description: 'Worktree skill', path: skillPath, scope: 'project', source: 'agents' });
  const globalSkill = { name: 'global-skill', description: 'Unscoped user skill', path: '/fixture/home/.agents/skills/global-skill/SKILL.md', scope: 'user', source: 'agents' };
  const scopedMcp = () => ({ name: 'scope-mcp', type: 'remote', url: mcpURL, enabled: true, oauth: false, scope: 'project' });
  const globalMcp = { name: 'global-mcp', type: 'remote', url: 'https://mcp.example.invalid/global', enabled: true, oauth: false, scope: 'user' };
  const audit = () => clone({ requests, writes, rejected, nativeCounts, settingsReads, runtimeScope: runtimeScope(), notification: { configurations, osAuthorization: 'unknown', scheduled: 0 }, agentDescription, instructions, mcpURL });
  return { call(name, input) {
    try {
      if (name === 'settingsNavigation.fixture.audit') { keys(input, []); return audit(); }
      nativeCounts[name] = (nativeCounts[name] || 0) + 1;
      if (name === 'connection.list') { keys(input, []); return snapshot(); }
      if (name === 'connection.select') {
        keys(input, ['id']);
        if (!connections.some(row => row.id === input.id)) throw new Error('Unknown settings navigation selection');
        selected = input.id; leaseRevision++;
        return snapshot();
      }
      if (name === 'connection.rename') {
        keys(input, ['id', 'version', 'label']);
        const row = connections.find(row => row.id === input.id);
        if (!row || input.version !== versions.get(input.id) || typeof input.label !== 'string' || !input.label.trim() || input.label.trim().length > 120 || /[\u0000-\u001f\u007f-\u009f]/.test(input.label)) throw new Error('Invalid settings navigation rename');
        row.label = input.label.trim(); versions.set(row.id, 'synthetic-editor-' + ++metadataRevision);
        return snapshot();
      }
      if (name === 'runtime.stream') {
        keys(input, ['path', 'key', 'expectedHost', 'ownerID', 'mode'], ['path', 'key']);
        if (Object.prototype.hasOwnProperty.call(input, 'expectedHost')) expected(input, 'GET');
        if (!(input.key === 'global' && input.path === '/api/yuri/events') && !(input.key === 'chat' && input.path === '/api/event?directory=' + encodeURIComponent(actual))) throw new Error('Unexpected settings navigation stream');
        return true;
      }
      if (name === 'runtime.stop') {
        keys(input, ['key', 'expectedHost', 'ownerID'], []);
        if (Object.prototype.hasOwnProperty.call(input, 'expectedHost')) expected(input, 'GET');
        if ('key' in input && !['global', 'chat'].includes(input.key)) throw new Error('Unexpected settings navigation stop');
        return true;
      }
      if (name === 'appearance.reset') { keys(input, ['hostID']); if (input.hostID !== null && input.hostID !== hostID) throw new Error('Unexpected appearance Host'); return { revision: ++appearanceRevision }; }
      if (name === 'appearance.apply') {
        keys(input, ['hostID', 'revision', 'mode', 'cssVars', 'fonts']);
        if (input.hostID !== hostID || input.revision !== appearanceRevision || !['system', 'light', 'dark'].includes(input.mode)) throw new Error('Unexpected appearance identity');
        keys(input.cssVars, ['light', 'dark']); keys(input.fonts, ['ui', 'mono', 'assistantLight', 'assistantDark']);
        if (!object(input.cssVars.light) || !object(input.cssVars.dark) || Object.values(input.fonts).some(value => typeof value !== 'string' || !value)) throw new Error('Unexpected appearance values');
        return { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [], systemColorScheme: 'light' };
      }
      if (name === 'notification.configure') {
        keys(input, ['hostID', 'enabled', 'mode', 'events', 'language']);
        if (!settingsReads || input.hostID !== hostID || input.enabled !== false || input.mode !== 'hidden-only' || input.language !== 'en' || JSON.stringify(input.events) !== JSON.stringify(['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'])) throw new Error('Unexpected notification configuration');
        configurations.push(clone(input));
        return { lease: 'settings-navigation-memory-lease' };
      }
      if (name === 'native.diagnostics.status') {
        keys(input, []);
        return { schemaVersion: 2, mode: 'event-recorder', enabled: false, recordingLease: null, eventCount: 0, maxEntries: 500, maxBytes: 256 * 1024 };
      }
      if (['speech.prepare', 'speech.stop', 'speech.release'].includes(name)) {
        keys(input, name === 'speech.stop' ? ['owner', 'revision'] : ['owner']);
        if (typeof input.owner !== 'string' || !/^speech-[0-9]+-[0-9]+$/.test(input.owner) || name === 'speech.stop' && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw new Error('Unexpected speech owner');
        return name === 'speech.prepare' ? { visible: false, provider: 'browser', mode: 'final' } : true;
      }
      if (name !== 'runtime.request') throw new Error('Unexpected settings navigation native call: ' + name);
      keys(input, ['path', 'method', 'body', 'expectedHost'], ['path']);
      if (typeof input.path !== 'string' || input.path.endsWith('?') || input.path.indexOf('?') !== input.path.lastIndexOf('?')) throw new Error('Invalid settings navigation resource');
      const route = fixtureRequest(input), { path, method, params } = route;
      expected(input, method);
      if (method === 'GET' && input.body !== undefined) throw new Error('Unexpected settings navigation GET body');
      requests.push({ path, resource: input.path, method, ...(input.body === undefined ? {} : { body: clone(input.body) }), ...(Object.prototype.hasOwnProperty.call(input, 'expectedHost') ? { expectedHost: clone(input.expectedHost) } : {}) });
      if (path === '/api/config/settings') {
        route.expect('GET'); settingsReads++;
        return ok({ projects, activeProjectId: 'first', lastDirectory: recent, nativeNotificationsEnabled: false, recentModels: [{ providerID: 'decoy', modelID: 'recent' }], sessionGoalEnabled: false });
      }
      if (path === '/api/config/themes') { route.expect('GET'); return ok({ themes: [] }); }
      if (path === '/api/yuri/history-import/jobs') {
        route.expect('GET');
        if (!Object.prototype.hasOwnProperty.call(input, 'expectedHost') || Object.prototype.hasOwnProperty.call(input, 'body')) throw new Error('Unexpected history monitor envelope');
        return ok([]);
      }
      if (path === '/api/yuri/session-index') { route.expect('GET'); return ok({ available: true, directories: [{ directory: first, sessions: [], hasMore: false }, { directory: project, sessions: [], hasMore: false }, { directory: actual, sessions: [session], hasMore: false }, { directory: recent, sessions: [decoy], hasMore: false }], pinnedSessionIds: [] }); }
      if (path === '/api/yuri/assistants/snapshot') { route.expect('GET'); return ok({ assistants: [] }); }
      if (path === '/api/yuri/scheduled-tasks') { route.expect('GET'); return ok({ tasks: [], failedProjectIds: [] }); }
      if (path === '/api/session/active') { route.expect('GET'); return ok({ data: {} }); }
      if (path === '/api/debug/location') { route.expect('GET'); return ok([{ directory: actual }, { directory: first }]); }
      if (path === '/api/form' || path === '/api/permission/request') {
        route.expect('GET', ['directory', 'location[directory]']);
        if (params.size !== 1) throw new Error('Missing blocking Location');
        if (params.has('directory')) scoped(params, 'directory', true);
        else if (![actual, first].includes(params.get('location[directory]'))) throw new Error('Unknown live Location');
        return ok({ data: [] });
      }
      if (path === '/api/session-folders/order') { route.expect('GET'); return ok({ revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} }); }
      if (path === '/api/yuri/message-queue/worktrees/order') {
        route.expect('GET', ['projectDirectory'], ['projectDirectory']);
        if (![first, project].includes(params.get('projectDirectory'))) throw new Error('Unknown parent project');
        return ok({ projectDirectory: params.get('projectDirectory'), revision: 0, orderedPaths: [] });
      }
      if (path === '/api/git/worktrees') {
        route.expect('GET', ['directory'], ['directory']);
        if (![first, project].includes(params.get('directory'))) throw new Error('Unknown worktree project');
        return ok(params.get('directory') === project ? [{ path: actual, name: 'Actual topic worktree', branch: 'topic' }] : []);
      }
      if (path === '/api/git/status') { route.expect('GET', ['directory', 'mode'], ['directory']); scoped(params, 'directory', true); if (params.has('mode') && params.get('mode') !== 'light') throw new Error('Unknown Git mode'); return ok({ isGitRepository: true, isClean: true, current: 'topic', files: [] }); }
      if (path === '/api/session') {
        route.expect('GET', ['directory', 'parentID', 'limit', 'order', 'search'], ['parentID', 'limit', 'order']);
        if (params.get('parentID') !== 'null' || !['20', '30'].includes(params.get('limit'))) throw new Error('Unexpected session page');
        if (params.has('directory')) { scoped(params, 'directory', true); if (params.get('limit') !== '20' || params.has('search')) throw new Error('Unexpected worktree session page'); return ok({ data: [session], cursor: {} }); }
        if (params.get('limit') !== '30') throw new Error('Unexpected global title limit');
        return ok({ data: params.has('search') ? [] : [decoy, session], cursor: {} });
      }
      if (path === '/api/yuri/content-search') { route.expect('GET', ['q', 'limit'], ['q', 'limit']); if (params.get('limit') !== '30') throw new Error('Unexpected content limit'); return ok({ hits: [] }); }
      if (path === '/api/fs/find') {
        route.expect('GET', ['location[directory]', 'query', 'limit', 'type'], ['location[directory]', 'query', 'limit', 'type']);
        scoped(params, 'location[directory]', true);
        if (!params.get('query').trim() || params.get('limit') !== '40' || params.get('type') !== 'file') throw new Error('Unexpected file search');
        return ok({ data: params.get('query') === 'worktree-scope-proof' ? [{ path: 'notes/worktree-scope-proof.txt' }] : [] });
      }
      if (path === '/api/session/' + sessionID) { route.expect('GET', ['directory'], ['directory']); scoped(params, 'directory', true); return ok({ data: session }); }
      if (path === '/api/session/' + sessionID + '/message') { route.expect('GET', ['directory', 'limit', 'order'], ['directory', 'limit', 'order']); scoped(params, 'directory', true); if (params.get('limit') !== '20') throw new Error('Unexpected message page'); return ok({ data: [], cursor: {} }); }
      if (path === '/api/session/' + sessionID + '/inbox' || path === '/api/session/' + sessionID + '/form') { route.expect('GET', ['directory'], ['directory']); scoped(params, 'directory', true); return ok({ data: [] }); }
      if (path === '/api/config/catalog/providers') { route.expect('GET', ['directory'], ['directory']); scoped(params, 'directory', true); return ok({ schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture provider', models: { model: { id: 'model', name: 'Fixture model', limit: { context: 128000 } } } }] }); }
      if (path === '/api/agent') { route.expect('GET', ['location[directory]']); return ok({ data: [scoped(params, 'location[directory]') ? scopedAgent() : globalAgent] }); }
      if (path === '/api/config/agents/metadata') {
        route.expect('POST', ['directory']); keys(input.body, ['names']); const local = scoped(params), name = local ? 'build' : 'global-agent';
        if (JSON.stringify(input.body.names) !== JSON.stringify([name])) throw new Error('Unexpected agent metadata names');
        return ok({ agents: { [name]: { scope: local ? 'project' : 'user', isBuiltIn: false, sources: {} } } });
      }
      if (path === '/api/config/agents/build/config' || path === '/api/config/agents/global-agent/config') {
        route.expect('GET', ['directory']); const local = scoped(params);
        if ((path === '/api/config/agents/build/config') !== local) throw new Error('Agent identity escaped scope');
        return ok({ config: { prompt: local ? 'Actual worktree prompt' : 'Global user prompt' } });
      }
      if (path === '/api/location') { route.expect('GET', ['location[directory]'], ['location[directory]']); scoped(params, 'location[directory]', true); return ok({ project: { id: 'second' }, directory: actual }); }
      if (path === '/api/permission/saved') { route.expect('GET', ['projectID'], ['projectID']); if (params.get('projectID') !== 'second') throw new Error('Wrong permission project'); return ok({ data: [] }); }
      if (path === '/api/config/skills') { route.expect('GET', ['summary', 'directory'], ['summary']); if (params.get('summary') !== 'true') throw new Error('Unexpected skill summary'); return ok({ skills: [scoped(params) ? scopedSkill() : globalSkill] }); }
      if (path === '/api/config/skills/scope-skill' && method === 'GET' || path === '/api/config/skills/global-skill') {
        route.expect('GET', ['directory']); const local = scoped(params), row = local ? scopedSkill() : globalSkill;
        if (path !== '/api/config/skills/' + row.name) throw new Error('Skill identity escaped scope');
        return ok({ name: row.name, scope: row.scope, source: 'agents', exists: true, sources: { md: { ...row, exists: true, instructions: local ? instructions : 'Global instructions', supportingFiles: [] } } });
      }
      if (path === '/api/config/mcp') { route.expect('GET', ['directory']); return ok([scoped(params) ? scopedMcp() : globalMcp]); }
      if (path === '/api/mcp') { route.expect('GET', ['location[directory]']); const local = scoped(params, 'location[directory]'); return ok({ data: [{ name: local ? 'scope-mcp' : 'global-mcp', status: { status: 'connected' } }] }); }
      if (['/api/config/agents/build', '/api/config/skills/scope-skill', '/api/config/mcp/scope-mcp'].includes(path)) {
        route.expect('PATCH', ['directory'], ['directory']); scoped(params, 'directory', true);
        if (path === '/api/config/agents/build') {
          keys(input.body, ['native', 'scope']); keys(input.body.native, ['description']);
          if (input.body.scope !== 'project' || input.body.native.description !== 'Saved in actual worktree') throw new Error('Unexpected agent patch');
          agentDescription = input.body.native.description;
        } else if (path === '/api/config/skills/scope-skill') {
          keys(input.body, ['instructions', 'targetPath']);
          if (input.body.instructions !== 'Actual worktree instructions edited' || input.body.targetPath !== skillPath) throw new Error('Unexpected skill patch');
          instructions = input.body.instructions;
        } else {
          keys(input.body, ['url', 'scope']);
          if (input.body.scope !== 'project' || input.body.url !== 'https://mcp.example.invalid/edited') throw new Error('Unexpected MCP patch: ' + JSON.stringify({ fields: Object.keys(input.body).sort(), scope: input.body.scope, url: input.body.url }));
          mcpURL = input.body.url;
        }
        writes.push({ path, directory: actual, body: clone(input.body) });
        return ok({ success: true, requiresReload: false, application: 'watch' });
      }
      throw new Error('Unexpected settings navigation request: ' + method + ' ' + input.path);
    } catch (error) {
      rejected.push({ name, resource: typeof input?.path === 'string' ? input.path : null, message: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  } };
}
