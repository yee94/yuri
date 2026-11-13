import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { NewWorktreeDialog } from './NewWorktreeDialog';
import { HostRuntimeContext } from '@/contexts/hostRuntimeContext';
import { HostRuntimeRegistry, type HostRuntimeDependencies } from '@/lib/remote-projects/registry';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { queryClient } from '@/lib/queryRuntime';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { useGitStore } from '@/stores/useGitStore';
import type { ProjectEntry } from '@/lib/api/types';
import { createWorktreeGitHubReads, renderRemoteWorktreePrompt, sendRemoteWorktreeContext } from './worktreeDialogRemote';

const mock = vi.hoisted(() => ({
  create: vi.fn(async () => ({ path: '/remote/checkouts/feature', branch: 'feature' })),
  local: vi.fn(() => { throw new Error('Hub API must not be used'); }),
  close: vi.fn(), complete: vi.fn(),
  t: (key: string) => key,
}));
vi.mock('@/lib/remote-projects/worktree-draft', () => ({ createRemoteWorktreeDraft: mock.create }));
vi.mock('@/lib/persistence', () => ({ updateDesktopSettings: vi.fn(async () => {}) }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: () => ({ git: new Proxy({}, { get: () => mock.local }), github: { authStatus: mock.local } }) }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: mock.t }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children, open }: { children: React.ReactNode; open: boolean }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>, DialogFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const project: ProjectEntry = { id: 'remote-reference', path: '/remote/root', hostId: 'host', hubId: 'hub' };
let root: Root, node: HTMLDivElement;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); }); };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); queryClient.clear(); queryClient.setDefaultOptions({ queries: { retry: false } });
  useProjectsStore.setState({ projects: [project], activeProjectId: project.id });
  useGitStore.setState({ directories: new Map() });
  useSessionNavigationStore.getState().clearRemoteSession();
  mock.create.mockImplementation(async () => {
    useSessionNavigationStore.getState().openRemoteSession(project, { hubId: 'hub', hostId: 'host', directory: '/remote/checkouts/feature' }, null, { title: 'retained worktree draft', bootstrapWaitEnabled: false });
    return { path: '/remote/checkouts/feature', branch: 'feature' };
  });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); queryClient.clear(); });

function setup(fetch: HostRuntimeDependencies['fetch']) {
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch, sdk: () => ({}) as ReturnType<HostRuntimeDependencies['sdk']> });
  registry.applyCatalog({ hubId: 'hub', supported: true, projects: [], hosts: [{ id: 'host', name: 'Host', state: 'connected', source: 'direct' }] });
  const entry = registry.resolve({ hubId: 'hub', hostId: 'host', directory: project.path });
  const context = { entry, registry, demand: null } as unknown as NonNullable<React.ContextType<typeof HostRuntimeContext>>;
  return { entry, registry, render: () => <QueryClientProvider client={queryClient}><HostRuntimeContext.Provider value={context}><NewWorktreeDialog open projectId={project.id} onOpenChange={mock.close} onWorktreeCreated={mock.complete} /></HostRuntimeContext.Provider></QueryClientProvider> };
}

test('the mounted shared new-branch form loads/validates against Host and invokes the real remote creator boundary, not Hub actions', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/auth/status')) return json({ connected: true });
    if (path.endsWith('/branches')) return json({ current: 'main', all: ['main'], branches: {} });
    if (path.endsWith('/status')) return json({ current: 'main', files: [] });
    if (path.endsWith('/worktrees')) return json([{ path: project.path, name: 'root' }]);
    if (path.endsWith('/validate')) return json({ ok: true, errors: [] });
    throw new Error(`Unexpected request: ${path}`);
  });
  const view = setup(fetch);
  await act(async () => root.render(view.render())); await flush(); await flush();
  const create = [...node.querySelectorAll('button')].find((button) => button.textContent === 'session.newWorktree.actions.createWorktree')!;
  expect(create).toBeTruthy(); expect(create.disabled).toBe(false);
  await act(async () => create.click()); await flush();
  expect(mock.create).toHaveBeenCalledWith(project, expect.objectContaining({ mode: 'new', worktreeName: expect.any(String), branchName: expect.any(String), startRef: 'main' }), expect.objectContaining({ createSession: false, isSelected: expect.any(Function) }));
  expect(mock.complete).toHaveBeenCalledWith('/remote/checkouts/feature', { remote: true });
  expect(mock.close).toHaveBeenCalledWith(false);
  expect(fetch.mock.calls.every(([path]) => path.startsWith('/api/hosts/host/'))).toBe(true);
  expect(mock.local).not.toHaveBeenCalled();
  expect(useSessionNavigationStore.getState().remoteSession?.draft?.title).toBe('retained worktree draft');
});

test('GitHub read adapter preserves raw cwd, paging, source repo and PR flags, with no machine auth mutations', async () => {
  const fetch = vi.fn(async () => json({})); const { entry } = setup(fetch);
  const github = createWorktreeGitHubReads(entry);
  const cwd = 'D:\\Raw checkout\\'; const sourceRepo = { owner: 'owner', repo: 'repository' };
  await github.issuesList(cwd, { page: 3, query: 'bug label:test' });
  await github.prsList(cwd, { page: 2, query: 'review' });
  await github.issueGet(cwd, 42, { sourceRepo }); await github.issueComments(cwd, 42, { sourceRepo });
  await github.prContext(cwd, 8, { sourceRepo, includeDiff: true, includeCheckDetails: true });
  expect(fetch).toHaveBeenCalledWith('/api/hosts/host/api/github/issues/list', expect.objectContaining({ query: { directory: cwd, page: 3, query: 'bug label:test' } }));
  expect(fetch).toHaveBeenCalledWith('/api/hosts/host/api/github/pulls/context', expect.objectContaining({ query: { directory: cwd, number: 8, owner: 'owner', repo: 'repository', diff: '1', checkDetails: '1' } }));
  expect(Object.keys(github)).not.toContain('authStart'); expect(mock.local).not.toHaveBeenCalled();
});

test('linked prompt templates read Host overrides and never fetch Hub templates', async () => {
  const fetch = vi.fn(async () => json({ version: 1, overrides: { 'github.issue.review.visible': 'Host issue {{ issue_number }}' } }));
  const { entry } = setup(fetch);
  expect(await renderRemoteWorktreePrompt(entry, 'github.issue.review.visible', { issue_number: '42' })).toBe('Host issue 42');
  expect(fetch).toHaveBeenCalledWith('/api/hosts/host/api/magic-prompts', undefined);
});

test('failed Host auth refresh retains its last snapshot and form, exposes the failure, and retries without Hub fallback', async () => {
  let fail = false;
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/auth/status')) return fail ? json({ error: 'Host auth unavailable' }, 503) : json({ connected: true });
    if (path.endsWith('/branches')) return json({ current: 'main', all: ['main'], branches: {} });
    if (path.endsWith('/status')) return json({ current: 'main', files: [] });
    return json([]);
  });
  const view = setup(fetch);
  await act(async () => root.render(view.render())); await flush(); await flush();
  const key = [...view.entry.queryScope, 'worktree-dialog', 'github-auth'];
  fail = true;
  await act(async () => { await queryClient.refetchQueries({ queryKey: key }); }); await flush();
  expect(queryClient.getQueryData(key)).toMatchObject({ connected: true });
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('Host auth unavailable');
  expect(node.querySelectorAll('input').length).toBeGreaterThan(0);
  fail = false;
  await act(async () => [...node.querySelectorAll('button')].find((button) => button.textContent === 'remoteProjects.retry')!.click()); await flush();
  expect(node.querySelector('[role="alert"]')).toBeNull();
  expect(mock.local).not.toHaveBeenCalled();
});

test('failed worktree creation retains the mature form and draft input for retry instead of closing or invoking local completion', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/auth/status')) return json({ connected: false });
    if (path.endsWith('/branches')) return json({ current: 'main', all: ['main'], branches: {} });
    if (path.endsWith('/status')) return json({ current: 'main', files: [] });
    if (path.endsWith('/worktrees')) return json([]);
    return json({ ok: true, errors: [] });
  });
  const view = setup(fetch); mock.create.mockRejectedValueOnce(new Error('Host checkout failed'));
  await act(async () => root.render(view.render())); await flush(); await flush();
  const values = [...node.querySelectorAll('input')].map((input) => input.value);
  const create = () => [...node.querySelectorAll('button')].find((button) => button.textContent === 'session.newWorktree.actions.createWorktree')!;
  await act(async () => create().click()); await flush();
  expect(mock.close).not.toHaveBeenCalled(); expect(mock.complete).not.toHaveBeenCalled();
  expect([...node.querySelectorAll('input')].map((input) => input.value)).toEqual(values);
  expect(create().disabled).toBe(false);
  await act(async () => create().click()); await flush();
  expect(mock.create).toHaveBeenCalledTimes(2); expect(mock.complete).toHaveBeenCalledWith('/remote/checkouts/feature', { remote: true });
  expect(mock.local).not.toHaveBeenCalled();
});

test('existing-branch picker preserves the mature selection and remote validation before creating on the Host', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/auth/status')) return json({ connected: false });
    if (path.endsWith('/branches')) return json({ current: 'main', all: ['main', 'feature-existing'], branches: {} });
    if (path.endsWith('/status')) return json({ current: 'main', files: [] });
    if (path.endsWith('/worktrees')) return json([]);
    return json({ ok: true, errors: [] });
  });
  const view = setup(fetch);
  await act(async () => root.render(view.render())); await flush(); await flush();
  const button = (label: string) => [...node.querySelectorAll('button')].find((item) => item.textContent === label)!;
  await act(async () => button('session.newWorktree.mode.existingBranch').click());
  await act(async () => button('session.newWorktree.chooseBranch').click()); await flush();
  const option = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent === 'feature-existing');
  await act(async () => { await vi.waitFor(() => expect(option()).toBeTruthy()); });
  await act(async () => option()!.click());
  await act(async () => { await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/hosts/host/api/git/worktrees/validate', expect.objectContaining({ body: expect.stringContaining('feature-existing') }))); });
  await act(async () => button('session.newWorktree.actions.createWorktree').click()); await flush();
  expect(mock.create).toHaveBeenCalledWith(project, expect.objectContaining({ mode: 'existing', existingBranch: 'feature-existing', worktreeName: 'feature-existing' }), expect.objectContaining({ createSession: false }));
  expect(mock.local).not.toHaveBeenCalled();
});

test('late creation does not invoke a completion callback that could replace a newer remote selection', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/auth/status')) return json({ connected: false });
    if (path.endsWith('/branches')) return json({ current: 'main', all: ['main'], branches: {} });
    if (path.endsWith('/status')) return json({ current: 'main', files: [] });
    if (path.endsWith('/worktrees')) return json([]);
    return json({ ok: true, errors: [] });
  });
  mock.create.mockImplementationOnce(async () => {
    useSessionNavigationStore.getState().openRemoteSession(project, { hubId: 'hub', hostId: 'host', directory: project.path }, 'ses_newer');
    return { path: '/remote/checkouts/feature', branch: 'feature' };
  });
  const view = setup(fetch);
  await act(async () => root.render(view.render())); await flush(); await flush();
  await act(async () => [...node.querySelectorAll('button')].find((button) => button.textContent === 'session.newWorktree.actions.createWorktree')!.click()); await flush();
  expect(mock.complete).not.toHaveBeenCalled();
  expect(useSessionNavigationStore.getState().remoteSession?.sessionId).toBe('ses_newer');
});

test('the same shared GitHub picker stays on the explicit Host and returns a linked issue into the worktree form', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/auth/status')) return json({ connected: true });
    if (path.endsWith('/branches')) return json({ current: 'main', all: ['main'], branches: {} });
    if (path.endsWith('/status')) return json({ current: 'main', files: [] });
    if (path.endsWith('/worktrees')) return json([]);
    if (path.endsWith('/issues/list')) return json({ connected: true, repo: { owner: 'owner', repo: 'repo' }, issues: [{ number: 42, title: 'Host issue' }], hasMore: false });
    return json({ ok: true, errors: [] });
  });
  const view = setup(fetch);
  await act(async () => root.render(view.render())); await flush(); await flush();
  const button = (label: string) => [...node.querySelectorAll('button')].find((item) => item.textContent === label)!;
  await act(async () => button('session.newWorktree.actions.startFromGitHubIssuePr').click()); await flush(); await flush();
  const issue = [...node.querySelectorAll('button')].find((item) => item.textContent?.includes('Host issue'))!;
  expect(issue).toBeTruthy();
  await act(async () => issue.click());
  await act(async () => button('session.githubIntegration.actions.select').click()); await flush();
  await act(async () => button('session.newWorktree.actions.createWorktree').click()); await flush();
  expect(mock.create).toHaveBeenCalledWith(project, expect.objectContaining({ mode: 'new', branchName: expect.stringContaining('issue-42-') }), expect.objectContaining({ title: '#42 Host issue', createSession: true }));
  expect(fetch.mock.calls.every(([path]) => path.startsWith('/api/hosts/host/'))).toBe(true);
  expect(mock.local).not.toHaveBeenCalled();
});

test('linked issue and PR context reach the native Host prompt endpoint in the created raw worktree cwd', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/magic-prompts')) return json({ overrides: {} });
    if (path.endsWith('/issues/get')) return json({ connected: true, repo: { owner: 'o', repo: 'r' }, issue: { number: 42, title: 'Host issue' } });
    if (path.endsWith('/issues/comments')) return json({ connected: true, comments: [{ body: 'Host-only comment' }] });
    if (path.endsWith('/pulls/context')) return json({ connected: true, repo: { owner: 'o', repo: 'r' }, pr: { number: 8 }, diff: 'Host-only diff' });
    if (path.endsWith('/prompt')) return json({ id: 'inbox', sessionID: 'ses_remote', type: 'user', delivery: 'steer', payload: { text: 'admitted' } });
    throw new Error(`Unexpected: ${path}`);
  });
  const { entry, registry } = setup(fetch);
  const issue = { number: 42, title: 'Host issue' } as NonNullable<Parameters<typeof sendRemoteWorktreeContext>[4]['issue']>;
  const pr = { number: 8 } as NonNullable<Parameters<typeof sendRemoteWorktreeContext>[4]['pr']>;
  await sendRemoteWorktreeContext(registry, entry, 'D:\\raw checkout\\src', 'ses_remote', { issue, pr: null, includeDiff: false }, 'context failed');
  expect(fetch).toHaveBeenCalledWith('/api/hosts/host/api/session/ses_remote/prompt', expect.objectContaining({ method: 'POST', query: { directory: 'D:\\raw checkout\\src' }, body: expect.stringContaining('Host-only comment') }));
  await sendRemoteWorktreeContext(registry, entry, 'D:\\raw checkout\\src', 'ses_remote', { issue: null, pr, includeDiff: true }, 'context failed');
  expect(fetch).toHaveBeenCalledWith('/api/hosts/host/api/session/ses_remote/prompt', expect.objectContaining({ body: expect.stringContaining('Host-only diff') }));
  expect(mock.local).not.toHaveBeenCalled();
});
