const failureStatus = (code) => code === 'not_found' ? 404
  : ['account_in_use', 'already_bound', 'channel_in_use'].includes(code) ? 409
    : ['network_error', 'upstream_error', 'invalid_response'].includes(code) ? 502 : 400;

/** Runs behind the Host's existing authenticated Yuri route gate. No public webhook. */
export function registerWeixinRoutes(app, runtime) {
  const root = '/api/yuri/assistants/:assistantID/weixin';
  const respond = (res, work) => {
    res.setHeader('Cache-Control', 'no-store');
    Promise.resolve().then(work).then((body) => res.json(body)).catch((error) => {
      const allowed = new Set(['not_found', 'account_in_use', 'already_bound', 'channel_in_use', 'network_error',
        'upstream_error', 'invalid_response', 'validation_error', 'auth_expired', 'cancelled']);
      const code = allowed.has(error?.code) ? error.code : 'channel_error';
      // Never return upstream bodies, credentials or QR-status payloads as errors.
      res.status(failureStatus(code)).json({ error: code });
    });
  };
  app.get(root, (req, res) => respond(res, () => runtime.status(req.params.assistantID)));
  app.post(`${root}/login`, (req, res) => respond(res, () => runtime.startLogin(req.params.assistantID, req.body?.language)));
  app.post(`${root}/verify`, (req, res) => respond(res, () => runtime.verify(req.params.assistantID, req.body?.code)));
  app.post(`${root}/retry`, (req, res) => respond(res, () => runtime.retry(req.params.assistantID)));
  app.delete(root, (req, res) => respond(res, () => runtime.disconnect(req.params.assistantID)));
}
