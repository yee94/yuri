import { AsyncLocalStorage } from 'node:async_hooks';
import { makeRemoteTaskOpenCodeClient } from '../remote-hosts/task-client.js';
import { AssignError } from './assign.js';

export const executionTargetSchema = {
  type: 'object', additionalProperties: false, required: ['hubId', 'hostId', 'instanceId'],
  properties: Object.fromEntries(['hubId', 'hostId', 'instanceId'].map((key) => [key, { type: 'string', minLength: 1, maxLength: 256 }])),
  description: 'Exact remote machine identity from discovery. Omit only for the local Hub. Never omit a known remote target.',
};

export function parseExecutionTarget(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['hubId', 'hostId', 'instanceId'].includes(key))
    || ['hubId', 'hostId', 'instanceId'].some((key) => typeof value[key] !== 'string' || !value[key].trim() || value[key].trim() !== value[key] || /[\x00-\x1f]/.test(value[key]) || value[key].length > 256)) {
    throw new AssignError('validation_error', 'target requires hubId, hostId and instanceId. A malformed remote target cannot use the local Hub.');
  }
  return { hubId: value.hubId.trim(), hostId: value.hostId.trim(), instanceId: value.instanceId.trim() };
}

export const executionTargetKey = (target) => target === undefined ? '' : JSON.stringify(parseExecutionTarget(target));
export const executionSessionKey = (sessionID, target) => target === undefined ? sessionID : `remote:${executionTargetKey(target)}:${sessionID}`;
const directoryKey = (value) => value.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
export const remoteDirectoryContained = (directory, root) => {
  if (typeof directory !== 'string' || typeof root !== 'string' || /[\x00-\x1f]/.test(directory)
    || directory.replace(/\\/g, '/').split('/').some((segment) => segment === '.' || segment === '..')) return false;
  const candidate = directoryKey(directory), parent = directoryKey(root);
  return candidate === parent || candidate.startsWith(parent === '/' ? '/' : `${parent}/`);
};

/** A task-scoped official client; neither credentials nor remote bodies are cached. */
export function createAssistantExecutionAccessor(gateway) {
  const context = new AsyncLocalStorage();
  const lifetime = new AbortController();
  const leases = new Set();
  const acquire = async (rawTarget, options = {}) => {
    const target = parseExecutionTarget(rawTarget);
    if (!target || !gateway?.acquireTask) throw new AssignError('upstream_error', 'Remote execution is unavailable.');
    if (target.hubId !== gateway.store?.hubId) throw new AssignError('workspace_forbidden', 'Remote target belongs to another Hub.');
    const signal = options.signal ? AbortSignal.any([lifetime.signal, options.signal]) : lifetime.signal;
    signal.throwIfAborted();
    const lease = await gateway.acquireTask(target.hostId, { ...options, signal, instanceId: target.instanceId });
    leases.add(lease);
    const release = () => { leases.delete(lease); lease.release(); };
    try {
      signal.throwIfAborted();
      if (executionTargetKey(lease.target) !== executionTargetKey(target)) throw new AssignError('workspace_forbidden', 'Remote machine identity changed.');
      const api = makeRemoteTaskOpenCodeClient(lease);
      const projects = async () => {
        const response = await lease.json('/api/projects');
        const rows = Array.isArray(response) ? response : response?.projects;
        if (!Array.isArray(rows) || rows.some((row) => typeof row?.path !== 'string' || typeof row?.id !== 'string')) throw new AssignError('upstream_error', 'Remote project catalog is unavailable.');
        return rows.map(({ id, path, label }) => ({ id, path, ...(label ? { label } : {}), target: lease.target }));
      };
      const worktrees = async (directory) => {
        const rows = await lease.json(`/api/git/worktrees?directory=${encodeURIComponent(directory)}`);
        if (!Array.isArray(rows)) throw new AssignError('upstream_error', 'Remote worktree catalog is unavailable.');
        const source = rows.filter((tree) => typeof tree.path === 'string' && remoteDirectoryContained(directory, tree.path))
          .sort((left, right) => right.path.length - left.path.length)[0];
        const suffix = source ? directoryKey(directory).slice(directoryKey(source.path).length) : '';
        return rows.filter((tree) => typeof tree.path === 'string').map((tree) => ({ ...tree, path: `${directoryKey(tree.path)}${suffix}` }));
      };
      const resolveDirectory = async ({ projectPath, directory, branch, worktrees: trees = [] }) => {
        const registered = await projects();
        let selected = directory || projectPath || (registered.length === 1 ? registered[0].path : null);
        if (!selected) throw new AssignError('project_required', 'Choose an exact remote project path from list_projects.');
        if (branch) {
          const tree = trees.find((item) => item.branch === branch || item.branch === `refs/heads/${branch}`);
          if (!tree?.path) throw new AssignError('worktree_not_found', 'No matching remote worktree exists.');
          selected = tree.path;
        }
        if (registered.some((project) => remoteDirectoryContained(selected, project.path))) return selected;
        for (const project of registered) {
          const linked = await worktrees(project.path);
          if (linked.some((tree) => remoteDirectoryContained(selected, tree.path))) return selected;
        }
        throw new AssignError('workspace_forbidden', 'The remote directory is not a registered project or worktree.');
      };
      return { ...lease, release, api, projects, worktrees, resolveDirectory };
    } catch (error) { release(); throw error; }
  };
  return {
    current: () => context.getStore(), acquire,
    close() { lifetime.abort(); for (const lease of leases) lease.release(); leases.clear(); },
    async run(params, work) {
      const target = parseExecutionTarget(params?.target);
      if (!target) return context.run(undefined, work);
      let scope;
      try {
        scope = await acquire(target, { signal: params?.signal });
        return await context.run(scope, work);
      }
      catch (error) {
        if (error && typeof error === 'object') error.target = target;
        throw error;
      }
      finally { scope?.release(); }
    },
    async discover({ probe = true, signal: parentSignal } = {}) {
      if (!gateway?.list) return [];
      let catalog;
      try { catalog = await gateway.list(); }
      catch {
        const projects = [];
        projects.failed = [{ error: 'remote_catalog_unavailable' }];
        return projects;
      }
      if (!probe) return (catalog.projects || []).flatMap((project) => {
        const instanceId = project.instanceId || catalog.hosts?.find((host) => host.id === project.hostId)?.instanceId;
        return instanceId ? [{ id: project.remoteProjectId || project.id, path: project.path, label: project.label,
          target: parseExecutionTarget({ hubId: catalog.hubId, hostId: project.hostId, instanceId }) }] : [];
      });
      const projects = [];
      const failed = [];
      const signal = parentSignal ? AbortSignal.any([lifetime.signal, parentSignal]) : lifetime.signal;
      for (const host of catalog.hosts || []) {
        let lease;
        try {
          signal.throwIfAborted();
          lease = await gateway.acquireTask(host.id, { signal });
          const target = parseExecutionTarget(lease.target);
          const response = await lease.json('/api/projects');
          const rows = Array.isArray(response) ? response : response?.projects;
          if (!Array.isArray(rows)) throw new Error('Invalid project catalog');
          for (const row of rows) {
            if (typeof row?.id !== 'string' || typeof row?.path !== 'string') throw new Error('Invalid remote project');
            projects.push({ id: row.id, path: row.path, ...(row.label ? { label: row.label } : {}), target, hostName: host.name || host.id });
          }
        } catch { signal.throwIfAborted(); failed.push({ hubId: catalog.hubId, hostId: host.id, error: 'remote_projects_unavailable' }); }
        finally { lease?.release(); }
      }
      projects.failed = failed;
      return projects;
    },
  };
}
