import { makeOpenCodeV2Client } from '../opencode/v2-client.js';

/** Official SDK forwarding over one authenticated, authority-fenced task lease.
 * The target Yuri HTTP proxy enforces its own current OpenCode write admission.
 * No Hub runtime contract, endpoint, credentials or protocol implementation leaks in.
 */
export function makeRemoteTaskOpenCodeClient(lease) {
  if (!lease || typeof lease.request !== 'function' || !lease.target?.hubId || !lease.target?.hostId || !lease.target?.instanceId) {
    throw new Error('A complete authenticated remote task lease is required');
  }
  return makeOpenCodeV2Client({
    baseUrl: 'http://remote-task.invalid',
    executionAdmission: 'target-yuri-proxy',
    fetchImpl: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin !== 'http://remote-task.invalid' || !url.pathname.startsWith('/api/')) throw new Error('Remote SDK route escaped its target proxy');
      const mutation = !['GET', 'HEAD'].includes(request.method);
      return lease.request(`${url.pathname}${url.search}`, {
        method: request.method, headers: request.headers, signal: request.signal,
        ...(mutation ? { body: await request.arrayBuffer() } : {}),
      }, { longRunning: mutation });
    },
  });
}
