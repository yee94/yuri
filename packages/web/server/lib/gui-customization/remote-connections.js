import { authorizeScheduledTaskSkillRequest } from '../scheduled-tasks/session-skill-contract.js';

export const REMOTE_CONNECTIONS_SKILL_PATH = '/api/yuri/session-skills/remote-connections';

const validInput = (operation, input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const allowed = operation === 'setup' ? ['id', 'sshCommand', 'nickname'] : operation === 'pair' ? ['id', 'relayUrl', 'label'] : [];
  if (Object.keys(input).some((key) => !allowed.includes(key))) return false;
  if (Object.values(input).some((value) => typeof value !== 'string' || !value.trim() || value.length > 1024 || /[\x00-\x1f]/.test(value))) return false;
  if (operation === 'setup' && (Boolean(input.id) === Boolean(input.sshCommand) || (input.id && input.nickname))) return false;
  if (input.relayUrl) {
    try {
      const url = new URL(input.relayUrl);
      if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return false;
    } catch { return false; }
  }
  return true;
};

/** Loopback + service credential + admitted-session binding, never browser/native IPC. */
export function registerRemoteConnectionsSkill(app, { express, adapter, getIsSharedOpenCodeService, getOpenCodeAuthHeaders, createClient }) {
  app.post(REMOTE_CONNECTIONS_SKILL_PATH, express.json({ limit: '16kb' }), async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!getIsSharedOpenCodeService() || !authorizeScheduledTaskSkillRequest(req, getOpenCodeAuthHeaders())) return res.status(403).json({ error: 'Forbidden' });
    if (!adapter) return res.status(501).json({ code: 'remote_connections_unsupported', error: 'Requires the local desktop Host' });
    const { sessionID, operation, input = {} } = req.body ?? {};
    if (typeof sessionID !== 'string' || !sessionID || !['describe', 'list', 'setup', 'pair'].includes(operation) || !validInput(operation, input)) return res.status(400).json({ code: 'invalid_input', error: 'Invalid connection input' });
    try {
      const session = await createClient().session.get({ sessionID });
      const hostOrigin = `http://${req.socket.localAddress === '::1' ? '[::1]' : '127.0.0.1'}:${req.socket.localPort}`;
      if (session.metadata?.yuri?.scheduledTaskSkill?.hostOrigin !== hostOrigin) return res.status(403).json({ error: 'Session is not bound to this Host' });
      if (operation === 'describe') return res.json({ supported: true,
        inputs: { setup: '{sshCommand, nickname?} or {id}', pair: '{id?, relayUrl?, label?}; omitted id means this local desktop', list: '{}' },
        completion: 'setup starts asynchronous SSH installation and config sync. Poll list until running=false; phase=ready alone does not confirm sync or Magpie gateway. Warnings mean partial completion.',
      });
      return res.json(await adapter[operation](input));
    } catch (error) {
      const status = { invalid_input: 400, instance_not_found: 404, external_instance: 409, instance_not_ready: 409 }[error?.message];
      if (Number.isInteger(status)) return res.status(status).json({ code: error.message, error: 'Check the connection input or saved instance status' });
      return res.status(503).json({ code: 'remote_connection_failed', error: 'Connection operation unavailable; check saved instance status before retrying' });
    }
  });
}
