import { fixtureRequest } from './new-session-request.js';

/** Strict, credential-free fake native boundary. No fetch, disk, pairing or real Host exists here. */
export function createHost() {
  const primaryID = 'connection-editor-primary', directory = '/fixture/connection-editor';
  const originalURL = 'https://primary.example.invalid';
  const connections = [
    { id: primaryID, label: 'Primary synthetic connection', url: originalURL, transport: 'direct', transportID: 'synthetic-primary-transport', lastUsedAt: 100 },
    { id: 'connection-editor-secondary', label: 'Other synthetic connection', url: 'https://secondary.example.invalid', transport: 'direct', transportID: 'synthetic-secondary-transport', lastUsedAt: 50 },
  ];
  const nativeCounts = {}, requests = [], rejected = [], expectedFailures = [], reauthorizations = [], notificationConfigurations = [];
  const versions = new Map(connections.map(connection => [connection.id, 0]));
  let sequence = 0, metadataWrites = 0, appearanceRevision = 0, settingsReads = 0;
  let notificationLease = null;
  const copy = value => JSON.parse(JSON.stringify(value));
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const snapshot = () => copy({ connections, selected: primaryID });
  function keys(input, allowed, required = allowed) {
    if (!object(input) || Object.keys(input).some(key => !allowed.includes(key)) || required.some(key => !(key in input))) throw new Error('Unexpected connection-editor fixture payload');
  }
  function expected(code) { expectedFailures.push(code); throw new Error(code); }
  function getRequest(input) {
    keys(input, ['path', 'method'], ['path']);
    if (typeof input.path !== 'string' || input.path.endsWith('?') || input.path.indexOf('?') !== input.path.lastIndexOf('?')) throw new Error('Unexpected connection-editor fixture resource');
    const route = fixtureRequest(input);
    for (const key of ['directory', 'location[directory]', 'projectDirectory']) {
      if (route.params.has(key) && route.params.get(key) !== directory) throw new Error('Unexpected connection-editor fixture directory');
    }
    return route;
  }
  const ok = body => ({ status: 200, body: copy(body) });
  return { call(name, input) {
    try {
      if (name === 'connectionEditor.fixture.audit') {
        keys(input, []);
        return copy({ sequence: ++sequence, nativeCounts, requests, rejected, expectedFailures, metadataWrites, selected: primaryID, connections,
          settingsReads, reauthorizations, notification: { configurations: notificationConfigurations, lease: notificationLease, osAuthorization: 'unknown', scheduled: 0 } });
      }
      nativeCounts[name] = (nativeCounts[name] || 0) + 1;
      if (name === 'connection.list') { keys(input, []); return snapshot(); }
      if (name === 'connection.editor') {
        keys(input, ['id']);
        const connection = connections.find(connection => connection.id === input.id);
        if (!connection) throw new Error('Unexpected connection-editor fixture identity');
        return { ...copy(connection), version: 'synthetic-version-' + versions.get(input.id) };
      }
      if (name === 'connection.rename' || name === 'connection.edit') {
        keys(input, name === 'connection.rename' ? ['id', 'version', 'label'] : ['id', 'version', 'label', 'url']);
        const index = connections.findIndex(connection => connection.id === input.id);
        if (index < 0 || typeof input.label !== 'string' || !input.label) throw new Error('Unexpected connection-editor fixture mutation');
        if (input.version !== 'synthetic-version-' + versions.get(input.id)) return expected('connection_editor_stale');
        // This fixture is a boundary mock, NOT a copy of Swift's origin/auth algorithm.
        // Only its fixed synthetic candidate can be edited; native security is covered by the Swift harness.
        if (name === 'connection.edit' && input.url !== connections[index].url) return expected('connection_editor_pairing_required');
        connections[index] = { ...connections[index], label: input.label };
        versions.set(input.id, versions.get(input.id) + 1); metadataWrites++;
        return snapshot();
      }
      if (name === 'connection.connect') {
        // Exact current Connect form wire. This scripted response does not redeem,
        // authenticate, store credentials or implement Swift's authorization algorithm.
        keys(input, ['id', 'version', 'pairingLink', 'url', 'password', 'token', 'label']);
        if (input.id !== 'connection-editor-secondary' || input.pairingLink !== 'synthetic-reauthorize-secondary' ||
            input.url !== 'https://replacement.example.invalid' || input.label !== 'Reauthorized secondary' || input.password !== '' || input.token !== '') throw new Error('Unexpected connection-editor fixture reauthorization');
        if (input.version !== 'synthetic-version-' + versions.get(input.id)) return expected('connection_editor_stale');
        const index = connections.findIndex(connection => connection.id === input.id);
        connections[index] = { ...connections[index], label: input.label, url: input.url, transportID: 'synthetic-replacement-transport' };
        versions.set(input.id, versions.get(input.id) + 1);
        reauthorizations.push({ id: input.id, version: input.version, label: input.label, url: input.url });
        // Intentionally absent runtimeInvalidated: exercise !== true and pop(2)
        // for a non-selected saved record without retiring the primary authority.
        return snapshot();
      }
      if (name === 'notification.configure') {
        keys(input, ['hostID', 'enabled', 'mode', 'events', 'language']);
        const events = ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'];
        if (!settingsReads || input.hostID !== primaryID || input.enabled !== false || input.mode !== 'hidden-only' || input.language !== 'en' ||
            !Array.isArray(input.events) || JSON.stringify(input.events) !== JSON.stringify(events)) throw new Error('Unexpected connection-editor fixture notification configuration');
        notificationConfigurations.push(copy(input));
        notificationLease ??= 'connection-editor-memory-notification-lease';
        // A lease is NOT an OS authorization/scheduling result. All five other
        // notification capabilities remain unknown and fail closed in this fixture.
        return { lease: notificationLease };
      }
      if (name === 'runtime.stream') {
        keys(input, ['path', 'key', 'expectedHost', 'ownerID', 'mode'], ['path', 'key']);
        if (!(input.key === 'global' && input.path === '/api/yuri/events') && !(input.key === 'chat' && input.path === '/api/event?directory=%2Ffixture%2Fconnection-editor')) throw new Error('Unexpected connection-editor fixture stream');
        return true;
      }
      if (name === 'runtime.stop') {
        keys(input, ['key', 'expectedHost', 'ownerID'], []);
        if ('key' in input && !['global', 'chat'].includes(input.key)) throw new Error('Unexpected connection-editor fixture stop');
        return true;
      }
      if (name === 'appearance.reset') {
        keys(input, ['hostID']);
        if (input.hostID !== null && input.hostID !== primaryID) throw new Error('Unexpected connection-editor appearance scope');
        return { revision: ++appearanceRevision };
      }
      if (name === 'appearance.apply') {
        keys(input, ['hostID', 'revision', 'mode', 'cssVars', 'fonts']);
        if (input.hostID !== primaryID || input.revision !== appearanceRevision || !['system', 'light', 'dark'].includes(input.mode) || !object(input.cssVars) || !object(input.fonts)) throw new Error('Unexpected connection-editor appearance apply');
        keys(input.cssVars, ['light', 'dark']); keys(input.fonts, ['ui', 'mono', 'assistantLight', 'assistantDark']);
        if (!object(input.cssVars.light) || !object(input.cssVars.dark) || Object.values(input.fonts).some(value => typeof value !== 'string' || !value)) throw new Error('Unexpected connection-editor appearance values');
        return { uiFontFamily: 'system-ui', monoFontFamily: 'monospace', assistantFontFamilies: { light: 'system-ui', dark: 'system-ui' }, unsupportedFonts: [], systemColorScheme: 'light' };
      }
      if (name !== 'runtime.request') throw new Error('Unexpected connection-editor fixture native call');
      const route = getRequest(input), { path, params } = route;
      requests.push({ path: input.path, method: input.method ?? 'GET' });
      if (path === '/api/config/settings') { route.expect('GET'); settingsReads++; return ok({ projects: [] }); }
      if (path === '/api/config/themes') { route.expect('GET'); return ok({ themes: [] }); }
      if (path === '/api/debug/location') { route.expect('GET'); return ok([]); }
      if (path === '/api/yuri/session-index') { route.expect('GET'); return ok({ available: true, directories: [] }); }
      if (path === '/api/yuri/assistants/snapshot') { route.expect('GET'); return ok({ assistants: [] }); }
      if (path === '/api/yuri/scheduled-tasks') { route.expect('GET'); return ok({ tasks: [], failedProjectIds: [] }); }
      if (path === '/api/session/active') { route.expect('GET'); return ok([]); }
      if (path === '/api/session/connection-editor-authority') {
        route.expect('GET', ['directory'], ['directory']);
        return ok({ id: 'connection-editor-authority', location: { directory } });
      }
      if (path === '/api/session/connection-editor-authority/message') {
        route.expect('GET', ['directory', 'limit', 'order'], ['directory', 'limit', 'order']);
        if (params.get('limit') !== '20' || params.get('order') !== 'desc') throw new Error('Unexpected connection-editor authority page');
        return ok({ data: [{ id: 'connection-editor-authoritative-message', type: 'assistant', text: 'Existing authoritative synthetic reply' }], cursor: {} });
      }
      if (path === '/api/session/connection-editor-authority/inbox' || path === '/api/session/connection-editor-authority/form' || path === '/api/permission/request') {
        route.expect('GET', ['directory'], ['directory']); return ok({ data: [] });
      }
      throw new Error('Unexpected connection-editor fixture request');
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      if (!['connection_editor_stale', 'connection_editor_pairing_required'].includes(code)) rejected.push({ name, path: typeof input?.path === 'string' ? input.path : null, method: typeof input?.method === 'string' ? input.method : null });
      throw error;
    }
  } };
}
