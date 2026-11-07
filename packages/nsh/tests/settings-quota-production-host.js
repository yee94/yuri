import { fixtureRequest } from './new-session-request.js';
import { quotaProductionRead } from './settings-quota-production-reads.js';

const quotaProductionIdentity = Object.freeze({ hostID: 'settings-navigation-production', secondaryID: 'quota-production-secondary', actual: '/fixture/second/.worktrees/topic' });

/** In-memory production wire only. No network, Keychain, Git, filesystem or credential discovery. */
export function createHost() {
  const { hostID, secondaryID, actual } = quotaProductionIdentity;
  const connections = [
    { id: hostID, label: 'Primary synthetic quota Host', url: 'https://primary.example.invalid', lastUsedAt: 2 },
    { id: secondaryID, label: 'Secondary synthetic quota Host', url: 'https://secondary.example.invalid', lastUsedAt: 1 },
  ];
  const providerIDs = ['opencode', 'ollama', 'cursor'];
  const quotaIDs = ['opencode-go', 'ollama-cloud', 'cursor'];
  const providers = providerIDs.map((id, index) => ({ id, name: ['OpenCode', 'Ollama', 'Cursor'][index], integrationID: id, models: {} }));
  providers.push({ id: 'fixture', name: 'Fixture provider', integrationID: 'fixture', models: { model: { id: 'model', name: 'Fixture model', limit: { context: 128000 } } } });
  const configured = new Map(connections.map(connection => [connection.id, new Map(quotaIDs.map(id => [id, false]))]));
  const requests = [], writes = [], rejected = [], configurations = [], nativeCounts = {};
  const actions = { validates: 0, imports: 0, deletes: 0 };
  const streams = new Map(), streamCalls = [];
  let foreground = true;
  const versions = new Map(connections.map(connection => [connection.id, 0]));
  let selected = hostID, revision = 0, mode = 'ok';
  // Synthetic UUIDs test JS forwarding only; not a copy of Native's authority/credential checks.
  let leaseRevision = 1;
  const lease = () => '00000000-0000-4000-8000-' + leaseRevision.toString(16).padStart(12, '0');
  const runtimeScope = () => foreground ? { hostID: selected, lease: lease() } : null;
  const copy = value => JSON.parse(JSON.stringify(value));
  const snapshot = () => copy({ selected, connections, runtimeScope: runtimeScope() });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  function keys(value, allowed, required = allowed) {
    if (!object(value) || Object.keys(value).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(value, key))) throw new Error('Unexpected quota production payload');
  }
  const matches = expected => foreground && expected.hostID === selected && expected.lease === lease();
  function expectedScope(input, required) {
    if (Object.hasOwn(input, 'expectedHost')) {
      keys(input.expectedHost, ['hostID', 'lease']);
      if (typeof input.expectedHost.hostID !== 'string' || !input.expectedHost.hostID.trim() || typeof input.expectedHost.lease !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(input.expectedHost.lease)) throw new Error('invalid_runtime_scope');
      if (!matches(input.expectedHost)) throw new Error('stale_runtime_scope');
    } else if (required) throw new Error('scope_required');
    if (!foreground) throw new Error('runtime_background');
  }
  const ok = body => ({ status: 200, body: copy(body) });
  const status = id => ({ configured: configured.get(selected).get(id), ...(id === 'opencode-go' ? { workspaceId: 'wrk_fixture' } : {}) });
  function scope(route, key) {
    route.expect('GET', [key]);
    if (route.params.has(key) && route.params.get(key) !== actual) throw new Error('Unexpected quota production directory');
  }
  return {
    // Test-realm lifecycle input only, never a native capability or an app-owned authority source.
    setForeground(value) {
      if (typeof value !== 'boolean') throw new Error('Unexpected quota fixture lifecycle');
      if (foreground === value) return;
      foreground = value; leaseRevision++; streams.clear();
    },
    call(name, input) {
    try {
      if (name === 'quotaProduction.fixture.audit') {
        keys(input, []);
        return copy({ selected, foreground, runtimeScope: runtimeScope(), streams: Object.fromEntries(streams), streamCalls, requests, writes, rejected, nativeCounts, configurations, actions,
          statuses: Object.fromEntries([...configured].map(([host, values]) => [host, Object.fromEntries(values)])) });
      }
      if (name === 'quotaProduction.fixture.scenario') {
        keys(input, ['mode']);
        if (!['ok', 'reject', 'read-fail', 'lost-ack'].includes(input.mode)) throw new Error('Unexpected quota production scenario');
        mode = input.mode; return true;
      }
      nativeCounts[name] = (nativeCounts[name] || 0) + 1;
      if (name === 'native.diagnostics.status') {
        keys(input, []);
        return { schemaVersion: 2, mode: 'event-recorder', enabled: false, recordingLease: null, eventCount: 0, maxEntries: 500, maxBytes: 262144 };
      }
      if (name === 'connection.list') { keys(input, []); return snapshot(); }
      if (name === 'connection.select') {
        keys(input, ['id']);
        if (!connections.some(connection => connection.id === input.id)) throw new Error('Unexpected quota production Host');
        if (!foreground) throw new Error('runtime_background');
        selected = input.id; leaseRevision++; streams.clear(); return snapshot();
      }
      if (name === 'connection.rename') {
        keys(input, ['id', 'version', 'label']);
        const connection = connections.find(connection => connection.id === input.id);
        if (!connection || input.version !== 'synthetic-quota-version-' + versions.get(input.id) || typeof input.label !== 'string' || !input.label.trim()) throw new Error('Unexpected quota production rename');
        connection.label = input.label; versions.set(input.id, versions.get(input.id) + 1);
        return snapshot();
      }
      if (name === 'appearance.reset') {
        keys(input, ['hostID']);
        if (input.hostID !== null && !connections.some(connection => connection.id === input.hostID)) throw new Error('Unexpected appearance Host');
        return { revision: ++revision };
      }
      if (name === 'appearance.apply') {
        keys(input, ['hostID', 'revision', 'mode', 'cssVars', 'fonts']);
        if (input.hostID !== selected || input.revision !== revision || !['system', 'light', 'dark'].includes(input.mode)) throw new Error('Unexpected appearance scope');
        keys(input.cssVars, ['light', 'dark']); keys(input.fonts, ['ui', 'mono', 'assistantLight', 'assistantDark']);
        if (!object(input.cssVars.light) || !object(input.cssVars.dark) || Object.values(input.fonts).some(value => typeof value !== 'string' || !value)) throw new Error('Unexpected appearance values');
        return { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [], systemColorScheme: 'light' };
      }
      if (name === 'notification.configure') {
        keys(input, ['hostID', 'enabled', 'mode', 'events', 'language']);
        if (!requests.some(row => row.hostID === selected && row.path === '/api/config/settings') || input.hostID !== selected || input.enabled !== false || input.mode !== 'hidden-only' || input.language !== 'en' || JSON.stringify(input.events) !== JSON.stringify(['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'])) throw new Error('Unexpected notification configuration');
        configurations.push(copy(input)); return { lease: 'quota-production-memory-lease-' + selected };
      }
      if (name === 'runtime.stream') {
        keys(input, ['path', 'key', 'expectedHost']); expectedScope(input, true);
        if (!(input.key === 'global' && input.path === '/api/yuri/events') && !(input.key === 'chat' && input.path === '/api/event?directory=' + encodeURIComponent(actual))) throw new Error('Unexpected quota production stream');
        streams.set(input.key, copy({ path: input.path, expectedHost: input.expectedHost }));
        streamCalls.push(copy({ name, ...input, accepted: true })); return true;
      }
      if (name === 'runtime.stop') {
        keys(input, ['key', 'expectedHost']); keys(input.expectedHost, ['hostID', 'lease']);
        if (!['global', 'chat'].includes(input.key) || typeof input.expectedHost.hostID !== 'string' || !input.expectedHost.hostID.trim() || typeof input.expectedHost.lease !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/.test(input.expectedHost.lease)) throw new Error('Unexpected quota production stop');
        const stream = streams.get(input.key);
        const released = !!stream && stream.expectedHost.hostID === input.expectedHost.hostID && stream.expectedHost.lease === input.expectedHost.lease;
        if (released) streams.delete(input.key);
        // Native cleanup is an exact stream-scope match; a stale well-formed stop is a recorded no-op.
        streamCalls.push(copy({ name, ...input, released })); return true;
      }
      if (['speech.prepare', 'speech.stop', 'speech.release'].includes(name)) {
        keys(input, name === 'speech.stop' ? ['owner', 'revision'] : ['owner']);
        if (typeof input.owner !== 'string' || !/^speech-[0-9]+-[0-9]+$/.test(input.owner) || name === 'speech.stop' && (!Number.isSafeInteger(input.revision) || input.revision < 1)) throw new Error('Unexpected quota production speech owner');
        return name === 'speech.prepare' ? { visible: false, provider: 'browser', mode: 'final' } : true;
      }
      if (name !== 'runtime.request') throw new Error('Unexpected quota production native call');
      keys(input, ['path', 'method', 'body', 'expectedHost'], ['path']);
      if (typeof input.path !== 'string' || input.path.endsWith('?') || input.path.indexOf('?') !== input.path.lastIndexOf('?')) throw new Error('Unexpected quota production resource');
      const route = fixtureRequest(input), { path, method, params } = route;
      if (typeof method !== 'string' || !/^[A-Z]+$/.test(method)) throw new Error('invalid_http_method');
      expectedScope(input, method !== 'GET');
      if (method === 'GET' && input.body !== undefined) throw new Error('Unexpected GET body');
      const row = { hostID: selected, runtimeScope: runtimeScope(), ...(input.expectedHost ? { expectedHost: copy(input.expectedHost) } : {}), path, resource: input.path, method };
      if (path === '/api/yuri/history-import/jobs') {
        keys(input, ['path', 'method', 'expectedHost']);
        expectedScope(input, true); route.expect('GET');
        requests.push(row); return ok([]);
      }
      const quota = /^\/api\/quota\/credentials\/(opencode-go|ollama-cloud|cursor)(?:\/(validate|import))?$/.exec(path);
      if (quota) {
        if (params.size || input.path.includes('?')) throw new Error('Quota credentials must be Host-global');
        const id = quota[1], action = quota[2];
        if (method === 'GET' && !action) {
          requests.push(row);
          return mode === 'read-fail' ? { status: 502, body: {} } : ok(status(id));
        }
        if (method === 'POST' && action === 'validate' || method === 'POST' && action === 'import' && id === 'cursor' || method === 'DELETE' && !action) {
          if (input.body !== undefined) throw new Error('Unexpected quota action body');
          requests.push(row);
          actions[action === 'validate' ? 'validates' : action === 'import' ? 'imports' : 'deletes']++;
          if (mode === 'reject' || action === 'validate' && !configured.get(selected).get(id)) return { status: 400, body: {} };
          if (action === 'validate') return ok({ valid: true });
          configured.get(selected).set(id, action === 'import');
          writes.push({ ...row, fields: [], accepted: true });
          if (mode === 'lost-ack') throw new Error('Synthetic lost quota ACK');
          return ok(status(id));
        }
        if (action) throw new Error('Unexpected quota action');
        if (method !== 'PUT') throw new Error('Unexpected quota action');
        const fields = id === 'opencode-go' ? ['workspaceId', 'authCookie'] : id === 'ollama-cloud' ? ['cookie'] : ['accessToken', 'refreshToken'];
        keys(input.body, fields);
        for (const field of fields) if (input.body[field] !== (field === 'workspaceId' ? 'wrk_fixture' : field === 'refreshToken' ? '' : 'fixture-only-input')) throw new Error('Only literal synthetic usage values are allowed');
        // Audit records field names only, never even synthetic authentication values.
        requests.push(row); writes.push({ ...row, fields, accepted: mode !== 'reject' });
        if (mode === 'reject') return { status: 400, body: { error: 'Synthetic rejection' } };
        configured.get(selected).set(id, true);
        if (mode === 'lost-ack') throw new Error('Synthetic lost quota ACK');
        return ok(status(id));
      }
      if (path === '/api/config/catalog/providers') { scope(route, 'directory'); requests.push(row); return ok({ schemaVersion: 1, providers }); }
      if (path === '/api/provider' || path === '/api/integration') {
        scope(route, 'location[directory]'); requests.push(row);
        return ok({ data: path === '/api/provider' ? providers : providers.map(provider => ({ id: provider.id, connections: [] })) });
      }
      if (path === '/api/config/providers/sources') { scope(route, 'directory'); requests.push(row); return ok(Object.fromEntries(providers.map(provider => [provider.id, { files: [] }]))); }
      const integration = /^\/api\/integration\/(opencode|ollama|cursor)$/.exec(path);
      if (integration) {
        scope(route, 'location[directory]'); requests.push(row);
        return ok({ data: { id: integration[1], methods: [{ id: 'key', type: 'key' }], connections: [] } });
      }
      // Pure read-only data has no nested connection router or independent lease authority.
      const reads = ['/api/config/settings', '/api/config/themes', '/api/yuri/session-index', '/api/yuri/assistants/snapshot', '/api/yuri/scheduled-tasks', '/api/session/active', '/api/debug/location', '/api/form', '/api/permission/request', '/api/session-folders/order', '/api/yuri/message-queue/worktrees/order', '/api/git/worktrees', '/api/git/status', '/api/session', '/api/yuri/content-search', '/api/fs/find', '/api/agent', '/api/session/ses_actual', '/api/session/ses_actual/message', '/api/session/ses_actual/inbox', '/api/session/ses_actual/form'];
      if (method !== 'GET' || !reads.includes(path)) throw new Error('Unexpected quota production request');
      const reply = ok(quotaProductionRead(route, actual)); requests.push(row); return reply;
    } catch (error) {
      rejected.push({ name, resource: typeof input?.path === 'string' ? input.path : null });
      throw error;
    }
  } };
}
