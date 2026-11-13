import { createHash } from 'node:crypto';

export function observeTerminalFrame(frame) {
  const bytes = frame.opcode === 2 ? Buffer.from(frame.payloadData ?? '', 'base64') : Buffer.from(frame.payloadData ?? '', 'utf8');
  const result = { opcode: frame.opcode, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  if (frame.opcode === 8 && bytes.length >= 2) return { ...result, closeCode: bytes.readUInt16BE(0) };
  let body;
  try { body = JSON.parse((bytes[0] === 1 ? bytes.subarray(1) : bytes).toString('utf8')); } catch { return result; }
  if (!body || typeof body !== 'object' || !['ok', 'b', 'bok', 'e', 'd', 'x', 'pi', 'po'].includes(body.t)) return result;
  result.type = body.t;
  if (Number.isSafeInteger(body.v)) result.version = body.v;
  if (typeof body.s === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(body.s)) result.sessionId = body.s;
  if (typeof body.c === 'string' && /^[A-Z_]{1,64}$/.test(body.c)) result.errorCode = body.c;
  if (typeof body.f === 'boolean') result.fatal = body.f;
  if (body.t === 'd' && typeof body.d === 'string') result.outputBytes = Buffer.byteLength(body.d);
  return result;
}
