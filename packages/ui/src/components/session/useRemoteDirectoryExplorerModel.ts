import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEvent, useMountedState } from '@reactuses/core';
import { useRemoteHost } from '@/contexts/HostRuntimeProvider';
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';
import { assertRemoteDirectoryScope, remoteDirectoryHomeOptions, remoteDirectoryListOptions } from '@/queries/remoteDirectoryQueries';
import { createRemoteProject, readRemoteResponse } from '@/queries/remoteProjectQueries';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { resolveRemoteBrowse, trimDirectoryPath } from './remoteDirectoryBrowsePath';

interface Options {
  open: boolean;
  registry: HostRuntimeRegistry;
  hostId: string;
  onOpenChange(open: boolean): void;
  onRegistered(project: RemoteProject): Promise<void>;
}

/** Owns directory IO and registration; views only render state and dispatch intent. */
export function useRemoteDirectoryExplorerModel({ open, registry, hostId, onOpenChange, onRegistered }: Options) {
  const host = useRemoteHost(registry, hostId);
  const entry = registry.resolve({ hubId: registry.hubId, hostId, directory: '/' });
  const [path, setPath] = useState('');
  const isMounted = useMountedState();
  const client = useQueryClient();
  const home = useQuery({ ...remoteDirectoryHomeOptions(registry, entry), enabled: open });
  const input = path || home.data || '';
  const browse = resolveRemoteBrowse(input, Boolean(path));
  const directory = trimDirectoryPath(input);
  const listing = useQuery({ ...remoteDirectoryListOptions(registry, entry, browse.directory), enabled: open && Boolean(browse.directory) });
  const assertSelected = useEvent((owner: HostRuntimeEntry) => {
    assertRemoteDirectoryScope(registry, owner);
    if (!isMounted() || !open || entry !== owner) throw new Error('Remote directory selection changed during request');
  });
  const mutationKey = [...entry.queryScope, 'project-picker', 'register'];
  const registration = useMutation({
    mutationKey,
    retry: false,
    mutationFn: async ({ owner, directory: target, create }: { owner: HostRuntimeEntry; directory: string; create: boolean }) => {
      assertSelected(owner);
      if (create) {
        await readRemoteResponse(await owner.fetch('/api/fs/mkdir', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: target }),
        }));
        assertSelected(owner);
      }
      const project = await createRemoteProject(registry, hostId, target);
      assertSelected(owner);
      useProjectsStore.getState().upsertRemoteProject(project, registry.hubId);
      useProjectsStore.getState().setActiveProjectIdOnly(project.id);
      useSessionNavigationStore.getState().openRemoteSession(project, { hubId: registry.hubId, hostId, directory: project.path }, null);
      await onRegistered(project);
      assertSelected(owner);
      onOpenChange(false);
    },
  });
  const submit = useEvent((create: boolean) => {
    if (!open || !directory || client.isMutating({ mutationKey, exact: true })
      || host?.available === false || host?.state === 'unauthorized' || host?.state === 'incompatible') return;
    registration.mutate({ owner: entry, directory, create });
  });
  return { input, browse, setPath, home, listing, submit, pending: registration.isPending, error: registration.error };
}
