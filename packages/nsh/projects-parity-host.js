/** In-memory Projects authority only: no network, filesystem, Git or process access. */
import { fixtureRequest } from './tests/new-session-request.js';

export function createHost(player) {
  const root = { id: 'root', title: 'Projects deferred root', location: { directory: '/fixture/repo' }, time: { created: 1, updated: 30 }, summary: { additions: 12, deletions: 3 } };
  const other = { id: 'other', title: 'Projects unaffected root', location: { directory: '/fixture/repo' }, time: { created: 2, updated: 20 } };
  const children = ['bad', 'good'].map(id => ({ id, title: id, parentID: root.id, location: root.location, time: { updated: 10 } }));
  const removed = new Set();
  const attempts = [];
  let writes = 0, rejectedRequests = 0, auditSequence = 0, failChild = true;
  return { call(name, input) {
    if (name === 'projects.fixture.complete') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length || typeof player?.hostEvent !== 'function') throw new Error('Unexpected Projects completion fixture arguments');
      player.hostEvent('runtime.event', { key: 'global', data: JSON.stringify({ type: 'session.execution.succeeded', data: { sessionID: 'root' } }) });
      return true;
    }
    if (name === 'projects.fixture.audit') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Unexpected Projects audit arguments');
      return { auditSequence: ++auditSequence, writes, attempts: [...attempts], removed: [...removed], rejectedRequests };
    }
    if (name !== 'runtime.request') { rejectedRequests++; throw new Error('Unexpected Projects native call'); }
    try {
      const route = fixtureRequest(input), { path, params } = route;
      const reply = body => ({ status: 200, body });
      if (path === '/api/yuri/session-index') {
        route.expect('GET');
        return reply({ available: true, pinnedSessionIds: [], directories: [{ directory: '/fixture/repo', sessions: [root, other].filter(row => !removed.has(row.id)), hasMore: false }] });
      }
      if (path === '/api/session-folders/order') { route.expect('GET'); return reply({ revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} }); }
      if (path === '/api/session/active') { route.expect('GET'); return reply({ data: {} }); }
      if (path === '/api/debug/location') { route.expect('GET'); return reply([]); }
      if (path === '/api/git/worktrees') { route.expect('GET', ['directory'], ['directory']); if (params.get('directory') !== '/fixture/repo') throw new Error('Unexpected Projects worktree scope'); return reply([]); }
      if (path === '/api/yuri/message-queue/worktrees/order') { route.expect('GET', ['projectDirectory'], ['projectDirectory']); if (params.get('projectDirectory') !== '/fixture/repo') throw new Error('Unexpected Projects order scope'); return reply({ projectDirectory: '/fixture/repo', revision: 0, orderedPaths: [] }); }
      if (path === '/api/session') {
        route.expect('GET', ['parentID', 'limit', 'order', 'cursor', 'directory'], ['parentID', 'limit', 'order']);
        if (params.get('parentID') === 'null') { if (params.get('directory') !== '/fixture/repo') throw new Error('Unexpected Projects directory'); return reply({ data: [root, other].filter(row => !removed.has(row.id)), cursor: {} }); }
        if (!['root', 'bad', 'good'].includes(params.get('parentID'))) throw new Error('Unexpected Projects parent');
        if (params.get('parentID') === 'root') {
          if (!params.has('cursor')) return reply({ data: [], cursor: { next: 'child-page+=' } });
          if (params.get('cursor') !== 'child-page+=') throw new Error('Unexpected Projects cursor');
          return reply({ data: children.filter(row => !removed.has(row.id)), cursor: {} });
        }
        if (params.has('cursor')) throw new Error('Unexpected Projects leaf cursor');
        return reply({ data: [], cursor: {} });
      }
      if (path.startsWith('/api/session/')) {
        route.expect('DELETE', ['directory'], ['directory']);
        const id = path.slice('/api/session/'.length);
        if (!['root', 'bad', 'good'].includes(id) || params.get('directory') !== '/fixture/repo' || input.body !== undefined) throw new Error('Unexpected Projects delete identity');
        writes++; attempts.push(id);
        if (id === 'bad' && failChild) { failChild = false; return { status: 503, body: { error: 'Fixture child delete failed' } }; }
        if (id === 'root' && children.some(row => !removed.has(row.id))) throw new Error('Projects attempted unsafe ancestor cascade');
        if (removed.has(id)) return { status: 404, body: { error: 'Already removed' } };
        removed.add(id); return reply(true);
      }
      throw new Error('Unexpected Projects request');
    } catch (failure) { rejectedRequests++; throw failure; }
  } };
}
