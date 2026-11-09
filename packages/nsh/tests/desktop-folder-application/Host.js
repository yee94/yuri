import { createNavigationHost, navigationIdentity as identity } from '../desktop-application/NavigationHost.js';
export { identity };
export { attachment, draftRecord, newDraftKey, newDraftNavigation, navigationRecord } from '../desktop-commands-application/Host.js';

export const folder = Object.freeze({ scope: identity.directory, id: 'root-folder' });
export const secondFolder = Object.freeze({ scope: identity.directory, id: 'second-folder' });
const dir = encodeURIComponent(identity.directory);
const clone = value => JSON.parse(JSON.stringify(value));
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');

/** Only exact synthetic endpoints extend the strict read-only production-root fixture. */
export function createFolderHost() {
  const base = createNavigationHost(), read = base.handlers['runtime.request'];
  const writes = [], events = [], creates = [], memberships = [], prompts = [], configurations = [], folderReads = [];
  const createdID = 'folder-created', target = '/api/session/' + createdID;
  let lostMembership = false, capturedInputID = null;
  let folders = { version: 1, foldersMap: { [identity.directory]: [
    { id: folder.id, name: 'Root folder', sessionIds: [], createdAt: 1 },
    { id: secondFolder.id, name: 'Second folder', sessionIds: [], createdAt: 2 },
  ] }, collapsedFolderIds: [], updatedAt: 1 };
  const fail = (message, input) => { base.rejected.push({ message, detail: input }); throw new Error(message); };
  const ok = body => ({ status: 200, body });
  function scope(input) {
    if (!exact(input.expectedHost, ['hostID', 'lease']) || input.expectedHost.hostID !== identity.hostID || input.expectedHost.lease !== identity.lease) fail('Wrong folder native authority', input);
  }
  function write(input, lane) { writes.push(input); lane.push(input); events.push({ kind: 'write', path: input.path }); }
  function writer(input, target) {
    try { base.writer.assertWrite(input, target); }
    catch { return fail('Folder write lacks exact native writer grant', input); }
  }
  base.handlers['folder.test.persisted'] = input => {
    if (!exact(input, ['key', 'phase', 'folder', 'inputID']) || !input.key.startsWith('nsh:new-session:v1:')) return fail('Invalid local receipt observation', input);
    if (input.inputID !== null) capturedInputID = input.inputID;
    events.push({ kind: 'persisted', ...input });
  };
  base.handlers['runtime.request'] = input => {
    scope(input);
    const fields = ['path', 'method', 'expectedHost', ...(input.body === undefined ? [] : ['body']), ...(input.writerGrant === undefined ? [] : ['writerGrant'])];
    if (!exact(input, fields) || input.method === 'GET' && (input.body !== undefined || input.writerGrant !== undefined)) return fail('Invalid exact request envelope', input);
    if (input.method === 'GET' && input.path === '/api/agent?location%5Bdirectory%5D=' + dir) return ok({ data: [{ name: 'build', mode: 'primary', model: { providerID: 'fixture', modelID: 'model' } }] });
    if (input.path === '/api/session-folders' && input.method === 'GET') {
      if (input.body !== undefined) return fail('Unexpected folders GET body', input);
      folderReads.push(input);
      return ok(clone(folders));
    }
    if (input.path === '/api/session-folders' && input.method === 'POST') {
      const body = input.body;
      if (!exact(body, ['version', 'foldersMap', 'collapsedFolderIds', 'updatedAt']) || body.version !== 1
        || !exact(body.foldersMap, [identity.directory]) || !Array.isArray(body.foldersMap[identity.directory])
        || body.foldersMap[identity.directory].length !== 2 || !Array.isArray(body.collapsedFolderIds) || body.collapsedFolderIds.length
        || body.foldersMap[identity.directory].some((value, index) => value.id !== [folder.id, secondFolder.id][index]
          || value.name !== ['Root folder', 'Second folder'][index] || value.createdAt !== index + 1
          || !Array.isArray(value.sessionIds) || value.sessionIds.some(id => id !== createdID))
        || body.foldersMap[identity.directory].flatMap(value => value.sessionIds).join(',') !== createdID) return fail('Invalid exact membership mutation', input);
      write(input, memberships); folders = clone(body);
      if (lostMembership) throw new Error('Synthetic lost folder membership ACK');
      return ok({ success: true });
    }
    if (input.path === '/api/session' && input.method === 'POST') {
      writer(input, { kind: 'new-session', id: identity.directory });
      if (JSON.stringify(input.body) !== JSON.stringify({ location: { directory: identity.directory } })) return fail('Invalid exact folder create', input);
      write(input, creates); return ok({ id: createdID, title: 'Folder created session', location: { directory: identity.directory } });
    }
    if (input.method === 'POST' && [target + '/model?directory=' + dir, target + '/agent?directory=' + dir].includes(input.path)) {
      writer(input, { kind: 'session', id: createdID });
      if (JSON.stringify(input.body) !== JSON.stringify(input.path.includes('/model?') ? { model: { providerID: 'fixture', id: 'model' } } : { agent: 'build' })) return fail('Invalid initial folder selection', input);
      write(input, configurations); return { status: 204, body: null };
    }
    if (input.method === 'POST' && input.path === target + '/prompt?directory=' + dir) {
      writer(input, { kind: 'session', id: createdID });
      const body = input.body;
      if (!body || !capturedInputID || body.id !== capturedInputID || body.text !== 'First folder input' || body.delivery !== 'steer'
        || Object.keys(body).some(key => !['id', 'text', 'delivery', 'files', 'agents', 'skills', 'metadata'].includes(key))
        || body.files !== undefined && (!Array.isArray(body.files) || body.files.length !== 0)) return fail('Invalid folder prompt', input);
      write(input, prompts); return ok({ id: body.id, sessionID: createdID, type: 'user', text: body.text, delivery: 'steer', state: 'queued' });
    }
    if (input.method === 'GET' && input.path === target + '?directory=' + dir) return ok({ id: createdID, title: 'Folder created session', location: { directory: identity.directory }, execution: { type: 'idle' }, model: { providerID: 'fixture', id: 'model' }, agent: 'build' });
    if (input.method === 'GET' && [target + '/inbox?directory=' + dir, target + '/form?directory=' + dir, target + '/permission/request?directory=' + dir].includes(input.path)) return ok(input.path.includes('/inbox?') ? prompts.map(row => ({ id: row.body.id, text: row.body.text, state: 'queued' })) : []);
    if (input.method === 'GET' && input.path === target + '/message?directory=' + dir + '&limit=20&order=desc') return ok({ data: [], cursor: { next: null } });
    if (input.method === 'GET' && prompts.some(row => input.path === target + '/message/' + encodeURIComponent(row.body.id) + '?directory=' + dir)) {
      const prompt = prompts.find(row => input.path === target + '/message/' + encodeURIComponent(row.body.id) + '?directory=' + dir);
      return ok({ id: prompt.body.id, sessionID: createdID, role: 'user', text: prompt.body.text, time: { created: 4 } });
    }
    if (input.method === 'GET' && capturedInputID && input.path === target + '/message/' + encodeURIComponent(capturedInputID) + '?directory=' + dir) return { status: 404, body: { error: 'Exact durable input not admitted yet' } };
    if (input.method === 'POST' && input.path === '/api/rpc/opencode.goal/get?location%5Bdirectory%5D=' + dir
      && exact(input.body, ['input']) && exact(input.body.input, ['sessionID']) && input.body.input.sessionID === createdID) return ok({ output: null });
    if (input.method === 'GET' && input.path === '/api/yuri/scheduled-tasks') return ok({ tasks: [{ projectId: identity.projectID, task: task() }], failedProjectIds: [] });
    if (input.method === 'GET' && input.path === '/api/projects/' + identity.projectID + '/scheduled-tasks') return ok({ tasks: [task()] });
    return read(input);
  };
  function task() { return { id: 'folder-task', name: 'Folder task', enabled: true, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { prompt: 'Synthetic folder schedule', providerID: 'fixture', modelID: 'model', agent: 'build', variant: '', goalEnabled: false }, state: { lastStatus: 'success' } }; }
  return { ...base, creates, memberships, prompts, configurations, writes, events, folderReads, createdID, loseMembership() { lostMembership = true; } };
}
