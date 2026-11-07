/** Production navigation fixture; no real Host, history, credentials or model calls. */
import { createHost as baseHost } from './host.js';

export function createHost() {
  const base = baseHost();
  const older = { id: 'focus-older', type: 'user', time: { created: 1000 }, content: [{ type: 'text', text: 'Exact older search target' }] };
  const latest = { id: 'focus-latest', type: 'user', time: { created: 2000 }, content: [{ type: 'text', text: 'Latest row is not the search target' }] };
  const firstPage = [latest, ...Array.from({ length: 19 }, (_, index) => ({ id: `focus-recent-${index}`, type: 'user', time: { created: 1990 - index }, content: [{ type: 'text', text: `Neutral recent row ${index}` }] }))];
  let pages = 0;
  return { call(name, input) {
    if (name === 'speech.prepare') return { visible: false, provider: 'browser', mode: 'final' };
    if (['speech.stop', 'speech.release'].includes(name)) return true;
    if (name === 'runtime.request') {
      const path = input.path;
      if (path.startsWith('/api/yuri/message-queue/worktrees/order?')) return { status: 200, body: { projectDirectory: '/workspace/project', revision: 0, orderedPaths: [] } };
      if (path.startsWith('/api/session?')) return { status: 200, body: { data: [{ id: 'ses_1', title: 'Native conversation', directory: '/workspace/project' }] } };
      if (path.startsWith('/api/yuri/content-search?')) return { status: 200, body: { hits: [{ sessionID: 'ses_1', messageID: older.id, title: 'Native conversation', directory: '/workspace/project', snippet: 'Exact older search target', role: 'user', createdAt: older.time.created }] } };
      if (path.startsWith('/api/session/ses_1/message?')) {
        if (path.includes('cursor=')) { pages++; return { status: 200, body: { data: [older], cursor: { next: null } } }; }
        return { status: 200, body: { data: firstPage, cursor: { next: 'opaque target ?/+' } } };
      }
      if (path.startsWith('/api/git/status?')) return { status: 200, body: { isClean: true, files: [], current: `Search pages:${pages}` } };
    }
    return base.call(name, input);
  } };
}
