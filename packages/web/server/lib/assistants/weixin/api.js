import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { downloadWeixinMedia } from './media.js';

// Wire-format reference: Tencent/openclaw-weixin (MIT), docs/protocol.md.
// This is a Yuri transport, not an OpenClaw runtime or a WorkBuddy login client.
const API_ORIGIN = 'https://ilinkai.weixin.qq.com';
const PROTOCOL_VERSION = '2.4.10';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class WeixinError extends Error {
  constructor(code, { ret = null, ambiguous = false } = {}) {
    super(code);
    this.code = code;
    this.ret = ret;
    this.ambiguous = ambiguous;
  }
}

export function weixinOrigin(value = API_ORIGIN) {
  let url;
  try { url = new URL(value.includes('://') ? value : `https://${value}`); } catch { throw new WeixinError('invalid_response'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port
    || !url.hostname.endsWith('.weixin.qq.com') || url.pathname !== '/' || url.search || url.hash) {
    throw new WeixinError('invalid_response');
  }
  return url.origin;
}

export function createWeixinAPI({ fetchImpl = fetch } = {}) {
  const request = async (origin, route, { token, body, signal, timeoutMs = 15_000, sending = false, allowEmpty = false } = {}) => {
    const headers = {
      'Content-Type': 'application/json',
      'iLink-App-Id': 'bot',
      'iLink-App-ClientVersion': String(0x02040a),
    };
    if (body !== undefined) {
      headers.AuthorizationType = 'ilink_bot_token';
      headers['X-WECHAT-UIN'] = Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
    }
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(`${weixinOrigin(origin)}${route}`, {
        method: body === undefined ? 'GET' : 'POST', headers,
        ...(body === undefined ? {} : { body: JSON.stringify(token ? {
          ...body, base_info: { channel_version: PROTOCOL_VERSION, bot_agent: 'Yuri' },
        } : body) }),
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
    } catch {
      if (signal?.aborted) throw new WeixinError('cancelled');
      throw new WeixinError('network_error', { ambiguous: sending });
    }
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new WeixinError('auth_expired');
      throw new WeixinError('network_error', { ambiguous: sending && response.status >= 500 });
    }
    let text = '';
    try {
      if (allowEmpty && !response.body) return {};
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('response_too_large'); }
        chunks.push(value);
      }
      text = Buffer.concat(chunks).toString('utf8');
      if (allowEmpty && !text.trim()) return {};
      // Weixin IDs are uint64; preserve digits before JSON's number conversion.
      const data = JSON.parse(text.replace(/("message_id"\s*:\s*)(\d+)(?=\s*[,}])/g, '$1"$2"'));
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_response');
      if (data.ret === -14 || data.errcode === -14) throw new WeixinError('auth_expired');
      if ((data.ret !== undefined && data.ret !== 0) || (data.errcode !== undefined && data.errcode !== 0)) {
        throw new WeixinError(sending ? 'reply_unavailable' : 'upstream_error', { ret: data.ret ?? data.errcode });
      }
      return data;
    } catch (error) {
      if (error instanceof WeixinError) throw error;
      throw new WeixinError('invalid_response', { ambiguous: sending });
    }
  };
  return {
    downloadMedia: (source, signal) => downloadWeixinMedia(source, { fetchImpl, signal }),
    getQRCode: (signal, localTokens = []) => request(API_ORIGIN, '/ilink/bot/get_bot_qrcode?bot_type=3', {
      body: { local_token_list: localTokens.slice(0, 10) }, signal,
    }),
    getQRStatus: (origin, qrcode, verifyCode, signal) => request(origin, `/ilink/bot/get_qrcode_status?${new URLSearchParams({
      qrcode, ...(verifyCode ? { verify_code: verifyCode } : {}),
    })}`, { signal, timeoutMs: 40_000 }),
    getUpdates: (binding, signal) => request(binding.base_url, '/ilink/bot/getupdates', {
      token: binding.token, body: { get_updates_buf: binding.cursor }, signal, timeoutMs: 40_000,
    }),
    getConfig: (binding, signal) => request(binding.base_url, '/ilink/bot/getconfig', {
      token: binding.token, signal, timeoutMs: 5000,
      body: { ilink_user_id: binding.peer_id, context_token: binding.context_token || undefined },
    }),
    sendTyping: (binding, ticket, status, signal) => request(binding.base_url, '/ilink/bot/sendtyping', {
      token: binding.token, signal, timeoutMs: 5000, allowEmpty: true,
      body: { ilink_user_id: binding.peer_id, typing_ticket: ticket, status },
    }),
    sendImage: async (binding, delivery, signal) => {
      const buffer = delivery.image?.buffer;
      if (!Buffer.isBuffer(buffer) || !buffer.length || buffer.length > 20 * 1024 * 1024) throw new WeixinError('validation_error');
      const key = randomBytes(16);
      const filekey = randomBytes(16).toString('hex');
      const cipher = createCipheriv('aes-128-ecb', key, null);
      const encrypted = Buffer.concat([cipher.update(buffer), cipher.final()]);
      const uploaded = await request(binding.base_url, '/ilink/bot/getuploadurl', {
        token: binding.token, signal,
        body: { filekey, media_type: 1, to_user_id: binding.peer_id, rawsize: buffer.length,
          rawfilemd5: createHash('md5').update(buffer).digest('hex'), filesize: encrypted.length,
          no_need_thumb: true, aeskey: key.toString('hex') },
      });
      const url = new URL(uploaded.upload_full_url || 'https://novac2c.cdn.weixin.qq.com/c2c/upload');
      if (!uploaded.upload_full_url) {
        if (typeof uploaded.upload_param !== 'string' || !uploaded.upload_param) throw new WeixinError('invalid_response');
        url.searchParams.set('encrypted_query_param', uploaded.upload_param);
        url.searchParams.set('filekey', filekey);
      }
      if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port
        || url.username || url.password || url.hash || url.pathname !== '/c2c/upload') throw new WeixinError('invalid_response');
      const uploadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
      uploadSignal.throwIfAborted();
      let response;
      try {
        response = await fetchImpl(url.href, { method: 'POST', body: encrypted, redirect: 'error',
          headers: { 'Content-Type': 'application/octet-stream' }, signal: uploadSignal });
      } catch { throw new WeixinError(signal?.aborted ? 'cancelled' : 'network_error'); }
      await response.body?.cancel().catch(() => {});
      const param = response.headers.get('x-encrypted-param');
      if (response.status !== 200 || !param || param.length > 65_536) throw new WeixinError('invalid_response');
      uploadSignal.throwIfAborted();
      delivery.beforeSend?.();
      return request(binding.base_url, '/ilink/bot/sendmessage', {
        token: binding.token, signal, sending: true,
        body: { msg: { from_user_id: '', to_user_id: binding.peer_id, client_id: delivery.id,
          message_type: 2, message_state: 2, context_token: binding.context_token || undefined,
          item_list: [{ type: 2, image_item: { media: { encrypt_query_param: param,
            aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }, mid_size: encrypted.length } }],
        } },
      });
    },
    sendText: (binding, delivery, signal) => request(binding.base_url, '/ilink/bot/sendmessage', {
      token: binding.token, signal, sending: true,
      body: { msg: {
        from_user_id: '', to_user_id: binding.peer_id, client_id: delivery.id,
        message_type: 2, message_state: 2, context_token: binding.context_token || undefined,
        item_list: [{ type: 1, text_item: { text: delivery.text } }],
      } },
    }),
  };
}
