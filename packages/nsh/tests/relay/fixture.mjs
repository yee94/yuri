// Test-only Host: real repository handshake/crypto/codec, local fixture HTTP semantics.
import assert from 'node:assert/strict';
import {
  createHostHandshake,
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  MAX_PLAINTEXT_FRAME_BYTES,
  RELAY_PROTOCOL_VERSION,
} from '../../../web/server/lib/relay/e2ee.js';
import {
  decodeTunnelFrame,
  encodeJsonPayload,
  encodeTunnelFrame,
  MAX_TUNNEL_PAYLOAD_BYTES,
  TunnelFrameType as Type,
} from '../../../web/server/lib/relay/tunnel-codec.js';

const keyPair = await generateEcdhKeyPair();
const publicKey = await exportPublicKeyJwk(keyPair.publicKey);
const credential = 'Bearer native-relay-test-only';
const encoder = new TextEncoder();
let connectionID = 0;

function send(ws, type, id, payload = new Uint8Array()) {
  const state = ws.data;
  // AES counters must hit the wire in encrypt order, including fixture responses.
  state.outbound = state.outbound.then(async () => {
    const bytes = await state.crypto.encryptor.encrypt(encodeTunnelFrame(type, id, payload));
    ws.send(bytes);
    return bytes;
  });
  return state.outbound;
}

async function echo(ws, entries) {
  for (const [id] of entries) {
    await send(ws, Type.HttpResponse, id, encodeJsonPayload({ status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  }
  // Deliberately interleave response body chunks across stream IDs.
  const count = Math.max(...entries.map(([, item]) => item.chunks.length));
  for (let chunk = 0; chunk < count; chunk++) {
    for (const [id, item] of entries) {
      if (item.chunks[chunk]) await send(ws, Type.HttpBody, id, item.chunks[chunk]);
    }
  }
  for (const [id] of entries) {
    await send(ws, Type.StreamEnd, id);
    ws.data.streams.delete(id);
  }
}

async function receive(ws, message) {
  const state = ws.data;
  if (typeof message === 'string') {
    assert.equal(JSON.parse(message).batch, false, 'native client must not negotiate batch');
    const action = await state.handshake.handleText(message);
    if (action.type === 'established') {
      assert.equal(action.batch, false);
      state.crypto = action.channel;
      ws.send(action.replyText);
      ws.send(action.replyText); // Duplicate ready is legal after hello retries.
    } else if (action.type === 'send-text') {
      ws.send(action.text);
    } else {
      assert.fail(`unexpected handshake action: ${action.type}`);
    }
    return;
  }
  const plaintext = await state.crypto.decryptor.decrypt(new Uint8Array(message));
  assert.ok(plaintext.length <= MAX_PLAINTEXT_FRAME_BYTES);
  const { frameType: type, streamId: id, payload, hasMoreFragments } = decodeTunnelFrame(plaintext);
  assert.equal(hasMoreFragments, false, 'HTTP body chunks must not use the WS fragment flag');
  assert.ok(payload.length <= MAX_TUNNEL_PAYLOAD_BYTES);
  if (type === Type.Ping) return send(ws, Type.Pong, id);
  if (type === Type.StreamAbort) {
    assert.equal(typeof JSON.parse(new TextDecoder().decode(payload)).reason, 'string');
    state.aborts++;
    state.streams.delete(id);
    return;
  }
  if (type === Type.HttpRequest) {
    assert.equal(id % 2, 1);
    assert.ok(id > state.lastStreamID, 'request IDs must increase without reuse');
    state.lastStreamID = id;
    const head = JSON.parse(new TextDecoder().decode(payload));
    assert.equal(head.acceptEncoding, undefined, 'native client does not negotiate gzip');
    state.streams.set(id, { head, chunks: [], size: 0, ended: false });
    assert.ok(state.streams.size <= 32);
    state.maxActive = Math.max(state.maxActive, state.streams.size);
    return;
  }
  const item = state.streams.get(id);
  assert.ok(item, 'body/end must follow a request head');
  assert.equal(item.ended, false, 'request must end exactly once');
  if (type === Type.HttpBody) {
    item.size += payload.length;
    assert.ok(item.size <= 1024 * 1024, 'fixture input budget exceeded');
    item.chunks.push(new Uint8Array(payload));
    state.bodyFrames++;
    return;
  }
  assert.equal(type, Type.StreamEnd);
  assert.equal(payload.length, 0);
  item.ended = true;
  if (item.head.headers.Authorization !== credential) {
    await send(ws, Type.HttpResponse, id, encodeJsonPayload({ status: 401, headers: {} }));
    await send(ws, Type.StreamEnd, id);
    state.streams.delete(id);
    return;
  }
  const route = item.head.path;
  if (route === '/api/stats') {
    await send(ws, Type.HttpResponse, id, encodeJsonPayload({ status: 200, headers: {} }));
    await send(ws, Type.HttpBody, id, encodeJsonPayload({
      connectionID: state.connectionID, aborts: state.aborts,
      maxActive: state.maxActive, bodyFrames: state.bodyFrames,
      liveStreams: [...state.streams.values()].filter(value => value.head.path === '/api/live').length,
    }));
    await send(ws, Type.StreamEnd, id);
    state.streams.delete(id);
    return;
  }
  if (route === '/api/echo') {
    assert.equal(item.head.method, 'POST');
    const query = new URLSearchParams(item.head.query);
    assert.equal(query.get('q'), 'a/b', 'encoded query must survive transport');
    if (query.get('group') === 'parallel') {
      const entries = [...state.streams].filter(([, value]) => value.head.path === '/api/echo' && value.ended);
      // A barrier proves all eight streams share this socket and coexist before responses.
      if (entries.length === 8) await echo(ws, entries);
    } else {
      await echo(ws, [[id, item]]);
    }
    return;
  }
  if (route === '/api/sse' || route === '/api/live') {
    await send(ws, Type.HttpResponse, id, encodeJsonPayload({ status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const event = encoder.encode('data: 你好\n\ndata: second\n\n');
    // Byte 7 splits inside the first UTF-8 Chinese character, never at a line boundary.
    await send(ws, Type.HttpBody, id, event.subarray(0, 7));
    await send(ws, Type.HttpBody, id, event.subarray(7));
    if (route === '/api/sse') {
      await send(ws, Type.StreamEnd, id);
      state.streams.delete(id);
    }
    return;
  }
  if (route === '/api/tamper' || route === '/api/replay') {
    const previous = await send(ws, Type.HttpResponse, id, encodeJsonPayload({ status: 200, headers: {} }));
    if (route === '/api/replay') {
      ws.send(previous);
    } else {
      // Fresh counter: rejection must exercise GCM authentication, not replay detection.
      state.outbound = state.outbound.then(async () => {
        const changed = await state.crypto.encryptor.encrypt(encodeTunnelFrame(Type.HttpBody, id, encoder.encode('tamper')));
        changed[changed.length - 1] ^= 1;
        ws.send(changed);
      });
      await state.outbound;
    }
    return;
  }
  assert.fail(`unexpected fixture path: ${route}`);
}

const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === '/config') {
      return Response.json({ relayUrl: `ws://127.0.0.1:${server.port}/ws`, serverId: 'native-fixture', hostEncPubJwk: publicKey });
    }
    if (url.pathname !== '/ws' || url.searchParams.get('v') !== String(RELAY_PROTOCOL_VERSION)
        || url.searchParams.get('role') !== 'client' || url.searchParams.get('serverId') !== 'native-fixture'
        || [...url.searchParams.keys()].length !== 3 || request.headers.has('authorization')) {
      return new Response('invalid public routing metadata', { status: 400 });
    }
    if (server.upgrade(request, { data: {
      connectionID: ++connectionID, handshake: createHostHandshake(keyPair.privateKey),
      inbound: Promise.resolve(), outbound: Promise.resolve(), streams: new Map(),
      aborts: 0, maxActive: 0, bodyFrames: 0, lastStreamID: 0,
    } })) return;
    return new Response('upgrade required', { status: 400 });
  },
  websocket: {
    message(ws, message) {
      ws.data.inbound = ws.data.inbound.then(() => receive(ws, message)).catch(error => {
        console.error(error.stack ?? String(error));
        ws.close(1011);
      });
    },
  },
});
console.log(JSON.stringify({ configURL: `http://127.0.0.1:${server.port}/config` }));
