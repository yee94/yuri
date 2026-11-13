import { beforeEach, expect, test, vi } from 'vitest';
import { useProjectsStore } from './useProjectsStore';
import { useSessionNavigationStore } from './useSessionNavigationStore';
import { useDirectoryStore } from './useDirectoryStore';
import { opencodeClient } from '@/lib/opencode/client';
import type { RemoteProject } from '@/lib/remote-projects/types';

const calls = vi.hoisted(() => ({ metadata: vi.fn(), remove: vi.fn(), settings: vi.fn(async (_settings: unknown) => {}), registry: {} }));
vi.mock('@/queries/remoteProjectQueries', () => ({
  supportsRemoteProjects: () => false,
  ensureRemoteHostCatalog: async () => ({ hubId: 'hub' }), getHostRuntimeRegistry: () => calls.registry,
  remoteProjectMetadata: (...args: unknown[]) => calls.metadata(...args), removeRemoteProject: (...args: unknown[]) => calls.remove(...args),
}));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: calls.settings, waitForPendingSettingsUpdates: async () => {} }));

const remote = (hostId: string, path = '/same'): RemoteProject => ({ id: `remote-${hostId}`, hostId, path, remoteProjectId: 'remote-id', remoteState: 'ok', label: hostId });
beforeEach(() => {
  vi.restoreAllMocks(); calls.metadata.mockReset(); calls.remove.mockReset(); calls.settings.mockClear();
  useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [] });
  useSessionNavigationStore.getState().clearRemoteSession();
});

test('Hub-confirmed references retain host, Hub and raw Windows path through persistence and restore', () => {
  const store = useProjectsStore.getState();
  store.upsertRemoteProject(remote('a', 'C:\\Raw Path\\'), 'hub');
  store.upsertRemoteProject(remote('b', 'C:\\Raw Path\\'), 'hub');
  store.setProjectCollapsed('remote-a', true);
  useProjectsStore.setState({ projects: [], activeProjectId: null });
  store.resetForRuntimeSwitch();
  expect(useProjectsStore.getState().projects).toEqual([
    expect.objectContaining({ id: 'remote-a', hubId: 'hub', hostId: 'a', remoteProjectId: 'remote-id', path: 'C:\\Raw Path\\', sidebarCollapsed: true }),
    expect.objectContaining({ id: 'remote-b', hubId: 'hub', hostId: 'b', path: 'C:\\Raw Path\\' }),
  ]);
});

test('same raw project path on local and two Hosts never deduplicates to another machine', () => {
  const store = useProjectsStore.getState();
  store.upsertRemoteProject(remote('a'), 'hub'); store.upsertRemoteProject(remote('b'), 'hub');
  const local = store.addProject('/same');
  expect(local?.hostId).toBeUndefined();
  expect(useProjectsStore.getState().projects).toHaveLength(3);
});

test('remote selection never sets the Hub SDK directory and opens a scoped draft', () => {
  const sdk = vi.spyOn(opencodeClient, 'setDirectory');
  const directory = vi.spyOn(useDirectoryStore.getState(), 'setDirectory');
  useProjectsStore.getState().upsertRemoteProject(remote('a'), 'hub');
  useProjectsStore.getState().setActiveProject('remote-a');
  expect(useSessionNavigationStore.getState().remoteSession).toEqual({ projectId: 'remote-a', sessionId: null, location: { hubId: 'hub', hostId: 'a', directory: '/same' } });
  expect(sdk).not.toHaveBeenCalled(); expect(directory).not.toHaveBeenCalled();
});

test('metadata writes wait for remote confirmation; failure leaves prior objects/layout intact', async () => {
  useProjectsStore.getState().upsertRemoteProject(remote('a'), 'hub');
  const before = useProjectsStore.getState().projects;
  calls.metadata.mockRejectedValueOnce(new Error('offline'));
  await expect(useProjectsStore.getState().updateProjectMeta('remote-a', { label: 'renamed', color: 'blue' })).rejects.toThrow('offline');
  expect(useProjectsStore.getState().projects).toBe(before);
  calls.metadata.mockResolvedValueOnce({ ...remote('a'), label: 'confirmed', color: 'blue' });
  await useProjectsStore.getState().updateProjectMeta('remote-a', { label: 'confirmed', color: 'blue' });
  expect(calls.metadata).toHaveBeenLastCalledWith(calls.registry, remote('a'), { label: 'confirmed', color: 'blue' });
  expect(useProjectsStore.getState().projects[0].label).toBe('confirmed');
});

test('remote remove only deletes Hub reference after confirmation and never drops it on failure', async () => {
  useProjectsStore.getState().upsertRemoteProject(remote('a'), 'hub');
  calls.remove.mockRejectedValueOnce(new Error('Hub unavailable'));
  await expect(useProjectsStore.getState().removeProject('remote-a')).rejects.toThrow('Hub unavailable');
  expect(useProjectsStore.getState().projects).toHaveLength(1);
  calls.remove.mockResolvedValueOnce(undefined);
  await useProjectsStore.getState().removeProject('remote-a');
  expect(calls.remove).toHaveBeenLastCalledWith(calls.registry, remote('a'));
  expect(useProjectsStore.getState().projects).toHaveLength(0);
});

test('local settings refresh cannot erase references in the separate Hub catalog', () => {
  useProjectsStore.getState().upsertRemoteProject(remote('a'), 'hub');
  useProjectsStore.getState().synchronizeFromSettings({ projects: [] });
  expect(useProjectsStore.getState().projects).toHaveLength(1);
  expect(useProjectsStore.getState().projects[0].hostId).toBe('a');
});

test('catalog preserves removed/unavailable projects and local layout, and no-op snapshots preserve references', () => {
  useProjectsStore.getState().upsertRemoteProject(remote('a'), 'hub');
  useProjectsStore.getState().setProjectCollapsed('remote-a', true);
  useProjectsStore.getState().reconcileRemoteProjects([{ ...remote('a'), remoteState: 'host-unavailable' }], 'hub');
  expect(useProjectsStore.getState().projects[0]).toMatchObject({ remoteState: 'host-unavailable', sidebarCollapsed: true });
  const before = useProjectsStore.getState().projects;
  useProjectsStore.getState().reconcileRemoteProjects([{ ...remote('a'), remoteState: 'host-unavailable' }], 'hub');
  expect(useProjectsStore.getState().projects).toBe(before);
});

test('remote layout/order/selection never writes remote paths into local settings projects', () => {
  const store = useProjectsStore.getState();
  store.upsertRemoteProject(remote('a'), 'hub'); store.upsertRemoteProject(remote('b'), 'hub');
  store.setActiveProject('remote-a'); store.reorderProjectsById('remote-b', 'remote-a'); store.setProjectCollapsed('remote-b', true);
  for (const [payload] of calls.settings.mock.calls) {
    expect(payload).toMatchObject({ projects: [] });
    expect(payload).not.toHaveProperty('activeProjectId');
  }
});

test('a metadata change for one Host preserves other Hosts project object references', () => {
  const store = useProjectsStore.getState();
  store.upsertRemoteProject(remote('a'), 'hub'); store.upsertRemoteProject(remote('b'), 'hub');
  const beforeB = useProjectsStore.getState().projects[1];
  store.reconcileRemoteProjects([{ ...remote('a'), label: 'changed' }, remote('b')], 'hub');
  expect(useProjectsStore.getState().projects[1]).toBe(beforeB);
});
