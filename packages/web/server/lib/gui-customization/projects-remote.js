import { makeRemoteTaskOpenCodeClient } from '../remote-hosts/task-client.js';
import path from 'node:path';

const text = (value, limit = 4096) => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= limit && !/[\x00-\x1f]/.test(value);
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const targetValid = (value) => object(value) && Object.keys(value).length === 3
  && ['hubId', 'hostId', 'instanceId'].every((key) => text(value[key], 512));
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const sessionRecord = (value) => value?.data && !value.id ? value.data : value;
const directoryOf = (value) => value?.location?.directory ?? value?.directory;
const sessionSummary = (value, target) => {
  const session = sessionRecord(value);
  if (!text(session?.id, 512) || !text(directoryOf(session))) fail('remote_response_invalid');
  return { sessionID: session.id, directory: directoryOf(session), title: session.title ?? '', time: session.time, target };
};

export const remoteProjectOperations = ['remote-hosts', 'add-remote', 'remote-projects', 'sessions', 'read-session', 'create-session', 'prompt-session'];

export function validRemoteProjectInput(operation, input) {
  if (!object(input)) return false;
  if (operation === 'remote-projects' || operation === 'remote-hosts') return Object.keys(input).length === 0;
  if (operation === 'add-remote') return Object.keys(input).every((key) => ['target', 'path', 'label'].includes(key))
    && targetValid(input.target) && text(input.path) && (path.posix.isAbsolute(input.path) || path.win32.isAbsolute(input.path))
    && (input.label === undefined || text(input.label, 80));
  const extras = { sessions: ['cursor'], 'read-session': ['sessionID', 'cursor'], 'create-session': ['sessionID', 'title'], 'prompt-session': ['sessionID', 'messageID', 'text'] }[operation];
  if (!extras || Object.keys(input).some((key) => !['target', 'directory', ...extras].includes(key))) return false;
  if (!targetValid(input.target) || !text(input.directory)) return false;
  if (operation !== 'sessions' && !text(input.sessionID, 512)) return false;
  if (input.cursor !== undefined && !text(input.cursor, 4096)) return false;
  if (input.title !== undefined && !text(input.title, 256)) return false;
  return operation !== 'prompt-session' || (text(input.messageID, 512) && typeof input.text === 'string' && input.text.trim().length > 0 && input.text.length <= 12_000);
}

/** Only the admitted Hub's existing connections; no desktop configuration capability. */
export async function runRemoteProjectOperation(gateway, operation, input, signal) {
  signal?.throwIfAborted();
  if (!gateway?.acquireTask) fail('remote_unavailable');
  const catalog = await gateway.list();
  signal?.throwIfAborted();
  if (!catalog.supported) fail('remote_unavailable');
  if (operation === 'remote-hosts') {
    const hosts = [], failed = [];
    for (const host of catalog.hosts) {
      let lease;
      try {
        if (host.available === false) fail('remote_unavailable');
        lease = await gateway.acquireTask(host.id, { signal });
        hosts.push({ name: host.name, source: host.source, target: lease.target });
      } catch { signal?.throwIfAborted(); failed.push({ hostId: host.id, code: 'remote_unavailable' }); }
      finally { lease?.release(); }
    }
    return { hosts, failed, complete: failed.length === 0 };
  }
  if (operation === 'remote-projects') {
    const projects = [], failed = [];
    for (const hostId of new Set(catalog.projects.map((project) => project.hostId))) {
      let lease;
      try {
        lease = await gateway.acquireTask(hostId, { signal });
        for (const project of catalog.projects.filter((project) => project.hostId === hostId)) {
          projects.push({ id: project.id, path: project.path, ...(project.label ? { label: project.label } : {}), target: lease.target });
        }
      } catch { signal?.throwIfAborted(); failed.push({ hostId, code: 'remote_unavailable' }); }
      finally { lease?.release(); }
    }
    return { projects, failed, complete: failed.length === 0 };
  }
  if (input.target.hubId !== catalog.hubId) fail('remote_target_mismatch');
  if (operation === 'add-remote') {
    const result = await gateway.registerProject(input.target.hostId, { path: input.path, ...(input.label ? { label: input.label } : {}) },
      { instanceId: input.target.instanceId, signal });
    return { ...result, target: input.target };
  }
  const lease = await gateway.acquireTask(input.target.hostId, { instanceId: input.target.instanceId, signal });
  try {
    if (['hubId', 'hostId', 'instanceId'].some((key) => lease.target[key] !== input.target[key])) fail('remote_target_mismatch');
    gateway.assertProjectDirectory(input.target.hostId, input.directory);
    const client = makeRemoteTaskOpenCodeClient(lease);
    if (operation === 'sessions') {
      const result = await client.session.list({ directory: input.directory, limit: 20, ...(input.cursor ? { cursor: input.cursor } : { order: 'desc' }) }, { signal });
      const rows = result?.data;
      if (!Array.isArray(rows)) fail('remote_response_invalid');
      return { sessions: rows.map((row) => sessionSummary(row, lease.target)).filter((row) => row.directory === input.directory), nextCursor: result.cursor?.next ?? null };
    }
    if (operation === 'create-session') {
      const created = await client.session.create({ id: input.sessionID, location: { directory: input.directory }, ...(input.title ? { title: input.title } : {}) }, { signal });
      const session = sessionSummary(created, lease.target);
      if (session.sessionID !== input.sessionID || session.directory !== input.directory) fail('remote_target_mismatch');
      return { session, created: true };
    }
    const session = sessionRecord(await client.session.get({ sessionID: input.sessionID }, { signal }));
    if (session?.id !== input.sessionID || directoryOf(session) !== input.directory) fail('remote_target_mismatch');
    if (operation === 'read-session') {
      const query = new URLSearchParams({ directory: input.directory, turns: '3', ...(input.cursor ? { cursor: input.cursor } : {}) });
      const messages = await lease.json(`/api/yuri/sessions/${encodeURIComponent(input.sessionID)}/messages?${query}`, { signal });
      return { session: sessionSummary(session, lease.target), messages };
    }
    await client.session.prompt({ sessionID: input.sessionID, id: input.messageID, text: input.text, delivery: 'steer' }, { signal });
    return { session: sessionSummary(session, lease.target), messageID: input.messageID, admitted: true };
  } finally { lease.release(); }
}
