import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'node:http';
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
import { createFragmentAssembler, decodeTunnelFrame, encodeJsonPayload, encodeTunnelFrame, TunnelFrameType } from '../relay/tunnel-codec.js';
import { attachRemoteDesktop } from './runtime.js';

let root, auth, clients, client, server, port, adapter, runtime, token;
const sockets = new Set();
beforeEach(async () => {
  root = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'remote-desktop-test-'));
  clients = createRemoteClientAuthRuntime({ fsPromises, path, crypto, storePath: path.join(root, 'clients.json') });
  client = await clients.createClient({ label: 'Test device', clientKind: 'mobile' });
  auth = createUiAuth({ password: null, clientAuthController: clients, readSettingsFromDiskMigrated: async () => ({}) });
  const security = createRequestSecurityRuntime({ readSettingsFromDiskMigrated: async () => ({}) });
  const app = express();
  app.post('/auth/url-token', auth.handleUrlAuthToken);
  app.use(auth.requireAuth);
  adapter = { supported: true, enabled: true, start: vi.fn(async ({ send }) => {
    send({ type: 'ready', width: 1600, height: 900, zoomQuality: true });
    return { handle: vi.fn(), close: vi.fn() };
  }), stop: vi.fn() };
  server = http.createServer(app);
  runtime = attachRemoteDesktop({ app, server, adapter, uiAuthController: auth, isRequestOriginAllowed: security.isRequestOriginAllowed,
    isClientActive: async id => (await clients.listClients()).some(entry => entry.id === id && !entry.revokedAt) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); port = server.address().port;
  const minted = await request(app).post('/auth/url-token').set('Authorization', `Bearer ${client.token}`);
  expect(minted.status).toBe(200);
  token = minted.body.token;
});
afterEach(async () => {
  for (const ws of sockets) ws.terminate(); sockets.clear();
  runtime.stop(); auth.dispose();
  await new Promise(resolve => server.close(resolve));
  await fsPromises.rm(root, { recursive: true, force: true });
});
function socket(query = `?yuri_url_token=${encodeURIComponent(token)}`, headers = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/remote-desktop/ws${query}`, { headers: { Origin: `http://127.0.0.1:${port}`, ...headers } });
  ws.on('error', () => {}); sockets.add(ws); return ws;
}
async function rejected(ws) {
  return new Promise((resolve, reject) => {
    ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode); });
    ws.on('open', () => reject(new Error('Upgrade unexpectedly allowed')));
  });
}
it('uses real auth and origin gates, refusing forged owner cookies, bearer query strings and hostile origins', async () => {
  expect(await rejected(socket('', { Cookie: 'yuri_ui_session=forged' }))).toBe(401);
  expect(await rejected(socket(`?yuri_url_token=${client.token}`))).toBe(401);
  expect(await rejected(socket(undefined, { Origin: 'https://attacker.example' }))).toBe(403);
  expect(adapter.start).not.toHaveBeenCalled();
});

it('refuses even authenticated devices while the native Host is disabled', async () => {
  adapter.enabled = false;
  expect(await rejected(socket())).toBe(403);
  expect(adapter.start).not.toHaveBeenCalled();
});
it('allows a scoped device, handles input and pong, rejects simultaneous control, and cleans up on disconnect', async () => {
  const ws = socket(); await once(ws, 'open');
  await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledTimes(1));
  const desktop = await adapter.start.mock.results[0].value;
  ws.send(JSON.stringify({ type: 'pointer', action: 'click', x: 0.4, y: 0.6 }));
  await vi.waitFor(() => expect(desktop.handle).toHaveBeenCalledWith({ type: 'pointer', action: 'click', x: 0.4, y: 0.6 }));
  ws.send(JSON.stringify({ type: 'view', zoomed: true, maxBitrate: 999999999 }));
  await vi.waitFor(() => expect(desktop.handle).toHaveBeenCalledWith({ type: 'view', zoomed: true }));
  const pong = once(ws, 'message'); ws.send('{"type":"ping"}');
  expect(JSON.parse((await pong)[0].toString()).type).toBe('pong');
  expect(await rejected(socket())).toBe(409);
  ws.close(); await once(ws, 'close');
  await vi.waitFor(() => expect(desktop.close).toHaveBeenCalledOnce());
});
it('keeps an early SDP answer until asynchronous capture startup finishes', async () => {
  let finish;
  const handle = vi.fn();
  adapter.start.mockImplementation(({ send }) => {
    send({ type: 'offer', sdp: 'offer' });
    return new Promise(resolve => { finish = () => resolve({ handle, close: vi.fn() }); });
  });
  const ws = socket(); await once(ws, 'open');
  ws.send('{"type":"answer","sdp":"answer"}');
  await vi.waitFor(() => expect(finish).toBeDefined()); finish();
  await vi.waitFor(() => expect(handle).toHaveBeenCalledWith({ type: 'answer', sdp: 'answer' }));
});

it('does not forward view commands into an older native adapter that did not advertise support', async () => {
  const handle = vi.fn();
  adapter.start.mockImplementation(async ({ send, zoomQuality }) => {
    expect(zoomQuality).toBe(true);
    send({ type: 'ready', width: 1600, height: 900 });
    return { handle, close: vi.fn() };
  });
  const ws = socket(); await once(ws, 'open');
  ws.send('{"type":"view","zoomed":true}');
  const pong = new Promise(resolve => ws.on('message', data => { if (JSON.parse(data.toString()).type === 'pong') resolve(); }));
  ws.send('{"type":"ping"}');
  await pong;
  await vi.waitFor(() => expect(adapter.start).toHaveBeenCalledOnce());
  expect(handle).not.toHaveBeenCalled();
});
it('aborts pending native consent on disconnect and frees the single capture slot', async () => {
  let signal;
  adapter.start.mockImplementation(options => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled'))));
  });
  const ws = socket(); await once(ws, 'open'); ws.close(); await once(ws, 'close');
  await vi.waitFor(() => expect(signal.aborted).toBe(true));
  adapter.start.mockResolvedValue({ handle: vi.fn(), close: vi.fn() });
  const next = socket(); await once(next, 'open');
});
it('stops native control when the device is revoked', { timeout: 10000 }, async () => {
  const ws = socket(); await once(ws, 'open');
  const closed = once(ws, 'close');
  await clients.revokeClient(client.client.id);
  expect((await closed)[0]).toBe(4001);
  const desktop = await adapter.start.mock.results[0].value;
  expect(desktop.close).toHaveBeenCalledOnce();
});
it('carries screen frames and validated input through the real Relay WS dispatcher and auth gates', async () => {
  const frames = [];
  const host = createTunnelHost({ connectionId: 'desktop-test', getLocalPort: () => port,
    sendFrame: frame => { frames.push(decodeTunnelFrame(frame)); }, getBufferedAmount: () => 0 });
  try {
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsOpen, 2, encodeJsonPayload({ path: '/api/remote-desktop/ws', query: `yuri_url_token=${token}` })));
    await vi.waitFor(() => expect(frames.some(frame => frame.frameType === TunnelFrameType.WsOpened)).toBe(true));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsText, 2, Buffer.from('{"type":"key","key":"Enter"}')));
    const desktop = await adapter.start.mock.results[0].value;
    await vi.waitFor(() => expect(desktop.handle).toHaveBeenCalledWith({ type: 'key', key: 'Enter' }));
    await host.handleFrame(encodeTunnelFrame(TunnelFrameType.WsText, 2, Buffer.from('{"type":"view","zoomed":true}')));
    await vi.waitFor(() => expect(desktop.handle).toHaveBeenCalledWith({ type: 'view', zoomed: true }));
    const jpeg = Buffer.alloc(200000, 17);
    adapter.start.mock.calls[0][0].send(jpeg);
    let reassembled;
    await vi.waitFor(() => {
      const fresh = createFragmentAssembler();
      for (const frame of frames.filter(frame => frame.frameType === TunnelFrameType.WsBinary)) {
        const complete = fresh.push(frame);
        if (complete) reassembled = complete;
      }
      expect(reassembled?.byteLength).toBe(jpeg.length);
    });
    expect(Buffer.from(reassembled)).toEqual(jpeg);
  } finally { host.close(); }
});
