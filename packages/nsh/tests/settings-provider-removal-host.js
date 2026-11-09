import { fixtureRequest } from './new-session-request.js';

/** Isolated in-memory destructive fixture; never connects to a real Host/configuration. */
export function createHost() {
  const ids = ['target', 'environment', 'runtime', 'partial-config', 'partial-credential', 'refresh'];
  const rows = ids.map(id => ({ id, files: id === 'runtime' ? [] : ['/fixture/user.jsonc', '/fixture/project/opencode.json'],
    credentials: id === 'runtime' ? [] : [`${id}/a`, `${id}/b`], configAttempts: 0, credentialAttempts: {}, configFailed: false, credentialFailed: false, refreshFailed: false }));
  let directory, lastDeleted = '';
  const present = row => row.files.length > 0 || row.credentials.length > 0 || ['environment', 'runtime'].includes(row.id);
  const connections = row => [...row.credentials.map(id => ({ type: 'credential', id, method: 'key', label: 'Fixture account' })), ...(row.id === 'environment' ? [{ type: 'env', name: 'FIXTURE_KEY' }] : [])];
  return { call(name, input) {
    if (name === 'connection.list') return { selected: 'provider-removal-fixture', runtimeScope: { hostID: 'provider-removal-fixture', lease: 'synthetic-provider-removal-lease' }, connections: [{ id: 'provider-removal-fixture', label: 'Synthetic Provider Host', url: 'https://providers.example.invalid', lastUsedAt: 0 }] };
    if (name !== 'runtime.request') throw new Error('Unexpected provider-removal native call');
    const route = fixtureRequest(input), { path, method, params } = route;
    if (input.path.endsWith('?') || input.body !== undefined) throw new Error('Unexpected provider-removal fixture query/body');
    const ok = body => ({ status: 200, body });
    function scoped(expectedMethod, key, allowed = [], required = []) {
      route.expect(expectedMethod, [key, ...allowed], required);
      if (directory === undefined || (params.has(key) ? params.get(key) : null) !== directory) throw new Error('Provider-removal fixture lost directory scope');
    }
    if (path === '/api/config/catalog/providers') {
      route.expect('GET', ['directory']);
      const selected = params.has('directory') ? params.get('directory') : null;
      if ((selected !== null && selected !== '/fixture/project') || (directory !== undefined && directory !== selected)) throw new Error('Unexpected provider-removal fixture directory');
      directory = selected;
      return ok({ schemaVersion: 1, providers: rows.filter(present).map(row => ({ id: row.id, name: `Fixture ${row.id}`, integrationID: `integration-${row.id}`, models: { model: { name: 'Fixture model' } } })).concat(lastDeleted ? [{ id: 'read-back', name: `Verified removal: ${lastDeleted}`, models: {} }] : []) });
    }
    if (path === '/api/config/settings') { route.expect('GET'); return ok({ hiddenModels: [] }); }
    if (['/api/provider', '/api/integration'].includes(path)) {
      scoped('GET', 'location[directory]');
      const refresh = rows.find(row => row.id === 'refresh');
      if (path === '/api/provider' && refresh.configAttempts && !present(refresh) && !refresh.refreshFailed) { refresh.refreshFailed = true; return { status: 502, body: { error: 'Fixture verification failure' } }; }
      if (path === '/api/provider') return ok({ data: rows.filter(present).map(row => ({ id: row.id, integrationID: `integration-${row.id}` })) });
      return ok({ data: rows.map(row => ({ id: `integration-${row.id}`, connections: connections(row), methods: [] })) });
    }
    const integration = /^\/api\/integration\/([^/]+)$/.exec(path);
    if (integration) {
      scoped('GET', 'location[directory]');
      const row = rows.find(item => encodeURIComponent(`integration-${item.id}`) === integration[1]);
      if (!row) throw new Error('Unknown fixture integration');
      return ok({ data: { id: `integration-${row.id}`, methods: [], connections: connections(row) } });
    }
    if (path === '/api/config/providers/sources') {
      scoped('GET', 'directory');
      return ok(Object.fromEntries(rows.filter(present).map(row => [row.id, { files: row.files.map(path => ({ path, scope: 'user' })), origin: row.files.length ? 'config' : 'runtime' }])));
    }
    const provider = /^\/api\/provider\/([^/]+)\/auth$/.exec(path);
    if (provider) {
      scoped('DELETE', 'directory', ['scope'], ['scope']);
      if (params.get('scope') !== 'config') throw new Error('Unsafe provider config scope');
      const row = rows.find(item => encodeURIComponent(item.id) === provider[1]), id = row?.id;
      if (!row || ['environment', 'runtime'].includes(id)) throw new Error('Attempted forbidden source deletion');
      row.configAttempts++;
      if (row.configAttempts > (id === 'partial-config' ? 2 : 1)) throw new Error('Repeated ACKed config deletion');
      if (id === 'partial-config' && !row.configFailed) { row.files.shift(); row.configFailed = true; return { status: 409, body: { error: 'Fixture partial config failure' } }; }
      row.files = []; return ok({ success: true, removed: true, requiresReload: false });
    }
    const credential = /^\/api\/credential\/([^/]+)$/.exec(path);
    if (credential) {
      route.expect('DELETE');
      const row = rows.find(item => item.credentials.some(id => encodeURIComponent(id) === credential[1]));
      if (!row) throw new Error('Repeated ACKed credential deletion');
      if (directory === undefined || row.files.length || ['environment', 'runtime'].includes(row.id)) throw new Error('Unsafe fixture credential deletion');
      const id = row.credentials.find(value => encodeURIComponent(value) === credential[1]);
      row.credentialAttempts[id] = (row.credentialAttempts[id] || 0) + 1;
      if (row.id === 'partial-credential' && id.endsWith('/b') && !row.credentialFailed) { row.credentialFailed = true; return { status: 409, body: { error: 'Fixture partial credential failure' } }; }
      row.credentials = row.credentials.filter(item => item !== id);
      if (!present(row)) lastDeleted = row.id;
      return { status: 204, body: null };
    }
    throw new Error(`Unexpected provider-removal fixture request: ${method} ${path}`);
  } };
}
