/** Synthetic Host used only by desktop-panel native regression tests. */
export function createHost(player) {
  const stats = { status: 0, diff: 0, history: 0, list: 0, find: 0, file: 0, writes: 0, mutations: 0, reveals: 0, gitRequests: 0, lastGitHost: '', lastWriteHost: '', lastWriteDirectory: '', lastWriteContent: '' };
  const files = new Map();
  const folders = new Set(), removed = new Set();
  let fail = '', lease = 0;
  const publish = () => player.hostEvent('desktop-panel-fixture.stats', { ...stats });
  return { async call(name, input) {
    if (name === 'runtime.request') {
      const path = input.path;
      if (path.startsWith('/fixture/control?')) { fail = path.split('fail=')[1]; return { status: 200, body: true }; }
      if (!['host-a', 'host-b'].includes(input.expectedHost?.hostID)) throw new Error('Missing captured Host scope');
      const at = path.includes('directory=%2Fworktree') ? '/worktree' : '/workspace';
      if (path.startsWith('/api/git/')) { stats.gitRequests++; stats.lastGitHost = input.expectedHost.hostID; publish(); }
      const filePath = path.includes('path=') ? decodeURIComponent(path.split('path=')[1].split('&')[0]) : input.body?.path;
      const key = JSON.stringify([input.expectedHost.hostID, filePath]);
      const value = () => files.get(key) ?? input.expectedHost.hostID + '_SOURCE_BODY';
      const entries = new Map([[at + '/source.ts', false], [at + '/other.ts', false], [at + '/unsafe.bin', false], [at + '/sub', true], [at + '/sub/note.md', false], [at + '/.hidden.md', false], [at + '/ignored', true], [at + '/ignored/inside.ts', false]]);
      for (const id of files.keys()) { const [host, path] = JSON.parse(id); if (host === input.expectedHost.hostID) entries.set(path, false); }
      for (const id of folders) { const [host, path] = JSON.parse(id); if (host === input.expectedHost.hostID) entries.set(path, true); }
      for (const path of [...entries.keys()]) if (removed.has(JSON.stringify([input.expectedHost.hostID, path]))) entries.delete(path);
      if (path.startsWith('/api/fs/write?') && input.method === 'POST') {
        stats.writes++; stats.lastWriteHost = input.expectedHost.hostID; stats.lastWriteDirectory = at; stats.lastWriteContent = input.body.content; publish();
        if (Object.keys(input.body).sort().join(',') !== 'content,path') throw new Error('Unexpected invented write field');
        const mode = fail; fail = '';
        if (mode === 'write-rejected') return { status: 409, body: { message: 'WRITE_CONFLICT' } };
        if (mode === 'write-delayed') await new Promise(resolve => setTimeout(resolve, 500));
        files.set(key, input.body.content);
        removed.delete(key);
        if (mode === 'write-unknown') throw new Error('WRITE_UNKNOWN');
        return { status: 200, body: { success: true, path: input.body.path } };
      }
      if (input.method === 'POST' && /^\/api\/fs\/(mkdir|rename|delete|reveal)\?/.test(path)) {
        stats.mutations++; publish();
        if (fail === 'mutation-delayed') { fail = ''; await new Promise(resolve => setTimeout(resolve, 500)); }
        if (path.startsWith('/api/fs/mkdir?')) { folders.add(key); removed.delete(key); return { status: 200, body: { success: true, path: filePath } }; }
        if (path.startsWith('/api/fs/reveal?')) { stats.reveals++; publish(); return { status: 200, body: { success: true, path: filePath } }; }
        const source = input.body.oldPath ?? filePath, target = input.body.newPath;
        for (const [entry, directory] of entries) if (entry === source || entry.startsWith(source + '/')) {
          const from = JSON.stringify([input.expectedHost.hostID, entry]); removed.add(from);
          if (target) {
            const next = JSON.stringify([input.expectedHost.hostID, target + entry.slice(source.length)]);
            if (directory) folders.add(next); else files.set(next, files.get(from) ?? input.expectedHost.hostID + '_SOURCE_BODY');
            removed.delete(next);
          }
        }
        return { status: 200, body: { success: true, path: target ?? source } };
      }
      if (input.method !== 'GET') throw new Error('Unexpected fixture mutation');
      if (path.startsWith('/api/git/check?')) return { status: 200, body: { isGitRepository: true } };
      if (path.startsWith('/api/git/branches?')) return { status: 200, body: { current: input.expectedHost.hostID + '-branch', all: [input.expectedHost.hostID + '-branch', 'main'] } };
      if (path.startsWith('/api/git/remotes?')) return { status: 200, body: [] };
      if (path.startsWith('/api/fs/stat?')) {
        if (fail === 'stat-401' || fail === 'stat-404') { const status = Number(fail.slice(5)); fail = ''; return { status, body: { error: 'VERIFY_REJECTED' } }; }
        if (!entries.has(filePath) && filePath !== at) return { status: 404, body: { error: 'MISSING' } };
        const directory = entries.get(filePath) === true || filePath === at;
        return { status: 200, body: { path: filePath, isFile: !directory, isDirectory: directory, isBinary: filePath.endsWith('.bin'), mimeType: 'text/plain', size: value().length, mtimeMs: 1 } };
      }
      if (path.startsWith('/api/fs/read?')) {
        stats.file++; publish();
        if (fail === 'file') { fail = ''; return { status: 503, body: { message: 'FILE_OFFLINE' } }; }
        if (fail === 'external') { fail = ''; files.set(key, 'EXTERNAL_CHANGE'); }
        return { status: 200, body: value() };
      }
      if (path.startsWith('/api/git/status?')) {
        stats.status++; publish();
        if (fail === 'status') { fail = ''; return { status: 503, body: { message: 'STATUS_OFFLINE' } }; }
        if (fail === 'git-delayed') { fail = ''; await new Promise(resolve => setTimeout(resolve, 600)); }
        return { status: 200, body: { isClean: false, current: input.expectedHost.hostID + '-branch', files: [{ path: 'source.ts', index: 'M', working_dir: 'M' }] } };
      }
      if (path.startsWith('/api/git/diff?')) {
        stats.diff++; publish();
        if (fail === 'diff') { fail = ''; return { status: 503, body: { message: 'DIFF_OFFLINE' } }; }
        return { status: 200, body: { diff: '@@ -1 +1 @@\n-before\n+' + (path.endsWith('staged=true') ? 'STAGED_ONLY' : 'WORKSPACE_ONLY') } };
      }
      if (path.startsWith('/api/yuri/sessions/')) { stats.history++; publish(); return { status: 503, body: { message: 'HISTORY_OFFLINE' } }; }
      if (path.startsWith('/api/fs/list?')) {
        stats.list++; publish();
        return { status: 200, body: { entries: [...entries].filter(([entry]) => entry.slice(0, entry.lastIndexOf('/')) === filePath && (!path.includes('respectGitignore=true') || !entry.startsWith(at + '/ignored'))).map(([entry, isDirectory]) => ({ path: entry, isDirectory })) } };
      }
      if (path.startsWith('/api/fs/find?')) { stats.find++; publish(); return { status: 200, body: { data: [{ path: 'sub/note.md', type: 'file' }] } }; }
      throw new Error('Unexpected desktop panel request: ' + path);
    }
    if (name === 'resources.read') {
      stats.file++; publish();
      if (!['host-a', 'host-b'].includes(input.expectedHost?.hostID)) throw new Error('Missing captured resource scope');
      if (fail === 'file') { fail = ''; throw new Error('FILE_OFFLINE'); }
      return { kind: 'text', size: 40, text: input.expectedHost.hostID + '_SOURCE_BODY', lease: 'resource-fixture-' + (++lease) };
    }
    if (['resources.cancel', 'resources.close', 'resources.release', 'resources.web.close'].includes(name)) return true;
    throw new Error('Unexpected desktop panel call: ' + name);
  } };
}
