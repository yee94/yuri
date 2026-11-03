import { describe, expect, test, vi } from 'vitest';
import type { FilesAPI } from '@/lib/api/types';

import { buildCommandPaletteFileSearchKey, commandPaletteFileSearchQueryOptions, scoreCommandPaletteFiles } from './commandPaletteFilesState';

const createFiles = (search: FilesAPI['search']): FilesAPI => ({
  search,
  listDirectory: async (directory) => ({ directory, entries: [] }),
  createDirectory: async (path) => ({ success: true, path }),
});
const scope = { transport: 'runtime-a', generation: 1 };

describe('commandPaletteFilesState', () => {
  test('does not build a file search key without a root or query', () => {
    expect(buildCommandPaletteFileSearchKey(null, 'alpha')).toBe('');
    expect(buildCommandPaletteFileSearchKey('/project', '')).toBe('');
  });

  test('ranks matching file candidates and does not return results for an empty query', () => {
    const fileResults = [{ name: 'alpha.ts', path: '/project/alpha.ts', relativePath: 'alpha.ts' }];
    expect(scoreCommandPaletteFiles(fileResults, '')).toEqual([]);
    expect(scoreCommandPaletteFiles(fileResults, 'alpha')).toHaveLength(1);
  });

  test('missing scope or query performs no file request even through the query function', async () => {
    const search = vi.fn<FilesAPI['search']>(async () => []);
    await commandPaletteFileSearchQueryOptions(createFiles(search), null, 'alpha', scope)
      .queryFn({ signal: new AbortController().signal });
    await commandPaletteFileSearchQueryOptions(createFiles(search), '/project', '', scope)
      .queryFn({ signal: new AbortController().signal });
    expect(search).not.toHaveBeenCalled();
  });

  test('query identity covers the focused directory, query, transport and generation', () => {
    const files = createFiles(async () => []);
    const first = commandPaletteFileSearchQueryOptions(files, '/a', 'alpha', scope).queryKey;
    expect(first).toEqual(commandPaletteFileSearchQueryOptions(files, '/a/', 'alpha', scope).queryKey);
    expect(first).not.toEqual(commandPaletteFileSearchQueryOptions(files, '/b', 'alpha', scope).queryKey);
    expect(first).not.toEqual(commandPaletteFileSearchQueryOptions(files, '/a', 'beta', scope).queryKey);
    expect(first).not.toEqual(commandPaletteFileSearchQueryOptions(files, '/a', 'alpha', { ...scope, transport: 'runtime-b' }).queryKey);
    expect(first).not.toEqual(commandPaletteFileSearchQueryOptions(files, '/a', 'alpha', { ...scope, generation: 2 }).queryKey);
  });

  test('makes one scoped request, deduplicates paths and caps candidates at ten', async () => {
    const search = vi.fn(async ({ directory }: { directory: string }) => {
      return [{ path: `${directory}/alpha.ts` }, { path: `${directory}/alpha.ts` },
        ...Array.from({ length: 12 }, (_, index) => ({ path: `${directory}/alpha-${index}.ts` }))];
    });
    const options = commandPaletteFileSearchQueryOptions(createFiles(search), '/project/', 'alpha', scope);
    const result = await options.queryFn({ signal: new AbortController().signal });
    expect(search).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(9);
    expect(result.every(file => file.directory === '/project')).toBe(true);
    expect(search).toHaveBeenCalledWith({ directory: '/project', query: 'alpha', maxResults: 10 }, { signal: expect.any(AbortSignal) });
  });

  test('a scoped failure is not empty success and never falls back to another project', async () => {
    const search = vi.fn(async () => { throw new Error('offline'); });
    await expect(commandPaletteFileSearchQueryOptions(createFiles(search), '/offline', 'alpha', scope)
      .queryFn({ signal: new AbortController().signal })).rejects.toThrow('offline');
    expect(search).toHaveBeenCalledTimes(1);
  });

  test('cancellation rejects late scoped results', async () => {
    const controller = new AbortController();
    const release: Array<() => void> = [];
    const search = vi.fn(({ directory }: { directory: string }, _options?: { signal?: AbortSignal }) => new Promise<{ path: string }[]>(resolve => {
      release.push(() => resolve([{ path: `${directory}/alpha.ts` }]));
    }));
    const task = commandPaletteFileSearchQueryOptions(createFiles(search), '/project', 'alpha', scope)
      .queryFn({ signal: controller.signal });
    const rejected = expect(task).rejects.toThrow();
    controller.abort();
    release.forEach(resolve => resolve());
    await rejected;
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls.every(([, options]) => options?.signal === controller.signal)).toBe(true);
  });
});
