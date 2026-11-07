import { fixtureRequest } from '../new-session-request.js';

/** In-memory only, strict read-only production App Host. Never contacts an actual Host. */
export function createHost(player) {
  const directory = '/fixture/actual', sessionID = 'context-actual';
  const session = { id: sessionID, title: 'Actual context conversation', location: { directory }, time: { created: 1000, updated: 3000 }, model: { providerID: 'actual', id: 'model' }, agent: 'build' };
  const decoy = { id: 'context-decoy', title: 'Do not use first session', location: { directory: '/fixture/decoy' }, time: { updated: 4000 } };
  const user = { id: 'context-user', sessionID, type: 'user', text: 'Synthetic question', time: { created: 1000 } };
  // Only output is measured; absent input/cache/cost/clock must not become zero.
  const assistant = { id: 'context-assistant', sessionID, parentID: user.id, type: 'assistant', model: { providerID: 'actual', id: 'model' }, tokens: { output: 7 }, content: [{ type: 'text', text: 'Synthetic answer' }], futureWireField: { retained: true } };
  const calls = [], requests = [], rejected = [], notificationConfigurations = [];
  const connections = [{ id: 'context-production', label: 'Synthetic context Host', url: 'https://host.example', lastUsedAt: 1 }, { id: 'context-other', label: 'Other synthetic Host', url: 'https://other.example', lastUsedAt: 0 }];
  let selected = 'context-production', leaseRevision = 1;
  const scope = () => ({ hostID: selected, lease: '00000000-0000-4000-8000-' + String(leaseRevision).padStart(12, '0') });
  const snapshot = () => ({ selected, connections: clone(connections), runtimeScope: scope() });
  let auditSequence = 0, revision = 0, appearanceApplies = 0, diagnosticsStatusReads = 0, deltas = 0, historyReads = 0, metadataReads = 0, catalogReads = 0, goalReads = 0, mutations = 0, failHistory = false;
  const clone = value => JSON.parse(JSON.stringify(value));
  const ok = body => ({ status: 200, body: clone(body) });
  const empty = input => { if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length) throw new Error('Unexpected context control arguments'); };
  const admittedStreams = [], admittedStops = [];
  function admit(expected) {
    if (!expected || typeof expected !== 'object' || Array.isArray(expected) || Object.keys(expected).sort().join(',') !== 'hostID,lease'
      || typeof expected.hostID !== 'string' || !expected.hostID || expected.hostID.length > 256 || /[\u0000-\u001f\u007f-\u009f]/.test(expected.hostID)
      || typeof expected.lease !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(expected.lease)) throw new Error('runtime_host_scope_invalid');
    const current = scope();
    if (expected.hostID !== current.hostID || expected.lease.toLowerCase() !== current.lease) throw new Error('runtime_host_scope_stale');
  }
  function emit(type, data) {
    if (typeof player?.hostEvent !== 'function') throw new Error('Context fixture requires the real hostEvent boundary');
    player.hostEvent('runtime.event', { key: 'chat', data: JSON.stringify({ type, data: { sessionID, ...data }, location: { directory } }) });
  }
  return { call(name, input) {
    calls.push({ name, input: clone(input ?? {}) });
    try {
      if (name === 'connection.list') { if (input !== undefined) empty(input); return snapshot(); }
      // Pure forwarding tests may rotate this synthetic selection. The engine
      // fixture never grants connection.select and cannot use it to inject navigation.
      if (name === 'connection.select') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'id' || !connections.some(connection => connection.id === input.id)) throw new Error('Invalid context connection selection');
        selected = input.id; leaseRevision++; return snapshot();
      }
      if (name === 'appearance.reset') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'hostID' || input.hostID !== null && input.hostID !== 'context-production') throw new Error('Invalid context appearance reset');
        return { revision: ++revision };
      }
      if (name === 'appearance.apply') {
        const keys = (value, expected) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...expected].sort().join(',');
        const tokens = ['background', 'foreground', 'card', 'card-foreground', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'muted', 'muted-foreground', 'accent', 'accent-foreground', 'border', 'input', 'ring', 'destructive', 'success', 'chat-user', 'chat-user-foreground', 'chat-assistant', 'chat-assistant-foreground'];
        if (!keys(input, ['hostID', 'revision', 'mode', 'cssVars', 'fonts']) || input.hostID !== 'context-production'
          || !Number.isSafeInteger(input.revision) || input.revision !== revision || revision < 1 || !['light', 'dark', 'system'].includes(input.mode)
          || !keys(input.cssVars, ['light', 'dark']) || !['light', 'dark'].every(mode => keys(input.cssVars[mode], tokens) && Object.values(input.cssVars[mode]).every(color => typeof color === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(color)))
          || !keys(input.fonts, ['ui', 'mono', 'assistantLight', 'assistantDark']) || !Object.values(input.fonts).every(font => typeof font === 'string' && /^[a-zA-Z0-9 -]{1,64}$/.test(font))
          || JSON.stringify(input).length > 16384) throw new Error('Invalid context appearance apply');
        const unsupported = new Set();
        // Synthetic inventory contains only the two semantic built-ins; no UIFont/OS lookup.
        const family = (font, fallback) => { if (font === 'system-ui' || font === 'monospace') return font; unsupported.add(font); return fallback; };
        const uiFontFamily = family(input.fonts.ui, 'system-ui'), monoFontFamily = family(input.fonts.mono, 'monospace');
        const assistantFontFamilies = { light: family(input.fonts.assistantLight, uiFontFamily), dark: family(input.fonts.assistantDark, uiFontFamily) };
        appearanceApplies++;
        return { uiFontFamily, monoFontFamily, assistantFontFamilies, unsupportedFonts: [...unsupported].sort(), systemColorScheme: 'light' };
      }
      if (name === 'native.diagnostics.status') {
        if (input !== undefined) empty(input);
        diagnosticsStatusReads++;
        return { schemaVersion: 2, mode: 'event-recorder', enabled: false, recordingLease: null, eventCount: 0, maxEntries: 500, maxBytes: 262144 };
      }
      if (name === 'notification.configure') {
        const events = ['completion', 'error', 'question', 'permission', 'schedule', 'assistant', 'goal'];
        if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'enabled,events,hostID,language,mode'
          || input.hostID !== 'context-production' || input.enabled !== false || input.mode !== 'hidden-only' || input.language !== 'en'
          || !Array.isArray(input.events) || input.events.length !== events.length || new Set(input.events).size !== events.length || !input.events.every(event => events.includes(event))) throw new Error('Invalid context notification configuration');
        notificationConfigurations.push(clone(input));
        return { lease: 'context-production-notification-lease' };
      }
      if (name === 'speech.prepare') return { visible: true, provider: 'browser', mode: 'sanitized' };
      if (name === 'speech.stop' || name === 'speech.release') return null;
      if (name === 'runtime.stream') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || !['global', 'chat'].includes(input.key) || input.path !== (input.key === 'global' ? '/api/yuri/events' : '/api/event?directory=%2Ffixture%2Factual') || Object.keys(input).some(key => !['path', 'key', 'expectedHost'].includes(key))) throw new Error('Unexpected context stream');
        if (!Object.prototype.hasOwnProperty.call(input, 'expectedHost')) throw new Error('runtime_host_scope_required');
        admit(input.expectedHost);
        admittedStreams.push({ name, input: clone(input) });
        return true;
      }
      if (name === 'runtime.stop') {
        if (!input || typeof input !== 'object' || Array.isArray(input) || !['global', 'chat'].includes(input.key) || Object.keys(input).some(key => !['key', 'expectedHost'].includes(key))) throw new Error('Unexpected context stream stop');
        if (!Object.prototype.hasOwnProperty.call(input, 'expectedHost')) throw new Error('runtime_host_scope_required');
        admit(input.expectedHost);
        admittedStops.push({ name, input: clone(input) });
        return true;
      }
      if (name === 'context.production.audit') {
        empty(input);
        return clone({ auditSequence: ++auditSequence, historyReads, metadataReads, catalogReads, goalReads, mutations, deltas, requests, rejected, notificationConfigurations, appearanceApplies, diagnosticsStatusReads, streams: calls.filter(call => call.name === 'runtime.stream'), stops: calls.filter(call => call.name === 'runtime.stop'), admittedStreams, admittedStops });
      }
      if (name === 'context.production.delta') {
        empty(input); const delta = ' synthetic-token-' + (++deltas);
        assistant.content[0].text += delta;
        emit('session.text.delta', { assistantMessageID: assistant.id, parentID: user.id, ordinal: 0, delta });
        return true;
      }
      if (name === 'context.production.failHistory') {
        empty(input); failHistory = true;
        emit('session.execution.succeeded', {});
        return true;
      }
      if (name !== 'runtime.request') throw new Error('Unexpected context production native call: ' + name);
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['path', 'method', 'body', 'expectedHost'].includes(key)) || typeof input.path !== 'string'
        || input.method !== undefined && !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(input.method)) throw new Error('Invalid context request keys/method');
      const verb = input.method ?? 'GET', hasScope = Object.prototype.hasOwnProperty.call(input, 'expectedHost');
      if (hasScope) {
        admit(input.expectedHost);
      } else if (verb !== 'GET') throw new Error('runtime_host_scope_required');
      if (input.path.endsWith('?') || input.path.indexOf('?') !== input.path.lastIndexOf('?')) throw new Error('Invalid context query');
      const route = fixtureRequest(input), { path, method, params } = route;
      requests.push({ path: input.path, method, ...(hasScope ? { expectedHost: clone(input.expectedHost) } : {}) });
      const goal = path === '/api/rpc/opencode.goal/get' && method === 'POST';
      if (method !== 'GET' && !goal) { mutations++; throw new Error('Context production fixture forbids mutation'); }
      if (!goal && input.body !== undefined) throw new Error('Unexpected context read body');
      for (const key of ['directory', 'location[directory]', 'projectDirectory']) {
        if (params.has(key) && params.get(key) !== directory) throw new Error('Wrong captured context directory');
      }
      if (goal) {
        route.expect('POST', ['location[directory]'], ['location[directory]']);
        if (JSON.stringify(input.body) !== JSON.stringify({ input: { sessionID } })) throw new Error('Invalid context Goal read');
        goalReads++; return ok({ output: { id: 'context-goal', objective: 'Read-only synthetic Goal', status: 'active', rounds: 1, maxRounds: 5, boot: 'fixture', updatedAt: 1 } });
      }
      if (path === '/api/yuri/history-import/jobs') {
        route.expect('GET');
        if (!hasScope) throw new Error('runtime_host_scope_required');
        if (Object.prototype.hasOwnProperty.call(input, 'body')) throw new Error('Unexpected context history import read body');
        return ok([]);
      }
      if (path === '/api/config/settings') { route.expect('GET'); return ok({ projects: [{ id: 'actual-project', name: 'Actual context project', path: directory }], showAssistantTps: true, sessionGoalEnabled: true }); }
      if (path === '/api/config/themes') { route.expect('GET'); return ok([]); }
      if (path === '/api/yuri/session-index') { route.expect('GET'); return ok({ available: true, directories: [{ directory: decoy.location.directory, sessions: [decoy] }, { directory, sessions: [session] }] }); }
      if (path === '/api/yuri/assistants/snapshot') { route.expect('GET'); return ok({ assistants: [] }); }
      if (path === '/api/yuri/scheduled-tasks') { route.expect('GET'); return ok({ tasks: [], failedProjectIds: [] }); }
      if (path === '/api/session/active') { route.expect('GET'); return ok({ data: { [sessionID]: { type: 'running' } } }); }
      if (path === '/api/session-folders/order') { route.expect('GET'); return ok({ revision: 0, sessionOrderByScope: {}, sessionOrderActivityByScope: {} }); }
      if (path === '/api/yuri/message-queue/worktrees/order') { route.expect('GET', ['projectDirectory'], ['projectDirectory']); return ok({ projectDirectory: directory, revision: 0, orderedPaths: [] }); }
      if (path === '/api/git/worktrees' || path === '/api/debug/location') { route.expect('GET', path.endsWith('worktrees') ? ['directory'] : [], path.endsWith('worktrees') ? ['directory'] : []); return ok([]); }
      if (path === '/api/git/check') { route.expect('GET', ['directory'], ['directory']); return ok({ isGitRepository: false }); }
      if (path === '/api/git/status') { route.expect('GET', ['directory', 'mode'], ['directory']); if (params.has('mode') && params.get('mode') !== 'light') throw new Error('Unexpected context Git mode'); return ok({ isGitRepository: false, isClean: true, files: [] }); }
      if (path === '/api/config/catalog/providers') {
        route.expect('GET', ['directory'], ['directory']); catalogReads++;
        return ok({ schemaVersion: 1, providers: [{ id: 'decoy', models: { wrong: { id: 'wrong', limit: { context: 1 } } } }, { id: 'actual', name: 'Actual provider', models: { model: { id: 'model', name: 'Actual model', limit: { context: 400000 } } } }] });
      }
      if (path === '/api/agent') { route.expect('GET', ['location[directory]'], ['location[directory]']); return ok({ data: [{ name: 'build', mode: 'primary' }] }); }
      if (path === '/api/permission/request' || path === '/api/form') { route.expect('GET', ['directory'], ['directory']); return ok([]); }
      if (path === '/api/session') { route.expect('GET', ['directory', 'parentID', 'search', 'limit', 'order', 'archived'], ['parentID', 'limit', 'order']); return ok({ data: params.get('parentID') !== 'null' ? [] : [session], cursor: {} }); }
      if (path === '/api/yuri/content-search') { route.expect('GET', ['q', 'limit'], ['q', 'limit']); return ok({ hits: [] }); }
      if (path === '/api/fs/find') { route.expect('GET', ['location[directory]', 'query', 'limit', 'type'], ['location[directory]', 'query', 'limit', 'type']); return ok({ data: [] }); }
      if (path === '/api/session/' + sessionID) { route.expect('GET', ['directory'], ['directory']); metadataReads++; return ok({ data: session }); }
      if (path === '/api/session/' + sessionID + '/message') {
        route.expect('GET', ['directory', 'limit', 'order'], ['directory', 'limit', 'order']);
        if (params.get('limit') !== '20' || params.get('order') !== 'desc') throw new Error('Unexpected context history window');
        historyReads++; if (failHistory) { failHistory = false; return { status: 503, body: { error: 'Synthetic context history unavailable' } }; }
        return ok({ data: [assistant, user], complete: true });
      }
      if (['inbox', 'permission/request', 'form'].some(suffix => path === '/api/session/' + sessionID + '/' + suffix)) { route.expect('GET', ['directory'], ['directory']); return ok([]); }
      throw new Error('Unexpected context production request: ' + input.path);
    } catch (failure) {
      rejected.push({ name, path: input?.path, error: String(failure instanceof Error ? failure.message : failure) });
      throw failure;
    }
  } };
}
