import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWeixinRuntime } from './runtime.js';
import { createWeixinStore } from './store.js';
import { WeixinError } from './api.js';
import { createAssistantsService } from '../service.js';

const closers = [];
afterEach(async () => { while (closers.length) await closers.pop()(); });
const root = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'yuri-weixin-'));
  closers.push(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};
const abortable = (signal) => new Promise((_, reject) => {
  if (signal.aborted) { reject(new WeixinError('cancelled')); return; }
  signal.addEventListener('abort', () => reject(new WeixinError('cancelled')), { once: true });
});
const inbound = (id = '1', peer = 'owner', text = 'hello') => ({
  message_id: id, from_user_id: peer, message_type: 1, context_token: `context-${id}`,
  item_list: [{ type: 1, text_item: { text } }],
});

function fixture({ directory = root(), configureAPI, service: externalService, clock } = {}) {
  const pages = new Map();
  const service = externalService ?? {
    channelPage: vi.fn((id, { afterOrdinal = 0, generation = null } = {}) => {
      if (id === 'missing') throw Object.assign(new Error('not_found'), { code: 'not_found' });
      const page = pages.get(id) ?? { generation: 0, messages: [] };
      const after = generation === null || generation === page.generation ? afterOrdinal : 0;
      const messages = page.messages.filter((message) => message.ordinal > after).slice(0, 50);
      return { generation: page.generation, tipOrdinal: page.messages.at(-1)?.ordinal ?? 0, ordinal: messages.at(-1)?.ordinal ?? after, messages };
    }),
    send: vi.fn(async () => ({ admitted: true })),
  };
  const updates = [];
  const api = {
    getQRCode: vi.fn(async () => ({ qrcode: 'opaque-qr', qrcode_img_content: 'https://example.com/scan' })),
    getQRStatus: vi.fn(async () => ({ status: 'confirmed', bot_token: 'test-token', ilink_bot_id: 'account', ilink_user_id: 'owner', baseurl: 'https://ilinkai.weixin.qq.com' })),
    getUpdates: vi.fn(async () => ({ msgs: updates.shift() ?? [], get_updates_buf: 'next-cursor' })),
    sendText: vi.fn(async () => ({ ret: 0 })),
    getConfig: vi.fn(async () => ({ ret: 0, typing_ticket: 'test-ticket' })),
    sendTyping: vi.fn(async () => ({})),
  };
  configureAPI?.(api);
  const runtime = createWeixinRuntime({ directory, service, api, intervalMs: 15, ...(clock ? { clock } : {}) });
  closers.push(() => runtime.close());
  const bind = async (id = 'bot') => {
    await runtime.startLogin(id, 'zh-CN');
    await vi.waitFor(() => expect(runtime.status(id).status).toBe('connected'), { interval: 10 });
  };
  const reply = (id, text, ordinal = 1) => pages.set(id, { generation: 0, messages: [{ ordinal, messageID: `reply-${ordinal}`, text, cards: [], status: 'complete' }] });
  return { directory, runtime, service, api, updates, pages, bind, reply };
}

describe('Weixin Host runtime', () => {
  it('QR binds one Bot, admits only the owner once, and sends persisted text with the latest context', async () => {
    const f = fixture();
    f.updates.push([inbound('1'), inbound('1'), inbound('2', 'stranger'), { ...inbound('3'), group_id: 'group' }]);
    await f.bind();
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(1));
    expect(f.service.send.mock.calls[0]).toEqual(['bot', expect.objectContaining({ parts: [{ type: 'text', text: 'hello' }] })]);
    f.reply('bot', '文字回复');
    await vi.waitFor(() => expect(f.api.sendText).toHaveBeenCalledTimes(1));
    expect(f.api.sendText.mock.calls[0][0]).toMatchObject({ peer_id: 'owner', context_token: 'context-1' });
    expect(f.api.sendText.mock.calls[0][1].text).toBe('文字回复');
    expect(JSON.stringify(f.runtime.status('bot'))).not.toMatch(/test-token|context-1|owner|account/);
    expect(fs.statSync(f.directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(f.directory, 'channel.sqlite')).mode & 0o777).toBe(0o600);
  });

  it('restarts without another scan, keeps deduplication and does not replay admitted tool work', async () => {
    const f = fixture();
    f.updates.push([inbound()]);
    await f.bind();
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(1));
    await f.runtime.close();
    const restarted = fixture({ directory: f.directory });
    restarted.updates.push([inbound()]);
    await vi.waitFor(() => expect(restarted.api.sendText).toHaveBeenCalled());
    expect(restarted.api.getQRCode).not.toHaveBeenCalled();
    expect(restarted.service.send).not.toHaveBeenCalled();
    expect(restarted.api.sendText.mock.calls[0][1].text).toContain('主机已重启');
  });

  it('does not replay old transcript rows on binding; resets the feed on transcript generation changes', async () => {
    const f = fixture();
    f.reply('bot', 'old', 50);
    f.updates.push([inbound()]);
    await f.bind();
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalled());
    expect(f.api.sendText).not.toHaveBeenCalled();
    f.pages.set('bot', { generation: 1, messages: [{ ordinal: 1, messageID: 'new', text: 'after reset', cards: [], status: 'complete' }] });
    await vi.waitFor(() => expect(f.api.sendText).toHaveBeenCalledTimes(1));
    expect(f.api.sendText.mock.calls[0][1].text).toBe('after reset');
  });

  it('uncertain delivery remains visible and is retried only by explicit action, even after new inbound', async () => {
    const f = fixture({ configureAPI: (api) => api.sendText.mockRejectedValueOnce(new WeixinError('network_error', { ambiguous: true })) });
    f.updates.push([inbound()]);
    await f.bind();
    f.reply('bot', 'reply');
    await vi.waitFor(() => expect(f.runtime.status('bot').error).toBe('delivery_unknown'));
    const originalId = f.api.sendText.mock.calls[0][1].id;
    f.updates.push([inbound('2')]);
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(2));
    expect(f.api.sendText).toHaveBeenCalledTimes(1);
    f.runtime.retry('bot');
    await vi.waitFor(() => expect(f.api.sendText).toHaveBeenCalledTimes(2));
    expect(f.api.sendText.mock.calls[1][1].id).toBe(originalId);
  });

  it('shutdown cancels a hanging platform read before closing storage', async () => {
    const f = fixture({ configureAPI: (api) => api.getUpdates.mockImplementation((_binding, signal) => abortable(signal)) });
    await f.bind();
    await vi.waitFor(() => expect(f.api.getUpdates).toHaveBeenCalled());
    const signal = f.api.getUpdates.mock.calls[0][1];
    await f.runtime.close();
    expect(signal.aborted).toBe(true);
  });

  it('stale QR confirmation after disconnect cannot restore credentials or start polling', async () => {
    let confirm;
    const confirmed = new Promise((resolve) => { confirm = resolve; });
    const f = fixture({ configureAPI: (api) => api.getQRStatus.mockImplementation(() => confirmed) });
    expect((await f.runtime.startLogin('bot')).status).toBe('waiting');
    await f.runtime.disconnect('bot');
    confirm({ status: 'confirmed', bot_token: 'stale', ilink_bot_id: 'account', ilink_user_id: 'owner' });
    await Promise.resolve();
    await Promise.resolve();
    expect(f.runtime.status('bot').status).toBe('disconnected');
    expect(f.api.getUpdates).not.toHaveBeenCalled();
  });

  it('keeps authentication failure sticky until QR authorization is renewed', async () => {
    const f = fixture({ configureAPI: (api) => api.getUpdates.mockRejectedValue(new WeixinError('auth_expired')) });
    await f.runtime.startLogin('bot');
    await vi.waitFor(() => expect(f.runtime.status('bot').status).toBe('expired'));
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(f.api.getUpdates).toHaveBeenCalledTimes(1);
  });

  it('a late receiver network failure cannot undo authorization expiry from sending', async () => {
    let rejectRead;
    const f = fixture({ configureAPI: (api) => {
      api.getUpdates.mockImplementationOnce(async () => ({ msgs: [inbound()], get_updates_buf: 'cursor' }))
        .mockImplementation(() => new Promise((_, reject) => { rejectRead = reject; }));
      api.sendText.mockRejectedValue(new WeixinError('auth_expired'));
    } });
    await f.bind();
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalled());
    f.reply('bot', 'reply');
    await vi.waitFor(() => expect(f.runtime.status('bot').status).toBe('expired'));
    await vi.waitFor(() => expect(rejectRead).toBeTypeOf('function'));
    rejectRead(new WeixinError('network_error'));
    await vi.waitFor(() => expect(f.runtime.status('bot')).toMatchObject({ status: 'expired', error: 'auth_expired' }));
  });

  it('enforces account exclusivity and process ownership without stealing a live receiver', async () => {
    const f = fixture();
    await f.bind();
    await f.runtime.startLogin('other-bot');
    await vi.waitFor(() => expect(f.runtime.status('other-bot').error).toBe('account_in_use'));
    expect(f.runtime.status('bot').status).toBe('connected');
    const second = fixture({ directory: f.directory });
    await expect(second.runtime.startLogin('third-bot')).rejects.toMatchObject({ code: 'channel_in_use' });
    expect(second.api.getUpdates).not.toHaveBeenCalled();
    await second.runtime.close();
    expect(f.runtime.status('bot').status).toBe('connected');
  });

  it('non-text input gives a text-only reply without invoking bot tools', async () => {
    const f = fixture();
    f.updates.push([{ ...inbound(), item_list: [null, { type: 2, image_item: { media: {} } }] }]);
    await f.bind();
    await vi.waitFor(() => expect(f.api.sendText).toHaveBeenCalled());
    expect(f.api.sendText.mock.calls[0][1].text).toContain('仅支持文字');
    expect(f.service.send).not.toHaveBeenCalled();
  });

  it('reuses the actual Yuri contact pipeline for WeChat → bot → durable reply', async () => {
    const directory = root();
    let runtime;
    let finish;
    const turnGate = new Promise((resolve) => { finish = resolve; });
    const service = createAssistantsService({
      dbPath: path.join(directory, 'assistants.sqlite'), dataDir: directory,
      buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}),
      getAllowedRoots: () => [directory],
      runContactTurn: async ({ userParts }) => { await turnGate; return { bubbles: [`收到：${userParts[0].text}`] }; },
      onContactTurnEvent: (event) => runtime?.onTurnEvent(event),
      createChatCompletion: async () => ({ choices: [] }),
    });
    closers.push(() => service.close());
    const bot = service.createAssistant({ name: '微信测试', providerID: 'p', modelID: 'm' });
    const f = fixture({ directory: path.join(directory, 'weixin'), service });
    runtime = f.runtime;
    f.updates.push([inbound('1', 'owner', '测试文字')]);
    await f.bind(bot.id);
    await vi.waitFor(() => expect(f.api.sendTyping).toHaveBeenCalledWith(
      expect.objectContaining({ assistant_id: bot.id, peer_id: 'owner' }), 'test-ticket', 1, expect.any(AbortSignal),
    ));
    finish();
    await vi.waitFor(() => expect(f.api.sendText).toHaveBeenCalled(), { timeout: 4000 });
    expect(f.api.sendText.mock.calls[0][1].text).toBe('收到：测试文字');
    expect(service.contactMessages(bot.id, { limit: 20 }).messages.some((message) => message.text === '测试文字')).toBe(true);
    await vi.waitFor(() => expect(f.api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 2]));
  });

  it.each(['error', 'cancelled'])('clears typing on a live %s terminal event without sending a placeholder text', async (status) => {
    const f = fixture();
    await f.bind();
    f.runtime.onTurnEvent({ type: 'yuri:contact-turn-start', properties: { assistantID: 'bot', turnID: 'turn' } });
    await vi.waitFor(() => expect(f.api.sendTyping).toHaveBeenCalledTimes(1));
    f.runtime.onTurnEvent({ type: 'yuri:contact-turn-end', properties: { assistantID: 'bot', turnID: 'turn', status } });
    await vi.waitFor(() => expect(f.api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 2]));
    expect(f.api.sendText).not.toHaveBeenCalled();
  });

  it('disconnect waits for typing cancellation before forgetting the binding', async () => {
    const f = fixture();
    await f.bind();
    f.runtime.onTurnEvent({ type: 'yuri:contact-turn-start', properties: { assistantID: 'bot', turnID: 'turn' } });
    await vi.waitFor(() => expect(f.api.sendTyping).toHaveBeenCalledTimes(1));
    let finishCancel;
    f.api.sendTyping.mockImplementationOnce(() => new Promise((resolve) => { finishCancel = resolve; }));
    const disconnected = f.runtime.disconnect('bot');
    await vi.waitFor(() => expect(finishCancel).toBeTypeOf('function'));
    f.runtime.onTurnEvent({ type: 'yuri:contact-turn-start', properties: { assistantID: 'bot', turnID: 'late' } });
    finishCancel({});
    expect(await disconnected).toMatchObject({ status: 'disconnected' });
    expect(f.api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 2]);
  });

  it('typing API failure cannot block contact admission, replies or expose optional presence errors', async () => {
    const f = fixture({ configureAPI: (api) => api.getConfig.mockRejectedValue(new Error('private-ticket-error')) });
    f.updates.push([inbound()]);
    await f.bind();
    f.runtime.onTurnEvent({ type: 'yuri:contact-turn-start', properties: { assistantID: 'bot', turnID: 'turn' } });
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(1));
    f.reply('bot', 'reply');
    await vi.waitFor(() => expect(f.api.sendText).toHaveBeenCalledTimes(1));
    expect(f.api.sendTyping).not.toHaveBeenCalled();
    expect(f.runtime.status('bot')).toEqual({ status: 'connected', error: null });
  });

  it('Host shutdown awaits an independent typing cancellation before closing storage', async () => {
    const f = fixture();
    await f.bind();
    f.runtime.onTurnEvent({ type: 'yuri:contact-turn-start', properties: { assistantID: 'bot', turnID: 'turn' } });
    await vi.waitFor(() => expect(f.api.sendTyping).toHaveBeenCalledTimes(1));
    let finishCancel;
    f.api.sendTyping.mockImplementationOnce(() => new Promise((resolve) => { finishCancel = resolve; }));
    let stopped = false;
    const closing = f.runtime.close().then(() => { stopped = true; });
    await vi.waitFor(() => expect(finishCancel).toBeTypeOf('function'));
    expect(stopped).toBe(false);
    expect(f.api.sendTyping.mock.calls[0][3].aborted).toBe(true);
    expect(f.api.sendTyping.mock.calls[1][3]).toBeUndefined();
    finishCancel({});
    await closing;
    expect(stopped).toBe(true);
  });
});

describe('Weixin durable store', () => {
  it('rolls back a conflicting rebind, persists cursor/receipt together, and fences old epochs', () => {
    const store = createWeixinStore(root());
    closers.push(() => store.close());
    const initial = { token: 'test-token', peer_id: 'owner', base_url: 'https://ilinkai.weixin.qq.com', language: 'en', generation: 0, ordinal: 0, updated_at: 1 };
    const a = store.bind({ ...initial, assistant_id: 'a', account_id: 'account-a' });
    store.bind({ ...initial, assistant_id: 'b', account_id: 'account-b' });
    expect(() => store.bind({ ...initial, assistant_id: 'a', account_id: 'account-b' })).toThrow('account_in_use');
    expect(store.get('a').epoch).toBe(a.epoch);
    store.accept(a, 'cursor-1', [{ id: 'one', text: 'hello', context: 'ctx' }]);
    store.accept(a, 'cursor-2', [{ id: 'one', text: 'hello', context: 'ctx' }]);
    expect(store.pending(a.epoch)).toHaveLength(1);
    expect(store.get('a')).toMatchObject({ cursor: 'cursor-2', context_token: 'ctx' });
    store.unlink('a');
    store.accept(a, 'stale', [{ id: 'stale', text: 'stale' }]);
    expect(store.pending(a.epoch)).toHaveLength(0);
    expect(store.get('a')).toBeNull();
  });
});
