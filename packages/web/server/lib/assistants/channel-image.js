import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { BlockList, isIP } from 'node:net';
import { collectRequestBytes, decodeDataUrlStrict, assertImageContentMatchesMime } from '../fs/prompt-attachment-store.js';

const MAX_BYTES = 20 * 1024 * 1024;
const blocked = new BlockList();
for (const [ip, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) blocked.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6');

const fail = () => { throw Object.assign(new Error('image_unavailable'), { code: 'image_unavailable' }); };
const within = (root, value) => value === root || value.startsWith(`${root}${path.sep}`);

/** HTTPS only, pinned public DNS, no redirects, cookies, auth forwarding or proxy. */
async function download(url, signal) {
  const target = new URL(url);
  if (target.protocol !== 'https:' || target.port || target.username || target.password || target.hash) fail();
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address, family }) => family === 6
    ? !globalV6.check(address, 'ipv6') || blocked.check(address, 'ipv6')
    : blocked.check(address, 'ipv4'))) fail();
  signal.throwIfAborted();
  const pinned = addresses[0];
  return new Promise((resolve, reject) => {
    const req = request(target, { signal, lookup: (_host, options, callback) => options?.all
      ? callback(null, [pinned]) : callback(null, pinned.address, pinned.family) }, async (response) => {
      try {
        if (response.statusCode !== 200 || Number(response.headers['content-length']) > MAX_BYTES) {
          response.destroy();
          fail();
        }
        const { buffer } = await collectRequestBytes(response, { maxBytes: MAX_BYTES, signal });
        resolve(buffer);
      } catch (error) { response.destroy(); reject(error); }
    });
    req.on('error', reject);
    req.end();
  });
}

function imageMime(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (/^GIF8[79]a$/.test(buffer.subarray(0, 6).toString())) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  if (buffer.subarray(0, 2).toString() === 'BM') return 'image/bmp';
  fail();
}

/** Local authority is the Bot cwd, registered projects and generator temp files. */
export async function loadChannelImage(source, { cwd, allowedRoots, signal, readAttachment }) {
  const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
  deadline.throwIfAborted();
  let buffer;
  if (source.attachmentID) {
    ({ buffer } = await readAttachment(source.attachmentID));
  } else if (typeof source.url !== 'string' || source.url.length > MAX_BYTES * 1.4) {
    fail();
  } else if (source.url.startsWith('data:')) {
    ({ buffer } = decodeDataUrlStrict(source.url, { maxBytes: MAX_BYTES }));
  } else if (/^https?:/i.test(source.url)) {
    buffer = await download(source.url, deadline);
  } else {
    let candidate = source.url;
    if (candidate.startsWith('file:')) candidate = fileURLToPath(candidate);
    else if ((!path.isAbsolute(candidate) && /^[a-z][a-z0-9+.-]*:/i.test(candidate)) || candidate.startsWith('//') || candidate.startsWith('\\\\')) fail();
    if (candidate.startsWith('~/')) candidate = path.join(os.homedir(), candidate.slice(2));
    const resolved = await fs.realpath(path.resolve(cwd, candidate));
    const roots = await Promise.all([cwd, ...allowedRoots, os.tmpdir()].map((root) => fs.realpath(root).catch(() => null)));
    if (!roots.some((root) => root && within(root, resolved))) fail();
    const handle = await fs.open(resolved, 'r');
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) fail();
      ({ buffer } = await collectRequestBytes(handle.createReadStream({ autoClose: false }), { maxBytes: MAX_BYTES, signal: deadline }));
    } finally { await handle.close(); }
  }
  deadline.throwIfAborted();
  if (!buffer?.length || buffer.length > MAX_BYTES) fail();
  const mime = imageMime(buffer);
  assertImageContentMatchesMime(buffer, mime);
  return { buffer, mime, filename: `image.${mime === 'image/jpeg' ? 'jpg' : mime.slice(6)}` };
}
