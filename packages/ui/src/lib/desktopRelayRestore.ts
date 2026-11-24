import { isElectronShell } from '@/lib/desktop';
import { getInjectedBootOutcome } from '@/lib/desktopBoot';
import {
  desktopHostProbe,
  desktopHostsGet,
  desktopHostsSet,
  desktopPrepareHost,
  getDesktopHostApiUrl,
  isPairedDesktopHost,
  normalizeHostUrl,
  probeRelayDesktopHost,
  type DesktopHost,
} from '@/lib/desktopHosts';
import { adoptRelayTunnel, isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { runtimeKeyForDesktopHost } from '@/lib/desktopHostSwitch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import {
  getRuntimeApiBaseUrl,
  getRuntimeGeneration,
  getRuntimeKey,
  subscribeRuntimeEndpointChanged,
  switchRuntimeEndpoint,
} from '@/lib/runtime-switch';
import { useConfigStore } from '@/stores/useConfigStore';

// Let the post-switch bootstrap traffic settle before the background refresh.
const CANDIDATE_REFRESH_DELAY_MS = 5_000;

// How long the stored direct address keeps startup to itself before the relay
// takes over. A live LAN probe answers well inside this window; a dead one no
// longer stalls startup for the probe's full timeout.
const DIRECT_PROBE_HEADSTART_MS = 1_500;
const DIRECT_RESELECT_TIMEOUT_MS = 3_000;
const RESELECT_ONLINE_DEBOUNCE_MS = 1_500;
const RESELECT_RESUME_DEBOUNCE_MS = 500;
const RESELECT_GRACE_RETRY_MS = 4_000;
const RESELECT_VISIBILITY_THROTTLE_MS = 5_000;
const DISCONNECT_RESELECT_INITIAL_MS = 3_000;
const DISCONNECT_RESELECT_MAX_MS = 30_000;

/**
 * A probe status that proves the direct transport is USABLE, not merely
 * reachable. Only these may replace a working relay transport: 'auth' means
 * the address answered but rejects our credentials — switching to it would
 * turn every request into a 401.
 */
const isDirectTransportUsable = (status: string): boolean =>
  status === 'ok' || status === 'update-recommended';

let candidateRefreshInFlight = false;

const readShellLocalOrigin = (): string => {
  if (typeof window === 'undefined') return '';
  const injected = window.__YURI_LOCAL_ORIGIN__;
  return typeof injected === 'string' ? injected.trim() : '';
};

const isHttpOrigin = (value: string): boolean => {
  if (!value || value === 'null') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin !== 'null';
  } catch {
    return false;
  }
};

/**
 * Virtual API base for a desktop relay client.
 * Packaged UI (`yuri-ui://`) reports `location.origin` as `"null"`,
 * which makes the URL resolver throw and leaves SDK calls on the injected
 * loopback — those then miss the tunnel and 404 against local OpenCode.
 * Prefer a real HTTP origin (window, else the shell loopback). runtimeFetch
 * tunnels that origin while relay is active.
 */
export const desktopRelayApiBaseUrl = (): string => {
  if (typeof window === 'undefined') return '';
  const windowOrigin = window.location.origin;
  if (isHttpOrigin(windowOrigin)) return windowOrigin;
  const local = readShellLocalOrigin();
  if (isHttpOrigin(local)) return local;
  return '';
};

/**
 * Background candidate refresh for a relay-connected desktop host: ask the
 * server (over the live authenticated transport) for its CURRENT LAN addresses,
 * update the stored host's direct `apiUrl` if it moved (pairing-time addresses
 * go stale when DHCP reassigns the host machine's IP), then probe the fresh
 * address — identity-gated by the host's pinned relay serverId — and hot-switch
 * relay → direct when it is reachable. The runtime key stays `host:<id>`, so the
 * swap is a transport change, not an instance switch.
 *
 * This rewrites only the direct address of an ALREADY-TRUSTED host, learned from
 * that host itself over the E2EE tunnel pinned to its key — the token and trust
 * boundary are unchanged, so no user confirmation is required. An https apiUrl
 * (stable tunnel hostname) is never overwritten: the DHCP problem does not apply
 * to it and the server does not know its own public hostnames.
 */
export const refreshDesktopHostCandidates = async (hostId: string): Promise<void> => {
  if (!isElectronShell() || candidateRefreshInFlight) return;
  const runtimeKey = `host:${hostId}`;
  // The candidates fetch rides the active runtime's transport — only meaningful
  // while this host IS the active runtime.
  if (getRuntimeKey() !== runtimeKey) return;
  const generation = getRuntimeGeneration();
  const isCurrent = () => getRuntimeKey() === runtimeKey && getRuntimeGeneration() === generation;
  candidateRefreshInFlight = true;
  try {
    const config = await desktopHostsGet().catch(() => null);
    if (!isCurrent()) return;
    const host = config?.hosts.find((entry) => entry.id === hostId);
    if (!config || !host?.relay) return;
    const currentApiUrl = host.apiUrl ? normalizeHostUrl(host.apiUrl) : null;
    if (currentApiUrl && currentApiUrl.startsWith('https://')) return;

    const response = await runtimeFetch('/api/client-auth/connection/candidates').catch(() => null);
    if (!response?.ok) return;
    const payload = await response.json().catch(() => null) as { serverId?: unknown; candidates?: unknown } | null;
    if (!isCurrent()) return;
    // Identity gate: the refresh must come from the server this host entry is
    // pinned to; anything else (including old servers without serverId) is ignored.
    if (!payload || payload.serverId !== host.relay.serverId) return;
    const reported = Array.isArray(payload.candidates) ? payload.candidates : [];
    const lanUrls: string[] = [];
    for (const entry of reported) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      if (record.type !== 'lan' || typeof record.url !== 'string') continue;
      const url = normalizeHostUrl(record.url);
      if (url && !lanUrls.includes(url)) lanUrls.push(url);
    }
    // Empty answer (loopback-only bind / scan failure) must not erase a stored
    // address — a stale one only costs a fast failed probe on the next start.
    if (lanUrls.length === 0) return;

    const nextApiUrl = currentApiUrl && lanUrls.includes(currentApiUrl) ? currentApiUrl : lanUrls[0];
    if (nextApiUrl !== currentApiUrl) {
      await desktopHostsSet({
        hosts: config.hosts.map((entry) => (entry.id === hostId ? { ...entry, apiUrl: nextApiUrl } : entry)),
        defaultHostId: config.defaultHostId,
        initialHostChoiceCompleted: config.initialHostChoiceCompleted,
      }).catch(() => undefined);
    }
    if (!isCurrent()) return;

    // We are on the relay for this host (the refresh call itself proves the
    // tunnel works) — only adopt the direct transport when the probe is a
    // definitive usable answer ('ok' / 'update-recommended'). A probe 'auth'
    // (reachable but our token is rejected) must NOT hot-switch off a working
    // relay: direct would 401 everything.
    const probe = await desktopHostProbe(nextApiUrl, {
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      expectedServerId: host.relay.serverId,
    }).catch(() => ({ status: 'unreachable' as const, latencyMs: 0 }));
    if (!isDirectTransportUsable(probe.status)) return;
    if (!isCurrent()) return; // user switched away or replaced this transport meanwhile
    switchRuntimeEndpoint({
      apiBaseUrl: nextApiUrl,
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      runtimeKey,
    });
  } finally {
    candidateRefreshInFlight = false;
  }
};

/** Fire-and-forget wrapper: schedule the refresh after a relay switch settles. */
export const scheduleDesktopHostCandidateRefresh = (hostId: string): void => {
  if (typeof window === 'undefined') return;
  window.setTimeout(() => {
    void refreshDesktopHostCandidates(hostId).catch(() => undefined);
  }, CANDIDATE_REFRESH_DELAY_MS);
};

/**
 * On desktop startup, reconnect a relay-capable default host. The Electron
 * shell boots the LOCAL UI for any host that carries a relay leg and defers
 * transport selection to the renderer: here we probe the direct address first
 * (cheap, preferred on the home network) and fall back to the E2EE tunnel via
 * switchRuntimeEndpoint({ relay }) — the multi-transport model mobile uses.
 * Direct-only hosts keep the shell-injected endpoint and adopt their stable
 * saved Host key before render; they do not open a Relay tunnel.
 *
 * Safe to call unconditionally; it is a no-op outside the Electron shell and when
 * the default host is local or already active.
 */
export const restoreDesktopRelayRuntime = async (targetHostId?: string): Promise<void> => {
  if (!isElectronShell()) return;
  const initialRuntimeKey = getRuntimeKey();
  const initialGeneration = getRuntimeGeneration();
  const canRestore = () => getRuntimeKey() === initialRuntimeKey && getRuntimeGeneration() === initialGeneration;
  const config = await desktopHostsGet().catch(() => null);
  if (!config || !canRestore()) return;
  // An explicit target (a "new window for host X") wins over the default-host
  // relaunch logic.
  const boot = getInjectedBootOutcome();
  const windowHostId = boot?.target === 'remote' ? boot.hostId : boot?.target === 'local' ? 'local' : null;
  const hostId = targetHostId || windowHostId || (config.defaultHostId !== 'local' ? config.defaultHostId : null);
  if (!hostId) return;
  let host = config.hosts.find((entry) => entry.id === hostId);
  if (!host) return;
  // Must match runtimeKeyForHost() in DesktopHostSwitcher so switch/resolve agree.
  const runtimeKey = runtimeKeyForDesktopHost(host);
  if (getRuntimeKey() === runtimeKey) return;

  if (!host.relay) {
    const directUrl = normalizeHostUrl(getDesktopHostApiUrl(host));
    if (directUrl && normalizeHostUrl(getRuntimeApiBaseUrl()) === directUrl
      && (!boot || boot.status === 'ok')) {
      switchRuntimeEndpoint({ apiBaseUrl: directUrl, clientToken: host.clientToken || null, requestHeaders: host.requestHeaders || null, runtimeKey });
    }
    return;
  }

  let rejectedToken: string | null = null;
  let retryCompleted = false;
  const selectTransport = async (candidate: DesktopHost): Promise<boolean> => {
    const directUrl = candidate.apiUrl || !candidate.relay ? normalizeHostUrl(getDesktopHostApiUrl(candidate)) : null;
    if (directUrl) {
      // Preserve the short LAN headstart. A losing probe never commits later.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const winner = await Promise.race([
        desktopHostProbe(directUrl, {
          clientToken: candidate.clientToken || null,
          requestHeaders: candidate.requestHeaders || null,
          expectedServerId: candidate.relay?.serverId,
        }).catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), DIRECT_PROBE_HEADSTART_MS); }),
      ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
      if (!canRestore()) return false;
      if (winner?.status === 'auth' && isPairedDesktopHost(candidate)) rejectedToken = candidate.clientToken || null;
      if (winner && isDirectTransportUsable(winner.status)) {
        switchRuntimeEndpoint({ apiBaseUrl: directUrl, clientToken: candidate.clientToken || null, requestHeaders: candidate.requestHeaders || null, runtimeKey });
        return true;
      }
    }

    if (!candidate.relay || !canRestore()) return false;
    const probe = await probeRelayDesktopHost(candidate.relay, { keepTunnel: true, clientToken: candidate.clientToken || null });
    if (!canRestore()) {
      probe.tunnel?.close();
      return false;
    }
    if (probe.status === 'auth' && isPairedDesktopHost(candidate)) rejectedToken = candidate.clientToken || null;
    if (probe.status !== 'ok' || !probe.tunnel) return false;
    adoptRelayTunnel(candidate.relay, probe.tunnel);
    switchRuntimeEndpoint({ apiBaseUrl: desktopRelayApiBaseUrl(), clientToken: candidate.clientToken || null, runtimeKey, relay: candidate.relay });
    // Ask the connected Host for its current LAN address in a separate,
    // identity-verified refresh; the losing startup probe cannot switch it.
    scheduleDesktopHostCandidateRefresh(candidate.id);
    return true;
  };

  try {
    if (await selectTransport(host) || !canRestore()) return;
    // Fast restore failed on both legs. Re-enter the normal main-owned SSH
    // initialization once, then retry using its refreshed endpoint/credentials.
    host = await desktopPrepareHost(host);
    if (!canRestore()) return;
    if (await selectTransport(host) || !canRestore()) return;
    retryCompleted = true;
    throw new Error('Remote instance is unreachable after initialization');
  } catch (error) {
    if (canRestore()) {
      window.__YURI_DESKTOP_BOOT_OUTCOME__ = { target: 'remote', status: retryCompleted && rejectedToken && rejectedToken === host.clientToken ? 'pairing-expired' : 'unreachable', hostId, url: getDesktopHostApiUrl(host) };
    }
    throw error;
  }
};

type DesktopTransportReselectResult =
  | { outcome: 'switched'; transport: 'direct' | 'relay' }
  | { outcome: 'unchanged'; transport: 'direct' | 'relay' }
  | { outcome: 'unreachable' | 'skipped' | 'stale' };

let reselectSeq = 0;

const parseRemoteRuntimeHostId = (runtimeKey: string): string | null => {
  if (!runtimeKey.startsWith('host:')) return null;
  const hostId = runtimeKey.slice('host:'.length).trim();
  return hostId || null;
};

const probeDirectBounded = async (
  url: string,
  host: DesktopHost,
  timeoutMs: number,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    desktopHostProbe(url, {
      clientToken: host.clientToken || null,
      requestHeaders: host.requestHeaders || null,
      expectedServerId: host.relay?.serverId,
    }).catch(() => null),
    new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
};

/**
 * Runtime bidirectional transport reselection for a relay-capable desktop host:
 * - On direct: verifies the direct leg; when unreachable/unusable (e.g. moved
 *   from office LAN to home Wi-Fi or VPN changed), probes the Relay leg and
 *   hot-switches in place while preserving the stable `host:<id>` runtimeKey.
 * - On Relay: checks whether the stored direct address (or refreshed LAN
 *   candidates) is usable again and hot-switches Relay → direct.
 */
export const reselectDesktopHostTransport = async (options?: {
  hostId?: string;
}): Promise<DesktopTransportReselectResult> => {
  if (!isElectronShell()) return { outcome: 'skipped' };
  const runtimeKey = getRuntimeKey();
  const activeHostId = parseRemoteRuntimeHostId(runtimeKey);
  if (!activeHostId) return { outcome: 'skipped' };
  const hostId = options?.hostId?.trim() || activeHostId;
  if (hostId !== activeHostId) return { outcome: 'skipped' };

  const seq = ++reselectSeq;
  const generation = getRuntimeGeneration();
  const isCurrent = () => (
    seq === reselectSeq
    && getRuntimeKey() === runtimeKey
    && getRuntimeGeneration() === generation
  );

  const config = await desktopHostsGet().catch(() => null);
  if (!isCurrent()) return { outcome: 'stale' };
  const host = config?.hosts.find((entry) => entry.id === hostId);
  if (!host?.relay) return { outcome: 'skipped' };

  const directUrl = host.apiUrl ? normalizeHostUrl(getDesktopHostApiUrl(host)) : null;

  if (isRelayModeActive()) {
    if (directUrl) {
      const probe = await probeDirectBounded(directUrl, host, DIRECT_PROBE_HEADSTART_MS);
      if (!isCurrent()) return { outcome: 'stale' };
      if (probe && isDirectTransportUsable(probe.status)) {
        switchRuntimeEndpoint({
          apiBaseUrl: directUrl,
          clientToken: host.clientToken || null,
          requestHeaders: host.requestHeaders || null,
          runtimeKey,
        });
        return { outcome: 'switched', transport: 'direct' };
      }
    }
    await refreshDesktopHostCandidates(hostId).catch(() => undefined);
    if (getRuntimeKey() !== runtimeKey) return { outcome: 'stale' };
    if (getRuntimeGeneration() !== generation && !isRelayModeActive()) {
      return { outcome: 'switched', transport: 'direct' };
    }
    return { outcome: 'unchanged', transport: 'relay' };
  }

  if (directUrl) {
    const probe = await probeDirectBounded(directUrl, host, DIRECT_RESELECT_TIMEOUT_MS);
    if (!isCurrent()) return { outcome: 'stale' };
    if (probe && isDirectTransportUsable(probe.status)) {
      return { outcome: 'unchanged', transport: 'direct' };
    }
  }

  const relayProbe = await probeRelayDesktopHost(host.relay, {
    keepTunnel: true,
    clientToken: host.clientToken || null,
  }).catch(() => ({ status: 'unreachable' as const, latencyMs: 0 }));

  if (!isCurrent()) {
    if ('tunnel' in relayProbe) relayProbe.tunnel?.close();
    return { outcome: 'stale' };
  }

  if (relayProbe.status !== 'ok' || !('tunnel' in relayProbe) || !relayProbe.tunnel) {
    return { outcome: 'unreachable' };
  }

  adoptRelayTunnel(host.relay, relayProbe.tunnel);
  switchRuntimeEndpoint({
    apiBaseUrl: desktopRelayApiBaseUrl(),
    clientToken: host.clientToken || null,
    runtimeKey,
    relay: host.relay,
  });
  scheduleDesktopHostCandidateRefresh(host.id);
  return { outcome: 'switched', transport: 'relay' };
};

type DesktopTransportRecoveryOptions = {
  reselect?: (options?: { hostId?: string }) => Promise<DesktopTransportReselectResult>;
  onlineDebounceMs?: number;
  resumeDebounceMs?: number;
  graceRetryMs?: number;
  visibilityThrottleMs?: number;
  disconnectInitialMs?: number;
  disconnectMaxMs?: number;
};

/**
 * Runtime monitor for desktop remote hosts: triggers bidirectional transport
 * reselection on `online`, `yuri:system-resume`, foreground visibility return,
 * and sustained stream disconnect with bounded exponential backoff.
 */
export const startDesktopTransportRecovery = (
  options: DesktopTransportRecoveryOptions = {},
): (() => void) => {
  if (!isElectronShell() || typeof window === 'undefined') {
    return () => {};
  }

  const reselect = options.reselect ?? reselectDesktopHostTransport;
  const onlineDebounceMs = options.onlineDebounceMs ?? RESELECT_ONLINE_DEBOUNCE_MS;
  const resumeDebounceMs = options.resumeDebounceMs ?? RESELECT_RESUME_DEBOUNCE_MS;
  const graceRetryMs = options.graceRetryMs ?? RESELECT_GRACE_RETRY_MS;
  const visibilityThrottleMs = options.visibilityThrottleMs ?? RESELECT_VISIBILITY_THROTTLE_MS;
  const disconnectInitialMs = options.disconnectInitialMs ?? DISCONNECT_RESELECT_INITIAL_MS;
  const disconnectMaxMs = options.disconnectMaxMs ?? DISCONNECT_RESELECT_MAX_MS;

  let disposed = false;
  let triggerTimer: ReturnType<typeof setTimeout> | null = null;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  let disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let disconnectAttempt = 0;
  let lastVisibilityCheckAt = 0;
  let runSeq = 0;

  const clearTriggerTimers = () => {
    if (triggerTimer !== null) {
      clearTimeout(triggerTimer);
      triggerTimer = null;
    }
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };

  const clearDisconnectTimer = () => {
    if (disconnectTimer !== null) {
      clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
  };

  const isForegroundOnline = (): boolean => {
    const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    return visible && online;
  };

  const isRemoteHostDisconnected = (): boolean => {
    if (!parseRemoteRuntimeHostId(getRuntimeKey())) return false;
    const { isConnected, connectionPhase } = useConfigStore.getState();
    return !isConnected && (connectionPhase === 'reconnecting' || connectionPhase === 'connecting');
  };

  const scheduleDisconnectCheck = () => {
    if (disposed) return;
    clearDisconnectTimer();
    if (!isRemoteHostDisconnected() || !isForegroundOnline()) return;
    const delayMs = Math.min(disconnectInitialMs * (2 ** Math.min(disconnectAttempt, 4)), disconnectMaxMs);
    disconnectTimer = setTimeout(() => {
      disconnectTimer = null;
      if (disposed || !isRemoteHostDisconnected() || !isForegroundOnline()) return;
      const mySeq = ++runSeq;
      void reselect().then((result) => {
        if (disposed || mySeq !== runSeq) return;
        if (result.outcome === 'switched') {
          disconnectAttempt = 0;
          return;
        }
        if (result.outcome === 'skipped') return;
        disconnectAttempt += 1;
        scheduleDisconnectCheck();
      }).catch(() => {
        if (disposed || mySeq !== runSeq) return;
        disconnectAttempt += 1;
        scheduleDisconnectCheck();
      });
    }, delayMs);
  };

  const triggerReselect = (debounceMs: number, allowGraceRetry: boolean) => {
    if (disposed || !parseRemoteRuntimeHostId(getRuntimeKey())) return;
    clearTriggerTimers();
    const mySeq = ++runSeq;
    triggerTimer = setTimeout(() => {
      triggerTimer = null;
      if (disposed || mySeq !== runSeq || !parseRemoteRuntimeHostId(getRuntimeKey())) return;
      void reselect().then((result) => {
        if (disposed || mySeq !== runSeq) return;
        if (result.outcome === 'switched') {
          disconnectAttempt = 0;
          clearDisconnectTimer();
          return;
        }
        if (result.outcome === 'unreachable' && allowGraceRetry && isForegroundOnline()) {
          graceTimer = setTimeout(() => {
            graceTimer = null;
            if (disposed || mySeq !== runSeq || !parseRemoteRuntimeHostId(getRuntimeKey())) return;
            void reselect().then((retryResult) => {
              if (disposed || mySeq !== runSeq) return;
              if (retryResult.outcome === 'switched') {
                disconnectAttempt = 0;
                clearDisconnectTimer();
              } else if (isRemoteHostDisconnected()) {
                scheduleDisconnectCheck();
              }
            }).catch(() => undefined);
          }, graceRetryMs);
          return;
        }
        if (isRemoteHostDisconnected()) {
          scheduleDisconnectCheck();
        }
      }).catch(() => undefined);
    }, debounceMs);
  };

  const onOnline = () => {
    disconnectAttempt = 0;
    triggerReselect(onlineDebounceMs, true);
  };

  const onSystemResume = () => {
    disconnectAttempt = 0;
    triggerReselect(resumeDebounceMs, true);
  };

  const onVisibilityChange = () => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      clearDisconnectTimer();
      return;
    }
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastVisibilityCheckAt < visibilityThrottleMs) return;
    if (!isRemoteHostDisconnected() && !isRelayModeActive()) return;
    lastVisibilityCheckAt = now;
    disconnectAttempt = 0;
    triggerReselect(0, false);
  };

  window.addEventListener('online', onOnline);
  window.addEventListener('yuri:system-resume', onSystemResume);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  const unsubscribeConfig = useConfigStore.subscribe((state, prev) => {
    if (state.isConnected === prev.isConnected && state.connectionPhase === prev.connectionPhase) {
      return;
    }
    if (state.isConnected && state.connectionPhase === 'connected') {
      disconnectAttempt = 0;
      clearDisconnectTimer();
      return;
    }
    if (isRemoteHostDisconnected()) {
      scheduleDisconnectCheck();
    } else {
      clearDisconnectTimer();
    }
  });

  const unsubscribeEndpoint = subscribeRuntimeEndpointChanged(() => {
    disconnectAttempt = 0;
    clearTriggerTimers();
    clearDisconnectTimer();
    if (isRemoteHostDisconnected()) {
      scheduleDisconnectCheck();
    }
  });

  if (isRemoteHostDisconnected()) {
    scheduleDisconnectCheck();
  }

  return () => {
    disposed = true;
    clearTriggerTimers();
    clearDisconnectTimer();
    window.removeEventListener('online', onOnline);
    window.removeEventListener('yuri:system-resume', onSystemResume);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
    unsubscribeConfig();
    unsubscribeEndpoint();
  };
};
