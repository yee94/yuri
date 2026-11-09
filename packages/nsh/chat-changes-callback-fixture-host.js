/** In-memory callbacks only. Never access filesystem, real Git, connections or models. */
export function createHost() {
  let generates = 0, commits = 0, statusReads = 0;
  const posts = [];
  return { audit: () => ({ generates, commits, statusReads, posts: [...posts] }), call(name, input) {
    if (name !== 'runtime.request') throw new Error('Unexpected fixture bridge');
    if (!input || typeof input !== 'object' || typeof input.path !== 'string') throw new Error('Invalid fixture request');
    const route = input.path.split('?')[0];
    if (input.expectedHost?.hostID !== 'changes-callback-fixture') throw new Error('Missing captured fixture scope');
    if (input.method === 'POST') posts.push(route);
    if (route === '/api/git/status' && input.method === 'GET') { statusReads++; return { status: 200, body: { isClean: false, current: 'fixture-branch', files: [{ path: 'src/a.ts', index: 'M', working_dir: 'M' }, { path: 'src/deep/b.ts', index: ' ', working_dir: 'M' }] } }; }
    if (route === '/api/magic-prompts') return { status: 200, body: { version: 1, overrides: {} } };
    if (route === '/api/git/remotes') return { status: 200, body: [] };
    if (route === '/api/git/diff') return { status: 200, body: { diff: '@@ -1 +1 @@\n-old\n+fixture material' } };
    if (route === '/api/git/file-diff') return { status: 200, body: { original: 'one\nold\nthree\nfour\nfive\nsix\nseven\neight', modified: 'one\nnew\nthree\nfour\nfive\nsix\nseven\neight', isBinary: false } };
    if (route === '/api/small-model/generate') {
      if (input.method !== 'POST' || input.body.purpose !== 'commit' || input.body.directory !== '/fixture') throw new Error('Invalid generation request');
      generates++; if (generates > 1) throw new Error('Generation unexpectedly replayed');
      return { status: 200, body: { text: '{"subject":"fix: fixture subject","highlights":["Fixture highlight one","Fixture highlight two"]}' } };
    }
    if (route === '/api/git/commit') {
      if (input.method !== 'POST' || input.body.files.join(',') !== 'src/a.ts' || input.body.stageFiles.length !== 0) throw new Error('Invalid fixture commit');
      commits++; if (commits > 1) throw new Error('Uncertain commit replayed');
      return { status: 503, body: { error: 'Fixture response lost: outcome unknown' } };
    }
    throw new Error('Unexpected mock route: ' + input.method + ' ' + route);
  } };
}
