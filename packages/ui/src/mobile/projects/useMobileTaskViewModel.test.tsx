import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test, vi } from 'vitest';
import type { Session } from '@/lib/opencode/v2-types';
import { createSessionOwnershipIndex } from '@/components/session/sidebar/sessionOwnership';
import { useMobileTaskViewModel, type MobileTaskViewModel } from './useMobileTaskViewModel';
import type { MobileProjectsHomeModel } from './useMobileProjectsHomeModel';

const fixtures = vi.hoisted(() => ({
  gitStatus: new Map<string, { isGitRepo: boolean | null; branch: string | null }>(),
  ids: new Set<string>(),
  counts: {},
  projects: [],
  runStarts: new Map<string, number>(),
  ensureStatus: vi.fn(),
}));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git: undefined }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/stores/useGitStore', () => ({
  useGitRepoStatusMap: () => fixtures.gitStatus,
  useGitStore: (selector: (state: { ensureStatus: typeof fixtures.ensureStatus }) => unknown) => selector(fixtures),
}));
vi.mock('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: (selector: (state: { homeDirectory: string }) => unknown) => selector({ homeDirectory: '/home/user' }),
}));
vi.mock('@/stores/useProjectsStore', () => ({
  useProjectsStore: (selector: (state: { projects: never[] }) => unknown) => selector(fixtures),
}));
vi.mock('@/stores/useSessionFoldersStore', () => ({
  useSessionFoldersStore: (selector: (state: { sessionOrderByScope: object }) => unknown) => selector({ sessionOrderByScope: {} }),
}));
vi.mock('@/sync/session-ui-store', () => ({
  useSessionUIStore: (selector: (state: { currentSessionId: null }) => unknown) => selector({ currentSessionId: null }),
}));
vi.mock('@/sync/notification-store', () => ({
  useNotificationStore: (selector: (state: { index: { session: { unseenCount: object } } }) => unknown) =>
    selector({ index: { session: { unseenCount: fixtures.counts } } }),
}));
vi.mock('@/queries/sessionIndexPinQueries', () => ({ usePinnedSessionIds: () => fixtures.ids }));
vi.mock('@/queries/sessionIndexSettleQueries', () => ({ useSettledSessionIds: () => fixtures.ids, useTaskIndexMembership: () => null }));
vi.mock('@/components/session/sidebar/hooks/useAlwaysVisibleSessionIds', () => ({ useRunningSessionIds: () => fixtures.ids }));
vi.mock('@/components/session/sidebar/taskRunElapsed', () => ({ useRunStartTimes: () => fixtures.runStarts }));
vi.mock('@/sync/sync-context', () => ({ useSessionIdsWithPendingRequests: () => fixtures.ids }));
vi.mock('./useMobileProjectsHomeModel', () => ({
  findExactWorktreeMatch: () => null,
  formatRelativeShort: () => '',
  getSessionDirectory: (session: { directory?: string }) => session.directory ?? '',
  getSessionTimestamp: (session: Session) => session.time?.updated ?? session.time?.created ?? 0,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test('task model distinguishes unknown Git, ready branch and confirmed non-repository without extra requests', () => {
  fixtures.gitStatus = new Map();
  fixtures.ensureStatus.mockClear();
  const session = { id: 'task', title: 'Task', directory: '/home/user/project', time: { created: 1, updated: 1 } } as Session;
  const model: Pick<MobileProjectsHomeModel, 'allSessions' | 'ownership' | 'projectMetaById'> = {
    allSessions: [session],
    ownership: createSessionOwnershipIndex([session], [{ id: 'project', normalizedPath: '/home/user/project' }], new Map(), false),
    projectMetaById: new Map([['project', { id: 'project', path: '/home/user/project', label: 'Project', worktrees: [] }]]),
  };
  const root = createRoot(document.createElement('div'));
  let latest: MobileTaskViewModel | null = null;
  function Harness() {
    latest = useMobileTaskViewModel(model, { enabled: true, status: 'active', settledLimit: 30 });
    return null;
  }
  const read = () => (latest as MobileTaskViewModel | null)?.items[0];
  try {
    act(() => root.render(<Harness />));
    expect(read()).toMatchObject({ branchState: 'loading', branch: undefined, pathLabel: undefined });
    fixtures.gitStatus = new Map([['/home/user/project', { isGitRepo: true, branch: 'main' }]]);
    act(() => root.render(<Harness />));
    expect(read()).toMatchObject({ branch: 'main', branchState: null, pathLabel: undefined });
    fixtures.gitStatus = new Map([['/home/user/project', { isGitRepo: false, branch: null }]]);
    act(() => root.render(<Harness />));
    expect(read()).toMatchObject({ branchState: 'no-git', branch: undefined, pathLabel: '~/project' });
    expect(fixtures.ensureStatus).not.toHaveBeenCalled();
  } finally {
    act(() => root.unmount());
  }
});

test('unread tab keeps only unread tasks and reports the filtered total', () => {
  fixtures.gitStatus = new Map();
  fixtures.counts = { b: 2 };
  const sessions = ['a', 'b'].map((id) => ({ id, title: id, directory: '/home/user/project', time: { created: 1, updated: 1 } }) as Session);
  const model: Pick<MobileProjectsHomeModel, 'allSessions' | 'ownership' | 'projectMetaById'> = {
    allSessions: sessions,
    ownership: createSessionOwnershipIndex(sessions, [{ id: 'project', normalizedPath: '/home/user/project' }], new Map(), false),
    projectMetaById: new Map([['project', { id: 'project', path: '/home/user/project', label: 'Project', worktrees: [] }]]),
  };
  const root = createRoot(document.createElement('div'));
  let latest: MobileTaskViewModel | null = null;
  function Harness({ status }: { status: 'active' | 'unread' }) {
    latest = useMobileTaskViewModel(model, { enabled: true, status, settledLimit: 30 });
    return null;
  }
  try {
    act(() => root.render(<Harness status="active" />));
    expect((latest as MobileTaskViewModel | null)?.total).toBe(2);
    act(() => root.render(<Harness status="unread" />));
    expect((latest as MobileTaskViewModel | null)?.items.map((node) => node.id)).toEqual(['b']);
    expect((latest as MobileTaskViewModel | null)?.total).toBe(1);
  } finally {
    act(() => root.unmount());
    fixtures.counts = {};
  }
});
