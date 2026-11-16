import { beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  setCurrentSession: vi.fn(),
  setActiveMainTab: vi.fn(() => true),
  notify: vi.fn(),
  remoteRoute: vi.fn(async () => true),
  supported: true,
  catalog: vi.fn(),
}));

vi.mock('@/router/sessionLookup', () => ({ resolveSessionForRoute: mocks.lookup }));
vi.mock('@/sync/openSessionWithFeedback', () => ({ notifySessionOpenFailed: mocks.notify }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: { getState: () => ({ setCurrentSession: mocks.setCurrentSession }) } }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: { getState: () => ({ setActiveMainTab: mocks.setActiveMainTab }) } }));
vi.mock('@/queries/remoteProjectQueries', () => ({
  supportsRemoteProjects: () => mocks.supported,
  ensureRemoteHostCatalog: mocks.catalog,
}));
vi.mock('@/lib/remote-projects/navigation', () => ({ applyRemoteProjectRoute: mocks.remoteRoute }));

import { openSessionFromDeepLink } from './openSessionFromDeepLink';

const project = (id: string, hostId: string, path: string) => ({ id, hostId, path });
const catalog = (projects: Array<ReturnType<typeof project>>) => ({ supported: true, hubId: 'hub', projects });

describe('openSessionFromDeepLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.supported = true;
    mocks.lookup.mockResolvedValue(null);
  });

  test('opens a session known to the local index', async () => {
    mocks.lookup.mockResolvedValue({ directory: '/local/repo' });
    await openSessionFromDeepLink({ sessionId: ' ses_1 ', directory: '/remote/repo' });
    expect(mocks.setCurrentSession).toHaveBeenCalledWith('ses_1', '/local/repo');
    expect(mocks.remoteRoute).not.toHaveBeenCalled();
  });

  test('routes to the single Remote Project that owns the directory', async () => {
    mocks.catalog.mockResolvedValue(catalog([project('p1', 'host-a', '/srv/app'), project('p2', 'host-b', '/other')]));
    await openSessionFromDeepLink({ sessionId: 'ses_1', directory: '/srv/app/sub' });
    expect(mocks.remoteRoute).toHaveBeenCalledWith(
      { sessionId: 'ses_1', directory: '/srv/app/sub', hostId: 'host-a', hubId: 'hub', projectId: 'p1', isNewSession: false },
      expect.any(Function),
    );
    expect(mocks.notify).not.toHaveBeenCalled();
  });

  test('reports not found when no Remote Project owns the directory', async () => {
    mocks.catalog.mockResolvedValue(catalog([project('p1', 'host-a', '/srv/app')]));
    await openSessionFromDeepLink({ sessionId: 'ses_1', directory: '/elsewhere' });
    expect(mocks.remoteRoute).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith('ses_1', 'not-found');
  });

  test('does not guess when several Hosts own the same path', async () => {
    mocks.catalog.mockResolvedValue(catalog([project('p1', 'host-a', '/srv/app'), project('p2', 'host-b', '/srv/app')]));
    await openSessionFromDeepLink({ sessionId: 'ses_1', directory: '/srv/app' });
    expect(mocks.remoteRoute).not.toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith('ses_1', 'not-found');
  });

  test('reports not found without a directory or remote support', async () => {
    await openSessionFromDeepLink({ sessionId: 'ses_1' });
    mocks.supported = false;
    await openSessionFromDeepLink({ sessionId: 'ses_2', directory: '/srv/app' });
    expect(mocks.notify.mock.calls).toEqual([['ses_1', 'not-found'], ['ses_2', 'not-found']]);
  });

  test('reports not found when the catalog cannot be read', async () => {
    mocks.catalog.mockRejectedValue(new Error('offline'));
    await openSessionFromDeepLink({ sessionId: 'ses_1', directory: '/srv/app' });
    expect(mocks.notify).toHaveBeenCalledWith('ses_1', 'not-found');
  });
});
