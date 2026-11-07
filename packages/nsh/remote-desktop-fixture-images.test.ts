import { inflateSync } from 'node:zlib';
import { expect, test } from 'vitest';
import { remoteDesktopFixtureBrokenJPEG, remoteDesktopFixtureJPEG, remoteDesktopFixturePNG } from './remote-desktop-fixture-images';

const bytes = (source: string) => Buffer.from(source.split(',')[1], 'base64');
function crc32(data: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

test('PNG control has valid chunk CRCs and a complete 1×1 RGBA scanline (not a native decode test)', () => {
  const png = bytes(remoteDesktopFixturePNG), compressed: Buffer[] = [];
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  let offset = 8;
  const kinds: string[] = [];
  while (offset < png.length) {
    const size = png.readUInt32BE(offset), type = png.toString('ascii', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + size);
    expect(crc32(png.subarray(offset + 4, offset + 8 + size))).toBe(png.readUInt32BE(offset + 8 + size));
    kinds.push(type);
    if (type === 'IHDR') {
      expect(body.readUInt32BE(0)).toBe(1); expect(body.readUInt32BE(4)).toBe(1);
      expect([...body.subarray(8)]).toEqual([8, 6, 0, 0, 0]);
    }
    if (type === 'IDAT') compressed.push(body);
    offset += size + 12;
  }
  expect(offset).toBe(png.length);
  expect(kinds).toEqual(['IHDR', 'IDAT', 'IEND']);
  expect([...inflateSync(Buffer.concat(compressed))]).toEqual([0, 0, 0, 0, 255]);
});

test('shared JPEG probe bytes exactly preserve the initial synthetic fixture, without claiming native decode', () => {
  expect(bytes(remoteDesktopFixtureJPEG.source)).toEqual(Buffer.from([
    0xff, 0xd8,
    0xff, 0xdb, 0, 67, 0, ...Array(64).fill(1),
    0xff, 0xc0, 0, 11, 8, 0, 9, 0, 16, 1, 1, 0x11, 0,
    0xff, 0xc4, 0, 20, 0, 1, ...Array(15).fill(0), 0,
    0xff, 0xc4, 0, 20, 0x10, 1, ...Array(15).fill(0), 0,
    0xff, 0xda, 0, 8, 1, 1, 0, 0, 63, 0, 0,
    0xff, 0xd9,
  ]));
  expect(remoteDesktopFixtureJPEG.width).toBe(16); expect(remoteDesktopFixtureJPEG.height).toBe(9);
});

test('broken JPEG is deliberately not a JPEG and remains an independent onError control', () => {
  expect(bytes(remoteDesktopFixtureBrokenJPEG).toString('utf8')).toBe('not-a-valid-jpeg');
  expect(bytes(remoteDesktopFixtureBrokenJPEG).subarray(0, 2)).not.toEqual(Buffer.from([0xff, 0xd8]));
});
