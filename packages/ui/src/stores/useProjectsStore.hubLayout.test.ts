import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { useProjectsStore } from './useProjectsStore';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { refreshProjectOrderSnapshot, waitForPendingHubProjectLayoutUpdates } from '@/queries/projectOrderQueries';
import { createProjectIdFromPath } from '@/lib/projectId';

const fixture = vi.hoisted(() => ({ fetch: vi.fn(), settings: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: fixture.fetch }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: fixture.settings, waitForPendingSettingsUpdates: async () => {} }));
vi.mock('@/queries/remoteProjectQueries', async (original) => ({ ...await original<object>(), supportsRemoteProjects: () => true }));
vi.mock('sonner', () => ({ toast: { error: fixture.error } }));

const local = { id: createProjectIdFromPath('/local'), path: '/local' };
const remote = { id: 'hub-ref', remoteProjectId: 'upstream-id', path: '/remote/raw cwd', hostId: 'host', remoteState: 'ok' as const };
const snapshot = (order = [local.id, remote.id], collapsed: Record<string, boolean> = {}) => ({ projects: [local],
  hasRemoteProjects: true, hubProjectLayout: { hubId: 'hub', order, collapsed } });

beforeEach(() => {
  switchRuntimeEndpoint({ apiBaseUrl: 'https://hub.example', runtimeKey: 'hub-layout' });
  queryClient.clear(); fixture.fetch.mockReset(); fixture.settings.mockClear(); fixture.error.mockClear();
  useProjectsStore.setState({ projects: [], activeProjectId: null, manualProjectOrder: [], hubProjectLayout: null });
});
afterEach(async () => { await waitForPendingHubProjectLayoutUpdates(getRuntimeTransportIdentity()); queryClient.clear(); });

test('cold settings layout survives catalog arriving later and restores mixed order and explicit expansion', async () => {
  fixture.fetch.mockResolvedValue(Response.json(snapshot([remote.id, local.id], { [remote.id]: true, [local.id]: false })));
  useProjectsStore.getState().synchronizeFromSettings(await refreshProjectOrderSnapshot());
  useProjectsStore.getState().reconcileRemoteProjects([remote], 'hub');
  expect(useProjectsStore.getState().projects).toEqual([
    expect.objectContaining({ id: remote.id, hubId: 'hub', sidebarCollapsed: true }),
    expect.objectContaining({ id: local.id, sidebarCollapsed: false }),
  ]);
  expect(useProjectsStore.getState().manualProjectOrder).toEqual([remote.id, local.id]);
  expect(fixture.settings).not.toHaveBeenCalled();
});

test('actual store drag and collapse PUT only Hub layout, serialize and consume server merge', async () => {
  const store = useProjectsStore.getState();
  store.synchronizeFromSettings(snapshot()); store.reconcileRemoteProjects([remote], 'hub');
  let authority = snapshot();
  fixture.fetch.mockImplementation(async (_path, options) => {
    const body = JSON.parse(options.body);
    expect(Object.keys(body)).toEqual(['hubProjectLayout']);
    expect(JSON.stringify(body)).not.toContain('/remote');
    const change = body.hubProjectLayout;
    authority = snapshot([...new Set([...change.order, ...authority.hubProjectLayout.order])], { ...authority.hubProjectLayout.collapsed, ...change.collapsed });
    return Response.json(authority);
  });
  store.reorderProjectsById(remote.id, local.id);
  store.setProjectCollapsed(remote.id, true);
  await waitForPendingHubProjectLayoutUpdates(getRuntimeTransportIdentity());
  await vi.waitFor(() => expect(useProjectsStore.getState().hubProjectLayout).toEqual(authority.hubProjectLayout));
  expect(fixture.fetch.mock.calls.map(([, options]) => JSON.parse(options.body))).toEqual([
    { hubProjectLayout: { hubId: 'hub', order: [remote.id, local.id], collapsed: {} } },
    { hubProjectLayout: { hubId: 'hub', order: [], collapsed: { [remote.id]: true } } },
  ]);
  expect(fixture.settings).not.toHaveBeenCalled();
  useProjectsStore.setState({ projects: [], manualProjectOrder: [], hubProjectLayout: null });
  useProjectsStore.getState().synchronizeFromSettings(authority);
  useProjectsStore.getState().reconcileRemoteProjects([remote], 'hub');
  expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([remote.id, local.id]);
  expect(useProjectsStore.getState().projects[0].sidebarCollapsed).toBe(true);
});

test.each([400, 409, 503])('failed layout PUT %s rolls back visible layout, keeps projects and permits retry', async (status) => {
  const store = useProjectsStore.getState();
  store.synchronizeFromSettings(snapshot()); store.reconcileRemoteProjects([remote], 'hub');
  fixture.fetch.mockResolvedValueOnce(Response.json({ error: 'failed' }, { status }));
  store.reorderProjectsById(remote.id, local.id);
  await vi.waitFor(() => expect(fixture.error).toHaveBeenCalled());
  expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual([local.id, remote.id]);
  fixture.fetch.mockResolvedValueOnce(Response.json(snapshot([remote.id, local.id])));
  store.reorderProjectsById(remote.id, local.id);
  await waitForPendingHubProjectLayoutUpdates(getRuntimeTransportIdentity());
  await vi.waitFor(() => expect(useProjectsStore.getState().hubProjectLayout?.order).toEqual([remote.id, local.id]));
});

test('late write from previous Hub cannot alter the next Hub projection', async () => {
  const store = useProjectsStore.getState();
  store.synchronizeFromSettings(snapshot()); store.reconcileRemoteProjects([remote], 'hub');
  let finish!: (response: Response) => void;
  fixture.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
  store.reorderProjectsById(remote.id, local.id);
  await vi.waitFor(() => expect(fixture.fetch).toHaveBeenCalled());
  const oldTransport = getRuntimeTransportIdentity();
  switchRuntimeEndpoint({ apiBaseUrl: 'https://other.example', runtimeKey: 'other-hub-layout' });
  useProjectsStore.setState({ projects: [{ id: 'other-local', path: '/other' }], activeProjectId: 'other-local', manualProjectOrder: ['other-local'], hubProjectLayout: null });
  finish(Response.json(snapshot([remote.id, local.id])));
  await waitForPendingHubProjectLayoutUpdates(oldTransport);
  expect(useProjectsStore.getState().projects.map((project) => project.id)).toEqual(['other-local']);
  expect(fixture.error).not.toHaveBeenCalled();
});
