import { hasPreviewProxyCredential } from '../opencode/core-routes.js';

export function registerContentSearchRoutes(app, { contentSearch, uiAuthController } = {}) {
  app.post('/api/yuri/content-search/resume', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    if (hasPreviewProxyCredential(req)) return res.status(403).json({ error: 'Forbidden' });
    try {
      const bearer = /^Bearer\s+\S+$/i.test(req.headers.authorization ?? '');
      const authRequest = bearer ? Object.assign(Object.create(req), { headers: { ...req.headers, cookie: undefined } }) : req;
      const context = await uiAuthController?.resolveAuthContext(authRequest, res, { allowClientAuth: true, allowUrlToken: false });
      if (!context || context.type === 'client' && !context.clientId) return res.status(401).json({ error: 'authentication_required' });
      const origin = req.headers.origin;
      if (context.type !== 'client' && (req.headers['sec-fetch-site'] === 'cross-site' || origin && origin !== `${req.protocol}://${req.get('host')}`)) {
        return res.status(403).json({ error: 'origin_forbidden' });
      }
      if (!contentSearch) return res.status(503).json({ error: 'Global content index unavailable' });
      void contentSearch.runtime.sync({ resume: true }).catch(() => {});
      return res.status(202).json({ index: contentSearch.runtime.status() });
    } catch { return res.status(500).json({ error: 'index_resume_failed' }); }
  });
  app.get('/api/yuri/content-search', (req, res) => {
    if (hasPreviewProxyCredential(req)) return res.status(403).json({ error: 'Forbidden' });
    if (!contentSearch) return res.status(503).json({ error: 'Global content index unavailable' });
    const query = req.query.q ?? '';
    const limit = req.query.limit === undefined ? 30 : Number(req.query.limit);
    const directory = req.query.directory;
    if (typeof query !== 'string' || query.length > 500 || !Number.isInteger(limit) || limit < 1 || limit > 50
      || (directory !== undefined && typeof directory !== 'string')) return res.status(400).json({ error: 'Invalid content search query' });
    try {
      return res.json({ hits: contentSearch.service.search(contentSearch.getRuntimeKey(), query, { limit, directory }), index: contentSearch.runtime.status() });
    } catch {
      return res.status(500).json({ error: 'Global content search failed' });
    }
  });
}
