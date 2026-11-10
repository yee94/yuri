import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  wait: vi.fn(), create: vi.fn(), createSession: vi.fn(), remove: vi.fn(),
  metadata: vi.fn(), directory: vi.fn(),
  projects: [{ id: 'root', path: '/repo' }, { id: 'src', path: '/repo/src' }],
}));
vi.mock('@/components/ui', () => ({ toast: { error: vi.fn() } }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: { getState: () => ({
  createSession: mocks.createSession, initializeNewYuriSession: vi.fn(), setSessionDirectory: vi.fn(), setWorktreeMetadata: mocks.metadata,
}) } }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({
  projects: mocks.projects, getActiveProject: () => mocks.projects[0],
}) } }));
vi.mock('@/stores/useConfigStore', () => ({ getConfigDirectoryKey: (directory: string) => directory,
  useConfigStore: { getState: () => ({ agents: [], providers: [], activateDirectory: vi.fn() }) },
}));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: () => ({ setDirectory: mocks.directory }) } }));
vi.mock('@/sync/selection-store', () => ({ useSelectionStore: { getState: () => ({}) } }));
vi.mock('@/lib/gitApi', () => ({ checkIsGitRepository: async () => true, previewGitWorktree: vi.fn() }));
vi.mock('@/lib/git/branchNameGenerator', () => ({ generateBranchName: vi.fn() }));
vi.mock('@/lib/worktrees/worktreeStatus', () => ({ getRootBranch: async () => 'main' }));
vi.mock('@/lib/yuriConfig', () => ({ getWorktreeSetupCommands: async () => [], getWorktreeSetupWaitEnabled: async () => true }));
vi.mock('@/lib/worktrees/worktreeManager', () => ({ removeProjectWorktree: mocks.remove }));
vi.mock('@/lib/worktrees/worktreeCreate', () => ({ createWorktreeWithDefaults: mocks.create }));
vi.mock('@/lib/worktrees/pendingDraftWorktree', () => ({
  createPendingDraftWorktreeRequest: vi.fn(), rejectPendingDraftWorktreeRequest: vi.fn(), resolvePendingDraftWorktreeRequest: vi.fn(),
}));
vi.mock('@/lib/worktrees/worktreeBootstrap', () => ({ waitForWorktreeBootstrap: mocks.wait }));

import { createWorktreeSessionForNewBranch } from './worktreeSessionCreator';

beforeEach(() => {
  vi.clearAllMocks();
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
  expect(mocks.createSession).toHaveBeenCalledWith(undefined, '/feature/src');
});

test('failed bootstrap never creates a session in either the scoped directory or the checkout root', async () => {
  mocks.wait.mockRejectedValue(new Error('setup failed'));
  expect(await createWorktreeSessionForNewBranch('/repo/src', 'feature')).toBeNull();
  expect(mocks.createSession).not.toHaveBeenCalled();
});
