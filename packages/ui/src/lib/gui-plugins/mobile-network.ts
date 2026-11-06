import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { getActiveRelayDescriptor } from '@/lib/relay/runtime-tunnel';
import { createRelayTunnelClient, type RelayTunnelClient, type RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { wsUrlToTunnelPath } from '@/lib/relay/tunnel-payloads';
import { getRuntimeGeneration, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { refreshRuntimeUrlAuthToken, subscribeRuntimeAuthGeneration } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { createMobileGuiWireFactory } from './mobile-network-wire';
import { mobileGuiNetworkBridge as plugin, type MobileGuiNetworkEvent as NativeEvent } from './mobile-network-bridge';
const CHUNK = 16 * 1024;
const WINDOW = 128 * 1024;
// The platform proxy is process/data-store scoped. Serialize leases and restoration,
// including StrictMode replay, before allowing another plugin host to execute.
let previousRelease: Promise<void> = Promise.resolve();

export async function openMobileGuiNetwork(signal: AbortSignal, onFailure: () => void): Promise<{ hostOrigin?: string; release(): Promise<void> }> {
  if (!Capacitor.isNativePlatform() || !Capacitor.isPluginAvailable('YuriGuiNetwork')) throw new Error('unsupported');
  const previous = previousRelease;
  let unlock!: () => void;
  previousRelease = new Promise<void>(resolve => { unlock = resolve; });
  const scope = crypto.randomUUID();
  const generation = getRuntimeGeneration();
  let socket: RelayTunnelWebSocket | undefined;
  let ownedTunnel: RelayTunnelClient | undefined;
  let listener: PluginListenerHandle | undefined;
  let wireFactory: Awaited<ReturnType<typeof createMobileGuiWireFactory>> | undefined;
  let started = false;
  let released = false;
  let releasing: Promise<void> | undefined;
  let failed = false;
  let hostOrigin: string | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let unsubscribe = () => {};
  let unsubscribeAuth = () => {};
  const streams = new Map<number, { chain: Promise<void>; queued: number; credit: number }>();
  const pendingNative: NativeEvent[] = [];
  let acceptNative = (event: NativeEvent) => {
    if (pendingNative.length >= 64) fail();
    else pendingNative.push(event);
  };
  const current = () => !released && !signal.aborted && generation === getRuntimeGeneration();
  const assertCurrent = () => { if (!current()) throw new DOMException('GUI runtime ended', 'AbortError'); };
  const send = (message: object) => { if (current() && !failed && socket?.readyState === 1) socket.send(JSON.stringify(message)); };
  const fail = () => {
    if (failed || released) return;
    failed = true;
    clearInterval(heartbeat);
    socket?.close();
    ownedTunnel?.close();
    for (const id of streams.keys()) void plugin.send({ scope, id, type: 'close' }).catch(() => {});
    streams.clear();
    // Keep the native proxy installed until React has removed plugin DOM. A dead
    // listener/relay must not switch a still-live iframe back to phone networking.
    onFailure();
  };
  const release = (): Promise<void> => {
    if (releasing) return releasing;
    released = true;
    unsubscribe(); unsubscribeAuth();
    signal.removeEventListener('abort', aborted);
    clearInterval(heartbeat);
    socket?.close(); ownedTunnel?.close();
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
    let descriptor = getActiveRelayDescriptor();
    if (!descriptor) {
      const { loadMobileConnections, isActiveRuntimeConnection } = await import('@/apps/mobileConnections');
      const saved = (await loadMobileConnections()).find(isActiveRuntimeConnection);
      descriptor = saved?.candidates.find(candidate => candidate.kind === 'relay')?.relay ?? null;
      assertCurrent();
      if (!descriptor) throw new Error('relay_required');
    }
    await refreshRuntimeUrlAuthToken();
    assertCurrent();
    const socketPath = wsUrlToTunnelPath(getRuntimeUrlResolver().websocket('/api/gui-network/ws'));
    wireFactory = await createMobileGuiWireFactory(plugin, scope);
    listener = await plugin.addListener('stream', event => {
      if (event.scope === scope && current() && !failed) acceptNative(event);
    });
    assertCurrent();
    started = true;
    await plugin.start({ scope, relayUrl: descriptor.relayUrl });
    assertCurrent();
    ownedTunnel = createRelayTunnelClient({ ...descriptor, createWireSocket: wireFactory.createWireSocket });
    socket = ownedTunnel.openWebSocket(socketPath);
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => settle(new Error('relay_unavailable')), 20_000);
      const abort = () => settle(new DOMException('GUI runtime ended', 'AbortError'));
      signal.addEventListener('abort', abort, { once: true });
      const settle = (error?: Error) => {
        clearTimeout(timeout); signal.removeEventListener('abort', abort);
        if (error) reject(error); else resolve();
      };
      socket!.onerror = () => settle(new Error('relay_unavailable'));
      socket!.onclose = () => settle(new Error('relay_unavailable'));
      socket!.onmessage = event => {
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
    socket.onclose = fail;
    socket.onerror = fail;
    const deliver = (id: number, type: string, data?: Uint8Array, credit?: number) => {
      const stream = streams.get(id);
      if (!stream || failed) return;
      if (stream.queued + (data?.length ?? 0) > WINDOW) { fail(); return; }
      stream.queued += data?.length ?? 0;
      stream.chain = stream.chain.then(async () => {
        if (!current() || failed || streams.get(id) !== stream) return;
        let encoded: string | undefined;
        if (data) encoded = btoa(String.fromCharCode(...data));
        await plugin.send({ scope, id, type, data: encoded, bytes: credit });
        if (data) { stream.queued -= data.length; send({ type: 'credit', id, bytes: data.length }); }
        if (type === 'close') streams.delete(id);
      }).catch(() => {
        streams.delete(id);
        send({ type: 'close', id });
        void plugin.send({ scope, id, type: 'close' }).catch(() => {});
      });
    };
    socket.onmessage = event => {
      if (!current() || failed) return;
      try {
        if (typeof event.data !== 'string') {
          if (event.data.byteLength <= 4 || event.data.byteLength > CHUNK + 4) throw new Error();
          deliver(new DataView(event.data).getUint32(0), 'data', new Uint8Array(event.data, 4));
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
        } else if (['opened', 'fin', 'close'].includes(message.type)) deliver(message.id, message.type);
        else throw new Error();
      } catch { fail(); }
    };
    acceptNative = event => {
      try {
        const { id, type } = event;
        if (type === 'failed') { fail(); return; }
        if (!Number.isInteger(id) || !id || id < 0 || id > 0xffffffff) throw new Error();
        if (type === 'open') {
          if (streams.has(id) || streams.size >= 32) throw new Error();
          streams.set(id, { chain: Promise.resolve(), queued: 0, credit: WINDOW });
          send({ type, id, hostname: event.hostname, port: event.port });
        } else if (type === 'data') {
          const stream = streams.get(id);
          if (!stream) return;
          const raw = atob(event.data ?? '');
          if (!raw.length || raw.length > CHUNK || raw.length > stream.credit) throw new Error();
          stream.credit -= raw.length;
          const bytes = new Uint8Array(4 + raw.length);
          new DataView(bytes.buffer).setUint32(0, id);
          for (let i = 0; i < raw.length; i++) bytes[i + 4] = raw.charCodeAt(i);
          socket!.send(bytes);
        } else if (type === 'fin' || type === 'close') {
          send({ type, id });
          if (type === 'close') streams.delete(id);
        } else throw new Error();
      } catch { fail(); }
    };
    for (const event of pendingNative.splice(0)) acceptNative(event);
    assertCurrent();
    if (failed) throw new Error('relay_unavailable');
    heartbeat = setInterval(() => send({ type: 'ping' }), 20_000);
    unsubscribe = subscribeRuntimeEndpointChanged(fail);
    unsubscribeAuth = subscribeRuntimeAuthGeneration(fail);
    signal.addEventListener('abort', aborted, { once: true });
    return { hostOrigin, release };
  } catch (error) { await release(); throw error; }
}
