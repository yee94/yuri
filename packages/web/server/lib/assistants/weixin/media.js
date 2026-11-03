import { createDecipheriv } from 'node:crypto';
import path from 'node:path';
import { MAX_PROMPT_ATTACHMENT_BYTES } from '../../fs/prompt-attachment-store.js';

const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c/download';
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const aesKey = (source) => {
  if (source.aeskey) {
    if (!/^[a-f\d]{32}$/i.test(source.aeskey)) fail('media_invalid_key');
    return Buffer.from(source.aeskey, 'hex');
  }
  if (!source.aes_key) return null;
  if (!/^[A-Za-z\d+/]+={0,2}$/.test(source.aes_key)) fail('media_invalid_key');
  const decoded = Buffer.from(source.aes_key, 'base64');
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[a-f\d]{32}$/i.test(decoded.toString('ascii'))) return Buffer.from(decoded.toString('ascii'), 'hex');
  fail('media_invalid_key');
};

const imageMime = (buffer) => {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 2).toString() === 'BM') return 'image/bmp';
  if (buffer.subarray(4, 8).toString() === 'ftyp') {
    const brand = buffer.subarray(8, 12).toString();
    if (['avif', 'avis'].includes(brand)) return 'image/avif';
    if (['heic', 'heix', 'hevc', 'hevx', 'mif1'].includes(brand)) return 'image/heic';
  }
  fail('media_invalid_image');
};

export async function downloadWeixinMedia(source, { fetchImpl = fetch, signal } = {}) {
  const url = new URL(source.full_url || CDN);
  if (!source.full_url) url.searchParams.set('encrypted_query_param', source.encrypt_query_param || '');
  // Media references are capabilities, not arbitrary user-provided fetch targets.
  if (url.protocol !== 'https:' || url.hostname !== 'novac2c.cdn.weixin.qq.com' || url.port
    || url.username || url.password || url.hash || url.pathname !== '/c2c/download') fail('media_unsafe_url');
  if (!source.full_url && !source.encrypt_query_param) fail('media_missing_reference');
  const key = aesKey(source);
  if (!key && source.kind !== 'image') fail('media_invalid_key');
  const limit = Math.min(MAX_PROMPT_ATTACHMENT_BYTES, 20 * 1024 * 1024);
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
  requestSignal.throwIfAborted();
  const response = await fetchImpl(url.href, { redirect: 'error', signal: requestSignal });
  if (!response.ok || !response.body) fail('media_download_failed');
  if (Number(response.headers.get('content-length')) > limit + 16) {
    await response.body.cancel(); fail('media_too_large');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      requestSignal.throwIfAborted();
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > limit + 16) fail('media_too_large');
      chunks.push(chunk.value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  let buffer = Buffer.concat(chunks, size);
  if (key) {
    const decipher = createDecipheriv('aes-128-ecb', key, null);
    buffer = Buffer.concat([decipher.update(buffer), decipher.final()]);
  }
  if (!buffer.length || buffer.length > limit) fail('media_too_large');
  const originalName = typeof source.filename === 'string' ? path.posix.basename(source.filename.replace(/\\/g, '/')) : '';
  const filename = originalName.replace(/[\x00-\x1f\x7f]/g, '').replace(/\.\./g, '_').slice(-128) || `weixin-${source.kind}`;
  const fileMimes = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
    '.pdf': 'application/pdf', '.xml': 'application/xml', '.html': 'text/html', '.zip': 'application/zip' };
  const voiceMimes = { 1: 'audio/pcm', 2: 'audio/adpcm', 4: 'audio/speex', 5: 'audio/amr', 6: 'audio/silk', 7: 'audio/mpeg', 8: 'audio/ogg' };
  const mime = source.kind === 'image' ? imageMime(buffer) : source.kind === 'video' ? 'video/mp4'
    : source.kind === 'voice' ? voiceMimes[source.encode_type] || 'application/octet-stream'
      : fileMimes[path.extname(filename).toLowerCase()] || 'application/octet-stream';
  return { buffer, mime, filename };
}
