import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import type { FilesAPI } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';

export const buildCommandPaletteFileSearchRoots = (
  projects: readonly { path: string }[],
  worktrees: ReadonlyMap<string, readonly { path: string }[]>,
): string[] => [...new Set([
  ...projects.map((project) => normalizePath(project.path)),
  ...[...worktrees.values()].flatMap((entries) => entries.map((entry) => normalizePath(entry.path))),
].filter((path): path is string => Boolean(path)))].sort();

export const buildCommandPaletteFileSearchKey = (
  roots: readonly string[],
  trimmedQuery: string,
): string => {
  if (!roots.length || trimmedQuery.length === 0) {
    return '';
  }

  return JSON.stringify([[...roots].sort(), trimmedQuery]);
};

export const commandPaletteFileSearchQueryOptions = (
  files: FilesAPI,
  roots: readonly string[],
  query: string,
  scope: { transport: string; generation: number },
) => ({
  queryKey: [scope.transport, 'global-file-search', scope.generation, buildCommandPaletteFileSearchKey(roots, query)] as const,
  staleTime: 30_000,
  gcTime: 60_000,
  retry: false,
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const found = new Map<string, { path: string; name: string; directory: string }>();
    const failedDirectories: string[] = [];
    let next = 0;
    const search = async () => {
      while (next < roots.length) {
        signal.throwIfAborted();
        const directory = roots[next++];
        try {
          const matches = await files.search({ directory, query, maxResults: 10 });
          signal.throwIfAborted();
          for (const match of matches.slice(0, 10)) {
            const path = normalizePath(match.path);
            if (!path) continue;
            const name = path.split('/').pop() || path;
            if (!found.has(path)) found.set(path, { path, name, directory });
          }
        } catch (error) {
          signal.throwIfAborted();
          failedDirectories.push(directory);
          if (roots.length === 1) throw error;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, roots.length) }, search));
    signal.throwIfAborted();
    if (roots.length > 0 && failedDirectories.length === roots.length) throw new Error('File search failed in every project');
    return { files: [...found.values()].sort((left, right) => left.path.localeCompare(right.path)), failedDirectories };
  },
});

export const scoreCommandPaletteFiles = <T extends { name: string }>(
  fileResults: T[],
  trimmedQuery: string,
): { item: T; score: number }[] => {
  if (!trimmedQuery || fileResults.length === 0) {
    return [];
  }

  return scoreByFuzzyQuery(fileResults, trimmedQuery, (file) => file.name, {
    limit: 10,
    threshold: 0.4,
  });
};
