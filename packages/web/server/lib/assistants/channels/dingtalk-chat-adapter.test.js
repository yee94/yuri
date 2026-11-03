import { Message, NotImplementedError, parseMarkdown, stringifyMarkdown } from 'chat';
import { EventEmitter } from 'node:events';
import { DWClient } from 'dingtalk-stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDingtalkSdkAdapter, DingTalkChatAdapter } from './dingtalk-chat-adapter.js';

const TOPIC = '/v1.0/im/bot/messages/get';

class FakeDingTalkClient extends EventEmitter {
  constructor({ register = true, hangConnect = false } = {}) {
    super();
    this.connected = false;
    this.registered = false;
    this.registerOnConnect = register;
    this.hangConnect = hangConnect;
    this.acks = [];
    this.disconnects = 0;
    this.connectCalls = 0;
    this.topics = new Map();
  }

  registerCallbackListener(topic, callback) {
    this.topics.set(topic, callback);
    return this;
  }

  async connect() {
    this.connectCalls += 1;
    if (this.hangConnect) return new Promise(() => {});
    this.connected = true;
    if (this.registerOnConnect) {
      this.registered = true;
      this.onSystem({ headers: { topic: 'REGISTERED' } });
    }
  }

  // Matches the SDK: instance-level wiring overrides this prototype method.
  onSystem() {}

  disconnect() {
    this.disconnects += 1;
    this.connected = false;
    this.registered = false;
  }

  socketCallBackResponse(messageId, payload) {
    this.acks.push({ messageId, payload });
  }

  deliver(frame) {
    return this.topics.get(TOPIC)(frame);
  }
}

function frame(body, messageId = 'm1') {
  return { headers: { messageId, topic: TOPIC }, data: JSON.stringify(body) };
}

function textBody(overrides = {}) {
  return {
    conversationType: '1',
    msgId: 'm1',
    msgtype: 'text',
    text: { content: '你好' },
    senderStaffId: 'owner_1',
    senderId: 'sender_1',
    senderNick: 'Owner',
    chatbotUserId: 'bot_1',
    sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?session=secret',
    ...overrides,
  };
}

function harness(options = {}) {
  const clients = [];
  const clientFactory = () => {
    const client = new FakeDingTalkClient(options);
    clients.push(client);
    return client;
  };
  return { clients, clientFactory };
}

function bridgeFor(value, extra = {}) {
  return createDingtalkSdkAdapter({ clientFactory: value.clientFactory, ...extra });
}

const config = { clientID: 'ding_client', clientSecret: 'ding_secret', ownerID: 'owner_1' };

afterEach(() => {
  vi.useRealTimers();
});

describe('dingtalk Chat SDK adapter', () => {
  it('accepts platform-scoped private senders without a binding and replies to the persisted user', async () => {
    const h = harness();
    const controller = new AbortController();
    const onReady = vi.fn();
    const onMessage = vi.fn();
    const fetchImpl = vi.fn(async (url) => new Response(JSON.stringify(String(url).includes('accessToken')
      ? { accessToken: 'token', expireIn: 7200 } : {}), { status: 200 }));
    const bridge = bridgeFor(h, { fetchImpl });
    const unbound = { ...config, ownerID: '' };
    const running = bridge.connect({ config: unbound, signal: controller.signal, onReady, onMessage });
    try {
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
      await h.clients[0].deliver(frame(textBody({ senderStaffId: 'alice' })));
      await h.clients[0].deliver(frame(textBody({ senderStaffId: 'bob' })));
      await h.clients[0].deliver(frame(textBody({ senderStaffId: 'bob', conversationType: '2' })));
      expect(onMessage.mock.calls.map(([message]) => message.senderID)).toEqual(['alice', 'bob']);
      await expect(bridge.send({ config: unbound, text: 'no recipient' })).rejects.toMatchObject({ code: 'invalid_response' });
      await bridge.send({ config: unbound, target: { userID: 'alice' }, text: 'hello' });
      expect(JSON.parse(fetchImpl.mock.calls[1][1].body).userIds).toEqual(['alice']);
    } finally { controller.abort(); await running; }
  });

  it('reports ready only after REGISTERED and keeps the gateway ACK behind durable delivery', async () => {
    const h = harness();
    const controller = new AbortController();
    const onReady = vi.fn();
    const onMessage = vi.fn();
    const running = bridgeFor(h).connect({ config, signal: controller.signal, onReady, onMessage });

    await vi.waitFor(() => expect(h.clients).toHaveLength(1));
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    expect(h.clients[0].registered).toBe(true);

    let release;
    onMessage.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const delivered = h.clients[0].deliver(frame(textBody()));
    await Promise.resolve();
    expect(h.clients[0].acks).toHaveLength(0);
    release();
    await delivered;
    expect(h.clients[0].acks).toEqual([{ messageId: 'm1', payload: {} }]);

    controller.abort();
    await running;
    expect(h.clients[0].disconnects).toBe(1);
  });

  it('runs an independent session per config and rejects a duplicate live connect', async () => {
    const h = harness();
    const first = new AbortController();
    const second = new AbortController();
    const onReady = vi.fn();
    const bridge = bridgeFor(h);
    const running1 = bridge.connect({ config, signal: first.signal, onReady, onMessage: vi.fn() });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));

    const otherConfig = { clientID: 'ding_client_b', clientSecret: 'ding_secret_b', ownerID: 'owner_2' };
    const running2 = bridge.connect({ config: otherConfig, signal: second.signal, onReady, onMessage: vi.fn() });
    await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(2));
    // One long connection per config, not a single shared adapter instance.
    expect(h.clients).toHaveLength(2);
    expect(h.clients[0]).not.toBe(h.clients[1]);

    await expect(bridge.connect({ config, signal: new AbortController().signal, onMessage: vi.fn() }))
      .rejects.toMatchObject({ code: 'channel_in_use' });

    first.abort();
    second.abort();
    await Promise.all([running1, running2]);
    expect(h.clients.every((client) => client.disconnects === 1)).toBe(true);
  });

  it('does not claim ready when the gateway never registers', async () => {
    vi.useFakeTimers();
    const h = harness({ register: false });
    const controller = new AbortController();
    const onReady = vi.fn();
    const running = bridgeFor(h).connect({ config, signal: controller.signal, onReady, onMessage: vi.fn() });
    const rejection = expect(running).rejects.toMatchObject({ code: 'network_error' });
    await vi.advanceTimersByTimeAsync(21_000);
    await rejection;
    expect(onReady).not.toHaveBeenCalled();
    expect(h.clients[0].disconnects).toBe(1);
  });

  it('aborts a connect that never settles and disconnects the SDK client', async () => {
    const h = harness({ hangConnect: true });
    const controller = new AbortController();
    const onReady = vi.fn();
    const running = bridgeFor(h).connect({ config, signal: controller.signal, onReady, onMessage: vi.fn() });

    await vi.waitFor(() => expect(h.clients).toHaveLength(1));
    expect(h.clients[0].connectCalls).toBe(1);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    expect(onReady).not.toHaveBeenCalled();
    expect(h.clients[0].disconnects).toBe(1);
  });

  it('acknowledges only authorized single-chat owner messages', async () => {
    const h = harness();
    const controller = new AbortController();
    const onMessage = vi.fn();
    const running = bridgeFor(h).connect({ config, signal: controller.signal, onMessage });
    await vi.waitFor(() => expect(h.clients).toHaveLength(1));
    await vi.waitFor(() => expect(h.clients[0].registered).toBe(true));

    const client = h.clients[0];
    await client.deliver(frame(textBody({ conversationType: '2', conversationId: 'group_1' }), 'm2'));
    await client.deliver(frame(textBody({ senderStaffId: 'owner_2' }), 'm3'));
    await client.deliver(frame(textBody({ senderStaffId: undefined, senderId: 'bot_1' }), 'm4'));
    expect(onMessage).not.toHaveBeenCalled();
    expect(client.acks.map((ack) => ack.messageId)).toEqual(['m2', 'm3', 'm4']);

    await client.deliver(frame(textBody({ msgId: 'm5', msgtype: 'picture', text: undefined }), 'm5'));
    expect(onMessage).toHaveBeenCalledOnce();
    const [message] = onMessage.mock.calls[0];
    expect(message).toMatchObject({ id: 'm5', senderID: 'owner_1', chatType: 'private', text: '', metadata: { platform: 'dingtalk', notDownloaded: true, mediaType: 'picture' } });
    expect(JSON.stringify(message)).not.toContain('sessionWebhook');
    expect(JSON.stringify(message)).not.toContain('bot_1');

    controller.abort();
    await running;
  });

  it('consumes platform speech recognition and rich text without inventing a transcript', async () => {
    const h = harness();
    const controller = new AbortController();
    const onMessage = vi.fn();
    const running = bridgeFor(h).connect({ config, signal: controller.signal, onMessage });
    await vi.waitFor(() => expect(h.clients[0]?.registered).toBe(true));

    await h.clients[0].deliver(frame(textBody({
      msgId: 'a1',
      msgtype: 'audio',
      text: undefined,
      content: { recognition: '明天上午开会', downloadCode: 'dc_secret' },
    }), 'a1'));
    expect(onMessage.mock.calls[0][0]).toMatchObject({
      id: 'a1', text: '明天上午开会', metadata: { transcript: 'platform' },
    });
    expect(JSON.stringify(onMessage.mock.calls[0][0])).not.toContain('dc_secret');

    await h.clients[0].deliver(frame(textBody({
      msgId: 'a2',
      msgtype: 'audio',
      text: undefined,
      content: { downloadCode: 'dc_secret' },
    }), 'a2'));
    expect(onMessage.mock.calls[1][0]).toMatchObject({
      id: 'a2', text: '', metadata: { notDownloaded: true, mediaType: 'audio' },
    });
    expect(onMessage.mock.calls[1][0].metadata).not.toHaveProperty('transcript');

    await h.clients[0].deliver(frame(textBody({
      msgId: 'r1',
      msgtype: 'richText',
      text: undefined,
      content: { richText: [{ text: '第一行' }, { type: 'picture', downloadCode: 'x' }, { text: '第二行' }] },
    }), 'r1'));
    expect(onMessage.mock.calls[2][0]).toMatchObject({
      id: 'r1', text: '第一行\n第二行', metadata: { format: 'richText' },
    });

    controller.abort();
    await running;
  });

  it('leaves failed deliveries unacknowledged so the platform can retry', async () => {
    const h = harness();
    const controller = new AbortController();
    const onError = vi.fn();
    const onMessage = vi.fn(async () => { throw new Error('sqlite busy'); });
    const running = bridgeFor(h).connect({ config, signal: controller.signal, onMessage, onError });
    await vi.waitFor(() => expect(h.clients[0]?.registered).toBe(true));
    await h.clients[0].deliver(frame(textBody()));
    expect(h.clients[0].acks).toHaveLength(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'network_error' }));
    controller.abort();
    await running;
  });

  it('keeps the standalone initialize deliver path owner-and-single-chat scoped', async () => {
    const h = harness();
    const adapter = new DingTalkChatAdapter({
      clientId: 'ding_client',
      clientSecret: 'ding_secret',
      ownerId: 'owner_1',
      clientFactory: h.clientFactory,
    });
    const processed = [];
    await adapter.initialize({
      processMessage: (_adapter, threadId, factory) => { processed.push({ threadId, factory }); },
    });
    const client = h.clients[0];

    await client.deliver(frame(textBody({ msgId: 'g1', conversationType: '2', conversationId: 'group_1' }), 'g1'));
    await client.deliver(frame(textBody({ msgId: 'u1', senderStaffId: 'owner_2' }), 'u1'));
    expect(processed).toHaveLength(0);

    await client.deliver(frame(textBody({ msgId: 'u2' }), 'u2'));
    expect(processed).toHaveLength(1);
    expect(processed[0].threadId).toBe('dingtalk:private:owner_1');

    await adapter.disconnect();
    expect(client.disconnects).toBe(1);
  });

  it('sends proactive direct messages to the configured owner with a cached token', async () => {
    const calls = [];
    const fetchImpl = vi.fn(async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
      if (String(url).includes('/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'at_1', expireIn: 7200 }), { status: 200 });
      }
      return new Response(JSON.stringify({ processQueryKey: 'q1' }), { status: 200 });
    });
    const bridge = createDingtalkSdkAdapter({ clientFactory: harness().clientFactory, fetchImpl });
    // A stray `target` must never redirect DingTalk outbound traffic.
    await bridge.send({ config, target: 'someone_else', text: 'hello', id: 'r1' });
    await bridge.send({ config, target: 'someone_else', text: 'again', id: 'r2' });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      '/v1.0/oauth2/accessToken',
      '/v1.0/robot/oToMessages/batchSend',
      '/v1.0/robot/oToMessages/batchSend',
    ]);
    expect(calls[0].body).toEqual({ appKey: 'ding_client', appSecret: 'ding_secret' });
    expect(calls[1].body).toEqual({ robotCode: 'ding_client', userIds: ['owner_1'], msgKey: 'sampleText', msgParam: JSON.stringify({ content: 'hello' }) });
    expect(calls[1].headers['x-acs-dingtalk-access-token']).toBe('at_1');
    expect(fetchImpl.mock.calls[1][1]).toMatchObject({ method: 'POST', redirect: 'error' });
  });

  it('keeps send ambiguity and recipient throttling distinct', async () => {
    const base = { clientID: 'ding_client_2', clientSecret: 'ding_secret_2', ownerID: 'owner_1' };
    const bridge = createDingtalkSdkAdapter({
      fetchImpl: async (url) => (String(url).includes('/oauth2/accessToken')
        ? new Response(JSON.stringify({ accessToken: 'at_2', expireIn: 7200 }), { status: 200 })
        : new Response('', { status: 502 })),
    });
    await expect(bridge.send({ config: base, text: 'hi', id: 'r1' }))
      .rejects.toMatchObject({ code: 'network_error', ambiguous: true });

    for (const field of ['invalidStaffIdList', 'flowControlledStaffIdList', 'filteredStaffIdList']) {
      const rejected = createDingtalkSdkAdapter({
        fetchImpl: async (url) => (String(url).includes('/oauth2/accessToken')
          ? new Response(JSON.stringify({ accessToken: 'at_3', expireIn: 7200 }), { status: 200 })
          : new Response(JSON.stringify({ [field]: ['owner_1'] }), { status: 200 })),
      });
      await expect(rejected.send({
        config: { ...base, clientID: `ding_${field}`, clientSecret: `ding_${field}` },
        text: 'hi',
        id: 'r2',
      })).rejects.toMatchObject({ code: 'network_error', ambiguous: false });
    }
  });
});

describe('dingtalk Chat SDK adapter contract', () => {
  it('relies on the installed dingtalk-stream surface', () => {
    const client = new DWClient({
      clientId: 'ding_client',
      clientSecret: 'ding_secret',
      subscriptions: [{ type: 'CALLBACK', topic: TOPIC }],
    });
    expect(typeof client.connect).toBe('function');
    expect(typeof client._connect).toBe('function');
    expect(typeof client.onSystem).toBe('function');
    expect(typeof client.registerCallbackListener).toBe('function');
    expect(typeof client.socketCallBackResponse).toBe('function');
    expect(typeof client.disconnect).toBe('function');
    expect(client.connected).toBe(false);
    expect(client.registered).toBe(false);
  });

  it('separates private from group threads and supports standard postables', async () => {
    const adapter = new DingTalkChatAdapter({ clientId: 'ding_client', clientSecret: 'ding_secret', ownerId: 'owner_1' });
    expect(adapter.name).toBe('dingtalk');
    expect(adapter.openDM('owner_1')).toBe('dingtalk:private:owner_1');
    expect(adapter.decodeThreadId('dingtalk:private:owner_1')).toEqual({ chatType: 'private', id: 'owner_1' });
    expect(adapter.channelIdFromThreadId('dingtalk:private:owner_1')).toBe('owner_1');
    expect(adapter.isDM('dingtalk:private:owner_1')).toBe(true);
    expect(adapter.isDM('dingtalk:group:group_1')).toBe(false);

    const message = adapter.parseMessage({
      msgId: 'm1', conversationType: '1', senderStaffId: 'owner_1', msgtype: 'text', text: { content: 'hi' },
    });
    expect(message).toBeInstanceOf(Message);
    expect(message.threadId).toBe('dingtalk:private:owner_1');
    const group = adapter.parseMessage({
      msgId: 'm2', conversationType: '2', conversationId: 'group_1', senderStaffId: 'owner_1', msgtype: 'text', text: { content: 'hi' },
    });
    expect(group.threadId).toBe('dingtalk:group:group_1');
    expect(group).toBeInstanceOf(Message);

    expect(adapter.renderFormatted(parseMarkdown('**hi** and *x*'))).toBe('**hi** and *x*\n');
    expect(adapter.renderFormatted('plain')).toBe('plain');

    await expect(adapter.postMessage('dingtalk:group:group_1', { raw: 'hi' }))
      .rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.postMessage('dingtalk:private:someone_else', { raw: 'hi' }))
      .rejects.toMatchObject({ code: 'invalid_response' });

    await expect(adapter.editMessage()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.fetchMessages()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.addReaction()).rejects.toBeInstanceOf(NotImplementedError);
    await expect(adapter.startTyping()).rejects.toBeInstanceOf(NotImplementedError);
    const response = await adapter.handleWebhook();
    expect(response.status).toBe(501);
    expect(await response.text()).not.toContain('secret');
  });

  it('renders every standard postable shape through the same text projection', () => {
    const adapter = new DingTalkChatAdapter({ clientId: 'ding_client', clientSecret: 'ding_secret', ownerId: 'owner_1' });
    const ast = parseMarkdown('**bold**');
    expect(adapter.renderFormatted(ast)).toBe(stringifyMarkdown(ast));
    expect(adapter.renderFormatted({ raw: 'raw text' })).toBe('raw text');
    expect(adapter.renderFormatted({ markdown: '**md**' })).toBe('**md**');
    expect(adapter.renderFormatted({ ast })).toBe(stringifyMarkdown(ast));
    expect(adapter.renderFormatted({ text: 'not-standard' })).toBe('');
  });
});
