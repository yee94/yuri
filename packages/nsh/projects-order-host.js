/** Synthetic authority only; deliberately no network, filesystem, Git or model calls. */
import { fixtureRequest } from './tests/new-session-request.js';

export function createHost() {
  const scope = { hostID: 'projects-order', lease: 'synthetic-order-lease' };
  const directories = ['/fixture/repo', '/fixture/a', '/fixture/b', '/fixture/c'];
  const rows = directories.flatMap((directory, d) => Array.from({ length: d === 1 ? 8 : 3 }, (_, i) => ({ id: `s${d}-${i}`, title: `Session ${d}.${i}`, location: { directory }, time: { created: 100 - i, updated: 100 - i }, ...(i === 0 ? { summary: { additions: 12, deletions: 3 } } : {}) })));
  let treeRevision = 1, paths = directories.slice(1), revision = 1, orders = {}, activities = {}, failRead = false;
  const writes = [];
  return { call(name, input) {
    if (name === 'connection.list') return { connections: [{ id: scope.hostID, url: 'https://host.example', label: 'Synthetic order Host', lastUsedAt: 0 }], selected: scope.hostID, runtimeScope: scope };
    if (name === 'projects.order.audit' || name === 'projects.order.failRead') {
      if (!input || Object.keys(input).length) throw new Error('Unexpected order fixture arguments');
      if (name === 'projects.order.failRead') { failRead = true; return true; }
      return { writes: [...writes], paths: [...paths], orders, activities };
    }
    if (name !== 'runtime.request') throw new Error('Unexpected order fixture call');
    const route = fixtureRequest(input), { path, params, method } = route, reply = body => ({ status: 200, body });
    if (method !== 'GET' && (input.expectedHost?.hostID !== scope.hostID || input.expectedHost?.lease !== scope.lease)) throw new Error('Missing exact fixture lease');
    if (path === '/api/yuri/session-index') { route.expect('GET'); return reply({ available: true, pinnedSessionIds: ['s0-0', 's1-0'], directories: directories.map(directory => ({ directory, sessions: rows.filter(row => row.location.directory === directory), hasMore: false })) }); }
    if (path === '/api/session/active') { route.expect('GET'); return reply({}); }
    if (path === '/api/session') { route.expect('GET', ['directory', 'parentID', 'limit', 'order'], ['directory', 'parentID', 'limit', 'order']); if (!directories.includes(params.get('directory')) || params.get('parentID') !== 'null') throw new Error('Unexpected directory'); return reply({ data: rows.filter(row => row.location.directory === params.get('directory')), cursor: {} }); }
    if (path === '/api/git/worktrees') { route.expect('GET', ['directory'], ['directory']); if (params.get('directory') !== directories[0]) throw new Error('Unexpected project'); return reply(directories.map((path, i) => ({ path, name: i ? `Tree ${i}` : 'Main', branch: i ? `feature-${i}` : 'main' }))); }
    if (path === '/api/session-folders/order') {
      route.expect(method === 'POST' ? 'POST' : 'GET');
      if (method === 'POST') {
        const body = input.body, members = rows.filter(row => body.scopeKey === '__pinned__' ? ['s0-0', 's1-0'].includes(row.id) : row.location.directory === body.scopeKey).map(row => row.id);
        if (!Array.isArray(body.order) || body.order.length !== members.length || new Set(body.order).size !== members.length || body.order.some(id => !members.includes(id))) throw new Error('Invalid scoped order');
        orders = { ...orders, [body.scopeKey]: body.order }; activities = { ...activities, [body.scopeKey]: body.activity }; revision++; writes.push({ kind: 'sessions', scope: body.scopeKey, ids: [...body.order] });
      } else if (failRead) { failRead = false; return { status: 503, body: { error: 'Synthetic order read failed' } }; }
      return reply({ revision, sessionOrderByScope: orders, sessionOrderActivityByScope: activities });
    }
    if (path === '/api/yuri/message-queue/worktrees/order') {
      if (method === 'PUT') {
        route.expect('PUT'); const body = input.body;
        if (body.projectDirectory !== directories[0] || body.expectedRevision !== treeRevision || body.orderedPaths.length !== paths.length || new Set(body.orderedPaths).size !== paths.length || body.orderedPaths.some(path => !paths.includes(path))) throw new Error('Invalid tree order');
        paths = [...body.orderedPaths]; treeRevision++; writes.push({ kind: 'worktrees', scope: directories[0], ids: [...paths] });
        return reply({ revision: treeRevision, projectDirectory: directories[0] });
      }
      route.expect('GET', ['projectDirectory'], ['projectDirectory']); if (params.get('projectDirectory') !== directories[0]) throw new Error('Unexpected tree order project');
      if (failRead) { failRead = false; return { status: 503, body: { error: 'Synthetic order read failed' } }; }
      return reply({ projectDirectory: directories[0], revision: treeRevision, orderedPaths: [...paths] });
    }
    throw new Error('Unexpected order fixture request');
  } };
}
