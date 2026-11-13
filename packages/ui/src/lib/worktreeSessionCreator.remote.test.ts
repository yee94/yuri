import { beforeEach, expect, test, vi } from 'vitest';
import type { ProjectEntry } from '@/lib/api/types';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { HostCatalog } from '@/lib/remote-projects/types';
import type { RemoteSessionNavigation } from '@/stores/useSessionNavigationStore';

const mocks = vi.hoisted(() => ({
  local: vi.fn(), error: vi.fn(), seed: vi.fn(), open: vi.fn(),
  catalog: vi.fn(), registry: vi.fn(), session: vi.fn(), config: vi.fn(), model: vi.fn(), agent: vi.fn(), agentModel: vi.fn(), variant: vi.fn(), update: vi.fn(), navigation: null as RemoteSessionNavigation | null,
  project: { id: 'ref-b', path: '/repo', hostId: 'b', hubId: 'hub' } as ProjectEntry,
}));
vi.mock('@/components/ui', () => ({ toast: { error: mocks.error } }));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: { getState: () => ({
  getActiveProject: () => mocks.project, projects: [mocks.project, { id: 'local', path: '/repo' }],
}) } }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: { getState: mocks.local } }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: { getState: mocks.local } }));
vi.mock('@/stores/useConfigStore', () => ({ getConfigDirectoryKey: mocks.local, useConfigStore: { getState: mocks.local } }));
vi.mock('@/sync/selection-store', () => ({ useSelectionStore: { getState: () => ({
  saveSessionModelSelection: mocks.model, saveSessionAgentSelection: mocks.agent,
  saveAgentModelForSession: mocks.agentModel, saveAgentModelVariantForSession: mocks.variant,
}) } }));
vi.mock('@/lib/gitApi', () => ({ checkIsGitRepository: mocks.local, previewGitWorktree: mocks.local }));
vi.mock('@/lib/worktrees/worktreeCreate', () => ({ createWorktreeWithDefaults: mocks.local }));
vi.mock('@/lib/worktrees/worktreeStatus', () => ({ getRootBranch: mocks.local }));
vi.mock('@/lib/worktrees/worktreeManager', () => ({ removeProjectWorktree: mocks.local }));
vi.mock('@/lib/worktrees/worktreeBootstrap', () => ({ waitForWorktreeBootstrap: mocks.local }));
vi.mock('@/queries/remoteProjectQueries', () => ({ ensureRemoteHostCatalog: mocks.catalog, getHostRuntimeRegistry: mocks.registry }));
vi.mock('@/stores/useSessionNavigationStore', () => ({ useSessionNavigationStore: { getState: () => ({ openRemoteSession: mocks.open, updateRemoteDraft: mocks.update, remoteSession: mocks.navigation }) } }));
vi.mock('@/sync/remote-input-store', async (original) => ({ ...await original<typeof import('@/sync/remote-input-store')>(), seedRemoteDraft: mocks.seed }));

import { createWorktreeDraft, createWorktreeDraftForBranch, createWorktreeSession, createWorktreeSessionForNewBranch } from './worktreeSessionCreator';

let requests: Array<{ path: string; directory?: unknown; body?: Record<string, unknown> }>;
let failure: string | undefined;
let registry: HostRuntimeRegistry;
let bootstrapPending: boolean;
let setupWait: boolean;
let configMissing: boolean;
let bootstrapFailed: boolean;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.navigation = null;
  mocks.open.mockImplementation((project, location, sessionId, draft) => {
    mocks.navigation = { projectId: project.id, location, sessionId, draft };
  });
  mocks.update.mockImplementation((expected, patch, location) => {
    if (mocks.navigation !== expected) return false;
    mocks.navigation = { ...expected, ...(location ? { location } : {}), draft: { ...expected.draft, ...patch } };
    return true;
  });
  requests = [];
  failure = undefined;
  bootstrapPending = false;
  setupWait = true;
  configMissing = false;
  bootstrapFailed = false;
  mocks.project = { id: 'ref-b', path: '/repo', hostId: 'b', hubId: 'hub' } as ProjectEntry;
  const catalog = { supported: true, hubId: 'hub', hosts: [{ id: 'b', name: 'B', state: 'connected', source: 'ssh', available: true }],
    projects: [mocks.project] } as HostCatalog;
  registry = new HostRuntimeRegistry('hub', {
    transportIdentity: 'test', isCurrent: () => true,
    sdk: () => ({} as ReturnType<HostRuntimeRegistry['resolve']> extends { sdk(): infer S } ? S : never),
    service: () => ({ createSession: mocks.session, getConfig: mocks.config } as unknown as ReturnType<ReturnType<HostRuntimeRegistry['resolve']>['service']>),
    fetch: async (path, init) => {
      const query = init?.query;
      const directory = query instanceof URLSearchParams ? query.get('directory') : query?.directory;
      requests.push({ path, directory, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (failure && path.endsWith(failure) && (failure !== '/git/worktrees' || init?.method)) return Response.json({ error: 'Host denied' }, { status: 503 });
      if (path.endsWith('/fs/home')) return Response.json({ home: '/host-home' });
      if (path.endsWith('/fs/read')) return configMissing
        ? new Response('', { headers: { 'x-yuri-file-exists': 'false' } })
        : new Response(JSON.stringify({ 'setup-worktree': ['echo $ROOT_PROJECT_PATH'], 'setup-worktree-wait': setupWait }));
      if (path.endsWith('/git/check')) return Response.json({ isGitRepository: true });
      if (path.endsWith('/git/status')) return Response.json({ current: 'main', tracking: 'origin/main' });
      if (path.endsWith('/git/branches')) return Response.json({ branches: { main: { tracking: 'origin/main' } } });
      if (path.endsWith('/git/worktrees') && !init?.method) return Response.json([{ path: '/repo', name: 'repo' }]);
      if (path.endsWith('/bootstrap-status')) return Response.json({ status: bootstrapFailed ? 'failed' : 'ready', error: bootstrapFailed ? 'setup failed' : null, updatedAt: 1 });
      return Response.json({ path: '/worktrees/feature', branch: 'feature', name: 'feature', bootstrapStatus: { status: bootstrapPending ? 'pending' : 'ready' } });
    },
  });
  registry.applyCatalog(catalog);
  mocks.catalog.mockResolvedValue(catalog);
  mocks.registry.mockReturnValue(registry);
  mocks.session.mockResolvedValue({ id: 'remote-session' });
  mocks.config.mockResolvedValue({ model: 'host-provider/host-model', default_agent: 'host-agent' });
});

test.each([
  ['shortcut', () => createWorktreeSession()],
  ['draft', () => createWorktreeDraft({ initialPrompt: 'remote text', title: 'Title' })],
  ['branch', () => createWorktreeDraftForBranch({ branch: 'remotes/origin/feature', projectDirectory: '/hub-retained' })],
] as const)('%s uses actual scoped Git/config chain and never retained Hub state', async (_, run) => {
  expect(await run()).toBe('/worktrees/feature');
  expect(requests.every((r) => r.path.startsWith('/api/hosts/b/api/'))).toBe(true);
  const creation = [...requests].reverse().find((r) => r.path.endsWith('/git/worktrees'))!;
  expect(creation.directory).toBe('/repo');
  expect(creation.body).toMatchObject({ startCommand: 'echo /repo', upstreamRemote: 'origin', returnAfterDirectoryCreated: false });
  expect(mocks.navigation).toMatchObject({ location: { hubId: 'hub', hostId: 'b', directory: '/worktrees/feature' }, sessionId: null,
    draft: { pendingWorktreeRequestId: null, worktreeMetadata: { branch: 'feature', kind: 'standard' } } });
  expect(mocks.local).not.toHaveBeenCalled();
  expect(mocks.session).not.toHaveBeenCalled();
});

test('new branch creates the session through the worktree Host service and preserves upstream/fork options', async () => {
  expect(await createWorktreeSessionForNewBranch('/hub-retained', 'feature', 'origin/base', {
    ensureRemoteName: 'fork', ensureRemoteUrl: 'https://example.invalid/repo', upstreamRemote: 'fork', upstreamBranch: 'feature',
  })).toEqual({ id: 'remote-session', path: '/worktrees/feature', branch: 'feature' });
  expect([...requests].reverse().find((r) => r.path.endsWith('/git/worktrees'))?.body).toMatchObject({
    startRef: 'origin/base', ensureRemoteName: 'fork', upstreamRemote: 'fork', upstreamBranch: 'feature',
  });
  expect(mocks.session).toHaveBeenCalledWith({ title: undefined }, '/worktrees/feature');
  expect(mocks.navigation?.sessionId).toBe('remote-session');
  expect(mocks.local).not.toHaveBeenCalled();
});

test.each(['/fs/home', '/fs/read', '/git/worktrees/preview', '/git/worktrees'])('failure at %s preserves draft and never falls back to Hub', async (route) => {
  failure = route;
  expect(await createWorktreeDraft({ initialPrompt: 'retain me' })).toBeNull();
  if (route === '/git/worktrees') {
    expect(mocks.navigation?.draft?.bootstrapStatus).toMatchObject({ status: 'failed' });
  } else {
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.seed).not.toHaveBeenCalled();
  }
  expect(mocks.local).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalled();
});

test('failed remote session creation compensates only on captured Host', async () => {
  mocks.session.mockRejectedValueOnce(new Error('session failed'));
  expect(await createWorktreeSessionForNewBranch('/repo', 'feature')).toBeNull();
  expect(requests.at(-1)).toMatchObject({ path: '/api/hosts/b/api/git/worktrees', body: { directory: '/worktrees/feature', deleteLocalBranch: true } });
  expect(mocks.local).not.toHaveBeenCalled();
  expect(mocks.navigation?.sessionId).toBeNull();
});

test('Host missing Hub identity cannot enter any local API', async () => {
  delete mocks.project.hubId;
  expect(await createWorktreeDraft()).toBeNull();
  expect(requests).toEqual([]);
  expect(mocks.local).not.toHaveBeenCalled();
});

test('wait enabled waits for the actual Host bootstrap before opening a draft', async () => {
  bootstrapPending = true;
  const creating = createWorktreeDraft({ initialPrompt: 'setup first' });
  await vi.waitFor(() => expect(requests.some((r) => r.body?.returnAfterDirectoryCreated === false)).toBe(true));
  expect(mocks.navigation?.draft?.pendingWorktreeRequestId).toEqual(expect.any(String));
  expect(await creating).toBe('/worktrees/feature');
  expect(requests.at(-1)?.path).toBe('/api/hosts/b/api/git/worktrees/bootstrap-status');
  expect(mocks.seed).toHaveBeenCalledWith({ hubId: 'hub', hostId: 'b', directory: '/worktrees/feature' }, 'setup first');
});

test('wait disabled keeps background setup capability without a bootstrap poll', async () => {
  setupWait = false;
  bootstrapPending = true;
  expect(await createWorktreeDraft()).toBe('/worktrees/feature');
  expect(requests.some((r) => r.path.endsWith('/bootstrap-status'))).toBe(false);
  expect(mocks.navigation?.draft?.bootstrapStatus).toBeUndefined();
  expect(mocks.navigation?.draft?.worktreeMetadata?.worktreeStatus).toBe('pending');
});

test('title and project defaults survive pending draft settlement without Hub selection mutation', async () => {
  mocks.project.defaultModel = 'project-provider/project-model';
  expect(await createWorktreeDraft({ title: 'Keep title', initialPrompt: 'Keep prompt' })).toBe('/worktrees/feature');
  expect(mocks.open.mock.calls[0][3]).toMatchObject({ title: 'Keep title', initialPrompt: 'Keep prompt',
    defaultModel: 'project-provider/project-model', pendingWorktreeRequestId: expect.any(String) });
  expect(mocks.navigation?.draft).toMatchObject({ title: 'Keep title', initialPrompt: 'Keep prompt', defaultModel: 'project-provider/project-model', pendingWorktreeRequestId: null });
  expect(mocks.model).not.toHaveBeenCalled();
  expect(mocks.local).not.toHaveBeenCalled();
});

test('NewBranch stores kind and Host-native selection under explicit Location, never the Hub bare ID', async () => {
  mocks.project.defaultModel = 'project-provider/project-model';
  expect(await createWorktreeSessionForNewBranch('/repo', 'feature', 'upstream/base', { kind: 'pr', createdFromBranch: 'upstream/base' })).not.toBeNull();
  const location = { hubId: 'hub', hostId: 'b', directory: '/worktrees/feature' };
  expect(mocks.navigation?.draft?.worktreeMetadata).toMatchObject({ kind: 'pr', createdFromBranch: 'upstream/base' });
  expect(mocks.config).toHaveBeenCalledWith('/worktrees/feature');
  expect(mocks.model).toHaveBeenCalledWith('remote-session', 'project-provider', 'project-model', location);
  expect(mocks.agent).toHaveBeenCalledWith('remote-session', 'host-agent', location);
  expect(mocks.variant).toHaveBeenCalledWith('remote-session', 'host-agent', 'project-provider', 'project-model', undefined, location);
  expect(mocks.local).not.toHaveBeenCalled();
});

test('NewBranch keeps the pending composer locked until the captured Host session actually exists', async () => {
  let finish!: (session: { id: string }) => void;
  mocks.session.mockImplementationOnce(() => new Promise<{ id: string }>((resolve) => { finish = resolve; }));
  const creating = createWorktreeSessionForNewBranch('/repo', 'feature');
  await vi.waitFor(() => expect(mocks.session).toHaveBeenCalled());
  expect(mocks.navigation?.sessionId).toBeNull();
  expect(mocks.navigation?.draft?.pendingWorktreeRequestId).toEqual(expect.any(String));
  finish({ id: 'actual-host-session' });
  expect(await creating).toMatchObject({ id: 'actual-host-session' });
  expect(mocks.navigation?.sessionId).toBe('actual-host-session');
  expect(mocks.navigation?.draft?.pendingWorktreeRequestId).toBeNull();
  expect(mocks.local).not.toHaveBeenCalled();
});

test('settlement preserves concurrent options edits belonging to the same pending remote draft', async () => {
  bootstrapPending = true;
  const creating = createWorktreeDraft({ title: 'Original title' });
  await vi.waitFor(() => expect(mocks.navigation?.draft?.pendingWorktreeRequestId).toEqual(expect.any(String)));
  mocks.navigation = { ...mocks.navigation!, draft: { ...mocks.navigation!.draft, title: 'Edited while preparing', permissionAutoAcceptEnabled: true } };
  expect(await creating).toBe('/worktrees/feature');
  expect(mocks.navigation?.draft).toMatchObject({ title: 'Edited while preparing', permissionAutoAcceptEnabled: true, pendingWorktreeRequestId: null });
  expect(mocks.local).not.toHaveBeenCalled();
});

test('nested project stays at its relative path in the remote checkout', async () => {
  mocks.project.path = '/repo/src';
  expect(await createWorktreeSessionForNewBranch('/repo/src', 'feature')).toEqual({ id: 'remote-session', branch: 'feature', path: '/worktrees/feature/src' });
  expect(mocks.session).toHaveBeenCalledWith({ title: undefined }, '/worktrees/feature/src');
  expect(mocks.navigation?.location.directory).toBe('/worktrees/feature/src');
  expect(mocks.local).not.toHaveBeenCalled();
});

test('missing native and legacy config remains an empty successful config, not a Hub fallback', async () => {
  configMissing = true;
  expect(await createWorktreeDraft()).toBe('/worktrees/feature');
  expect(requests.filter((r) => r.path.endsWith('/fs/read'))).toHaveLength(2);
  expect(mocks.local).not.toHaveBeenCalled();
});

test('bootstrap failure keeps the original draft and does not create a session', async () => {
  bootstrapPending = true;
  bootstrapFailed = true;
  expect(await createWorktreeSessionForNewBranch('/repo', 'feature')).toBeNull();
  expect(mocks.navigation?.draft?.bootstrapStatus).toMatchObject({ status: 'failed', error: 'setup failed' });
  expect(mocks.session).not.toHaveBeenCalled();
  expect(mocks.error).toHaveBeenCalledWith('Failed to create worktree', { description: 'setup failed' });
  expect(mocks.local).not.toHaveBeenCalled();
});

test('switching project during creation never steals the new selection', async () => {
  bootstrapPending = true;
  const creating = createWorktreeDraft({ initialPrompt: 'for B' });
  await vi.waitFor(() => expect(requests.some((r) => r.body?.returnAfterDirectoryCreated === false)).toBe(true));
  mocks.project = { id: 'local', path: '/repo' } as ProjectEntry;
  expect(await creating).toBe('/worktrees/feature');
  expect(mocks.open).toHaveBeenCalledOnce();
  expect(mocks.seed).toHaveBeenCalledWith({ hubId: 'hub', hostId: 'b', directory: '/worktrees/feature' }, 'for B');
});

test('a retired Host entry cannot commit its draft or issue any local fallback', async () => {
  bootstrapPending = true;
  const creating = createWorktreeDraft();
  await vi.waitFor(() => expect(requests.some((r) => r.body?.returnAfterDirectoryCreated === false)).toBe(true));
  registry.dispose();
  expect(await creating).toBeNull();
  expect(mocks.navigation?.draft?.bootstrapStatus).toMatchObject({ status: 'failed' });
  expect(mocks.local).not.toHaveBeenCalled();
});
