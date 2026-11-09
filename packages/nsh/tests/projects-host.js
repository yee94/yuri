import { projectsFixtureAuthority } from './projects-fixture-authority.js';

/** Projects-only native engine fixture; never loaded by the production app. */
export function createHost() {
  const authority = projectsFixtureAuthority('fixture');
  let directoryReads = 0;
  return { call(name, input) {
    if (name === 'connection.list' && input && Object.keys(input).length === 0) return authority.snapshot();
    if (name !== 'runtime.request') throw new Error('Unexpected native call');
    authority.accept(input);
    if ((input.method || 'GET') !== 'GET' || input.body !== undefined) throw new Error('Projects home fixture is read-only');
    const path = input.path;
    const session = { id: 'projects_session', title: 'Native projects conversation', location: { directory: '/repo' }, time: { updated: Date.now() } };
    const sessions = [session, ...Array.from({ length: 4 }, (_, index) => ({ ...session, id: `fixture_extra_${index}`, title: `Extra fixture row ${index}`, time: { updated: 4 - index } }))];
    let body;
    if (path === '/fixture/projects-read-count') body = `directory reads:${directoryReads}`;
    else if (path === '/api/debug/location') body = [{ directory: '/repo' }];
    else if (path === '/api/form?location%5Bdirectory%5D=%2Frepo' || path === '/api/permission/request?location%5Bdirectory%5D=%2Frepo') body = { data: [] };
    else if (path === '/api/yuri/session-index') body = { available: true, pinnedSessionIds: [], directories: [{ directory: '/repo', sessions, hasMore: false }] };
    else if (path === '/api/session-folders/order') body = { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} };
    else if (path.startsWith('/api/yuri/message-queue/worktrees/order')) body = { projectDirectory: '/repo', revision: 2, orderedPaths: ['/repo/second', '/repo/first'] };
    else if (path === '/api/session/active') body = { data: { projects_session: { type: 'running' } } };
    else if (path.startsWith('/api/git/check?')) body = { isGitRepository: true };
    else if (path.startsWith('/api/git/worktrees')) body = [{ path: '/repo', branch: 'main', name: 'repo' }, { path: '/repo/first', branch: 'native-first-branch', name: 'first' }, { path: '/repo/second', branch: 'native-second-branch', name: 'second' }];
    else if (path.startsWith('/api/session?')) {
      directoryReads++;
      const directory = decodeURIComponent(path.match(/[?&]directory=([^&]*)/)?.[1] || '%2Frepo');
      body = { data: sessions.map((row, index) => ({ ...row, id: `tree_${index}`, location: { directory } })), cursor: { next: directoryReads === 1 ? 'opaque-next' : null } };
    }
    else throw new Error('Unexpected projects request: ' + path);
    return { status: 200, body };
  } };
}
