import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssistantChannelsRuntime } from './runtime.js';
import { createAssistantChannelStore } from './store.js';
import { createAssistantsService } from '../service.js';

const Database = createRequire(import.meta.url)('better-sqlite3');

const closers = [];
afterEach(async () => { while (closers.length) await closers.pop()(); });
const root = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-channels-'));
  closers.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

const abortable = (signal) => new Promise((_, reject) => {
  const error = Object.assign(new Error('cancelled'), { code: 'cancelled' });
  if (signal.aborted) { reject(error); return; }
  signal.addEventListener('abort', () => reject(error), { once: true });
});

function fixture({ directory = root(), service: externalService, env = {}, intervalMs = 10, autoReady = true, includeDingtalk = false, discoveryTimeoutMs } = {}) {
  const pages = new Map();
  const seen = new Set();
  const service = externalService ?? {
    snapshot: () => ({ assistants: [...seen].map((id) => ({ id, name: id })) }),
    channelPage: vi.fn((id, { afterOrdinal = 0, generation = null, tipOnly = false } = {}) => {
      if (id === 'missing') throw Object.assign(new Error('not_found'), { code: 'not_found' });
      seen.add(id);
      const page = pages.get(id) ?? { generation: 0, messages: [] };
      const after = generation === null || generation === page.generation ? afterOrdinal : 0;
      const messages = tipOnly ? [] : page.messages.filter((message) => message.ordinal > after).slice(0, 50);
      return {
        generation: page.generation,
        tipOrdinal: page.messages.at(-1)?.ordinal ?? 0,
        ordinal: messages.at(-1)?.ordinal ?? after,
        messages,
      };
    }),
    send: vi.fn(async () => ({ admitted: true })),
  };
  const connections = [];
  const adapter = {
    connect: vi.fn(async (input) => {
      const connection = { ...input };
      connections.push(connection);
      if (autoReady) input.onReady();
      await abortable(input.signal);
    }),
    send: vi.fn(async () => {}),
  };
  const runtime = createAssistantChannelsRuntime({
    directory,
    service,
    adapters: { wecom: adapter, feishu: adapter, ...(includeDingtalk ? { dingtalk: adapter } : {}) },
    env,
    intervalMs,
    discoveryTimeoutMs,
  });
  closers.push(() => runtime.close());
  const save = (assistantID = 'bot', provider = 'wecom', input = {}) => runtime.save(assistantID, provider, {
    clientID: 'client', clientSecret: 'secret', ownerID: 'owner', language: 'zh-CN', ...input,
  });
  const seedLegacyUnrestricted = () => {
    const store = createAssistantChannelStore(directory);
    try {
      store.bind({ assistant_id: 'bot', provider: 'wecom', client_id: 'client', client_secret: 'secret', owner_id: '', language: 'zh-CN', generation: 0, ordinal: 0, updated_at: 1 });
    } finally { store.close(); }
  };
  const connected = async (assistantID = 'bot', provider = 'wecom') => {
    await vi.waitFor(
      () => expect(runtime.status(assistantID, provider).status).toBe('connected'),
      { interval: 10, timeout: 3000 },
    );
    return connections.at(-1);
  };
  const reply = (assistantID = 'bot', text = 'reply', ordinal = 1, generation = 0) => pages.set(assistantID, {
    generation,
    messages: [{ ordinal, messageID: `reply-${ordinal}`, text, cards: [], status: 'complete' }],
  });
  return { directory, runtime, service, adapter, connections, pages, save, connected, reply, seedLegacyUnrestricted };
}

describe('enterprise channel runtime', () => {
  it.each(['wecom', 'feishu', 'dingtalk'])('discovers %s from a private message without saving credentials or executing tasks', async (provider) => {
    const f = fixture({ includeDingtalk: true });
    const probe = f.runtime.discover('bot', provider, { clientID: 'client', clientSecret: 'secret' });
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    const connection = f.connections[0];
    expect(f.runtime.status('bot', provider).configured).toBe(false);
    expect(await connection.onMessage({ senderID: 'group-user', chatType: 'group' })).toBe(false);
    expect(await connection.onMessage({ senderID: '', chatType: 'private' })).toBe(false);
    expect(await connection.onMessage({ senderID: 'user_1', chatType: 'private', text: 'detect me' })).toBe(true);
    await expect(probe).resolves.toEqual({ ownerID: 'user_1' });
    expect(connection.signal.aborted).toBe(true);
    expect(f.service.send).not.toHaveBeenCalled();
    expect(f.runtime.status('bot', provider).configured).toBe(false);
    await f.save('bot', provider, { ownerID: 'user_1' });
    expect(f.runtime.status('bot', provider)).toMatchObject({ configured: true, ownerID: 'user_1' });
  });

  it('rejects empty owner IDs at the save boundary, including existing bindings', async () => {
    const f = fixture();
    await expect(f.save('bot', 'wecom', { ownerID: '' })).rejects.toMatchObject({ code: 'owner_required' });
    await f.save();
    await expect(f.save('bot', 'wecom', { ownerID: undefined })).rejects.toMatchObject({ code: 'owner_required' });
    expect(f.runtime.status('bot', 'wecom').ownerID).toBe('owner');
  });

  it('cancels discovery and resumes the untouched saved connection, without reusing secrets across accounts', async () => {
    const f = fixture();
    await f.save();
    const original = await f.connected();
    const controller = new AbortController();
    const probe = f.runtime.discover('bot', 'wecom', { clientID: 'client' }, { signal: controller.signal });
    const result = expect(probe).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(f.connections).toHaveLength(2));
    expect(original.signal.aborted).toBe(true);
    expect(f.connections[1].config.clientSecret).toBe('secret');
    controller.abort();
    await result;
    await vi.waitFor(() => expect(f.connections).toHaveLength(3));
    expect(f.connections[2].signal.aborted).toBe(false);
    expect(f.runtime.status('bot', 'wecom')).toMatchObject({ clientID: 'client', ownerID: 'owner', configured: true });
    await expect(f.runtime.discover('bot', 'wecom', { clientID: 'new-account' })).rejects.toMatchObject({ code: 'validation_error' });
  });

  it('expires a probe and cleans up its lane so it can be retried', async () => {
    const f = fixture({ discoveryTimeoutMs: 50 });
    await expect(f.runtime.discover('bot', 'wecom', { clientID: 'client', clientSecret: 'secret' })).rejects.toMatchObject({ code: 'discovery_timeout' });
    expect(f.connections[0].signal.aborted).toBe(true);
    expect(f.runtime.status('bot', 'wecom').configured).toBe(false);
    await f.save();
  });

  it('fences competing discovery/save lanes and does not take an account from another Bot', async () => {
    const f = fixture();
    const controller = new AbortController();
    const input = { clientID: 'client', clientSecret: 'secret' };
    const probe = f.runtime.discover('bot', 'wecom', input, { signal: controller.signal });
    const result = expect(probe).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    await expect(f.runtime.discover('other', 'wecom', input)).rejects.toMatchObject({ code: 'account_in_use' });
    await expect(f.save('other')).rejects.toMatchObject({ code: 'account_in_use' });
    await expect(f.save()).rejects.toMatchObject({ code: 'channel_in_use' });
    controller.abort();
    await result;
    await f.save();
    await expect(f.runtime.discover('other', 'wecom', input)).rejects.toMatchObject({ code: 'account_in_use' });
  });

  it('redacts discovery authentication failures and cancels an unsaved probe on shutdown', async () => {
    const f = fixture();
    const probe = f.runtime.discover('bot', 'wecom', { clientID: 'client', clientSecret: 'secret' });
    const failed = expect(probe).rejects.toMatchObject({ code: 'auth_failed', message: 'auth_failed' });
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    f.connections[0].onError(Object.assign(new Error('private upstream payload'), { code: 'auth_failed' }));
    await failed;
    const next = f.runtime.discover('bot', 'wecom', { clientID: 'client', clientSecret: 'secret' });
    const cancelled = expect(next).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(f.connections).toHaveLength(2));
    await f.runtime.close();
    await cancelled;
    expect(f.connections[1].signal.aborted).toBe(true);
  });

  it('cancels discovery when its Bot is forgotten, including probes with no saved binding', async () => {
    const f = fixture();
    const probe = f.runtime.discover('bot', 'wecom', { clientID: 'client', clientSecret: 'secret' });
    const cancelled = expect(probe).rejects.toMatchObject({ code: 'cancelled' });
    await vi.waitFor(() => expect(f.connections).toHaveLength(1));
    await f.runtime.forget('bot');
    await cancelled;
    expect(f.connections[0].signal.aborted).toBe(true);
    expect(f.runtime.status('bot', 'wecom').configured).toBe(false);
  });

  it('replies only on the originating channel and to its original sender; source-less output is pushed', async () => {
    const f = fixture();
    f.seedLegacyUnrestricted();
    const wecom = await f.connected('bot', 'wecom');
    await f.save('bot', 'feishu');
    const feishu = await f.connected('bot', 'feishu');
    await wecom.onMessage({ id: 'alice-message', senderID: 'alice', chatType: 'private', text: 'a' });
    await wecom.onMessage({ id: 'bob-message', senderID: 'bob', chatType: 'private', text: 'b' });
    await feishu.onMessage({ id: 'feishu-message', senderID: 'owner', chatType: 'private', text: 'f' });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(3));
    const turnFor = (text) => f.service.send.mock.calls.find(([, input]) => input.parts.some((part) => part.text === text))[1].messageID;
    const aliceTurn = turnFor('a');
    f.pages.set('bot', { generation: 0, messages: [
      { ordinal: 1, messageID: 'r-a', turnID: aliceTurn, text: 'alice reply', cards: [], status: 'complete' },
      { ordinal: 2, messageID: 'r-b', turnID: turnFor('b'), text: 'bob reply', cards: [], status: 'complete' },
      { ordinal: 3, messageID: 'r-f', turnID: turnFor('f'), text: 'feishu reply', cards: [], status: 'complete' },
      { ordinal: 4, messageID: 'r-w', turnID: 'weixin:other-turn', text: 'wechat only', cards: [], status: 'complete' },
      { ordinal: 5, messageID: 'push', turnID: 'app-turn', text: 'proactive push', cards: [], status: 'complete' },
    ] });
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledTimes(5));
    const deliveries = f.adapter.send.mock.calls.map(([input]) => input);
    expect(deliveries.filter((input) => input.config.clientID === 'client' && input.config.ownerID === '').map((input) => [input.text, input.target.userID]))
      .toEqual([['alice reply', 'alice'], ['bob reply', 'bob'], ['proactive push', 'bob']]);
    expect(deliveries.filter((input) => input.config.ownerID === 'owner').map((input) => input.text))
      .toEqual(['feishu reply', 'proactive push']);
    for (const [, input] of f.service.send.mock.calls) f.runtime.onTurnEvent({ type: 'yuri:contact-turn-end', properties: { turnID: input.messageID } });
    await f.runtime.close();
    const restarted = fixture({ directory: f.directory });
    restarted.pages.set('bot', { generation: 0, messages: [
      { ordinal: 6, messageID: 'late-r-a', turnID: aliceTurn, text: 'late alice reply', cards: [], status: 'complete' },
    ] });
    await vi.waitFor(() => expect(restarted.adapter.send).toHaveBeenCalledOnce());
    expect(restarted.adapter.send.mock.calls[0][0]).toMatchObject({ text: 'late alice reply', target: { userID: 'alice' } });
  });

  it.each(['wecom', 'feishu', 'dingtalk'])('keeps ordinary %s text as exactly one original text part', async (provider) => {
    const f = fixture({ includeDingtalk: true });
    await f.save('bot', provider);
    const connection = await f.connected('bot', provider);
    await connection.onMessage({ id: 'plain', senderID: 'owner', chatType: 'private', text: 'halo', metadata: { platform: provider, chatType: 'private' } });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledOnce());
    expect(f.service.send.mock.calls[0][1].parts).toEqual([{ type: 'text', text: 'halo' }]);
  });

  it('retains actual media metadata without leaking internal routing labels', async () => {
    const f = fixture();
    await f.save();
    const connection = await f.connected();
    await connection.onMessage({ id: 'image', senderID: 'owner', chatType: 'private', text: '', metadata: { platform: 'wecom', chatType: 'private', notDownloaded: true, resources: [{ type: 'image' }] } });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledOnce());
    const parts = f.service.send.mock.calls[0][1].parts;
    expect(parts).toHaveLength(1);
    expect(parts[0].text).toContain('notDownloaded: true');
    expect(parts[0].text).toContain('image');
    expect(parts[0].text).not.toMatch(/platform:|chatType:/);
  });

  it.each(['wecom', 'feishu'])('moves %s to the selected Bot without forwarding old work or moving other providers', async (provider) => {
    const f = fixture();
    await f.save('bot', provider);
    const previous = await f.connected('bot', provider);
    await previous.onMessage({ id: 'one', senderID: 'owner', chatType: 'private', text: 'old request' });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledOnce());
    const otherProvider = provider === 'wecom' ? 'feishu' : 'wecom';
    await f.save('bot', otherProvider);
    const source = f.runtime.status('other', provider).transferSources[0];
    expect(source).toMatchObject({ assistantID: 'bot', name: 'bot', clientID: 'client' });
    expect(JSON.stringify(source)).not.toContain('secret');
    await expect(f.runtime.transfer('other', provider, { sourceAssistantID: 'bot', revision: 'stale' })).rejects.toMatchObject({ code: 'binding_changed' });
    expect(previous.signal.aborted).toBe(false);
    f.reply('other', 'existing target history', 10);
    await f.runtime.transfer('other', provider, { sourceAssistantID: 'bot', revision: source.revision });
    expect(previous.signal.aborted).toBe(true);
    expect(f.runtime.status('bot', provider).configured).toBe(false);
    expect(f.runtime.status('bot', otherProvider).configured).toBe(true);
    const moved = await f.connected('other', provider);
    await moved.onMessage({ id: 'one', senderID: 'owner', chatType: 'private', text: 'replay' });
    expect(f.service.send).toHaveBeenCalledOnce();
    await moved.onMessage({ id: 'two', senderID: 'owner', chatType: 'private', text: 'new request' });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(2));
    expect(f.service.send.mock.calls[1][0]).toBe('other');
    expect(f.adapter.send).not.toHaveBeenCalled();
  });

  it('resumes the source binding when the target disappears while a transfer drains', async () => {
    const f = fixture();
    await f.save();
    const connection = await f.connected();
    const source = f.runtime.status('other', 'wecom').transferSources[0];
    const original = f.service.channelPage.getMockImplementation();
    let deleted = false;
    f.service.channelPage.mockImplementation((id, options) => {
      if (id === 'other' && deleted) throw Object.assign(new Error('not_found'), { code: 'not_found' });
      return original(id, options);
    });
    connection.signal.addEventListener('abort', () => { deleted = true; }, { once: true });
    await expect(f.runtime.transfer('other', 'wecom', { sourceAssistantID: 'bot', revision: source.revision })).rejects.toMatchObject({ code: 'not_found' });
    await vi.waitFor(() => expect(f.connections.length).toBeGreaterThan(1));
    const resumed = await f.connected();
    expect(resumed.signal.aborted).toBe(false);
    expect(f.runtime.status('bot', 'wecom').configured).toBe(true);
  });

  it('preserves legacy unrestricted bindings until explicitly restricted by a save', async () => {
    const f = fixture();
    f.seedLegacyUnrestricted();
    const connection = await f.connected();
    f.reply('bot', 'no recipient yet', 1);
    await vi.waitFor(() => expect(f.service.channelPage).toHaveBeenCalled(), { interval: 10 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(f.adapter.send).not.toHaveBeenCalled();
    await connection.onMessage({ id: 'same-platform-id', senderID: 'alice', chatType: 'private', text: 'hello', target: { userID: 'forged' } });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(1), { interval: 10 });
    f.reply('bot', 'reply to alice', 2);
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledTimes(1), { interval: 10 });
    expect(f.adapter.send.mock.calls[0][0]).toMatchObject({ target: { userID: 'alice' } });
    await connection.onMessage({ id: 'same-platform-id', senderID: 'bob', chatType: 'private', text: 'hello again' });
    await connection.onMessage({ id: 'group', senderID: 'bob', chatType: 'group', text: 'ignored' });
    await connection.onMessage({ id: 'missing-sender', senderID: '', chatType: 'private', text: 'ignored' });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(2), { interval: 10 });
    f.reply('bot', 'reply to bob', 3);
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledTimes(2), { interval: 10 });
    expect(f.adapter.send.mock.calls[1][0]).toMatchObject({ target: { userID: 'bob' } });
    expect(f.service.send.mock.calls[0][1].messageID).not.toBe(f.service.send.mock.calls[1][1].messageID);
    await f.save('bot', 'wecom', { ownerID: 'alice' });
    const restricted = await f.connected();
    await restricted.onMessage({ id: 'blocked', senderID: 'bob', chatType: 'private', text: 'ignored' });
    expect(f.service.send).toHaveBeenCalledTimes(2);
  });

  it.each([
    { NODE_ENV: 'development' },
    { YURI_ELECTRON_DEV: '1' },
    { YURI_ELECTRON_DEV: 'true' },
    { NODE_ENV: 'production', YURI_CHANNELS_ENABLED: '0' },
    { YURI_CHANNELS_ENABLED: 'false' },
    { YURI_CHANNELS_ENABLED: 'invalid' },
  ])('disables startup and every mutation without opening private storage for %j', async (env) => {
    const directory = path.join(root(), 'must-not-open');
    const adapter = { connect: vi.fn(), send: vi.fn() };
    const service = { channelPage: vi.fn(), send: vi.fn() };
    const runtime = createAssistantChannelsRuntime({ directory, service, adapters: { wecom: adapter }, env });
    closers.push(() => runtime.close());
    expect(runtime.status('bot', 'wecom')).toEqual({
      provider: 'wecom', status: 'disabled', error: null, configured: false,
      hasSecret: false, transport: 'websocket',
    });
    await expect(runtime.save('bot', 'wecom', {})).rejects.toMatchObject({ code: 'channel_disabled' });
    await expect(runtime.retry('bot', 'wecom')).rejects.toMatchObject({ code: 'channel_disabled' });
    await expect(runtime.disconnect('bot', 'wecom')).rejects.toMatchObject({ code: 'channel_disabled' });
    runtime.onTurnEvent({ type: 'yuri:contact-turn-end', properties: { turnID: 'turn' } });
    await runtime.forget('bot');
    await runtime.close();
    expect(fs.existsSync(directory)).toBe(false);
    expect(adapter.connect).not.toHaveBeenCalled();
    expect(adapter.send).not.toHaveBeenCalled();
    expect(service.channelPage).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
  });

  it.each(['1', 'true'])('requires an explicit %s opt-in to run channels in development', async (enabled) => {
    const f = fixture({ env: { NODE_ENV: 'development', YURI_ELECTRON_DEV: '1', YURI_CHANNELS_ENABLED: enabled } });
    await f.save();
    await f.connected();
    expect(f.connections[0].config).toEqual({
      clientID: 'client', clientSecret: 'secret', ownerID: 'owner', language: 'zh-CN',
    });
  });

  it('requires a secret on first save, keeps the old one on blank update and never serializes it', async () => {
    const f = fixture();
    await expect(f.save('bot', 'wecom', { clientSecret: '' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    const saved = await f.save();
    expect(saved).toMatchObject({
      provider: 'wecom', configured: true, clientID: 'client', ownerID: 'owner',
      hasSecret: true, transport: 'websocket',
    });
    expect(JSON.stringify(saved)).not.toContain('secret');
    const first = await f.connected();
    expect(first.config.clientSecret).toBe('secret');
    const updated = await f.save('bot', 'wecom', { clientSecret: '' });
    expect(updated).toMatchObject({ configured: true, hasSecret: true, clientID: 'client' });
    await vi.waitFor(() => expect(f.connections).toHaveLength(2), { interval: 10, timeout: 3000 });
    expect(f.connections[1].config.clientSecret).toBe('secret');
  });

  it('rejects unsupported providers and invalid provider names without opening a connection', async () => {
    const f = fixture();
    expect(() => f.runtime.status('bot', 'not a provider')).toThrow('validation_error');
    await expect(f.save('bot', 'dingtalk')).rejects.toMatchObject({ code: 'unsupported_provider' });
    await expect(f.save('missing', 'wecom')).rejects.toMatchObject({ code: 'not_found' });
    expect(f.connections).toHaveLength(0);
  });

  it('keeps one provider account assigned to one Bot', async () => {
    const f = fixture();
    await f.save('bot');
    await expect(f.save('other', 'wecom', { clientID: 'client', clientSecret: 'other' }))
      .rejects.toMatchObject({ code: 'account_in_use' });
    // Another provider may reuse the same account string.
    await expect(f.save('other', 'feishu', { clientID: 'client', clientSecret: 'other' })).resolves.toBeTruthy();
  });

  it('admits only one explicit private owner once, projects metadata and keeps targets out of context', async () => {
    const f = fixture();
    await f.save();
    const connection = await f.connected();
    const message = {
      id: 'platform-1',
      senderID: 'owner',
      chatType: 'private',
      text: 'hello',
      metadata: {
        chatName: 'Team',
        note: 'see https://private.example/media',
        token: 'private-token',
        url: 'https://private.example/hook',
        media: { full_url: 'https://cdn.example/file' },
      },
      target: { sessionWebhook: 'https://private.example/reply' },
    };
    await connection.onMessage(message);
    await connection.onMessage(message);
    await connection.onMessage({ ...message, id: 'platform-2', senderID: 'stranger' });
    await connection.onMessage({ ...message, id: 'platform-3', chatType: 'group' });
    await connection.onMessage({ ...message, id: undefined });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(1), { interval: 10 });
    const parts = f.service.send.mock.calls[0][1].parts;
    expect(parts[0]).toEqual({ type: 'text', text: 'hello' });
    expect(parts[1].text).toContain('chatName');
    expect(parts[1].text).toContain('[link omitted]');
    const serialized = JSON.stringify(parts);
    expect(serialized).not.toContain('private-token');
    expect(serialized).not.toContain('sessionWebhook');
    expect(serialized).not.toContain('private.example');
    expect(JSON.stringify(f.runtime.status('bot', 'wecom'))).not.toContain('secret');

    f.reply('bot', 'answer', 1);
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledTimes(1), { interval: 10 });
    expect(f.adapter.send.mock.calls[0][0]).toMatchObject({
      text: 'answer',
      target: { sessionWebhook: 'https://private.example/reply' },
      config: { clientID: 'client', ownerID: 'owner', language: 'zh-CN' },
    });
    expect(f.adapter.send.mock.calls[0][0].id).toMatch(/^yuri_/);
  });

  it('starts from the current contact tip so pre-binding history is not delivered', async () => {
    const f = fixture();
    f.pages.set('bot', {
      generation: 0,
      messages: [{ ordinal: 50, messageID: 'old', text: 'old history', cards: [], status: 'complete' }],
    });
    await f.save();
    await f.connected();
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.adapter.send).not.toHaveBeenCalled();
  });

  it('drops queued output from a previous transcript generation', async () => {
    const f = fixture();
    await f.save();
    await f.connected();
    let finish;
    f.adapter.send.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    f.reply('bot', 'old generation', 1, 0);
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledTimes(1), { interval: 10 });
    f.pages.set('bot', {
      generation: 1,
      messages: [{ ordinal: 1, messageID: 'new', text: 'after reset', cards: [], status: 'complete' }],
    });
    finish();
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledTimes(2), { interval: 10 });
    expect(f.adapter.send.mock.calls[1][0].text).toBe('after reset');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.adapter.send.mock.calls.filter((call) => call[0].text === 'old generation')).toHaveLength(1);
  });

  it('never automatically resends an uncertain delivery; retry only reconnects and keeps it visible', async () => {
    const f = fixture();
    f.adapter.send.mockRejectedValueOnce(Object.assign(new Error('timeout'), { ambiguous: true }));
    await f.save();
    await f.connected();
    f.reply('bot', 'possibly delivered', 1);
    await vi.waitFor(() => expect(f.runtime.status('bot', 'wecom').error).toBe('delivery_unknown'), { interval: 10 });
    const deliveryID = f.adapter.send.mock.calls[0][0].id;
    const before = f.connections.length;
    const retried = await f.runtime.retry('bot', 'wecom');
    expect(retried).toMatchObject({ error: 'delivery_unknown' });
    expect(['reconnecting', 'connected']).toContain(retried.status);
    await vi.waitFor(() => expect(f.connections.length).toBe(before + 1), { interval: 10, timeout: 3000 });
    await vi.waitFor(() => expect(f.runtime.status('bot', 'wecom')).toMatchObject({
      status: 'connected', error: 'delivery_unknown',
    }), { interval: 10, timeout: 3000 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.adapter.send).toHaveBeenCalledTimes(1);
    expect(f.adapter.send.mock.calls[0][0].id).toBe(deliveryID);
  });

  it.each(['auth_failed', 'connection_replaced'])('keeps %s sticky instead of hot-looping reconnects', async (code) => {
    const f = fixture();
    f.adapter.connect.mockRejectedValue(Object.assign(new Error('rejected'), { code }));
    await f.save();
    await vi.waitFor(
      () => expect(f.runtime.status('bot', 'wecom')).toMatchObject({ status: 'error', error: code }),
      { interval: 10, timeout: 3000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(f.adapter.connect).toHaveBeenCalledTimes(1);
  });

  it('starts a changed owner at the current transcript tip instead of replaying the old owner watermark', async () => {
    const f = fixture({ autoReady: false, intervalMs: 10_000 });
    await f.save('bot', 'wecom', { ownerID: 'old-owner' });
    f.pages.set('bot', {
      generation: 0,
      messages: [
        { ordinal: 10, messageID: 'old-10', text: 'old owner reply', cards: [], status: 'complete' },
        { ordinal: 20, messageID: 'old-20', text: 'old owner reply 2', cards: [], status: 'complete' },
      ],
    });
    await f.runtime.save('bot', 'wecom', { clientID: 'client', ownerID: 'new-owner' });
    const raw = createAssistantChannelStore(f.directory);
    expect(raw.get('bot', 'wecom')).toMatchObject({ owner_id: 'new-owner', generation: 0, ordinal: 20 });
    raw.close();
    f.pages.set('bot', {
      generation: 0,
      messages: [
        { ordinal: 10, messageID: 'old-10', text: 'old owner reply', cards: [], status: 'complete' },
        { ordinal: 20, messageID: 'old-20', text: 'old owner reply 2', cards: [], status: 'complete' },
        { ordinal: 21, messageID: 'new-21', text: 'new owner reply', cards: [], status: 'complete' },
      ],
    });
    f.connections.at(-1).onReady();
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledTimes(1), { interval: 10 });
    expect(f.adapter.send.mock.calls[0][0].text).toBe('new owner reply');
  });

  it('does not send before the adapter authenticates and resumes durable output on ready', async () => {
    const f = fixture({ autoReady: false, intervalMs: 10 });
    await f.save();
    f.pages.set('bot', {
      generation: 0,
      messages: [{ ordinal: 1, messageID: 'r1', text: 'queued reply', cards: [], status: 'complete' }],
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.adapter.send).not.toHaveBeenCalled();
    expect(f.runtime.status('bot', 'wecom').status).toBe('connecting');
    f.connections.at(-1).onReady();
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledTimes(1), { interval: 10 });
    expect(f.adapter.send.mock.calls[0][0].text).toBe('queued reply');
  });

  it('acknowledges a durable duplicate at the backlog limit instead of rejecting it', async () => {
    const f = fixture();
    await f.save();
    const connection = await f.connected();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    f.service.send.mockImplementation(() => gate.then(() => ({ admitted: true })));
    for (let index = 0; index < 100; index += 1) {
      await connection.onMessage({
        id: `bulk-${index}`, senderID: 'owner', chatType: 'private', text: `message ${index}`,
      });
    }
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(1), { interval: 10 });
    await expect(connection.onMessage({
      id: 'bulk-overflow', senderID: 'owner', chatType: 'private', text: 'overflow',
    })).rejects.toMatchObject({ code: 'backlog_full' });
    await expect(connection.onMessage({
      id: 'bulk-0', senderID: 'owner', chatType: 'private', text: 'duplicate',
    })).resolves.toBe(true);
    release({ admitted: true });
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('stops admitting new work after a sticky connection error and never sends on a dead lane', async () => {
    const f = fixture();
    await f.save();
    const connection = await f.connected();
    connection.onError({ code: 'auth_expired' });
    await vi.waitFor(
      () => expect(f.runtime.status('bot', 'wecom')).toMatchObject({ status: 'error', error: 'auth_expired' }),
      { interval: 10 },
    );
    await expect(connection.onMessage({
      id: 'blocked', senderID: 'owner', chatType: 'private', text: 'should not admit',
    })).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(f.service.send).not.toHaveBeenCalled();
    expect(f.adapter.send).not.toHaveBeenCalled();
  });

  it('rejects overlong identities and secrets instead of truncating them', async () => {
    const f = fixture();
    await expect(f.save('bot', 'wecom', { clientID: 'c'.repeat(513) }))
      .rejects.toMatchObject({ code: 'validation_error' });
    await expect(f.save('bot', 'wecom', { ownerID: 'o'.repeat(513) }))
      .rejects.toMatchObject({ code: 'validation_error' });
    await expect(f.save('bot', 'wecom', { clientSecret: 's'.repeat(4097) }))
      .rejects.toMatchObject({ code: 'validation_error' });
    await f.save();
    // A new account cannot silently reuse the previous account's secret.
    await expect(f.runtime.save('bot', 'wecom', { clientID: 'other-client', ownerID: 'owner' }))
      .rejects.toMatchObject({ code: 'validation_error' });
    const connection = await f.connected();
    await connection.onMessage({
      id: 'm'.repeat(300), senderID: 'owner', chatType: 'private', text: 'too long id',
    });
    await connection.onMessage({
      id: 'valid-id', senderID: `owner${'x'.repeat(600)}`, chatType: 'private', text: 'too long sender',
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.service.send).not.toHaveBeenCalled();
  });

  it('drains admitted inbound work before rotating a save and keeps the receipt durable', async () => {
    const f = fixture();
    await f.save();
    const connection = await f.connected();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    f.service.send.mockImplementationOnce(() => gate.then(() => ({ admitted: true })));
    await connection.onMessage({ id: 'm1', senderID: 'owner', chatType: 'private', text: 'do work' });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(1), { interval: 10 });
    let settled = false;
    const saving = f.runtime.save('bot', 'wecom', {
      clientID: 'client', clientSecret: 'secret2', ownerID: 'owner',
    }).then((value) => { settled = true; return value; });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(settled).toBe(false);
    release({ admitted: true });
    await saving;
    const db = new Database(path.join(f.directory, 'channel.sqlite'));
    expect(db.prepare('SELECT state FROM inbox').all()).toEqual([{ state: 'admitted' }]);
    db.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(f.service.send).toHaveBeenCalledTimes(1);
  });

  it('locks retry against concurrent mutations until the old lane drains', async () => {
    const f = fixture();
    await f.save();
    const connection = await f.connected();
    let release;
    const pending = new Promise((_, reject) => {
      release = () => reject(Object.assign(new Error('network'), { code: 'network_error' }));
    });
    f.adapter.send.mockImplementationOnce(() => pending);
    f.reply('bot', 'in flight', 1);
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalledTimes(1), { interval: 10 });
    const retrying = f.runtime.retry('bot', 'wecom');
    await expect(f.runtime.save('bot', 'wecom', {
      clientID: 'client', clientSecret: 'secret', ownerID: 'owner',
    })).rejects.toMatchObject({ code: 'channel_in_use' });
    await expect(f.runtime.disconnect('bot', 'wecom')).rejects.toMatchObject({ code: 'channel_in_use' });
    release();
    await retrying;
  });

  it('restarts without replaying admitted tools or duplicate receipts and reports interruption', async () => {
    const f = fixture();
    await f.save();
    const connection = await f.connected();
    await connection.onMessage({ id: 'm1', senderID: 'owner', chatType: 'private', text: 'do work' });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(1), { interval: 10 });
    // No turn-end event: the receipt stays admitted, like a process crash mid-turn.
    await f.runtime.close();
    f.service.send.mockClear();
    const restarted = fixture({ directory: f.directory, service: f.service });
    await vi.waitFor(() => expect(restarted.adapter.send).toHaveBeenCalledTimes(1), { interval: 10, timeout: 3000 });
    expect(restarted.adapter.send.mock.calls[0][0].text).toMatch(/主机已重启|host restarted/);
    expect(restarted.service.send).not.toHaveBeenCalled();
    const second = await restarted.connected();
    await second.onMessage({ id: 'm1', senderID: 'owner', chatType: 'private', text: 'do work' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(restarted.service.send).not.toHaveBeenCalled();
  });

  it('disconnect removes local credentials and queues without cancelling admitted work', async () => {
    const f = fixture();
    await f.save();
    const connection = await f.connected();
    await connection.onMessage({ id: 'm1', senderID: 'owner', chatType: 'private', text: 'do work' });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(1), { interval: 10 });
    const result = await f.runtime.disconnect('bot', 'wecom');
    expect(result).toMatchObject({ status: 'disconnected', configured: false, hasSecret: false });
    const raw = createAssistantChannelStore(f.directory);
    expect(raw.get('bot', 'wecom')).toBeNull();
    raw.close();
    f.reply('bot', 'late reply', 1);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.adapter.send).not.toHaveBeenCalled();
    await expect(f.save('bot', 'wecom', { clientSecret: '' }))
      .rejects.toMatchObject({ code: 'validation_error' });
  });

  it('forgets every provider when the Bot is deleted', async () => {
    const f = fixture();
    await f.save('bot', 'wecom');
    await f.save('bot', 'feishu');
    await f.connected('bot', 'wecom');
    await f.runtime.forget('bot');
    await vi.waitFor(() => {
      expect(f.runtime.status('bot', 'wecom').status).toBe('disconnected');
      expect(f.runtime.status('bot', 'feishu').status).toBe('disconnected');
    }, { interval: 10 });
  });

  it('uses a process lease so another runtime cannot steal a live account', async () => {
    const f = fixture();
    await f.save();
    await f.connected();
    const second = fixture({ directory: f.directory });
    await expect(second.save('other', 'wecom', { clientID: 'other-client', clientSecret: 'other' }))
      .rejects.toMatchObject({ code: 'channel_in_use' });
    await second.runtime.close();
    expect(f.runtime.status('bot', 'wecom').status).toBe('connected');
  });

  it('aborts platform reads on close and releases the lease for the next runtime', async () => {
    const f = fixture();
    await f.save();
    const connection = await f.connected();
    await f.runtime.close();
    expect(connection.signal.aborted).toBe(true);
    const next = fixture({ directory: f.directory });
    await next.save('bot', 'wecom', { clientID: 'client', clientSecret: 'replacement', ownerID: 'owner' });
    await next.connected();
  });

  it('shares one store, lease and lifecycle across the three enterprise providers without mixing queues', async () => {
    const providers = ['wecom', 'feishu', 'dingtalk'];
    const service = {
      channelPage: vi.fn((id, { afterOrdinal = 0, generation = null, tipOnly = false } = {}) => {
        const page = service.pages?.get(id) ?? { generation: 0, messages: [] };
        const after = generation === null || generation === page.generation ? afterOrdinal : 0;
        const messages = tipOnly ? [] : page.messages.filter((message) => message.ordinal > after).slice(0, 50);
        return {
          generation: page.generation,
          tipOrdinal: page.messages.at(-1)?.ordinal ?? 0,
          ordinal: messages.at(-1)?.ordinal ?? after,
          messages,
        };
      }),
      send: vi.fn(async () => ({ admitted: true })),
      pages: new Map(),
    };
    const connections = {};
    const sends = { wecom: [], feishu: [], dingtalk: [] };
    const adapters = Object.fromEntries(providers.map((provider) => [provider, {
      connect: vi.fn(async (input) => {
        connections[provider] = input;
        input.onReady();
        await abortable(input.signal);
      }),
      send: vi.fn(async (input) => { sends[provider].push(input); }),
    }]));
    const directory = root();
    const runtime = createAssistantChannelsRuntime({ directory, service, adapters, env: {}, intervalMs: 10 });
    closers.push(() => runtime.close());
    for (const provider of providers) {
      await runtime.save('bot', provider, {
        clientID: `client-${provider}`,
        clientSecret: `secret-${provider}`,
        ownerID: 'owner',
        language: 'zh-CN',
      });
    }
    await vi.waitFor(() => {
      for (const provider of providers) expect(runtime.status('bot', provider).status).toBe('connected');
    }, { interval: 10, timeout: 3000 });
    expect(Object.keys(connections).sort()).toEqual([...providers].sort());

    for (const provider of providers) {
      await connections[provider].onMessage({
        id: 'shared-message-id',
        senderID: 'owner',
        chatType: 'private',
        text: `hello ${provider}`,
        target: { reply: `target-${provider}` },
      });
    }
    await vi.waitFor(() => expect(service.send).toHaveBeenCalledTimes(3), { interval: 10 });
    // The per-account dedup namespace is not shared across providers, and each
    // account keeps its own original text.
    expect(new Set(service.send.mock.calls.map((call) => call[1].parts[0].text)))
      .toEqual(new Set(providers.map((provider) => `hello ${provider}`)));

    service.pages.set('bot', {
      generation: 0,
      messages: [{ ordinal: 1, messageID: 'reply-1', text: 'common reply', cards: [], status: 'complete' }],
    });
    await vi.waitFor(() => {
      for (const provider of providers) expect(sends[provider]).toHaveLength(1);
    }, { interval: 10, timeout: 3000 });
    for (const provider of providers) {
      expect(sends[provider][0]).toMatchObject({
        text: 'common reply',
        target: { reply: `target-${provider}` },
        config: { clientID: `client-${provider}`, ownerID: 'owner', language: 'zh-CN' },
      });
    }

    await runtime.forget('bot');
    await vi.waitFor(() => {
      for (const provider of providers) expect(runtime.status('bot', provider).status).toBe('disconnected');
    }, { interval: 10 });
    const raw = createAssistantChannelStore(directory);
    for (const provider of providers) expect(raw.get('bot', provider)).toBeNull();
    raw.close();
  });

  it('reuses the real Yuri contact pipeline for channel → bot → durable reply', async () => {
    const directory = root();
    let runtime;
    const service = createAssistantsService({
      dbPath: path.join(directory, 'assistants.sqlite'),
      dataDir: directory,
      buildOpenCodeUrl: () => 'http://127.0.0.1:1',
      getOpenCodeAuthHeaders: () => ({}),
      getAllowedRoots: () => [directory],
      runContactTurn: async ({ userParts }) => ({ bubbles: [`收到：${userParts[0].text}`] }),
      onContactTurnEvent: (event) => runtime?.onTurnEvent(event),
      createChatCompletion: async () => ({ choices: [] }),
    });
    closers.push(() => service.close());
    const bot = service.createAssistant({ name: 'Channel test', providerID: 'p', modelID: 'm' });
    const f = fixture({ directory: path.join(directory, 'channels'), service });
    runtime = f.runtime;
    await f.runtime.save(bot.id, 'wecom', {
      clientID: 'client', clientSecret: 'secret', ownerID: 'owner', language: 'zh-CN',
    });
    const connection = await f.connected(bot.id);
    await connection.onMessage({ id: 'm1', senderID: 'owner', chatType: 'private', text: '测试文字' });
    await vi.waitFor(() => expect(f.adapter.send).toHaveBeenCalled(), { interval: 10, timeout: 4000 });
    expect(f.adapter.send.mock.calls[0][0].text).toBe('收到：测试文字');
    expect(service.contactMessages(bot.id, { limit: 20 }).messages
      .some((message) => message.text === '测试文字')).toBe(true);
  });
});
