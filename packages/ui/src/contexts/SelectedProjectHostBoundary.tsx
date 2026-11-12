import React, { useMemo } from 'react';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { ProjectEntry } from '@/lib/api/types';
import { useRemoteProjectRuntime, getHostRuntimeRegistry, supportsRemoteProjects } from '@/queries/remoteProjectQueries';
import { useI18n } from '@/lib/i18n';
import { HostRuntimeProvider } from './HostRuntimeProvider';
import { locationKey } from '@/lib/remote-projects/location';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';

function RemoteProjectBoundary({ project, children }: { project: ProjectEntry; children: React.ReactNode }) {
  const { t } = useI18n();
  const { catalog, registry: discoveredRegistry, error } = useRemoteProjectRuntime(true);
  const fallbackCatalog = useMemo(() => project.hubId ? {
    supported: true, hubId: project.hubId, projects: [],
    hosts: [{ id: project.hostId!, name: project.hostId!, source: 'direct' as const, state: 'offline' as const }],
  } : undefined, [project.hubId, project.hostId]);
  const registry = discoveredRegistry ?? (fallbackCatalog ? getHostRuntimeRegistry(fallbackCatalog) : undefined);
  const selectedLocation = useSessionNavigationStore((state) => {
    const selected = state.remoteSession;
    return selected?.projectId === project.id && selected.location.hubId === project.hubId && selected.location.hostId === project.hostId
      ? selected.location : undefined;
  });
  const directory = selectedLocation?.directory ?? project.path;
  const location = useMemo(() => registry ? { hubId: registry.hubId, hostId: project.hostId, directory } : undefined,
    [registry, project.hostId, directory]);
  if (!supportsRemoteProjects() || catalog?.supported === false) {
    return <div role="status">{t('remoteProjects.unsupported')}</div>;
  }
  if (project.hubId && catalog && project.hubId !== catalog.hubId) {
    return <div role="alert">{t('remoteProjects.host-unavailable')}</div>;
  }
  if (!registry || !location) {
    return <div role={error ? 'alert' : 'status'}>{error ? error.message : t('remoteProjects.state.connecting')}</div>;
  }
  return <HostRuntimeProvider key={locationKey(location)} registry={registry} location={location}>{children}</HostRuntimeProvider>;
}

/** Only project surfaces inherit this scope. Machine settings and the sidebar do not. */
export function SelectedProjectHostBoundary({ children }: { children: React.ReactNode }) {
  const project = useProjectsStore((state) => state.projects.find((project) => project.id === state.activeProjectId));
  if (!project?.hostId) return children;
  return <RemoteProjectBoundary project={project}>{children}</RemoteProjectBoundary>;
}
