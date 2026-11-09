import { createHost as createBase } from './host.js';
import { verifyChangesFixtureScope } from '../chat-changes-fixture-scope.js';

export function createHost() {
  const base = createBase();
  const saved = base.call('connection.list', {});
  let reads = 0;
  const files = Array.from({ length: 300 }, (_, index) => ({ path: `neutral-${index}.txt`, index: ' ', working_dir: 'M' }));
  const diffStats = Object.fromEntries(files.map(file => [file.path, { insertions: 1, deletions: 0 }]));
  return { call(name, input) {
    if (name === 'runtime.request') verifyChangesFixtureScope(input, saved.runtimeScope);
    if (name === 'runtime.request' && input.path.startsWith('/api/git/status?')) {
      if (input.path.includes('&mode=light')) return { status: 200, body: { current: 'fixture', isClean: true, files: [] } };
      reads++;
      if (reads === 2) return { status: 503, body: { message: 'Neutral status offline' } };
      return { status: 200, body: { isClean: false, files, diffStats } };
    }
    if (name === 'runtime.request' && input.path.startsWith('/api/git/diff?')) return { status: 200, body: { diff: '@@ -1 +1 @@\n-Neutral old file\n+Neutral changed file evidence' } };
    if (name === 'runtime.request' && input.path.startsWith('/api/git/file-diff?')) return { status: 200, body: { original: 'Neutral old file', modified: 'Neutral changed file evidence', isBinary: false } };
    if (name === 'runtime.request' && input.path.startsWith('/api/git/remotes?')) return { status: 200, body: [] };
    if (name === 'runtime.request' && input.path.startsWith('/api/git/check?')) return { status: 200, body: { isGitRepository: true } };
    return base.call(name, input);
  } };
}
