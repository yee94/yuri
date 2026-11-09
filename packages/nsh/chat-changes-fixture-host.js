/** Isolated fixture; never selected by production native Host. */
import { changesFixtureConnection, verifyChangesFixtureScope } from './chat-changes-fixture-scope.js';
export function createHost() {
  const saved = changesFixtureConnection('changes-read-fixture', 'synthetic-changes-read-lease');
  let statusReads = 0, diffReads = 0;
  return { call(name, input) {
    if (name === 'connection.list') return saved;
    if (name !== 'runtime.request') throw new Error('Unexpected native call: ' + name);
    verifyChangesFixtureScope(input, saved.runtimeScope);
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
    if (input.path.startsWith('/api/git/file-diff?directory=%2Ffixture')) {
      diffReads++;
      if (diffReads === 2) return { status: 503, body: { message: 'Neutral diff offline' } };
      return { status: 200, body: { original: 'same\nold', modified: 'same\n' + (input.path.endsWith('staged=true') ? 'STAGED_ONLY' : 'WORKING_ONLY'), isBinary: false } };
    }
    if (input.path.startsWith('/api/git/remotes?')) return { status: 200, body: [] };
    if (input.path.startsWith('/api/git/check?directory=%2Ffixture')) return { status: 200, body: { isGitRepository: true } };
    if (input.path.startsWith('/api/yuri/sessions/s/changes?')) return { status: 200, body: { diff: { file: 'thin.ts' } } };
    throw new Error('Unexpected Changes request: ' + input.path);
  } };
}
