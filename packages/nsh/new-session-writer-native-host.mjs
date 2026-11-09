import { createHost as createDraftHost } from './tests/new-session-host.js';
import { createDesktopWriterHost } from './tests/desktop-writer-host.js';

/** Named main producer, unchanged capability shape. Never add a support flag. */
export function createHost(player) {
  const base = createDraftHost(), snapshot = base.call('connection.list');
  const writers = createDesktopWriterHost(() => snapshot);
  let mode = '', creates = 0, prompts = 0, releaseAcquire, releaseResolve;
  const publish = () => player.hostEvent('fixture.writer.audit', { names: writers.calls.map(row => row.name), held: writers.held().map(row => ({ kind: row.target.kind, id: row.target.id, ownerID: row.ownerID })), creates, prompts });
  return {
    async call(name, input) {
      try {
        if (name === 'fixture.newSessionWriter.control') {
          if (Object.keys(input).join(',') !== 'action') throw new Error('Invalid writer fixture control');
          if (input.action === 'release-acquire') { releaseAcquire?.(); releaseAcquire = undefined; mode = ''; }
          else if (input.action === 'release-resolve') { releaseResolve?.(); releaseResolve = undefined; mode = ''; }
          else if (input.action !== 'audit') mode = input.action;
          return { ok: true };
        }
        if (name in writers.handlers) {
          if (name === 'desktop.writer.capabilities' && mode === 'no-capability') throw new Error('Synthetic old native build');
          if (name === 'desktop.writer.acquire' && mode === 'conflict') {
            writers.handlers[name]({ ...input, ownerID: 'synthetic-peer-owner' }); mode = '';
          }
          const result = writers.handlers[name](input);
          publish();
          if (name === 'desktop.writer.release' && mode === 'lose-release') throw new Error('Synthetic lost release ACK');
          if (name === 'desktop.writer.acquire') {
            if (mode === 'hold-acquire') await new Promise(resolve => { releaseAcquire = resolve; });
            else if (mode === 'lose-acquire' || mode === 'lose-session' && input.target.kind === 'session') throw new Error('Synthetic lost acquire ACK');
          }
          return result;
        }
        if (name === 'runtime.request') {
          const path = input.path.split('?')[0], method = input.method ?? 'GET';
          if (path === '/api/fs/list' && method === 'GET') {
            if (mode === 'hold-resolve') await new Promise(resolve => { releaseResolve = resolve; });
            if (mode === 'fail-resolve') throw new Error('Synthetic failed canonical read');
            return { status: 200, body: { path: '/fixture/project', entries: [] } };
          }
          if (method !== 'GET') {
            if (path === '/api/session') writers.assertWrite(input, { kind: 'new-session', id: input.body.location.directory });
            else if (path.startsWith('/api/session/')) writers.assertWrite(input, { kind: 'session', id: decodeURIComponent(path.slice('/api/session/'.length).split('/')[0]) });
          }
          if (path === '/api/session' && method === 'POST') {
            creates++;
            const result = base.call(name, input);
            if (mode === 'lose-create') throw new Error('Synthetic lost create ACK');
            return result;
          }
          if (path.endsWith('/prompt') && method === 'POST') prompts++;
        }
        return base.call(name, input);
      } finally { publish(); }
    },
  };
}
