/** Projects-only native engine fixture; never loaded by the production app. */
export function createHost() {
  return { call(name, input) {
    if (name !== 'runtime.request') throw new Error('Unexpected native call');
    const path = input.path;
    const session = { id: 'projects_session', title: 'Native projects conversation', location: { directory: '/repo' }, time: { updated: Date.now() } };
    let body;
    if (path === '/api/yuri/session-index') body = { available: true, pinnedSessionIds: [], directories: [{ directory: '/repo', sessions: [session], hasMore: true }] };
    else if (path === '/api/session-folders/order') body = { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} };
    else if (path.startsWith('/api/yuri/message-queue/worktrees/order')) body = { projectDirectory: '/repo', revision: 2, orderedPaths: ['/repo/second', '/repo/first'] };
    else if (path === '/api/session/active') body = { data: { projects_session: { type: 'running' } } };
    else if (path.startsWith('/api/git/worktrees')) body = [{ path: '/repo', branch: 'main', name: 'repo' }, { path: '/repo/first', branch: 'native-first-branch', name: 'first' }, { path: '/repo/second', branch: 'native-second-branch', name: 'second' }];
    else if (path.startsWith('/api/session?')) body = { data: [session], cursor: {} };
    else throw new Error('Unexpected projects request: ' + path);
    return { status: 200, body };
  } };
}
