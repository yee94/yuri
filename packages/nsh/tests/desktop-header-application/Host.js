import { createNavigationHost, navigationIdentity as identity } from '../desktop-application/NavigationHost.js';
export { navigationRecord, draftKey, draftRecord } from '../desktop-commands-application/Host.js';

export function createHeaderHost(options = {}) {
  const base = createNavigationHost(), read = base.handlers['runtime.request'];
  const metadata = [], lightStatus = [], quotas = [], servicesReads = [], servicesWrites = [], githubReads = [], githubWrites = [], aboutReads = [];
  let aboutFailure = false;
  const closeDecision = base.handlers['desktop.window.closeDecision'];
  let closeDecisions = 0;
  base.handlers['desktop.window.closeDecision'] = value => { closeDecisions++; closeDecision(value); return !options.rejectFirstClose || closeDecisions !== 1; };
  base.handlers['native.clientMetadata'] = () => ({ schemaVersion: 1, version: '2.3.0', build: '1', updates: { status: 'unsupported' } });
  base.handlers['native.diagnostics.status'] = () => ({ schemaVersion: 2, mode: 'event-recorder', enabled: false, recordingLease: null });
  let githubSelected = 'a', githubFailure = false, githubUnknown = false;
  const githubStatus = () => ({ connected: true, user: { login: githubSelected }, accounts: ['a', 'b'].map(id => ({ id, source: 'oauth', current: id === githubSelected, user: { login: id, name: 'Synthetic ' + id } })), capabilities: { exactAccountRemoval: false, deviceFlowCancellation: true } });
  let offline = false, mcpFailure = false, mcpUnknown = false, mcpConnected = false;
  base.handlers['runtime.request'] = input => {
    const url = new URL(input.path, identity.origin);
    if (['/api/system/info', '/api/system/update', '/api/opencode/upgrade-status'].includes(input.path)) {
      if (input.method !== 'GET' || input.body !== undefined || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Wrong About read authority');
      aboutReads.push(input);
      if (aboutFailure) return { status: 503, body: {} };
    }
    if (options.github && (url.pathname === '/api/github/auth/status' || url.pathname === '/api/github/auth/activate')) {
      if (url.searchParams.size || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Wrong shared GitHub authority');
      if (url.pathname.endsWith('/status') && input.method === 'GET' && input.body === undefined) {
        githubReads.push(input); return githubFailure ? { status: 503, body: {} } : { status: 200, body: githubStatus() };
      }
      if (url.pathname.endsWith('/activate') && input.method === 'POST' && Object.keys(input.body ?? {}).join(',') === 'accountId' && ['a', 'b'].includes(input.body.accountId)) {
        githubWrites.push(input); githubSelected = input.body.accountId;
        if (githubUnknown) throw new Error('Synthetic shared GitHub ACK lost');
        return { status: 200, body: githubStatus() };
      }
      throw new Error('Wrong shared GitHub request');
    }
    if (options.github && ['/api/git/identities', '/api/git/global-identity', '/api/git/discover-credentials'].includes(input.path)) {
      if (input.method !== 'GET' || input.body !== undefined || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Wrong Git Settings authority');
      return { status: 200, body: input.path.endsWith('/global-identity') ? {} : [] };
    }
    const isMetadata = input.path === '/api/session/' + identity.sessionID + '/message?directory=' + encodeURIComponent(identity.directory) + '&limit=20&order=desc';
    const isQuota = url.pathname.startsWith('/api/quota/');
    const configPath = '/api/config/mcp?directory=' + encodeURIComponent(identity.directory);
    const statusPath = '/api/mcp?location%5Bdirectory%5D=' + encodeURIComponent(identity.directory);
    const mutation = /^\/api\/experimental\/mcp\/Alpha\/(connect|disconnect)\?location%5Bdirectory%5D=/.exec(input.path);
    if (input.path === configPath || input.path === statusPath || mutation) {
      if (input.body !== undefined || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Wrong services authority');
      if (mutation) {
        if (input.method !== 'POST' || input.path !== '/api/experimental/mcp/Alpha/' + mutation[1] + '?location%5Bdirectory%5D=' + encodeURIComponent(identity.directory)) throw new Error('Wrong services mutation');
        servicesWrites.push(input); mcpConnected = mutation[1] === 'connect';
        if (mcpUnknown) throw new Error('Synthetic MCP response lost');
        return { status: 204, body: null };
      }
      if (input.method !== 'GET') throw new Error('Wrong services read method');
      servicesReads.push(input);
      if (input.path === configPath) return { status: 200, body: [{ name: 'Alpha' }, { name: 'Beta' }] };
      if (mcpFailure) return { status: 503, body: { error: 'Synthetic MCP offline' } };
      return { status: 200, body: { data: [{ name: 'Alpha', status: { status: mcpConnected ? 'connected' : 'disabled' } }, { name: 'Beta', status: { status: 'needs_auth' } }] } };
    }
    if (input.method === 'GET' && input.path === '/api/git/remotes?directory=' + encodeURIComponent(identity.directory)
      && input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease) return { status: 200, body: [] };
    if (input.method === 'GET' && url.pathname === '/api/git/status' && url.searchParams.get('mode') === 'light') lightStatus.push(input);
    if (isMetadata || isQuota) {
      if (input.method !== 'GET' || input.body !== undefined || input.expectedHost?.hostID !== identity.hostID || input.expectedHost?.lease !== identity.lease) throw new Error('Wrong header read authority');
    }
    if (isMetadata) {
      metadata.push(input);
      return { status: 200, body: { data: [
        { id: 'measured-assistant', type: 'assistant', tokens: { input: 120, output: 30 }, content: [] },
        { id: 'measured-user', type: 'user', model: { providerID: 'fixture', id: 'model' }, content: [] },
      ] } };
    }
    if (isQuota) {
      quotas.push(input);
      if (url.pathname === '/api/quota/providers' && url.searchParams.size === 0) return { status: 200, body: { providers: options.families ? ['google'] : [] } };
      if (options.families && url.pathname === '/api/quota/google' && url.searchParams.size === 0) {
        const weekly = { usedPercent: 25, remainingPercent: 75, windowSeconds: 604800, resetAt: Date.now() + 604800000 * .75 };
        return { status: 200, body: { providerId: 'google', providerName: 'Synthetic Google', configured: true, ok: true, usage: {
          windows: { weekly }, models: { 'gemini/root-family': { windows: { weekly: { ...weekly, usedPercent: 33 } } }, 'antigravity/root-family': { windows: { weekly: { ...weekly, usedPercent: 51 } } }, other: { windows: { weekly: { usedPercent: 20 } } } },
        } } };
      }
      if (url.pathname === '/api/quota/magpie' && url.searchParams.get('directory') === identity.directory && url.searchParams.get('refresh') === '1' && url.searchParams.size === 2) {
        if (offline) return { status: 503, body: { error: 'Synthetic header quota offline' } };
        return { status: 200, body: { sources: [{ id: 'header', name: 'Header source', results: [{
          providerId: 'magpie:header:cursor', providerName: 'Header quota account', source: 'magpie', sourceId: 'header', upstreamProviderId: 'cursor',
          configured: true, ok: true, usage: { windows: { weekly: { usedPercent: 25, remainingPercent: 75 } } },
        }] }] } };
      }
      throw new Error('Unexpected header quota route');
    }
    const response = read(input);
    if (options.families && input.path === '/api/config/settings') return { ...response, body: { ...response.body,
      usageDropdownProviders: ['google'], usageShowPredValues: true, usageSelectedModels: { google: ['gemini/root-family', 'antigravity/root-family', 'other'] } } };
    if (url.pathname === '/api/config/catalog/providers') return { ...response, body: { ...response.body,
      providers: response.body.providers.map(provider => ({ ...provider, models: { model: { ...provider.models.model, limit: { context: 1000 } } } })) } };
    return response;
  };
  return { ...base, metadata, lightStatus, quotas, servicesReads, servicesWrites, githubReads, githubWrites, aboutReads,
    aboutFailure(value) { aboutFailure = value; },
    githubFailure(value) { githubFailure = value; }, githubUnknown(value) { githubUnknown = value; }, offline(value) { offline = value; },
    mcpFailure(value) { mcpFailure = value; }, mcpUnknown(value) { mcpUnknown = value; } };
}
