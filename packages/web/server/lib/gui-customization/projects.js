import path from 'node:path';
import { authorizeScheduledTaskSkillRequest } from '../scheduled-tasks/session-skill-contract.js';
import { remoteProjectOperations, validRemoteProjectInput, runRemoteProjectOperation } from './projects-remote.js';
import { lifecycleOperations, validLifecycleInput } from './projects-lifecycle.js';
import { isBoundSkillCaller, parseSkillCaller } from './skill-caller.js';

export const PROJECTS_SKILL_PATH = '/api/yuri/session-skills/projects';

const projectResult = ({ id, path, label }) => ({ id, path, ...(label ? { label } : {}) });
const validInput = (operation, input) => {
  if (remoteProjectOperations.includes(operation)) return validRemoteProjectInput(operation, input);
  if (lifecycleOperations.includes(operation)) return validLifecycleInput(operation, input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const allowed = operation === 'add' ? ['path', 'label'] : operation === 'remove' ? ['projectId'] : [];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return false;
  if (Object.entries(input).some(([key, value]) => typeof value !== 'string' || !value.trim()
    || value.length > (key === 'label' ? 80 : 4096) || /[\x00-\x1f]/.test(value))) return false;
  if (operation === 'add') return typeof input.path === 'string' && path.isAbsolute(input.path.trim());
  if (operation === 'remove') return typeof input.projectId === 'string' && input.projectId === input.projectId.trim();
  return true;
};

/** Session-bound Host registration; the shared project registry owns persistence. */
export function registerProjectsSkill(app, { express, getIsSharedOpenCodeService, getOpenCodeAuthHeaders, createClient, registerProject, removeProject, readSettingsFromDiskStrict, sanitizeProjects, remoteHostGateway, sessionLifecycle, hasAssistant }) {
  app.post(PROJECTS_SKILL_PATH, express.json({ limit: '16kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!getIsSharedOpenCodeService() || !authorizeScheduledTaskSkillRequest(req, getOpenCodeAuthHeaders())) return res.status(403).json({ error: 'Forbidden' });
    const { operation, input = {} } = req.body ?? {};
    const caller = parseSkillCaller(req.body);
    if (!caller
      || !['describe', 'list', 'add', 'remove', ...lifecycleOperations, ...remoteProjectOperations].includes(operation) || !validInput(operation, input)) return res.status(400).json({ code: 'invalid_input', error: 'Invalid project input' });
    try {
      if (!await isBoundSkillCaller(req, caller, { createClient, hasAssistant })) return res.status(403).json({ error: 'Caller is not bound to this Host' });
      if (operation === 'describe') return res.json({ supported: true, remoteSupported: Boolean(remoteHostGateway?.supported && remoteHostGateway?.acquireTask), lifecycleSupported: Boolean(sessionLifecycle), inputs: { add: '{path: existing absolute Host directory, label?: display name}', list: '{}',
        ...(removeProject ? { remove: '{projectId: exact ID from list} removes only the bound Host registration; preserves files, sessions and remote projects' } : {}),
        'task-sessions': '{directory?: absolute bound-Host directory, settled?: boolean filter (false = still active in the task view), cursor?: returned nextCursor} bounded Host index metadata ordered by activity, newest first; rows carry status, not full upstream history',
        'session-state': '{sessionID} read Host archive authority and nullable task projection; not upstream existence or live UI state',
        'settle-session': '{sessionID} task-view 「归档」: moves the session to the archived shelf; reversible, returns to active on new activity', 'unsettle-session': '{sessionID} restores a task-view-archived session to active',
        'archive-session': '{sessionID, directory?} session-level archive (archivedAt metadata); not the task-view 「归档」', 'unarchive-session': '{sessionID, directory?}',
        'remote-hosts': '{}', 'add-remote': '{target: {hubId,hostId,instanceId} from remote-hosts, path: existing absolute remote directory, label?}',
        'remote-projects': '{}', sessions: '{target, directory, cursor?}', 'read-session': '{target, directory, sessionID, cursor?}',
        'create-session': '{target, directory, sessionID: new caller-generated ID, title?}', 'prompt-session': '{target, directory, sessionID, messageID: stable caller-generated ID, text}',
        'archive-remote-session': '{target, directory, sessionID} 「归档」 of a Remote Project session: writes the real archive on that remote Host, as the task/project view does; not a local settle', 'unarchive-remote-session': '{target, directory, sessionID} restores it' },
        completion: 'add and add-remote return the persisted project and created=true/false. add-remote registers on the target Host, then saves the Hub reference. Registration does not clone/create files, open a session or change an existing active selection. Retry the same target and path safely after an interrupted response.' });
      if (lifecycleOperations.includes(operation)) {
        if (!sessionLifecycle) return res.status(501).json({ code: 'unsupported', error: 'Session lifecycle is unavailable on this Host' });
        const result = await sessionLifecycle(operation, input);
        return res.json(result);
      }
      if (remoteProjectOperations.includes(operation)) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        if (req.aborted || res.destroyed) abort();
        const timeout = ['create-session', 'prompt-session'].includes(operation) ? 300_000 : 25_000;
        try {
          const result = await runRemoteProjectOperation(remoteHostGateway, operation, input,
            AbortSignal.any([controller.signal, AbortSignal.timeout(timeout)]));
          if (!controller.signal.aborted) return res.json(result);
          return;
        } finally {
          req.removeListener('aborted', abort);
          res.removeListener('close', abort);
          controller.abort();
        }
      }
      if (operation === 'list') {
        const settings = await readSettingsFromDiskStrict();
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)
          || (settings.projects !== undefined && !Array.isArray(settings.projects))) throw new Error('Invalid project settings');
        return res.json({ projects: (sanitizeProjects(settings.projects) || []).map(projectResult) });
      }
      if (operation === 'remove') {
        if (!removeProject) return res.status(501).json({ code: 'unsupported', error: 'Project removal is unavailable on this Host' });
        await removeProject(input);
        return res.json({ projectId: input.projectId, removed: true });
      }
      const { project, created } = await registerProject(input);
      return res.json({ project: projectResult(project), created });
    } catch (error) {
      if (res.destroyed) return;
      if (lifecycleOperations.includes(operation)) {
        const status = [400, 403, 404, 409, 501, 503].includes(error?.status) ? error.status : 503;
        const code = ['unsupported', 'session_not_found', 'session_archived', 'not_found', 'directory_mismatch', 'validation_error'].includes(error?.code) ? error.code : 'session_operation_failed';
        return res.status(status).json({ code, error: 'Session operation not confirmed; inspect the same session on the bound Host before retrying.' });
      }
      if (operation === 'remove') {
        if (error?.code === 'not_found') return res.status(404).json({ code: 'not_found', error: 'Project is not registered on this Host' });
        return res.status(503).json({ code: 'project_operation_failed', error: 'Project removal was not confirmed; inspect the same project on the bound Host before retrying.' });
      }
      const code = ['validation_error', 'project_unavailable', 'remote_unavailable', 'remote_target_mismatch', 'remote_response_invalid'].includes(error?.code) ? error.code : 'project_operation_failed';
      return res.status(code === 'validation_error' ? 400 : 503).json({ code, error: 'Project operation was not confirmed; inspect the same target before retrying. Never retry against the local Host.' });
    }
  });
}
