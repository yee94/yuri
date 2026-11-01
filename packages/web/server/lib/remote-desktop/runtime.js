import { WebSocketServer } from 'ws';
import { parseDesktopMessage } from './protocol.js';

const REMOTE_DESKTOP_WS_PATH = '/api/remote-desktop/ws';

export function attachRemoteDesktop({ app, server, adapter, uiAuthController, isRequestOriginAllowed, isClientActive = async () => true }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 96 * 1024, perMessageDeflate: false });
  let stopping = false;
  let occupied = false;
  const reject = (socket, code) => {
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`, () => socket.destroy());
  };
  app.get('/api/remote-desktop', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ supported: adapter?.supported === true, enabled: adapter?.enabled === true });
  });

  wss.on('connection', (ws, req, auth) => {
    let session;
    let closed = false;
    let zoomQuality = false;
    let lastPing = Date.now();
    let count = 0;
    let windowStart = Date.now();
    const startedAt = Date.now();
    let queued = 0;
    let chain = Promise.resolve();
    const abort = new AbortController();
    const send = (value) => {
      if (closed || ws.readyState !== 1 || ws.bufferedAmount > 512 * 1024) return false;
      if (value?.type === 'ready') zoomQuality = value.zoomQuality === true;
      ws.send(Buffer.isBuffer(value) ? value : JSON.stringify(value));
      return true;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      abort.abort();
      clearInterval(timer);
      // Keep the slot until asynchronous startup/consent has finished cleaning up.
      if (session) { session.close(); occupied = false; }
    };
    const fail = (code) => {
      send({ type: 'error', code });
      ws.close(1011, code);
      close();
    };
    const timer = setInterval(() => {
      if (Date.now() - lastPing > 20000 || Date.now() - startedAt > 60 * 60 * 1000) { ws.terminate(); close(); return; }
      if (auth.type === 'client') void isClientActive(auth.clientId ?? auth.client?.id).then((active) => {
        if (!active) { ws.close(4001, 'authentication_required'); close(); }
      }).catch(() => { ws.terminate(); close(); });
    }, 5000);
    timer.unref?.();
    ws.on('close', close);
    ws.on('error', close);
    ws.on('message', (data, binary) => {
      if (closed) return;
      if (Date.now() - windowStart >= 1000) { count = 0; windowStart = Date.now(); }
      if (binary || ++count > 150 || queued >= 32) { fail('rate_limited'); return; }
      let message;
      try { message = parseDesktopMessage(JSON.parse(data.toString())); }
      catch { fail('invalid_message'); return; }
      if (message.type === 'ping') { lastPing = Date.now(); send({ type: 'pong' }); return; }
      queued++;
      chain = chain.then(async () => {
        await start;
        if (!closed && session && (message.type !== 'view' || zoomQuality)) await session.handle(message);
      }).catch(() => fail('desktop_failed')).finally(() => { queued--; });
    });
    const start = (async () => {
      try {
        session = await adapter.start({ send, onEnded: () => fail('desktop_ended'), signal: abort.signal, zoomQuality: true,
          client: auth.type === 'client' ? { id: auth.clientId ?? auth.client?.id, label: auth.client?.label ?? '' } : null });
        if (closed) { session.close(); occupied = false; }
      } catch (error) {
        occupied = false;
        fail(['disabled', 'permission_required', 'permission_denied', 'unsupported', 'helper_unavailable'].includes(error.code) ? error.code : 'desktop_failed');
      }
    })();
    void start;
  });

  const upgrade = (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { return; }
    if (pathname !== REMOTE_DESKTOP_WS_PATH) return;
    void (async () => {
      try {
        const auth = await uiAuthController.resolveAuthContext(req, null, { allowClientAuth: true, allowUrlToken: true });
        // Password-less owner cookies are not authentication. Relay loopback is not trusted.
        if (!auth || (auth.type !== 'client' && !uiAuthController.enabled)) return reject(socket, 401);
        if (!await isRequestOriginAllowed(req)) return reject(socket, 403);
        if (!adapter?.supported) return reject(socket, 501);
        if (adapter.enabled !== true) return reject(socket, 403);
        if (stopping || occupied) return reject(socket, 409);
        if (socket.destroyed) return;
        occupied = true;
        try { wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, auth)); }
        catch { occupied = false; socket.destroy(); }
      } catch { reject(socket, 401); }
    })();
  };
  server.on('upgrade', upgrade);
  return {
    stop() {
      stopping = true;
      server.off('upgrade', upgrade);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      adapter?.stop?.();
    },
  };
}
