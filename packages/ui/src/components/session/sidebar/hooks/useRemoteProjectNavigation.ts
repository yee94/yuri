import React from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getHostRuntimeRegistry, useRemoteHostCatalog } from '@/queries/remoteProjectQueries';

export { remoteHostSummariesQueryOptions as remoteSummaryOptions, useRemoteHostSummaries as useRemoteSummaries } from '@/queries/remoteProjectQueries';
export type { RemoteHostSummaries as RemoteSummarySnapshot } from '@/queries/remoteProjectQueries';

/** Project projection only; the shared Query/service owns catalog and summary IO. */
export function useRemoteProjectNavigation(enabled = true) {
  const hasRemoteProjects = useProjectsStore((state) => state.projects.some((project) => Boolean(project.hostId)));
  const catalog = useRemoteHostCatalog(enabled && hasRemoteProjects);
  const registry = catalog.data?.supported ? getHostRuntimeRegistry(catalog.data) : undefined;
  React.useEffect(() => {
    if (catalog.data?.supported) useProjectsStore.getState().reconcileRemoteProjects(catalog.data.projects, catalog.data.hubId);
  }, [catalog.data]);
  return { registry, catalog };
}
