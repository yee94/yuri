import net from 'node:net';
import { WebSocketServer } from 'ws';

const PATH = '/api/gui-network/ws';
const CHUNK = 16 * 1024;
const WINDOW = 128 * 1024;
const MAX_STREAMS = 32;

// One authenticated socket owns the whole proxy lifetime. Website bytes are opaque:
// TLS and website credentials remain browser-owned, never Yuri-authenticated upstream.
export function attachGuiNetwork({ server, uiAuthController, isRequestOriginAllowed, isClientActive = async () => true }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: CHUNK + 4, perMessageDeflate: false });
  const reject = (socket, status) => socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  let stopped = false;
  wss.on('connection', (ws, auth) => {
    const streams = new Map();
    let closed = false;
    let lastSeen = Date.now();
    const send = (value) => {
      if (closed || ws.readyState !== 1) return;
      if (ws.bufferedAmount > MAX_STREAMS * WINDOW) { ws.close(1009, 'backpressure'); return; }
      ws.send(Buffer.isBuffer(value) ? value : JSON.stringify(value));
    };
    const closeStream = (id, notify = true) => {
      const stream = streams.get(id);
      if (!stream) return;
      streams.delete(id);
      clearTimeout(stream.timeout);
      stream.socket.destroy();
      if (notify) send({ type: 'close', id });
    };
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      for (const id of streams.keys()) closeStream(id, false);
    };
    const invalid = () => { ws.close(1008, 'invalid_message'); cleanup(); };
    const pump = (stream) => {
      if (!stream.connected || streams.get(stream.id) !== stream) return;
      while (stream.credit > 0) {
        const available = Math.min(stream.socket.readableLength, CHUNK, stream.credit);
        if (!available) break;
        const bytes = stream.socket.read(available);
        if (!bytes) break;
        stream.credit -= bytes.length;
        const frame = Buffer.allocUnsafe(bytes.length + 4);
        frame.writeUInt32BE(stream.id);
        bytes.copy(frame, 4);
        send(frame);
      }
    };
    ws.on('message', (bytes, binary) => {
      lastSeen = Date.now();
      if (closed) return;
      if (binary) {
        if (bytes.length <= 4 || bytes.length > CHUNK + 4) return invalid();
        const id = bytes.readUInt32BE(0);
        const stream = streams.get(id);
        if (!stream) return;
        const length = bytes.length - 4;
        if (!stream.connected || stream.fin || stream.pending + length > WINDOW) return invalid();
        stream.pending += length;
        stream.socket.write(bytes.subarray(4), () => {
          stream.pending -= length;
          if (streams.get(id) === stream) send({ type: 'credit', id, bytes: length });
        });
        return;
      }
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { return invalid(); }
      if (!message || typeof message !== 'object') return invalid();
      if (message.type === 'ping') { send({ type: 'pong' }); return; }
      const { id } = message;
      if (!Number.isInteger(id) || id <= 0 || id > 0xffffffff) return invalid();
      if (message.type === 'open') {
        const { hostname, port } = message;
        if (streams.has(id) || streams.size >= MAX_STREAMS || typeof hostname !== 'string'
          || !hostname.length || hostname.length > 253 || /[\s/\\@\0]/.test(hostname)
          || !Number.isInteger(port) || port < 1 || port > 65535) return invalid();
        const socket = new net.Socket({ allowHalfOpen: true });
        const stream = { id, socket, connected: false, fin: false, pending: 0, credit: WINDOW,
          timeout: setTimeout(() => closeStream(id), 15_000) };
        streams.set(id, stream);
        socket.setNoDelay(true);
        socket.setTimeout(120_000, () => closeStream(id));
        socket.on('error', () => closeStream(id));
        socket.on('close', () => closeStream(id));
        socket.on('readable', () => pump(stream));
        socket.on('end', () => send({ type: 'fin', id }));
        socket.connect({ host: hostname, port }, () => {
          if (streams.get(id) !== stream) return socket.destroy();
          clearTimeout(stream.timeout);
          stream.connected = true;
          send({ type: 'opened', id, credit: WINDOW });
          pump(stream);
        });
        return;
      }
      const stream = streams.get(id);
      if (!stream) return;
      if (message.type === 'close') { closeStream(id, false); return; }
      if (message.type === 'fin' && !stream.fin) { stream.fin = true; stream.socket.end(); return; }
      if (message.type === 'credit' && Number.isInteger(message.bytes) && message.bytes > 0
        && stream.credit + message.bytes <= WINDOW) {
        stream.credit += message.bytes;
        pump(stream);
        return;
      }
      invalid();
    });
    const timer = setInterval(() => {
      if (Date.now() - lastSeen > 60_000) { ws.terminate(); cleanup(); return; }
      if (auth.type === 'client') void isClientActive(auth.clientId ?? auth.client?.id).then(active => {
        if (!active) { ws.close(4001, 'authentication_required'); cleanup(); }
      }).catch(() => { ws.terminate(); cleanup(); });
    }, 20_000);
    timer.unref?.();
    ws.on('error', cleanup);
    ws.on('close', cleanup);
    const address = server.address();
    send({ type: 'ready', version: 1, chunk: CHUNK, window: WINDOW, streams: MAX_STREAMS,
      ...(address && typeof address === 'object' ? { httpOrigin: `http://localhost:${address.port}` } : {}) });
  });
  const upgrade = (req, socket, head) => {
    let path;
    try { path = new URL(req.url, 'http://localhost').pathname; } catch { return; }
    if (path !== PATH) return;
    void (async () => {
      try {
        const auth = await uiAuthController.resolveAuthContext(req, null, { allowClientAuth: true, allowUrlToken: true });
        if (!auth || (auth.type !== 'client' && !uiAuthController.enabled)) return reject(socket, 401);
        if (!await isRequestOriginAllowed(req)) return reject(socket, 403);
        if (stopped || wss.clients.size >= 8) return reject(socket, 503);
        if (!socket.destroyed) wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, auth));
      } catch { reject(socket, 401); }
    })();
  };
  server.on('upgrade', upgrade);
  return { stop() {
    stopped = true;
    server.off('upgrade', upgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  } };
}
