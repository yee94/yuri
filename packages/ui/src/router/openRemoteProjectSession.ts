import type { RemoteProject } from '@/lib/remote-projects/types';
import type { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore, type RemoteSessionDraftOptions } from '@/stores/useSessionNavigationStore';
import { useUIStore } from '@/stores/useUIStore';
import { useMobileNavigationStore } from '@/mobile/useMobileNavigationStore';
import { ensureRemoteHostCatalog, getHostRuntimeRegistry } from '@/queries/remoteProjectQueries';

/** Never passes a remote directory or raw session ID into the Hub's local session store. */
export function openRemoteProjectSession(project: RemoteProject, registry: HostRuntimeRegistry, sessionId: string | null, directory = project.path, mobile = false, draft?: RemoteSessionDraftOptions) {
  registry.assertCurrent();
  useProjectsStore.getState().setActiveProjectIdOnly(project.id);
  useSessionNavigationStore.getState().openRemoteSession(project, { hubId: registry.hubId, hostId: project.hostId, directory,
    ...(project.instanceId ? { instanceId: project.instanceId } : {}) }, sessionId, draft);
  useUIStore.getState().setActiveMainTab('chat');
  if (mobile) useMobileNavigationStore.getState().openRemoteProject();
}

export async function openRemoteProjectDraft(project: RemoteProject, mobile = false) {
  const catalog = await ensureRemoteHostCatalog();
  const confirmed = catalog.projects.find((entry) => entry.id === project.id && entry.hostId === project.hostId && entry.path === project.path);
  if (!confirmed) throw new Error('Remote project is not registered in the current Hub');
  const registry = getHostRuntimeRegistry(catalog);
  registry.assertCurrent();
  useProjectsStore.getState().upsertRemoteProject(confirmed, catalog.hubId);
  openRemoteProjectSession(confirmed, registry, null, confirmed.path, mobile);
}
