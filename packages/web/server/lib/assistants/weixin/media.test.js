import { createCipheriv } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { downloadWeixinMedia } from './media.js';

const key = Buffer.from('0123456789abcdef');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6D/8AAAAASUVORK5CYII=', 'base64');
const encrypted = (bytes) => {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
};
const source = { kind: 'image', encrypt_query_param: 'private capability', aes_key: key.toString('base64') };

describe('WeChat CDN media boundary', () => {
  it.each([key.toString('base64'), Buffer.from(key.toString('hex')).toString('base64')])('downloads and decrypts both official AES key encodings', async (aes_key) => {
    const fetchImpl = vi.fn(async () => new Response(encrypted(png)));
    const result = await downloadWeixinMedia({ ...source, aes_key }, { fetchImpl });
    expect(result.buffer).toEqual(png);
    expect(result.mime).toBe('image/png');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(new URL(url).searchParams.get('encrypted_query_param')).toBe('private capability');
    expect(init).toMatchObject({ redirect: 'error' });
    expect(init.headers).toBeUndefined();
  });

  it('prefers the image hex key and a validated full CDN URL; permits plaintext images only', async () => {
    const full_url = 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=full';
    const fetchImpl = vi.fn(async () => new Response(encrypted(png)));
    await expect(downloadWeixinMedia({ ...source, full_url, aeskey: key.toString('hex'), aes_key: 'invalid' }, { fetchImpl }))
      .resolves.toMatchObject({ buffer: png });
    expect(fetchImpl.mock.calls[0][0]).toBe(full_url);
    await expect(downloadWeixinMedia({ kind: 'image', full_url }, { fetchImpl: async () => new Response(png) })).resolves.toMatchObject({ buffer: png });
    await expect(downloadWeixinMedia({ kind: 'voice', full_url }, { fetchImpl })).rejects.toMatchObject({ code: 'media_invalid_key' });
  });

  it.each(['http://novac2c.cdn.weixin.qq.com/c2c/download', 'https://127.0.0.1/c2c/download',
    'https://novac2c.cdn.weixin.qq.com.evil.example/c2c/download', 'https://user:pass@novac2c.cdn.weixin.qq.com/c2c/download',
    'https://novac2c.cdn.weixin.qq.com:8443/c2c/download', 'https://novac2c.cdn.weixin.qq.com/other'])('rejects SSRF/credential destinations before fetching %s', async (full_url) => {
    const fetchImpl = vi.fn();
    await expect(downloadWeixinMedia({ ...source, full_url }, { fetchImpl })).rejects.toMatchObject({ code: 'media_unsafe_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('bounds declared and streaming bytes, cancels oversized bodies and rejects invalid image bytes/padding', async () => {
    await expect(downloadWeixinMedia(source, { fetchImpl: async () => new Response('x', { headers: { 'content-length': String(26 * 1024 * 1024) } }) }))
      .rejects.toMatchObject({ code: 'media_too_large' });
    const cancel = vi.fn();
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(26 * 1024 * 1024)); }, cancel });
    await expect(downloadWeixinMedia(source, { fetchImpl: async () => new Response(body) })).rejects.toMatchObject({ code: 'media_too_large' });
    expect(cancel).toHaveBeenCalled();
    await expect(downloadWeixinMedia(source, { fetchImpl: async () => new Response(encrypted(Buffer.from('<html>not an image</html>'))) }))
      .rejects.toMatchObject({ code: 'media_invalid_image' });
    await expect(downloadWeixinMedia(source, { fetchImpl: async () => new Response(Buffer.alloc(16)) })).rejects.toThrow();
  });

  it('honors cancellation and preserves files/audio/video with safe names and MIME metadata', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(downloadWeixinMedia(source, { signal: controller.signal, fetchImpl: async () => new Response(encrypted(png)) })).rejects.toThrow();
    const file = await downloadWeixinMedia({ ...source, kind: 'file', filename: '..\\..\\notes.md' }, { fetchImpl: async () => new Response(encrypted(Buffer.from('# hello'))) });
    expect(file).toMatchObject({ filename: 'notes.md', mime: 'text/markdown' });
    const voice = await downloadWeixinMedia({ ...source, kind: 'voice', encode_type: 6 }, { fetchImpl: async () => new Response(encrypted(Buffer.from('#!SILK_V3'))) });
    expect(voice.mime).toBe('audio/silk');
    const video = await downloadWeixinMedia({ ...source, kind: 'video' }, { fetchImpl: async () => new Response(encrypted(Buffer.from('video'))) });
    expect(video.mime).toBe('video/mp4');
  });
});
