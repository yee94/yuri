import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { getActiveRelayDescriptor, type RelayRuntimeDescriptor } from '@/lib/relay/runtime-tunnel';
import { createRelayTunnelClient, type RelayTunnelClient, type RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { wsUrlToTunnelPath } from '@/lib/relay/tunnel-payloads';
import { getRuntimeApiBaseUrl, getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { refreshRuntimeUrlAuthToken, subscribeRuntimeAuthGeneration } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { createMobileGuiWireFactory } from './mobile-network-wire';
import { mobileGuiNetworkBridge as plugin, type MobileGuiDirectTarget, type MobileGuiNetworkEvent as NativeEvent } from './mobile-network-bridge';

const CHUNK = 16 * 1024;
const WINDOW = 128 * 1024;
const MAX_STREAMS = 32;
const READY_TIMEOUT_MS = 20_000;
const IDLE_CLOSE_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
// The platform proxy is process/data-store scoped. Serialize leases and restoration,
// including StrictMode replay, before allowing another plugin host to execute.
let previousRelease: Promise<void> = Promise.resolve();

export type MobileGuiNetwork = {
  /** Opens the plugin Relay channel now; plugin traffic otherwise connects it on first use. */
  connect(signal?: AbortSignal): Promise<{ hostOrigin?: string }>;
  release(): Promise<void>;
};

type Stream = { chain: Promise<void>; queued: number; credit: number; opened: boolean };
type Channel = { tunnel: RelayTunnelClient; socket: RelayTunnelWebSocket; hostOrigin?: string; heartbeat: ReturnType<typeof setInterval> };

const targetOf = (raw: string): MobileGuiDirectTarget | null => {
  try {
    const url = new URL(raw);
    const secure = url.protocol === 'https:' || url.protocol === 'wss:';
    if (!secure && url.protocol !== 'http:' && url.protocol !== 'ws:') return null;
    const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return hostname ? { hostname, port: Number(url.port) || (secure ? 443 : 80) } : null;
  } catch { return null; }
};

/** Yuri's own transports never enter the plugin egress, so plugin work cannot stall sync. */
const applicationTargets = (descriptor: RelayRuntimeDescriptor, candidates: readonly string[]): MobileGuiDirectTarget[] => {
  const targets = new Map<string, MobileGuiDirectTarget>();
  for (const raw of [descriptor.relayUrl, getRuntimeApiBaseUrl(), ...candidates]) {
    const target = raw ? targetOf(raw) : null;
    if (target) targets.set(`${target.hostname}:${target.port}`, target);
  }
  return [...targets.values()];
};

export async function openMobileGuiNetwork(signal: AbortSignal, onFailure: () => void): Promise<MobileGuiNetwork> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('YuriGuiNetwork')) throw new Error('unsupported');
  const previous = previousRelease;
  let unlock!: () => void;
  previousRelease = new Promise<void>(resolve => { unlock = resolve; });
  const scope = crypto.randomUUID();
  const generation = getRuntimeGeneration();
  let listener: PluginListenerHandle | undefined;
  let wireFactory: Awaited<ReturnType<typeof createMobileGuiWireFactory>> | undefined;
  let descriptor: RelayRuntimeDescriptor | null = null;
  let started = false;
  let released = false;
  let releasing: Promise<void> | undefined;
  let channel: Channel | undefined;
  let connecting: Promise<Channel> | undefined;
  let failures = 0;
  let retryAt = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe = () => {};
  let unsubscribeAuth = () => {};
  const streams = new Map<number, Stream>();
  const current = () => !released && !signal.aborted && generation === getRuntimeGeneration();
  const assertCurrent = () => { if (!current()) throw new DOMException('GUI runtime ended', 'AbortError'); };
  const native = (id: number, type: string, data?: string, bytes?: number) => plugin.send({ scope, id, type, data, bytes });
  const send = (message: object) => {
    if (channel?.socket.readyState === 1) channel.socket.send(JSON.stringify(message));
  };
  const scheduleIdle = () => {
    clearTimeout(idle);
    if (channel && !streams.size) idle = setTimeout(() => { if (!streams.size) closeChannel(); }, IDLE_CLOSE_MS);
  };
  const dropStream = (id: number, notifyNative: boolean) => {
    if (!streams.delete(id)) return;
    if (notifyNative) void native(id, 'close').catch(() => {});
    scheduleIdle();
  };
  const closeChannel = () => {
    const closing = channel;
    channel = undefined;
    clearTimeout(idle);
    if (!closing) return;
    clearInterval(closing.heartbeat);
    closing.socket.onclose = null; closing.socket.onerror = null; closing.socket.onmessage = null;
    closing.socket.close();
    closing.tunnel.close();
  };
  // Loss affects only in-flight plugin connections; the next connection reconnects with backoff.
  const lose = (notify = true) => {
    if (!channel) return;
    closeChannel();
    failures++;
    retryAt = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
    for (const id of [...streams.keys()]) dropStream(id, true);
    if (notify && current()) onFailure();
  };
  const deliver = (id: number, type: string, data?: Uint8Array, credit?: number) => {
    const stream = streams.get(id);
    if (!stream) return;
    if (stream.queued + (data?.length ?? 0) > WINDOW) { lose(); return; }
    stream.queued += data?.length ?? 0;
    stream.chain = stream.chain.then(async () => {
      if (!current() || streams.get(id) !== stream) return;
      let encoded: string | undefined;
      if (data) encoded = btoa(String.fromCharCode(...data));
      await native(id, type, encoded, credit);
      if (data) { stream.queued -= data.length; send({ type: 'credit', id, bytes: data.length }); }
      if (type === 'close') dropStream(id, false);
    }).catch(() => {
      send({ type: 'close', id });
      dropStream(id, true);
    });
  };
  const receive = (event: { data: unknown }) => {
    if (!current()) return;
    try {
      if (typeof event.data !== 'string') {
        const data = event.data as ArrayBuffer;
        if (data.byteLength <= 4 || data.byteLength > CHUNK + 4) throw new Error();
        deliver(new DataView(data).getUint32(0), 'data', new Uint8Array(data, 4));
        return;
      }
      const message = JSON.parse(event.data) as { type: string; id: number; bytes?: number };
      if (message.type === 'pong') return;
      if (!Number.isInteger(message.id)) throw new Error();
      if (message.type === 'credit') {
        const stream = streams.get(message.id);
        if (!stream) return;
        if (!Number.isInteger(message.bytes) || message.bytes! <= 0 || stream.credit + message.bytes! > WINDOW) throw new Error();
        stream.credit += message.bytes!;
        deliver(message.id, 'credit', undefined, message.bytes);
      } else if (message.type === 'opened') {
        const stream = streams.get(message.id);
        if (stream) { stream.opened = true; deliver(message.id, 'opened'); }
      } else if (message.type === 'fin' || message.type === 'close') deliver(message.id, message.type);
      else throw new Error();
    } catch { lose(); }
  };
  const dial = async (): Promise<Channel> => {
    const wait = retryAt - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    assertCurrent();
    await refreshRuntimeUrlAuthToken();
    assertCurrent();
    const tunnel = createRelayTunnelClient({ ...descriptor!, createWireSocket: wireFactory!.createWireSocket });
    const socket = tunnel.openWebSocket(wsUrlToTunnelPath(getRuntimeUrlResolver().websocket('/api/gui-network/ws')));
    let hostOrigin: string | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => settle(new Error('relay_unavailable')), READY_TIMEOUT_MS);
        const abort = () => settle(new DOMException('GUI runtime ended', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        function settle(error?: Error) {
          clearTimeout(timeout); signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve();
        }
        socket.onerror = () => settle(new Error('relay_unavailable'));
        socket.onclose = () => settle(new Error('relay_unavailable'));
        socket.onmessage = event => {
          try {
            const message: unknown = typeof event.data === 'string' ? JSON.parse(event.data) : null;
            if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'ready'
              || !('version' in message) || message.version !== 1) throw new Error('unsupported_host');
            if ('httpOrigin' in message) {
              if (typeof message.httpOrigin !== 'string') throw new Error('unsupported_host');
              const origin = new URL(message.httpOrigin);
              if (origin.protocol !== 'http:' || origin.hostname !== 'localhost' || origin.username || origin.password
                || origin.pathname !== '/' || origin.search || origin.hash
                || ![origin.origin, `${origin.origin}/`].includes(message.httpOrigin)) throw new Error('unsupported_host');
              hostOrigin = origin.origin;
            }
            settle();
          } catch { settle(new Error('unsupported_host')); }
        };
      });
      assertCurrent();
    } catch (error) { socket.close(); tunnel.close(); throw error; }
    const opened: Channel = { tunnel, socket, hostOrigin, heartbeat: setInterval(() => send({ type: 'ping' }), 20_000) };
    socket.onclose = () => { if (channel === opened) lose(); };
    socket.onerror = () => { if (channel === opened) lose(); };
    socket.onmessage = receive;
    failures = 0;
    return opened;
  };
  const ensureChannel = (): Promise<Channel> => {
    if (channel) return Promise.resolve(channel);
    if (!connecting) {
      const attempt = dial().then(opened => {
        if (connecting !== attempt || !current()) { opened.socket.close(); opened.tunnel.close(); throw new DOMException('GUI runtime ended', 'AbortError'); }
        channel = opened;
        scheduleIdle();
        return opened;
      }).catch(error => {
        if (connecting === attempt) {
          failures++;
          retryAt = Date.now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1));
          if (current()) onFailure();
        }
        throw error;
      }).finally(() => { if (connecting === attempt) connecting = undefined; });
      connecting = attempt;
    }
    return connecting;
  };
  const accept = (event: NativeEvent) => {
    if (!current()) return;
    const { id, type } = event;
    if (type === 'failed') { lose(); return; }
    if (!Number.isInteger(id) || !id || id < 0 || id > 0xffffffff) return;
    if (type === 'open') {
      if (streams.has(id) || streams.size >= MAX_STREAMS) { void native(id, 'close').catch(() => {}); return; }
      const stream: Stream = { chain: Promise.resolve(), queued: 0, credit: WINDOW, opened: false };
      streams.set(id, stream);
      clearTimeout(idle);
      void ensureChannel().then(() => {
        if (streams.get(id) === stream) send({ type, id, hostname: event.hostname, port: event.port });
      }).catch(() => dropStream(id, true));
      return;
    }
    const stream = streams.get(id);
    if (!stream) return;
    if (type === 'data') {
      const raw = atob(event.data ?? '');
      if (!channel || !stream.opened || !raw.length || raw.length > CHUNK || raw.length > stream.credit) { send({ type: 'close', id }); dropStream(id, true); return; }
      stream.credit -= raw.length;
      const bytes = new Uint8Array(4 + raw.length);
      new DataView(bytes.buffer).setUint32(0, id);
      for (let i = 0; i < raw.length; i++) bytes[i + 4] = raw.charCodeAt(i);
      channel.socket.send(bytes);
    } else if (type === 'fin' || type === 'close') {
      send({ type, id });
      if (type === 'close') dropStream(id, false);
    }
  };
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true;
    unsubscribe(); unsubscribeAuth();
    signal.removeEventListener('abort', aborted);
    connecting = undefined;
    closeChannel();
    streams.clear();
    releasing = (async () => {
      try {
        try { await listener?.remove(); }
        finally { await wireFactory?.dispose(); }
      } finally {
        try { if (started) await plugin.stop({ scope }); }
        finally { unlock(); }
      }
    })();
    return releasing;
  };
  const aborted = () => { void release().catch(() => {}); };
  try {
    await previous;
    assertCurrent();
    if (!(await plugin.capabilities()).supported) throw new Error('unsupported');
    assertCurrent();
    descriptor = getActiveRelayDescriptor();
    let candidates: string[] = [];
    const { loadMobileConnections, isActiveRuntimeConnection } = await import('@/apps/mobileConnections');
    const saved = (await loadMobileConnections()).find(isActiveRuntimeConnection);
    assertCurrent();
    candidates = saved?.candidates.flatMap(candidate => candidate.kind === 'direct' ? [candidate.url] : []) ?? [];
    descriptor ??= saved?.candidates.find(candidate => candidate.kind === 'relay')?.relay ?? null;
    if (!descriptor) throw new Error('relay_required');
    wireFactory = await createMobileGuiWireFactory(plugin, scope);
    listener = await plugin.addListener('stream', event => { if (event.scope === scope) accept(event); });
    assertCurrent();
    started = true;
    await plugin.start({ scope, relayUrl: descriptor.relayUrl, direct: applicationTargets(descriptor, candidates) });
    assertCurrent();
    unsubscribe = subscribeRuntimeEndpointChanged(() => lose());
    unsubscribeAuth = subscribeRuntimeAuthGeneration(() => lose(false));
    signal.addEventListener('abort', aborted, { once: true });
    return {
      async connect(owner) {
        if (owner?.aborted) throw new DOMException('Owner ended', 'AbortError');
        const opened = await ensureChannel();
        return { hostOrigin: opened.hostOrigin };
      },
      release,
    };
  } catch (error) { await release(); throw error; }
}
