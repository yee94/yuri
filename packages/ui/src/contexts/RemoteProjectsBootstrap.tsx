import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { settingsBootstrapQueryOptions } from '@/queries/settingsBootstrapQueries';
import { supportsRemoteProjects, useRemoteProjectRuntime } from '@/queries/remoteProjectQueries';

/** Observe the already loaded bootstrap. Local-only users add no request or timer. */
export function RemoteProjectsBootstrap() {
  const hasCachedReferences = useProjectsStore((state) => state.projects.some((project) => !!project.hostId));
  const bootstrap = useQuery({ ...settingsBootstrapQueryOptions(), enabled: false, staleTime: Infinity, gcTime: Infinity });
  const enabled = supportsRemoteProjects() && (hasCachedReferences || bootstrap.data?.hasRemoteProjects === true);
  return enabled ? <RemoteCatalogBootstrap /> : null;
}

function RemoteCatalogBootstrap() {
  const { catalog } = useRemoteProjectRuntime(true, true);
  useEffect(() => {
    if (catalog?.supported) useProjectsStore.getState().reconcileRemoteProjects(catalog.projects, catalog.hubId);
  }, [catalog]);
  return null;
}
