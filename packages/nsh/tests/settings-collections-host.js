/** Explicit --web-host only. Rejects every unknown request; no real Host/credentials. */
function parseFixturePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/api/') || /[\s#]/.test(value)) throw new Error('Invalid collections fixture path');
  const parts = value.split('?');
  if (parts.length > 2) throw new Error('Invalid collections fixture query');
  const query = Object.create(null);
  if (parts.length === 2) {
    if (!parts[1]) throw new Error('Empty collections fixture query');
    for (const field of parts[1].split('&')) {
      const separator = field.indexOf('=');
      if (separator < 1) throw new Error('Invalid collections fixture query field');
      const key = decodeURIComponent(field.slice(0, separator)), entry = decodeURIComponent(field.slice(separator + 1));
      if (!['directory', 'location[directory]', 'projectID', 'specs'].includes(key) || Object.prototype.hasOwnProperty.call(query, key) || !entry) throw new Error('Unexpected collections fixture query key');
      query[key] = entry;
    }
  }
  return { pathname: parts[0], query };
}

export function createHost() {
  let deleted = false, permissionDeletes = 0, agentWrites = 0, mcpWrites = 0, reloads = 0, checks = 0, updates = 0;
  let agentDescription = 'Review fixtures';
  let pluginUpdated = false;
  const directoryQuery = '?directory=%2Ffixture%2Fproject';
  const locationQuery = '?location%5Bdirectory%5D=%2Ffixture%2Fproject';
  const ok = body => ({ status: 200, body });
  const inventory = () => ({ data: [{ source: { type: 'package', target: 'example-plugin@latest', version: pluginUpdated ? '2.0.0' : '1.0.0', outdated: !pluginUpdated, updating: false }, state: pluginUpdated ? { status: 'active' } : { status: 'failed', error: 'Fixture load failure\nSecond detail\nThird detail', ref: 'fixture-reference' } }] });
  return { call(name, input) {
    if (name === 'collections.fixture.audit') return { permissionDeletes, agentWrites, mcpWrites, reloads, checks, updates };
    if (name !== 'runtime.request') throw new Error('Unexpected collections fixture call');
    const { path, method, body } = input;
    parseFixturePath(path);
    if (path === '/api/agent' + locationQuery && method === 'GET') return ok({ data: [{ name: 'review', description: agentDescription, model: { providerID: 'example', modelID: 'model', variant: 'deep' }, mode: 'primary', permissions: [{ action: 'shell', resource: '*', effect: 'ask' }] }] });
    if (path === '/api/config/agents/metadata' + directoryQuery && method === 'POST') return ok({ agents: { review: { scope: 'project' } } });
    if (path === '/api/config/agents/review/config' + directoryQuery && method === 'GET') return ok({ config: { prompt: 'Stored fixture prompt' } });
    if (path === '/api/config/agents/review' + directoryQuery && method === 'PATCH') {
      const keys = Object.keys(body.native);
      if (keys.length !== 1 || keys[0] !== 'description' || body.scope !== 'project' || !body.native.description.includes('Edited fixture')) throw new Error('Agent patch rewrote untouched fields');
      agentWrites++; agentDescription = body.native.description;
      return ok({ ok: true });
    }
    if (path === '/api/location' + locationQuery && method === 'GET') return ok({ project: { id: 'fixture-project' } });
    if (path === '/api/permission/saved?projectID=fixture-project' && method === 'GET') return ok({ data: deleted ? [] : [{ id: 'saved-fixture', projectID: 'fixture-project', action: 'shell', resource: 'npm fixture' }] });
    if (path === '/api/permission/saved/saved-fixture' && method === 'DELETE') {
      permissionDeletes++;
      if (permissionDeletes === 1) return { status: 409, body: { error: 'Fixture revoke rejected' } };
      deleted = true; return { status: 204, body: null };
    }
    if (path === '/api/config/mcp/imported' + directoryQuery && method === 'POST') {
      if (body.oauth?.clientId !== 'example-client' || body.oauth?.scope !== 'read write' || body.oauth?.redirectUri !== 'https://callback.example.test' || body.type !== 'remote') throw new Error('MCP import lost reviewed options');
      mcpWrites++; return ok({ ok: true });
    }
    if (path === '/api/config/plugins' + directoryQuery && method === 'GET') return ok({ entries: [{ id: 'plugin-entry', spec: 'example-plugin@latest', scope: 'user', parsedKind: 'npm' }], files: [] });
    if (path === '/api/plugin' + locationQuery && method === 'GET') return ok(inventory());
    if (path === '/api/plugin/check' + locationQuery && method === 'POST') { checks++; return ok(inventory()); }
    if (path === '/api/location/reload' && method === 'POST' && body === undefined) { reloads++; return { status: 204, body: null }; }
    if (path === '/api/config/plugins/registry?specs=example-plugin%40latest&directory=%2Ffixture%2Fproject' && method === 'GET') return ok({ results: [{ kind: 'npm-ok', name: 'example-plugin', spec: 'example-plugin@latest', latestVersion: '2.0.0', hasUpdate: false }] });
    if (path === '/api/plugin/update' + locationQuery && method === 'POST') {
      if (JSON.stringify(body) !== JSON.stringify({ targets: ['example-plugin@latest'] })) throw new Error('Wrong package update target');
      updates++; pluginUpdated = true; return { status: 204, body: null };
    }
    throw new Error(`Unexpected collections fixture request: ${method} ${path}`);
  } };
}
