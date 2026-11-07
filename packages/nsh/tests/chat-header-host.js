/** Isolated native header fixture. No credentials or production configuration. */
export function createHost() {
  let requests = 0, failAnchor = false;
  return { call(name, input) {
    if (name === 'navigation.anchor') return failAnchor ? null : { origin: { x: 350, y: 68 }, size: { width: 32, height: 32 } };
    if (name !== 'runtime.request') throw new Error('Unexpected call');
    if (input.path === '/fixture/fail-anchor') { failAnchor = true; return { status: 200, body: true }; }
    if (input.path === '/fixture/request-count') return { status: 200, body: requests };
    requests++;
    const path = input.path;
    let body;
    if (path.startsWith('/api/session/ses_header/message?')) body = { data: [
      { id: 'assistant', type: 'assistant', tokens: { input: 500, output: 100, reasoning: 50, cache: { read: 50 } } },
      { id: 'user', type: 'user', model: { id: 'model', providerID: 'fixture' } },
    ], complete: true };
    else if (path.startsWith('/api/session/ses_header?')) body = { data: { id: 'ses_header', title: 'Authoritative title', model: { id: 'model', providerID: 'fixture' } } };
    else if (path.startsWith('/api/config/catalog/providers?')) body = { schemaVersion: 1, providers: [{ id: 'fixture', models: { model: { id: 'model', limit: { context: 1000 } } } }] };
    else if (path.startsWith('/api/git/status?')) body = { current: 'feature/header' };
    else if (path === '/api/config/settings') body = {};
    else if (path === '/api/quota/providers') body = { providers: [] };
    else if (path.startsWith('/api/quota/magpie?')) body = { sources: [{ id: 'neutral', name: 'Fixture', results: [{ providerId: 'magpie:neutral:cursor', sourceId: 'neutral', source: 'magpie', upstreamProviderId: 'cursor', providerName: 'Cursor · Fixture', configured: true, ok: true, fetchedAt: 1, usage: { windows: { 'Account Alpha · Weekly': { label: 'Weekly', usedPercent: 8, remainingPercent: 92, resetAt: null }, 'Account Beta · Weekly': { label: 'Weekly', usedPercent: 16, remainingPercent: 84, resetAt: null } }, accounts: [{ name: 'Account Alpha' }, { name: 'Account Beta' }] } }] }] };
    else throw new Error('Unexpected request');
    return { status: 200, body };
  } };
}
