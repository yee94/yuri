import { AssistantError, createAssistantsService } from './service.js';
import { sendContactAttachment } from './contact-attachment-response.js';
import { createChatCompletion } from '../llm/completions.js';
import { makeOpenCodeV2Client } from '../opencode/v2-client.js';
import path from 'node:path';
import { createWeixinRuntime } from './weixin/runtime.js';
import { registerWeixinRoutes } from './weixin/routes.js';
import { createAssistantChannelsRuntime } from './channels/runtime.js';
import { registerAssistantChannelRoutes } from './channels/routes.js';
import { createAssistantChannelAdapters } from './channels/sdk-adapters.js';

const respond = (res, work, success = 200) => Promise.resolve().then(work).then((body) => res.status(success).json(body)).catch((error) => { const code = error instanceof AssistantError ? error.code : error?.code || 'internal_error'; const status = code === 'not_found' ? 404 : ['revision_conflict', 'idempotency_conflict', 'contact_generation_conflict', 'attachment_retired', 'attachment_upload_inflight'].includes(code) ? 409 : code === 'assistant_disabled' ? 403 : code === 'no_provider' ? 400 : code === 'upstream_error' || code === 'llm_attachment_generation_unavailable' ? 502 : 400; res.status(status).json({ ok: false, error: code, message: typeof error?.message === 'string' && error.message.trim() ? error.message : code }); });
const gone = (_req, res) => res.status(410).json({ ok: false, error: 'assistant_topics_retired' });

export const registerContactAttachmentRoutes = (app, service) => {
  const uploads = '/api/yuri/assistants/:assistantID/contact/attachments/uploads/:uploadID';
  app.get(uploads, async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    try {
      const receipt = service.getAssistantContactAttachmentReceipt(req.params.assistantID, req.params.uploadID, req.query.generation);
      return res.status(receipt.state === 'not_found' ? 404 : 200).json(receipt);
    } catch (error) { return respond(res, () => { throw error; }); }
  });
  app.delete(uploads, (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    return respond(res, () => service.retireAssistantContactAttachment(req.params.assistantID, req.params.uploadID, req.body));
  });
  // Contact attachments: raw-byte PUT + opaque GET (content-addressed under dataDir).
  app.put('/api/yuri/assistants/:assistantID/contact/attachments/:uploadID', (req, res) => {
    const controller = new AbortController();
    req.once?.('aborted', () => controller.abort());
    return respond(res, () => service.putAssistantContactAttachment(req.params.assistantID, req.params.uploadID, {
      stream: req, headers: req.headers, signal: controller.signal, expectedGeneration: req.query.generation,
    }), 201);
  });
  app.get('/api/yuri/assistants/:assistantID/contact/attachments/:attachmentID', (req, res) => {
    return Promise.resolve()
      .then(() => service.getAssistantContactAttachment(req.params.assistantID, req.params.attachmentID))
      .then((file) => sendContactAttachment(req, res, file))
      .catch((error) => {
        const code = error instanceof AssistantError ? error.code : error?.code || 'internal_error';
        const status = code === 'not_found' ? 404
          : ['revision_conflict', 'idempotency_conflict', 'contact_generation_conflict', 'attachment_retired'].includes(code) ? 409
          : code === 'assistant_disabled' ? 403
          : code === 'PROMPT_ATTACHMENT_TOO_LARGE' ? 413
          : code === 'upstream_error' ? 502 : 400;
        res.status(status).json({ ok: false, error: code, message: typeof error?.message === 'string' && error.message.trim() ? error.message : code });
      });
  });
};

export const registerAssistantRoutes = (app, dependencies) => {
  let weixin;
  let channels;
  const boundCompletion = (input) => createChatCompletion({
    ...input,
    buildOpenCodeUrl: dependencies.buildOpenCodeUrl,
    getOpenCodeAuthHeaders: dependencies.getOpenCodeAuthHeaders,
    clientFactory: () => makeOpenCodeV2Client({
      baseUrl: dependencies.buildOpenCodeUrl('/', '').replace(/\/$/, ''),
      authHeaders: dependencies.getOpenCodeAuthHeaders(),
    }),
    // Contact activity continues through the existing event hub; inference executes no OpenCode tools.
    globalEventHub: input?.globalEventHub ?? dependencies.globalEventHub,
    persistSessionMetadata: dependencies.persistSessionMetadata,
    onSystemSessionPersisted: dependencies.onSystemSessionPersisted,
  });
  const service = createAssistantsService({
    dbPath: dependencies.dbPath,
    dataDir: dependencies.yuriDataDir,
    buildOpenCodeUrl: dependencies.buildOpenCodeUrl,
    getOpenCodeAuthHeaders: dependencies.getOpenCodeAuthHeaders,
    getServerId: dependencies.getServerId,
    getAllowedRoots: dependencies.getAllowedRoots,
    listProjects: dependencies.listProjects,
    remoteHostGateway: dependencies.remoteHostGateway,
    registerProject: dependencies.registerProject,
    readModelPreferences: dependencies.readModelPreferences,
    listScheduledTasks: dependencies.listScheduledTasks,
    sessionIndexService: dependencies.sessionIndexService,
    upsertScheduledTask: dependencies.upsertScheduledTask,
    patchScheduledTask: dependencies.patchScheduledTask,
    syncScheduledTaskProject: dependencies.syncScheduledTaskProject,
    globalEventHub: dependencies.globalEventHub,
    onRevisionTip: dependencies.onRevisionTip,
    onContactTurnEvent: (event) => {
      weixin?.onTurnEvent(event);
      channels?.onTurnEvent(event);
      dependencies.onContactTurnEvent?.(event);
    },
    onContactTurnComplete: dependencies.onContactTurnComplete,
    archiveSessionHost: dependencies.archiveSessionHost,
    forgetSessionHost: dependencies.forgetSessionHost,
    persistSessionMetadata: dependencies.persistSessionMetadata,
    onSystemSessionPersisted: dependencies.onSystemSessionPersisted,
    createChatCompletion: boundCompletion,
  });
  const unsubscribeTaskResults = dependencies.setTaskResultHandler?.((run) => service.reportScheduledTaskResult(run));
  app.use('/api/yuri/assistants', (req, res, next) => Promise.resolve(dependencies.refreshAllowedRoots?.()).then(next).catch((error) => respond(res, () => { throw error; })));
  app.get('/api/yuri/assistants/capability', (_req, res) => respond(res, () => service.capability()));
  const snapshot = async () => { await service.ensureDefaultAssistant(); return service.snapshot(); };
  app.get('/api/yuri/assistants', (_req, res) => respond(res, snapshot)); app.get('/api/yuri/assistants/snapshot', (_req, res) => respond(res, snapshot)); app.put('/api/yuri/assistants/settings', (req, res) => respond(res, () => service.setEnabled(req.body)));
  app.post('/api/yuri/assistants', (req, res) => respond(res, () => service.createAssistant(req.body), 201)); app.patch('/api/yuri/assistants/:assistantID', (req, res) => respond(res, () => service.updateAssistant(req.params.assistantID, req.body))); app.delete('/api/yuri/assistants/:assistantID', (req, res) => respond(res, async () => {
    const result = service.removeAssistant(req.params.assistantID, req.body?.expectedRevision);
    await weixin.forget(req.params.assistantID);
    await channels.forget(req.params.assistantID);
    return result;
  }));
  app.post('/api/yuri/assistants/:assistantID/session/ensure', (req, res) => respond(res, () => service.ensure(req.params.assistantID))); app.post('/api/yuri/assistants/:assistantID/session/new', (req, res) => respond(res, () => service.createNew(req.params.assistantID))); app.post('/api/yuri/assistants/:assistantID/session/compact', (req, res) => respond(res, () => service.compact(req.params.assistantID, req.body))); app.post('/api/yuri/assistants/:assistantID/session/abort', (req, res) => respond(res, () => service.abort(req.params.assistantID, req.body)));
  app.get('/api/yuri/assistants/:assistantID/messages', (req, res) => respond(res, () => service.historicalMessages(req.params.assistantID, req.query)));
  app.get('/api/yuri/assistants/:assistantID/contact/messages', (req, res) => respond(res, () => service.contactMessages(req.params.assistantID, req.query)));
  app.post('/api/yuri/assistants/:assistantID/contact/reset', (req, res) => respond(res, () => service.resetContact(req.params.assistantID)));
  // Shared multi-client contact read watermark (monotonic; generation-fenced).
  app.post('/api/yuri/assistants/:assistantID/contact/read', (req, res) => respond(res, () => service.markContactRead(req.params.assistantID, req.body)));
  app.post('/api/yuri/assistants/:assistantID/contact/cards', (req, res) => respond(res, () => service.appendContactCard(req.params.assistantID, req.body), 201));
  app.post('/api/yuri/assistants/:assistantID/contact/dm', (req, res) => respond(res, () => service.deliverPeerMessage(req.params.assistantID, req.body), 201));
  registerContactAttachmentRoutes(app, service);
  app.get('/api/yuri/assistants/:assistantID/scheduled-tasks', (req, res) => respond(res, () => service.listAssistantScheduledTasks(req.params.assistantID)));
  // Contact send admits the user message at 202; assistant bubbles stream on SSE.
  app.post('/api/yuri/assistants/:assistantID/messages', (req, res) => respond(res, () => service.send(req.params.assistantID, req.body), 202)); app.post('/api/yuri/assistants/:assistantID/share', (req, res) => respond(res, () => service.share(req.params.assistantID, req.body), 202)); app.get('/api/yuri/assistants/share-operations/:operationID', (req, res) => respond(res, () => { const operation = service.shareOperation(req.params.operationID); if (!operation) throw new AssistantError('not_found'); return operation; }));
  app.use('/api/yuri/assistants/topics', gone); app.use('/api/yuri/assistants/:assistantID/topics', gone);
  weixin = createWeixinRuntime({
    directory: path.join(dependencies.yuriDataDir, 'weixin'), service,
    refreshAllowedRoots: dependencies.refreshAllowedRoots,
    ...(dependencies.weixinAPI ? { api: dependencies.weixinAPI } : {}),
  });
  registerWeixinRoutes(app, weixin);
  channels = createAssistantChannelsRuntime({
    directory: path.join(dependencies.yuriDataDir, 'channels'), service,
    refreshAllowedRoots: dependencies.refreshAllowedRoots,
    adapters: dependencies.assistantChannelAdapters ?? createAssistantChannelAdapters(),
    ...(dependencies.channelsEnv ? { env: dependencies.channelsEnv } : {}),
  });
  registerAssistantChannelRoutes(app, channels);
  return { service, close: async () => {
    unsubscribeTaskResults?.();
    await Promise.all([weixin.close(), channels.close()]);
    service.close();
  } };
};
