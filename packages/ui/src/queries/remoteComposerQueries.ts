import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { remoteHostSummariesQueryOptions } from './remoteProjectQueries';
import type { RemoteHostSummaries } from '@/lib/remote-projects/summaries';
import type { QueryClient } from '@tanstack/react-query';
import type { ProjectFileSearchHit } from '@/lib/opencode/client';
import { toAbsoluteFilePath } from '@/lib/path-utils';
import { basename, normalize } from 'pathe';

/** The mounted picker and send compiler share this immutable Host catalog. */
const selectSessions = (summary: RemoteHostSummaries) => summary.directories.flatMap((directory) => directory.sessions);
export const remoteComposerSessionsQueryOptions = (registry: HostRuntimeRegistry, entry: HostRuntimeEntry) => {
  return {
    ...remoteHostSummariesQueryOptions(registry, entry.location.hostId),
    select: selectSessions,
  };
};

export const ensureRemoteComposerSessions = async (client: QueryClient, registry: HostRuntimeRegistry, entry: HostRuntimeEntry) => {
  entry.sdk();
  const summary = await client.fetchQuery(remoteComposerSessionsQueryOptions(registry, entry));
  entry.sdk();
  return selectSessions(summary);
};

export const readRemoteComposerSessionTitle = (client: QueryClient, registry: HostRuntimeRegistry, entry: HostRuntimeEntry, id: string) => {
  entry.sdk();
  const summary = client.getQueryData<RemoteHostSummaries>(remoteComposerSessionsQueryOptions(registry, entry).queryKey);
  for (const directory of summary?.directories ?? []) {
    const session = directory.sessions.find((session) => session.id === id);
    if (session) return session.title || id;
  }
  return id;
};

export const remoteComposerFilesQueryOptions = (entry: HostRuntimeEntry, query: string, limit: number,
  options: { includeHidden?: boolean; respectGitignore?: boolean; type?: 'file' | 'directory' } = {}) => ({
  queryKey: [...entry.queryScope, 'composer-files', query, limit, options],
  staleTime: 30_000,
  gcTime: 30_000,
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ProjectFileSearchHit[]> => {
    const response = await entry.sdk().file.find({ query, location: { directory: entry.location.directory }, limit, type: options.type }, { signal });
    entry.sdk();
    signal.throwIfAborted();
    if (!Array.isArray(response.data)) throw new Error('File search returned no data');
    return response.data.map((file) => {
      const relativePath = normalize(file.path);
      const name = basename(relativePath);
      return { name, path: toAbsoluteFilePath(entry.location.directory, relativePath), relativePath,
        extension: name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined, isDirectory: file.type === 'directory' };
    });
  },
});
