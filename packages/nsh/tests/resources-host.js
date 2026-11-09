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
    if (input.source !== undefined) {
      const source = input.source, descriptor = source.descriptor;
      if (Object.keys(input).sort().join(',') !== 'expectedHost,requestId,source' || source.kind !== 'contact' || source.assistantID !== 'fixture-bot' || Object.keys(source).sort().join(',') !== 'assistantID,descriptor,kind' || JSON.stringify(descriptor) !== JSON.stringify({ type: 'file', attachmentID: 'opaque-note', sha256: 'a'.repeat(64), size: 26, mime: 'text/markdown', filename: 'note.md' })) throw new Error('Unexpected contact descriptor');
      return { kind: 'text', lease: 'contact-fixture-lease', size: 26, text: '# Contact resource fixture' };
    }
    return { kind: 'text', lease: 'fixture-lease', size: 26, text: input.path.endsWith('lines.ts') ? 'first line\nsecond line\ntarget line\nlast line' : input.path.endsWith('.md') ? '# Neutral resource fixture' : 'const neutralFixture = 1;' };
  }
  if (['resources.release', 'resources.close', 'resources.cancel'].includes(name)) return true;
  if (name === 'resources.present') return { completed: false };
  throw new Error('Unexpected resource handler: ' + name);
} }; }
