import { beforeEach, expect, test, vi } from 'vitest';
import type { WorktreeMetadata } from '@/types/worktree';

const state = vi.hoisted(() => ({
  runtime: 'A', generation: 1, repository: '/repo', fail: false,
  worktrees: [{ path: '/repo', branch: 'main' }] as Array<{ path: string; branch: string }>,
  requests: [] as string[],
}));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => state.runtime, getRuntimeGeneration: () => state.generation }));
vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ api: (path: string, query: Record<string, string>) => `${path}?${new URLSearchParams(query)}` }) }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: async (input: string) => {
  state.requests.push(input);
  const root = input.includes('/primary-root');
  return new Response(JSON.stringify(root ? { root: state.repository } : state.worktrees), { status: state.fail && !root ? 503 : 200 });
} }));
vi.mock('@/lib/gitApi', async () => {
  const http = await import('@/lib/gitApiHttp');
  return { deleteRemoteBranch: vi.fn(), resolveGitPrimaryRoot: async (directory: string) => (await http.resolveGitPrimaryRoot(directory)).root,
    git: { worktree: { list: http.listGitWorktrees } },
  };
});
vi.mock('@/lib/yuriConfig', () => ({ substituteCommandVariables: (value: string) => value }));
vi.mock('@/lib/worktrees/worktreeStatus', () => ({ resolveProjectRoot: vi.fn(), invalidateResolvedProjectRootCache: vi.fn() }));
vi.mock('@/lib/worktrees/worktreeBootstrap', () => ({
  getWorktreeBootstrapState: () => null, clearWorktreeBootstrapState: vi.fn(), markWorktreeBootstrapPending: vi.fn(),
  setWorktreeBootstrapState: vi.fn(), startWorktreeBootstrapWatcher: vi.fn(),
}));
vi.mock('@/sync/session-worktree-store', () => ({ useSessionWorktreeStore: { getState: () => ({ attachments: new Map() }) } }));
vi.mock('@/sync/session-ui-store', () => {
  const store = { availableWorktreesByProject: new Map<string, WorktreeMetadata[]>(), availableWorktrees: [] as WorktreeMetadata[], worktreeMetadata: new Map<string, WorktreeMetadata>() };
  return { useSessionUIStore: { getState: () => store,
    setState: (patch: Partial<typeof store> | ((value: typeof store) => Partial<typeof store>)) => Object.assign(store, typeof patch === 'function' ? patch(store) : patch),
  } };
});

import { forceRefreshProjectWorktreeCatalog, listProjectWorktrees } from './worktreeManager';
import { useSessionUIStore } from '@/sync/session-ui-store';

beforeEach(() => { state.runtime += 'A'; state.generation++; state.repository = '/repo'; state.fail = false;
  state.worktrees = [{ path: '/repo', branch: 'main' }]; state.requests = [];
});

test('a sibling force refresh bypasses the real HTTP TTL and enumerates the repository once per batch', async () => {
  const root = { id: 'root', path: '/repo' }; const src = { id: 'src', path: '/repo/src' };
  await listProjectWorktrees(root); await listProjectWorktrees(src);
  expect(state.requests.filter((url) => url.startsWith('/api/git/worktrees?'))).toHaveLength(1);
  state.worktrees = [...state.worktrees, { path: '/feature', branch: 'feature' }];
  const refreshBatch = {};
  const results = await Promise.all([forceRefreshProjectWorktreeCatalog(src, { refreshBatch }), forceRefreshProjectWorktreeCatalog(root, { refreshBatch })]);
  expect(results[0].worktrees.map((entry) => entry.path)).toEqual(['/feature/src']);
  expect(results[1].worktrees.map((entry) => entry.path)).toEqual(['/feature']);
  expect(state.requests.filter((url) => url.startsWith('/api/git/worktrees?'))).toHaveLength(2);
});

test('equal directory strings never reuse another runtime root or worktree list', async () => {
  const project = { id: 'root', path: '/repo' };
  await listProjectWorktrees(project);
  state.runtime = 'B'; state.generation++;
  state.repository = '/different'; state.worktrees = [{ path: '/different', branch: 'main' }, { path: '/feature-b', branch: 'b' }];
  const result = await forceRefreshProjectWorktreeCatalog(project);
  expect(result.repositoryDirectory).toBe('/different');
  expect(state.requests.filter((url) => url.startsWith('/api/git/primary-root?'))).toHaveLength(2);
  expect(state.requests.some((url) => url === '/api/git/worktrees?directory=%2Fdifferent')).toBe(true);
});

test('an HTTP enumeration failure preserves the previous scoped catalog', async () => {
  state.worktrees.push({ path: '/feature', branch: 'feature' });
  const project = { id: 'src', path: '/repo/src' };
  await forceRefreshProjectWorktreeCatalog(project);
  const before = useSessionUIStore.getState().availableWorktreesByProject.get(project.path);
  state.fail = true;
  await expect(forceRefreshProjectWorktreeCatalog(project)).rejects.toThrow('Failed to list worktrees');
  expect(useSessionUIStore.getState().availableWorktreesByProject.get(project.path)).toBe(before);
});

test('missing repository identity is a failure, not a guessed project-root identity', async () => {
  state.repository = '';
  await expect(forceRefreshProjectWorktreeCatalog({ id: 'src', path: '/repo/src' })).rejects.toThrow('Invalid git primary root response');
  expect(state.requests.filter((url) => url.startsWith('/api/git/worktrees?'))).toHaveLength(0);
});
