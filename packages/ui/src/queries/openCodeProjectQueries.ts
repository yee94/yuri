import React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '@/lib/pathNormalization';
import { queryKeys } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';

const EMPTY_PROJECT_ROOTS: ReadonlyMap<string, string> = new Map();
const PROJECT_ROOTS_STALE_TIME = 5 * 60_000;

/**
 * OpenCode project ID → canonical checkout. `projectIds` only scopes the cache
 * key: a newly seen unresolved ID refetches the single `project.list()` call.
 */
export const openCodeProjectRootsQueryOptions = (
  projectIds: readonly string[],
  transport = getRuntimeTransportIdentity(),
) => ({
  queryKey: queryKeys.openCodeProjects.roots(projectIds, transport),
  queryFn: async ({ signal }: { signal: AbortSignal }): Promise<ReadonlyMap<string, string>> => {
    const projects = await opencodeClient.getApiClient().project.list({}, { signal });
    const roots = new Map<string, string>();
    for (const project of projects) {
      const canonical = normalizePath(project.canonical);
      if (project.id && canonical) roots.set(project.id, canonical);
    }
    return roots;
  },
  staleTime: PROJECT_ROOTS_STALE_TIME,
});

/** `projectIds` must be sorted so the query key stays stable. */
export const useOpenCodeProjectRootsQuery = (projectIds: readonly string[], enabled = true): ReadonlyMap<string, string> => {
  const transport = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeTransportIdentity, getRuntimeTransportIdentity);
  const query = useQuery({
    ...openCodeProjectRootsQueryOptions(projectIds, transport),
    enabled: enabled && projectIds.length > 0,
    placeholderData: keepPreviousData,
  });
  return query.data ?? EMPTY_PROJECT_ROOTS;
};
