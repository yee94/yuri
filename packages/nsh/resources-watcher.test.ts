import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createResourceWatcher } from './resources-watcher';
import { resourceStatFrom, resourceWatchable, type ResourceStat } from './resources-model';
import { bindResourceStat } from './resources-request';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
const stat = (mtimeMs = 1, size = 10, isBinary = false): ResourceStat => ({ mtimeMs, size, isBinary });
const flush = async () => { for (let i = 0; i < 16; i++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void, reject!: (cause: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let current = true, available = true, identity = 'original';
  const read = vi.fn<() => Promise<ResourceStat | undefined>>(async () => stat());
  const metadata = vi.fn(async () => stat()), failed = vi.fn();
  const watcher = createResourceWatcher({ current: () => current, identity: () => identity, available: () => available, stat: metadata, read, failed });
  return { watcher, read, metadata, failed, hidden: () => { current = false; watcher.pause(); }, resume: () => { current = true; watcher.start(); }, change: () => { identity = 'replacement'; }, busy: (value: boolean) => { available = !value; } };
}
test('uses real fs stat envelope and rejects failed/optional-empty metadata; bitmap files do not watch', async () => {
  const request = vi.fn(async () => ({ isFile: true, ...stat() }));
  const scope = { hostID: 'host', lease: '00000000-0000-4000-8000-000000000001' };
  expect(await bindResourceStat(scope, request)('/fixture/a #?.svg')).toEqual(stat());
  expect(request).toHaveBeenCalledWith('/api/fs/stat?path=%2Ffixture%2Fa%20%23%3F.svg');
  await expect(bindResourceStat(null, request)('/fixture/a')).rejects.toThrow('scope_required');
  for (const value of [{ exists: false }, {}, { isFile: true, ...stat(), mtimeMs: NaN }, { isFile: true, ...stat(), isBinary: undefined }]) expect(() => resourceStatFrom(value)).toThrow();
  for (const path of ['image.PNG', 'a.jpeg', 'b.gif', 'c.webp', 'd.heic']) expect(resourceWatchable(path)).toBe(false);
  for (const path of ['a.svg', 'index.html', 'file.txt', 'file.bin']) expect(resourceWatchable(path)).toBe(true);
});
test('single 2sec timer uses the pre-read baseline and catches edits during the initial download', async () => {
  const f = fixture(), initial = deferred<ResourceStat>(); f.read.mockReturnValueOnce(initial.promise);
  f.watcher.start(); void f.watcher.refresh();
  await vi.advanceTimersByTimeAsync(10_000); expect(f.metadata).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledTimes(1);
  initial.resolve(stat(1)); await flush(); f.metadata.mockResolvedValue(stat(2)); f.read.mockResolvedValue(stat(2));
  await vi.advanceTimersByTimeAsync(2_000); expect(f.read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(20_000); expect(f.read).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(1);
  f.watcher.dispose(); expect(vi.getTimerCount()).toBe(0);
});
test('changed size/mtime/binary refreshes; failed read/stat retains baseline and retries rather than false unchanged success', async () => {
  const f = fixture(); await f.watcher.refresh(); f.watcher.start();
  f.metadata.mockRejectedValueOnce(new Error('stat unavailable'));
  await vi.advanceTimersByTimeAsync(2_000); expect(f.failed).toHaveBeenCalledTimes(1); expect(f.read).toHaveBeenCalledTimes(1);
  f.metadata.mockResolvedValue(stat(1, 11)); f.read.mockRejectedValueOnce(new Error('read unavailable'));
  await vi.advanceTimersByTimeAsync(2_000); expect(f.failed).toHaveBeenCalledTimes(2);
  f.read.mockResolvedValue(stat(1, 11)); await vi.advanceTimersByTimeAsync(2_000); expect(f.read).toHaveBeenCalledTimes(3);
  f.metadata.mockResolvedValue(stat(1, 11, true)); f.read.mockResolvedValue(stat(1, 11, true));
  await vi.advanceTimersByTimeAsync(2_000); expect(f.read).toHaveBeenCalledTimes(4);
  f.watcher.dispose();
});
test.each(['hide', 'scope', 'source', 'dispose'])('%s rejects late stat callbacks with zero ghost reads', async reason => {
  const f = fixture(), pending = deferred<ResourceStat>(); await f.watcher.refresh(); f.metadata.mockReturnValue(pending.promise); f.watcher.start();
  await vi.advanceTimersByTimeAsync(2_000);
  if (reason === 'dispose') f.watcher.dispose(); else if (reason === 'source') f.change(); else f.hidden();
  pending.resolve(stat(2)); await flush(); expect(f.read).toHaveBeenCalledTimes(1); expect(f.failed).not.toHaveBeenCalled();
  f.watcher.dispose(); expect(vi.getTimerCount()).toBe(0);
});
test('manual requests coalesce behind stat/read; pause drops queued requests and resume waits for the previous lane', async () => {
  const f = fixture(), pending = deferred<ResourceStat>(); await f.watcher.refresh(); f.metadata.mockReturnValueOnce(pending.promise); f.watcher.start();
  await vi.advanceTimersByTimeAsync(2_000); void f.watcher.refresh(); void f.watcher.refresh();
  expect(f.read).toHaveBeenCalledTimes(1); pending.resolve(stat()); await flush(); expect(f.read).toHaveBeenCalledTimes(2);
  const old = deferred<ResourceStat>(); f.read.mockReturnValueOnce(old.promise); void f.watcher.refresh(); void f.watcher.refresh(); f.hidden(); f.resume();
  await vi.advanceTimersByTimeAsync(2_000); expect(f.read).toHaveBeenCalledTimes(3); old.resolve(stat()); await flush();
  expect(f.read).toHaveBeenCalledTimes(3); expect(vi.getTimerCount()).toBe(1); f.watcher.dispose();
});
test('a missing legacy baseline forces one read and busy/native presentation does no stat work', async () => {
  const f = fixture(); f.read.mockResolvedValueOnce(undefined); await f.watcher.refresh(); f.watcher.start(); f.busy(true);
  await vi.advanceTimersByTimeAsync(6_000); expect(f.metadata).not.toHaveBeenCalled();
  f.busy(false); await vi.advanceTimersByTimeAsync(2_000); expect(f.read).toHaveBeenCalledTimes(2); f.watcher.dispose();
});
