import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEvent, useMountedState } from '@reactuses/core';
import { useRemoteHost } from '@/contexts/HostRuntimeProvider';
import type { HostRuntimeEntry, HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { RemoteProject } from '@/lib/remote-projects/types';
import { assertRemoteDirectoryScope, remoteDirectoryHomeOptions, remoteDirectoryListOptions } from '@/queries/remoteDirectoryQueries';
import { createRemoteProject, createRemoteWorkspace, readRemoteResponse, remoteProjectMetadata } from '@/queries/remoteProjectQueries';
import { normalizeDirectoryKey } from '@/lib/pathNormalization';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { resolveRemoteBrowse, trimDirectoryPath } from './remoteDirectoryBrowsePath';

interface Options {
  open: boolean;
  registry: HostRuntimeRegistry;
  hostId: string;
  onOpenChange(open: boolean): void;
  onRegistered?(project: RemoteProject): Promise<void>;
  /** Edits this remote workspace's member directories instead of adding a project. */
  editProject?: RemoteProject;
}

/** Owns directory IO and registration; views only render state and dispatch intent. */
export function useRemoteDirectoryExplorerModel({ open, registry, hostId, onOpenChange, onRegistered, editProject }: Options) {
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
      await onRegistered?.(project);
      assertSelected(owner);
      onOpenChange(false);
    },
  });
  const hostWritable = host?.available !== false && host?.state !== 'unauthorized' && host?.state !== 'incompatible';
  const submit = useEvent((create: boolean) => {
    if (!open || !directory || client.isMutating({ mutationKey, exact: true }) || !hostWritable) return;
    registration.mutate({ owner: entry, directory, create });
  });

  // Multi-project workspace: every staged directory is browsed on, and registered by, this one Host.
  const [workspaceMode, setWorkspaceMode] = useState(Boolean(editProject));
  const [stagedPaths, setStagedPaths] = useState<string[]>(() => editProject?.paths ?? []);
  const [workspaceName, setWorkspaceName] = useState('');
  const [workspaceNameError, setWorkspaceNameError] = useState(false);
  const workspaceRequest = useRef<{ payload: string; id: string } | null>(null);
  const toggleStagedPath = useEvent((candidate: string) => {
    const key = normalizeDirectoryKey(candidate);
    if (!key) return;
    setStagedPaths((previous) => previous.some((item) => normalizeDirectoryKey(item) === key)
      ? previous.filter((item) => normalizeDirectoryKey(item) !== key)
      : [...previous, candidate]);
  });
  const makePrimary = useEvent((path: string) => setStagedPaths((previous) => [path, ...previous.filter((item) => item !== path)]));
  const workspaceKey = [...entry.queryScope, 'project-picker', 'workspace'];
  const workspace = useMutation({
    mutationKey: workspaceKey,
    retry: false,
    mutationFn: async ({ owner, paths, label }: { owner: HostRuntimeEntry; paths: string[]; label: string }) => {
      assertSelected(owner);
      if (editProject) {
        const updated = await remoteProjectMetadata(registry, editProject, { paths });
        assertSelected(owner);
        useProjectsStore.getState().upsertRemoteProject(updated, registry.hubId);
        onOpenChange(false);
        return;
      }
      const payload = JSON.stringify([paths, label]);
      if (workspaceRequest.current?.payload !== payload) {
        const id = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        workspaceRequest.current = { payload, id };
      }
      const project = await createRemoteWorkspace(registry, hostId, paths, label, workspaceRequest.current.id);
      assertSelected(owner);
      useProjectsStore.getState().upsertRemoteProject(project, registry.hubId);
      useProjectsStore.getState().setActiveProjectIdOnly(project.id);
      useSessionNavigationStore.getState().openRemoteSession(project, { hubId: registry.hubId, hostId, directory: project.path }, null);
      await onRegistered?.(project);
      assertSelected(owner);
      onOpenChange(false);
    },
  });
  const saveWorkspace = useEvent(() => {
    if (!open || !stagedPaths.length || client.isMutating({ mutationKey: workspaceKey, exact: true }) || !hostWritable) return;
    const label = workspaceName.trim();
    if (!editProject && !label) { setWorkspaceNameError(true); return; }
    setWorkspaceNameError(false);
    workspace.mutate({ owner: entry, paths: stagedPaths, label });
  });
  const changeWorkspaceName = useEvent((value: string) => {
    setWorkspaceName(value);
    if (value.trim()) setWorkspaceNameError(false);
  });

  return { input, browse, setPath, home, listing, submit,
    pending: registration.isPending || workspace.isPending, error: registration.error ?? workspace.error,
    workspaceMode, setWorkspaceMode, stagedPaths, toggleStagedPath, makePrimary, saveWorkspace,
    workspaceName, changeWorkspaceName, workspaceNameError };
}
