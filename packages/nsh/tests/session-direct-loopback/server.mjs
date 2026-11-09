/** Main-only child process: bound to IPv4 loopback, no external connections. */
export const replayCount = 128;
export function replayFrames(count = replayCount) {
  return [...Array.from({ length: count }, (_, ordinal) => JSON.stringify({ type: 'event', eventId: `loopback-${ordinal}`, directory: '/synthetic', payload: { type: 'fixture.replay', ordinal } })), JSON.stringify({ type: 'ready', scope: 'global' })];
}

export async function serveLoopback(authorization) {
  if (process.env.NSH_SESSION_DIRECT_LOOPBACK !== '1') throw Error('Loopback server requires explicit NSH_SESSION_DIRECT_LOOPBACK=1');
  if (typeof authorization !== 'string' || authorization.length < 32 || /\s/.test(authorization)) throw Error('Invalid synthetic authorization input');
  const sockets = new Map(), records = new Map();
  let targetRequests = 0, targetAuthorization = 0;
  const target = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    targetRequests++; if (request.headers.has('authorization')) targetAuthorization++;
    return new Response('', { status: 403 });
  } });
  let source;
  const authorized = request => request.headers.get('authorization') === `Bearer ${authorization}`;
  const record = (request, name) => {
    const previous = records.get(name) || { requests: 0, authorizationExact: true, originExact: true, frames: 0, closed: 0 };
    previous.requests++; previous.authorizationExact &&= authorized(request); previous.originExact &&= request.headers.get('origin') === source.url.origin;
    records.set(name, previous);
  };
  source = Bun.serve({ hostname: '127.0.0.1', port: 0,
    fetch(request, server) {
      const url = new URL(request.url), name = url.pathname.slice(1);
      if (name === 'audit') {
        if (request.method !== 'GET' || !authorized(request)) return new Response('', { status: 403 });
        return Response.json({ records: Object.fromEntries(records), targetRequests, targetAuthorization });
      }
      if (name === 'control-close') {
        if (request.method !== 'POST' || !authorized(request)) return new Response('', { status: 403 });
        sockets.get('server-close')?.close(1000, 'synthetic close'); return new Response(null, { status: 204 });
      }
      if (name === 'redirect-target') { targetRequests++; if (request.headers.has('authorization')) targetAuthorization++; return new Response('', { status: 403 }); }
      if (!['probe', 'replay', 'local-close', 'receive-cancel', 'server-close', 'open-close', 'open-cancel', 'unauthorized', 'redirect-same', 'redirect-cross'].includes(name) || url.search) return new Response('', { status: 404 });
      record(request, name);
      if (name === 'unauthorized') return new Response('', { status: 401 });
      if (name.startsWith('redirect-')) return new Response('', { status: 302, headers: { location: (name === 'redirect-same' ? source.url.origin : target.url.origin) + '/redirect-target' } });
      if (!authorized(request)) return new Response('', { status: 403 });
      if (name === 'open-close' || name === 'open-cancel') return new Promise(resolve => { request.signal.addEventListener('abort', () => resolve(new Response('', { status: 499 })), { once: true }); });
      if (server.upgrade(request, { data: { name } })) return;
      return new Response('', { status: 400 });
    },
    websocket: {
      open(socket) {
        const name = socket.data.name; sockets.set(name, socket);
        const frames = name === 'replay' ? replayFrames() : [name === 'probe' ? 'loopback-capability' : 'loopback-waiting'];
        for (const frame of frames) { socket.send(frame); records.get(name).frames++; }
      },
      message() {},
      close(socket) { const name = socket.data.name; records.get(name).closed++; if (sockets.get(name) === socket) sockets.delete(name); },
    },
  });
  let stopping = false;
  const stop = () => {
    if (stopping) return; stopping = true;
    for (const socket of sockets.values()) socket.close(1001, 'fixture end');
    source.stop(true); target.stop(true); process.exit(0);
  };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return { origin: source.url.origin, targetOrigin: target.url.origin };
}

if (import.meta.main) {
  if (process.env.NSH_SESSION_DIRECT_LOOPBACK !== '1') throw Error('Loopback server requires explicit NSH_SESSION_DIRECT_LOOPBACK=1');
  const configuration = JSON.parse(await new Response(Bun.stdin.stream()).text());
  const ready = await serveLoopback(configuration.authorization);
  console.log(JSON.stringify({ kind: 'ready', ...ready }));
}
