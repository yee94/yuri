import { createRequire } from 'node:module';
import { deepStrictEqual } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { cloneAgentArtworkData } from './agent-avatar-clone';

test('the local data clone matches structuredClone for the complete installed artwork definition and options', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const require = createRequire(path.join(root, 'packages/ui/package.json'));
  const definition: unknown = JSON.parse(readFileSync(require.resolve('@dicebear/styles/bottts-neutral.json'), 'utf8'));
  const options = { seed: '中文/custom-agent', size: 128, idRandomization: false, borderRadius: 0, backgroundColor: ['c1f2c4'], title: undefined };
  for (const source of [definition, options]) {
    const copy = cloneAgentArtworkData(source);
    expect(copy).toStrictEqual(structuredClone(source));
    expect(copy).not.toBe(source);
  }
  const copy = cloneAgentArtworkData(options);
  copy.backgroundColor[0] = 'changed';
  expect(options.backgroundColor).toEqual(['c1f2c4']);
  expect(Object.hasOwn(copy, 'title')).toBe(true);
});

test('cloning preserves numeric values, undefined, sparse arrays, aliases and cycles without JSON serialization', () => {
  const sparse = new Array<unknown>(4);
  sparse[2] = undefined;
  const shared = { value: undefined, negativeZero: -0, infinity: Infinity, notANumber: NaN };
  const source: { first: typeof shared; second: typeof shared; sparse: unknown[]; self?: unknown } = { first: shared, second: shared, sparse };
  source.self = source;
  const copy = cloneAgentArtworkData(source);
  expect(copy).toStrictEqual(structuredClone(source));
  expect(copy.first).not.toBe(shared);
  expect(copy.first).toBe(copy.second);
  expect(copy.self).toBe(copy);
  expect(Object.is(copy.first.negativeZero, -0)).toBe(true);
  expect(0 in copy.sparse).toBe(false);
  expect(2 in copy.sparse).toBe(true);
});

test('prototype-sensitive keys remain own data and null-prototype data follows standard clone semantics', () => {
  const source = Object.create(null);
  Object.defineProperty(source, '__proto__', { value: { polluted: true }, enumerable: true });
  Object.defineProperty(source, 'constructor', { value: { name: 'not-a-class' }, enumerable: true });
  const copy = cloneAgentArtworkData(source);
  deepStrictEqual(copy, structuredClone(source));
  expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
  expect(Object.hasOwn(copy, '__proto__')).toBe(true);
  expect(Object.prototype).not.toHaveProperty('polluted');
});

test('unsupported values fail explicitly instead of silently dropping or changing them', () => {
  for (const value of [() => 1, Symbol('unsupported'), 1n, new Date(), new Map(), new Set(), /pattern/, new (class Data {})()]) {
    expect(() => cloneAgentArtworkData({ nested: value })).toThrow(TypeError);
  }
});
