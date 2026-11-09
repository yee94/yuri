import { createHost as referenceHost } from './composer-references-chat-host.js';
import { fixtureRequest } from './new-session-request.js';

/** Never sends a prompt: keyboard selection only edits the local draft. */
export function createHost() {
  const base = referenceHost();
  let scope = null, mutations = 0, sends = 0;
  const keys = (value, expected) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) throw new Error('Invalid keyboard fixture payload');
  };
  return { call(name, input) {
    if (name === 'connection.list') { keys(input, []); const saved = base.call(name, input); scope = saved.runtimeScope; return saved; }
    if (!scope) throw new Error('Keyboard fixture scope not issued');
    if (name === 'referenceKeyboard.fixture.audit') { keys(input, []); return { mutations, sends }; }
    if (name === 'runtime.stream' || name === 'runtime.stop') return base.call(name, input);
    if (name !== 'runtime.request') throw new Error('Unexpected keyboard native call');
    keys(input, ['path', 'method', 'expectedHost', ...(input.body === undefined ? [] : ['body'])]);
    keys(input.expectedHost, ['hostID', 'lease']);
    if (input.expectedHost.hostID !== scope.hostID || input.expectedHost.lease !== scope.lease) throw new Error('Stale keyboard fixture scope');
    const route = fixtureRequest(input), { path, params } = route;
    if (input.method !== 'GET') { mutations++; if (path.endsWith('/prompt')) sends++; throw new Error('Keyboard fixture must not send or mutate Host'); }
    if (input.body !== undefined) throw new Error('Unexpected keyboard read body');
    if (path === '/api/fs/find') {
      route.expect('GET', ['location[directory]', 'query', 'type', 'limit'], ['location[directory]', 'type', 'limit']);
      if (params.get('location[directory]') !== '/workspace' || !params.has('query') || !['file', 'directory'].includes(params.get('type')) || params.get('limit') !== (params.get('type') === 'file' ? '80' : '40')) throw new Error('Unexpected keyboard file query scope');
      if (params.get('type') === 'file') return { status: 200, body: { location: { directory: '/workspace' }, data: Array.from({ length: 12 }, (_, index) => ({ path: `src/file-${String(index).padStart(2, '0')}.ts`, type: 'file' })) } };
    } else if (path === '/api/agent' || path === '/api/skill') {
      route.expect('GET', ['location[directory]'], ['location[directory]']);
      if (params.get('location[directory]') !== '/workspace') throw new Error('Unexpected keyboard catalog scope');
    } else if (path === '/api/session') {
      route.expect('GET', ['search', 'limit', 'order', 'archived'], ['limit', 'order', 'archived']);
      if (!params.has('search') || params.get('order') !== 'desc' || params.get('archived') !== 'false' || params.get('limit') !== (params.get('search') ? '12' : '6')) throw new Error('Unexpected keyboard session query');
    }
    return base.call(name, input);
  } };
}
