import { useSyncExternalStore } from 'react';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { getRuntimeGeneration, getRuntimeTransportIdentity, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { deletePermissionSaved, listPermissionSaved, parsePermissionSavedList, resolvePermissionSavedProject, type PermissionSavedInfo } from '@/sync/permission-saved-api';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { useHostRuntime } from '@/contexts/HostRuntimeProvider';

// Saved permissions are pull state. Both stages retain their captured runtime
// and directory; only the authoritative project ID enables the rule list.
type RuntimeScope = { transport: string; generation: number; directory: string; entry?: HostRuntimeEntry };
export type SavedPermissionScope = RuntimeScope & { projectID: string };

function assertCurrent(scope: RuntimeScope) {
  scope.entry?.sdk();
  if (scope.transport !== getRuntimeTransportIdentity() || scope.generation !== getRuntimeGeneration()) {
    throw new Error('Saved permission runtime changed');
  }
}

export const savedPermissionProjectQueryOptions = (scope: RuntimeScope) => queryOptions({
  queryKey: [scope.transport, scope.generation, 'saved-permission-project', scope.directory, ...(scope.entry ? scope.entry.queryScope : [])] as const,
  queryFn: async ({ signal }) => {
    assertCurrent(scope);
    const id = scope.entry
      ? (await scope.entry.sdk().location.get({ location: { directory: scope.directory } }, { signal })).project?.id
      : await resolvePermissionSavedProject(scope.directory, signal);
    assertCurrent(scope);
    if (!id) throw new Error('Saved permission project ID required');
    return id;
  },
  retry: false,
});

export const savedPermissionListQueryOptions = (scope: SavedPermissionScope) => queryOptions({
  queryKey: [scope.transport, scope.generation, 'saved-permissions', scope.directory, scope.projectID, ...(scope.entry ? scope.entry.queryScope : [])] as const,
  queryFn: async ({ signal }) => {
    assertCurrent(scope);
    if (!scope.directory || !scope.projectID) throw new Error('Saved permission scope required');
    const items = scope.entry
      ? parsePermissionSavedList(await scope.entry.sdk().permission.saved.list({ projectID: scope.projectID }, { signal }))
      : await listPermissionSaved({ projectID: scope.projectID, signal });
    assertCurrent(scope);
    if (items.some((item) => item.projectID !== scope.projectID)) throw new Error('Saved permission project mismatch');
    return items;
  },
  retry: false,
});

export function useSavedPermissionsQuery(directory: string) {
  const host = useHostRuntime();
  const generation = useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeGeneration, getRuntimeGeneration);
  const runtime = { transport: getRuntimeTransportIdentity(), generation, directory: host?.entry.location.directory ?? directory.trim(), entry: host?.entry };
  const project = useQuery({ ...savedPermissionProjectQueryOptions(runtime), enabled: Boolean(runtime.directory) });
  const scope = { ...runtime, projectID: project.data ?? '' };
  const list = useQuery({
    ...savedPermissionListQueryOptions(scope),
    enabled: Boolean(runtime.directory && project.data) && !project.isError,
  });
  return { project, list, scope };
}

export async function deleteSavedPermissionQuery(client: QueryClient, scope: SavedPermissionScope, id: string) {
  assertCurrent(scope);
  const queryKey = savedPermissionListQueryOptions(scope).queryKey;
  const items = client.getQueryData(queryKey);
  if (!items?.some((item) => item.id === id && item.projectID === scope.projectID)) {
    throw new Error('Saved permission is outside the captured scope');
  }
  // Dispatch before yielding so runtimeFetch binds the active endpoint now.
  if (scope.entry) await scope.entry.sdk().permission.saved.remove({ id });
  else await deletePermissionSaved({ id });
  if (scope.entry) assertCurrent(scope);
  if (scope.transport !== getRuntimeTransportIdentity() || scope.generation !== getRuntimeGeneration()) return;
  await client.cancelQueries({ queryKey, exact: true });
  if (scope.entry) assertCurrent(scope);
  if (scope.transport !== getRuntimeTransportIdentity() || scope.generation !== getRuntimeGeneration()) return;
  client.setQueryData<PermissionSavedInfo[]>(queryKey, (current) => current?.filter((item) => item.id !== id));
}
