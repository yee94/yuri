/** Read-only domain data, with no second Host/lease authority or native call router. */
export function quotaProductionRead(route, actual) {
  const { path, params } = route;
  const first = '/fixture/first', project = '/fixture/second', recent = '/fixture/recent-decoy';
  const projects = [{ id: 'first', name: 'First project decoy', path: first }, { id: 'second', name: 'Actual parent project', path: project }];
  const session = { id: 'ses_actual', title: 'Actual worktree conversation', location: { directory: actual }, time: { created: 1, updated: 2 }, execution: { type: 'idle' }, agent: 'build', model: { providerID: 'fixture', id: 'model' } };
  const decoy = { id: 'ses_recent', title: 'Recent directory decoy', location: { directory: recent }, time: { created: 10, updated: 20 } };
  const exact = (key = 'directory') => { if (params.get(key) !== actual) throw new Error('Unexpected quota production read directory'); };
  if (path === '/api/config/settings') { route.expect('GET'); return { projects, activeProjectId: 'first', lastDirectory: recent, nativeNotificationsEnabled: false, recentModels: [{ providerID: 'decoy', modelID: 'recent' }], sessionGoalEnabled: false }; }
  if (path === '/api/config/themes') { route.expect('GET'); return { themes: [] }; }
  if (path === '/api/yuri/session-index') { route.expect('GET'); return { available: true, directories: [{ directory: first, sessions: [], hasMore: false }, { directory: project, sessions: [], hasMore: false }, { directory: actual, sessions: [session], hasMore: false }, { directory: recent, sessions: [decoy], hasMore: false }], pinnedSessionIds: [] }; }
  if (path === '/api/yuri/assistants/snapshot') { route.expect('GET'); return { assistants: [] }; }
  if (path === '/api/yuri/scheduled-tasks') { route.expect('GET'); return { tasks: [], failedProjectIds: [] }; }
  if (path === '/api/session/active') { route.expect('GET'); return { data: {} }; }
  if (path === '/api/debug/location') { route.expect('GET'); return [{ directory: actual }, { directory: first }]; }
  if (path === '/api/form' || path === '/api/permission/request') {
    route.expect('GET', ['directory', 'location[directory]']);
    if (params.size !== 1) throw new Error('Missing quota production blocking Location');
    if (params.has('directory')) exact();
    else if (![actual, first].includes(params.get('location[directory]'))) throw new Error('Unknown quota production live Location');
    return { data: [] };
  }
  if (path === '/api/session-folders/order') { route.expect('GET'); return { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} }; }
  if (path === '/api/yuri/message-queue/worktrees/order') {
    route.expect('GET', ['projectDirectory'], ['projectDirectory']);
    if (![first, project].includes(params.get('projectDirectory'))) throw new Error('Unknown quota production parent project');
    return { projectDirectory: params.get('projectDirectory'), revision: 0, orderedPaths: [] };
  }
  if (path === '/api/git/worktrees') {
    route.expect('GET', ['directory'], ['directory']);
    if (![first, project].includes(params.get('directory'))) throw new Error('Unknown quota production worktree project');
    return params.get('directory') === project ? [{ path: actual, name: 'Actual topic worktree', branch: 'topic' }] : [];
  }
  if (path === '/api/git/status') { route.expect('GET', ['directory', 'mode'], ['directory']); exact(); if (params.has('mode') && params.get('mode') !== 'light') throw new Error('Unknown quota production Git mode'); return { isGitRepository: true, isClean: true, current: 'topic', files: [] }; }
  if (path === '/api/session') {
    route.expect('GET', ['directory', 'parentID', 'limit', 'order', 'search'], ['parentID', 'limit', 'order']);
    if (params.get('parentID') !== 'null' || !['20', '30'].includes(params.get('limit'))) throw new Error('Unexpected quota production session page');
    if (params.has('directory')) { exact(); if (params.get('limit') !== '20' || params.has('search')) throw new Error('Unexpected quota production worktree page'); return { data: [session], cursor: {} }; }
    if (params.get('limit') !== '30') throw new Error('Unexpected quota production title limit');
    return { data: params.has('search') ? [] : [decoy, session], cursor: {} };
  }
  if (path === '/api/yuri/content-search') { route.expect('GET', ['q', 'limit'], ['q', 'limit']); if (params.get('limit') !== '30') throw new Error('Unexpected quota production content limit'); return { hits: [] }; }
  if (path === '/api/fs/find') { route.expect('GET', ['location[directory]', 'query', 'limit', 'type'], ['location[directory]', 'query', 'limit', 'type']); exact('location[directory]'); if (!params.get('query').trim() || params.get('limit') !== '40' || params.get('type') !== 'file') throw new Error('Unexpected quota production file search'); return { data: [] }; }
  if (path === '/api/session/ses_actual') { route.expect('GET', ['directory'], ['directory']); exact(); return { data: session }; }
  if (path === '/api/session/ses_actual/message') { route.expect('GET', ['directory', 'limit', 'order'], ['directory', 'limit', 'order']); exact(); if (params.get('limit') !== '20') throw new Error('Unexpected quota production message page'); return { data: [], cursor: {} }; }
  if (path === '/api/session/ses_actual/inbox' || path === '/api/session/ses_actual/form') { route.expect('GET', ['directory'], ['directory']); exact(); return { data: [] }; }
  if (path === '/api/agent') { route.expect('GET', ['location[directory]']); if (params.has('location[directory]')) exact('location[directory]'); return { data: [{ name: params.has('location[directory]') ? 'build' : 'global-agent', description: 'Synthetic quota agent', mode: 'primary' }] }; }
  throw new Error('Unexpected quota production read');
}
