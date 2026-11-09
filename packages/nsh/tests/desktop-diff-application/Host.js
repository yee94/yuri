import { createHeaderHost, navigationRecord, draftKey, draftRecord } from '../desktop-header-application/Host.js';
import { navigationIdentity as identity } from '../desktop-application/NavigationHost.js';
export { navigationRecord, draftKey, draftRecord };
export const preferenceKey = 'desktop.diff-preferences.v1';
export const panelRecord = JSON.stringify({ version: 1, scopes: [{
  scope: { host: { hostID: identity.hostID }, authorityKey: JSON.stringify([identity.hostID, identity.origin, identity.authorizationID]), directory: identity.directory, sessionID: identity.sessionID },
  tabs: [{ id: JSON.stringify(['workspace', identity.directory + '/readme.md', false]), kind: 'diff', source: { kind: 'workspace', directory: identity.directory, path: 'readme.md' } }],
  selectedID: JSON.stringify(['workspace', identity.directory + '/readme.md', false]), rail: null, activeView: 'preview',
}] });
export function createDiffHost(options = {}) {
  const fixture = createHeaderHost(), read = fixture.handlers['runtime.request'];
  const fullReads = [], patchReads = [];
  fixture.handlers['runtime.request'] = input => {
    if (input.method === 'GET' && input.path === '/api/git/diff?directory=' + encodeURIComponent(identity.directory) + '&path=readme.md&staged=false'
      && input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease) {
      patchReads.push(input);
      if (options.long) return { status: 200, body: { diff: '@@ -1,12002 +1,12002 @@\n-APPLICATION_TOP_OLD\n' + '-APPLICATION_BODY_OLD\n'.repeat(12000) + '-APPLICATION_END_OLD\n+APPLICATION_TOP_NEW\n' + '+APPLICATION_BODY_NEW\n'.repeat(12000) + '+APPLICATION_END_NEW\n' } };
      return { status: 200, body: { diff: '@@ -1,3 +1,3 @@\n SAME_ROOT\n-BEFORE_ROOT\n+AFTER_ROOT\n TAIL_ROOT\n' } };
    }
    if (input.method === 'GET' && input.path === '/api/git/file-diff?directory=' + encodeURIComponent(identity.directory) + '&path=readme.md'
      && input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease) {
      fullReads.push(input); return { status: 200, body: { path: 'readme.md', original: 'SAME_ROOT\nBEFORE_ROOT\nTAIL_ROOT\nFULL_CONTEXT_ROOT', modified: 'SAME_ROOT\nAFTER_ROOT\nTAIL_ROOT\nFULL_CONTEXT_ROOT', isBinary: false } };
    }
    if (input.method === 'GET' && [
      '/api/git/status?directory=' + encodeURIComponent(identity.directory),
      '/api/git/status?directory=' + encodeURIComponent(identity.directory) + '&mode=light',
    ].includes(input.path)
      && input.expectedHost?.hostID === identity.hostID && input.expectedHost?.lease === identity.lease) return { status: 200, body: { isClean: false, current: 'main', files: [{ path: 'readme.md', index: ' ', working_dir: 'M' }] } };
    return read(input);
  };
  return { ...fixture, fullReads, patchReads };
}
