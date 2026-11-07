// Loopback only: synthetic bytes, ephemeral E2EE keys, production Host mux/codec.
import assert from 'node:assert/strict';
import { createHostHandshake, exportPublicKeyJwk, generateEcdhKeyPair } from '../../../web/server/lib/relay/e2ee.js';
import { createTunnelHost } from '../../../web/server/lib/relay/tunnel-host.js';
import { decodeTunnelFrame, encodeJsonPayload, encodeTunnelFrame } from '../../../web/server/lib/relay/tunnel-codec.js';

const keys = await generateEcdhKeyPair();
const publicKey = await exportPublicKeyJwk(keys.publicKey);
let relayConnections = 0;
let urlMints = 0;
const binary = Buffer.from(Array.from({ length: 300_000 }, (_, index) => index % 251));
const statuses = { unauthorized: 401, disabled: 403, unsupported: 501, occupied: 409, redirect: 302 };
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request, server) {
    const url = new URL(request.url);
    const origin = `http://127.0.0.1:${server.port}`;
    if (url.pathname === '/config') {
      const scenario = url.searchParams.get('scenario');
      return Response.json({ origin, relayUrl: `ws://127.0.0.1:${server.port}/relay/${scenario}`, serverId: 'desktop-fixture', hostEncPubJwk: publicKey });
    }
    if (url.pathname.startsWith('/relay/')) {
      assert.deepEqual([...url.searchParams.keys()], ['v', 'role', 'serverId']);
      assert.equal(request.headers.get('authorization'), null);
      assert.equal(url.searchParams.get('serverId'), 'desktop-fixture');
      const scenario = url.pathname.split('/').at(-1);
      if (scenario === 'carrier-redirect') return new Response(null, { status: 302, headers: { Location: `${origin}/redirect-target` } });
      relayConnections++;
      if (server.upgrade(request, { data: { kind: 'relay', scenario, handshake: createHostHandshake(keys.privateKey), inbound: Promise.resolve(), outbound: Promise.resolve() } })) return;
      return new Response(null, { status: 400 });
    }
    if (url.pathname === '/redirect-target') { throw new Error('credential-bearing redirect followed'); }
    const bearer = request.headers.get('authorization');
    const scenario = bearer?.startsWith('Bearer fixture-only:') ? bearer.split(':').at(-1) : undefined;
    if (url.pathname === '/api/remote-desktop/ws' || url.pathname === '/api/dictation/ws') {
      const scoped = url.searchParams.get('yuri_url_token');
      const mode = scoped ? 'relay' : 'direct';
      const wsScenario = scoped?.startsWith('fixture-url-') ? scoped.slice('fixture-url-'.length) : scenario;
      assert.ok(wsScenario, 'missing socket credential');
      assert.equal(request.headers.get('origin'), origin, 'real origin gate');
      if (mode === 'relay') { assert.equal(bearer, null); assert.ok(request.headers.has('x-yuri-relay-connection')); }
      else { assert.ok(bearer?.startsWith('Bearer fixture-only:direct:')); assert.equal(url.search, ''); }
      if (statuses[wsScenario]) return new Response(null, { status: statuses[wsScenario], headers: { Location: `${origin}/redirect-target` } });
      if (wsScenario === 'voice-denied') return new Response(null, { status: 403 });
      if (wsScenario === 'cancel-upgrade' || wsScenario === 'upgrade-timeout') { await new Promise(resolve => setTimeout(resolve, 600)); }
      if (server.upgrade(request, { data: { kind: 'desktop', scenario: wsScenario } })) return;
      return new Response(null, { status: 400 });
    }
    assert.ok(scenario, 'all HTTP must authenticate');
    if (url.pathname === '/api/voice/settings') {
      assert.equal(request.method, 'GET');
      return Response.json({ sttProvider: 'local', sttLocalModel: 'synthetic-only' });
    }
    if (url.pathname === '/api/stt/transcribe') {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers.get('content-type'), 'audio/wav');
      assert.deepEqual(new Uint8Array(await request.arrayBuffer()), new Uint8Array([82, 73, 70, 70]));
      return Response.json({ transcript: 'synthetic transport only' });
    }
    if (url.pathname === '/auth/url-token') {
      assert.equal(request.method, 'POST'); urlMints++;
      if (scenario === 'cancel-mint' || scenario === 'switch-mint') await new Promise(resolve => setTimeout(resolve, 600));
      if (scenario === 'mint-denied') return Response.json({ error: 'unauthorized' }, { status: 403 });
      return Response.json({ token: scenario === 'bearer-url' ? bearer.slice(7) : scenario === 'bad-mint' ? 'invalid\r\nheader' : `fixture-url-${scenario}`, expiresAt: Date.now() + (scenario === 'expired-url' ? -60_000 : 60_000) });
    }
    if (url.pathname === '/api/remote-desktop') {
      assert.equal(request.method, 'GET');
      if (scenario === 'stale') await new Promise(resolve => setTimeout(resolve, 150));
      return Response.json({ supported: true, enabled: true, relayConnections, urlMints });
    }
    return new Response(null, { status: 404 });
  },
  websocket: {
    open(ws) {
      if (ws.data.kind !== 'desktop') return;
      ws.send('ready');
      if (ws.data.scenario === 'messages') ws.sendBinary(binary);
    },
    message(ws, message) {
      const state = ws.data;
      if (state.kind === 'desktop') {
        const text = String(message);
        if (text === 'revoke') { ws.close(4001, ''); return; }
        if (text === 'oversize') { ws.sendBinary(Buffer.alloc(512 * 1024 + 1)); return; }
        if (text === 'flood') { for (let index = 0; index < 10; index++) ws.send('queued'); return; }
        if (text === 'done') { ws.close(1000, ''); return; }
        ws.send(text); return;
      }
      state.inbound = state.inbound.then(async () => {
        if (typeof message === 'string') {
          const action = await state.handshake.handleText(message);
          if (action.type !== 'established') return;
          assert.equal(action.batch, false);
          state.channel = action.channel;
          state.host = createTunnelHost({
            connectionId: 'native-fixture', getLocalPort: () => server.port, getBufferedAmount: () => 0,
            authorizeRequest: async req => {
              const uri = new URL(req.url, originFor(server.port));
              if (req.headers.upgrade === 'websocket') return ['/api/remote-desktop/ws', '/api/dictation/ws'].includes(uri.pathname) && uri.searchParams.get('yuri_url_token') === `fixture-url-${state.scenario}` && state.scenario !== 'unpaired';
              return req.headers.Authorization === `Bearer fixture-only:relay:${state.scenario}` || req.headers.authorization === `Bearer fixture-only:relay:${state.scenario}`;
            },
            sendFrame: frame => {
              const decoded = decodeTunnelFrame(frame);
              if (decoded.frameType === 7) {
                const malformed = {
                  'bad-open': [7, encodeJsonPayload({ protocol: 1 })],
                  'bad-close': [10, encodeJsonPayload({ status: 401, reason: '' })],
                  'bad-abort': [5, encodeJsonPayload({ status: 401 })],
                  'bad-text': [8, new Uint8Array([255])],
                  'control-fragment': [7 | 128, encodeJsonPayload({})],
                }[state.scenario];
                if (malformed) frame = encodeTunnelFrame(malformed[0], decoded.streamId, malformed[1]);
              }
              state.outbound = state.outbound.then(async () => ws.send(await state.channel.encryptor.encrypt(frame)));
              return state.outbound;
            },
          });
          ws.send(action.replyText); return;
        }
        await state.host.handleFrame(await state.channel.decryptor.decrypt(message));
      }).catch(error => { console.error(error.stack ?? error); ws.close(1011); });
    },
    close(ws) { ws.data.host?.close(); },
  },
});
function originFor(port) { return `http://127.0.0.1:${port}`; }
console.log(JSON.stringify({ configURL: `${originFor(server.port)}/config` }));
