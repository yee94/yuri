import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { trackedPathsFromIndex } from './source-inventory.mjs';

const index = (paths, version = 2, extension = Buffer.alloc(0)) => {
  const header = Buffer.alloc(12);
  header.write('DIRC'); header.writeUInt32BE(version, 4); header.writeUInt32BE(paths.length, 8);
  const entries = paths.map(file => {
    const name = Buffer.from(file), entry = Buffer.alloc(Math.ceil((62 + name.length + 1) / 8) * 8);
    entry.writeUInt16BE(name.length, 60); name.copy(entry, 62); return entry;
  });
  const body = Buffer.concat([header, ...entries, extension]);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
};

test('read-only index inventory preserves tracked ignored paths and Unicode, sorts and deduplicates stages', () => {
  expect(trackedPathsFromIndex(index(['src/中文.ts', '.ignored/tracked.ts', 'src/a.ts', 'src/a.ts']))).toEqual(['.ignored/tracked.ts', 'src/a.ts', 'src/中文.ts']);
});

test('index inventory fails closed for unsupported formats, tampering, unsafe paths and split indexes', () => {
  expect(() => trackedPathsFromIndex(index(['a'], 4))).toThrow('Unsupported');
  const damaged = index(['a']); damaged[30] ^= 1;
  expect(() => trackedPathsFromIndex(damaged)).toThrow('checksum');
  expect(() => trackedPathsFromIndex(index(['../outside']))).toThrow('Unsafe');
  const extension = Buffer.alloc(8); extension.write('link');
  expect(() => trackedPathsFromIndex(index(['a'], 2, extension))).toThrow('Split/sparse');
});
