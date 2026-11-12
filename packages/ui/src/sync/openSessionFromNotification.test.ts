import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  return {
    isLocalRuntimeActive: true,
    runtimeKey: 'local',
    switchCalls: 0,
    setCurrentSession: [] as Array<[string, string | null, string]>,
    setActiveMainTab: [] as string[],
    remoteRoute: vi.fn(async () => undefined),
  };
});

vi.mock('@/lib/desktopLocalRuntime', () => ({
  isLocalRuntimeActive: () => mocks.isLocalRuntimeActive,
  switchToLocalDesktopRuntime: async () => {
    mocks.switchCalls += 1;
    mocks.runtimeKey = 'local';
    return { ok: true };
  },
}));

vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeKey: () => mocks.runtimeKey,
}));
vi.mock('@/lib/remote-projects/navigation', () => ({ applyRemoteProjectRoute: mocks.remoteRoute }));

vi.mock('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      setCurrentSession: (id: string, directory: string | null) => {
        mocks.setCurrentSession.push([id, directory, mocks.runtimeKey]);
      },
    }),
  },
}));

vi.mock('@/stores/useUIStore', () => ({
  useUIStore: {
    getState: () => ({
      setActiveMainTab: (tab: string) => {
        mocks.setActiveMainTab.push(tab);
        return true;
      },
    }),
  },
}));

import { openSessionFromNotification } from './openSessionFromNotification';

const flushMicrotasks = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('openSessionFromNotification', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.isLocalRuntimeActive = true;
    mocks.runtimeKey = 'local';
    mocks.switchCalls = 0;
    mocks.setCurrentSession.length = 0;
    mocks.setActiveMainTab.length = 0;
    mocks.remoteRoute.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('local active opens immediately without switching', () => {
    openSessionFromNotification({ sessionId: 'ses_local', directory: '/repo' });
    expect(mocks.switchCalls).toBe(0);
    expect(mocks.setActiveMainTab).toEqual(['chat']);
    expect(mocks.setCurrentSession).toEqual([['ses_local', '/repo', 'local']]);
  });

  test('empty sessionId is a no-op', () => {
    openSessionFromNotification({ sessionId: '  ', directory: '/repo' });
    expect(mocks.switchCalls).toBe(0);
    expect(mocks.setCurrentSession).toEqual([]);
  });

  test('explicit Host notifications never enter the local session lookup', async () => {
    openSessionFromNotification({ sessionId: 'same-id', directory: 'C:\\repo', hubId: 'hub', hostId: 'host' });
    await vi.dynamicImportSettled();
    expect(mocks.remoteRoute).toHaveBeenCalledWith({ sessionId: 'same-id', directory: 'C:\\repo', hubId: 'hub', hostId: 'host', isNewSession: false }, expect.any(Function));
    expect(mocks.setCurrentSession).toEqual([]);
  });

  test('incomplete remote identity is rejected without local fallback', () => {
    openSessionFromNotification({ sessionId: 'same-id', directory: '/repo', hostId: 'host' });
    expect(mocks.remoteRoute).not.toHaveBeenCalled();
    expect(mocks.setCurrentSession).toEqual([]);
  });

  test.each(['host:remote', 'relay:remote'])('notification delivered to %s stays on its originating runtime', async (runtimeKey) => {
    mocks.isLocalRuntimeActive = false;
    mocks.runtimeKey = runtimeKey;
    openSessionFromNotification({ sessionId: 'ses_remote', directory: '/remote/repo' });
    await flushMicrotasks();
    expect(mocks.switchCalls).toBe(0);
    expect(mocks.runtimeKey).toBe(runtimeKey);
    expect(mocks.setCurrentSession).toEqual([['ses_remote', '/remote/repo', runtimeKey]]);
    expect(mocks.setActiveMainTab).toEqual(['chat']);
  });

  test('consecutive clicks open on the receiving runtime without delayed local navigation', async () => {
    mocks.isLocalRuntimeActive = false;
    mocks.runtimeKey = 'host:remote';
    openSessionFromNotification({ sessionId: 'ses_first', directory: '/a' });
    openSessionFromNotification({ sessionId: 'ses_second', directory: '/b' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mocks.switchCalls).toBe(0);
    expect(mocks.setCurrentSession).toEqual([
      ['ses_first', '/a', 'host:remote'],
      ['ses_second', '/b', 'host:remote'],
    ]);
    expect(vi.getTimerCount()).toBe(0);
  });

  test('normalizes session and directory hints, leaving absent directories for session resolution', () => {
    openSessionFromNotification({ sessionId: ' ses_trimmed ', directory: ' /repo ' });
    openSessionFromNotification({ sessionId: 'ses_no_hint', directory: ' ' });
    expect(mocks.setCurrentSession).toEqual([
      ['ses_trimmed', '/repo', 'local'],
      ['ses_no_hint', null, 'local'],
    ]);
  });
});
