import { refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import type { RelayTunnelSocketMessageEvent, RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';

type Options = {
  signal: AbortSignal;
  path?: string;
  openSocket(url: string): RelayTunnelWebSocket;
  onMessage(event: RelayTunnelSocketMessageEvent): void;
  onFailure(): void;
};

const hostOriginOf = (data: string | ArrayBuffer): string | undefined => {
  const message: unknown = typeof data === 'string' ? JSON.parse(data) : null;
  if (!message || typeof message !== 'object' || !('type' in message) || message.type !== 'ready'
    || !('version' in message) || message.version !== 1) throw new Error('unsupported_host');
  if (!('httpOrigin' in message)) return;
  if (typeof message.httpOrigin !== 'string') throw new Error('unsupported_host');
  const origin = new URL(message.httpOrigin);
  if (origin.protocol !== 'http:' || origin.hostname !== 'localhost' || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash
    || ![origin.origin, `${origin.origin}/`].includes(message.httpOrigin)) throw new Error('unsupported_host');
  return origin.origin;
};

/** Shared GUI TCP channel for plugin/HTML egress and desktop Browser.
 * Platform adapters own SOCKS and stream credit; this owner handles auth, ready,
 * heartbeat and teardown without changing the chosen direct/Relay transport.
 */
export async function openGuiNetworkChannel({ signal, path = '/api/gui-network/ws', openSocket, onMessage, onFailure }: Options) {
  const cancelled = () => new DOMException('GUI runtime ended', 'AbortError');
  if (signal.aborted) throw cancelled();
  let socket: RelayTunnelWebSocket | undefined;
  let closed = false;
  let ready = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectPending!: (error: Error) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectPending = reject; });
  void cancellation.catch(() => {});
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timeout);
    clearInterval(heartbeat);
    signal.removeEventListener('abort', abort);
    if (socket) {
      socket.onopen = null; socket.onmessage = null; socket.onclose = null; socket.onerror = null;
      socket.close();
    }
    rejectPending(cancelled());
  };
  const abort = () => close();
  const fail = (error = new Error('relay_unavailable')) => {
    if (closed) return;
    rejectPending(error);
    close();
    if (ready) onFailure();
  };
  try {
    timeout = setTimeout(() => fail(), 20_000);
    signal.addEventListener('abort', abort, { once: true });
    await Promise.race([refreshRuntimeUrlAuthToken(), cancellation]);
    if (closed || signal.aborted) throw cancelled();
    const wire = socket = openSocket(getRuntimeUrlResolver().websocket(path));
    wire.binaryType = 'arraybuffer';
    const hostOrigin = await Promise.race([new Promise<string | undefined>((resolve) => {
      wire.onclose = () => fail();
      wire.onerror = () => fail();
      wire.onmessage = event => {
        try {
          const origin = hostOriginOf(event.data);
          ready = true;
          clearTimeout(timeout);
          wire.onmessage = event => {
            if (closed) return;
            const size = typeof event.data === 'string' ? event.data.length * 2 : event.data.byteLength;
            if (size > 16 * 1024 + 4) { fail(new Error('GUI network frame limit')); return; }
            try { onMessage(event); } catch { fail(); }
          };
          heartbeat = setInterval(() => {
            try { wire.send(JSON.stringify({ type: 'ping' })); } catch { fail(); }
          }, 20_000);
          resolve(origin);
        } catch { fail(new Error('unsupported_host')); }
      };
      if (signal.aborted) close();
    }), cancellation]);
    if (closed || signal.aborted) throw cancelled();
    return { socket: wire, hostOrigin, close };
  } catch (error) { close(); throw error; }
}
