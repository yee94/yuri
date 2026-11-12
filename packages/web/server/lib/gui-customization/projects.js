import path from 'node:path';
import { authorizeScheduledTaskSkillRequest } from '../scheduled-tasks/session-skill-contract.js';

export const PROJECTS_SKILL_PATH = '/api/yuri/session-skills/projects';

const projectResult = ({ id, path, label }) => ({ id, path, ...(label ? { label } : {}) });
const validInput = (operation, input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const allowed = operation === 'add' ? ['path', 'label'] : [];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return false;
  if (Object.entries(input).some(([key, value]) => typeof value !== 'string' || !value.trim()
    || value.length > (key === 'label' ? 80 : 4096) || /[\x00-\x1f]/.test(value))) return false;
  return operation !== 'add' || (typeof input.path === 'string' && path.isAbsolute(input.path.trim()));
};

/** Session-bound Host registration; the shared project registry owns persistence. */
export function registerProjectsSkill(app, { express, getIsSharedOpenCodeService, getOpenCodeAuthHeaders, createClient, registerProject, readSettingsFromDiskStrict, sanitizeProjects }) {
  app.post(PROJECTS_SKILL_PATH, express.json({ limit: '16kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!getIsSharedOpenCodeService() || !authorizeScheduledTaskSkillRequest(req, getOpenCodeAuthHeaders())) return res.status(403).json({ error: 'Forbidden' });
    const { sessionID, operation, input = {} } = req.body ?? {};
    if (typeof sessionID !== 'string' || !sessionID || sessionID.length > 256
      || !['describe', 'list', 'add'].includes(operation) || !validInput(operation, input)) return res.status(400).json({ code: 'invalid_input', error: 'Invalid project input' });
    try {
      const session = await createClient().session.get({ sessionID });
      const hostOrigin = `http://${req.socket.localAddress === '::1' ? '[::1]' : '127.0.0.1'}:${req.socket.localPort}`;
      if (session.metadata?.yuri?.scheduledTaskSkill?.hostOrigin !== hostOrigin) return res.status(403).json({ error: 'Session is not bound to this Host' });
      if (operation === 'describe') return res.json({ supported: true, inputs: { add: '{path: existing absolute Host directory, label?: display name}', list: '{}' },
        completion: 'add returns the persisted project and created=true/false. Registration does not clone/create files, open a session or change an existing active selection. Retry the same path safely after an interrupted response.' });
      if (operation === 'list') {
        const settings = await readSettingsFromDiskStrict();
        if (!settings || typeof settings !== 'object' || Array.isArray(settings)
          || (settings.projects !== undefined && !Array.isArray(settings.projects))) throw new Error('Invalid project settings');
        return res.json({ projects: (sanitizeProjects(settings.projects) || []).map(projectResult) });
      }
      const { project, created } = await registerProject(input);
      return res.json({ project: projectResult(project), created });
    } catch (error) {
      const code = ['validation_error', 'project_unavailable'].includes(error?.code) ? error.code : 'project_operation_failed';
      return res.status(code === 'validation_error' ? 400 : 503).json({ code, error: 'Project operation was not confirmed; check the path or retry the same path after recovery' });
    }
  });
}
