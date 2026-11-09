import { expect, test, vi } from 'vitest';
import { resolveNewSessionWriterDirectory } from './new-session-directory';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };

test.each([
  ['/selected/symlink', '/actual/repository'],
  ['C:\\selected\\link', 'C:\\actual\\repository'],
  ['//server/share/link', '//server/share/repository'],
  ['/selected/space and #?', '/actual/space and #?'],
])('explicit %s resolves through GET only and preserves exact canonical %s', async (directory, canonical) => {
  const read = vi.fn(async () => ({ path: canonical, entries: [] }));
  expect(await resolveNewSessionWriterDirectory({ directory, read, current: () => true })).toBe(canonical);
  expect(read).toHaveBeenCalledExactlyOnceWith(`/api/fs/list?path=${encodeURIComponent(directory)}`);
});

test.each(['', ' ', ' /repo', '/repo ', 'relative', '~', '/repo\u0000', 'C:relative', '\\\\?\\unsafe'])('no implicit home/project or mutation fallback for invalid selection %j', async directory => {
  const read = vi.fn();
  await expect(resolveNewSessionWriterDirectory({ directory, read, current: () => true })).rejects.toThrow();
  expect(read).not.toHaveBeenCalled();
});

test.each([null, [], {}, { path: '/repo' }, { path: '', entries: [] }, { path: 'relative', entries: [] },
  { path: '/repo', entries: {} }, { path: '/repo', entries: [], partial: true }, { path: '/repo', entries: [], complete: false },
  { path: '/repo', entries: [], ok: false }, { path: '/repo', entries: [], success: false }, { path: '/repo', entries: [], failed: true },
])('malformed/partial authority %j never becomes a canonical grant target', async value => {
  const read = vi.fn(async () => value);
  await expect(resolveNewSessionWriterDirectory({ directory: '/repo', read, current: () => true })).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(1);
});

test('failed directory GET stays failed: no canonicalize POST, stat fallback or first project lookup', async () => {
  const read = vi.fn(async () => { throw new Error('synthetic directory unavailable'); });
  await expect(resolveNewSessionWriterDirectory({ directory: '/repo', read, current: () => true })).rejects.toThrow('synthetic directory unavailable');
  expect(read).toHaveBeenCalledExactlyOnceWith('/api/fs/list?path=%2Frepo');
});

test('stale before resolution performs zero I/O; late read never admits a new scope', async () => {
  let current = false; const late = deferred<unknown>(), read = vi.fn(() => late.promise);
  await expect(resolveNewSessionWriterDirectory({ directory: '/repo', read, current: () => current })).rejects.toThrow('stale');
  expect(read).not.toHaveBeenCalled(); current = true;
  const work = resolveNewSessionWriterDirectory({ directory: '/repo', read, current: () => current });
  current = false; late.resolve({ path: '/actual', entries: [] });
  await expect(work).rejects.toThrow('stale'); expect(read).toHaveBeenCalledTimes(1);
});

test.each(['/repo/.opencode/plans', 'C:\\repo\\.opencode\\plans'])('plans %s requires a real directory entry in canonical parent', async directory => {
  const canonical = directory.replace(/\\/g, '/'), parent = canonical.slice(0, canonical.lastIndexOf('/'));
  const read = vi.fn().mockResolvedValueOnce({ path: directory, entries: [] }).mockResolvedValueOnce({ path: parent, entries: [{ path: directory, isDirectory: true }] });
  expect(await resolveNewSessionWriterDirectory({ directory, read, current: () => true })).toBe(directory);
  expect(read.mock.calls).toEqual([[`/api/fs/list?path=${encodeURIComponent(directory)}`], [`/api/fs/list?path=${encodeURIComponent(parent)}`]]);
});

test.each([
  { path: '/repo/.opencode', entries: [] },
  { path: '/repo/.opencode', entries: [{ path: '/repo/.opencode/plans', isDirectory: false }] },
  { path: '/repo/.opencode', entries: [{ path: '/repo/.opencode/plans', isDirectory: true }, { path: '/repo/.opencode/plans', isDirectory: true }] },
  { path: '/different', entries: [{ path: '/repo/.opencode/plans', isDirectory: true }] },
  { path: '/repo/.opencode', entries: [null] },
  { path: '/repo/.opencode', entries: [{ path: '/repo/.opencode/plans' }] },
])('plans ENOENT fake-empty or ambiguous parent proof %j is not authorization', async proof => {
  const read = vi.fn().mockResolvedValueOnce({ path: '/repo/.opencode/plans', entries: [] }).mockResolvedValueOnce(proof);
  await expect(resolveNewSessionWriterDirectory({ directory: '/repo/.opencode/plans', read, current: () => true })).rejects.toThrow();
  expect(read).toHaveBeenCalledTimes(2);
});

test('retirement while plans parent proof awaits fences the whole resolution', async () => {
  let current = true; const late = deferred<unknown>();
  const read = vi.fn().mockResolvedValueOnce({ path: '/repo/.opencode/plans', entries: [] }).mockReturnValueOnce(late.promise);
  const work = resolveNewSessionWriterDirectory({ directory: '/repo/.opencode/plans', read, current: () => current });
  await Promise.resolve(); expect(read).toHaveBeenCalledTimes(2); current = false;
  late.resolve({ path: '/repo/.opencode', entries: [{ path: '/repo/.opencode/plans', isDirectory: true }] });
  await expect(work).rejects.toThrow('stale');
});
