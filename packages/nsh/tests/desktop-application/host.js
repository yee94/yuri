import { createDesktopJournalHost } from '../desktop-journal-host.js';
import { createDesktopWriterHost } from '../desktop-writer-host.js';
/** Production-root integration uses only synthetic records; unknown calls fail. */
export function createHost(player) {
  const journal = createDesktopJournalHost();
  let selected = 'desktop-fixture', lease = 0;
  const connections = [{ id: 'desktop-fixture', label: 'Synthetic desktop Host', url: 'https://host.example', authorizationID: 'synthetic-desktop-authorization', lastUsedAt: 0 }, { id: 'other-fixture', label: 'Other synthetic Host', url: 'https://other.example', authorizationID: 'synthetic-other-authorization', lastUsedAt: 0 }];
  const snapshot = () => ({ selected, connections, runtimeScope: { hostID: selected, lease: 'desktop-fixture-lease-' + lease } });
  const writer = createDesktopWriterHost(snapshot);
  let appearanceRevision = 0;
  return { writer, async call(name, input = {}) {
    if (Object.prototype.hasOwnProperty.call(journal.handlers, name)) return journal.handlers[name](input);
    if (Object.prototype.hasOwnProperty.call(writer.handlers, name)) return writer.handlers[name](input);
    const directory = selected === 'desktop-fixture' ? '/fixture/project' : '/other/project';
    const project = { id: selected === 'desktop-fixture' ? 'desktop-project' : 'other-project', name: selected === 'desktop-fixture' ? 'Desktop project' : 'Other project', path: directory };
    if (name === 'appearance.reset') return { revision: ++appearanceRevision };
    if (name === 'appearance.apply') return { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [] };
    if (name === 'native.diagnostics.status') return { enabled: false };
    if (name === 'notification.status') return { authorization: 'notDetermined', delivery: 'local', backgroundDelivery: false };
    if (name === 'notification.launch.peek') return null;
    if (name === 'connection.list') return snapshot();
    if (name === 'connection.select') {
      if (!connections.some(connection => connection.id === input.id)) throw new Error('Unknown synthetic Host');
      selected = input.id; lease++; return snapshot();
    }
    if (name === 'runtime.stream' || name === 'runtime.stop') return true;
    if (name === 'desktop.window.closeDecision') return true;
    if (name !== 'runtime.request') throw new Error('Unexpected synthetic desktop call: ' + name);
    if (JSON.stringify(input.expectedHost) !== JSON.stringify(snapshot().runtimeScope)) throw new Error('Wrong synthetic desktop authority');
    const path = input.path.split('?')[0];
    const ok = body => ({ status: 200, body });
    if (input.method !== 'GET' && !(path === '/api/config/commands/metadata' && input.method === 'POST' && JSON.stringify(input.body) === '{"catalog":true}')) throw new Error('Unexpected synthetic desktop mutation: ' + path);
    if (path === '/api/config/settings') {
      if (input.method !== 'GET') throw new Error('Unexpected synthetic settings write');
      return ok({ projects: [project], setupTour: { completed: true } });
    }
    if (path === '/api/yuri/session-index') return ok({ available: true, pinnedSessionIds: [], directories: [{ directory, sessions: [], hasMore: false }] });
    if (path === '/api/yuri/assistants/snapshot') return ok({ assistants: [] });
    if (path === '/api/yuri/scheduled-tasks') return ok({ tasks: [], failedProjectIds: [] });
    if (path === '/api/session/active') return ok({});
    if (path === '/api/permission' || path === '/api/form') return ok({ data: [] });
    if (path === '/api/session-folders/order') return ok({ revision: 1, sessionOrderByScope: {}, sessionOrderActivityByScope: {} });
    if (path === '/api/session-folders') return ok({ version: 1, foldersMap: {}, collapsedFolderIds: [], updatedAt: 1 });
    if (path === '/api/yuri/message-queue/worktrees/order') return ok({ projectDirectory: directory, revision: 1, orderedPaths: [] });
    if (path === '/api/git/check') return ok({ isGitRepository: true });
    if (path === '/api/git/branches') return ok({ current: 'main', all: ['main'] });
    if (path === '/api/git/worktrees') return ok([{ path: directory, name: 'main', branch: 'main' }]);
    if (path === '/api/git/status') return ok({ isClean: true, files: [] });
    if (path === '/api/config/opencode') return ok({ config: {}, path: '/fixture/config/opencode.json' });
    if (path === '/api/config/themes') return ok({ themes: [] });
    if (path === '/api/fs/list') {
      const requested = decodeURIComponent(input.path.match(/[?&]path=([^&]*)/)?.[1] ?? '');
      const canonicalRead = '/api/fs/list?path=' + encodeURIComponent(directory);
      const panelRead = '/api/fs/list?directory=' + encodeURIComponent(directory) + '&path=' + encodeURIComponent(directory) + '&respectGitignore=';
      if (requested !== directory || ![canonicalRead, panelRead + 'true', panelRead + 'false'].includes(input.path)) throw new Error('Unknown synthetic directory');
      return ok({ path: requested, entries: [{ name: 'readme.md', path: requested + '/readme.md', isDirectory: false }] });
    }
    if (path === '/api/fs/home') return ok({ home: '/fixture/home' });
    if (path === '/api/fs/read') return ok('');
    if (path === '/api/config/catalog/providers') return ok({ schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture', models: { model: { id: 'model', name: 'Fixture model' } } }] });
    if (path === '/api/agent') return ok({ data: [{ name: 'build', mode: 'primary' }] });
    if (path === '/api/command' || path === '/api/skill') return ok({ data: [] });
    if (path === '/api/config/commands/metadata') return ok({ commands: [] });
    if (path === '/api/config/skills') return ok({ skills: [] });
    if (path === '/api/magic-prompts') return ok({ version: 1, overrides: {} });
    if (path === '/api/session') {
      if (input.method !== 'GET') throw new Error('Opening a desktop draft must not create a session');
      if (input.path.includes('archived=true')) return ok({ data: [{ id: 'archive-b', title: 'Archived workspace B', directory: '/workspace-b', time: { archived: 1 } }] });
      return ok({ data: [] });
    }
    if (path === '/api/session/archive-b') {
      if (!input.path.includes('directory=%2Fworkspace-b')) throw new Error('Archive preview used the settings entry directory');
      return ok({ id: 'archive-b', title: 'Archive B directory verified', directory: '/workspace-b', time: { archived: 1 } });
    }
    if (path === '/api/session/archive-b/message') return ok({ messages: [], cursor: { next: null } });
    if (path === '/api/yuri/content-search') return ok({ hits: [] });
    if (path === '/api/fs/find') {
      const location = decodeURIComponent(input.path.match(/[?&]location%5Bdirectory%5D=([^&]*)/)?.[1] ?? '');
      if (location !== directory) throw new Error('Search used the wrong effective directory');
      return ok({ data: [{ path: 'desktop-search-proof.txt', type: 'file' }] });
    }
    throw new Error('Unexpected synthetic desktop request: ' + path);
  } };
}
