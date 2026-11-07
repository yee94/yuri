export function createHost() { let reads = 0; return { async call(name, input) {
  if (name === 'runtime.request') {
    if (input.path.startsWith('/api/fs/list?')) return { status: 200, body: { entries: input.path.includes(encodeURIComponent('/fixture/sub')) ? [{ path: '/fixture/sub/note.md', isDirectory: false }] : [{ path: '/fixture/sub', isDirectory: true }, { path: '/fixture/source.ts', isDirectory: false }] } };
    if (input.path.startsWith('/api/fs/find?location%5Bdirectory%5D=')) return { status: 200, body: { location: { directory: '/fixture' }, data: [{ path: 'source.ts', type: 'file' }] } };
    throw new Error('Unexpected resource request');
  }
  if (name === 'resources.read') {
    if (input.expectedHost?.hostID !== 'resource-fixture' || input.expectedHost?.lease !== '00000000-0000-4000-8000-000000000001') throw new Error('Synthetic resource scope rejected');
    reads++;
    if (reads === 2) throw new Error('Neutral fixture offline; retry available');
    return { kind: 'text', lease: 'fixture-lease', size: 26, text: input.path.endsWith('lines.ts') ? 'first line\nsecond line\ntarget line\nlast line' : input.path.endsWith('.md') ? '# Neutral resource fixture' : 'const neutralFixture = 1;' };
  }
  if (['resources.release', 'resources.close', 'resources.cancel'].includes(name)) return true;
  if (name === 'resources.present') return { completed: false };
  throw new Error('Unexpected resource handler: ' + name);
} }; }
