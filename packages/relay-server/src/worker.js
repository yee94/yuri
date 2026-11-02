import { createRelayCore, DEFAULT_RELAY_LIMITS } from './core.js';
import { WorkerRelaySocket } from './worker-socket.js';

const response = (status, body = null, headers = {}) => new Response(body, {
  status, headers: { 'cache-control': 'no-store', ...headers },
});

const readOptions = (env) => {
  const path = env.YURI_RELAY_PATH ?? '/ws';
  if (!path.startsWith('/') || /[?#]/.test(path)) throw new Error('Invalid YURI_RELAY_PATH');
  const limits = JSON.parse(env.YURI_RELAY_LIMITS_JSON ?? '{}');
  if (!limits || Array.isArray(limits) || typeof limits !== 'object') throw new Error('Invalid YURI_RELAY_LIMITS_JSON');
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(DEFAULT_RELAY_LIMITS, key) || !Number.isSafeInteger(value) || value < 1) throw new Error('Invalid Relay limit');
  }
  return { path, limits };
};

// One object per deployment preserves the Node server's global admission and
// queue limits. Ordinary accepted sockets deliberately keep routing state alive;
// hibernation requires restoring queues, replay protection and timeout state.
export class YuriRelay {
  constructor(_state, env) {
    this.options = readOptions(env);
    this.core = createRelayCore(this.options);
  }

  fetch(request) {
    const url = new URL(request.url);
    const upgrade = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';
    if (!upgrade) {
      if ((url.pathname === '/healthz' || url.pathname === '/readyz') && (request.method === 'GET' || request.method === 'HEAD')) {
        return response(200, request.method === 'HEAD' ? null : '{"status":"ok"}', { 'content-type': 'application/json' });
      }
      return response(url.pathname === this.options.path ? 426 : 404);
    }
    if (request.method !== 'GET') return response(405);
    // Cloudflare replaces this header at public ingress. Never trust X-Forwarded-For.
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const admission = this.core.admitConnection(url.pathname + url.search, ip);
    const pair = new WebSocketPair();
    const socket = new WorkerRelaySocket(pair[1]);
    pair[1].accept();
    if (admission.code) this.core.reject(socket, admission.code);
    else this.core.accept(socket, admission.parsed, ip);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }
}

export default {
  fetch(request, env) {
    const id = env.YURI_RELAY.idFromName('relay-v1');
    return env.YURI_RELAY.get(id).fetch(request);
  },
};
