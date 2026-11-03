import { WebSocketServer } from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWecomSdkAdapter, WecomChatAdapter } from './wecom-chat-adapter.js';

const cleanups = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()(); });
const config = { clientID: 'test-bot', clientSecret: 'test-secret', ownerID: 'owner' };

async function connect(overrides = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  cleanups.push(() => new Promise((resolve) => { for (const socket of server.clients) socket.terminate(); server.close(resolve); }));
  const frames = [];
  let socket;
  server.on('connection', (value) => {
    socket = value;
    value.on('message', (bytes) => {
      const frame = JSON.parse(bytes.toString());
      if (frame.cmd === 'aibot_subscribe' || frame.cmd === 'ping') {
        value.send(JSON.stringify({ headers: frame.headers, errcode: 0 }));
      } else frames.push(frame);
    });
  });
  const bridge = createWecomSdkAdapter({ wsUrl: `ws://127.0.0.1:${server.address().port}` });
  const controller = new AbortController();
  const onReady = vi.fn();
  const onMessage = vi.fn();
  const onError = vi.fn();
  const running = bridge.connect({ config, signal: controller.signal, onReady, onMessage, onError, ...overrides });
  cleanups.push(async () => { controller.abort(); await running.catch(() => {}); });
  await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
  return { bridge, controller, running, frames, socket: () => socket, onMessage, onError,
    ack: (index, errcode = 0) => socket.send(JSON.stringify({ headers: frames[index].headers, errcode })) };
}

describe('official WeCom Chat adapter ACK boundary', () => {
  it('uses official chunked media upload then waits for the native image send ACK', async () => {
    const h = await connect();
    let settled = false;
    const buffer = Buffer.from('generated image bytes');
    const sending = h.bridge.send({ config, image: { buffer, mime: 'image/png', filename: 'image.png' } }).then(() => { settled = true; });
    await vi.waitFor(() => expect(h.frames).toHaveLength(1));
    expect(h.frames[0]).toMatchObject({ cmd: 'aibot_upload_media_init', body: { type: 'image', filename: 'image.png', total_size: buffer.length } });
    h.socket().send(JSON.stringify({ headers: h.frames[0].headers, errcode: 0, body: { upload_id: 'upload-one' } }));
    await vi.waitFor(() => expect(h.frames).toHaveLength(2));
    expect(Buffer.from(h.frames[1].body.base64_data, 'base64')).toEqual(buffer);
    h.ack(1);
    await vi.waitFor(() => expect(h.frames).toHaveLength(3));
    expect(h.frames[2].cmd).toBe('aibot_upload_media_finish');
    h.socket().send(JSON.stringify({ headers: h.frames[2].headers, errcode: 0, body: { media_id: 'media-one', type: 'image' } }));
    await vi.waitFor(() => expect(h.frames).toHaveLength(4));
    expect(h.frames[3]).toMatchObject({ cmd: 'aibot_send_msg', body: { chatid: 'owner', msgtype: 'image', image: { media_id: 'media-one' } } });
    expect(settled).toBe(false);
    h.ack(3);
    await sending;
    expect(settled).toBe(true);
  });
  it('waits for real SDK ACKs and sends a second reply without blocking the lane', async () => {
    const h = await connect();
    let settled = false;
    const first = h.bridge.send({ config, text: 'first' }).then(() => { settled = true; });
    await vi.waitFor(() => expect(h.frames).toHaveLength(1));
    expect(settled).toBe(false);
    expect(h.frames[0].body).toMatchObject({ chatid: 'owner', markdown: { content: 'first' } });
    h.ack(0);
    await first;
    const second = h.bridge.send({ config, text: 'second' });
    await vi.waitFor(() => expect(h.frames).toHaveLength(2));
    h.ack(1);
    await expect(second).resolves.toBeUndefined();
  });

  it('treats a nonzero ACK as a definite safe failure', async () => {
    const h = await connect();
    const sending = expect(h.bridge.send({ config, text: 'rejected' })).rejects.toMatchObject({ code: 'delivery_failed', ambiguous: false });
    await vi.waitFor(() => expect(h.frames).toHaveLength(1));
    h.ack(0, 846605);
    await sending;
  });

  it('preserves uncertainty on cancellation after sending', async () => {
    const h = await connect();
    const controller = new AbortController();
    const sending = expect(h.bridge.send({ config, text: 'cancel', signal: controller.signal })).rejects.toMatchObject({ code: 'delivery_unknown', ambiguous: true });
    await vi.waitFor(() => expect(h.frames).toHaveLength(1));
    controller.abort();
    await sending;
  });

  it('preserves platform IDs and only admits owner private messages', async () => {
    const h = await connect();
    const body = { msgid: 'message-one', from: { userid: 'owner' }, chattype: 'single', msgtype: 'voice', voice: { content: 'transcript' } };
    const emit = (value) => h.socket().send(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'incoming' }, body: value }));
    emit({ ...body, chattype: 'group' });
    emit({ ...body, from: { userid: 'stranger' } });
    emit(body);
    await vi.waitFor(() => expect(h.onMessage).toHaveBeenCalledOnce());
    expect(h.onMessage.mock.calls[0][0]).toMatchObject({ id: 'message-one', senderID: 'owner', text: 'transcript', metadata: { transcript: 'platform' } });
    const adapter = new WecomChatAdapter({ ownerId: 'owner' });
    const parsed = adapter.parseMessage({ ...body, msgtype: 'image', image: { url: 'private-url', aeskey: 'private-key' } });
    expect(parsed.id).toBe('message-one');
    expect(JSON.stringify(parsed)).not.toMatch(/private-url|private-key/);
  });

  it.each(['timeout', 'disconnect'])('keeps %s after submission unknown, never a successful send', async (mode) => {
    const h = await connect();
    const sending = expect(h.bridge.send({ config, text: 'uncertain' })).rejects.toMatchObject({ code: 'delivery_unknown', ambiguous: true });
    await vi.waitFor(() => expect(h.frames).toHaveLength(1));
    if (mode === 'disconnect') h.socket().terminate();
    await sending;
  }, 10_000);

  it('allows another enterprise Bot account to connect concurrently', async () => {
    const h = await connect();
    const controller = new AbortController();
    const onReady = vi.fn();
    const running = h.bridge.connect({ config: { ...config, clientID: 'second-bot' }, signal: controller.signal, onReady });
    cleanups.push(async () => { controller.abort(); await running.catch(() => {}); });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    await expect(h.bridge.connect({ config })).rejects.toMatchObject({ code: 'channel_in_use' });
  });

  it('reports missing sessions before writing and refuses duplicate live credentials', async () => {
    const h = await connect();
    await expect(h.bridge.connect({ config })).rejects.toMatchObject({ code: 'channel_in_use' });
    await expect(h.bridge.send({ config: { ...config, clientID: 'another' }, text: 'no session' })).rejects.toMatchObject({ code: 'network_error', ambiguous: false });
    h.controller.abort();
    await h.running;
  });
});
