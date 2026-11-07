/** Isolated in-memory Host. Unknown requests fail closed; no real filesystem, Git, process, or network. */
import { fixtureRequest } from './new-session-request.js';

export function createHost(options = {}) {
  const project = { id: 'catalog-do-not-use', path: '/fixture/root', label: 'Project settings fixture', unknown: { retained: true } };
  const file = '/fixture/host-home/.config/yuri/projects/path_L2ZpeHR1cmUvcm9vdA.json';
  let config = { version: 1, projectPath: project.path, scheduledTasks: [{ id: 'server-owned' }], draftStarters: [{ id: 'preserved' }], unknown: { retained: true }, projectActions: [{ id: 'serve', name: 'Serve fixture', command: 'fixture-only command', icon: 'rocket', autoOpenUrl: true, openUrl: 'http://fixture.invalid', desktopOpenSshForward: 'preserved-forward', platforms: ['linux'], extra: 7 }], projectActionsPrimaryId: 'serve', 'setup-worktree': ['fixture setup one', 'fixture setup two'], 'setup-worktree-wait': true };
  let writes = 0, commits = 0, rejectedRequests = 0, auditSequence = 0, writeFailures = options.writeFailures ?? 1, readbackFailures = options.readbackFailures ?? 1, readback = false;
  const requests = [];
  return {
    inspect: () => ({ config, writes, requests }),
    replace: next => { config = next; },
    call(name, input) {
      if (name === 'projectSettings.fixture.audit') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Unexpected project settings audit arguments');
        return { writes, commits, rejectedRequests, auditSequence: ++auditSequence, actionCount: config.projectActions.length, commands: [...config['setup-worktree']], wait: config['setup-worktree-wait'] };
      }
      if (name !== 'runtime.request') { rejectedRequests++; throw new Error('Unexpected project settings native call: ' + name); }
      try {
        const route = fixtureRequest(input), { path, method, params } = route, { body } = input;
        requests.push({ path: input.path, method, body });
        const scoped = () => { if (params.get('directory') !== project.path) throw new Error('Unexpected project settings directory'); };
        if (path === '/api/config/settings') { route.expect('GET'); return { status: 200, body: { projects: [project, { id: 'other', path: '/fixture/other', label: 'Unrelated project' }] } }; }
        if (path === '/api/config/catalog/providers') { route.expect('GET', ['directory'], ['directory']); scoped(); return { status: 200, body: { schemaVersion: 1, providers: [] } }; }
        if (path === '/api/git/check') { route.expect('GET', ['directory'], ['directory']); scoped(); return { status: 200, body: { isGitRepository: true } }; }
        if (path === '/api/fs/home') { route.expect('GET'); return { status: 200, body: { home: '/fixture/host-home' } }; }
        if (path === '/api/fs/read') {
          route.expect('GET', ['path', 'directory'], ['path', 'directory']); scoped();
          if (params.get('path') !== file) throw new Error('Unexpected project settings file read');
          if (readback && readbackFailures > 0) { readbackFailures--; return { status: 503, body: { error: 'Fixture read-back unavailable' } }; }
          readback = false;
          return { status: 200, body: JSON.stringify(config) };
        }
        if (path === '/api/fs/write') {
          route.expect('POST', ['directory'], ['directory']); scoped();
          if (body.path !== file) throw new Error('Project settings escaped its root path identity');
          const next = JSON.parse(body.content);
          if (next.version !== 1 || next.scheduledTasks?.[0]?.id !== 'server-owned' || next.draftStarters?.[0]?.id !== 'preserved' || next.unknown?.retained !== true) throw new Error('Project settings erased unrelated or server-owned config');
          writes++;
          if (writeFailures > 0) { writeFailures--; return { status: 409, body: { error: 'Fixture project configuration conflict' } }; }
          config = next; commits++; readback = true;
          return { status: 200, body: { success: true, path: file } };
        }
        throw new Error('Unexpected project settings request: ' + method + ' ' + path);
      } catch (error) { rejectedRequests++; throw error; }
    },
  };
}
