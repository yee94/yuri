import { describe, expect, it, vi } from 'vitest';
import { createLarkChannel } from '@larksuite/channel';
import { createAssistantChannelAdapters, createFeishuSdkAdapter, outboundUuid } from './sdk-adapters.js';

describe('Feishu native image delivery', () => {
  it('uploads multipart bytes and sends image_key with the same durable UUID', async () => {
    const fetchImpl = vi.fn(async (url) => Response.json(String(url).includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'token', expire: 7200 }
      : String(url).endsWith('/images') ? { code: 0, data: { image_key: 'img_uploaded' } } : { code: 0 }));
    const bridge = createFeishuSdkAdapter({ fetchImpl });
    await bridge.send({ config: { clientID: 'app', clientSecret: 'secret', ownerID: 'owner' }, id: 'stable-image',
      image: { buffer: Buffer.from('image'), mime: 'image/png', filename: 'image.png' } });
    const form = fetchImpl.mock.calls[1][1].body;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('image_type')).toBe('message');
    expect(Buffer.from(await form.get('image').arrayBuffer())).toEqual(Buffer.from('image'));
    expect(fetchImpl.mock.calls[1][1].headers['Content-Type']).toBeUndefined();
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toEqual({ receive_id: 'owner', msg_type: 'image', content: JSON.stringify({ image_key: 'img_uploaded' }), uuid: 'stable-image' });
  });
});

/**
 * Mimics the real `@larksuite/vercel-chat-adapter` lifecycle: it asks the
 * bridge for a channel through `channelFactory`, wires its own normalized
 * handler, and only then calls `channel.connect()`.
 */
function makeFeishuHarness({ parseMessage } = {}) {
  const order = [];
  const rawHandlers = new Map();
  const channel = {
    connect: vi.fn(async () => {
      // The raw ACK gate must already be installed before the socket opens.
      order.push(rawHandlers.has('im.message.receive_v1') ? 'connect-gated' : 'connect-ungated');
    }),
    disconnect: vi.fn(async () => {}),
    getBotIdentity: () => ({ openId: 'ou_bot' }),
    getConnectionStatus: vi.fn(() => ({ state: 'connected' })),
    onRawEvent: (name, handler) => {
      order.push(`raw:${name}`);
      rawHandlers.set(name, handler);
      return () => rawHandlers.delete(name);
    },
    on: vi.fn((name) => {
      order.push(`on:${name}`);
      return () => {};
    }),
  };
  const adapter = {
    initialize: vi.fn(),
    parseMessage: parseMessage ?? ((nm) => ({
      id: nm.messageId,
      threadId: `lark:${nm.chatId}:`,
      text: nm.content,
      raw: nm,
      author: { userId: nm.senderId, isMe: false, isBot: nm.senderType === 'bot' },
      attachments: [],
    })),
    disconnect: vi.fn(async () => {}),
  };
  return { adapter, channel, rawHandlers, order };
}

/** Mirrors the real adapter's `initialize`: create the channel, wire it, connect. */
function fakeAdapterFactory(harness, { initialize } = {}) {
  return async (options) => {
    harness.adapter.initialize.mockImplementation(async (host) => {
      if (initialize) return initialize({ host, options, harness });
      const channel = options.channelFactory(options);
      await channel.connect();
    });
    return harness.adapter;
  };
}

function feishuBridge(harness, options = {}, initOptions) {
  return createFeishuSdkAdapter({
    channelFactory: () => harness.channel,
    adapterFactory: fakeAdapterFactory(harness, initOptions),
    normalizeEvent: async () => normalized(),
    ...options,
  });
}

function normalized(overrides = {}) {
  return {
    messageId: 'om_1',
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou_owner',
    senderType: 'user',
    content: 'hello',
    resources: [],
    mentions: [],
    createTime: Date.now(),
    ...overrides,
  };
}

function ownerConfig(overrides = {}) {
  return { clientID: 'cli_x', clientSecret: 'secret', ownerID: 'ou_owner', ...overrides };
}

describe('feishu Chat SDK bridge', () => {
  it('accepts platform-scoped DMs without a user binding and sends to the durable recipient', async () => {
    const h = makeFeishuHarness();
    const controller = new AbortController();
    const onMessage = vi.fn();
    const fetchImpl = vi.fn(async (url) => new Response(JSON.stringify(String(url).includes('tenant_access_token')
      ? { code: 0, tenant_access_token: 'token', expire: 7200 } : { code: 0 }), { status: 200 }));
    const bridge = feishuBridge(h, { fetchImpl, normalizeEvent: async (raw) => normalized(raw) });
    const config = ownerConfig({ ownerID: '' });
    const running = bridge.connect({ config, signal: controller.signal, onMessage });
    try {
      await vi.waitFor(() => expect(h.rawHandlers.has('im.message.receive_v1')).toBe(true));
      const receive = h.rawHandlers.get('im.message.receive_v1');
      await receive({ senderId: 'ou_alice' });
      await receive({ senderId: 'ou_bob' });
      await receive({ senderId: 'ou_bob', chatType: 'group' });
      expect(onMessage.mock.calls.map(([message]) => message.senderID)).toEqual(['ou_alice', 'ou_bob']);
      await expect(bridge.send({ config, text: 'no recipient' })).rejects.toMatchObject({ code: 'invalid_response' });
      await bridge.send({ config, target: { userID: 'ou_alice' }, text: 'hello' });
      expect(JSON.parse(fetchImpl.mock.calls[1][1].body).receive_id).toBe('ou_alice');
    } finally { controller.abort(); await running; }
  });

  it('installs the public raw ACK gate before the channel connects', async () => {
    const harness = makeFeishuHarness();
    const controller = new AbortController();
    const onReady = vi.fn();
    const running = feishuBridge(harness).connect({ config: ownerConfig(), signal: controller.signal, onReady, onMessage: vi.fn() });

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(harness.order.indexOf('raw:im.message.receive_v1')).toBeGreaterThan(-1);
    expect(harness.order).toContain('connect-gated');
    expect(harness.order).not.toContain('connect-ungated');
    expect(harness.order.indexOf('raw:im.message.receive_v1')).toBeLessThan(harness.order.indexOf('connect-gated'));
    controller.abort();
    await running;
    expect(harness.adapter.disconnect).toHaveBeenCalledOnce();
  });

  it('keeps the platform ACK pending until durable delivery resolves', async () => {
    const harness = makeFeishuHarness();
    const controller = new AbortController();
    const onMessage = vi.fn();
    const running = feishuBridge(harness).connect({ config: ownerConfig(), signal: controller.signal, onMessage });

    await vi.waitFor(() => expect(harness.rawHandlers.has('im.message.receive_v1')).toBe(true));

    let release;
    onMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    let settled = false;
    const acked = harness.rawHandlers.get('im.message.receive_v1')({}).then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(onMessage).toHaveBeenCalledOnce();
    release();
    await acked;
    expect(settled).toBe(true);

    controller.abort();
    await running;
  });

  it('drops bots, group chats and non-owner senders without delivery', async () => {
    const onMessage = vi.fn();
    for (const nm of [
      normalized({ chatType: 'group' }),
      normalized({ senderId: 'ou_other' }),
      normalized({ senderType: 'bot' }),
      normalized({ senderType: 'app' }),
      normalized({ senderId: 'cli_app', senderType: 'app' }),
    ]) {
      const harness = makeFeishuHarness();
      const controller = new AbortController();
      const running = feishuBridge(harness, { normalizeEvent: async () => nm })
        .connect({ config: ownerConfig(), signal: controller.signal, onMessage });
      await vi.waitFor(() => expect(harness.rawHandlers.has('im.message.receive_v1')).toBe(true));
      await harness.rawHandlers.get('im.message.receive_v1')({});
      controller.abort();
      await running;
    }
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('projects bounded public metadata without platform capability handles', async () => {
    const harness = makeFeishuHarness();
    const controller = new AbortController();
    const onMessage = vi.fn();
    const projected = [];
    onMessage.mockImplementation((message) => { projected.push(message); });
    const running = feishuBridge(harness, {
      normalizeEvent: async () => normalized({
        resources: [{ type: 'file', fileKey: 'file_v2_secret', fileName: 'notes.pdf', durationMs: 1200 }],
        mentions: [{ name: 'Owner', openId: 'ou_owner' }],
      }),
    }).connect({ config: ownerConfig(), signal: controller.signal, onMessage });
    await vi.waitFor(() => expect(harness.rawHandlers.has('im.message.receive_v1')).toBe(true));
    await harness.rawHandlers.get('im.message.receive_v1')({});
    expect(projected[0]).toMatchObject({
      id: 'om_1', senderID: 'ou_owner', chatType: 'private', text: 'hello',
      metadata: { platform: 'feishu', notDownloaded: true, resources: [{ type: 'file', name: 'notes.pdf', durationMs: 1200 }], mentions: ['Owner'] },
    });
    expect(JSON.stringify(projected[0])).not.toContain('file_v2_secret');
    controller.abort();
    await running;
  });

  it('re-arms readiness from the SDK reconnect events', async () => {
    const harness = makeFeishuHarness();
    const controller = new AbortController();
    const onReady = vi.fn();
    const onError = vi.fn();
    const running = feishuBridge(harness).connect({ config: ownerConfig(), signal: controller.signal, onReady, onError });

    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    const handlers = new Map(harness.channel.on.mock.calls);
    expect(typeof handlers.get('reconnecting')).toBe('function');
    expect(typeof handlers.get('reconnected')).toBe('function');

    handlers.get('reconnecting')();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError.mock.calls[0][0]).toMatchObject({ code: 'network_error' });

    // A successful SDK reconnect must re-announce readiness, otherwise the
    // runtime never sends again after a transient error.
    handlers.get('reconnected')();
    expect(onReady).toHaveBeenCalledTimes(2);

    controller.abort();
    await running;
  });

  it('maps vendor error codes instead of leaking them to the runtime', async () => {
    const harness = makeFeishuHarness();
    const failure = Object.assign(new Error('not connected'), { code: 'not_connected' });
    const running = feishuBridge(harness, {}, {
      initialize: () => Promise.reject(failure),
    }).connect({ config: ownerConfig(), signal: new AbortController().signal, onMessage: vi.fn() });
    await expect(running).rejects.toMatchObject({ code: 'network_error', ambiguous: false });
  });

  it('aborts a connect that never finishes and still disconnects the adapter', async () => {
    const harness = makeFeishuHarness();
    const controller = new AbortController();
    const running = feishuBridge(harness, {}, { initialize: () => new Promise(() => {}) }).connect({ config: ownerConfig(), signal: controller.signal, onMessage: vi.fn() });

    await vi.waitFor(() => expect(harness.adapter.initialize).toHaveBeenCalledOnce());
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    expect(harness.adapter.disconnect).toHaveBeenCalled();
  });

  it('closes a Feishu channel whose handshake finishes after the abort', async () => {
    const harness = makeFeishuHarness();
    let releaseConnect;
    harness.channel.connect.mockImplementationOnce(() => new Promise((resolve) => { releaseConnect = resolve; }));
    const controller = new AbortController();
    const running = feishuBridge(harness).connect({ config: ownerConfig(), signal: controller.signal, onMessage: vi.fn() });

    await vi.waitFor(() => expect(harness.channel.connect).toHaveBeenCalledOnce());
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    // The vendor disconnect is a no-op mid-handshake, so the socket is closed
    // once the aborted connect settles instead of leaking.
    expect(harness.channel.disconnect).not.toHaveBeenCalled();
    releaseConnect();
    await vi.waitFor(() => expect(harness.channel.disconnect).toHaveBeenCalledOnce());
  });

  it('hands a terminal Feishu connection back to the runtime', async () => {
    vi.useFakeTimers();
    try {
      const harness = makeFeishuHarness();
      const controller = new AbortController();
      const onError = vi.fn();
      const running = feishuBridge(harness).connect({ config: ownerConfig(), signal: controller.signal, onError, onMessage: vi.fn() });
      await vi.advanceTimersByTimeAsync(0);
      expect(onError).not.toHaveBeenCalled();

      // The vendor gives up after its bounded reconnect attempts and reports a
      // terminal state without emitting `reconnected`.
      harness.channel.getConnectionStatus.mockReturnValue({ state: 'failed' });
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(running).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledOnce();
      expect(onError.mock.calls[0][0]).toMatchObject({ code: 'network_error' });
      expect(harness.channel.disconnect).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps one HTTP attempt and sends text to the fixed owner with a stable uuid', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body) });
      if (String(url).includes('tenant_access_token')) {
        return new Response(JSON.stringify({ code: 0, tenant_access_token: 't_1', expire: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_sent' } }), { status: 200 });
    });
    const bridge = createFeishuSdkAdapter({ fetchImpl });
    const id = `row-${'x'.repeat(80)}`;
    await bridge.send({
      config: ownerConfig(),
      text: 'hi',
      id,
      // A stray target must never redirect the outbound chat.
      target: 'ou_attacker',
      signal: new AbortController().signal,
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/open-apis/auth/v3/tenant_access_token/internal',
      '/open-apis/im/v1/messages',
    ]);
    expect(calls[0].body).toEqual({ app_id: 'cli_x', app_secret: 'secret' });
    expect(calls[1].body).toMatchObject({ receive_id: 'ou_owner', msg_type: 'text', content: JSON.stringify({ text: 'hi' }), uuid: outboundUuid(id) });
    expect(calls[1].body.uuid).toHaveLength(40);
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(fetchImpl.mock.calls[1][1].headers.Authorization).toBe('Bearer t_1');
  });

  it('marks an uncertain Feishu send ambiguous and keeps auth failures explicit', async () => {
    const bridge = createFeishuSdkAdapter({
      fetchImpl: async (url) => (String(url).includes('tenant_access_token')
        ? new Response(JSON.stringify({ code: 0, tenant_access_token: 't_1', expire: 7200 }), { status: 200 })
        : new Response('upstream detail', { status: 502 })),
    });
    await expect(bridge.send({ config: ownerConfig(), text: 'hi', id: 'r1' }))
      .rejects.toMatchObject({ code: 'network_error', ambiguous: true });
    await expect(createFeishuSdkAdapter({ fetchImpl: async () => new Response('', { status: 403 }) })
      .send({ config: ownerConfig(), text: 'hi', id: 'r1' }))
      .rejects.toMatchObject({ code: 'auth_expired' });
  });
});

describe('installed SDK surfaces', () => {
  it('constructs the real Feishu channel with the public raw hook the bridge depends on', () => {
    const noop = { debug() {}, info() {}, warn() {}, error() {}, trace() {} };
    const channel = createLarkChannel({ appId: 'cli_x', appSecret: 'secret', logger: noop });
    expect(typeof channel.onRawEvent).toBe('function');
    expect(typeof channel.on).toBe('function');
    expect(typeof channel.getBotIdentity).toBe('function');
    expect(typeof channel.connect).toBe('function');
    expect(typeof channel.disconnect).toBe('function');
  });

});

describe('assistant channel provider registry', () => {
  it('exposes the three SDK providers without opening a connection', () => {
    const registry = createAssistantChannelAdapters();
    expect(Object.keys(registry).sort()).toEqual(['dingtalk', 'feishu', 'wecom']);
    for (const bridge of Object.values(registry)) {
      expect(typeof bridge.connect).toBe('function');
      expect(typeof bridge.send).toBe('function');
    }
  });

  it('normalizes a real Feishu text event through the installed channel SDK', async () => {
    const harness = makeFeishuHarness();
    const controller = new AbortController();
    const onMessage = vi.fn();
    const running = feishuBridge(harness, { normalizeEvent: undefined })
      .connect({ config: ownerConfig(), signal: controller.signal, onMessage });
    await vi.waitFor(() => expect(harness.rawHandlers.has('im.message.receive_v1')).toBe(true));
    await harness.rawHandlers.get('im.message.receive_v1')({
      sender: { sender_id: { open_id: 'ou_owner' }, sender_type: 'user' },
      message: {
        message_id: 'om_real',
        chat_id: 'oc_dm',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'real hello' }),
        create_time: String(Date.now()),
      },
    });
    expect(onMessage).toHaveBeenCalledOnce();
    expect(onMessage.mock.calls[0][0]).toMatchObject({ id: 'om_real', senderID: 'ou_owner', chatType: 'private', text: 'real hello' });
    controller.abort();
    await running;
  });
});
