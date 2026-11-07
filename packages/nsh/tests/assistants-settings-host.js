/** Local fixture only. This module never contacts a real Host or model provider. */
export function createHost() {
  const bot = { id: 'bot/a', name: 'Configuration Bot', revision: 2, defaultPrompt: 'Fixture prompt', providerID: 'fixture', modelID: 'native-model', workspacePath: null, effectiveWorkspacePath: '/workspace/project', managedWorkspacePath: '/workspace/project', pinnedAt: null };
  const task = { id: 'daily', name: 'Linked native schedule', enabled: true, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { prompt: 'Fixture linked schedule prompt', providerID: 'fixture', modelID: 'native-model' }, state: {} };
  let snapshotAttempts = 0, channelAttempts = 0, clearAttempts = 0;
  let channel = { provider: 'feishu', status: 'disconnected', configured: false, hasSecret: false, clientID: '', ownerID: '', error: null, transferSources: [{ assistantID: 'other', name: 'Previous bot', revision: 'r1', clientID: 'imported-client' }] };
  return { call(name, input) {
    if (name !== 'runtime.request') throw new Error('Unexpected native call');
    const { path, method, body } = input;
    const ok = body => ({ status: 200, body });
    if (path === '/api/yuri/assistants/capability') return ok({ supported: true, enabled: true });
    if (path === '/api/yuri/assistants/snapshot') return ++snapshotAttempts === 1 ? { status: 503, body: { message: 'fixture_catalog_offline' } } : ok({ enabled: true, revision: 3, assistants: [bot] });
    if (path === '/api/yuri/assistants/bot%2Fa/scheduled-tasks') return ok({ tasks: [{ projectID: 'project', taskID: task.id, task }], complete: true });
    if (path === '/api/yuri/scheduled-tasks') return ok({ tasks: [{ projectId: 'project', task }], failedProjectIds: [] });
    if (path.startsWith('/api/yuri/scheduled-task-runs?')) return ok({ runs: [], complete: true, nextCursor: null });
    if (path.startsWith('/api/config/catalog/providers')) return ok({ schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture', models: { 'native-model': { id: 'native-model', name: 'Native model' } } }] });
    if (path.startsWith('/api/agent?')) return ok({ data: [] });
    if (path === '/api/yuri/assistants/bot%2Fa/channels/feishu' && method === 'GET') return ++channelAttempts === 1 ? { status: 503, body: { message: 'fixture_channel_offline' } } : ok(channel);
    if (path === '/api/yuri/assistants/bot%2Fa/channels/feishu/transfer') {
      if (body.sourceAssistantID !== 'other' || body.revision !== 'r1') throw new Error('Invalid transfer fence');
      channel = { ...channel, configured: true, status: 'connected', hasSecret: true, clientID: 'imported-client', ownerID: 'imported-owner', transferSources: [] };
      return ok(channel);
    }
    if (path === '/api/yuri/assistants/bot%2Fa/channels/feishu' && method === 'PUT') {
      if (body.clientID !== 'imported-client' || body.ownerID !== 'imported-owner' || body.clientSecret !== undefined) throw new Error('Transferred fields were not authoritative');
      return ok(channel);
    }
    if (path === '/api/yuri/assistants/bot%2Fa/contact/reset' && method === 'POST') return ++clearAttempts === 1 ? { status: 500, body: { message: 'fixture_clear_failed' } } : ok({ assistantID: bot.id, reset: true, historyCleared: true, generation: 2 });
    throw new Error(`Unexpected assistant fixture request: ${method} ${path}`);
  } };
}
