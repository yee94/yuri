import { describe, expect, test, vi } from 'vitest';
import type { FilesAPI } from '@/lib/api/types';

import { buildCommandPaletteFileSearchKey, buildCommandPaletteFileSearchRoots, commandPaletteFileSearchQueryOptions, scoreCommandPaletteFiles } from './commandPaletteFilesState';

const createFiles = (search: FilesAPI['search']): FilesAPI => ({
  search,
  listDirectory: async (directory) => ({ directory, entries: [] }),
  createDirectory: async (path) => ({ success: true, path }),
});
const scope = { transport: 'runtime-a', generation: 1 };

describe('commandPaletteFilesState', () => {
  test('does not build a file search key without a root or query', () => {
    expect(buildCommandPaletteFileSearchKey([], 'alpha')).toBe('');
    expect(buildCommandPaletteFileSearchKey(['/project'], '')).toBe('');
  });

  test('ranks matching file candidates and does not return results for an empty query', () => {
    const fileResults = [{ name: 'alpha.ts', path: '/project/alpha.ts', relativePath: 'alpha.ts' }];
    expect(scoreCommandPaletteFiles(fileResults, '')).toEqual([]);
    expect(scoreCommandPaletteFiles(fileResults, 'alpha')).toHaveLength(1);
  });

  test('canonicalizes saved projects and worktrees without needing an active project', () => {
    expect(buildCommandPaletteFileSearchRoots([{ path: '/second/' }, { path: '/first' }], new Map([
      ['/first', [{ path: '/first/' }, { path: '/worktree' }]],
    ]))).toEqual(['/first', '/second', '/worktree']);
  });

  test('query identity covers every root, transport and generation', () => {
    const files = createFiles(async () => []);
    const first = commandPaletteFileSearchQueryOptions(files, ['/b', '/a'], 'alpha', scope).queryKey;
    expect(first).toEqual(commandPaletteFileSearchQueryOptions(files, ['/a', '/b'], 'alpha', scope).queryKey);
    expect(first).not.toEqual(commandPaletteFileSearchQueryOptions(files, ['/a'], 'alpha', scope).queryKey);
    expect(first).not.toEqual(commandPaletteFileSearchQueryOptions(files, ['/a', '/b'], 'alpha', { ...scope, transport: 'runtime-b' }).queryKey);
    expect(first).not.toEqual(commandPaletteFileSearchQueryOptions(files, ['/a', '/b'], 'alpha', { ...scope, generation: 2 }).queryKey);
  });

  test('searches all roots with four bounded workers and deduplicates overlapping paths', async () => {
    let active = 0;
    let maximum = 0;
    const search = vi.fn(async ({ directory }: { directory: string }) => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active -= 1;
      return [{ path: `${directory}/alpha.ts` }, { path: '/shared/alpha.ts' }];
    });
    const roots = Array.from({ length: 30 }, (_, i) => `/project-${i}`);
    const options = commandPaletteFileSearchQueryOptions(createFiles(search), roots, 'alpha', scope);
    const result = await options.queryFn({ signal: new AbortController().signal });
    expect(search).toHaveBeenCalledTimes(30);
    expect(maximum).toBe(4);
    expect(result.files).toHaveLength(31);
    expect(result.failedDirectories).toEqual([]);
    expect(search).toHaveBeenCalledWith({ directory: '/project-29', query: 'alpha', maxResults: 10 });
  });

  test('keeps successful projects visible after a partial failure; total failure is not empty success', async () => {
    const files = createFiles(async ({ directory }) => {
      if (directory === '/offline') throw new Error('offline');
      return [{ path: `${directory}/alpha.ts` }];
    });
    const partial = await commandPaletteFileSearchQueryOptions(files, ['/offline', '/online'], 'alpha', scope)
      .queryFn({ signal: new AbortController().signal });
    expect(partial.files).toEqual([{ path: '/online/alpha.ts', name: 'alpha.ts', directory: '/online' }]);
    expect(partial.failedDirectories).toEqual(['/offline']);
    await expect(commandPaletteFileSearchQueryOptions(files, ['/offline'], 'alpha', scope)
      .queryFn({ signal: new AbortController().signal })).rejects.toThrow('offline');
  });

  test('cancellation rejects late results and never starts queued roots', async () => {
    const controller = new AbortController();
    const release: Array<() => void> = [];
    const search = vi.fn(({ directory }: { directory: string }) => new Promise<{ path: string }[]>(resolve => {
      release.push(() => resolve([{ path: `${directory}/alpha.ts` }]));
    }));
    const task = commandPaletteFileSearchQueryOptions(createFiles(search), Array.from({ length: 10 }, (_, i) => `/project-${i}`), 'alpha', scope)
      .queryFn({ signal: controller.signal });
    const rejected = expect(task).rejects.toThrow();
    controller.abort();
    release.forEach(resolve => resolve());
    await rejected;
    expect(search).toHaveBeenCalledTimes(4);
  });
});
