import { fixtureRequest } from './tests/new-session-request.js';

/** Isolated synthetic Host. It never opens a socket, filesystem or real Host. */
export function createHost(player) {
  const directory = '/fixture/repo';
  const root = { id: 'root', title: 'Attention root', location: { directory }, time: { created: 1, updated: 30 } };
  let forms = [{ id: 'frm_fixture', sessionID: 'root', metadata: { kind: 'question' }, title: 'Fixture question', fields: [] }];
  let permissions = [{ id: 'perm_fixture', sessionID: 'root', action: 'shell' }];
  let failure = false, rejectedRequests = 0, sequence = 0, serial = 0;
  const reads = [];
  const emit = (type, data) => player.hostEvent('runtime.event', { key: 'global', data: JSON.stringify({ directory, payload: { type, data, id: `attention-event-${++serial}` } }) });
  return { call(name, input) {
    if (name === 'projects.attention.fixture') {
      if (!input || Object.keys(input).length !== 1 || !['question', 'permission', 'fail', 'recover', 'audit'].includes(input.action)) throw new Error('Invalid attention fixture action');
      if (input.action === 'audit') return { attentionAudit: ++sequence, reads: [...reads], rejectedRequests };
      if (input.action === 'question') { forms = []; emit('form.replied', { sessionID: 'root', id: 'frm_fixture' }); }
      if (input.action === 'permission') { permissions = []; emit('permission.replied', { sessionID: 'root', requestID: 'perm_fixture' }); }
      if (input.action === 'fail') {
        forms = [{ id: 'frm_retry', sessionID: 'root', metadata: { kind: 'question' }, title: 'Retry question', fields: [] }];
        emit('form.created', forms[0]); failure = true; emit('server.connected', {});
      }
      if (input.action === 'recover') { forms = []; permissions = []; failure = false; emit('server.connected', {}); }
      return true;
    }
    if (name !== 'runtime.request') { rejectedRequests++; throw new Error('Unexpected attention fixture native call'); }
    try {
      const route = fixtureRequest(input), { path, params } = route;
      const reply = body => ({ status: 200, body });
      reads.push(input.path);
      if (path === '/api/debug/location') { route.expect('GET'); return reply([{ directory }]); }
      if (path === '/api/form' || path === '/api/permission/request') {
        route.expect('GET', ['location[directory]'], ['location[directory]']);
        if (params.get('location[directory]') !== directory) throw new Error('Invalid attention Location');
        if (path === '/api/form' && failure) return { status: 503, body: { error: 'Synthetic form failure' } };
        return reply({ data: path === '/api/form' ? forms : permissions });
      }
      if (path === '/api/yuri/session-index') { route.expect('GET'); return reply({ available: true, pinnedSessionIds: [], directories: [{ directory, sessions: [root], hasMore: false }] }); }
      if (path === '/api/session-folders/order') { route.expect('GET'); return reply({ revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} }); }
      if (path === '/api/session/active') { route.expect('GET'); return reply({ data: { root: { type: 'running' } } }); }
      if (path === '/api/git/worktrees') { route.expect('GET', ['directory'], ['directory']); if (params.get('directory') !== directory) throw new Error('Invalid worktree directory'); return reply([]); }
      if (path === '/api/yuri/message-queue/worktrees/order') { route.expect('GET', ['projectDirectory'], ['projectDirectory']); if (params.get('projectDirectory') !== directory) throw new Error('Invalid order directory'); return reply({ projectDirectory: directory, revision: 0, orderedPaths: [] }); }
      if (path === '/api/session') { route.expect('GET', ['parentID', 'limit', 'order', 'directory'], ['parentID', 'limit', 'order', 'directory']); if (params.get('directory') !== directory || params.get('parentID') !== 'null') throw new Error('Invalid session directory'); return reply({ data: [root], cursor: {} }); }
      throw new Error('Unexpected attention fixture request');
    } catch (error) { rejectedRequests++; throw error; }
  } };
}
