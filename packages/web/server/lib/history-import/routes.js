import { createHistoryImportService } from './service.js';
import { hasPreviewProxyCredential } from '../opencode/core-routes.js';

export function registerHistoryImportRoutes(app, { express, uiAuthController, service: provided, ...dependencies }) {
  const service = provided ?? createHistoryImportService(dependencies);
  // All routes inherit the Host UI/client authentication gate. Plans and jobs
  // additionally belong to the authenticated device (or the local owner UI).
  const owner = async (req, res) => {
    if (hasPreviewProxyCredential(req)) throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    const context = await uiAuthController?.resolveAuthContext(req, res, { allowUrlToken: false });
    if (!context || context.type === 'client' && !context.clientId) throw Object.assign(new Error('authentication_required'), { code: 'authentication_required' });
    return context.type === 'client' ? `client:${context.clientId}` : 'owner';
  };
  const handle = (operation) => async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try { res.json(await operation(req, await owner(req, res))); }
    catch (error) {
      const code = typeof error?.code === 'string' && /^[a-z_]+$/.test(error.code) ? error.code : 'import_failed';
      const status = code === 'authentication_required' ? 401 : code === 'forbidden' ? 403 : ['import_busy', 'plan_expired', 'source_changed', 'target_changed'].includes(code) ? 409
        : ['source_too_large', 'settings_too_large', 'too_many_files', 'too_many_sessions'].includes(code) ? 413
          : code === 'import_failed' ? 500 : 400;
      res.status(status).json({ code });
    }
  };
  const json = express.json({ limit: '2mb' });
  app.post('/api/yuri/history-import/scan', json, handle((req, actor) => service.scan(req.body ?? {}, actor)));
  app.post('/api/yuri/history-import/imported', json, handle((req, actor) => service.imported(req.body ?? {}, actor)));
  app.post('/api/yuri/history-import/preview', json, handle((req, actor) => service.preview(req.body ?? {}, actor)));
  app.post('/api/yuri/history-import/start', json, handle((req, actor) => service.start(req.body ?? {}, actor)));
  app.post('/api/yuri/history-import/resume', json, handle((req, actor) => {
    const origin = req.headers.origin;
    if (actor === 'owner' && (req.headers['sec-fetch-site'] === 'cross-site' || origin && origin !== `${req.protocol}://${req.get('host')}`)) {
      throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    }
    return service.resume(req.body ?? {}, actor);
  }));
  app.post('/api/yuri/history-import/dismiss', json, handle((req, actor) => {
    const origin = req.headers.origin;
    if (actor === 'owner' && (req.headers['sec-fetch-site'] === 'cross-site' || origin && origin !== `${req.protocol}://${req.get('host')}`)) {
      throw Object.assign(new Error('forbidden'), { code: 'forbidden' });
    }
    return service.dismiss(req.body ?? {}, actor);
  }));
  app.get('/api/yuri/history-import/jobs', handle((_req, actor) => service.jobs(actor)));
  app.get('/api/yuri/history-import/job', handle((req, actor) => service.status(typeof req.query.id === 'string' ? req.query.id : undefined, actor)));
  app.post('/api/yuri/history-import/cancel', json, handle((req, actor) => service.cancel(req.body?.id, actor)));
  return service;
}
