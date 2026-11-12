import { WebSocket } from 'ws';
import { remoteDeadlineSignal } from './deadline.js';

const failure = (code, status = 503) => Object.assign(new Error(code), { code, status });
const directUrl = (value) => {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url : null;
  } catch { return null; }
};

export async function createRemoteTransport(host, { fetchImpl = fetch, signal } = {}) {
  const boundedSignal = (ms) => remoteDeadlineSignal(ms, signal ? [signal] : []);
  const token = host.clientToken;
  if (!token) throw failure('remote_authorization_required', 401);
  const headers = { ...host.requestHeaders, Authorization: `Bearer ${token}` };
  const requestHeaders = (input) => {
    const merged = new Headers(input);
    for (const [name, value] of Object.entries(headers)) merged.set(name, value);
    return Object.fromEntries(merged);
  };
  let base = directUrl(host.apiUrl || host.url);
  let capabilities;
  const readAdmission = async (response) => {
    if (response.status === 401 || response.status === 403) throw failure('remote_authorization_required', response.status);
    const capability = response.ok ? await response.json().catch(() => null) : null;
    if (!capability?.remoteProjects || capability.protocol !== 1 || !capability.instanceId) throw failure('remote_incompatible', 409);
    return capability;
  };
  // A learned direct address must prove identity before it receives a secret.
  if (base && host.relay) {
    try {
      const health = await fetchImpl(new URL('/health', base), { redirect: 'error', signal: boundedSignal(2000) });
      if (!health.ok || (await health.json()).serverId !== host.relay.serverId) base = null;
    } catch { base = null; }
  }
  if (base) {
    try {
      const response = await fetchImpl(new URL('/api/hosts/capabilities', base), {
        headers, redirect: 'error', signal: boundedSignal(3000),
      });
      capabilities = await readAdmission(response);
    } catch (error) {
      if (error.code === 'remote_incompatible') throw error;
      if (!host.relay) throw error;
      base = null;
    }
  }
  if (base) {
    const sockets = new Set();
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true; signal?.removeEventListener('abort', close);
      for (const socket of sockets) socket.terminate();
      sockets.clear();
    };
    signal?.addEventListener('abort', close, { once: true });
    if (signal?.aborted) close();
    return {
    capabilities,
    fetch: (route, init = {}) => {
      if (closed) throw failure('stale_host', 409);
      return fetchImpl(new URL(route, base), { ...init,
        signal: AbortSignal.any([...(signal ? [signal] : []), ...(init.signal ? [init.signal] : [])]),
        redirect: 'manual', headers: requestHeaders(init.headers) });
    },
    openWebSocket(route, protocols = [], { onMessage } = {}) {
      if (closed) throw failure('stale_host', 409);
      const url = new URL(route, base);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, protocols, { headers });
      socket.onmessage = onMessage || null;
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      socket.on('error', () => {});
      socket.binaryType = 'arraybuffer';
      return socket;
    },
    close,
  };
  }
  if (!host.relay || (host.source === 'ssh' && host.pairingSource !== 'connect-link')) {
    throw failure('remote_transport_unavailable');
  }
  const { createRelayTunnelClient } = await import('./relay-client.bundle.js');
  const tunnel = createRelayTunnelClient({ ...host.relay, batchWindowMs: 0,
    createWireSocket(url) {
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      return socket;
    } });
  const close = () => { signal?.removeEventListener('abort', close); tunnel.close(); };
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  const relayFetch = (route, init = {}) => tunnel.fetch(`http://remote.invalid${route}`, {
    ...init, signal: AbortSignal.any([...(signal ? [signal] : []), ...(init.signal ? [init.signal] : [])]),
    headers: requestHeaders(init.headers),
  });
  try {
    capabilities = await readAdmission(await relayFetch('/api/hosts/capabilities', { signal: boundedSignal(10000) }));
  } catch (error) {
    close();
    if (['remote_authorization_required', 'remote_incompatible'].includes(error?.code)) throw error;
    throw failure('remote_relay_unavailable');
  }
  return { capabilities, fetch: relayFetch, async openWebSocket(route, protocols = [], { onMessage } = {}) {
    const response = await relayFetch('/auth/url-token', { method: 'POST', signal: boundedSignal(5000) });
    const authorization = response.ok ? await response.json() : null;
    if (!authorization?.token) throw failure('remote_authorization_required', 401);
    const target = new URL(route, 'http://remote.invalid');
    target.searchParams.set('yuri_url_token', authorization.token);
    const socket = tunnel.openWebSocket(`${target.pathname}${target.search}`, protocols, headers);
    socket.onmessage = onMessage || null;
    return socket;
  },
    close };
}
