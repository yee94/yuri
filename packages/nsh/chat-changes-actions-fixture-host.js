/** Mutable in-memory fake only: no filesystem or Git implementation. */
export function createHost() {
  let staged = false, committed = false, removed = false, stages = 0, commits = 0;
  return { call(name, input) {
    if (name !== 'runtime.request') throw new Error('Unexpected fixture native call: ' + name);
    const route = input.path.split('?')[0];
    if (route === '/api/git/status' && input.method === 'GET') {
      const files = [
        ...(!committed ? [{ path: 'folder/a.ts', index: staged ? 'M' : ' ', working_dir: staged ? ' ' : 'M' }] : []),
        ...(!removed ? [{ path: 'folder/b.ts', index: '?', working_dir: '?' }] : []),
      ];
      return { status: 200, body: { isClean: !files.length, current: 'fixture-branch', files, diffStats: { 'folder/a.ts': { insertions: 3, deletions: 2 } } } };
    }
    if (route === '/api/git/stage' && input.method === 'POST') {
      if (input.body.paths.join(',') !== 'folder/a.ts') throw new Error('Unexpected staging selection');
      if (++stages === 1) return { status: 503, body: { message: 'Fake stage failure' } };
      staged = true; return { status: 200, body: { success: true } };
    }
    if (route === '/api/git/commit' && input.method === 'POST') {
      if (!staged || input.body.message !== 'Exact fixture commit' || input.body.files.join(',') !== 'folder/a.ts' || input.body.stageFiles.length !== 0) throw new Error('Unsafe fixture commit payload');
      if (++commits === 1) return { status: 503, body: { message: 'Fake commit failure' } };
      committed = true; return { status: 200, body: { success: true, commit: 'fixture-commit' } };
    }
    if (route === '/api/git/revert' && input.method === 'POST') {
      if (input.body.path !== 'folder/b.ts') throw new Error('Unexpected fixture revert');
      removed = true; return { status: 200, body: { success: true } };
    }
    if (route === '/api/git/remotes' && input.method === 'GET') return { status: 200, body: [] };
    throw new Error('Unexpected mutation fixture route: ' + input.method + ' ' + route);
  } };
}
