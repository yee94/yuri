import { createHost as createBaseHost } from '../../tests/desktop-application/host.js';

export const previewSession = { id: 'ui-preview-session', title: 'Session UI preview', directory: '/fixture/project', agent: 'build', model: { providerID: 'fixture', id: 'model' }, time: { created: 1, updated: 2 } };
const messages = [
  { id: 'preview-user', type: 'user', text: 'Verify the Session layout without sending a real request.' },
  { id: 'preview-assistant', type: 'assistant', content: [{ type: 'text', text: '## Native Session preview\n\nThis is local sample content, not a real model response.\n\n- Sidebar and session navigation\n- Markdown and composer layout\n\n```ts\nconst preview = "UI only";\n```' }], finish: 'stop', modelID: 'model', providerID: 'fixture' },
];

export function createHost() {
  const base = createBaseHost();
  return { async call(name, input = {}) {
    if (name === 'notification.configure') return { lease: 'preview-notification' };
    if (name === 'notification.launch.peek') return { record: null };
    if (name === 'runtime.request') {
      const path = input.path.split('?')[0];
      if (input.method !== 'GET' && !(path === '/api/config/commands/metadata' && input.method === 'POST' && input.body?.catalog === true)) throw new Error('UI preview does not send or change real data');
      const ok = body => ({ status: 200, body });
      if (path === '/api/config/settings') {
        const response = await base.call(name, input);
        return ok({ ...response.body, themeMode: 'dark', themeId: 'cursor-dark', darkThemeId: 'cursor-dark', lightThemeId: 'jetbrains-light' });
      }
      if (path === '/api/yuri/session-index') return ok({ available: true, pinnedSessionIds: [], directories: [{ directory: previewSession.directory, sessions: [previewSession], hasMore: false }] });
      if (path === '/api/session') return ok({ data: [previewSession], cursor: {} });
      if (path === '/api/session/ui-preview-session') return ok(previewSession);
      if (path === '/api/session/ui-preview-session/message') return ok({ data: messages, cursor: { next: null } });
      if (path === '/api/session/ui-preview-session/inbox' || path === '/api/permission/request' || path === '/api/session/ui-preview-session/form') return ok({ data: [] });
      if (path === '/api/voice/settings') return ok({ dictationEnabled: false });
    }
    return base.call(name, input);
  } };
}
