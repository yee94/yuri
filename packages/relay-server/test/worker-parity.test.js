import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';
import { createPrivateRelayServer } from '../src/index.js';

// Set to a dedicated local Wrangler instance or a NEW staging Worker, never a
// shared production endpoint: these tests deliberately trigger policy failures.
const workerUrl = process.env.YURI_RELAY_WORKER_TEST_URL;
const sockets = [];
let relay;
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await relay?.stop(); relay = undefined;
});

const identity = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
  let last = 0;
  return { serverId, params(role, connectionId) {
    const ts = String(Math.max(Date.now(), last + 1)); last = Number(ts);
    return { v: '1', role, serverId, ...(connectionId ? { connectionId } : {}), ...(role === 'client' ? {} : {
      ts, pk: Buffer.from(canonical).toString('base64url'),
      sig: crypto.sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'),
    }) };
  } };
};
const open = async (url) => {
  const socket = new WebSocket(url);
  sockets.push(socket); socket.messages = []; socket.closeCode = null;
  socket.on('message', (data, binary) => socket.messages.push([Buffer.from(data), binary]));
  socket.on('close', (code) => { socket.closeCode = code; });
  socket.on('error', () => {});
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('Relay upgrade timed out')); }, 5_000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
  return socket;
};
const until = async (check) => {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error('Relay contract timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const next = async (socket) => { await until(() => socket.messages.length > 0); return socket.messages.shift(); };
const closed = async (socket) => { await until(() => socket.closeCode !== null); return socket.closeCode; };

for (const runtime of ['Node', 'Workers']) describe.skipIf(runtime === 'Workers' && !workerUrl)(`${runtime} shared Relay protocol`, () => {
  const endpoint = async () => {
    if (runtime === 'Workers') return workerUrl;
    relay = createPrivateRelayServer({ host: '127.0.0.1', port: 0 }); await relay.start(); return relay.wsUrl;
  };
  const route = (url, params) => `${url}?${new URLSearchParams(params)}`;

  it('accepts Node P-256 signatures, rejects replay/forgery, and does not replace a valid control', async () => {
    const url = await endpoint(); const host = identity(); const params = host.params('host-control');
    const control = await open(route(url, params));
    expect(JSON.parse((await next(control))[0])).toEqual({ type: 'sync', connectionIds: [] });
    expect(await closed(await open(route(url, params)))).toBe(4010);
    const forged = host.params('host-control'); forged.sig = crypto.randomBytes(64).toString('base64url');
    expect(await closed(await open(route(url, forged)))).toBe(4010);
    expect(control.readyState).toBe(WebSocket.OPEN);
  });

  it('preserves pre-attach text/binary order and exact bytes in both directions', async () => {
    const url = await endpoint(); const host = identity();
    const control = await open(route(url, host.params('host-control'))); await next(control);
    const client = await open(route(url, host.params('client')));
    const { connectionId } = JSON.parse((await next(control))[0]);
    client.send('中文'); client.send(Buffer.from([0, 255])); client.send('third');
    const data = await open(route(url, host.params('host-data', connectionId)));
    const frames = [await next(data), await next(data), await next(data)];
    expect(frames.map(([payload, binary]) => [payload.toString('hex'), binary])).toEqual([
      [Buffer.from('中文').toString('hex'), false], ['00ff', true], [Buffer.from('third').toString('hex'), false],
    ]);
    const payload = crypto.randomBytes(128 * 1024);
    data.send(payload);
    expect(await next(client)).toEqual([payload, true]);
    expect(await closed(await open(route(url, host.params('host-data', connectionId))))).toBe(4002);
  });

  it('answers the existing Host wire ping without requiring a new application protocol', async () => {
    const url = await endpoint(); const host = identity();
    const control = await open(route(url, host.params('host-control'))); await next(control);
    let pong = false; control.once('pong', () => { pong = true; });
    control.ping('keepalive');
    await until(() => pong);
    expect(control.readyState).toBe(WebSocket.OPEN);
  });

  it('rejects oversize payloads and closes both paired sockets', async () => {
    const url = await endpoint(); const host = identity();
    const control = await open(route(url, host.params('host-control'))); await next(control);
    const client = await open(route(url, host.params('client')));
    const { connectionId } = JSON.parse((await next(control))[0]);
    const data = await open(route(url, host.params('host-data', connectionId)));
    client.send(Buffer.alloc(128 * 1024 + 1));
    expect([1009, 4029]).toContain(await closed(client));
    await closed(data);
    expect(JSON.parse((await next(control))[0])).toEqual({ type: 'disconnected', connectionId });
  });

  it('preserves pairs across control grace and invalidates them on active replacement', async () => {
    const url = await endpoint(); const host = identity();
    const control = await open(route(url, host.params('host-control'))); await next(control);
    const client = await open(route(url, host.params('client')));
    const { connectionId } = JSON.parse((await next(control))[0]);
    const data = await open(route(url, host.params('host-data', connectionId)));
    control.close(); await closed(control);
    data.send('during grace'); expect((await next(client))[0].toString()).toBe('during grace');
    const recovered = await open(route(url, host.params('host-control')));
    expect(JSON.parse((await next(recovered))[0]).connectionIds).toEqual([connectionId]);
    const replacement = await open(route(url, host.params('host-control')));
    expect(JSON.parse((await next(replacement))[0]).connectionIds).toEqual([]);
    expect(await closed(recovered)).toBe(4001); expect(await closed(client)).toBe(4001);
  });

  it('rejects unknown hosts, duplicate fields and inherited object-property roles safely', async () => {
    const url = await endpoint(); const host = identity();
    expect(await closed(await open(route(url, host.params('client'))))).toBe(4008);
    expect(await closed(await open(`${route(url, host.params('client'))}&v=1`))).toBe(1008);
    for (const role of ['constructor', '__proto__', 'toString']) {
      expect(await closed(await open(route(url, { v: '1', role, serverId: host.serverId })))).toBe(1008);
    }
  });

  it('forwards repeated traffic without reordering and lets a second pair progress', async () => {
    const url = await endpoint(); const host = identity();
    const control = await open(route(url, host.params('host-control'))); await next(control);
    const first = await open(route(url, host.params('client')));
    const firstId = JSON.parse((await next(control))[0]).connectionId;
    const firstData = await open(route(url, host.params('host-data', firstId)));
    const second = await open(route(url, host.params('client')));
    const secondId = JSON.parse((await next(control))[0]).connectionId;
    const secondData = await open(route(url, host.params('host-data', secondId)));
    for (let i = 0; i < 100; i += 1) first.send(`frame:${i}`);
    second.send('independent');
    expect((await next(secondData))[0].toString()).toBe('independent');
    await until(() => firstData.messages.length === 100);
    expect(firstData.messages.map(([data]) => data.toString())).toEqual(Array.from({ length: 100 }, (_, i) => `frame:${i}`));
  });
});
