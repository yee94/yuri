import { createNavigationHost, navigationIdentity as identity } from '../desktop-application/NavigationHost.js';
export { navigationRecord, draftKey, draftRecord } from '../desktop-commands-application/Host.js';
export { identity };

const directory = encodeURIComponent(identity.directory);
const chosen = encodeURIComponent(identity.chosen);
const historyMessageID = 'changes-history-assistant';
export const historyToolID = 'changes-history-edit';
const patch = '@@ -1 +1 @@\n-BEFORE_CAPTURED_SOURCE\n+AFTER_CAPTURED_SOURCE\n';

/** Strict baseline plus exact, synthetic Changes endpoints. No Git/model I/O. */
export function createChangesApplicationHost(options = {}) {
  const fixture = createNavigationHost(), baseline = fixture.handlers['runtime.request'];
  const requests = [], posts = [], previews = [];
  const fail = (message, detail) => {
    fixture.rejected.push({ message, detail });
    throw new Error(message);
  };
  fixture.handlers['runtime.request'] = input => {
    requests.push(input);
    const exact = input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease;
    const get = path => input.path === path && input.method === 'GET' && input.body === undefined && exact;
    if (input.path === '/api/git/commit?directory=' + chosen) {
      if (!exact || input.method !== 'POST' || JSON.stringify(input.body) !== JSON.stringify({ message: 'Protected Changes draft', files: ['readme.md'], stageFiles: [] })) return fail('Unsafe synthetic commit DTO', input);
      posts.push(input);
      if (options.unknown) throw new Error('Synthetic Changes commit ACK lost');
      return { status: 200, body: { success: true } };
    }
    if (get('/api/git/worktrees?directory=' + directory)) return { status: 200, body: [{ path: identity.directory, name: 'main', branch: 'main' }, { path: identity.chosen, name: 'captured-worktree', branch: 'captured-worktree' }] };
    if ([directory, chosen].some(value => get('/api/git/status?directory=' + value) || get('/api/git/status?directory=' + value + '&mode=light'))) {
      return { status: 200, body: { isGitRepository: true, isClean: false, current: 'captured-source-branch', files: [{ path: 'readme.md', index: 'M', working_dir: ' ' }], diffStats: { 'readme.md': { insertions: 1, deletions: 1 } } } };
    }
    if ([directory, chosen].some(value => get('/api/git/remotes?directory=' + value))) return { status: 200, body: [] };
    if ([directory, chosen].some(value => get('/api/git/diff?directory=' + value + '&path=readme.md&staged=true')
      || get('/api/git/diff?directory=' + value + '&path=readme.md&staged=false'))) return { status: 200, body: { diff: patch } };
    if (get('/api/session/' + identity.sessionID + '/message?directory=' + directory + '&limit=20&order=desc')) {
      return { status: 200, body: { data: [
        { id: historyMessageID, type: 'assistant', time: { created: 2, completed: 3 }, content: [
          { type: 'tool', id: historyToolID, tool: 'edit', state: { status: 'completed', input: { filePath: identity.directory + '/readme.md', oldString: 'BEFORE_CAPTURED_SOURCE', newString: 'AFTER_CAPTURED_SOURCE' }, output: '', metadata: { diff: patch } } },
          { type: 'text', text: 'Actual historical edit payload' },
        ] },
        { id: 'changes-history-user', type: 'user', time: { created: 1 }, model: { providerID: 'fixture', id: 'model' }, content: [{ type: 'text', text: 'Read-only Changes regression' }] },
      ], cursor: { next: null } } };
    }
    const response = baseline(input);
    if (get('/api/config/settings')) return { ...response, body: { ...response.body, projects: response.body.projects.filter(project => project.id === identity.projectID) } };
    return response;
  };
  fixture.handlers['resources.read'] = input => {
    if (Object.keys(input).sort().join(',') !== 'expectedHost,path,requestId' || input.path !== identity.chosen + '/readme.md'
      || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease || typeof input.requestId !== 'string' || !input.requestId) return fail('Wrong captured worktree preview authority', input);
    previews.push(input);
    return { kind: 'text', path: input.path, text: 'AFTER_CAPTURED_SOURCE\n', mime: 'text/plain', lease: 'changes-preview-lease' };
  };
  for (const name of ['resources.close', 'resources.release']) fixture.handlers[name] = input => {
    if (Object.keys(input).join(',') !== 'lease' || input.lease !== 'changes-preview-lease') return fail('Wrong synthetic resource lease', input);
    return true;
  };
  return { ...fixture, requests, posts, previews };
}
