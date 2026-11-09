import { createDesktopJournalHost } from '../desktop-journal-host.js';
import { createDesktopWriterHost } from '../desktop-writer-host.js';
/** Independent production-root Host. Unknown GETs and every mutation fail loudly.
 * No delegation to the existing host.js (which has legacy auth and permissive shapes). */
export const navigationIdentity = Object.freeze({ hostID: 'navigation-root', origin: 'https://navigation.example', authorizationID: 'navigation-auth', lease: 'navigation-native-lease',
  projectID: 'actual-project', directory: '/fixture/actual', decoy: '/fixture/decoy', chosenID: 'chosen-project', chosen: '/fixture/chosen', sessionID: 'ses_saved' });
export const navigationOtherIdentity = Object.freeze({ ...navigationIdentity, hostID: 'navigation-other', origin: 'https://other.navigation.example', authorizationID: 'navigation-other-auth', lease: 'navigation-other-lease' });
export function isNavigationReadOnlyGoalRPC(input) {
  return input.method === 'POST' && input.path === '/api/rpc/opencode.goal/get?location%5Bdirectory%5D=' + encodeURIComponent(navigationIdentity.directory)
    && input.body !== null && typeof input.body === 'object' && !Array.isArray(input.body) && Object.keys(input.body).length === 1
    && input.body.input !== null && typeof input.body.input === 'object' && !Array.isArray(input.body.input) && Object.keys(input.body.input).length === 1
    && input.body.input.sessionID === navigationIdentity.sessionID;
}
export function createNavigationHost() {
  let id = { ...navigationIdentity };
  const identities = [{ ...navigationIdentity }, { ...navigationOtherIdentity }];
  const projects = [{ id: 'decoy-project', name: 'Decoy project', path: id.decoy }, { id: id.projectID, name: 'Actual project', path: id.directory }, { id: id.chosenID, name: 'Chosen project', path: id.chosen }];
  const session = { id: id.sessionID, title: 'Saved exact conversation', location: { directory: id.directory }, time: { created: 1, updated: 2, archived: 0 }, execution: { type: 'idle' }, model: { providerID: 'fixture', modelID: 'model' }, agent: 'build' };
  let appearanceRevision = 0, lookupStatus = 200;
  const reads = [], readonlyRPCs = [], mutations = [], rejected = [], storage = [], decisions = [];
  const fail = (message, detail) => { rejected.push({ message, detail }); throw new Error(message); };
  const ok = body => ({ status: 200, body });
  const settings = { projects, setupTour: { completed: true }, notifications: { nativeNotificationsEnabled: false }, lastDirectory: id.decoy, activeProjectId: 'decoy-project' };
  const writer = createDesktopWriterHost(snapshot);
  const validDirectory = value => [undefined, null, '', id.directory, id.decoy, id.chosen].includes(value);
  function parse(input) {
    const [path, raw = ''] = input.path.split('?'), params = new Map();
    for (const pair of raw.split('&').filter(Boolean)) { const [key, value = ''] = pair.split('='); const name = decodeURIComponent(key); if (params.has(name)) fail('Duplicate query field', input); params.set(name, decodeURIComponent(value)); }
    if (!validDirectory(params.get('directory'))) fail('Wrong synthetic directory', input);
    return { path, params };
  }
  function read(input) {
    if (input.expectedHost && (input.expectedHost.hostID !== id.hostID || input.expectedHost.lease !== id.lease)) return fail('Wrong captured native scope', input);
    if (isNavigationReadOnlyGoalRPC(input)) {
      if (!input.expectedHost) return fail('Read-only Goal RPC lacks native scope', input);
      readonlyRPCs.push(input); return ok({ output: null });
    }
    if (input.method !== 'GET') { mutations.push(input); return fail('Navigation must not create, send or mutate', input); }
    if (input.body !== undefined) return fail('Unexpected GET body', input);
    reads.push(input);
    const { path, params } = parse(input), directory = params.get('directory') || id.directory;
    if (path === '/api/github/auth/status') {
      if (!input.expectedHost || params.size) return fail('GitHub status lacks exact Host or has invented query', input);
      return ok({ connected: false, accounts: [] });
    }
    if (['/api/system/info', '/api/system/update', '/api/opencode/upgrade-status'].includes(path)) {
      if (!input.expectedHost || params.size || input.body !== undefined) return fail('Invalid shared version read', input);
      return ok(path === '/api/system/info' ? { yuriVersion: '2.3.0' }
        : path === '/api/opencode/upgrade-status' ? { serveVersion: '2.3.0' }
        : { supported: false, host: 'cli', serverId: 'synthetic-server', currentVersion: '2.3.0', available: false, checkError: null, update: null, operation: null });
    }
    if (path === '/api/config/settings') return ok(settings);
    if (path === '/api/config/themes') return ok({ themes: [] });
    if (path === '/api/config/opencode') return ok({ config: {}, path: '/fixture/config/opencode.json' });
    if (path === '/api/yuri/session-index') return ok({ available: true, pinnedSessionIds: [], directories: projects.map(project => ({ directory: project.path, sessions: project.id === id.projectID ? [session] : [], hasMore: false })) });
    if (path === '/api/yuri/assistants/snapshot') return ok({ enabled: true, revision: 1, assistants: [] });
    if (path === '/api/yuri/assistants/capability') return ok({ supported: true, enabled: true });
    if (path === '/api/yuri/scheduled-tasks') return ok({ tasks: [], failedProjectIds: [] });
    if (path === '/api/debug/location') return ok([]);
    if (path === '/api/session/active') return ok({});
    if (path === '/api/permission' || path === '/api/permission/request' || path === '/api/form') return ok({ data: [] });
    if (path === '/api/session-folders/order') return ok({ revision: 1, sessionOrderByScope: {}, sessionOrderActivityByScope: {} });
    if (path === '/api/session-folders') return ok({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 1 });
    if (path === '/api/yuri/message-queue/worktrees/order') {
      const projectDirectory = params.get('projectDirectory');
      if (!projects.some(project => project.path === projectDirectory)) return fail('Wrong worktree order project', input);
      return ok({ projectDirectory, revision: 1, orderedPaths: [] });
    }
    if (path === '/api/git/check') return ok({ isGitRepository: true });
    if (path === '/api/git/branches') return ok({ current: 'main', all: ['main'] });
    if (path === '/api/git/worktrees') return ok([{ path: directory, name: 'main', branch: 'main' }]);
    if (path === '/api/git/status') return ok({ isClean: true, files: [] });
    if (path === '/api/fs/list') {
      const actual = params.get('path');
      if (![id.directory, id.chosen, id.decoy].includes(actual)) return fail('Unexpected directory stat/list target', input);
      return ok({ path: actual, entries: [{ name: 'readme.md', path: actual + '/readme.md', isDirectory: false, isFile: true }] });
    }
    if (path === '/api/fs/home') return ok({ home: '/fixture/home' });
    if (path === '/api/fs/read') {
      const files = ['L2ZpeHR1cmUvYWN0dWFs', 'L2ZpeHR1cmUvY2hvc2Vu', 'L2ZpeHR1cmUvZGVjb3k'].map(value => '/fixture/home/.config/yuri/projects/path_' + value + '.json');
      files.push(...projects.map(project => project.path + '/.yuri/yuri.json'));
      if (params.get('optional') !== 'true' || !files.includes(params.get('path'))) return fail('Unexpected project metadata file', input);
      return ok('');
    }
    if (path === '/api/config/catalog/providers') return ok({ schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture', models: { model: { id: 'model', name: 'Fixture model' } } }] });
    if (path === '/api/agent') return ok({ data: [{ name: 'build', mode: 'primary' }] });
    if (path === '/api/command' || path === '/api/skill') return ok({ data: [] });
    if (path === '/api/config/commands/metadata') return ok({ commands: [] });
    if (path === '/api/config/skills') return ok({ skills: [] });
    if (path === '/api/magic-prompts') return ok({ version: 1, overrides: {} });
    if (path === '/api/session') return ok({ data: [], cursor: { next: null } });
    if (path === '/api/session/' + id.sessionID) {
      if (params.get('directory') !== id.directory) return fail('Exact session lookup used guessed directory', input);
      if (!input.expectedHost) return fail('Restore lookup lacks native scope', input);
      return lookupStatus === 200 ? ok(session) : { status: lookupStatus, body: { error: 'Do not display /private/path or raw content' } };
    }
    if (path === '/api/session/' + id.sessionID + '/message') return ok({ data: [{ id: 'msg_history', role: 'assistant', parts: [{ type: 'text', text: 'Verified saved session transcript' }], time: { created: 2, completed: 3 } }], cursor: { next: null } });
    if (['/inbox', '/form', '/permission/request'].some(suffix => path === '/api/session/' + id.sessionID + suffix)) return ok([]);
    if (path === '/api/yuri/content-search') return ok({ hits: [] });
    return fail('Unexpected navigation root GET ' + path, input);
  }
  const handlers = {
    ...createDesktopJournalHost().handlers,
    ...writer.handlers,
    'connection.list': snapshot,
    'connection.select': input => {
      const next = identities.find(value => value.hostID === input.id);
      if (!next || Object.keys(input).length !== 1) return fail('Unexpected native Host selection', input);
      id = { ...next }; return snapshot();
    },
    'runtime.request': read,
    'runtime.stream': () => true, 'runtime.stop': () => true,
    'appearance.reset': () => ({ revision: ++appearanceRevision }),
    'appearance.apply': () => ({ uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [] }),
    'native.diagnostics.status': () => ({ enabled: false }),
    'notification.status': () => ({ authorization: 'notDetermined', delivery: 'local', backgroundDelivery: false }),
    'notification.launch.peek': () => null,
    'navigation.test.storage': event => { storage.push(event); },
    'desktop.window.closeDecision': decision => { decisions.push(decision); return true; },
  };
  function snapshot() {
    return { selected: id.hostID, connections: identities.map(value => ({ id: value.hostID, url: value.origin, authorizationID: value.authorizationID, label: value.hostID === navigationIdentity.hostID ? 'Navigation test Host' : 'Other navigation Host', lastUsedAt: 1 })), runtimeScope: { hostID: id.hostID, lease: id.lease } };
  }
  return { handlers, reads, readonlyRPCs, mutations, rejected, storage, decisions, writer,
    failLookup(status) { lookupStatus = status; },
    rotateLease() { id = { ...id, lease: 'navigation-renewed-lease' }; Object.assign(identities.find(value => value.hostID === id.hostID), id); },
    rotateAuthorization() {
      id = { ...id, authorizationID: 'navigation-rotated-auth', lease: 'navigation-rotated-lease' };
      Object.assign(identities.find(value => value.hostID === id.hostID), id);
    },
  };
}
