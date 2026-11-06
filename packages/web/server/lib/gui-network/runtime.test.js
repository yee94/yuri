import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import * as fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import request from 'supertest';
import { createUiAuth } from '../ui-auth/ui-auth.js';
import { createRemoteClientAuthRuntime } from '../client-auth/remote-clients.js';
import { createRequestSecurityRuntime } from '../security/request-security.js';
import { createTunnelHost } from '../relay/tunnel-host.js';
import { decodeTunnelFrame, encodeJsonPayload, encodeTunnelFrame, TunnelFrameType } from '../relay/tunnel-codec.js';
import { attachGuiNetwork } from './runtime.js';

let root, auth, clients, client, server, port, runtime, token;
const sockets = new Set();
const destinations = new Set();
beforeEach(async () => {
  root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'gui-network-'));
  clients = createRemoteClientAuthRuntime({ fsPromises, path, crypto, storePath: path.join(root, 'clients.json') });
  client = await clients.createClient({ label: 'GUI fixture', clientKind: 'mobile' });
  auth = createUiAuth({ password: null, clientAuthController: clients, readSettingsFromDiskMigrated: async () => ({}) });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const app = express();
  app.post('/auth/url-token', auth.handleUrlAuthToken);
  server = http.createServer(app);
  runtime = attachGuiNetwork({ server, uiAuthController: auth, isRequestOriginAllowed: security.isRequestOriginAllowed });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
  token = (await request(app).post('/auth/url-token').set('Authorization', `Bearer ${client.token}`)).body.token;
});
afterEach(async () => {
  for (const socket of sockets) { if (socket.terminate) socket.terminate(); else socket.destroy(); }
  sockets.clear();
  runtime.stop(); auth.dispose();
  await Promise.all([new Promise(resolve => server.close(resolve)), ...[...destinations].map(target => new Promise(resolve => target.close(resolve)))]);
  destinations.clear();
  await fsPromises.rm(root, { recursive: true, force: true });
});
function connect(query = `?yuri_url_token=${encodeURIComponent(token)}`, origin = `http://127.0.0.1:${port}`) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/gui-network/ws${query}`, { headers: { Origin: origin } });
  ws.on('error', () => {}); sockets.add(ws);
  return ws;
}
async function denied(ws) {
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.on('open', () => reject(new Error('unexpected connection')));
  });
}
async function target(handler) {
  const destination = net.createServer({ allowHalfOpen: true }, socket => { sockets.add(socket); handler(socket); });
  destinations.add(destination);
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  return destination.address().port;
}
const packet = (id, bytes) => {
  const frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32BE(id); bytes.copy(frame, 4); return frame;
};

it('rejects unauthenticated, forged-token and hostile-origin upgrades through real auth gates', async () => {
  expect(await denied(connect(''))).toBe(401);
  expect(await denied(connect(`?yuri_url_token=${client.token}`))).toBe(401);
  expect(await denied(connect(undefined, 'https://untrusted.example'))).toBe(403);
});

it('relays opaque bytes bidirectionally, preserves half-close and closes remaining targets on disconnect', async () => {
  const received = [];
  let destination;
  const targetPort = await target(socket => {
    destination = socket;
    socket.on('data', bytes => received.push(bytes));
    socket.on('end', () => socket.end(Buffer.from('after-fin')));
  });
  const ws = connect();
  const controls = [], data = [];
  ws.on('message', (bytes, binary) => { if (binary) data.push(bytes); else controls.push(JSON.parse(bytes)); });
  await once(ws, 'open');
  await vi.waitFor(() => expect(controls).toContainEqual(expect.objectContaining({ type: 'ready', httpOrigin: `http://localhost:${port}` })));
  ws.send(JSON.stringify({ type: 'open', id: 1, hostname: '127.0.0.1', port: targetPort }));
  await vi.waitFor(() => expect(controls).toContainEqual({ type: 'opened', id: 1, credit: 131072 }));
  const payload = crypto.randomBytes(16384);
  ws.send(packet(1, payload));
  ws.send(JSON.stringify({ type: 'fin', id: 1 }));
  await vi.waitFor(() => expect(Buffer.concat(received)).toEqual(payload));
  await vi.waitFor(() => expect(data.length).toBe(1));
  expect(data[0].subarray(4).toString()).toBe('after-fin');
  expect(data[0].readUInt32BE()).toBe(1);
  expect(controls).toContainEqual({ type: 'credit', id: 1, bytes: payload.length });
  ws.close(); await once(ws, 'close');
  await vi.waitFor(() => expect(destination.destroyed).toBe(true));
});

it('bounds outbound bytes by credit until the native consumer acknowledges them', async () => {
  const targetPort = await target(socket => socket.write(Buffer.alloc(256 * 1024, 7)));
  const ws = connect(); const data = [];
  ws.on('message', (bytes, binary) => { if (binary) data.push(bytes.subarray(4)); });
  await once(ws, 'open');
  ws.send(JSON.stringify({ type: 'open', id: 2, hostname: '127.0.0.1', port: targetPort }));
  await vi.waitFor(() => expect(Buffer.concat(data).length).toBe(128 * 1024));
  ws.send(JSON.stringify({ type: 'credit', id: 2, bytes: 128 * 1024 }));
  await vi.waitFor(() => expect(Buffer.concat(data)).toEqual(Buffer.alloc(256 * 1024, 7)));
  ws.send(JSON.stringify({ type: 'credit', id: 2, bytes: 128 * 1024 + 1 }));
  expect((await once(ws, 'close'))[0]).toBe(1008);
});

it('uses the existing Relay dispatcher for TCP, with immediate data flush and unchanged website bytes', async () => {
  const targetPort = await target(socket => socket.on('data', bytes => socket.write(bytes)));
  const frames = [];
  const host = createTunnelHost({ connectionId: 'gui-network', getLocalPort: () => port,
    sendFrame: (frame, immediate) => frames.push({ ...decodeTunnelFrame(frame), immediate }), getBufferedAmount: () => 0 });
  const control = value => host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsText, 2, Buffer.from(JSON.stringify(value))));
  try {
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsOpen, 2, encodeJsonPayload({ path: '/api/gui-network/ws', query: `yuri_url_token=${token}` })));
    await vi.waitFor(() => expect(frames.some(frame => frame.frameType === TunnelFrameType.WsOpened)).toBe(true));
    await control({ type: 'open', id: 3, hostname: '127.0.0.1', port: targetPort });
    await vi.waitFor(() => expect(frames.filter(frame => frame.frameType === TunnelFrameType.WsText).map(frame => JSON.parse(Buffer.from(frame.payload)))).toContainEqual({ type: 'opened', id: 3, credit: 131072 }));
    const payload = packet(3, crypto.randomBytes(8192));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsBinary, 2, payload));
    await vi.waitFor(() => expect(frames.some(frame => frame.frameType === TunnelFrameType.WsBinary)).toBe(true));
    const result = frames.find(frame => frame.frameType === TunnelFrameType.WsBinary);
    expect(Buffer.from(result.payload)).toEqual(payload);
    expect(result.immediate).toBe(true);
  } finally { host.close(); }
});
