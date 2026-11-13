import path from 'node:path';
import { authorizeScheduledTaskSkillRequest } from '../scheduled-tasks/session-skill-contract.js';
import { remoteProjectOperations, validRemoteProjectInput, runRemoteProjectOperation } from './projects-remote.js';

export const PROJECTS_SKILL_PATH = '/api/yuri/session-skills/projects';

const projectResult = ({ id, path, label }) => ({ id, path, ...(label ? { label } : {}) });
const validInput = (operation, input) => {
  if (remoteProjectOperations.includes(operation)) return validRemoteProjectInput(operation, input);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const allowed = operation === 'add' ? ['path', 'label'] : [];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return false;
  if (Object.entries(input).some(([key, value]) => typeof value !== 'string' || !value.trim()
    || value.length > (key === 'label' ? 80 : 4096) || /[\x00-\x1f]/.test(value))) return false;
  return operation !== 'add' || (typeof input.path === 'string' && path.isAbsolute(input.path.trim()));
};

/** Session-bound Host registration; the shared project registry owns persistence. */
export function registerProjectsSkill(app, { express, getIsSharedOpenCodeService, getOpenCodeAuthHeaders, createClient, registerProject, readSettingsFromDiskStrict, sanitizeProjects, remoteHostGateway }) {
  app.post(PROJECTS_SKILL_PATH, express.json({ limit: '16kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!getIsSharedOpenCodeService() || !authorizeScheduledTaskSkillRequest(req, getOpenCodeAuthHeaders())) return res.status(403).json({ error: 'Forbidden' });
    const { sessionID, operation, input = {} } = req.body ?? {};
    if (typeof sessionID !== 'string' || !sessionID || sessionID.length > 256
      || !['describe', 'list', 'add', ...remoteProjectOperations].includes(operation) || !validInput(operation, input)) return res.status(400).json({ code: 'invalid_input', error: 'Invalid project input' });
    try {
      const session = await createClient().session.get({ sessionID });
      const hostOrigin = `http://${req.socket.localAddress === '::1' ? '[::1]' : '127.0.0.1'}:${req.socket.localPort}`;
      if (session.metadata?.yuri?.scheduledTaskSkill?.hostOrigin !== hostOrigin) return res.status(403).json({ error: 'Session is not bound to this Host' });
      if (operation === 'describe') return res.json({ supported: true, remoteSupported: Boolean(remoteHostGateway?.supported && remoteHostGateway?.acquireTask), inputs: { add: '{path: existing absolute Host directory, label?: display name}', list: '{}',
        'remote-hosts': '{}', 'add-remote': '{target: {hubId,hostId,instanceId} from remote-hosts, path: existing absolute remote directory, label?}',
        'remote-projects': '{}', sessions: '{target, directory, cursor?}', 'read-session': '{target, directory, sessionID, cursor?}',
        'create-session': '{target, directory, sessionID: new caller-generated ID, title?}', 'prompt-session': '{target, directory, sessionID, messageID: stable caller-generated ID, text}' },
        completion: 'add and add-remote return the persisted project and created=true/false. add-remote registers on the target Host, then saves the Hub reference. Registration does not clone/create files, open a session or change an existing active selection. Retry the same target and path safely after an interrupted response.' });
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
      const { project, created } = await registerProject(input);
      return res.json({ project: projectResult(project), created });
    } catch (error) {
      if (res.destroyed) return;
      const code = ['validation_error', 'project_unavailable', 'remote_unavailable', 'remote_target_mismatch', 'remote_response_invalid'].includes(error?.code) ? error.code : 'project_operation_failed';
      return res.status(code === 'validation_error' ? 400 : 503).json({ code, error: 'Project operation was not confirmed; inspect the same target before retrying. Never retry against the local Host.' });
    }
  });
}
