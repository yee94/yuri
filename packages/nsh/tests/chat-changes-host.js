import { createHost as createBase } from './host.js';

export function createHost() {
  const base = createBase();
  let reads = 0;
  const files = Array.from({ length: 300 }, (_, index) => ({ path: `neutral-${index}.txt`, index: ' ', working_dir: 'M' }));
  const diffStats = Object.fromEntries(files.map(file => [file.path, { insertions: 1, deletions: 0 }]));
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'layout-fixture', runtimeScope: { hostID: 'layout-fixture', lease: 'layout-fixture-lease' }, connections: [{ id: 'layout-fixture', label: 'Layout fixture', url: 'https://layout.example', lastUsedAt: 1 }] };
    if (name === 'runtime.request' && (input.method !== 'GET' || input.body !== undefined || input.expectedHost?.hostID !== 'layout-fixture' || input.expectedHost?.lease !== 'layout-fixture-lease')) throw new Error('Wrong layout fixture authority');
    if (name === 'runtime.request' && input.path.startsWith('/api/git/status?')) {
      if (input.path.includes('&mode=light')) return { status: 200, body: { current: 'fixture', isClean: true, files: [] } };
      reads++;
      if (reads === 2) return { status: 503, body: { message: 'Neutral status offline' } };
      return { status: 200, body: { isClean: false, files, diffStats } };
    }
    if (name === 'runtime.request' && input.path.startsWith('/api/git/diff?')) return { status: 200, body: { diff: '+Neutral changed file evidence' } };
    return base.call(name, input);
  } };
}
