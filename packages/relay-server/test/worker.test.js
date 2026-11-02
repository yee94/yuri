import { afterEach, describe, expect, it, vi } from 'vitest';
import crypto from 'node:crypto';
import { createRelayCore } from '../src/core.js';
import { WorkerRelaySocket } from '../src/worker-socket.js';
import worker, { YuriRelay } from '../src/worker.js';

class RuntimeSocket extends EventTarget {
  readyState = 1;
  sent = [];
  send(data) { this.sent.push(data); }
  close(code, reason) {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
  }
  receive(data) { this.dispatchEvent(Object.assign(new Event('message'), { data })); }
}

const cores = [];
afterEach(() => {
  for (const core of cores.splice(0)) core.dispose();
  vi.useRealTimers();
});

const coreAndHost = (limits = {}) => {
  const core = createRelayCore({ limits }); cores.push(core);
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const serverId = crypto.createHash('sha256').update(canonical).digest('base64url');
  let last = 0;
  const attach = (role, connectionId) => {
    const params = new URLSearchParams({ v: '1', role, serverId });
    if (role !== 'client') {
      const ts = String(Math.max(Date.now(), last + 1)); last = Number(ts);
      const sig = crypto.sign('SHA256', Buffer.from(`${ts}.${serverId}.${role}.${connectionId ?? ''}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
      params.set('ts', ts); params.set('sig', sig); params.set('pk', Buffer.from(canonical).toString('base64url'));
    }
    if (connectionId) params.set('connectionId', connectionId);
    const admission = core.admitConnection(`/ws?${params}`, 'test-ip');
    expect(admission.code).toBeUndefined();
    const native = new RuntimeSocket();
    const socket = new WorkerRelaySocket(native);
    core.accept(socket, admission.parsed, 'test-ip');
    return { native, socket };
  };
  return { core, attach };
};

describe('Workers runtime adapter', () => {
  it('preserves binary/text types, uses ArrayBuffer delivery, and reports acceptance errors', () => {
    const native = new RuntimeSocket(); const socket = new WorkerRelaySocket(native);
    expect(native.binaryType).toBe('arraybuffer');
    const messages = []; socket.on('message', (data, binary) => messages.push([data.toString('hex'), binary]));
    native.receive('中文'); native.receive(new Uint8Array([0, 255]).buffer);
    expect(messages).toEqual([[Buffer.from('中文').toString('hex'), false], ['00ff', true]]);
    const sent = vi.fn(); socket.send(Buffer.from('你好'), { binary: false }, sent);
    socket.send(Buffer.from([1, 2]), { binary: true }, sent);
    expect(native.sent).toEqual(['你好', Buffer.from([1, 2])]);
    expect(sent.mock.calls).toEqual([[undefined], [undefined]]);
    expect(socket.bufferedAmount).toBeUndefined();
    native.send = () => { throw new Error('runtime send failed'); };
    socket.send(Buffer.from('x'), { binary: false }, sent);
    expect(sent.mock.lastCall[0].message).toBe('runtime send failed');
  });

  it('cleans socket state once on error, close, and late messages', () => {
    const native = new RuntimeSocket(); const socket = new WorkerRelaySocket(native);
    const close = vi.fn(); const message = vi.fn(); socket.on('close', close); socket.on('message', message);
    native.dispatchEvent(new Event('error')); native.close(1000, ''); native.receive('late'); socket.terminate();
    expect(close).toHaveBeenCalledTimes(1); expect(message).not.toHaveBeenCalled();
    expect(socket.readyState).toBe(3);
  });

  it('uses the same core for ordered queued frames and releases pending/grace timers', () => {
    vi.useFakeTimers();
    const { core, attach } = coreAndHost({ pendingMs: 15, graceMs: 30 });
    const control = attach('host-control');
    const first = attach('client');
    const { connectionId } = JSON.parse(control.native.sent.at(-1));
    first.native.receive('one'); first.native.receive(new Uint8Array([2]).buffer);
    const data = attach('host-data', connectionId);
    vi.advanceTimersByTime(5);
    expect(data.native.sent.map((value) => typeof value === 'string' ? value : [...value])).toEqual(['one', [2]]);
    data.native.receive('reply'); vi.advanceTimersByTime(5);
    expect(first.native.sent).toEqual(['reply']);
    const pending = attach('client'); vi.advanceTimersByTime(16);
    expect(pending.socket.readyState).toBe(3);
    expect(core.getSnapshot()).toMatchObject({ clients: 1, pairs: 1, pending: 0, queuedBytes: 0 });
    control.native.close(1000, '');
    vi.advanceTimersByTime(31);
    expect(core.getSnapshot()).toMatchObject({ sockets: 0, clients: 0, hosts: 0, pairs: 0, queuedBytes: 0 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds a Worker pending queue even though runtime sockets cannot pause TCP', () => {
    vi.useFakeTimers();
    const { core, attach } = coreAndHost({ maxQueuedBytesPerConnection: 8 });
    attach('host-control'); const client = attach('client');
    client.native.receive(new Uint8Array(5).buffer); client.native.receive(new Uint8Array(5).buffer);
    expect(client.socket.readyState).toBe(3);
    expect(core.getSnapshot()).toMatchObject({ clients: 0, queuedBytes: 0, reasons: { limited: 1 } });
  });

  it('fails closed on invalid Worker configuration', () => {
    for (const env of [
      { YURI_RELAY_PATH: 'ws' }, { YURI_RELAY_PATH: '/ws?x' },
      { YURI_RELAY_LIMITS_JSON: '[]' }, { YURI_RELAY_LIMITS_JSON: '{"maxHosts":0}' },
      { YURI_RELAY_LIMITS_JSON: '{"unknown":1}' },
    ]) expect(() => new YuriRelay(null, env)).toThrow();
  });

  it('uses one authoritative Durable Object for all routes, not spoofable routing headers', async () => {
    const fetch = vi.fn(() => new Response('ok')); const get = vi.fn(() => ({ fetch })); const idFromName = vi.fn(() => 'id');
    const request = new Request('https://relay.example.com/healthz');
    expect(await (await worker.fetch(request, { YURI_RELAY: { idFromName, get } })).text()).toBe('ok');
    expect(idFromName).toHaveBeenCalledWith('relay-v1'); expect(get).toHaveBeenCalledWith('id');
    expect(fetch).toHaveBeenCalledWith(request);
  });

  it('keeps health/readiness checks private of route metadata and does not mount Push', async () => {
    const relay = new YuriRelay(null, {});
    for (const path of ['/healthz', '/readyz']) {
      const result = relay.fetch(new Request(`https://relay.example.com${path}`));
      expect(result.status).toBe(200); expect(await result.json()).toEqual({ status: 'ok' });
      expect(result.headers.get('cache-control')).toBe('no-store');
      expect(await relay.fetch(new Request(`https://relay.example.com${path}`, { method: 'HEAD' })).text()).toBe('');
    }
    expect(relay.fetch(new Request('https://relay.example.com/ws')).status).toBe(426);
    expect(relay.fetch(new Request('https://relay.example.com/v1/push/send', { method: 'POST' })).status).toBe(404);
    expect(relay.fetch(new Request('https://relay.example.com/healthz', { method: 'POST' })).status).toBe(404);
  });
});
