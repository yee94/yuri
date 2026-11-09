import http from 'node:http';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sendContactAttachment } from './contact-attachment-response.js';

const buffer = Buffer.from('0123456789');
const sha256 = createHash('sha256').update(buffer).digest('hex');
const etag = `"${sha256}"`;
const file = { buffer, size: buffer.length, sha256, etag, mime: 'application/octet-stream', filename: '档案.bin' };
const binary = Buffer.from([0, 255, 128, 13, 10, 240, 1, 2]);
let server, base;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const body = req.url === '/binary' ? binary : req.url === '/empty' ? Buffer.alloc(0) : null;
    sendContactAttachment(req, res, body ? { buffer: body, size: body.length,
      sha256: createHash('sha256').update(body).digest('hex'), mime: 'application/octet-stream' } : file);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}/authorized-attachment`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

test('ordinary GET preserves complete bytes, privacy, MIME, strong ETag and safe filename', async () => {
  const response = await fetch(base);
  expect(response.status).toBe(200); expect(await response.text()).toBe('0123456789');
  expect(response.headers.get('content-length')).toBe('10');
  expect(response.headers.get('content-type')).toBe('application/octet-stream');
  expect(response.headers.get('etag')).toBe(etag);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('content-disposition')).toBe(`attachment; filename*=UTF-8''${encodeURIComponent('档案.bin')}`);
  expect(response.headers.get('content-range')).toBeNull();
});

for (const [range, body, contentRange] of [
  ['bytes=4-', '456789', 'bytes 4-9/10'],
  ['bytes=2-5', '2345', 'bytes 2-5/10'],
  ['bytes=-3', '789', 'bytes 7-9/10'],
  ['bytes=8-999999999999999999999999', '89', 'bytes 8-9/10'],
  ['bytes=-999999999999999999999999', '0123456789', 'bytes 0-9/10'],
]) test('authorized single range ' + range + ' returns exact bytes and complete-source identity', async () => {
  const response = await fetch(base, { headers: { Range: range, 'If-Range': etag } });
  expect(response.status).toBe(206); expect(await response.text()).toBe(body);
  expect(response.headers.get('content-length')).toBe(String(body.length));
  expect(response.headers.get('content-range')).toBe(contentRange);
  expect(response.headers.get('accept-ranges')).toBe('bytes');
  expect(response.headers.get('etag')).toBe(etag);
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

for (const validator of ['"different"', `W/${etag}`, new Date(0).toUTCString()]) test('If-Range mismatch or unsupported date/weak validator returns the complete representation: ' + validator, async () => {
  const response = await fetch(base, { headers: { Range: 'bytes=4-', 'If-Range': validator } });
  expect(response.status).toBe(200); expect(await response.text()).toBe('0123456789');
  expect(response.headers.get('content-length')).toBe('10'); expect(response.headers.get('content-range')).toBeNull();
});

for (const range of ['bytes=10-', 'bytes=999999999999999999999999-', 'bytes=5-2', 'bytes=-0']) test('unsatisfiable single range returns 416 without attachment bytes: ' + range, async () => {
  const response = await fetch(base, { headers: { Range: range, 'If-Range': etag } });
  expect(response.status).toBe(416); expect(await response.text()).toBe('');
  expect(response.headers.get('content-range')).toBe('bytes */10'); expect(response.headers.get('content-length')).toBe('0');
  expect(response.headers.get('cache-control')).toBe('private, no-store');
});

for (const range of ['items=0-1', 'bytes=oops', 'bytes=-', 'bytes=0-1,3-4']) test('unsupported or malformed range is ignored, never mislabeled as a partial body: ' + range, async () => {
  const response = await fetch(base, { headers: { Range: range } });
  expect(response.status).toBe(200); expect(await response.text()).toBe('0123456789');
  expect(response.headers.get('content-range')).toBeNull();
});

test('range without If-Range is supported, but HEAD retains complete length without bytes', async () => {
  const partial = await fetch(base, { headers: { Range: 'bytes=1-2' } });
  expect(partial.status).toBe(206); expect(await partial.text()).toBe('12');
  const head = await fetch(base, { method: 'HEAD', headers: { Range: 'bytes=1-2' } });
  expect(head.status).toBe(200); expect(await head.text()).toBe('');
  expect(head.headers.get('content-length')).toBe('10'); expect(head.headers.get('content-range')).toBeNull();
});

test('binary prefix plus resumed suffix reconstructs the exact canonical SHA-256 without text conversion', async () => {
  const url = new URL('/binary', base), full = await fetch(url);
  const fullBytes = Buffer.from(await full.arrayBuffer());
  const partial = await fetch(url, { headers: { Range: 'bytes=3-', 'If-Range': full.headers.get('etag') } });
  expect(partial.status).toBe(206);
  const resumed = Buffer.concat([fullBytes.subarray(0, 3), Buffer.from(await partial.arrayBuffer())]);
  expect(resumed).toEqual(binary);
  expect(createHash('sha256').update(resumed).digest('hex')).toBe(full.headers.get('etag').slice(1, -1));
  expect(partial.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''attachment");
});

test('empty legacy objects have no satisfiable range, while stale If-Range takes precedence over an unsatisfiable range', async () => {
  const empty = await fetch(new URL('/empty', base), { headers: { Range: 'bytes=0-' } });
  expect(empty.status).toBe(416); expect(await empty.text()).toBe('');
  expect(empty.headers.get('content-range')).toBe('bytes */0');
  const stale = await fetch(base, { headers: { Range: 'bytes=100-', 'If-Range': '"stale"' } });
  expect(stale.status).toBe(200); expect(await stale.text()).toBe('0123456789');
  expect(stale.headers.get('content-range')).toBeNull();
});
