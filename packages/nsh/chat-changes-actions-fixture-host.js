/** Mutable in-memory fake only: no filesystem or Git implementation. */
export function createHost(player) {
  let staged = false, committed = false, removed = false, stages = 0, commits = 0;
  let statusReads = 0, getReads = 0, posts = 0, commitCalls = 0, commitAcks = 0, failStatus = false, holdCommit = false, release;
  const audit = () => player?.hostEvent('changes.fixture.audit', { statusReads, getReads, posts, commitCalls, commitAcks });
  return { async call(name, input) {
    if (name === 'changes.fixture.control') {
      if (!input || Object.keys(input).join(',') !== 'name') throw new Error('Invalid fixture control');
      if (input.name === 'seed-staged') { staged = true; stages = 1; }
      else if (input.name === 'fail-next-status') failStatus = true;
      else if (input.name === 'hold-commit') { holdCommit = true; commits = 1; }
      else if (input.name === 'release') release?.();
      else throw new Error('Unexpected fixture control');
      audit(); return { ok: true };
    }
    if (name === 'connection.list') return { selected: 'changes-fixture', runtimeScope: { hostID: 'changes-fixture', lease: 'changes-fixture-lease' }, connections: [{ id: 'changes-fixture', label: 'Changes fixture', url: 'https://changes.example', lastUsedAt: 1 }] };
    if (name !== 'runtime.request') throw new Error('Unexpected fixture native call: ' + name);
    if (input.expectedHost?.hostID !== 'changes-fixture' || input.expectedHost?.lease !== 'changes-fixture-lease') throw new Error('Wrong Changes fixture authority');
    const route = input.path.split('?')[0];
    if (route === '/api/git/diff') {
      if (input.method !== 'GET' || !/^directory=%2Ffixture&path=folder%2Fa.ts&staged=(true|false)$/.test(input.path.split('?')[1])) throw new Error('Wrong Changes fixture diff');
    } else if (input.path.split('?')[1] !== 'directory=%2Ffixture') throw new Error('Wrong Changes fixture directory');
    if (input.method === 'GET') { getReads++; audit(); }
    if (input.method !== 'GET') { posts++; if (route === '/api/git/commit') commitCalls++; audit(); }
    if (route === '/api/git/status' && input.method === 'GET') {
      statusReads++; audit();
      if (failStatus) { failStatus = false; return { status: 503, body: { message: 'Lifecycle status failure' } }; }
      const files = [
        ...(!committed ? [{ path: 'folder/a.ts', index: staged ? 'M' : ' ', working_dir: staged ? ' ' : 'M' }] : []),
        ...(!removed ? [{ path: 'folder/b.ts', index: '?', working_dir: '?' }] : []),
      ];
      return { status: 200, body: { isClean: !files.length, current: 'fixture-branch', files, diffStats: { 'folder/a.ts': { insertions: 3, deletions: 2 } } } };
    }
    if (route === '/api/git/diff') return { status: 200, body: { diff: '@@ -1 +1 @@\n-old\n+SHARED_READER_ONLY\n' } };
    if (route === '/api/git/stage' && input.method === 'POST') {
      if (input.body.paths.join(',') !== 'folder/a.ts') throw new Error('Unexpected staging selection');
      if (++stages === 1) return { status: 503, body: { message: 'Fake stage failure' } };
      staged = true; return { status: 200, body: { success: true } };
    }
    if (route === '/api/git/commit' && input.method === 'POST') {
      if (!staged || input.body.message !== 'Exact fixture commit' || input.body.files.join(',') !== 'folder/a.ts' || input.body.stageFiles.length !== 0) throw new Error('Unsafe fixture commit payload');
      if (holdCommit) { holdCommit = false; await new Promise(resolve => { release = resolve; }); release = undefined; }
      if (++commits === 1) return { status: 503, body: { message: 'Fake commit failure' } };
      committed = true; commitAcks++; audit(); return { status: 200, body: { success: true, commit: 'fixture-commit' } };
    }
    if (route === '/api/git/revert' && input.method === 'POST') {
      if (input.body.path !== 'folder/b.ts') throw new Error('Unexpected fixture revert');
      removed = true; return { status: 200, body: { success: true } };
    }
    if (route === '/api/git/remotes' && input.method === 'GET') return { status: 200, body: [] };
    throw new Error('Unexpected mutation fixture route: ' + input.method + ' ' + route);
  } };
}
