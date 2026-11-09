import { isSafeInlineImageMime } from '../fs/prompt-attachment-store.js';

function byteRange(req, size, etag) {
  if (req.method !== 'GET' || typeof req.headers.range !== 'string') return null;
  const validator = req.headers['if-range'];
  if (validator !== undefined && (typeof validator !== 'string' || validator.startsWith('W/') || validator !== etag)) return null;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(req.headers.range.trim());
  // A single range only. Unsupported units, malformed and multipart requests
  // retain the existing complete representation, never a misleading 206.
  if (!match || !match[1] && !match[2]) return null;
  if (size === 0) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix > 0 ? { start: Math.max(0, size - suffix), end: size - 1 } : false;
  }
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  // Canonical objects are bounded in size; oversized decimal endpoints only
  // compare beyond that bound (or clamp), never become a byte offset.
  return start >= size || end < start ? false : { start, end: Math.min(end, size - 1) };
}

/** The service must authorize the Assistant and live generation before calling. */
export function sendContactAttachment(req, res, file) {
  const etag = file.etag || `"${file.sha256}"`;
  res.statusCode = 200;
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Length', String(file.size));
  res.setHeader('ETag', etag);
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // App owns cache; do not let browsers/CDNs immutable-cache attachment bodies.
  res.setHeader('Cache-Control', 'private, no-store');
  const safeInline = isSafeInlineImageMime(file.mime);
  const name = file.filename ? encodeURIComponent(file.filename) : 'attachment';
  res.setHeader('Content-Disposition', `${safeInline ? 'inline' : 'attachment'}; filename*=UTF-8''${name}`);
  const range = byteRange(req, file.size, etag);
  if (range === false) {
    res.statusCode = 416;
    res.setHeader('Content-Range', `bytes */${file.size}`);
    res.setHeader('Content-Length', '0');
    res.end();
    return;
  }
  if (range) {
    res.statusCode = 206;
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
    res.end(file.buffer.subarray(range.start, range.end + 1));
    return;
  }
  res.end(req.method === 'HEAD' ? undefined : file.buffer);
}
