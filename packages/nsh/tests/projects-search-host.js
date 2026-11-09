import { fixtureRequest } from './new-session-request.js';
import { projectsFixtureAuthority } from './projects-fixture-authority.js';

/** Search-only synthetic authority. Unknown requests are failures, never empty success. */
export function createHost() {
  const calls = [], contentReads = new Map();
  const authority = projectsFixtureAuthority('search-fixture');
  let rejected = 0;
  const snapshot = () => ({ calls: calls.map(row => ({ ...row })), rejected });
  return { call(name, input) {
    if (name === 'projectsSearch.fixture.audit') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Invalid search audit input');
      return snapshot();
    }
    try {
      if (name === 'connection.list' && input && Object.keys(input).length === 0) return authority.snapshot();
      if (name !== 'runtime.request' || !input || Object.keys(input).some(key => !['path', 'method', 'body', 'expectedHost'].includes(key)) || input.body !== undefined) throw new Error('Unexpected search fixture call');
      authority.accept(input);
      const req = fixtureRequest(input), { path, params } = req;
      let body;
      if (path === '/api/session') {
        req.expect('GET', ['parentID', 'limit', 'order', 'search'], ['parentID', 'limit', 'order']);
        if (params.get('parentID') !== 'null' || params.get('limit') !== '30' || params.has('search') && !params.get('search').trim()) throw new Error('Invalid global title search');
        body = { data: Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, title: `needle chat ${i}`, location: { directory: '/global/other-project' }, time: { updated: 100 - i } })), cursor: {} };
      } else if (path === '/api/yuri/content-search') {
        req.expect('GET', ['q', 'limit'], ['q', 'limit']);
        if (!params.get('q').trim() || params.get('limit') !== '30') throw new Error('Invalid global content search');
        const query = params.get('q'), count = (contentReads.get(query) || 0) + 1; contentReads.set(query, count);
        calls.push({ path, query, method: req.method });
        if (count === 2) return { status: 503, body: { message: 'Search fixture content refresh failed' } };
        body = { hits: [
          { sessionID: 's0', messageID: 'm8', title: 'needle chat 0', directory: '/global/other-project', snippet: 'needle older body', role: 'assistant', createdAt: 10 },
          { sessionID: 's0', messageID: 'm9', title: 'needle chat 0', directory: '/global/other-project', snippet: 'needle latest body', role: 'assistant', createdAt: 10 },
          { sessionID: 'body-only', messageID: 'exact-body-only', title: 'needle body only', directory: '/global/body-only', snippet: 'needle body only match', role: 'user', createdAt: 12 },
        ] };
        return { status: 200, body };
      } else if (path === '/api/fs/find') {
        req.expect('GET', ['location[directory]', 'query', 'limit', 'type'], ['location[directory]', 'query', 'limit', 'type']);
        if (params.get('location[directory]') !== '/fixture/focus' || !params.get('query').trim() || params.get('limit') !== '40' || params.get('type') !== 'file') throw new Error('File search escaped explicit Focus or changed its wire');
        body = { data: Array.from({ length: 8 }, (_, i) => ({ path: `src/needle-${i}.ts` })) };
      } else throw new Error('Unexpected search fixture route: ' + path);
      calls.push({ path, query: params.get('search') || params.get('query') || '', directory: params.get('location[directory]') || '', method: req.method });
      return { status: 200, body };
    } catch (error) { rejected++; throw error; }
  } };
}
