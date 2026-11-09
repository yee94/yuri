import { createNavigationHost, navigationIdentity as identity } from '../desktop-application/NavigationHost.js';
export { newDraftNavigation, newDraftKey, draftRecord } from '../desktop-commands-application/Host.js';

export function createStartersHost() {
  const fixture = createNavigationHost(), read = fixture.handlers['runtime.request'];
  const writes = [];
  let starters = [{ type: 'command', name: 'explore' }, { type: 'command', name: 'weigh' }];
  fixture.handlers['runtime.request'] = input => {
    if (input.path === '/api/config/settings') {
      if (input.method === 'GET') { const result = read(input); return { ...result, body: { ...result.body, draftStarters: starters } }; }
      if (input.method === 'PUT' && input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease
        && Object.keys(input.body ?? {}).join(',') === 'draftStarters' && Array.isArray(input.body.draftStarters)
        && input.body.draftStarters.every(row => Object.keys(row).sort().join(',') === 'name,type' && row.type === 'command' && ['explore', 'weigh'].includes(row.name))
        && new Set(input.body.draftStarters.map(row => row.name)).size === input.body.draftStarters.length) {
        writes.push(input); starters = input.body.draftStarters.map(row => ({ ...row })); return { status: 200, body: { success: true } };
      }
    }
    return read(input);
  };
  return { ...fixture, writes, starters: () => starters };
}
