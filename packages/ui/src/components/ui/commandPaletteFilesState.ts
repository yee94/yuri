import { scoreByFuzzyQuery } from '@/lib/search/fuzzySearch';
import type { FilesAPI } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';

export const buildCommandPaletteFileSearchKey = (
  directory: string | null,
  trimmedQuery: string,
): string => {
  const normalizedDirectory = normalizePath(directory);
  if (!normalizedDirectory || trimmedQuery.length === 0) {
    return '';
  }

  return JSON.stringify([normalizedDirectory, trimmedQuery]);
};

export const commandPaletteFileSearchQueryOptions = (
  files: FilesAPI,
  directory: string | null,
  query: string,
  scope: { transport: string; generation: number },
) => ({
  queryKey: [scope.transport, 'session-file-search', scope.generation, buildCommandPaletteFileSearchKey(directory, query)] as const,
  staleTime: 30_000,
  gcTime: 60_000,
  retry: false,
  queryFn: async ({ signal }: { signal: AbortSignal }) => {
    const root = normalizePath(directory);
    if (!root || !query.trim()) return [];
    signal.throwIfAborted();
    const matches = await files.search({ directory: root, query, maxResults: 10 }, { signal });
    signal.throwIfAborted();
    const found = new Map<string, { path: string; name: string; directory: string }>();
    for (const match of matches.slice(0, 10)) {
      const path = normalizePath(match.path);
      if (!path) continue;
      const name = path.split('/').pop() || path;
      if (!found.has(path)) found.set(path, { path, name, directory: root });
    }
    return [...found.values()].sort((left, right) => left.path.localeCompare(right.path));
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
