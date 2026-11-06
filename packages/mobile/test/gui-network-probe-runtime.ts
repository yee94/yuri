import { createRelayTunnelClient } from '../../ui/src/lib/relay/tunnel-client';

declare global {
  interface Window {
    guiProbe: { relayUrl: string; serverId: string; hostEncPubJwk: JsonWebKey; target: string; prewarm: boolean; preview: boolean };
    webkit: { messageHandlers: { probe: { postMessage(value: string): void } } };
  }
}
const tunnel = createRelayTunnelClient(window.guiProbe);
let token = '';
export const getActiveRelayDescriptor = () => window.guiProbe;
export const getActiveRelayTunnel = () => tunnel;
export const getRuntimeGeneration = () => 1;
export const subscribeRuntimeEndpointChanged = () => () => {};
export const subscribeRuntimeAuthGeneration = () => () => {};
export const getRuntimeUrlResolver = () => ({
  websocket: (path: string) => `ws://runtime.invalid${path}?yuri_url_token=${encodeURIComponent(token)}`,
  authenticatedAsset: (path: string) => { const url = new URL(path, 'http://runtime.invalid'); url.searchParams.set('yuri_url_token', token); return url.href; },
});
export const runtimeFetch = (path: string, init?: RequestInit) => {
  const headers = new Headers(init?.headers); headers.set('Authorization', 'Bearer probe-client');
  return tunnel.fetch(path, { ...init, headers });
};
export const refreshRuntimeUrlAuthToken = async () => {
  const response = await tunnel.fetch('/auth/url-token', { method: 'POST', headers: { Authorization: 'Bearer probe-client' } });
  if (!response.ok) throw new Error('probe auth failed');
  token = (await response.json()).token;
};
export const loadMobileConnections = () => { throw new Error('probe has an active relay'); };
export const isActiveRuntimeConnection = () => false;
