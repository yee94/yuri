import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantsService } from './service.js';
import { createAssistantChannelsRuntime } from './channels/runtime.js';
import { createWeixinRuntime } from './weixin/runtime.js';
import { createWeixinStore } from './weixin/store.js';
import { createAssistantChannelStore } from './channels/store.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aKxkAAAAASUVORK5CYII=', 'base64');
describe('real contact output → all native image channels', () => {
  it.each(['weixin', 'wecom', 'feishu', 'dingtalk'])('returns images only to %s, keeps app replies local and broadcasts scheduled results', async (source) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'yuri-image-pipeline-'));
    const imagePath = path.join(directory, 'generated.png');
    await fs.writeFile(imagePath, png);
    let enterprise;
    let weixin;
    const service = createAssistantsService({ dbPath: path.join(directory, 'assistants.sqlite'), dataDir: directory,
      buildOpenCodeUrl: () => 'http://127.0.0.1:1', getOpenCodeAuthHeaders: () => ({}), getAllowedRoots: () => [directory],
      clientFactory: () => ({ message: { list: async () => ({ data: [], cursor: {} }) } }),
      listProjects: async () => [{ id: 'project', path: directory }],
      upsertScheduledTask: async (_project, task) => ({ task: { ...task, id: 'task' } }),
      syncScheduledTaskProject: async () => {},
      createChatCompletion: async () => ({ choices: [] }),
      runContactTurn: async ({ userText, tools, onBubbleDelta }) => {
        if (userText === 'draw again') {
          const scheduled = await tools.find((tool) => tool.name === 'schedule_task').execute('schedule', {
            name: 'Draw daily', prompt: 'Draw an image', time: '18:00', timezone: 'UTC',
          });
          expect(scheduled.isError).not.toBe(true);
        }
        const image = `![generated](<${imagePath}>)`;
        onBubbleDelta?.(0, image, true);
        return { bubbles: [image] };
      },
      onContactTurnEvent: (event) => { enterprise?.onTurnEvent(event); weixin?.onTurnEvent(event); } });
    const bot = service.createAssistant({ name: 'Image pipeline', providerID: 'p', modelID: 'm', workspacePath: directory });
    const connections = new Map();
    const sends = Object.fromEntries(['weixin', 'wecom', 'feishu', 'dingtalk'].map((provider) => [provider, vi.fn(async () => {})]));
    const adapters = Object.fromEntries(['wecom', 'feishu', 'dingtalk'].map((provider) => [provider, {
      connect: async (input) => { connections.set(provider, input); input.onReady();
        await new Promise((resolve) => input.signal.aborted ? resolve() : input.signal.addEventListener('abort', resolve, { once: true })); },
      send: sends[provider],
    }]));
    const incoming = [];
    const api = { getQRCode: async () => ({ qrcode: 'qr', qrcode_img_content: 'qr-content' }),
      getQRStatus: async () => ({ status: 'confirmed', bot_token: 'test', ilink_bot_id: 'account', ilink_user_id: 'owner', baseurl: 'https://ilinkai.weixin.qq.com' }),
      getUpdates: async () => ({ msgs: incoming.splice(0), get_updates_buf: 'cursor' }),
      sendImage: async (_binding, delivery) => sends.weixin(delivery), sendText: vi.fn(async () => {}),
      getConfig: async () => ({ ret: 0 }), sendTyping: async () => {} };
    try {
      enterprise = createAssistantChannelsRuntime({ directory: path.join(directory, 'channels'), service, adapters, env: {}, intervalMs: 10 });
      weixin = createWeixinRuntime({ directory: path.join(directory, 'weixin'), service, api, env: {}, intervalMs: 10 });
      for (const provider of Object.keys(adapters)) {
        await enterprise.save(bot.id, provider, { clientID: provider, clientSecret: 'test', ownerID: 'owner', language: 'zh-CN' });
      }
      await weixin.startLogin(bot.id, 'zh-CN');
      await vi.waitFor(() => expect(weixin.status(bot.id).status).toBe('connected'));
      const weixinStore = createWeixinStore(path.join(directory, 'weixin'));
      weixinStore.patch(weixinStore.get(bot.id).epoch, { context_token: 'test-context' });
      weixinStore.close();
      await vi.waitFor(() => expect(connections.size).toBe(3));
      const cards = [
        { cardType: 'session', sessionID: 'ses_card', directory, title: 'Internal session', status: 'complete' },
        { cardType: 'assistant', assistantID: bot.id, name: 'Internal Bot', providerID: 'p', modelID: 'm' },
        { cardType: 'schedule', taskID: 'task_card', projectID: 'project_card', name: 'Internal schedule' },
      ];
      for (const card of cards) service.appendContactCard(bot.id, card);
      const tip = service.channelPage(bot.id, { tipOnly: true }).tipOrdinal;
      const channelStore = createAssistantChannelStore(path.join(directory, 'channels'));
      const personalStore = createWeixinStore(path.join(directory, 'weixin'));
      try {
        await vi.waitFor(() => {
          expect(personalStore.get(bot.id).ordinal).toBe(tip);
          for (const provider of Object.keys(adapters)) expect(channelStore.get(bot.id, provider).ordinal).toBe(tip);
        });
        for (const send of Object.values(sends)) expect(send).not.toHaveBeenCalled();
        expect(api.sendText).not.toHaveBeenCalled();
        expect(weixin.status(bot.id).error).toBeNull();
        for (const provider of Object.keys(adapters)) expect(enterprise.status(bot.id, provider).error).toBeNull();
        expect(service.contactMessages(bot.id, { limit: 20 }).messages.flatMap((message) => message.cards)).toEqual(cards.map((card) => expect.objectContaining(card)));
      } finally { channelStore.close(); personalStore.close(); }
      if (source === 'weixin') incoming.push({ message_id: 'in', from_user_id: 'owner', message_type: 1,
        context_token: 'test-context', item_list: [{ type: 1, text_item: { text: 'draw' } }] });
      else await connections.get(source).onMessage({ id: 'in', senderID: 'owner', chatType: 'private', text: 'draw' });
      await vi.waitFor(() => expect(sends[source]).toHaveBeenCalledOnce());
      expect(sends[source].mock.calls[0][0].image.buffer).toEqual(png);
      for (const [provider, send] of Object.entries(sends)) if (provider !== source) expect(send).not.toHaveBeenCalled();
      await service.send(bot.id, { messageID: 'app-turn', parts: [{ type: 'text', text: 'draw again' }] });
      await vi.waitFor(() => {
        expect(service.contactMessages(bot.id, { limit: 20 }).messages.some((message) => message.messageID === 'app-turn:bubble:1')).toBe(true);
      });
      const appTip = service.channelPage(bot.id, { tipOnly: true }).tipOrdinal;
      const appChannels = createAssistantChannelStore(path.join(directory, 'channels'));
      const appWeixin = createWeixinStore(path.join(directory, 'weixin'));
      try {
        await vi.waitFor(() => {
          expect(appWeixin.get(bot.id).ordinal).toBe(appTip);
          for (const provider of Object.keys(adapters)) expect(appChannels.get(bot.id, provider).ordinal).toBe(appTip);
        });
        for (const [provider, send] of Object.entries(sends)) expect(send).toHaveBeenCalledTimes(provider === source ? 1 : 0);
      } finally { appChannels.close(); appWeixin.close(); }
      expect(await service.reportScheduledTaskResult({ id: 'run', projectId: 'project', taskId: 'task',
        taskName: 'Draw daily', status: 'success', sessionId: 'worker', directory,
        startedAt: Date.now(), finishedAt: Date.now(), prompt: 'Draw an image' })).toBe(true);
      await vi.waitFor(() => {
        for (const [provider, send] of Object.entries(sends)) expect(send).toHaveBeenCalledTimes(provider === source ? 2 : 1);
      });
      for (const send of Object.values(sends)) expect(send.mock.calls.at(-1)[0].image.buffer).toEqual(png);
      expect(api.sendText).not.toHaveBeenCalled();
    } finally { await enterprise?.close(); await weixin?.close(); service.close(); await fs.rm(directory, { recursive: true, force: true }); }
  });
});
