import net from 'node:net';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { createBrowserSocksGateway } from './browser-socks-gateway.mjs';

const read = (socket, length) => new Promise((resolve, reject) => {
  const receive = () => {
    const bytes = socket.read(length);
    if (!bytes) return;
    socket.off('readable', receive);
    socket.off('error', reject);
    resolve(bytes);
  };
  socket.on('readable', receive);
  socket.once('error', reject);
  receive();
});
const connect = async (port, hostname = 'localhost') => {
  const socket = net.connect({ host: '127.0.0.1', port, allowHalfOpen: true });
  socket.on('error', () => {});
  await once(socket, 'connect');
  socket.write(Buffer.from([5, 1, 0]));
  expect(await read(socket, 2)).toEqual(Buffer.from([5, 0]));
  const name = Buffer.from(hostname);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0, 3, name.length]), name, Buffer.from([0x14, 0x3c])]));
  return socket;
};
const packet = (id, bytes) => {
  const result = Buffer.alloc(4 + bytes.length);
  result.writeUInt32BE(id); bytes.copy(result, 4);
  return result;
};

it('negotiates SOCKS, forwards opaque bytes with credit and preserves half-close', async () => {
  const messages = [];
  const gateway = createBrowserSocksGateway({ send: value => { messages.push(value); return true; } });
  const { port } = await gateway.start();
  let socket;
  try {
    socket = await connect(port);
    await expect.poll(() => messages[0]).toEqual({ type: 'open', id: 1, hostname: 'localhost', port: 5180 });
    gateway.receive(JSON.stringify({ type: 'opened', id: 1 }));
    expect((await read(socket, 10))[1]).toBe(0);
    socket.write('request');
    await expect.poll(() => messages.find(Buffer.isBuffer)?.subarray(4).toString()).toBe('request');
    gateway.receive(packet(1, Buffer.from('response')));
    expect((await read(socket, 8)).toString()).toBe('response');
    await expect.poll(() => messages.some(value => value.type === 'credit' && value.bytes === 8)).toBe(true);
    socket.end();
    await expect.poll(() => messages.some(value => value.type === 'fin')).toBe(true);
    gateway.receive(packet(1, Buffer.from('after-fin')));
    gateway.receive(JSON.stringify({ type: 'fin', id: 1 }));
    expect((await read(socket, 9)).toString()).toBe('after-fin');
  } finally { socket?.destroy(); await gateway.close(); }
});

it('waits for Host acknowledgement before succeeding and fails closed on release', async () => {
  const messages = [];
  const gateway = createBrowserSocksGateway({ send: value => { messages.push(value); return true; } });
  const { port } = await gateway.start();
  const socket = await connect(port);
  try {
    await expect.poll(() => messages.length).toBe(1);
    expect(socket.readableLength).toBe(0);
    const ended = once(socket, 'end');
    await gateway.close();
    socket.resume();
    await ended;
    await expect(new Promise((resolve, reject) => {
      const next = net.connect(port, '127.0.0.1');
      next.once('error', reject); next.once('connect', () => { next.destroy(); resolve(); });
    })).rejects.toThrow();
  } finally { socket.destroy(); await gateway.close(); }
});

it('bounds upstream reads by Host credit and rejects credit inflation', async () => {
  const messages = [];
  const gateway = createBrowserSocksGateway({ send: value => { messages.push(value); return true; } });
  const { port } = await gateway.start();
  const socket = await connect(port);
  try {
    await expect.poll(() => messages[0]?.type).toBe('open');
    gateway.receive(JSON.stringify({ type: 'opened', id: 1 }));
    await read(socket, 10);
    socket.write(Buffer.alloc(256 * 1024, 7));
    const sent = () => messages.filter(Buffer.isBuffer).reduce((sum, item) => sum + item.length - 4, 0);
    await expect.poll(sent).toBe(128 * 1024);
    gateway.receive(JSON.stringify({ type: 'credit', id: 1, bytes: 128 * 1024 }));
    await expect.poll(sent).toBe(256 * 1024);
    expect(() => gateway.receive(JSON.stringify({ type: 'credit', id: 1, bytes: 128 * 1024 + 1 }))).toThrow();
  } finally { socket.destroy(); await gateway.close(); }
});
