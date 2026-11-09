import { settingsEngineFixtureScope } from './settings-engine-fixture-scope.js';
import { fixtureRequest } from './new-session-request.js';
/** Local fixture only. This module never contacts a real Host or model provider. */
export function createHost() {
  const scope = settingsEngineFixtureScope('fixture-settings');
  const bot = { id: 'bot/a', name: 'Configuration Bot', revision: 2, defaultPrompt: 'Fixture prompt', providerID: 'fixture', modelID: 'native-model', workspacePath: null, effectiveWorkspacePath: '/workspace/project', managedWorkspacePath: '/workspace/project', pinnedAt: null };
  const task = { id: 'daily', name: 'Linked native schedule', enabled: true, schedule: { kind: 'daily', times: ['09:00'], timezone: 'UTC' }, execution: { prompt: 'Fixture linked schedule prompt', providerID: 'fixture', modelID: 'native-model' }, state: {} };
  let snapshotAttempts = 0, channelAttempts = 0, clearAttempts = 0, requests = 0, transfers = 0, channelWrites = 0, auditReads = 0, contactReads = 0;
  let resetScenario = 'ack', contactGeneration = 1, contactRevision = 3;
  let channel = { provider: 'feishu', status: 'disconnected', configured: false, hasSecret: false, clientID: '', ownerID: '', error: null, transferSources: [{ assistantID: 'other', name: 'Previous bot', revision: 'r1', clientID: 'imported-client' }] };
  return { call(name, input) {
    if (name === 'connection.list') return scope.connection(input);
    if (name === 'settings.fixture.scope') return scope.control(input);
    if (name === 'settings.fixture.scopeAudit') return scope.audit(input);
    if (name !== 'runtime.request') throw new Error('Unexpected native call');
    scope.admit(input);
    const { path, method, body } = input;
    const route = fixtureRequest(input);
    if (method === 'GET' && body !== undefined) throw new Error('Unexpected assistant fixture read body');
    const ok = body => ({ status: 200, body });
    if (path === '/fixture/assistants-settings/audit') { route.expect('GET'); return ok({ requests, snapshotAttempts, channelAttempts, transfers, channelWrites, clearAttempts, contactReads, auditReads: ++auditReads }); }
    if (path === '/fixture/assistants-settings/reset-scenario') {
      route.expect('PUT');
      if (!body || Object.keys(body).join(',') !== 'mode' || !['unknown', 'unknown-read-failed'].includes(body.mode) || resetScenario !== 'ack' || clearAttempts) throw new Error('Invalid fixture reset scenario');
      resetScenario = body.mode; return ok({ mode: resetScenario });
    }
    requests++;
    if (path === '/api/yuri/assistants/capability') { route.expect('GET'); return ok({ supported: true, enabled: true }); }
    if (path === '/api/yuri/assistants/snapshot') { route.expect('GET'); return ++snapshotAttempts === 1 ? { status: 503, body: { message: 'fixture_catalog_offline' } } : ok({ enabled: true, revision: 3, assistants: [bot] }); }
    if (path === '/api/yuri/assistants/bot%2Fa/scheduled-tasks') { route.expect('GET'); return ok({ tasks: [{ projectID: 'project', taskID: task.id, task }], complete: true }); }
    if (path === '/api/yuri/scheduled-tasks') { route.expect('GET'); return ok({ tasks: [{ projectId: 'project', task }], failedProjectIds: [] }); }
    if (path === '/api/yuri/scheduled-task-runs?limit=20&projectId=project&taskId=daily') { route.expect('GET', ['limit', 'projectId', 'taskId']); return ok({ runs: [], complete: true, nextCursor: null }); }
    if (path === '/api/config/catalog/providers' || path === '/api/config/catalog/providers?directory=%2Fworkspace%2Fproject') { route.expect('GET', ['directory']); return ok({ schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture', models: { 'native-model': { id: 'native-model', name: 'Native model' } } }] }); }
    if (path === '/api/config/settings/bootstrap') { route.expect('GET'); return ok({ schemaVersion: 1, defaultModel: 'fixture/native-model', defaultVariant: '' }); }
    if (path === '/api/config') { route.expect('GET'); return ok({ data: [{ type: 'document', info: { model: 'fixture/native-model' } }] }); }
    if (path === '/api/yuri/assistants/bot%2Fa/channels/feishu' && method === 'GET') return ++channelAttempts === 1 ? { status: 503, body: { message: 'fixture_channel_offline' } } : ok(channel);
    if (path === '/api/yuri/assistants/bot%2Fa/channels/feishu/transfer') {
      route.expect('POST');
      if (!body || Object.keys(body).sort().join(',') !== 'revision,sourceAssistantID' || body.sourceAssistantID !== 'other' || body.revision !== 'r1' || !channel.transferSources.length) throw new Error('Invalid transfer fence');
      transfers++;
      channel = { ...channel, configured: true, status: 'connected', hasSecret: true, clientID: 'imported-client', ownerID: 'imported-owner', transferSources: [] };
      return ok(channel);
    }
    if (path === '/api/yuri/assistants/bot%2Fa/channels/feishu' && method === 'PUT') {
      if (!body || Object.keys(body).sort().join(',') !== 'clientID,language,ownerID' || body.language !== 'en' || body.clientID !== 'imported-client' || body.ownerID !== 'imported-owner' || body.clientSecret !== undefined || !channel.configured) throw new Error('Transferred fields were not authoritative');
      channelWrites++;
      return ok(channel);
    }
    if (path === '/api/yuri/assistants/bot%2Fa/contact/reset' && method === 'POST') {
      if (body !== undefined) throw new Error('Unexpected wipe payload');
      if (clearAttempts) throw new Error('Repeated fixture history reset');
      clearAttempts++; contactGeneration++; contactRevision++;
      return resetScenario === 'ack' ? ok({ assistantID: bot.id, reset: true, historyCleared: true, generation: contactGeneration }) : { status: 500, body: { message: 'fixture_clear_failed' } };
    }
    if (path === '/api/yuri/assistants/bot%2Fa/contact/messages?limit=1') {
      route.expect('GET', ['limit'], ['limit']); contactReads++;
      return resetScenario === 'unknown-read-failed' ? { status: 503, body: { message: 'fixture_contact_read_failed' } }
        : ok({ messages: [], nextCursor: null, complete: true, generation: contactGeneration, revision: contactRevision });
    }
    throw new Error(`Unexpected assistant fixture request: ${method} ${path}`);
  } };
}
