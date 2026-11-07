import { fixtureRequest } from './new-session-request.js';

/** Read-only authority for the production catalog, Chat draft owner and header. */
export function createHost() {
  const requests = [];
  let rejected = 0, mode = 'ready';
  const directory = '/workspace/second';
  const sessions = [
    { id: 'ses_a', title: 'First conversation', location: { directory }, time: { updated: 20 } },
    { id: 'ses_b', title: 'Second conversation', location: { directory }, time: { updated: 10 } },
  ];
  return { call(name, input) {
    try {
      if (name === 'sessionSwitcher.fixture.audit') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Invalid audit');
        return { requests: requests.map(row => ({ ...row })), rejected };
      }
      if (name === 'sessionSwitcher.fixture.scenario') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'mode' || !['ready', 'fail-page', 'compacted', 'empty', 'fail-index'].includes(input.mode)) throw new Error('Invalid scenario');
        mode = input.mode; return true;
      }
      if (name === 'runtime.stream') {
        if (!input || input.key !== 'chat' || input.path !== '/api/event?directory=%2Fworkspace%2Fsecond' || Object.keys(input).length !== 2) throw new Error('Invalid stream scope');
        return true;
      }
      if (name === 'runtime.stop') {
        if (!input || input.key !== 'chat' || Object.keys(input).length !== 1) throw new Error('Invalid stream stop');
        return true;
      }
      if (name !== 'runtime.request' || !input || Object.keys(input).some(key => !['path', 'method'].includes(key))) throw new Error('Unexpected fixture call or body');
      if (typeof input.path !== 'string' || input.path.endsWith('?')) throw new Error('Invalid empty query');
      const req = fixtureRequest(input), { path, params } = req;
      if (req.method !== 'GET') throw new Error('Session switcher fixture must not mutate Host');
      let body;
      if (path === '/api/yuri/session-index') {
        req.expect('GET', [], []);
        if (mode === 'fail-index') return { status: 503, body: { message: 'Synthetic index unavailable' } };
        body = { available: true, pinnedSessionIds: [], directories: [{ directory, sessions, hasMore: false }, { directory: '/workspace/first', sessions: [], hasMore: false }] };
      } else if (path === '/api/session-folders/order') {
        req.expect('GET', [], []); body = { revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} };
      } else if (path === '/api/session/active') {
        req.expect('GET', [], []); body = { data: {} };
      } else if (path === '/api/git/worktrees' || path === '/api/yuri/message-queue/worktrees/order') {
        const key = path === '/api/git/worktrees' ? 'directory' : 'projectDirectory';
        req.expect('GET', [key], [key]);
        if (!['/workspace/first', directory].includes(params.get(key))) throw new Error('Unknown project directory');
        body = key === 'directory' ? [] : { projectDirectory: params.get(key), revision: 0, orderedPaths: [] };
      } else if (path === '/api/config/settings' || path === '/api/quota/providers') {
        req.expect('GET', [], []); body = path === '/api/config/settings' ? {} : { providers: [] };
      } else if (path === '/api/quota/magpie') {
        req.expect('GET', ['directory', 'refresh'], ['directory']);
        if (params.get('directory') !== directory || params.has('refresh') && params.get('refresh') !== '1') throw new Error('Invalid quota scope');
        body = { sources: [] };
      } else if (path === '/api/config/catalog/providers') {
        req.expect('GET', ['directory'], ['directory']);
        if (params.get('directory') !== directory) throw new Error('Catalog guessed the first/recent project');
        body = { schemaVersion: 1, providers: [{ id: 'fixture', models: { model: { id: 'model', limit: { context: 400000, output: 32000 } } } }] };
      } else if (path === '/api/git/status') {
        req.expect('GET', ['directory', 'mode'], ['directory', 'mode']);
        if (params.get('directory') !== directory || params.get('mode') !== 'light') throw new Error('Invalid Git metadata scope');
        body = { current: 'feature/second', isGitRepository: true, files: [] };
      } else if (path === '/api/permission/request') {
        req.expect('GET', ['directory'], ['directory']);
        if (params.get('directory') !== directory) throw new Error('Invalid permission scope');
        body = { data: [] };
      } else if (/^\/api\/session\/ses_[ab](?:\/(?:message|inbox|form))?$/.test(path)) {
        const id = path.split('/')[3], suffix = path.split('/')[4];
        req.expect('GET', suffix === 'message' ? ['directory', 'limit', 'order'] : ['directory'], suffix === 'message' ? ['directory', 'limit', 'order'] : ['directory']);
        if (params.get('directory') !== directory || suffix === 'message' && (params.get('limit') !== '20' || params.get('order') !== 'desc')) throw new Error('Invalid Chat scope/page budget');
        if (suffix === 'message' && mode === 'fail-page') return { status: 503, body: { message: 'Synthetic page unavailable' } };
        body = !suffix ? { data: { id, title: sessions.find(row => row.id === id).title, model: { id: 'model', providerID: 'fixture' }, execution: { type: 'idle' } } }
          : suffix !== 'message' ? { data: [] }
          : { data: mode === 'empty' ? [] : [
            ...(mode === 'compacted' ? [{ id: 'compact', type: 'assistant', clientRole: 'compaction', status: 'completed', content: [{ type: 'compaction', status: 'completed' }] }] : []),
            { id: 'answer', type: 'assistant', tokens: { input: 28000, output: 900 }, content: [{ type: 'text', text: 'Synthetic answer' }] },
            { id: 'question', type: 'user', model: { id: 'model', providerID: 'fixture' }, content: [{ type: 'text', text: 'Synthetic question' }] },
          ], complete: true };
      } else throw new Error('Unexpected fixture route: ' + path);
      requests.push({ path: input.path, method: req.method });
      return { status: 200, body };
    } catch (error) { rejected++; throw error; }
  } };
}
