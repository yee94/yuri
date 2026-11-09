import { projectsFixtureAuthority } from './projects-fixture-authority.js';

/** Projects acquisition/search fixture only; no production Host or model calls. */
export function createHost() {
  const authority = projectsFixtureAuthority('fixture');
  let cloneCount = 0, saves = 0, contentReads = 0, projects = [];
  return { call(name, input) {
    if (name === 'connection.list' && input && Object.keys(input).length === 0) return authority.snapshot();
    if (name !== 'runtime.request') throw new Error('Unexpected native call');
    authority.accept(input);
    const path = input.path, method = input.method;
    let body;
    if (path === '/api/fs/home') body = { home: '/workspace' };
    else if (path.startsWith('/api/fs/list')) body = { entries: [{ name: 'focus', path: '/workspace/focus', isDirectory: true }] };
    else if (path === '/api/git/identities') body = [{ id: 'fixture-profile', name: 'Fixture SSH profile' }];
    else if (path === '/api/fs/clone') {
      cloneCount++;
      if (cloneCount !== 1) throw new Error('Clone was replayed after registry failure');
      body = { success: true, path: input.body.destinationPath };
    } else if (path === '/api/config/settings' && method === 'GET') body = { projects };
    else if (path === '/api/config/settings' && method === 'PUT') {
      if (++saves === 1) return { status: 409, body: { message: 'Fixture registry conflict' } };
      projects = input.body.projects; body = { projects, activeProjectId: input.body.activeProjectId };
    } else if (path.startsWith('/api/session?')) body = { data: [{ id: 'fixture-session', title: 'Native global title hit', location: { directory: '/other-project' }, time: { updated: 1 } }], cursor: {} };
    else if (path.startsWith('/api/yuri/content-search')) {
      if (++contentReads === 1) return { status: 503, body: { message: 'Fixture content offline' } };
      body = { hits: [{ sessionID: 'fixture-session', messageID: 'fixture-message', title: 'Native message hit', directory: '/other-project', snippet: 'Native body match', role: 'assistant', createdAt: 1 }] };
    } else if (path.startsWith('/api/fs/find')) {
      if (!path.includes('location%5Bdirectory%5D=%2Fworkspace%2Ffocus')) throw new Error('Search escaped the Focus directory');
      body = { data: [{ path: 'src/native.ts', type: 'file' }] };
    } else throw new Error('Unexpected projects fixture request: ' + path);
    return { status: 200, body };
  } };
}
