import { createHost as createBaseHost } from './tests/new-session-host.js';
import { createDesktopWriterHost } from './tests/desktop-writer-host.js';

export function createHost() {
  const base = createBaseHost();
  const writer = createDesktopWriterHost(() => base.call('connection.list', {}));
  let requests = 0;
  return {
    call(name, input) {
      if (Object.prototype.hasOwnProperty.call(writer.handlers, name)) return writer.handlers[name](input);
      if (name === 'runtime.request') {
        const path = input.path.split('?')[0];
        if (path === '/api/fs/list') {
          const directory = decodeURIComponent(input.path.match(/[?&]path=([^&]*)/)?.[1] ?? '');
          if (input.method !== 'GET' || !['/fixture/project', '/fixture/project/tree'].includes(directory)) throw new Error('Unknown synthetic directory');
          return { status: 200, body: { path: directory, entries: [] } };
        }
        if (path === '/__fixture/new-session/stats') {
          const result = base.call(name, input);
          return { ...result, body: { ...result.body, requests } };
        }
        requests++;
        if (path === '/api/git/check') return { status: 200, body: { isGitRepository: true } };
        if (path === '/api/git/branches') return { status: 200, body: { current: input.path.includes(encodeURIComponent('/fixture/project/tree')) ? 'topic/native' : 'main', all: ['main', 'topic/native'] } };
        if (path === '/api/git/worktrees') return { status: 200, body: [{ path: '/fixture/project', branch: 'main', name: 'main' }, { path: '/fixture/project/tree', branch: 'topic/native', name: 'native' }] };
        if (path === '/api/config/commands/metadata' || path === '/api/config/skills') input = { ...input, path: input.path.replace(encodeURIComponent('/fixture/project/tree'), encodeURIComponent('/fixture/project')) };
      }
      return base.call(name, input);
    },
  };
}
