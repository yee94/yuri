import { describe, expect, it, vi } from 'vitest';
import { normalizeWeixinInput, prepareWeixinInput } from './inbound.js';

const image = { type: 2, image_item: { media: { encrypt_query_param: 'private-reference', aes_key: 'private-key' }, thumb_width: 100 } };
const prepare = async (message, overrides = {}) => {
  const api = { downloadMedia: vi.fn(async () => ({ buffer: Buffer.from('bytes'), mime: 'image/png', filename: 'image.png' })) };
  const service = { putAssistantContactAttachment: vi.fn(async (_bot, uploadID, { headers }) => ({ type: 'file', attachmentID: `att_${uploadID}`, mime: headers['content-type'], size: Number(headers['x-content-size']) })) };
  const options = { api, service, assistantID: 'bot', assertCurrent: () => {}, ...overrides };
  const receipt = { id: 'stable-id', ...normalizeWeixinInput(message) };
  const parts = await prepareWeixinInput(receipt, options);
  return { parts, ...options, receipt };
};

describe('WeChat rich input projection', () => {
  it('does not turn ordinary text item protocol IDs into a TOON message', async () => {
    const message = { message_id: 'message-id', from_user_id: 'owner', create_time_ms: 123,
      item_list: [{ type: 1, msg_id: 'item-id', create_time_ms: 123, text_item: { text: 'halo' } }] };
    const result = await prepare(message);
    expect(result.receipt.payload).toBe('');
    expect(result.parts).toEqual([{ type: 'text', text: 'halo' }]);
  });

  it('keeps ordinary text byte-for-byte and accepts legacy text-only receipts', async () => {
    const message = { context_token: 'private-context', message_id: 'id', item_list: [{ type: 1, text_item: { text: '你好' } }, { type: 1, text_item: { text: 'world' } }] };
    expect(normalizeWeixinInput(message)).toEqual({ text: '你好\nworld', payload: '' });
    const result = await prepare(message);
    expect(result.parts).toEqual([{ type: 'text', text: '你好\nworld' }]);
    expect(result.api.downloadMedia).not.toHaveBeenCalled();
  });

  it('keeps every mixed item, inline quote and article extension as data while stripping transport secrets', async () => {
    const { parts } = await prepare({ context_token: 'private-context', bot_token: 'private-token', item_list: [
      { type: 1, text_item: { text: '看看这篇' }, ref_msg: { title: '原消息', svr_id: 'quoted-id', message_item: { type: 1, text_item: { text: '引用文字' } } } },
      image,
      // Deliberately synthetic extension: no public iLink article-item schema exists.
      { type: 99, article_item: { title: '公众号文章', description: '摘要', url: 'https://mp.weixin.qq.com/s?__biz=public&mid=123&token=private-token',
        media: { aes_key: 'private-key' }, context_token: 'private-context' } },
    ] });
    const text = parts.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    expect(text).toContain('看看这篇');
    for (const expected of ['TOON', '公众号文章', '摘要', 'mp.weixin.qq.com', '__biz=public', '原消息', '引用文字', 'attached']) expect(text).toContain(expected);
    expect(text).not.toMatch(/private-key|private-token|private-context|private-reference/);
    expect(parts.filter((part) => part.type === 'file')).toHaveLength(1);
  });

  it('retains unknown text fields and handles thumbnail-only and URL-only image references without claiming a full-resolution image', async () => {
    const result = await prepare({ item_list: [
      { type: 99, text_item: { text: '分享的其他内容' } },
      { type: 2, image_item: { thumb_media: image.image_item.media, aeskey: 'must-not-use-original-key' } },
      { type: 2, image_item: { url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=private-reference' } },
    ] });
    expect(result.parts.at(-1).text).toContain('分享的其他内容');
    expect(result.parts.at(-1).text).toContain('thumbnail');
    expect(result.api.downloadMedia).toHaveBeenCalledTimes(2);
    expect(result.api.downloadMedia.mock.calls[0][0].aeskey).toBeUndefined();
    expect(result.api.downloadMedia.mock.calls[1][0].full_url).toContain('encrypted_query_param=private-reference');
    expect(result.parts.at(-1).text).not.toContain('private-reference');
  });

  it('consumes platform voice transcripts without downloading audio, and preserves raw audio when no transcript is supplied', async () => {
    const spoken = await prepare({ item_list: [{ type: 3, voice_item: { text: '帮我总结今天的工作', encode_type: 6, media: image.image_item.media } }] });
    expect(spoken.parts.at(-1).text).toContain('帮我总结今天的工作');
    expect(spoken.parts.at(-1).text).toContain('provided');
    expect(spoken.api.downloadMedia).not.toHaveBeenCalled();
    const raw = await prepare({ item_list: [{ type: 3, voice_item: { encode_type: 6, playtime: 3000, media: image.image_item.media } }] });
    expect(raw.parts.at(-1).text).toContain('original_file_only_not_transcribed');
    expect(raw.parts.at(-1).text).toContain('unavailable');
    expect(raw.parts.filter((part) => part.type === 'file')).toHaveLength(1);
  });

  it('preserves XML/JSON share data, sanitizes embedded capabilities and never fetches article URLs', async () => {
    const { parts, api } = await prepare({ item_list: [{ type: 98, appmsg: {
      xml: '<appmsg><title>文章</title><url>https://mp.weixin.qq.com/s/public</url><aes_key>private-key</aes_key></appmsg>',
      json: '{"title":"其他分享","context_token":"private-context"}',
    } }] });
    expect(parts.at(-1).text).toContain('文章');
    expect(parts.at(-1).text).toContain('其他分享');
    expect(parts.at(-1).text).not.toMatch(/private-key|private-context/);
    expect(api.downloadMedia).not.toHaveBeenCalled();
  });

  it('continues with successful attachments/text when one media item fails, and uses stable upload identities', async () => {
    const api = { downloadMedia: vi.fn().mockRejectedValueOnce(new Error('https://private-url private-key')).mockResolvedValue({ buffer: Buffer.from('good'), mime: 'text/plain', filename: 'note.txt' }) };
    const message = { item_list: [{ type: 1, text_item: { text: '读取附件' } }, image, { type: 4, file_item: { file_name: 'note.txt', media: image.image_item.media } }] };
    const result = await prepare(message, { api });
    expect(result.parts.filter((part) => part.type === 'file')).toHaveLength(1);
    expect(result.parts.at(-1).text).toContain('download_or_storage_failed');
    expect(result.parts.at(-1).text).toContain('attached');
    expect(JSON.stringify(result.parts)).not.toMatch(/private-url|private-key|private-reference/);
    const retry = await prepare(message, { api: { downloadMedia: vi.fn(async () => ({ buffer: Buffer.from('good'), mime: 'text/plain', filename: 'note.txt' })) } });
    expect(result.service.putAssistantContactAttachment.mock.calls[0][1]).toBe(retry.service.putAssistantContactAttachment.mock.calls[1][1]);
  });

  it('bounds metadata depth, strings, items and downloads, explicitly marking truncation', async () => {
    const message = { item_list: Array.from({ length: 100 }, () => ({ ...image, extension: { title: '文'.repeat(20_000), nested: { a: { b: { c: { d: { e: 'too deep' } } } } } } })) };
    const result = await prepare(message);
    expect(result.parts.at(-1).text).toContain('truncated');
    expect(result.parts.at(-1).text.length).toBeLessThan(40_000);
    expect(result.api.downloadMedia).toHaveBeenCalledTimes(8);
    expect(result.receipt.payload.length).toBeLessThan(45_000);
  });

  it('does not admit or upload a stale completion after disconnect, expiry/lease loss or cancellation', async () => {
    let current = true;
    const api = { downloadMedia: vi.fn(async () => { current = false; return { buffer: Buffer.from('bytes'), mime: 'image/png', filename: 'image.png' }; }) };
    const service = { putAssistantContactAttachment: vi.fn() };
    await expect(prepare({ item_list: [image] }, { api, service, assertCurrent: () => { if (!current) throw new Error('cancelled'); } })).rejects.toThrow('cancelled');
    expect(service.putAssistantContactAttachment).not.toHaveBeenCalled();
  });

  it('keeps within the per-turn byte budget and does not charge failed uploads against successful attachments', async () => {
    const api = { downloadMedia: vi.fn(async () => ({ buffer: Buffer.alloc(20 * 1024 * 1024), mime: 'application/octet-stream', filename: 'file.bin' })) };
    const service = { putAssistantContactAttachment: vi.fn().mockRejectedValueOnce(new Error('storage failure'))
      .mockResolvedValue({ type: 'file', attachmentID: 'att_file', mime: 'application/octet-stream', size: 20 * 1024 * 1024 }) };
    const result = await prepare({ item_list: Array.from({ length: 4 }, () => ({ type: 4, file_item: { media: image.image_item.media } })) }, { api, service });
    expect(result.parts.filter((part) => part.type === 'file')).toHaveLength(2);
    expect(service.putAssistantContactAttachment).toHaveBeenCalledTimes(3);
    expect(result.parts.at(-1).text).toContain('size_limit');
    expect(result.parts.at(-1).text).toContain('download_or_storage_failed');
  });
});
