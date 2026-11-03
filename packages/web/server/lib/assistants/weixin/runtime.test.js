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

function fixture({ directory = root(), configureAPI, service: externalService, clock, env = {} } = {}) {
  const pages = new Map();
  const service = externalService ?? {
    snapshot: () => ({ assistants: ['bot', 'other-bot', 'third-bot'].map((id) => ({ id, name: `Name ${id}` })) }),
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
  const runtime = createWeixinRuntime({ directory, service, api, env, intervalMs: 15, ...(clock ? { clock } : {}) });
  closers.push(() => runtime.close());
  const bind = async (id = 'bot') => {
    await runtime.startLogin(id, 'zh-CN');
    await vi.waitFor(() => expect(runtime.status(id).status).toBe('connected'), { interval: 10 });
  };
  const reply = (id, text, ordinal = 1) => pages.set(id, { generation: 0, messages: [{ ordinal, messageID: `reply-${ordinal}`, text, cards: [], status: 'complete' }] });
  return { directory, runtime, service, api, updates, pages, bind, reply };
}

describe('Weixin Host runtime', () => {
  it.each([
    { NODE_ENV: 'development' },
    { YURI_ELECTRON_DEV: '1' },
    { YURI_ELECTRON_DEV: 'true' },
    { NODE_ENV: 'production', YURI_WEIXIN_ENABLED: '0' },
    { YURI_WEIXIN_ENABLED: 'false' },
    { YURI_WEIXIN_ENABLED: 'invalid' },
  ])('disables channel startup and all mutations without opening storage for %j', async (env) => {
    const directory = path.join(root(), 'must-not-open');
    const api = { getQRCode: vi.fn(), getUpdates: vi.fn(), sendText: vi.fn(), getConfig: vi.fn(), sendTyping: vi.fn() };
    const service = { channelPage: vi.fn(), send: vi.fn() };
    const runtime = createWeixinRuntime({ directory, api, service, env });
    closers.push(() => runtime.close());
    expect(runtime.status('bot')).toEqual({ status: 'disabled', error: null });
    for (const method of ['startLogin', 'verify', 'retry', 'disconnect', 'transfer']) {
      expect(() => runtime[method]('bot', {})).toThrow('channel_disabled');
    }
    runtime.onTurnEvent({ type: 'yuri:contact-turn-start', properties: { assistantID: 'bot', turnID: 'turn' } });
    await runtime.forget('bot');
    await runtime.close();
    expect(fs.existsSync(directory)).toBe(false);
    for (const call of Object.values(api)) expect(call).not.toHaveBeenCalled();
    expect(service.send).not.toHaveBeenCalled();
    expect(service.channelPage).not.toHaveBeenCalled();
  });

  it('a disabled dev runtime cannot acquire the production lease or delete its binding', async () => {
    const production = fixture();
    await production.bind();
    const dev = fixture({ directory: production.directory, env: { NODE_ENV: 'development' } });
    expect(dev.runtime.status('bot')).toEqual({ status: 'disabled', error: null });
    await dev.runtime.forget('bot');
    await dev.runtime.close();
    production.updates.push([inbound()]);
    await vi.waitFor(() => expect(production.service.send).toHaveBeenCalledTimes(1));
    expect(production.runtime.status('bot')).toEqual({ status: 'connected', error: null });
    expect(dev.api.getUpdates).not.toHaveBeenCalled();
  });

  it.each(['1', 'true'])('requires an explicit %s override to enable WeChat in development', async (enabled) => {
    const f = fixture({ env: { NODE_ENV: 'development', YURI_ELECTRON_DEV: '1', YURI_WEIXIN_ENABLED: enabled } });
    await f.bind();
    expect(f.runtime.status('bot').status).toBe('connected');
    expect(f.api.getUpdates).toHaveBeenCalled();
  });

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

  it('offers an explicit local move without scanning and preserves cursor/dedup across restart', async () => {
    const f = fixture();
    f.updates.push([inbound('1')]);
    await f.bind();
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(1));
    f.reply('other-bot', 'old target history', 50);
    const state = f.runtime.status('other-bot');
    expect(state).toMatchObject({ status: 'disconnected', transferSources: [{ assistantID: 'bot', name: 'Name bot' }] });
    expect(JSON.stringify(state)).not.toMatch(/test-token|context-1|peer_id|account_id/);
    const revision = state.transferSources[0].revision;
    const result = await f.runtime.transfer('other-bot', { sourceAssistantID: 'bot', revision, language: 'zh-CN' });
    expect(result).toEqual({ status: 'connected', error: null });
    expect(f.runtime.status('bot').status).toBe('disconnected');
    expect(f.api.getQRCode).toHaveBeenCalledTimes(1);
    f.updates.push([inbound('1'), inbound('2')]);
    f.reply('bot', 'late old bot reply');
    f.reply('other-bot', 'new target reply', 51);
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledTimes(2));
    expect(f.service.send.mock.calls[1][0]).toBe('other-bot');
    await vi.waitFor(() => expect(f.api.sendText).toHaveBeenCalledTimes(1));
    expect(f.api.sendText.mock.calls[0][1].text).toBe('new target reply');
    expect(f.api.getUpdates.mock.calls.find(([binding]) => binding.assistant_id === 'other-bot')[0].cursor).toBe('next-cursor');
    await f.runtime.close();
    const restarted = fixture({ directory: f.directory });
    restarted.updates.push([inbound('1'), inbound('2')]);
    await vi.waitFor(() => expect(restarted.api.getUpdates).toHaveBeenCalled());
    expect(restarted.api.getUpdates.mock.calls[0][0].assistant_id).toBe('other-bot');
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(restarted.service.send).not.toHaveBeenCalled();
  });

  it('rejects stale/occupied/missing/expired transfers without changing the original connection', async () => {
    const f = fixture();
    await f.bind();
    const revision = f.runtime.status('other-bot').transferSources[0].revision;
    await expect(f.runtime.transfer('other-bot', { sourceAssistantID: 'bot', revision: 'stale' })).rejects.toMatchObject({ code: 'binding_changed' });
    await expect(f.runtime.transfer('missing', { sourceAssistantID: 'bot', revision })).rejects.toMatchObject({ code: 'not_found' });
    await expect(f.runtime.transfer('bot', { sourceAssistantID: 'bot', revision })).rejects.toMatchObject({ code: 'validation_error' });
    const second = fixture({ directory: f.directory });
    await expect(second.runtime.transfer('other-bot', { sourceAssistantID: 'bot', revision })).rejects.toMatchObject({ code: 'channel_in_use' });
    await second.runtime.close();
    await f.runtime.transfer('other-bot', { sourceAssistantID: 'bot', revision });
    await expect(f.runtime.transfer('third-bot', { sourceAssistantID: 'bot', revision })).rejects.toMatchObject({ code: 'binding_changed' });
    expect(f.runtime.status('other-bot').status).toBe('connected');
    f.api.getQRStatus.mockResolvedValue({ status: 'confirmed', bot_token: 'second-token', ilink_bot_id: 'second-account', ilink_user_id: 'second-owner' });
    await f.bind('bot');
    const source = f.runtime.status('third-bot').transferSources.find((entry) => entry.assistantID === 'bot');
    await expect(f.runtime.transfer('other-bot', { sourceAssistantID: 'bot', revision: source.revision })).rejects.toMatchObject({ code: 'binding_changed' });
    f.api.getUpdates.mockRejectedValue(new WeixinError('auth_expired'));
    await vi.waitFor(() => expect(f.runtime.status('bot').status).toBe('expired'));
    await expect(f.runtime.transfer('third-bot', { sourceAssistantID: 'bot', revision: source.revision })).rejects.toMatchObject({ code: 'binding_changed' });
  });

  it('drains old sending/typing, blocks concurrent mutations and fences a cancelled QR confirmation', async () => {
    const f = fixture();
    f.updates.push([inbound()]);
    await f.bind();
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalled());
    let finishRead;
    let oldSignal;
    f.api.getUpdates.mockImplementationOnce((_binding, signal) => {
      oldSignal = signal;
      return new Promise((resolve) => { finishRead = resolve; });
    });
    let confirm;
    f.api.getQRStatus.mockImplementation(() => new Promise((resolve) => { confirm = resolve; }));
    await f.runtime.startLogin('other-bot');
    await vi.waitFor(() => expect(finishRead).toBeTypeOf('function'));
    f.runtime.onTurnEvent({ type: 'yuri:contact-turn-start', properties: { assistantID: 'bot', turnID: 'live' } });
    await vi.waitFor(() => expect(f.api.sendTyping).toHaveBeenCalled());
    let finishSend;
    f.api.sendText.mockImplementationOnce((_binding, _delivery, signal) => {
      expect(signal.aborted).toBe(false);
      return new Promise((resolve) => { finishSend = resolve; });
    });
    f.reply('bot', 'in flight');
    await vi.waitFor(() => expect(finishSend).toBeTypeOf('function'));
    const revision = f.runtime.status('other-bot').transferSources[0].revision;
    const moving = f.runtime.transfer('other-bot', { sourceAssistantID: 'bot', revision });
    expect(oldSignal.aborted).toBe(true);
    await expect(f.runtime.transfer('third-bot', { sourceAssistantID: 'bot', revision })).rejects.toMatchObject({ code: 'channel_in_use' });
    await expect(f.runtime.disconnect('bot')).rejects.toMatchObject({ code: 'channel_in_use' });
    expect(() => f.runtime.retry('bot')).toThrow('channel_in_use');
    await expect(f.runtime.startLogin('other-bot')).rejects.toMatchObject({ code: 'channel_in_use' });
    confirm({ status: 'confirmed', bot_token: 'stale-token', ilink_bot_id: 'stale-account', ilink_user_id: 'owner' });
    finishRead({ msgs: [inbound('stale')], get_updates_buf: 'stale-cursor' });
    finishSend({ ret: 0 });
    await moving;
    expect(f.api.sendTyping.mock.calls.map((call) => call[2])).toEqual([1, 2]);
    expect(f.service.send).toHaveBeenCalledTimes(1);
    expect(f.runtime.status('bot').status).toBe('disconnected');
    expect(f.runtime.status('other-bot').status).toBe('connected');
    await expect(f.runtime.transfer('third-bot', { sourceAssistantID: 'bot', revision })).rejects.toMatchObject({ code: 'binding_changed' });
  });

  it('preserves and resumes the source if the target disappears while draining', async () => {
    const f = fixture();
    await f.bind();
    f.runtime.onTurnEvent({ type: 'yuri:contact-turn-start', properties: { assistantID: 'bot', turnID: 'live' } });
    await vi.waitFor(() => expect(f.api.sendTyping).toHaveBeenCalled());
    let finishCancel;
    f.api.sendTyping.mockImplementationOnce(() => new Promise((resolve) => { finishCancel = resolve; }));
    const revision = f.runtime.status('other-bot').transferSources[0].revision;
    const moving = f.runtime.transfer('other-bot', { sourceAssistantID: 'bot', revision }).catch((error) => error);
    await vi.waitFor(() => expect(finishCancel).toBeTypeOf('function'));
    f.service.channelPage.mockImplementationOnce(() => { throw Object.assign(new Error('not_found'), { code: 'not_found' }); });
    finishCancel({});
    expect(await moving).toMatchObject({ code: 'not_found' });
    expect(f.runtime.status('bot').status).toBe('connected');
    f.updates.push([inbound('after-failure')]);
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalledWith('bot', expect.anything()));
  });

  it('a failed move leaves an aborted in-flight reply explicitly retryable, never stuck or automatically resent', async () => {
    const f = fixture();
    f.updates.push([inbound()]);
    await f.bind();
    await vi.waitFor(() => expect(f.service.send).toHaveBeenCalled());
    f.runtime.onTurnEvent({ type: 'yuri:contact-turn-start', properties: { assistantID: 'bot', turnID: 'live' } });
    await vi.waitFor(() => expect(f.api.sendTyping).toHaveBeenCalled());
    let finishCancel;
    f.api.sendTyping.mockImplementationOnce(() => new Promise((resolve) => { finishCancel = resolve; }));
    f.api.sendText.mockImplementationOnce((_binding, _delivery, signal) => abortable(signal));
    f.reply('bot', 'possibly delivered');
    await vi.waitFor(() => expect(f.api.sendText).toHaveBeenCalledTimes(1));
    const revision = f.runtime.status('other-bot').transferSources[0].revision;
    const moving = f.runtime.transfer('other-bot', { sourceAssistantID: 'bot', revision }).catch((error) => error);
    await vi.waitFor(() => expect(finishCancel).toBeTypeOf('function'));
    f.service.channelPage.mockImplementationOnce(() => { throw Object.assign(new Error('not_found'), { code: 'not_found' }); });
    finishCancel({});
    expect(await moving).toMatchObject({ code: 'not_found' });
    expect(f.runtime.status('bot')).toEqual({ status: 'connected', error: 'delivery_unknown' });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(f.api.sendText).toHaveBeenCalledTimes(1);
    f.runtime.retry('bot');
    await vi.waitFor(() => expect(f.api.sendText).toHaveBeenCalledTimes(2));
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
  it('moves atomically, preserves credentials/cursor/receipt IDs, drops old work, and rolls back failed writes', () => {
    const store = createWeixinStore(root());
    closers.push(() => store.close());
    const initial = { token: 'test-token', peer_id: 'owner', base_url: 'https://ilinkai.weixin.qq.com', language: 'en', generation: 0, ordinal: 0, updated_at: 1 };
    const a = store.bind({ ...initial, assistant_id: 'a', account_id: 'account-a' });
    store.accept(a, 'cursor', [{ id: 'done', text: 'old', context: 'ctx' }, { id: 'pending', text: 'pending' }]);
    store.markInbox('done', 'admitted');
    store.enqueue(a.epoch, 'old-delivery', 'old reply');
    const move = { sourceAssistantID: 'a', expectedEpoch: a.epoch, assistantID: 'b', generation: 5, ordinal: 42, language: 'zh-CN', updatedAt: 2 };
    expect(() => store.transfer({ ...move, ordinal: null })).toThrow();
    expect(store.get('a').epoch).toBe(a.epoch);
    expect(store.pending(a.epoch)).toHaveLength(1);
    expect(store.nextDelivery(a.epoch).text).toBe('old reply');
    const b = store.transfer(move);
    expect(store.get('a')).toBeNull();
    expect(b).toMatchObject({ ...initial, assistant_id: 'b', language: 'zh-CN', generation: 5, ordinal: 42, updated_at: 2, cursor: 'cursor', context_token: 'ctx' });
    expect(b.epoch).not.toBe(a.epoch);
    expect(store.nextDelivery(b.epoch)).toBeUndefined();
    store.accept(b, 'next', [{ id: 'done', text: 'replay' }, { id: 'pending', text: 'replay' }, { id: 'fresh', text: 'new' }]);
    expect(store.pending(b.epoch).map((row) => row.id)).toEqual(['fresh']);
    store.accept(a, 'stale', [{ id: 'stale', text: 'stale' }]);
    expect(store.get('b').cursor).toBe('next');
    expect(() => store.transfer(move)).toThrow('binding_changed');
    store.bind({ ...initial, assistant_id: 'c', account_id: 'account-c' });
    expect(() => store.transfer({ ...move, sourceAssistantID: 'b', expectedEpoch: b.epoch, assistantID: 'c' })).toThrow('binding_changed');
    expect(store.get('b').epoch).toBe(b.epoch);
    expect(store.get('c').account_id).toBe('account-c');
  });

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
