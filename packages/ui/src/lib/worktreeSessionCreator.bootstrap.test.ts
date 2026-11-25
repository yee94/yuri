import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  wait: vi.fn(), create: vi.fn(), createSession: vi.fn(), remove: vi.fn(),
  metadata: vi.fn(), directory: vi.fn(), toastError: vi.fn(), checkGit: vi.fn(),
  projects: [{ id: 'root', path: '/repo' }, { id: 'src', path: '/repo/src' }, { id: 'non-git', path: '/plain' }],
  activeIndex: 0,
}));
vi.mock('@/components/ui', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: { getState: () => ({
  newSessionDraft: { open: false, selectedProjectId: null, pendingWorktreeRequestId: null },
  openNewSessionDraft: vi.fn(), overrideNewSessionDraftTarget: vi.fn(),
  resolvePendingDraftWorktreeTarget: vi.fn(), setDraftBootstrapPendingDirectory: vi.fn(),
  createSession: mocks.createSession, initializeNewYuriSession: vi.fn(), setSessionDirectory: vi.fn(), setWorktreeMetadata: mocks.metadata,
}) } }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({
  projects: mocks.projects, getActiveProject: () => mocks.projects[mocks.activeIndex],
}) } }));
vi.mock('@/stores/useConfigStore', () => ({ getConfigDirectoryKey: (directory: string) => directory,
  useConfigStore: { getState: () => ({ agents: [], providers: [], activateDirectory: vi.fn() }) },
}));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ setDirectory: mocks.directory }) } }));
vi.mock('@/sync/selection-store', () => ({ useSelectionStore: { getState: () => ({}) } }));
vi.mock('@/lib/gitApi', () => ({ checkIsGitRepository: mocks.checkGit, previewGitWorktree: vi.fn(async () => null) }));
vi.mock('@/lib/git/branchNameGenerator', () => ({ generateBranchName: vi.fn() }));
vi.mock('@/lib/worktrees/worktreeStatus', () => ({ getRootBranch: async () => 'main' }));
vi.mock('@/lib/yuriConfig', () => ({ getWorktreeSetupCommands: async () => [], getWorktreeSetupWaitEnabled: async () => true }));
vi.mock('@/lib/worktrees/worktreeManager', () => ({ removeProjectWorktree: mocks.remove }));
vi.mock('@/lib/worktrees/worktreeCreate', () => ({ createWorktreeWithDefaults: mocks.create }));
vi.mock('@/lib/worktrees/pendingDraftWorktree', () => ({
  createPendingDraftWorktreeRequest: vi.fn(() => 'req-1'), rejectPendingDraftWorktreeRequest: vi.fn(), resolvePendingDraftWorktreeRequest: vi.fn(),
}));
vi.mock('@/lib/worktrees/worktreeBootstrap', () => ({ waitForWorktreeBootstrap: mocks.wait }));

import { createWorktreeDraftForBranch, createWorktreeSessionForNewBranch } from './worktreeSessionCreator';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.activeIndex = 0;
  mocks.checkGit.mockResolvedValue(true);
  mocks.create.mockResolvedValue({ path: '/feature/src', worktreeRoot: '/feature', projectDirectory: '/repo/src', branch: 'feature', label: 'feature' });
  mocks.createSession.mockResolvedValue({ id: 'new' });
});

test('selects the explicit nested project and waits on its Git root before creating its scoped session', async () => {
  let ready!: () => void;
  mocks.wait.mockImplementation(() => new Promise<void>((resolve) => { ready = resolve; }));
  const creating = createWorktreeSessionForNewBranch('/repo/src', 'feature');
  await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledWith('/feature'));
  expect(mocks.create.mock.calls[0][0]).toEqual(mocks.projects[1]);
  expect(mocks.createSession).not.toHaveBeenCalled();
  ready();
  expect(await creating).toEqual({ id: 'new', branch: 'feature', path: '/feature/src' });
  expect(mocks.createSession).toHaveBeenCalledWith(undefined, '/feature/src', null, {
    yuri: {
      worktree: {
        branch: 'feature',
        name: 'feature',
        path: '/feature/src',
        projectDirectory: '/repo/src',
        projectId: 'src',
        worktreeRoot: '/feature',
      },
    },
  });
});

test('failed bootstrap never creates a session in either the scoped directory or the checkout root', async () => {
  mocks.wait.mockRejectedValue(new Error('setup failed'));
  expect(await createWorktreeSessionForNewBranch('/repo/src', 'feature')).toBeNull();
  expect(mocks.createSession).not.toHaveBeenCalled();
});

test('explicit projectId / projectDirectory does not fall back to an unrelated non-Git active project', async () => {
  mocks.activeIndex = 2; // non-git active project
  mocks.checkGit.mockImplementation(async (dir: string) => dir === '/repo/src');

  const path = await createWorktreeDraftForBranch({
    branch: 'feat/demo',
    projectId: 'src',
    projectDirectory: '/repo/src',
  });
  expect(path).toBe('/feature/src');
  expect(mocks.checkGit).toHaveBeenCalledWith('/repo/src', { fresh: true });
});

test('git check transport failure reports real error instead of Not a Git repository', async () => {
  mocks.checkGit.mockRejectedValueOnce(new Error('HTTP 502 Bad Gateway'));

  expect(await createWorktreeDraftForBranch({
    branch: 'feat/demo',
    projectId: 'root',
    projectDirectory: '/repo',
  })).toBeNull();
  expect(mocks.toastError).toHaveBeenCalledWith('Failed to check Git repository', {
    description: 'HTTP 502 Bad Gateway',
  });
});
