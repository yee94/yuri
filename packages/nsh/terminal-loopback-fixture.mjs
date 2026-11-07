// Loopback synthetic HTTP/WS plus the REAL production Host mux/E2EE. No PTY,
// terminal runtime, shell, real credential, Keychain or external network exists.
import assert from 'node:assert/strict';
import { createHostHandshake, exportPublicKeyJwk, generateEcdhKeyPair } from '../web/server/lib/relay/e2ee.js';
import { createTunnelHost } from '../web/server/lib/relay/tunnel-host.js';
const keys = await generateEcdhKeyPair(), publicKey = await exportPublicKeyJwk(keys.publicKey);
let redirects = 0, directWS = 0, relayWS = 0;
let globalRequests = 0;
const globals = new Map();
const server = Bun.serve({ hostname: '127.0.0.1', port: 0,
  async fetch(request, server) {
    const url = new URL(request.url), origin = `http://127.0.0.1:${server.port}`;
    if (url.pathname === '/config') return Response.json({ origin, relayUrl: `ws://127.0.0.1:${server.port}/relay/${url.searchParams.get('scenario') || 'normal'}`, serverId: 'terminal-fixture', hostEncPubJwk: publicKey, redirects, directWS, relayWS, globalRequests });
    if (url.pathname.startsWith('/relay/')) {
      assert.equal(request.headers.get('authorization'), null);
      if (server.upgrade(request, { data: { kind: 'relay', scenario: url.pathname.split('/').at(-1), handshake: createHostHandshake(keys.privateKey), inbound: Promise.resolve(), outbound: Promise.resolve() } })) return;
      return new Response(null, { status: 400 });
    }
    if (url.pathname === '/redirect-target') { redirects++; return Response.json({ forbidden: true }); }
    const bearer = request.headers.get('authorization');
    const scenario = bearer?.split(':').at(-1) || 'normal';
    if (['/api/terminal/ws', '/api/dictation/ws', '/api/remote-desktop/ws'].includes(url.pathname)) {
      assert.equal(request.headers.get('origin'), origin);
      const scoped = url.searchParams.get('yuri_url_token');
      assert.ok(bearer?.startsWith('Bearer loopback-terminal:') || scoped?.startsWith('loopback-scoped:'));
      if (scoped) assert.ok(request.headers.has('x-yuri-relay-connection'));
      const wsScenario = scoped?.split(':').at(-1) || scenario;
      if (wsScenario === 'auth-denied') return new Response(null, { status: 403 });
      if (wsScenario === 'fallback') return new Response(null, { status: 501 });
      if (wsScenario === 'ws-redirect') return new Response(null, { status: 302, headers: { Location: origin + '/redirect-target' } });
      if (scoped) relayWS++; else directWS++;
      if (server.upgrade(request, { data: { kind: url.pathname === '/api/terminal/ws' ? 'terminal' : 'legacy' } })) return;
      return new Response(null, { status: 400 });
    }
    assert.ok(bearer?.startsWith('Bearer loopback-terminal:'));
    if (url.pathname === '/api/terminal/create') return Response.json({ sessionId: 'pty', capabilities: { stream: { preferred: scenario === 'explicit-sse' ? 'sse' : 'ws', transports: scenario === 'explicit-sse' ? ['sse'] : ['ws'], ws: { path: '/api/terminal/ws', v: 2 } }, input: { preferred: 'http', transports: ['http'] } } });
    if (url.pathname === '/auth/url-token') return Response.json({ token: `loopback-scoped:${scenario}`, expiresAt: Date.now() + 60000 }, { status: scenario === 'mint-denied' ? 403 : 200 });
    if (url.pathname === '/api/terminal/redirect') return new Response(null, { status: 302, headers: { Location: origin + '/redirect-target' } });
    if (url.pathname === '/api/terminal/overflow') return new Response(' '.repeat(65537), { headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/api/terminal/missing/stream') return Response.json({ error: 'missing' }, { status: 404 });
    if (url.pathname === '/api/terminal/pty/stream') {
      let heartbeat;
      return new Response(new ReadableStream({ start(controller) {
        const bytes = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"type":"connected"}\r\n\r\ndata: {"type":"data","data":"中文😀"}\r\n\r\n');
        // Real UTF-8 and SSE framing can split at every byte, including CRLF.
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        heartbeat = setInterval(() => controller.enqueue(new TextEncoder().encode(': keepalive\n\n')), 1000);
      }, cancel() { clearInterval(heartbeat); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    if (url.pathname === '/api/terminal/pty/input') { assert.equal(request.headers.get('content-type'), 'text/plain'); assert.deepEqual(Buffer.from(await request.arrayBuffer()), Buffer.from('中文\0\r\n')); return Response.json({ success: true }); }
    if (url.pathname === '/api/fs/read') { assert.equal(url.searchParams.get('directory'), '/tree 中文'); return new Response('', { headers: { 'Content-Type': 'text/plain', 'X-Yuri-File-Exists': url.searchParams.get('path').endsWith('index.html') ? 'false' : 'true' } }); }
    if (url.pathname === '/api/system/free-port') {
      for (const controller of globals.values()) controller.enqueue(new TextEncoder().encode('data: native-tick\n\n'));
      return Response.json({ port: 8123, redirects });
    }
    if (url.pathname === '/api/yuri/events') {
      const id = ++globalRequests; let timer;
      return new Response(new ReadableStream({ start(controller) {
        globals.set(id, controller); controller.enqueue(new TextEncoder().encode(`data: native-global-${id}\n\n`));
        timer = setInterval(() => controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')), 1000);
      }, cancel() { clearInterval(timer); globals.delete(id); } }), { headers: { 'Content-Type': 'text/event-stream' } });
    }
    return Response.json({ success: true });
  },
  websocket: {
    open(ws) { if (ws.data.kind === 'terminal') { ws.send('connected'); ws.sendBinary(Buffer.alloc(1_048_576, 42)); } else if (ws.data.kind === 'legacy') ws.send('ready'); },
    message(ws, message) {
      const state = ws.data;
      if (state.kind === 'legacy') { assert.equal(typeof message, 'string'); ws.send(message); return; }
      if (state.kind === 'terminal') { if (typeof message === 'string') ws.send(message); else ws.sendBinary(message); return; }
      state.inbound = state.inbound.then(async () => {
        if (typeof message === 'string') {
          const action = await state.handshake.handleText(message); if (action.type !== 'established') return;
          state.channel = action.channel;
          state.host = createTunnelHost({ connectionId: 'terminal-fixture', getLocalPort: () => server.port, getBufferedAmount: () => 0,
            authorizeRequest: async req => {
              if (req.headers.upgrade === 'websocket') return state.scenario !== 'auth-denied' && new URL(req.url, `http://127.0.0.1:${server.port}`).searchParams.get('yuri_url_token') === `loopback-scoped:${state.scenario}`;
              return (req.headers.Authorization ?? req.headers.authorization) === `Bearer loopback-terminal:${state.scenario}`;
            }, sendFrame: frame => { state.outbound = state.outbound.then(async () => ws.send(await state.channel.encryptor.encrypt(frame))); return state.outbound; } });
          ws.send(action.replyText); return;
        }
        await state.host.handleFrame(await state.channel.decryptor.decrypt(message));
      }).catch(error => { console.error(error.stack); ws.close(1011); });
    }, close(ws) { ws.data.host?.close(); },
  },
});
console.log(JSON.stringify({ configURL: `http://127.0.0.1:${server.port}/config` }));
