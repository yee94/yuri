import { getActiveRelayTunnel } from './relay/runtime-tunnel';
import { getRuntimeAuthGeneration } from './runtime-auth';
import { runtimeFetch } from './runtime-fetch';
import { getRuntimeGeneration, getRuntimeKey, subscribeRuntimeEndpointChanged } from './runtime-switch';

type RuntimeSessionRejection =
  | { kind: 'session'; response: Response; relay: boolean }
  | { kind: 'relay-authentication' };

/** Observe authoritative auth failures, without treating transport failure as logout. */
export const observeRuntimeSession = (onRejected: (rejection: RuntimeSessionRejection) => void, { desktop = false } = {}): (() => void) => {
  let disposed = false;
  let pending: AbortController | null = null;
  let unsubscribeTunnel: (() => void) | undefined;

  const bindTunnel = () => {
    unsubscribeTunnel?.();
    if (!desktop) return;
    const tunnel = getActiveRelayTunnel();
    if (!tunnel) return;
    const inspect = () => {
      if (!disposed && getActiveRelayTunnel() === tunnel
        && tunnel.getStatus().failureCode === 'relay_authentication_rejected') {
        onRejected({ kind: 'relay-authentication' });
      }
    };
    unsubscribeTunnel = tunnel.subscribeStatus(inspect);
    inspect();
  };

  const revalidate = () => {
    if (pending || disposed) return;
    const tunnel = getActiveRelayTunnel();
    if (desktop && tunnel?.getStatus().failureCode === 'relay_authentication_rejected') {
      onRejected({ kind: 'relay-authentication' });
      return;
    }
    const runtimeKey = getRuntimeKey();
    const runtimeGeneration = getRuntimeGeneration();
    const authGeneration = getRuntimeAuthGeneration();
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 10_000);
    void runtimeFetch('/auth/session', { credentials: 'include', signal: controller.signal }).then((response) => {
      if (disposed || controller.signal.aborted || runtimeKey !== getRuntimeKey()
        || runtimeGeneration !== getRuntimeGeneration() || authGeneration !== getRuntimeAuthGeneration()
        || tunnel !== getActiveRelayTunnel()) return;
      if (response.status === 401 || (desktop && tunnel && response.status === 403)) {
        onRejected({ kind: 'session', response, relay: Boolean(tunnel) });
      }
    }).catch(() => {
      // Offline, timeouts and server failures are not evidence of revoked credentials.
    }).finally(() => {
      clearTimeout(timeout);
      if (pending === controller) pending = null;
    });
  };
  const unsubscribeEndpoint = subscribeRuntimeEndpointChanged(() => {
    pending?.abort();
    pending = null;
    bindTunnel();
  });
  window.addEventListener('yuri:runtime-auth-rejected', revalidate);
  if (desktop) window.addEventListener('focus', revalidate);
  bindTunnel();
  return () => {
    disposed = true;
    pending?.abort();
    unsubscribeTunnel?.();
    unsubscribeEndpoint();
    window.removeEventListener('yuri:runtime-auth-rejected', revalidate);
    window.removeEventListener('focus', revalidate);
  };
};
