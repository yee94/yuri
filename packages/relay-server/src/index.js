import http from 'node:http';
import { isIP } from 'node:net';
import { WebSocketServer } from 'ws';
import { createRelayCore } from './core.js';

export const resolveRelayClientIp = (request, trustProxy = false) => {
  const remoteAddress = request.socket.remoteAddress ?? 'unknown';
  if (!trustProxy) return remoteAddress;
  const forwarded = request.headers['x-forwarded-for'];
  const candidate = typeof forwarded === 'string' && !forwarded.includes(',') ? forwarded.trim() : '';
  return isIP(candidate) ? candidate : remoteAddress;
};

export const formatRelayWsUrl = (host, port, relayPath) => `ws://${isIP(host) === 6 ? `[${host}]` : host}:${port}${relayPath}`;

/**
 * Creates the Layer 1 self-hosted relay. It routes opaque Layer 2/3 frames.
 * @param {import('./index.js').Options} options
 */
export const createPrivateRelayServer = (options = {}) => {
  const clock = { now: Date.now, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, ...options.clock };
  const core = createRelayCore({ ...options, clock });
  const { limits } = core;
  const rawSockets = new Set(); const rawIpCounts = new Map();
  const resolveClientIp = options.resolveClientIp ?? ((request) => resolveRelayClientIp(request, options.trustProxy));
  const relayPath = options.path ?? '/ws';
  let server = null; let wss = null; let heartbeat = null; let startPromise = null; let stopPromise = null; let abortStart = null; let state = 'idle'; let generation = 0;
  const start = () => {
    if (state === 'running') return Promise.resolve(); if (state === 'stopping') return stopPromise.then(() => start()); if (startPromise) return startPromise;
    state = 'starting'; const localGeneration = ++generation; const localServer = http.createServer((request, response) => {
      if (options.requestHandler?.(request, response) || response.writableEnded) return;
      const pathname = new URL(request.url ?? '/', 'http://relay').pathname;
      const ready = pathname === '/readyz' && state === 'running';
      const healthy = pathname === '/healthz';
      response.setHeader('cache-control', 'no-store');
      if ((healthy || ready) && (request.method === 'GET' || request.method === 'HEAD')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(request.method === 'HEAD' ? undefined : '{"status":"ok"}');
        return;
      }
      response.writeHead(404); response.end();
    }); const localWss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: limits.maxFrameBytes }); server = localServer; wss = localWss;
    localServer.on('connection', (socket) => {
      const ip = socket.remoteAddress ?? 'unknown';
      if (rawSockets.size >= limits.maxRawSockets || (rawIpCounts.get(ip) ?? 0) >= limits.maxRawSocketsPerIp) { core.recordLimit(); socket.destroy(); return; }
      rawSockets.add(socket); rawIpCounts.set(ip, (rawIpCounts.get(ip) ?? 0) + 1);
      socket._relayTcpTimer = clock.setTimeout(() => socket.destroy(), limits.handshakeMs);
      socket.on('close', () => {
        if (socket._relayTcpTimer) clock.clearTimeout(socket._relayTcpTimer);
        if (rawSockets.delete(socket)) {
          const remaining = (rawIpCounts.get(ip) ?? 0) - 1;
          if (remaining > 0) rawIpCounts.set(ip, remaining); else rawIpCounts.delete(ip);
        }
      });
    });
    localServer.on('upgrade', (request, socket, head) => {
      if (socket._relayTcpTimer) { clock.clearTimeout(socket._relayTcpTimer); socket._relayTcpTimer = null; }
      const ip = resolveClientIp(request);
      const admission = core.admitConnection(request.url, ip);
      localWss.handleUpgrade(request, socket, head, (ws) => {
        if (admission.code) return core.reject(ws, admission.code);
        core.accept(ws, admission.parsed, ip);
      });
    });
    heartbeat = clock.setInterval(core.heartbeat, limits.heartbeatMs);
    startPromise = new Promise((resolve, rejectStart) => {
      const fail = (error) => { if (localGeneration !== generation) return; localServer.off('listening', ready); cleanupStart(); rejectStart(error); };
      const ready = () => { localServer.off('error', fail); if (localGeneration !== generation || state !== 'starting') return; state = 'running'; resolve(); };
      const cleanupStart = () => { if (heartbeat) { clock.clearInterval(heartbeat); heartbeat = null; } localWss.close(); localServer.close(); if (server === localServer) { server = null; wss = null; } state = 'stopped'; };
      abortStart = () => { if (state === 'starting') { cleanupStart(); rejectStart(new Error('relay stopped during start')); } };
      localServer.once('error', fail); localServer.once('listening', ready); localServer.listen(options.port ?? 0, options.host ?? '127.0.0.1');
    }).finally(() => { startPromise = null; abortStart = null; });
    return startPromise;
  };
  const stop = () => {
    if (stopPromise) return stopPromise;
    if (state === 'idle' || state === 'stopped') { state = 'stopped'; return Promise.resolve(); }
    if (state === 'starting') abortStart?.();
    state = 'stopping'; generation += 1; const localServer = server; const localWss = wss;
    stopPromise = new Promise((resolve) => {
      if (heartbeat) { clock.clearInterval(heartbeat); heartbeat = null; }
      core.dispose();
      for (const socket of rawSockets) socket.destroy(); rawSockets.clear(); rawIpCounts.clear();
      if (!localServer) return resolve(); localWss?.close(); localServer.close(() => resolve()); clock.setTimeout(resolve, 100);
    }).then(() => { if (server === localServer && wss === localWss) { server = null; wss = null; state = 'stopped'; } stopPromise = null; });
    return stopPromise;
  };
  return { start, stop, address: () => server?.address(), get wsUrl() { const address = server?.address(); return address && typeof address === 'object' ? formatRelayWsUrl(options.host ?? '127.0.0.1', address.port, relayPath) : null; }, getSnapshot: () => ({ state, ...core.getSnapshot(), rawSockets: rawSockets.size }) };
};

export const startPrivateRelayServer = async (options) => { const relay = createPrivateRelayServer(options); await relay.start(); return relay; };
