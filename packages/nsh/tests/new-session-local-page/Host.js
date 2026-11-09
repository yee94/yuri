import { createHost } from '../new-session-host.js';
import { createDesktopWriterHost } from '../desktop-writer-host.js';

const hostID = 'new-session-fixture', directory = '/fixture/project';
const authority = JSON.stringify([hostID, 'https://host.example', null]);
export const sourceKey = 'nsh:chat-draft:v1:' + encodeURIComponent(JSON.stringify([hostID, directory, 'session', 'new-session-draft', authority]));
export const attachment = { uri: 'attachment://keep', name: 'keep.txt', mime: 'text/plain' };
export const draftRecord = text => JSON.stringify({ version: 1, revision: 1, draft: text, references: [], attachments: [attachment], pendingSend: null, queueEdit: null, context: { kind: 'checks', instructionsText: 'retained context', payloadText: '{}' } });
export function createLocalPageHost() {
  const base = createHost(), rejected = [], requests = [];
  const snapshot = base.call('connection.list'), writers = createDesktopWriterHost(() => snapshot);
  let releaseMagic;
  const call = (name, input) => {
    try {
      if (name === 'runtime.request') {
        requests.push(JSON.parse(JSON.stringify(input)));
        if (input.path.startsWith('/api/fs/list?')) return { status: 200, body: { path: directory, entries: [] } };
        if (input.method && input.method !== 'GET') {
          const path = input.path.split('?')[0];
          if (path === '/api/session') writers.assertWrite(input, { kind: 'new-session', id: input.body.location.directory });
          else if (path.startsWith('/api/session/')) writers.assertWrite(input, { kind: 'session', id: decodeURIComponent(path.slice('/api/session/'.length).split('/')[0]) });
        }
        if (input.path.startsWith('/api/git/check?')) return { status: 200, body: { isGitRepository: false } };
        if (input.path === '/api/magic-prompts' && releaseMagic === null) return new Promise(resolve => { releaseMagic = () => { releaseMagic = undefined; resolve({ status: 200, body: { version: 1, overrides: {} } }); }; });
      }
      return base.call(name, input);
    } catch (error) { rejected.push(String(error)); throw error; }
  };
  const handlers = { ...writers.handlers, ...Object.fromEntries(['connection.list', 'runtime.request', 'runtime.stream', 'runtime.stop', 'runtime.pickAttachment'].map(name => [name, input => call(name, input)])) };
  return { handlers, requests, rejected,
    stats: () => base.call('runtime.request', { path: '/__fixture/new-session/stats', method: 'GET' }).body,
    loseCreate: () => base.call('runtime.request', { path: '/__fixture/new-session/lose-create', method: 'GET' }),
    holdMagic: () => { releaseMagic = null; },
    magicWaiting: () => typeof releaseMagic === 'function',
    resolveMagic: () => releaseMagic?.(),
  };
}
