/** Isolated fixture; never selected by production native Host. */
export function createHost() {
  let statusReads = 0, diffReads = 0;
  return { call(name, input) {
    if (name !== 'runtime.request') throw new Error('Unexpected native call: ' + name);
    if (input.method !== 'GET') throw new Error('Changes fixture permits read-only requests only');
    if (input.path.startsWith('/api/git/status?directory=%2Ffixture')) {
      statusReads++;
      if (statusReads === 2) return { status: 503, body: { message: 'Neutral status offline' } };
      return { status: 200, body: { isClean: false, files: [
        { path: 'a.ts', index: 'M', working_dir: 'M' },
        { path: 'b.ts', index: ' ', working_dir: 'M' },
        ...Array.from({ length: 298 }, (_, index) => ({ path: `neutral-${index}.txt`, index: ' ', working_dir: 'M' })),
      ], diffStats: { 'a.ts': { insertions: 1, deletions: 1 } } } };
    }
    if (input.path.startsWith('/api/git/diff?directory=%2Ffixture')) {
      diffReads++;
      if (diffReads === 2) return { status: 503, body: { message: 'Neutral diff offline' } };
      return { status: 200, body: { diff: '@@ -8,2 +8,2 @@\n same\n-old\n+' + (input.path.endsWith('staged=true') ? 'STAGED_ONLY' : 'WORKING_ONLY') } };
    }
    if (input.path.startsWith('/api/yuri/sessions/s/changes?')) return { status: 200, body: { diff: { file: 'thin.ts' } } };
    throw new Error('Unexpected Changes request: ' + input.path);
  } };
}
