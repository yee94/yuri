import { expect, it, vi } from 'vitest';
import { createNativeCatalogCache } from './catalog-cache';
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

it('seeds immediately, shares concurrent GETs, but refreshes on every later open including empty success', async () => {
  const cache = createNativeCatalogCache(), gate = deferred<string[]>(), load = vi.fn(() => gate.promise);
  const first = cache.refresh('host:dir:providers', load), second = cache.refresh('host:dir:providers', load);
  expect(first).toBe(second); await Promise.resolve(); expect(load).toHaveBeenCalledTimes(1);
  gate.resolve(['model']); await first; expect(cache.peek('host:dir:providers')).toEqual(['model']);
  await cache.refresh('host:dir:providers', async () => []); expect(cache.peek('host:dir:providers')).toEqual([]);
  await cache.refresh('host:dir:providers', async () => ['new']); expect(cache.peek('host:dir:providers')).toEqual(['new']);
});
it('preserves prior success on failure and isolates Host, authorization lease and directory', async () => {
  const cache = createNativeCatalogCache(); cache.write('a:lease:dir', ['prior']);
  await expect(cache.refresh('a:lease:dir', async () => { throw Error('offline'); })).rejects.toThrow('offline');
  expect(cache.peek('a:lease:dir')).toEqual(['prior']);
  for (const key of ['b:lease:dir', 'a:new:dir', 'a:lease:other']) expect(cache.peek(key)).toBeUndefined();
});
it('fences a late GET after mutation and a retired cache entry', async () => {
  const cache = createNativeCatalogCache(), gate = deferred<string[]>();
  const get = cache.refresh('settings', () => gate.promise); await Promise.resolve(); cache.write('settings', ['confirmed']);
  gate.resolve(['stale']); expect(await get).toEqual(['confirmed']); expect(cache.peek('settings')).toEqual(['confirmed']);
  const retired = deferred<string[]>(), old = cache.refresh('settings', () => retired.promise);
  await Promise.resolve(); cache.clear(); retired.resolve(['old']); await old; expect(cache.peek('settings')).toBeUndefined();
});
it('bounds LRU count and bytes, including failed/empty lanes', async () => {
  const cache = createNativeCatalogCache(2, 100); cache.write('a', ['one']); cache.write('b', ['two']); cache.peek('a'); cache.write('c', []);
  expect(cache.peek('b')).toBeUndefined(); expect(cache.peek('a')).toEqual(['one']);
  cache.write('oversize', 'x'.repeat(100)); expect(cache.peek('oversize')).toBeUndefined();
  for (let i = 0; i < 100; i++) await cache.refresh(`empty-${i}`, async () => []);
  expect(cache.peek('a')).toBeUndefined(); expect(cache.peek('empty-99')).toEqual([]);
});
it('an unchanged authoritative catalog preserves its reference for mounted consumers', async () => {
  const cache = createNativeCatalogCache(), first = { providers: [{ id: 'p', models: { m: { id: 'm' } } }] };
  cache.write('catalog', first);
  const refreshed = await cache.refresh('catalog', async () => JSON.parse(JSON.stringify(first)));
  expect(refreshed).toBe(first); expect(cache.peek('catalog')).toBe(first);
});
