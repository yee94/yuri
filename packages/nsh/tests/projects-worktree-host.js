import { projectsFixtureAuthority } from './projects-fixture-authority.js';

/** Worktree form interaction Host: records synthetic writes, never accesses Git. */
export function createHost() {
  const authority = projectsFixtureAuthority('worktree-fixture');
  let validations = 0, creates = 0, hold = false, release;
  let branchReads = 0, branchMode = 'normal', releaseBranches;
  return { call(name, input) {
    if (name === 'connection.list') return authority.snapshot();
    if (name !== 'runtime.request') throw new Error('Unexpected worktree fixture call');
    authority.accept(input);
    const path = input.path;
    let body;
    if (path === '/fixture/audit') body = `validations:${validations} creates:${creates}`;
    else if (path === '/fixture/branches-audit') body = `branches:${branchReads} creates:${creates}`;
    else if (path.startsWith('/fixture/branches-mode/')) { branchMode = path.split('/').pop(); body = `branch mode:${branchMode}`; }
    else if (path === '/fixture/branches-release') { releaseBranches?.(); releaseBranches = undefined; body = 'branches released'; }
    else if (path === '/fixture/hold') { hold = true; body = 'hold armed'; }
    else if (path === '/fixture/release') { release?.(); release = undefined; body = 'released prior'; }
    else if (path.startsWith('/api/git/worktrees/validate') && input.method === 'POST') {
      validations++;
      if (hold) { hold = false; return new Promise(resolve => { release = () => resolve({ status: 200, body: { ok: false, errors: [{ code: 'branch_exists', message: 'Late prior draft conflict' }] } }); }); }
      body = validations === 1 ? { ok: false, errors: [{ code: 'worktree_exists', message: 'Isolated directory conflict' }] } : { ok: true };
    } else if (path.startsWith('/api/git/worktrees?') && input.method === 'POST') { creates++; body = { path: '/isolated/created' }; }
    else if ((input.method || 'GET') !== 'GET' || input.body !== undefined) throw new Error('Unexpected worktree fixture mutation');
    else if (path === '/api/yuri/session-index') body = { available: true, directories: [] };
    else if (path === '/api/session/active') body = {};
    else if (path === '/api/session-folders/order') body = { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} };
    else if (path.startsWith('/api/git/branches?')) {
      branchReads++;
      if (branchMode === 'fail') return { status: 503, body: { error: 'Isolated branches unavailable' } };
      body = { all: branchMode === 'empty' || branchMode === 'hold' ? [] : ['main', 'feature/existing', 'remotes/origin/release'] };
      if (branchMode === 'hold') return new Promise(resolve => { releaseBranches = () => resolve({ status: 200, body }); });
    }
    else if (path.startsWith('/api/git/primary-root?')) body = { root: '/repo' };
    else if (path.startsWith('/api/git/status?')) body = { current: 'main' };
    else if (path.startsWith('/api/git/worktrees?')) body = [{ path: '/repo', name: 'repo', branch: 'main' }];
    else if (path.startsWith('/api/yuri/message-queue/worktrees/order?')) body = { projectDirectory: '/repo', revision: 0, orderedPaths: [] };
    else if (path.startsWith('/api/session?')) body = { data: [], cursor: {} };
    else throw new Error('Unexpected worktree fixture read: ' + path);
    return { status: 200, body };
  } };
}
