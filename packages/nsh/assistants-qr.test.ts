import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect, it } from 'vitest';
import { assistantQRMatrix, assistantQRSvg } from './assistants-qr';

const require = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), '../ui/package.json'));
const reference = require('qrcode') as { create: (value: Array<{ data: string; mode: string }>, options: { version: number; errorCorrectionLevel: string; maskPattern: number }) => { modules: { size: number; data: Uint8Array } } };
it.each(['https://example.invalid/weixin/login?code=opaque-test', 'a'.repeat(271), '中文🟢 test', 'b'.repeat(1000), 'c'.repeat(2953)])('native QR matches the existing standard encoder byte-for-byte', value => {
  const matrix = assistantQRMatrix(value);
  const expected = reference.create([{ data: value, mode: 'byte' }], { version: (matrix.length - 17) / 4, errorCorrectionLevel: 'L', maskPattern: 0 });
  expect(matrix.length).toBe(expected.modules.size);
  expect(matrix.flat().map(Number)).toEqual(Array.from(expected.modules.data));
});
it('rejects empty/oversized inputs rather than showing corrupted QR or raw bearer payload', () => {
  expect(() => assistantQRSvg('')).toThrow('qr_capacity');
  expect(() => assistantQRSvg('a'.repeat(2954))).toThrow('qr_capacity');
  expect(assistantQRSvg('https://example.invalid')).not.toContain('https://example.invalid');
});
