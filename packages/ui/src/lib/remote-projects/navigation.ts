import type { RouteState } from '@/lib/router';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { ensureRemoteHostCatalog, ensureRemoteHostSummaries, getHostRuntimeRegistry } from '@/queries/remoteProjectQueries';
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { resolveRemoteProjectOwner } from './summaries';
import type { HostLocation } from './location';

/** Resolve a remote URL only against the current Hub catalog, never a local ID lookup. */
export async function applyRemoteProjectRoute(route: Pick<RouteState, 'sessionId' | 'isNewSession' | 'hostId' | 'hubId' | 'directory' | 'projectId'>, isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!route.hostId || !route.hubId || !route.directory) throw new Error('Incomplete remote session route');
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const runtime = getRuntimeKey();
  const catalog = await ensureRemoteHostCatalog();
  if (!isCurrent()) return false;
  if (!catalog.supported || catalog.hubId !== route.hubId || transport !== getRuntimeTransportIdentity()
    || generation !== getRuntimeGeneration() || runtime !== getRuntimeKey()) {
    throw new Error('Remote route belongs to a different or unsupported Hub');
  }
  const project = route.projectId
    ? catalog.projects.find((project) => project.hostId === route.hostId && project.id === route.projectId)
    : resolveRemoteProjectOwner(catalog.projects, catalog.hubId, route.hostId, route.directory,
      (await ensureRemoteHostSummaries(getHostRuntimeRegistry(catalog), route.hostId)).worktrees);
  if (!isCurrent()) return false;
  if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration() || runtime !== getRuntimeKey()) {
    throw new Error('Remote route belongs to an inactive Hub');
  }
  if (!project) throw new Error('Remote Project is not referenced by this Hub');
  const store = useProjectsStore.getState();
  store.upsertRemoteProject(project, catalog.hubId);
  store.setActiveProjectIdOnly(project.id);
  useSessionNavigationStore.getState().openRemoteSession(project, { hubId: catalog.hubId, hostId: project.hostId, directory: route.directory }, route.isNewSession ? null : route.sessionId);
  return true;
}

/** Native/menu initial text stays in the remote client's draft owner, not the Hub draft. */
export async function seedRemoteProjectDraft(location: HostLocation, text: string): Promise<void> {
  const transportIdentity = getRuntimeTransportIdentity();
  const { seedRemoteDraft } = await import('@/sync/remote-input-store');
  if (transportIdentity !== getRuntimeTransportIdentity()) return;
  await seedRemoteDraft(location, text);
}
