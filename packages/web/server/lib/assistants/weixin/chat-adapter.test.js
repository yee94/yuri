import { Message } from 'chat';
import { describe, expect, it, vi } from 'vitest';
import { createWeixinChatAdapter } from './chat-adapter.js';

const binding = { epoch: 'epoch', account_id: 'account:one', peer_id: 'owner', token: 'test-secret', context_token: 'private-context' };
const textMessage = { message_id: 'one', message_type: 1, from_user_id: 'owner', context_token: 'private-context',
  item_list: [{ type: 1, text_item: { text: '你好' } }] };

describe('Chat SDK WeChat Bot adapter', () => {
  it('uses the standard Message and dispatch seam while keeping credentials and cursor capabilities private', async () => {
    const api = { getUpdates: vi.fn(async () => ({ msgs: [textMessage] })), sendText: vi.fn() };
    const adapter = createWeixinChatAdapter({ api, getBinding: () => binding, clock: () => 1000 });
    const processMessage = vi.fn();
    await adapter.initialize({ processMessage });
    await adapter.dispatch(textMessage);
    const [source, threadID, message] = processMessage.mock.calls[0];
    expect(source).toBe(adapter);
    expect(message).toBeInstanceOf(Message);
    expect(message.text).toBe('你好');
    expect(message.author).toMatchObject({ userId: 'owner', isMe: false });
    expect(adapter.decodeThreadId(threadID)).toEqual({ accountID: 'account:one', peerID: 'owner' });
    expect(adapter.receipt(message)).toMatchObject({ id: message.id, text: '你好', context: 'private-context', payload: '' });
    expect(JSON.stringify(message.toJSON())).not.toMatch(/test-secret|private-context/);
    expect(await adapter.poll()).toEqual({ msgs: [textMessage] });
  });

  it('retains rich-input receipts and exposes lazy standard attachments without serializing media keys', async () => {
    const api = { downloadMedia: vi.fn(async () => ({ buffer: Buffer.from('image') })) };
    const adapter = createWeixinChatAdapter({ api, getBinding: () => binding });
    const message = adapter.parseMessage({ ...textMessage, item_list: [
      { type: 2, image_item: { media: { aes_key: 'private-key', encrypt_query_param: 'private-capability' } } },
      { type: 99, article_item: { title: '文章标题', url: 'https://mp.weixin.qq.com/s/example' } },
    ] });
    expect(message.text).toContain('文章标题');
    expect(message.attachments[0].type).toBe('image');
    expect(JSON.stringify(message.toJSON())).not.toMatch(/private-key|private-capability/);
    expect(adapter.receipt(message).payload).toContain('private-key');
    await expect(message.attachments[0].fetchData()).resolves.toEqual(Buffer.from('image'));
  });

  it('keeps stable delivery IDs and latest reply context, and disallows sending to another owner', async () => {
    const api = { sendText: vi.fn(async () => {}) };
    const adapter = createWeixinChatAdapter({ api, getBinding: () => binding });
    const threadID = await adapter.openDM('owner');
    const controller = new AbortController();
    await adapter.postMessage(threadID, { markdown: '**result**' }, { id: 'stable-outbox-id', signal: controller.signal });
    expect(api.sendText).toHaveBeenCalledWith(binding, { id: 'stable-outbox-id', text: '**result**' }, controller.signal);
    await expect(adapter.openDM('stranger')).rejects.toMatchObject({ code: 'validation_error' });
    await expect(adapter.postMessage('weixin:other:owner', 'no')).rejects.toMatchObject({ code: 'validation_error' });
    await expect(adapter.postMessage(threadID, { files: [{ data: Buffer.from('file') }], raw: 'file' })).rejects.toThrow();
    expect((await adapter.handleWebhook(new Request('https://example.com'))).status).toBe(501);
    await adapter.disconnect();
    await expect(adapter.postMessage(threadID, 'late')).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('rejects unauthorized, group and ID-less input before constructing a Chat message', () => {
    const adapter = createWeixinChatAdapter({ api: {}, getBinding: () => binding });
    for (const changes of [{ from_user_id: 'stranger' }, { group_id: 'group' }, { message_id: '' }]) {
      expect(() => adapter.parseMessage({ ...textMessage, ...changes })).toThrow('validation_error');
    }
  });
});
