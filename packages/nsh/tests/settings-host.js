import { settingsEngineFixtureScope } from './settings-engine-fixture-scope.js';
/** Isolated native engine settings fixture; never used by the production Host. */
export function createHost() {
  const scope = settingsEngineFixtureScope('settings-ui-fixture');
  let attempts = 0;
  let firstBody;
  let savedTemplate = 'Original review template';
  let magicAttempts = 0;
  let magicResets = 0;
  let preferenceWrites = 0;
  let preferences = { chatRenderMode: 'sorted', messageStreamTransport: 'sse', diffLayoutPreference: 'inline' };
  let magicOverrides = { 'git.commit.generate.visible': 'Fixture visible override', 'git.commit.generate.instructions': 'Fixture instructions' };
  return { call(name, input) {
    if (name === 'connection.list') return scope.connection(input);
    if (name === 'settings.fixture.scope') return scope.control(input);
    if (name === 'settings.fixture.scopeAudit') return scope.audit(input);
    if (name !== 'runtime.request') throw new Error('Unexpected settings native call');
    scope.admit(input);
    if (input.method === 'GET' && input.body !== undefined || input.method === 'DELETE' && input.body !== undefined) throw new Error('Unexpected settings read/delete body');
    if (input.path === '/fixture/commands/audit' && input.method === 'GET') return { status: 200, body: { attempts } };
    if (input.path === '/fixture/preferences/audit' && input.method === 'GET') return { status: 200, body: { writes: preferenceWrites, preferences: { ...preferences } } };
    if (input.path === '/api/config/catalog/providers?directory=%2Fnative%2Fproject' && input.method === 'GET') return { status: 200, body: { schemaVersion: 1, providers: [{ id: 'example', name: 'Example provider', models: { model: { name: 'Example model', variants: { deep: {} }, capabilities: { tools: true, input: ['text'] } } } }] } };
    if (input.path === '/api/agent?location%5Bdirectory%5D=%2Fnative%2Fproject' && input.method === 'GET') return { status: 200, body: { data: [{ name: 'build', mode: 'primary' }, { name: 'plan', mode: 'primary' }] } };
    if (input.path === '/api/config/agents/metadata?directory=%2Fnative%2Fproject' && input.method === 'POST') {
      if (!input.body || Object.keys(input.body).join(',') !== 'names' || JSON.stringify(input.body.names) !== JSON.stringify(['build', 'plan'])) throw new Error('Unexpected settings Agent metadata payload');
      return { status: 200, body: { agents: { build: { scope: 'user' }, plan: { scope: 'user' } } } };
    }
    if (input.path === '/api/config/settings' && input.method === 'GET') return { status: 200, body: { favoriteModels: [], recentModels: [], hiddenModels: [], ...preferences } };
    if (input.path === '/api/config/settings' && input.method === 'PUT') {
      if (!input.body || JSON.stringify(Object.keys(input.body).sort()) !== JSON.stringify(['chatRenderMode', 'diffLayoutPreference', 'messageStreamTransport']) || input.body.chatRenderMode !== 'live' || input.body.diffLayoutPreference !== 'side-by-side' || input.body.messageStreamTransport !== 'ws') throw new Error('Unexpected preferences patch');
      preferenceWrites++; preferences = { ...input.body };
      return { status: 200, body: { ok: true } };
    }
    if (input.path === '/api/magic-prompts') {
      if (!['GET', 'DELETE'].includes(input.method)) throw new Error('Unexpected Magic prompt method');
      if (input.method === 'DELETE') magicOverrides = {};
      return { status: 200, body: { version: 1, overrides: { ...magicOverrides } } };
    }
    if (input.path.startsWith('/api/magic-prompts/')) {
      const id = decodeURIComponent(input.path.slice('/api/magic-prompts/'.length));
      if (input.method === 'PUT') {
        if (typeof input.body.text !== 'string' || !input.body.text.includes('Native edited magic')) throw new Error('Magic editor did not send its native draft');
        magicAttempts++;
        if (magicAttempts === 1) return { status: 409, body: { error: 'Magic fixture conflict' } };
        magicOverrides[id] = input.body.text;
        magicOverrides['git.commit.generate.instructions'] = `Magic writes: ${magicAttempts}`;
      } else if (input.method === 'DELETE') {
        magicResets++; delete magicOverrides[id];
        magicOverrides['git.commit.generate.instructions'] = `Magic resets: ${magicResets}`;
      } else throw new Error('Unexpected Magic prompt method');
      return { status: 200, body: { version: 1, overrides: { ...magicOverrides } } };
    }
    if (input.path === '/api/command?location%5Bdirectory%5D=%2Fnative%2Fproject' && input.method === 'GET') return { status: 200, body: { data: [{ name: 'review', description: attempts ? `Read-back save attempts: ${attempts}` : 'Review a change', template: savedTemplate }] } };
    if (input.path === '/api/config/commands/review?directory=%2Fnative%2Fproject' && input.method === 'PATCH') {
      if (Object.keys(input.body).join(',') !== 'template' || typeof input.body.template !== 'string' || !input.body.template.includes('Native edited review')) throw new Error('Command editor did not send its native draft');
      attempts++;
      if (attempts === 1) { firstBody = JSON.stringify(input.body); return { status: 409, body: { error: 'Settings revision conflict' } }; }
      if (JSON.stringify(input.body) !== firstBody) throw new Error('Retry changed the native settings draft');
      savedTemplate = input.body.template;
      return { status: 200, body: { ok: true } };
    }
    throw new Error('Unexpected settings request: ' + input.method + ' ' + input.path);
  } };
}
