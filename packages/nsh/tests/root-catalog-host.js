import { projectsFixtureAuthority } from './projects-fixture-authority.js';

/** An isolated synthetic server; no production connection, files or credentials. */
export function createHost() {
  const authority = projectsFixtureAuthority('catalog-fixture');
  let healthy = false;
  const row = id => ({ id, title: id, time: { updated: 10 } });
  return { call(name, input) {
    if (name === 'connection.list') return authority.snapshot();
    if (name !== 'runtime.request') throw new Error('Unexpected catalog fixture call');
    authority.accept(input);
    const path = input.path;
    if (path === '/fixture/healthy' && input.method === 'POST') { healthy = true; return { status: 200, body: true }; }
    if ((input.method || 'GET') !== 'GET' || input.body !== undefined) throw new Error('Unexpected catalog fixture mutation');
    let body;
    if (path === '/api/config/settings') body = { projects: [{ id: 'good-project', path: '/repo', name: 'Complete directory' }, { id: 'failed-project', path: '/failed', name: 'Isolated failed directory' }] };
    else if (path === '/api/yuri/session-index') body = { available: true, directories: [
      { directory: '/repo', sessions: [row('good-session')], hasMore: false },
      { directory: '/failed', sessions: healthy ? [] : [row('failed-seed')], hasMore: false },
    ], sync: { active: false, completed: healthy ? 2 : 1, total: 2, pendingDirectories: [], completedDirectories: healthy ? ['/repo', '/failed'] : ['/repo'], failedDirectories: healthy ? [] : ['/failed'] } };
    else if (path === '/api/yuri/assistants/snapshot') body = { assistants: [] };
    else if (path === '/api/yuri/scheduled-tasks') body = { tasks: [] };
    else if (path === '/api/debug/location') body = [{ directory: '/repo' }, { directory: '/failed' }];
    else if (path.startsWith('/api/form?') || path.startsWith('/api/permission/request?')) body = { data: [] };
    else if (path === '/api/session-folders/order') body = { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} };
    else if (path === '/api/session/active') body = {};
    else if (path.startsWith('/api/git/worktrees')) body = [];
    else if (path.startsWith('/api/yuri/message-queue/worktrees/order')) body = { projectDirectory: decodeURIComponent(path.match(/[?&]projectDirectory=([^&]*)/)?.[1] || '%2Frepo'), revision: 0, orderedPaths: [] };
    else throw new Error('Unexpected catalog fixture request: ' + path);
    return { status: 200, body };
  } };
}
