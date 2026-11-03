const SAFE_ERRORS = new Set([
  'validation_error',
  'not_found',
  'account_in_use',
  'channel_in_use',
  'channel_disabled',
  'unsupported_provider',
  'auth_failed',
  'auth_expired',
  'network_error',
  'upstream_error',
  'invalid_response',
  'rate_limited',
  'delivery_failed',
  'delivery_unknown',
  'backlog_full',
  'cancelled',
  'binding_changed',
  'connection_replaced',
]);

const failureStatus = (code) => code === 'channel_disabled' ? 403
  : code === 'not_found' ? 404
    : ['account_in_use', 'channel_in_use', 'binding_changed', 'connection_replaced'].includes(code) ? 409
      : ['network_error', 'upstream_error'].includes(code) ? 502
        : 400;

/**
 * Runs behind the Host's existing authenticated Yuri route gate. There is no
 * public webhook: every mutation is scoped to one Bot and one provider.
 */
export function registerAssistantChannelRoutes(app, runtime) {
  const root = '/api/yuri/assistants/:assistantID/channels/:provider';
  const respond = (res, work) => {
    res.setHeader('Cache-Control', 'no-store');
    Promise.resolve().then(work).then((body) => res.json(body)).catch((error) => {
      // Never return upstream bodies, credentials or routing targets as errors.
      const code = SAFE_ERRORS.has(error?.code) ? error.code : 'channel_error';
      res.status(failureStatus(code)).json({ error: code });
    });
  };
  app.get(root, (req, res) => respond(res, () => runtime.status(req.params.assistantID, req.params.provider)));
  app.put(root, (req, res) => respond(res, () => runtime.save(req.params.assistantID, req.params.provider, req.body)));
  app.post(`${root}/retry`, (req, res) => respond(res, () => runtime.retry(req.params.assistantID, req.params.provider)));
  app.post(`${root}/transfer`, (req, res) => respond(res, () => runtime.transfer(req.params.assistantID, req.params.provider, req.body)));
  app.delete(root, (req, res) => respond(res, () => runtime.disconnect(req.params.assistantID, req.params.provider)));
}
