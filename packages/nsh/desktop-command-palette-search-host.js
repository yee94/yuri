/** Strict, read-only synthetic authority for the desktop Dialog integration. */
export function createHost() {
  const calls = [];
  let contentReads = 0;
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'palette-fixture', connections: [{ id: 'palette-fixture', label: 'Fixture', url: 'https://host.example', lastUsedAt: 0 }] };
    if (name !== 'runtime.request' || input.method !== 'GET') throw new Error('Unexpected palette fixture operation');
    const path = input.path;
    if (path === '/api/fixture/palette/audit') return { status: 200, body: { calls } };
    calls.push(path);
    if (path.startsWith('/api/session?')) return { status: 200, body: { data: [{ id: 'session', title: 'Needle conversation', directory: '/other', time: { updated: 1 } }] } };
    if (path.startsWith('/api/yuri/content-search?')) {
      if (++contentReads === 2) return { status: 503, body: { message: 'Deliberate refresh failure' } };
      return { status: 200, body: { hits: [{ sessionID: 'session', messageID: 'exact-message', title: 'Needle conversation', directory: '/other', snippet: 'Needle body', role: 'assistant', createdAt: 2 }] } };
    }
    if (path.startsWith('/api/fs/find?')) {
      if (!path.includes('location%5Bdirectory%5D=%2Fworkspace%2Ffocus')) throw new Error('File search escaped Focus');
      return { status: 200, body: { data: [{ path: 'src/needle.ts' }] } };
    }
    throw new Error('Unexpected palette fixture request: ' + path);
  } };
}
