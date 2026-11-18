import { executionTargetSchema } from './execution-target.js';
import { runRemoteProjectOperation, validRemoteProjectInput } from '../gui-customization/projects-remote.js';

export function createYuriContactToolGroups(tools) {
  return [
    { id: 'yuri.projects', description: 'Register an existing local workspace or add a directory on an authorized saved Host to this Hub’s Remote Projects sidebar.', names: ['register_project', 'list_remote_hosts', 'register_remote_project'] },
    { id: 'yuri.assistants', description: 'Create or delete another Bot.', names: ['create_assistant', 'delete_assistant'] },
    { id: 'yuri.tasks', description: 'Create scheduled tasks owned by this contact, or update/pause/resume existing tasks. Delegate another contact\'s new task with message_assistant.', names: ['schedule_task', 'update_scheduled_task'] },
  ].map(({ id, description, names }) => ({ id, description, tools: tools.filter((tool) => names.includes(tool.name)) }))
    .filter((group) => group.tools.length > 0);
}

const result = (details, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(details) }], details, isError, terminate: false,
});

/** Assistant-local business capability; never registered with OpenCode or its skills catalog. */
export function createYuriContactTools({ registerProject, remoteHostGateway } = {}) {
  const tools = [];
  if (typeof registerProject === 'function') tools.push({
    name: 'register_project', label: 'Register project',
    description: 'Register an existing user-requested directory on this local Hub as a Yuri project. Only call assign_session afterward if the user also requested a session. Does not clone/create files or switch the active project. Never register a guessed directory or assistant-workspaces.',
    parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: {
      path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Existing absolute Host directory resolved from the user request or filesystem discovery.' },
      label: { type: 'string', minLength: 1, maxLength: 80, description: 'Optional project display name.' },
    } },
    execute: async (_id, params, signal) => {
      signal?.throwIfAborted();
      if (!params || Array.isArray(params) || typeof params !== 'object'
        || Object.keys(params).some((key) => !['path', 'label'].includes(key))
        || typeof params.path !== 'string' || !params.path.trim() || params.path.length > 4096
        || (params.label !== undefined && (typeof params.label !== 'string' || !params.label.trim() || params.label.length > 80))) {
        return result({ error: 'validation_error' }, true);
      }
      try {
        const { project, created } = await registerProject(params, signal);
        return result({ project: { id: project.id, path: project.path, ...(project.label ? { label: project.label } : {}) }, created });
      } catch (error) {
        signal?.throwIfAborted();
        const code = ['validation_error', 'workspace_forbidden', 'project_unavailable'].includes(error?.code) ? error.code : 'yuri_operation_failed';
        return result({ error: code, message: 'Registration failed. Check the project catalog before retrying; do not claim success.' }, true);
      }
    },
  });
  if (remoteHostGateway?.supported && typeof remoteHostGateway.registerProject === 'function') {
    const execute = (operation) => async (_id, input, signal) => {
      signal?.throwIfAborted();
      if (!validRemoteProjectInput(operation, input)) return result({ error: 'validation_error' }, true);
      try {
        const value = await runRemoteProjectOperation(remoteHostGateway, operation, input, signal);
        if (operation === 'remote-hosts') return result(value);
        const { project, created, target } = value;
        return result({ project: { id: project.id, path: project.path, ...(project.label ? { label: project.label } : {}) }, created, target });
      } catch (error) {
        signal?.throwIfAborted();
        const code = ['remote_unavailable', 'remote_target_mismatch', 'remote_instance_mismatch', 'host_unavailable', 'project_not_found', 'validation_error'].includes(error?.code)
          ? error.code : 'yuri_operation_failed';
        return result({ error: code, message: 'No confirmed result. Never substitute another Host or claim the Hub saved a reference.' }, true);
      }
    };
    tools.push({
      name: 'list_remote_hosts', label: 'List authorized remote hosts',
      description: 'Discover authorized saved Hosts and their exact targets, including Hosts with no projects. Check complete/failed before reporting no matches.',
      parameters: { type: 'object', additionalProperties: false, properties: {} },
      execute: execute('remote-hosts'),
    }, {
      name: 'register_remote_project', label: 'Add remote project to this Hub',
      description: 'Add the user-requested existing remote directory to this Hub’s Remote Projects sidebar. Use the exact target from list_projects or list_remote_hosts. An entry in the remote Host’s own catalog is not a Hub sidebar reference. Success returns the saved Hub reference; created=false means it already existed. No new connection, file creation, or session.',
      parameters: { type: 'object', additionalProperties: false, required: ['target', 'path'], properties: {
        target: { ...executionTargetSchema, description: 'Exact hubId, hostId and instanceId from authorized remote discovery.' },
        path: { type: 'string', minLength: 1, maxLength: 4096, description: 'Existing absolute directory on the selected remote Host.' },
        label: { type: 'string', minLength: 1, maxLength: 80, description: 'Optional project display name.' },
      } },
      execute: execute('add-remote'),
    });
  }
  return tools;
}
