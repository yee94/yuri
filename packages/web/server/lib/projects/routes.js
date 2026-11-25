/**
 * Host HTTP routes for creating and updating 0..N-path workspaces.
 * Uses the shared projectRegistry so UI, Yuri skill, and settings sync share
 * one atomic persistence and path-validation boundary.
 */
export const registerWorkspaceRoutes = (app, {
  express,
  projectRegistry,
  onProjectsMutated = null,
}) => {
  app.post('/api/yuri/workspaces', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const body = req.body ?? {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ code: 'validation_error', error: 'Request body must be a JSON object' });
      }
      const { project, created, settings } = await projectRegistry.register({
        ...(Array.isArray(body.paths) ? { paths: body.paths } : {}),
        ...(typeof body.path === 'string' ? { path: body.path } : {}),
        ...(typeof body.primaryPath === 'string' ? { primaryPath: body.primaryPath } : {}),
        ...(typeof body.label === 'string' ? { label: body.label } : {}),
        ...(body.activate === true ? { activate: true } : {}),
        ...(body.prepend === true ? { prepend: true } : {}),
        ...(body.createWorkspace === true ? { createWorkspace: true } : {}),
      });
      await onProjectsMutated?.(settings);
      return res.status(created ? 201 : 200).json({ project, created, settings });
    } catch (error) {
      const code = error?.code === 'validation_error' ? 'validation_error'
        : error?.code === 'not_found' ? 'not_found'
          : 'workspace_operation_failed';
      const status = code === 'validation_error' ? 400 : code === 'not_found' ? 404 : 500;
      return res.status(status).json({ code, error: error?.message || 'Workspace creation failed' });
    }
  });

  app.patch('/api/yuri/workspaces/:projectId', express.json({ limit: '64kb' }), async (req, res) => {
    try {
      const body = req.body ?? {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ code: 'validation_error', error: 'Request body must be a JSON object' });
      }
      const { project, settings } = await projectRegistry.update({
        projectId: req.params.projectId,
        ...(body.label !== undefined ? { label: body.label } : {}),
        ...(body.paths !== undefined ? { paths: body.paths } : {}),
        ...(body.addPath !== undefined ? { addPath: body.addPath } : {}),
        ...(body.removePath !== undefined ? { removePath: body.removePath } : {}),
        ...(body.primaryPath !== undefined ? { primaryPath: body.primaryPath } : {}),
      });
      await onProjectsMutated?.(settings);
      return res.json({ project, settings });
    } catch (error) {
      const code = error?.code === 'validation_error' ? 'validation_error'
        : error?.code === 'not_found' ? 'not_found'
          : 'workspace_operation_failed';
      const status = code === 'validation_error' ? 400 : code === 'not_found' ? 404 : 500;
      return res.status(status).json({ code, error: error?.message || 'Workspace update failed' });
    }
  });
};
