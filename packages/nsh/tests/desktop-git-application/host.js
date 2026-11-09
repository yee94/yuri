import { createDesktopJournalHost } from '../desktop-journal-host.js';
import { createDesktopWriterHost } from '../desktop-writer-host.js';
/** Independent, offline Host. Every unknown method, route and mutation is rejected. */
export const identity = Object.freeze({ hostID: 'git-application', origin: 'https://git.example', authorizationID: 'synthetic-auth', lease: 'synthetic-lease',
  projectID: 'git-project', directory: '/fixture/git-project', sessionID: 'ses_git_existing' });
export const visible = 'Resolve this captured merge';
export const instructions = 'SYNTHETIC_INSTRUCTIONS_ONLY_NOT_VISIBLE';
export const attachment = Object.freeze({ uri: 'file:///synthetic/retained.txt', name: 'retained.txt', mime: 'text/plain' });
export const authority = JSON.stringify([identity.hostID, identity.origin, identity.authorizationID]);
export const draftKey = (sessionID = 'new-session-draft') => 'nsh:chat-draft:v1:' + encodeURIComponent(JSON.stringify([identity.hostID, identity.directory, 'session', sessionID, authority]));
export const draftRecord = (text, attachments = []) => JSON.stringify({ version: 1, revision: 1, draft: text, references: [], attachments, pendingSend: null, queueEdit: null });
export function createGitHost() {
  const id = identity, project = { id: id.projectID, name: 'Git application project', path: id.directory };
  const session = { id: id.sessionID, title: 'Existing Git conversation', location: { directory: id.directory }, time: { created: 1, updated: 2, archived: 0 }, execution: { type: 'idle' },
    model: { providerID: 'fixture', id: 'model', variant: 'high' }, agent: 'build' };
  const pr = { number: 42, title: 'Synthetic application PR', body: 'Captured PR body', url: 'https://git.example/pull/42', state: 'open', draft: false, base: 'main', head: 'feature', headSha: 'abcdef1234567', mergeable: true };
  const reads = [], mutations = [], rejected = [], storage = [];
  let revision = 0, marker = 'CAPTURED_CONFLICT_A', lostPrompt = false;
  const fail = (message, input) => { rejected.push({ message, input }); throw new Error(message); };
  const ok = body => ({ status: 200, body });
  const snapshot = () => ({ selected: id.hostID, connections: [{ id: id.hostID, url: id.origin, authorizationID: id.authorizationID, label: 'Synthetic Git application', lastUsedAt: 1 }], runtimeScope: { hostID: id.hostID, lease: id.lease } });
  const writer = createDesktopWriterHost(snapshot, 'synthetic-git-window');
  const handlers = {
    ...createDesktopJournalHost().handlers,
    ...writer.handlers,
    'connection.list': snapshot,
    'appearance.reset': () => ({ revision: ++revision }),
    'appearance.apply': () => ({ uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [] }),
    'native.diagnostics.status': () => ({ enabled: false }),
    'notification.status': () => ({ authorization: 'notDetermined', alert: 'unsupported', sound: 'unsupported', badge: 'unsupported', backgroundPush: false }),
    'notification.launch.peek': () => null,
    'notification.configure': input => {
      if (input.hostID !== id.hostID || input.enabled !== false || input.mode !== 'hidden-only' || input.language !== 'en') return fail('Unexpected native notification configuration', input);
      return { lease: 'synthetic-notification-lease' };
    },
    'speech.prepare': () => ({ visible: false, provider: 'browser', mode: 'sanitized' }),
    'speech.stop': () => null, 'speech.release': () => null,
    'runtime.stream': () => true, 'runtime.stop': () => true,
    'git.test.storage': event => { storage.push(event); },
    'runtime.request': input => {
      if (!input || typeof input.path !== 'string' || !['GET', 'POST'].includes(input.method) || Object.keys(input).some(key => !['path', 'method', 'body', 'expectedHost', 'writerGrant'].includes(key))) return fail('Invalid synthetic request envelope', input);
      const [path, raw = ''] = input.path.split('?'), params = new Map();
      for (const pair of raw.split('&').filter(Boolean)) {
        const [key, value = ''] = pair.split('='), name = decodeURIComponent(key);
        if (params.has(name)) return fail('Duplicate query field', input);
        params.set(name, decodeURIComponent(value));
      }
      if (input.expectedHost && (input.expectedHost.hostID !== id.hostID || input.expectedHost.lease !== id.lease)) return fail('Wrong captured Host', input);
      if (params.has('directory') && params.get('directory') !== id.directory && !(path === '/api/config/catalog/providers' && params.get('directory') === '')) return fail('Wrong captured directory', input);
      for (const key of ['location[directory]', 'projectDirectory']) if (params.has(key) && params.get(key) !== id.directory && !(path === '/api/agent' && key === 'location[directory]' && params.get(key) === '')) return fail('Wrong scoped query', input);
      if (path === '/api/github/auth/status') {
        if (input.method !== 'GET' || input.body !== undefined || !input.expectedHost || params.size) return fail('Wrong Header auth status read', input);
        reads.push(input); return ok({ connected: false, accounts: [] });
      }
      if ((path.startsWith('/api/git/') || path.startsWith('/api/github/')) && (!input.expectedHost || params.get('directory') !== id.directory)) return fail('Git request lacks captured scope', input);
      const allowedQuery = path.startsWith('/api/git/') ? ['directory', ...(path === '/api/git/status' ? ['mode'] : [])]
        : path === '/api/github/pr/status' ? ['directory', 'branch', 'remote', 'force']
        : path === '/api/github/pulls/context' ? ['directory', 'number', 'diff', 'checkDetails', 'owner', 'repo']
        : path === '/api/github/repo/branches' ? ['directory', 'owner', 'repo']
        : path === '/api/github/repo/upstream' ? ['directory']
        : path === '/api/rpc/opencode.goal/get' || path === '/api/agent' ? ['location[directory]']
        : path === '/api/config/catalog/providers' || path === '/api/magic-prompts' || path === '/api/permission/request' || path === '/api/permission' || path === '/api/form' ? ['directory']
        : path === '/api/session' ? ['directory', 'parentID', 'search', 'limit', 'order', 'archived', ...(params.get('parentID') === id.sessionID ? ['location[directory]'] : [])]
        : path === '/api/session/' + id.sessionID + '/message' ? ['directory', 'limit', 'order']
        : path.startsWith('/api/session/' + id.sessionID) ? ['directory']
        : path === '/api/fs/read' ? ['path', 'optional']
        : path === '/api/fs/list' ? ['path', 'includeHidden']
        : path === '/api/yuri/message-queue/worktrees/order' ? ['projectDirectory'] : [];
      if ([...params.keys()].some(key => !allowedQuery.includes(key))) return fail('Unexpected query field for ' + path + ': ' + [...params.keys()].join(','), input);
      if (path === '/api/rpc/opencode.goal/get' && input.method === 'POST') {
        if (!input.expectedHost || params.size !== 1 || params.get('location[directory]') !== id.directory || JSON.stringify(input.body) !== JSON.stringify({ input: { sessionID: id.sessionID } })) return fail('Invalid read-only Goal RPC', input);
        reads.push(input); return ok({ output: null });
      }
      if (input.method !== 'GET') {
        mutations.push(input);
        if (path !== '/api/session/' + id.sessionID + '/prompt' || input.method !== 'POST') return fail('Unexpected mutation (no create, Git write or model call allowed)', input);
        try { writer.assertWrite(input, { kind: 'session', id: id.sessionID }); }
        catch { return fail('Prompt lacks verified native writer grant', input); }
        if (!input.expectedHost || params.get('directory') !== id.directory) return fail('Prompt lacks exact scope', input);
        const body = input.body;
        if (!body || typeof body.id !== 'string' || !body.id || typeof body.text !== 'string' || !['queue', 'steer'].includes(body.delivery)) return fail('Invalid existing send wire', input);
        if (Object.keys(body).some(key => !['id', 'text', 'delivery', 'files', 'agents', 'skills', 'metadata'].includes(key))) return fail('Git dispatch invented model/send parameters', input);
        if (lostPrompt) throw new Error('SYNTHETIC_PROMPT_ACK_LOST');
        return ok({ id: body.id, sessionID: id.sessionID, type: 'user', text: body.text, delivery: body.delivery, state: 'queued' });
      }
      if (input.body !== undefined) return fail('Unexpected GET body', input);
      reads.push(input);
      if (path === '/api/config/settings') return ok({ projects: [project], setupTour: { completed: true }, nativeNotificationsEnabled: false });
      if (path === '/api/config/themes') return ok({ themes: [] });
      if (path === '/api/config/opencode') return ok({ config: {}, path: '/fixture/config/opencode.json' });
      if (path === '/api/yuri/session-index') return ok({ available: true, pinnedSessionIds: [], directories: [{ directory: id.directory, sessions: [session], hasMore: false }] });
      if (path === '/api/yuri/assistants/snapshot') return ok({ enabled: true, revision: 1, assistants: [] });
      if (path === '/api/yuri/scheduled-tasks') return ok({ tasks: [], failedProjectIds: [] });
      if (path === '/api/debug/location') return ok([]);
      if (path === '/api/session/active') return ok({});
      if (path === '/api/permission' || path === '/api/form') return ok({ data: [] });
      if (path === '/api/session-folders/order') return ok({ revision: 1, sessionOrderByScope: {}, sessionOrderActivityByScope: {} });
      if (path === '/api/session-folders') return ok({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 1 });
      if (path === '/api/yuri/message-queue/worktrees/order') return ok({ projectDirectory: id.directory, revision: 1, orderedPaths: [] });
      if (path === '/api/git/check') return ok({ isGitRepository: true });
      if (path === '/api/git/branches') return ok({ current: 'feature', all: ['feature', 'main'] });
      if (path === '/api/git/worktrees') return ok([{ path: id.directory, name: 'feature', branch: 'feature' }]);
      if (path === '/api/git/remotes') return ok([{ name: 'origin' }]);
      if (path === '/api/git/status') return ok({ isClean: false, current: 'feature', ahead: 1, behind: 0, tracking: 'origin/feature', mergeInProgress: { head: 'main', message: 'Synthetic merge' }, conflicted: ['conflict.txt'], files: [{ path: 'conflict.txt', index: 'U', working_dir: 'U' }] });
      if (path === '/api/git/conflict-details') {
        if (!input.expectedHost || params.get('directory') !== id.directory) return fail('Conflict read lacks exact scope', input);
        return ok({ operation: 'merge', headInfo: marker, unmergedFiles: ['conflict.txt'], diff: marker + '_PRIVATE_DIFF' });
      }
      if (path === '/api/fs/list') {
        if (params.get('path') !== id.directory) return fail('Unexpected list directory', input);
        return ok({ path: id.directory, entries: [{ name: 'conflict.txt', path: id.directory + '/conflict.txt', isFile: true, isDirectory: false }] });
      }
      if (path === '/api/fs/home') return ok({ home: '/fixture/home' });
      if (path === '/api/fs/read') {
        const files = ['/fixture/home/.config/yuri/projects/path_L2ZpeHR1cmUvZ2l0LXByb2plY3Q.json', id.directory + '/.yuri/yuri.json'];
        if (params.size !== 2 || params.get('optional') !== 'true' || !files.includes(params.get('path'))) return fail('Unexpected optional project config read', input);
        return ok('');
      }
      if (path === '/api/config/catalog/providers') return ok({ schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture', models: { model: { id: 'model', name: 'Fixture model', variants: { high: {} } } } }] });
      if (path === '/api/agent') return ok({ data: [{ name: 'build', mode: 'primary' }] });
      if (path === '/api/command' || path === '/api/skill') return ok({ data: [] });
      if (path === '/api/config/commands/metadata') return ok({ commands: [] });
      if (path === '/api/config/skills') return ok({ skills: [] });
      if (path === '/api/magic-prompts') return ok({ version: 1, overrides: { 'git.conflict.resolve.visible': visible, 'git.conflict.resolve.instructions': instructions,
        'github.pr.review.visible': 'Review captured PR 42', 'github.pr.review.instructions': 'PR_SYNTHETIC_INSTRUCTIONS_ONLY' } });
      if (path === '/api/session') {
        if (params.get('parentID') === id.sessionID && (!input.expectedHost || params.get('location[directory]') !== id.directory || params.get('directory') !== id.directory || params.get('limit') !== '200' || params.size !== 4)) return fail('Wrong exact-parent WorkStatus read', input);
        return ok({ data: [], cursor: { next: null } });
      }
      if (path === '/api/session/' + id.sessionID) return ok(session);
      if (path === '/api/session/' + id.sessionID + '/message') return ok({ data: [{ id: 'msg_history', role: 'assistant', text: 'Existing synthetic transcript', time: { created: 2 } }], cursor: { next: null }, complete: true });
      if (path === '/api/permission/request') return ok([]);
      if (['/inbox', '/form', '/permission/request'].some(suffix => path === '/api/session/' + id.sessionID + suffix)) return ok([]);
      if (path === '/api/github/pr/status') return ok({ connected: true, branch: 'feature', repo: { owner: 'synthetic', repo: 'fixture' }, pr, checks: { state: 'failure', total: 1, success: 0, failure: 1, pending: 0 }, canMerge: false, defaultBranch: 'main' });
      if (path === '/api/github/repo/upstream') return ok({ connected: true, isFork: false, upstream: null });
      if (path === '/api/github/repo/branches') return ok({ branches: ['main'] });
      if (path === '/api/github/pulls/context') return ok({ connected: true, pr, issueComments: [{ id: 1, body: 'CAPTURED_PR_COMMENT', author: { login: 'synthetic-reviewer' } }], reviewComments: [], files: [], checkRuns: [], diff: 'CAPTURED_PR_PRIVATE_DIFF' });
      return fail('Unexpected synthetic Git application GET ' + path, input);
    },
  };
  return { handlers, reads, mutations, rejected, storage, writer, setConflict(value) { marker = value; }, losePrompt() { lostPrompt = true; } };
}
export function createHost() {
  const fixture = createGitHost();
  return { call(name, input) {
    if (!Object.prototype.hasOwnProperty.call(fixture.handlers, name)) throw new Error('Unexpected synthetic bridge ' + name);
    return fixture.handlers[name](input);
  } };
}
