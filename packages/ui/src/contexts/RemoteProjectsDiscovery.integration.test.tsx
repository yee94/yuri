import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import type { YuriEvent } from '@/lib/yuriEvents';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { mountProjectOrderSync } from '@/sync/project-order-sync';
import { RemoteProjectsBootstrap } from './RemoteProjectsBootstrap';
import { createRemoteProject, ensureRemoteHostCatalog, getHostRuntimeRegistry } from '@/queries/remoteProjectQueries';
import { settingsBootstrapQueryOptions } from '@/queries/settingsBootstrapQueries';

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), listeners: new Set<(event: YuriEvent) => void>() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: fixture.fetch }));
vi.mock('@/lib/desktop', async (original) => ({ ...await original<object>(), isDesktopShell: () => true, isVSCodeRuntime: () => false }));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: (listener: (event: YuriEvent) => void) => {
  fixture.listeners.add(listener); return () => fixture.listeners.delete(listener);
} }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: vi.fn(), waitForPendingSettingsUpdates: async () => {}, invalidateSettingsCache: vi.fn() }));
vi.mock('@/lib/opencode/client', () => ({ opencodeClient: { setDirectory: vi.fn() }, getLocationOpencodeClient: () => { throw new Error('Discovery must not read remote content'); } }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: { getState: () => ({}) } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ setDirectory: vi.fn() }) } }));

it('existing settings tip discovers first reference on another client and removes the last without new socket/poll or unconditional Host reads', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  switchRuntimeEndpoint({ apiBaseUrl: 'https://discovery.example', runtimeKey: 'hub-discovery' });
  queryClient.clear();
  useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [], hubProjectLayout: null });
  let hasRemoteProjects = false;
  const remote = { id: 'hub-ref', hostId: 'host', path: '/remote/raw cwd', remoteProjectId: 'upstream', remoteState: 'ok' };
  fixture.fetch.mockImplementation(async (path: string) => {
    if (path === '/api/config/settings') return Response.json({ projects: [], hasRemoteProjects,
      hubProjectLayout: { hubId: 'hub', order: ['hub-ref'], collapsed: { 'hub-ref': true } } });
    if (path === '/api/hosts') return Response.json({ supported: true, hubId: 'hub', hosts: [], projects: hasRemoteProjects ? [remote] : [] });
    throw new Error(`Unexpected request ${path}`);
  });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const release = mountProjectOrderSync();
  const tip = () => fixture.listeners.forEach((listener) => listener({ type: 'project-order-changed', occurredAt: Date.now() }));
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectsBootstrap /></QueryClientProvider>));
    await vi.waitFor(() => expect(queryClient.getQueryData([getRuntimeTransportIdentity(), 'settings', 'bootstrap'])).toMatchObject({ hasRemoteProjects: false }));
    expect(fixture.fetch.mock.calls.map(([path]) => path)).toEqual(['/api/config/settings']);
    hasRemoteProjects = true;
    await act(async () => tip());
    await vi.waitFor(() => expect(useProjectsStore.getState().projects, JSON.stringify({ calls: fixture.fetch.mock.calls.map(([path]) => path), queries: queryClient.getQueryCache().getAll().map((query) => ({ key: query.queryKey, data: query.state.data, error: query.state.error?.message, failure: query.state.fetchFailureReason?.message })) })).toEqual([expect.objectContaining({ id: 'hub-ref', sidebarCollapsed: true })]));
    expect(fixture.fetch.mock.calls.filter(([path]) => path === '/api/hosts')).toHaveLength(1);
    hasRemoteProjects = false;
    await act(async () => tip());
    await vi.waitFor(() => expect(useProjectsStore.getState().projects).toEqual([]));
    expect(fixture.fetch.mock.calls.filter(([path]) => path === '/api/hosts')).toHaveLength(2);
    await act(async () => tip());
    await vi.waitFor(() => expect(fixture.fetch.mock.calls.filter(([path]) => path === '/api/config/settings')).toHaveLength(4));
    expect(fixture.fetch.mock.calls.filter(([path]) => path === '/api/hosts')).toHaveLength(2);
  } finally {
    release(); await act(async () => root.unmount()); node.remove(); queryClient.clear();
    expect(fixture.listeners.size).toBe(0);
  }
});

it('an already mounted root shows a confirmed picker registration before restart and retains it through late local settings', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.fetch.mockReset();
  switchRuntimeEndpoint({ apiBaseUrl: 'https://registration.example', runtimeKey: 'hub-registration' });
  queryClient.clear();
  useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [], hubProjectLayout: null });
  const bootstrapKey = settingsBootstrapQueryOptions().queryKey;
  queryClient.setQueryData(bootstrapKey, { schemaVersion: 1, hasRemoteProjects: false });
  const remote = { id: 'registered-reference', hostId: 'host', path: '/remote/raw cwd', remoteProjectId: 'upstream', remoteState: 'ok' };
  let registered = false;
  fixture.fetch.mockImplementation(async (path: string, options?: { method?: string }) => {
    if (path === '/api/hosts') return Response.json({ supported: true, hubId: 'registration-hub',
      hosts: [{ id: 'host', name: 'Remote', source: 'direct', state: 'connected' }], projects: registered ? [remote] : [] });
    if (path === '/api/hosts/host/projects' && options?.method === 'POST') {
      registered = true; return Response.json({ project: remote });
    }
    throw new Error(`Unexpected request ${path}`);
  });
  // The explicit picker has discovered Hosts before registration; root bootstrap is still local-only.
  const catalog = await ensureRemoteHostCatalog();
  const registry = getHostRuntimeRegistry(catalog);
  function ProjectRows() {
    const projects = useProjectsStore((state) => state.projects);
    return <>{projects.map((project) => <div key={project.id} data-reference={project.id}>{project.path}</div>)}</>;
  }
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<QueryClientProvider client={queryClient}><RemoteProjectsBootstrap /><ProjectRows /></QueryClientProvider>));
    expect(fixture.fetch).toHaveBeenCalledTimes(1);
    await act(async () => {
      const project = await createRemoteProject(registry, 'host', remote.path);
      useProjectsStore.getState().upsertRemoteProject(project, registry.hubId);
    });
    await vi.waitFor(() => expect(node.querySelector('[data-reference="registered-reference"]')?.textContent).toBe(remote.path));
    await act(async () => {
      useProjectsStore.getState().synchronizeFromSettings({ projects: [] });
      queryClient.setQueryData(bootstrapKey, { schemaVersion: 1, hasRemoteProjects: true });
    });
    await vi.waitFor(() => expect(fixture.fetch.mock.calls.filter(([path]) => path === '/api/hosts')).toHaveLength(2));
    expect(useProjectsStore.getState().projects).toEqual([expect.objectContaining({ ...remote, hubId: registry.hubId })]);
    expect(node.querySelector('[data-reference="registered-reference"]')).not.toBeNull();
    expect(fixture.fetch.mock.calls.map(([path]) => path)).toEqual(['/api/hosts', '/api/hosts/host/projects', '/api/hosts']);
  } finally {
    await act(async () => root.unmount()); node.remove(); queryClient.clear();
  }
});
