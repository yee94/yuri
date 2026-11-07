import { createHost as draftHost } from './new-session-host.js';
import { fixtureRequest } from './new-session-request.js';

/** Own production-navigation fixture; all requests stay in this fake bridge. */
export function createHost() {
  const base = draftHost();
  let writes = 0, appearanceRevision = 0;
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'new-session-production', connections: [{ id: 'new-session-production', label: 'Draft fixture Host', url: 'https://host.example', lastUsedAt: 0 }] };
    if (name === 'appearance.reset') return { revision: ++appearanceRevision };
    if (name === 'appearance.apply') return {};
    if (name !== 'runtime.request') return base.call(name, input);
    const route = fixtureRequest(input), { path: pathname, method, params } = route;
    const ok = body => ({ status: 200, body });
    if (input.method && input.method !== 'GET') writes++;
    if (pathname === '/__fixture/new-session-production/audit') {
      route.expect('GET');
      const stats = base.call('runtime.request', { path: '/__fixture/new-session/stats', method: 'GET' }).body;
      return ok({ writes, creates: stats.creates, prompts: stats.prompts.length });
    }
    if (pathname === '/api/config/settings') {
      route.expect('GET');
      const settings = base.call(name, input).body;
      return ok({ ...settings, projects: [{ id: 'fixture-project', name: 'Native draft project', path: '/fixture/project' }] });
    }
    if (pathname === '/api/config/themes') { route.expect('GET'); return ok([]); }
    if (pathname === '/api/yuri/assistants/snapshot') { route.expect('GET'); return ok({ assistants: [] }); }
    if (pathname === '/api/yuri/scheduled-tasks') { route.expect('GET'); return ok({ tasks: [], failedProjectIds: [] }); }
    if (pathname === '/api/session-folders/order') { route.expect('GET'); return ok({ revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} }); }
    if (pathname === '/api/yuri/message-queue/worktrees/order') { route.expect('GET', ['projectDirectory'], ['projectDirectory']); return ok({ projectDirectory: params.get('projectDirectory'), revision: 0, orderedPaths: [] }); }
    if (pathname === '/api/git/worktrees') { route.expect('GET', ['directory'], ['directory']); return ok([]); }
    if (pathname === '/api/git/check') { route.expect('GET', ['directory'], ['directory']); return ok({ isGitRepository: false }); }
    if (pathname === '/api/session' && method === 'GET') { route.expect('GET', ['directory', 'search', 'limit', 'order', 'archived', 'parentID', 'cursor']); return ok({ data: [], cursor: {} }); }
    return base.call(name, input);
  } };
}
