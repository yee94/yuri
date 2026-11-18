import { invokeDesktop, isElectronShell } from '@/lib/desktop';
import { getInjectedBootOutcome } from '@/lib/desktopBoot';
import { desktopHostsGet, getDesktopHostApiUrl, normalizeHostUrl, type DesktopHostsConfig } from '@/lib/desktopHosts';
import { runtimeKeyForDesktopHost } from '@/lib/desktopHostSwitch';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { getRuntimeAuthGeneration, getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl, getRuntimeGeneration, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';

const sameOrigin = (left: string, right: string): boolean => {
  const normalizedLeft = normalizeHostUrl(left);
  const normalizedRight = normalizeHostUrl(right);
  if (!normalizedLeft || !normalizedRight) return false;
  try {
    return new URL(normalizedLeft).origin === new URL(normalizedRight).origin;
  } catch {
    return false;
  }
};

/** Saved desktop host this window is bound to, or null for local / unbound windows. */
export const resolveActiveDesktopHostId = (): string | null => {
  const runtimeKey = getRuntimeKey();
  if (runtimeKey.startsWith('host:')) return runtimeKey.slice(5);
  const boot = getInjectedBootOutcome();
  return boot?.target === 'remote' && boot.status === 'ok' && sameOrigin(boot.url, getRuntimeApiBaseUrl()) ? boot.hostId : null;
};

// A reloaded window can lose its `host:` runtime key while still talking to the
// SSH tunnel; match the endpoint so it is never mistaken for a password host.
const findBoundSshHostId = (config: DesktopHostsConfig): string | null => {
  const sshHostIds = config.sshHostIds ?? [];
  const bound = resolveActiveDesktopHostId();
  if (bound) return sshHostIds.includes(bound) ? bound : null;
  const apiBaseUrl = getRuntimeApiBaseUrl();
  const host = config.hosts.find((entry) => sshHostIds.includes(entry.id) && !entry.relay
    && sameOrigin(getDesktopHostApiUrl(entry), apiBaseUrl));
  return host?.id ?? null;
};

/** SSH host this window is bound to, for user-facing reconnect guidance. */
export const findBoundDesktopSshHost = async (): Promise<{ id: string; label: string } | null> => {
  if (!isElectronShell() || getActiveRelayTunnel()) return null;
  const config = await desktopHostsGet().catch(() => null);
  if (!config) return null;
  const hostId = findBoundSshHostId(config);
  if (!hostId) return null;
  const host = config.hosts.find((entry) => entry.id === hostId);
  return { id: hostId, label: host?.label?.trim() || '' };
};

export type DesktopSshHostResync = 'not-ssh' | 'unchanged' | 'switched' | 'failed';

/**
 * Re-adopt the stored endpoint and credential of the SSH host this window is
 * bound to. SSH (re)connects mint a replacement client token that revokes the
 * previous one, so open windows must follow the stored token instead of
 * prompting for the ephemeral remote UI password. With `refresh`, the shell
 * first ensures the tunnel and re-mints only when the stored token is rejected.
 */
export const resyncDesktopSshHostRuntime = async (options: { hostId?: string; refresh?: boolean } = {}): Promise<DesktopSshHostResync> => {
  if (!isElectronShell() || getActiveRelayTunnel()) return 'not-ssh';
  const runtimeKey = getRuntimeKey();
  const runtimeGeneration = getRuntimeGeneration();
  const authGeneration = getRuntimeAuthGeneration();
  const isCurrent = () => runtimeKey === getRuntimeKey() && runtimeGeneration === getRuntimeGeneration()
    && authGeneration === getRuntimeAuthGeneration();

  let config = await desktopHostsGet().catch(() => null);
  if (!config || !isCurrent()) return 'unchanged';
  const hostId = findBoundSshHostId(config);
  if (!hostId || (options.hostId && options.hostId !== hostId)) return 'not-ssh';
  if (options.refresh) {
    try {
      await invokeDesktop('desktop_ssh_host_token_refresh', { hostId });
    } catch {
      return 'failed';
    }
    config = await desktopHostsGet().catch(() => null);
    if (!config || !isCurrent()) return 'unchanged';
  }
  const host = config.hosts.find((entry) => entry.id === hostId);
  const apiBaseUrl = host ? normalizeHostUrl(getDesktopHostApiUrl(host)) : null;
  if (!host || host.relay || !apiBaseUrl || !host.clientToken) return 'unchanged';
  if (host.clientToken === getRuntimeBearerTokenSync() && normalizeHostUrl(getRuntimeApiBaseUrl()) === apiBaseUrl) return 'unchanged';
  switchRuntimeEndpoint({
    apiBaseUrl,
    clientToken: host.clientToken,
    requestHeaders: host.requestHeaders || null,
    runtimeKey: runtimeKeyForDesktopHost(host),
  });
  return 'switched';
};
