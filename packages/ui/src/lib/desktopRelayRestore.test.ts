import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { vi } from 'vitest';

// Relay hot-switch gate: only a definitive usable direct probe ('ok' /
// 'update-recommended') may replace a working relay transport. A probe 'auth'
// (reachable but token rejected) previously passed the blocked-status check
// and hot-switched the desktop off a healthy E2EE relay onto a direct leg
// that 401s every runtime request.

let activeRuntimeKey = 'host:host-1';
let activeRuntimeGeneration = 0;
let relayActive = false;
let probeStatus: 'ok' | 'auth' | 'update-recommended' | 'incompatible' | 'wrong-service' | 'unreachable' = 'ok';
let relayProbeStatus: 'ok' | 'auth' | 'unreachable' = 'ok';
const switches: Array<Record<string, unknown>> = [];
const adoptedTunnels: Array<unknown> = [];
let persistedHosts: Array<Record<string, unknown>> = [];
let endpointListeners: Array<() => void> = [];

mock.module('@/lib/desktop', () => ({
  isElectronShell: () => true,
}));

const passthroughUrl = (raw: unknown): string | null =>
  typeof raw === 'string' && raw.trim() ? raw.trim() : null;

mock.module('@/lib/desktopHosts', () => ({
  desktopHostProbe: async () => ({ status: probeStatus, latencyMs: 5 }),
  desktopHostsGet: async () => ({
    hosts: persistedHosts,
    defaultHostId: 'host-1',
    initialHostChoiceCompleted: true,
    localOrigin: 'http://127.0.0.1:57123',
  }),
  desktopHostsSet: async (config: { hosts: Array<Record<string, unknown>> }) => {
    persistedHosts = config.hosts;
  },
  desktopPrepareHost: async (host: Record<string, unknown>) => host,
  getDesktopHostApiUrl: (host: { apiUrl?: string }) => host.apiUrl ?? '',
  isPairedDesktopHost: () => false,
  normalizeHostUrl: passthroughUrl,
  probeRelayDesktopHost: async () => (
    relayProbeStatus === 'ok'
      ? { status: 'ok', latencyMs: 18, tunnel: { close: vi.fn() } }
      : { status: relayProbeStatus, latencyMs: 0 }
  ),
}));

mock.module('@/lib/desktopHostSwitch', () => ({
  runtimeKeyForDesktopHost: (host: { id: string }) => (host.id === 'local' ? 'local' : `host:${host.id}`),
}));

mock.module('@/lib/relay/runtime-tunnel', () => ({
  adoptRelayTunnel: (_descriptor: unknown, tunnel: unknown) => {
    adoptedTunnels.push(tunnel);
  },
  isRelayModeActive: () => relayActive,
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async () => ({
    ok: true,
    json: async () => ({
      serverId: 'srv-1',
      candidates: [{ type: 'lan', url: 'http://192.168.1.50:57123' }],
    }),
  }),
}));

let configState = { isConnected: true, connectionPhase: 'connected' };
const configListeners = new Set<(state: typeof configState, prev: typeof configState) => void>();

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => configState,
    setState: (partial: Partial<typeof configState>) => {
      const prev = configState;
      configState = { ...configState, ...partial };
      for (const listener of configListeners) listener(configState, prev);
    },
    subscribe: (listener: (state: typeof configState, prev: typeof configState) => void) => {
      configListeners.add(listener);
      return () => { configListeners.delete(listener); };
    },
  },
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: () => 'http://192.168.1.50:57123',
  getRuntimeKey: () => activeRuntimeKey,
  getRuntimeGeneration: () => activeRuntimeGeneration,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    endpointListeners.push(listener);
    return () => {
      endpointListeners = endpointListeners.filter((entry) => entry !== listener);
    };
  },
  switchRuntimeEndpoint: (options: Record<string, unknown>) => {
    switches.push(options);
    activeRuntimeGeneration += 1;
    relayActive = Boolean(options.relay);
  },
}));

const {
  desktopRelayApiBaseUrl,
  refreshDesktopHostCandidates,
  reselectDesktopHostTransport,
  startDesktopTransportRecovery,
} = await import('./desktopRelayRestore');
const { useConfigStore } = await import('@/stores/useConfigStore');

describe('desktopRelayApiBaseUrl', () => {
  test('uses the shell loopback when packaged UI origin is null', () => {
    const originalWindow = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        location: { origin: 'null', href: 'yuri-ui://app/index.html' },
        __YURI_LOCAL_ORIGIN__: 'http://127.0.0.1:57123',
      },
    });
    try {
      expect(desktopRelayApiBaseUrl()).toBe('http://127.0.0.1:57123');
    } finally {
      Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    }
  });
});

const relayHost = {
  id: 'host-1',
  label: 'Remote desktop',
  url: 'http://192.168.1.50:57123',
  apiUrl: 'http://192.168.1.50:57123',
  relay: {
    relayUrl: 'wss://relay.example/ws',
    serverId: 'srv-1',
    hostEncPubJwk: { kty: 'EC', crv: 'P-256', x: 'axfR8uEsQv8FJfV6gYwVgyNMLawKaV7Rbm6V7RkF7yA', y: 'T-NC4v4af5uO5-tKfA-eFivOM1drMV7Oy7ZAaDe_UfU' },
  },
};

describe('refreshDesktopHostCandidates relay→direct hot-switch gate', () => {
  beforeEach(() => {
    activeRuntimeKey = 'host:host-1';
    switches.length = 0;
    persistedHosts = [{ ...relayHost, relay: { ...relayHost.relay } }];
  });

  test('keeps the relay when the direct probe answers auth (token rejected)', async () => {
    probeStatus = 'auth';
    await refreshDesktopHostCandidates('host-1');
    expect(switches).toEqual([]);
  });

  test('keeps the relay on blocked probe statuses', async () => {
    for (const status of ['unreachable', 'wrong-service', 'incompatible'] as const) {
      probeStatus = status;
      await refreshDesktopHostCandidates('host-1');
    }
    expect(switches).toEqual([]);
  });

  test('adopts direct on a usable probe without carrying the relay descriptor', async () => {
    probeStatus = 'ok';
    await refreshDesktopHostCandidates('host-1');
    expect(switches).toHaveLength(1);
    expect(switches[0].apiBaseUrl).toBe('http://192.168.1.50:57123');
    expect(switches[0].runtimeKey).toBe('host:host-1');
    expect(switches[0].relay).toBeUndefined();
  });

  test('update-recommended is still a usable direct transport', async () => {
    probeStatus = 'update-recommended';
    await refreshDesktopHostCandidates('host-1');
    expect(switches).toHaveLength(1);
  });
});

describe('reselectDesktopHostTransport bidirectional hot-switch', () => {
  beforeEach(() => {
    activeRuntimeKey = 'host:host-1';
    activeRuntimeGeneration = 0;
    relayActive = false;
    probeStatus = 'ok';
    relayProbeStatus = 'ok';
    switches.length = 0;
    adoptedTunnels.length = 0;
    persistedHosts = [{ ...relayHost, relay: { ...relayHost.relay } }];
  });

  test('hot-switches direct → relay when direct becomes unreachable after network change', async () => {
    probeStatus = 'unreachable';
    relayProbeStatus = 'ok';
    const result = await reselectDesktopHostTransport();
    expect(result).toEqual({ outcome: 'switched', transport: 'relay' });
    expect(adoptedTunnels).toHaveLength(1);
    expect(switches).toHaveLength(1);
    expect(switches[0].runtimeKey).toBe('host:host-1');
    expect(switches[0].relay).toEqual(relayHost.relay);
  });

  test('stays on direct when direct probe is still usable', async () => {
    probeStatus = 'ok';
    const result = await reselectDesktopHostTransport();
    expect(result).toEqual({ outcome: 'unchanged', transport: 'direct' });
    expect(switches).toEqual([]);
  });

  test('reports unreachable when both direct and relay fail', async () => {
    probeStatus = 'unreachable';
    relayProbeStatus = 'unreachable';
    const result = await reselectDesktopHostTransport();
    expect(result).toEqual({ outcome: 'unreachable' });
    expect(switches).toEqual([]);
  });

  test('hot-switches relay → direct when LAN becomes reachable again', async () => {
    relayActive = true;
    probeStatus = 'ok';
    const result = await reselectDesktopHostTransport();
    expect(result).toEqual({ outcome: 'switched', transport: 'direct' });
    expect(switches).toHaveLength(1);
    expect(switches[0].apiBaseUrl).toBe('http://192.168.1.50:57123');
    expect(switches[0].relay).toBeUndefined();
  });

  test('skips local host and direct-only hosts', async () => {
    activeRuntimeKey = 'local';
    expect(await reselectDesktopHostTransport()).toEqual({ outcome: 'skipped' });

    activeRuntimeKey = 'host:host-1';
    persistedHosts = [{ id: 'host-1', label: 'Direct only', url: 'http://192.168.1.50:57123', apiUrl: 'http://192.168.1.50:57123' }];
    expect(await reselectDesktopHostTransport()).toEqual({ outcome: 'skipped' });
  });
});

describe('startDesktopTransportRecovery', () => {
  beforeEach(() => {
    activeRuntimeKey = 'host:host-1';
    relayActive = false;
    useConfigStore.setState({ isConnected: true, connectionPhase: 'connected' });
  });

  test('triggers reselection on online, system-resume, and sustained disconnect backoff', async () => {
    vi.useFakeTimers();
    try {
      let reselectCalls = 0;
      const reselect = async () => {
        reselectCalls += 1;
        return { outcome: 'unreachable' as const };
      };
      const cleanup = startDesktopTransportRecovery({
        reselect,
        onlineDebounceMs: 100,
        resumeDebounceMs: 50,
        graceRetryMs: 200,
        disconnectInitialMs: 150,
        disconnectMaxMs: 600,
      });

      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(100);
      expect(reselectCalls).toBe(1);

      // Grace retry fires when online reselect reported unreachable.
      await vi.advanceTimersByTimeAsync(200);
      expect(reselectCalls).toBe(2);

      // Sustained disconnect triggers exponential backoff checks.
      useConfigStore.setState({ isConnected: false, connectionPhase: 'reconnecting' });
      await vi.advanceTimersByTimeAsync(150);
      expect(reselectCalls).toBe(3);
      await vi.advanceTimersByTimeAsync(300);
      expect(reselectCalls).toBe(4);

      // Reconnecting clears further disconnect retries.
      useConfigStore.setState({ isConnected: true, connectionPhase: 'connected' });
      await vi.advanceTimersByTimeAsync(1000);
      expect(reselectCalls).toBe(4);

      // System resume triggers prompt reselection.
      window.dispatchEvent(new Event('yuri:system-resume'));
      await vi.advanceTimersByTimeAsync(50);
      expect(reselectCalls).toBe(5);

      cleanup();
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(500);
      expect(reselectCalls).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });
});
