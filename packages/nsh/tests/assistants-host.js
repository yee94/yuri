import { settingsEngineFixtureScope } from './settings-engine-fixture-scope.js';
import { fixtureRequest } from './new-session-request.js';

/** In-memory synthetic Assistant catalog; no real Host, credentials or transport. */
export function createHost() {
  const scope = settingsEngineFixtureScope('assistants-fixture');
  let requests = 0, deleteAttempts = 0, auditReads = 0;
  const bots = [
    { id: 'a', revision: 1, name: 'Research Bot', defaultPrompt: 'Never use personality as preview', providerID: 'fixture', modelID: 'model', workspacePath: null, effectiveWorkspacePath: '/workspace', pinnedAt: null, unreadCount: 2, latestMessagePreview: { text: 'Authoritative latest reply', createdAt: Date.now(), fallbackKind: null } },
    { id: 'b', revision: 2, name: 'Review Bot', pinnedAt: 3, unreadCount: 0, latestMessagePreview: { text: 'Review ready', createdAt: 2 } },
  ];
  const ok = body => ({ status: 200, body });
  return { call(name, input) {
    if (name === 'connection.list') return scope.connection(input);
    if (name === 'settings.fixture.scope') return scope.control(input);
    if (name === 'settings.fixture.scopeAudit') return scope.audit(input);
    if (name !== 'runtime.request') throw new Error('Unexpected Assistant native call: ' + name);
    scope.admit(input);
    const route = fixtureRequest(input), { path, method } = route, { body } = input;
    if (method === 'GET' && body !== undefined) throw new Error('Unexpected Assistant read body');
    if (path === '/fixture/assistants/audit') { route.expect('GET'); return ok({ requests, deleteAttempts, auditReads: ++auditReads }); }
    requests++;
    if (path === '/api/yuri/assistants/a' && method === 'DELETE') {
      route.expect('DELETE');
      if (!body || Object.keys(body).join(',') !== 'expectedRevision' || body.expectedRevision !== 1) throw new Error('Invalid Assistant deletion revision');
      deleteAttempts++; return { status: 500, body: { message: 'delete_test_failure' } };
    }
    if (path === '/api/yuri/assistants/capability') { route.expect('GET'); return ok({ supported: true, enabled: true, sharingAvailable: true }); }
    if (path === '/api/yuri/assistants/snapshot') { route.expect('GET'); return ok({ enabled: true, revision: 3, assistants: bots }); }
    if (path === '/api/yuri/assistants/a/scheduled-tasks') { route.expect('GET'); return ok({ tasks: [], complete: true }); }
    if (path === '/api/yuri/assistants/a/channels/wecom') { route.expect('GET'); return ok({ provider: 'wecom', status: 'disabled', configured: false, hasSecret: false, error: null, transport: 'websocket' }); }
    if (path === '/api/config/catalog/providers') { route.expect('GET'); return ok({ schemaVersion: 1, providers: [{ id: 'fixture', name: 'Fixture', models: { model: { id: 'model', name: 'Model' } } }] }); }
    throw new Error('Unexpected Assistant fixture request: ' + method + ' ' + path);
  } };
}
