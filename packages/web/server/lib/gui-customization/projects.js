import path from 'node:path';
import { authorizeScheduledTaskSkillRequest } from '../scheduled-tasks/session-skill-contract.js';
import { remoteProjectOperations, validRemoteProjectInput, runRemoteProjectOperation, listRemoteTaskRows } from './projects-remote.js';
import { lifecycleOperations, validLifecycleInput, pageTaskRows } from './projects-lifecycle.js';
import { importSessionOperations, validImportSessionInput, runImportSession } from './projects-import.js';
import { isBoundSkillCaller, parseSkillCaller } from './skill-caller.js';

export const PROJECTS_SKILL_PATH = '/api/yuri/session-skills/projects';

const projectResult = ({ id, path: projectPath, paths, label }) => ({
  id,
  path: projectPath,
  ...(Array.isArray(paths) ? { paths } : {}),
  ...(label ? { label } : {}),
});

const isSafeString = (value, max = 4096) => (
  typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value)
);

const isValidAbsolutePathsArray = (value) => (
  Array.isArray(value)
  && value.length <= 24
  && value.every((entry) => isSafeString(entry, 4096) && path.isAbsolute(entry.trim()))
);

const validInput = (operation, input) => {
  if (remoteProjectOperations.includes(operation)) return validRemoteProjectInput(operation, input);
  if (lifecycleOperations.includes(operation)) return validLifecycleInput(operation, input);
  if (importSessionOperations.includes(operation)) return validImportSessionInput(input);
  if (operation === 'task-view') return validLifecycleInput('task-sessions', input) && input.directory === undefined;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;

  if (operation === 'add') {
    const allowed = ['path', 'paths', 'primaryPath', 'label'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) return false;
    if (input.label !== undefined && !isSafeString(input.label, 80)) return false;
    if (input.primaryPath !== undefined && (!isSafeString(input.primaryPath, 4096) || !path.isAbsolute(input.primaryPath.trim()))) return false;
    if (input.paths !== undefined) {
      if (input.path !== undefined) return false;
      if (!isValidAbsolutePathsArray(input.paths)) return false;
      if (input.paths.length === 0 && !isSafeString(input.label, 80)) return false;
      return true;
    }
    return isSafeString(input.path, 4096) && path.isAbsolute(input.path.trim());
  }

  if (operation === 'update') {
    const allowed = ['projectId', 'label', 'paths', 'addPath', 'removePath', 'primaryPath'];
    if (Object.keys(input).some((key) => !allowed.includes(key))) return false;
    if (!isSafeString(input.projectId, 4096) || input.projectId !== input.projectId.trim()) return false;
    if (input.label !== undefined && input.label !== null && input.label !== '' && !isSafeString(input.label, 80)) return false;
    if (input.paths !== undefined && !isValidAbsolutePathsArray(input.paths)) return false;
    if (input.addPath !== undefined && (!isSafeString(input.addPath, 4096) || !path.isAbsolute(input.addPath.trim()))) return false;
    if (input.removePath !== undefined && (!isSafeString(input.removePath, 4096) || !path.isAbsolute(input.removePath.trim()))) return false;
    if (input.primaryPath !== undefined && (!isSafeString(input.primaryPath, 4096) || !path.isAbsolute(input.primaryPath.trim()))) return false;
    return [input.label, input.paths, input.addPath, input.removePath, input.primaryPath].some((value) => value !== undefined);
  }

  const allowed = operation === 'remove' ? ['projectId'] : [];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return false;
  if (operation === 'remove') return isSafeString(input.projectId, 4096) && input.projectId === input.projectId.trim();
  return true;
};

/** Session-bound Host registration; the shared project registry owns persistence. */
export function registerProjectsSkill(app, { express, getIsSharedOpenCodeService, getOpenCodeAuthHeaders, createClient, registerProject, updateProject = null, removeProject, readSettingsFromDiskStrict, sanitizeProjects, remoteHostGateway, sessionLifecycle, onImported = null, hasAssistant }) {
  app.post(PROJECTS_SKILL_PATH, express.json({ limit: '16mb', verify: (req, _res, buf) => { req._rawBodyLength = buf.length; } }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!getIsSharedOpenCodeService() || !authorizeScheduledTaskSkillRequest(req, getOpenCodeAuthHeaders())) return res.status(403).json({ error: 'Forbidden' });
    const { operation, input = {} } = req.body ?? {};
    if (operation !== 'import-session' && (req._rawBodyLength ?? 0) > 16 * 1024) return res.status(413).json({ code: 'payload_too_large', error: 'Request payload too large' });
    const caller = parseSkillCaller(req.body);
    if (!caller
      || !['describe', 'list', 'add', 'update', 'remove', 'task-view', ...lifecycleOperations, ...remoteProjectOperations, ...importSessionOperations].includes(operation) || !validInput(operation, input)) return res.status(400).json({ code: 'invalid_input', error: 'Invalid project input' });
    try {
      if (!await isBoundSkillCaller(req, caller, { createClient, hasAssistant })) return res.status(403).json({ error: 'Caller is not bound to this Host' });
      const importSupported = typeof createClient?.()?.session?.import === 'function';
      if (operation === 'describe') return res.json({ supported: true, remoteSupported: Boolean(remoteHostGateway?.supported && remoteHostGateway?.acquireTask), lifecycleSupported: Boolean(sessionLifecycle), importSupported, inputs: {
        add: '{path?: existing absolute Host directory, paths?: 0..N absolute Host directories (pass [] + label for a blank workspace, or 2+ paths for a multi-path workspace), primaryPath?: absolute directory from paths, label?: display name (required when paths is [])}',
        ...(updateProject ? { update: '{projectId: exact ID from list, label?: display name or null, paths?: replace attached directories (0..N), addPath?: append one existing absolute directory, removePath?: detach one directory, primaryPath?: switch primary directory among attached paths} preserves projectId and existing sessions' } : {}),
        list: '{}',
        ...(removeProject ? { remove: '{projectId: exact ID from list} removes only the bound Host registration; preserves files, sessions and remote projects' } : {}),
        ...(importSupported ? { 'import-session': '{directory: existing absolute Host directory, title?: string, source?: string, sourceId?: string, parentID?: string, registerProject?: boolean (default true), messages: [{role:"user"|"assistant"|"system", text?, time?, thinking?, tools?:[{name,input?,output?,incomplete?,isError?}]}] | events: [{kind:"user"|"assistant-text"|"thinking"|"tool"|"marker", text?, time?, name?, input?, output?, incomplete?, isError?}]} imports one normalized historical conversation into this Host via official session.import and indexes it; supply source+sourceId for idempotent retries' } : {}),
        'task-view': '{settled?: boolean (false = what the task view still lists as active), cursor?} THE task-view list: local sessions plus every Remote Project session (all project and worktree directories), newest activity first. Remote rows carry remote:{host,target} and settled=true means archived on that Host; archive them with archive-remote-session using the row directory and target',
        'task-sessions': '{directory?: absolute bound-Host directory, settled?: boolean filter (false = still active in the task view), cursor?: returned nextCursor} bounded Host index metadata ordered by activity, newest first; rows carry status, not full upstream history',
        'session-state': '{sessionID} read Host archive authority and nullable task projection; not upstream existence or live UI state',
        'settle-session': '{sessionID} task-view 「归档」: moves the session to the archived shelf; reversible, returns to active on new activity', 'unsettle-session': '{sessionID} restores a task-view-archived session to active',
        'archive-session': '{sessionID, directory?} session-level archive (archivedAt metadata); not the task-view 「归档」', 'unarchive-session': '{sessionID, directory?}',
        'remote-hosts': '{}', 'add-remote': '{target: {hubId,hostId,instanceId} from remote-hosts, path: existing absolute remote directory, label?}',
        'remote-projects': '{}', sessions: '{target, directory, cursor?}', 'read-session': '{target, directory, sessionID, cursor?}',
        'create-session': '{target, directory, sessionID: new caller-generated ID, title?}', 'prompt-session': '{target, directory, sessionID, messageID: stable caller-generated ID, text}',
        'archive-remote-session': '{target, directory, sessionID} 「归档」 of a Remote Project session: writes the real archive on that remote Host, as the task/project view does; not a local settle', 'unarchive-remote-session': '{target, directory, sessionID} restores it' },
        completion: 'add and add-remote return the persisted project and created=true/false. add-remote registers on the target Host, then saves the Hub reference. Registration does not clone/create files, open a session or change an existing active selection. Retry the same target and path safely after an interrupted response.' });
      if (operation === 'import-session') {
        if (!importSupported) return res.status(501).json({ code: 'unsupported', error: 'Session import is unavailable on this Host' });
        const controller = new AbortController();
        const abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        if (req.aborted || res.destroyed) abort();
        try {
          const result = await runImportSession(input, {
            createClient,
            registerProject,
            onImported,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
          });
          if (!controller.signal.aborted) return res.json(result);
          return;
        } finally {
          req.removeListener('aborted', abort);
          res.removeListener('close', abort);
          controller.abort();
        }
      }
      if (operation === 'task-view') {
        const local = sessionLifecycle ? await sessionLifecycle('task-rows', {}) : { rows: [], historyComplete: false };
        const remote = await listRemoteTaskRows(remoteHostGateway);
        const page = pageTaskRows([...local.rows, ...remote.rows], input);
        return res.json({ sessions: page.rows, nextCursor: page.nextCursor, indexedOnly: true, historyComplete: local.historyComplete,
          remoteComplete: remote.complete, remoteFailed: remote.failed });
      }
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
      if (operation === 'update') {
        if (!updateProject) return res.status(501).json({ code: 'unsupported', error: 'Workspace update is unavailable on this Host' });
        const { project } = await updateProject(input);
        return res.json({ project: projectResult(project), updated: true });
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
      if (operation === 'remove' || operation === 'update') {
        if (error?.code === 'not_found') return res.status(404).json({ code: 'not_found', error: 'Project is not registered on this Host' });
        if (error?.code === 'validation_error') return res.status(400).json({ code: 'validation_error', error: 'Invalid project input' });
        return res.status(503).json({ code: 'project_operation_failed', error: 'Project update was not confirmed; inspect the same project on the bound Host before retrying.' });
      }
      if (operation === 'import-session') {
        const code = ['validation_error', 'session_conflict', 'unsupported', 'import_failed'].includes(error?.code) ? error.code : 'import_failed';
        const status = code === 'validation_error' ? 400 : code === 'session_conflict' ? 409 : code === 'unsupported' ? 501 : 503;
        return res.status(status).json({ code, error: 'Session import was not confirmed; inspect the bound Host before retrying.' });
      }
      const code = ['validation_error', 'project_unavailable', 'remote_unavailable', 'remote_target_mismatch', 'remote_response_invalid'].includes(error?.code) ? error.code : 'project_operation_failed';
      return res.status(code === 'validation_error' ? 400 : 503).json({ code, error: 'Project operation was not confirmed; inspect the same target before retrying. Never retry against the local Host.' });
    }
  });
}
