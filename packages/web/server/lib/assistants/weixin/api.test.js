import { describe, expect, it, vi } from 'vitest';
import { createWeixinAPI, weixinOrigin } from './api.js';
import { createDecipheriv, createHash } from 'node:crypto';

const binding = { base_url: 'https://ilinkai.weixin.qq.com', token: 'test-token', peer_id: 'owner', cursor: 'cursor', context_token: 'context' };

describe('Weixin wire transport', () => {
  it('encrypts/uploads the image without bot credentials on CDN, then sends a native image with stable ID', async () => {
    const buffer = Buffer.from('image bytes');
    const fetchImpl = vi.fn(async (url) => String(url).includes('getuploadurl') ? Response.json({ ret: 0, upload_param: 'upload-capability' })
      : String(url).includes('/c2c/upload') ? new Response(null, { headers: { 'x-encrypted-param': 'download-capability' } }) : Response.json({ ret: 0 }));
    await createWeixinAPI({ fetchImpl }).sendImage(binding, { id: 'image-stable', image: { buffer } });
    const uploadRequest = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(uploadRequest).toMatchObject({ media_type: 1, to_user_id: 'owner', rawsize: buffer.length, rawfilemd5: createHash('md5').update(buffer).digest('hex'), no_need_thumb: true });
    const [cdnURL, cdn] = fetchImpl.mock.calls[1];
    expect(new URL(cdnURL).searchParams.get('encrypted_query_param')).toBe('upload-capability');
    expect(cdn.headers.Authorization).toBeUndefined();
    expect(cdn.redirect).toBe('error');
    const decrypt = createDecipheriv('aes-128-ecb', Buffer.from(uploadRequest.aeskey, 'hex'), null);
    expect(Buffer.concat([decrypt.update(cdn.body), decrypt.final()])).toEqual(buffer);
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body).msg).toMatchObject({ client_id: 'image-stable', to_user_id: 'owner', context_token: 'context',
      item_list: [{ type: 2, image_item: { media: { encrypt_query_param: 'download-capability', aes_key: Buffer.from(uploadRequest.aeskey).toString('base64'), encrypt_type: 1 }, mid_size: cdn.body.length } }] });
  });

  it('never sends an image after a rejected upload, unsafe CDN or stale generation', async () => {
    for (const mode of ['unsafe', 'missing-header', 'stale']) {
      const fetchImpl = vi.fn(async (url) => String(url).includes('getuploadurl')
        ? Response.json(mode === 'unsafe' ? { upload_full_url: 'https://127.0.0.1/c2c/upload' } : { upload_param: 'opaque' })
        : new Response(null, { headers: mode === 'stale' ? { 'x-encrypted-param': 'download' } : {} }));
      await expect(createWeixinAPI({ fetchImpl }).sendImage(binding, { id: 'id', image: { buffer: Buffer.from('image') },
        beforeSend: () => { throw new Error('cancelled'); } })).rejects.toThrow();
      expect(fetchImpl.mock.calls.some(([url]) => String(url).endsWith('sendmessage'))).toBe(false);
    }
  });
  it('uses QR POST, app headers and private local-token hints without bot authorization', async () => {
    const fetchImpl = vi.fn(async () => Response.json({ qrcode: 'opaque', qrcode_img_content: 'https://example.com/qr' }));
    await createWeixinAPI({ fetchImpl }).getQRCode(undefined, ['existing']);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body)).toEqual({ local_token_list: ['existing'] });
  });

  it('preserves uint64 message IDs and passes cursor, owner and context through the text API', async () => {
    const fetchImpl = vi.fn(async (url) => url.endsWith('getupdates')
      ? new Response('{"ret":0,"msgs":[{"message_id":18446744073709551615}],"get_updates_buf":"next"}')
      : Response.json({ ret: 0 }));
    const api = createWeixinAPI({ fetchImpl });
    expect((await api.getUpdates(binding)).msgs[0].message_id).toBe('18446744073709551615');
    await api.sendText(binding, { id: 'delivery-id', text: '你好' });
    const [, init] = fetchImpl.mock.calls[1];
    expect(init.headers.Authorization).toBe('Bearer test-token');
    expect(init.headers.AuthorizationType).toBe('ilink_bot_token');
    expect(JSON.parse(init.body)).toMatchObject({
      base_info: { bot_agent: 'Yuri' },
      msg: { client_id: 'delivery-id', to_user_id: 'owner', context_token: 'context', item_list: [{ type: 1, text_item: { text: '你好' } }] },
    });
  });

  it('does not treat HTTP 200 with a failed business code as delivered', async () => {
    const api = createWeixinAPI({ fetchImpl: async () => Response.json({ ret: -2, errmsg: 'private upstream body' }) });
    await expect(api.sendText(binding, { id: 'id', text: 'reply' })).rejects.toMatchObject({ code: 'reply_unavailable', ret: -2, ambiguous: false });
    const expired = createWeixinAPI({ fetchImpl: async () => Response.json({ ret: -14 }) });
    await expect(expired.getUpdates(binding)).rejects.toMatchObject({ code: 'auth_expired' });
  });

  it('requests a per-user ticket and sends start/cancel with authenticated bot metadata', async () => {
    const fetchImpl = vi.fn(async (url) => url.endsWith('getconfig')
      ? Response.json({ ret: 0, typing_ticket: 'test-ticket' }) : new Response(null, { status: 204 }));
    const api = createWeixinAPI({ fetchImpl });
    const signal = new AbortController().signal;
    const config = await api.getConfig(binding, signal);
    await api.sendTyping(binding, config.typing_ticket, 1, signal);
    await api.sendTyping(binding, config.typing_ticket, 2);
    expect(fetchImpl.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/ilink/bot/getconfig', '/ilink/bot/sendtyping', '/ilink/bot/sendtyping',
    ]);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      ilink_user_id: 'owner', context_token: 'context', base_info: { channel_version: '2.4.10', bot_agent: 'Yuri' },
    });
    for (const [index, status] of [[1, 1], [2, 2]]) {
      const init = fetchImpl.mock.calls[index][1];
      expect(init.headers.Authorization).toBe('Bearer test-token');
      expect(JSON.parse(init.body)).toMatchObject({ ilink_user_id: 'owner', typing_ticket: 'test-ticket', status });
    }
  });

  it('does not ignore failed typing business codes or accept an empty ticket response as valid JSON', async () => {
    const failed = createWeixinAPI({ fetchImpl: async () => Response.json({ ret: -2 }) });
    await expect(failed.sendTyping(binding, 'ticket', 1)).rejects.toMatchObject({ code: 'upstream_error' });
    const empty = createWeixinAPI({ fetchImpl: async () => new Response('') });
    await expect(empty.getConfig(binding)).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(empty.sendTyping(binding, 'ticket', 2)).resolves.toEqual({});
  });

  it('distinguishes uncertain send failures and never exposes upstream credentials', async () => {
    const api = createWeixinAPI({ fetchImpl: async () => { throw new Error('test-token context secret'); } });
    await expect(api.sendText(binding, { id: 'id', text: 'reply' })).rejects.toMatchObject({ message: 'network_error', ambiguous: true });
    await expect(api.getUpdates(binding)).rejects.toMatchObject({ ambiguous: false });
  });

  it.each(['http://ilinkai.weixin.qq.com', 'https://evil.example', 'https://ilinkai.weixin.qq.com.evil.example',
    'https://user:password@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:8443', 'https://ilinkai.weixin.qq.com/path'])('rejects credential redirects to %s', (url) => {
    expect(() => weixinOrigin(url)).toThrow('invalid_response');
  });
});
