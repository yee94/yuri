import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryClient } from '@/lib/queryRuntime';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeGeneration, getRuntimeKey, getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { getLocationOpencodeClient } from '@/lib/opencode/client';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { parseHostCatalog, parseRemoteProject, type HostCatalog, type RemoteProject } from '@/lib/remote-projects/types';
import { parseRemoteHostSummaries, remoteHostSummariesKey } from '@/lib/remote-projects/summaries';
import { getHostRuntimeServices } from '@/lib/remote-projects/runtime';
export type { RemoteHostSummaries } from '@/lib/remote-projects/summaries';

export const supportsRemoteProjects = (): boolean => !isVSCodeRuntime() && (isDesktopShell() || isCapacitorApp());

export class RemoteProjectRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly minimumVersion?: string) {
    super(message);
    this.name = 'RemoteProjectRequestError';
  }
}

export const readRemoteResponse = async (response: Response): Promise<unknown> => {
  const payload: unknown = await response.json();
  if (response.ok) return payload;
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  throw new RemoteProjectRequestError(response.status,
    typeof value.code === 'string' ? value.code : 'request_failed',
    typeof value.error === 'string' ? value.error : response.statusText,
    typeof value.minimumVersion === 'string' ? value.minimumVersion : undefined);
};

export const remoteHostCatalogQueryOptions = () => {
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  const runtime = getRuntimeKey();
  return {
    queryKey: [transport, 'remote-projects', 'catalog'] as const,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<HostCatalog> => {
      if (!supportsRemoteProjects()) throw new RemoteProjectRequestError(501, 'unsupported_client', 'Remote Projects are not supported by this client');
      const payload = await readRemoteResponse(await runtimeFetch('/api/hosts', { signal }));
      if (transport !== getRuntimeTransportIdentity() || generation !== getRuntimeGeneration() || runtime !== getRuntimeKey()) {
        throw new Error('Remote Host catalog belongs to an inactive Hub');
      }
      const catalog = parseHostCatalog(payload);
      if (catalog.supported) getHostRuntimeRegistry(catalog).applyCatalog(catalog);
      return catalog;
    },
  };
};

/** No mounted demand means zero discovery requests, polling or realtime work. */
export const useRemoteHostCatalog = (enabled: boolean, refreshOnEnable = false) => {
  const options = remoteHostCatalogQueryOptions();
  const transport = options.queryKey[0];
  const generation = getRuntimeGeneration();
  useEffect(() => {
    const key = [transport, 'remote-projects', 'catalog'] as const;
    if (enabled && refreshOnEnable && supportsRemoteProjects() && queryClient.getQueryData(key) !== undefined) {
      void queryClient.invalidateQueries({ queryKey: key, exact: true });
    }
  }, [enabled, transport, generation, refreshOnEnable]);
  return useQuery({ ...options, enabled: enabled && supportsRemoteProjects() }, queryClient);
};

export const ensureRemoteHostCatalog = (): Promise<HostCatalog> => queryClient.fetchQuery(remoteHostCatalogQueryOptions());

export const useRemoteProjectRuntime = (enabled: boolean, refreshOnEnable = false) => {
  const query = useRemoteHostCatalog(enabled, refreshOnEnable);
  const registry = query.data?.supported ? getHostRuntimeRegistry(query.data) : undefined;
  return { catalog: query.data, registry, error: query.error, isPending: query.isPending };
};

export const remoteHostSummariesQueryOptions = (registry: HostRuntimeRegistry | undefined, hostId: string | undefined) => {
  const transport = getRuntimeTransportIdentity();
  return {
    queryKey: remoteHostSummariesKey(transport, registry?.hubId ?? '', hostId ?? ''),
    enabled: !!registry && !!hostId,
    staleTime: Infinity,
    gcTime: Infinity,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (!registry || !hostId) throw new Error('Remote summary scope is unavailable');
      const payload = await readRemoteResponse(await registry.requestHost(hostId, 'summaries', { signal }));
      const summaries = parseRemoteHostSummaries(payload, registry.hubId, hostId);
      registry.assertCurrent();
      getHostRuntimeServices(registry).demand.topologyAvailable(hostId, summaries.worktrees);
      return summaries;
    },
  };
};

export const useRemoteHostSummaries = (registry: HostRuntimeRegistry | undefined, hostId: string | undefined, enabled = true) => {
  useEffect(() => {
    if (enabled && registry && hostId) return getHostRuntimeServices(registry).retain();
  }, [enabled, registry, hostId]);
  return useQuery({
    ...remoteHostSummariesQueryOptions(registry, hostId),
    enabled: enabled && !!registry && !!hostId,
  }, queryClient);
};

export const ensureRemoteHostSummaries = (registry: HostRuntimeRegistry, hostId: string) => queryClient.ensureQueryData(remoteHostSummariesQueryOptions(registry, hostId));
export const refreshRemoteHostSummaries = (registry: HostRuntimeRegistry, hostId: string) => queryClient.fetchQuery({ ...remoteHostSummariesQueryOptions(registry, hostId), staleTime: 0 });

let currentRegistry: { runtime: string; transport: string; generation: number; registry: HostRuntimeRegistry } | undefined;

export const getHostRuntimeRegistry = (catalog: HostCatalog): HostRuntimeRegistry => {
  const runtime = getRuntimeKey();
  const transport = getRuntimeTransportIdentity();
  const generation = getRuntimeGeneration();
  if (!currentRegistry || currentRegistry.runtime !== runtime || currentRegistry.transport !== transport
    || currentRegistry.generation !== generation || currentRegistry.registry.hubId !== catalog.hubId) {
    currentRegistry?.registry.dispose();
    currentRegistry = {
      runtime, transport, generation,
      registry: new HostRuntimeRegistry(catalog.hubId, {
        transportIdentity: transport,
        isCurrent: () => runtime === getRuntimeKey() && transport === getRuntimeTransportIdentity() && generation === getRuntimeGeneration(),
        fetch: runtimeFetch,
        sdk: (location, fence, scope) => getLocationOpencodeClient(location, fence, scope).getScopedSdkClient(location.directory),
        service: getLocationOpencodeClient,
      }),
    };
    currentRegistry.registry.applyCatalog(catalog);
  }
  return currentRegistry.registry;
};

const projectFromResponse = async (response: Response, hostId: string): Promise<RemoteProject> => {
  const payload = await readRemoteResponse(response);
  const value = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const project = parseRemoteProject(value.project);
  if (project.hostId !== hostId) throw new Error('Remote Project response belongs to another machine');
  return project;
};

export const createRemoteProject = async (registry: HostRuntimeRegistry, hostId: string, path: string, label?: string): Promise<RemoteProject> => {
  const project = await projectFromResponse(await registry.requestHost(hostId, 'projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, ...(label ? { label } : {}) }),
  }), hostId);
  registry.assertCurrent();
  const scopedProject = { ...project, hubId: registry.hubId };
  updateCachedProject(registry, scopedProject);
  return scopedProject;
};

const updateCachedProject = (registry: HostRuntimeRegistry, project: RemoteProject, remove = false): void => {
  registry.assertCurrent();
  const transport = registry.resolve({ hubId: registry.hubId, hostId: project.hostId, directory: project.path }).queryScope[0];
  queryClient.setQueryData<HostCatalog>([transport, 'remote-projects', 'catalog'], (previous) => {
    if (!previous || previous.hubId !== registry.hubId) return previous;
    const index = previous.projects.findIndex((entry) => entry.id === project.id && entry.hostId === project.hostId);
    if (remove && index < 0) return previous;
    const projects = [...previous.projects];
    if (remove) projects.splice(index, 1);
    else if (index < 0) projects.push(project);
    else projects[index] = project;
    return { ...previous, projects };
  });
};

const metadataWrites = new WeakMap<HostRuntimeRegistry, Map<string, Promise<RemoteProject>>>();

export const remoteProjectMetadata = async (
  registry: HostRuntimeRegistry,
  project: RemoteProject,
  metadata: Pick<Partial<RemoteProject>, 'label' | 'icon' | 'iconImage' | 'iconBackground' | 'color'>,
): Promise<RemoteProject> => {
  registry.assertCurrent();
  let writes = metadataWrites.get(registry);
  if (!writes) metadataWrites.set(registry, writes = new Map());
  const key = JSON.stringify([project.hostId, project.id]);
  const captured = { ...metadata };
  const previous = writes.get(key);
  const flight = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
    // Project reference routes belong to the Hub, unlike proxied /api/projects routes.
    const response = await registry.requestHost(project.hostId, `projects/${encodeURIComponent(project.id)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(captured),
    });
    const updated = await projectFromResponse(response, project.hostId);
    registry.assertCurrent();
    if (updated.id !== project.id) throw new Error('Remote Project metadata response identity mismatch');
    updateCachedProject(registry, updated);
    return updated;
  });
  writes.set(key, flight);
  const finish = () => { if (writes.get(key) === flight) writes.delete(key); };
  void flight.then(finish, finish);
  return flight;
};

export const removeRemoteProject = async (registry: HostRuntimeRegistry, project: RemoteProject): Promise<void> => {
  const response = await registry.requestHost(project.hostId, `projects/${encodeURIComponent(project.id)}`, { method: 'DELETE' });
  if (!response.ok) await readRemoteResponse(response);
  registry.assertCurrent();
  updateCachedProject(registry, project, true);
};
