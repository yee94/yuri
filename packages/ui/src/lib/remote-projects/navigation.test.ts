import { beforeEach, expect, it, vi } from 'vitest';
import { applyRemoteProjectRoute } from './navigation';
import { routeStateFromPath } from '@/lib/router/parseRoute';

const fixture = vi.hoisted(() => ({
  catalog: vi.fn(), summaries: vi.fn(), registry: {}, upsert: vi.fn(), select: vi.fn(), open: vi.fn(),
}));
vi.mock('@/queries/remoteProjectQueries', () => ({ ensureRemoteHostCatalog: fixture.catalog, ensureRemoteHostSummaries: fixture.summaries, getHostRuntimeRegistry: () => fixture.registry }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({ upsertRemoteProject: fixture.upsert, setActiveProjectIdOnly: fixture.select }) } }));
vi.mock('@/stores/useSessionNavigationStore', () => ({ useSessionNavigationStore: { getState: () => ({ openRemoteSession: fixture.open }) } }));
const project = { id: 'reference', hostId: 'host', hubId: 'hub', path: '/root', remoteProjectId: 'remote-project', remoteState: 'ok' };
beforeEach(() => {
  vi.clearAllMocks(); fixture.catalog.mockResolvedValue({ supported: true, hubId: 'hub', projects: [project], hosts: [] });
  fixture.summaries.mockResolvedValue({ worktrees: { projectDirectories: { '/root': ['/root', '/sibling worktree'] }, staleProjectDirectories: [] } });
});

it('restores a worktree URL through its current-Hub project reference without replacing raw cwd with project root', async () => {
  const route = routeStateFromPath('/session/raw-id?hostId=host&hubId=hub&projectId=reference&directory=%2Fsibling%20worktree');
  await applyRemoteProjectRoute(route);
  expect(fixture.upsert).toHaveBeenCalledWith(project, 'hub');
  expect(fixture.select).toHaveBeenCalledWith('reference');
  expect(fixture.open).toHaveBeenCalledWith(project, { hubId: 'hub', hostId: 'host', directory: '/sibling worktree' }, 'raw-id');
  expect(fixture.summaries).not.toHaveBeenCalled();
});

it('restores legacy URLs and notifications without projectId through Hub topology and preserves the worktree cwd', async () => {
  const route = routeStateFromPath('/session/raw-id?hostId=host&hubId=hub&directory=%2Fsibling%20worktree');
  expect(await applyRemoteProjectRoute(route)).toBe(true);
  expect(fixture.summaries).toHaveBeenCalledWith(fixture.registry, 'host');
  expect(fixture.open).toHaveBeenCalledWith(project, { hubId: 'hub', hostId: 'host', directory: '/sibling worktree' }, 'raw-id');
});

it('does not mutate selection after topology failure or navigation supersedes a delayed lookup', async () => {
  const route = routeStateFromPath('/session/raw-id?hostId=host&hubId=hub&directory=%2Fsibling%20worktree');
  fixture.summaries.mockRejectedValueOnce(new Error('topology unavailable'));
  await expect(applyRemoteProjectRoute(route)).rejects.toThrow('topology unavailable');
  expect(fixture.open).not.toHaveBeenCalled();
  let current = true;
  fixture.summaries.mockImplementationOnce(async () => { current = false; return { worktrees: { projectDirectories: { '/root': ['/sibling worktree'] }, staleProjectDirectories: [] } }; });
  expect(await applyRemoteProjectRoute(route, () => current)).toBe(false);
  expect(fixture.open).not.toHaveBeenCalled(); expect(fixture.select).not.toHaveBeenCalled();
});

it('rejects a foreign reference and ignores a superseded route without changing either selection', async () => {
  const route = routeStateFromPath('/session/raw-id?hostId=other-host&hubId=hub&projectId=reference&directory=%2Froot');
  await expect(applyRemoteProjectRoute(route)).rejects.toThrow('not referenced');
  expect(fixture.upsert).not.toHaveBeenCalled(); expect(fixture.open).not.toHaveBeenCalled();
  expect(await applyRemoteProjectRoute({ ...route, hostId: 'host' }, () => false)).toBe(false);
  expect(fixture.select).not.toHaveBeenCalled(); expect(fixture.open).not.toHaveBeenCalled();
});
