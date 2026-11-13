import { beforeEach, expect, test, vi } from 'vitest';
import { useGitStore } from '@/stores/useGitStore';
import { createProjectGitStoreProjection } from './useProjectGitStore';
import { createProjectGitAPI } from '@/lib/gitApiProject';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { queryClient } from '@/lib/queryRuntime';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { createProjectFilesAPI } from './project-files';

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => { useGitStore.setState({ directories: new Map(), activeDirectory: null }); queryClient.clear(); });

test('the production Git store adapter isolates equal directories and sends raw paths for status/branches/diffs', async () => {
  const directory = 'C:\\work\\same project';
  const fetch = vi.fn(async (route: string, _options?: RuntimeFetchOptions) => {
    const branch = route.includes('/hosts/a/') ? 'branch-a' : 'branch-b';
    if (route.endsWith('/check')) return json({ isGitRepository: true });
    if (route.endsWith('/status')) return json({ files: [], current: branch, ahead: 0, behind: 0 });
    if (route.endsWith('/branches')) return json({ current: branch, all: [branch], branches: {} });
    return json({ original: '', modified: branch });
  });
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch,
    sdk: () => opencodeClient.getSdkClient(), service: () => { throw new Error('Service not used'); } });
  const a = registry.resolve({ hubId: 'hub', hostId: 'a', directory });
  const b = registry.resolve({ hubId: 'hub', hostId: 'b', directory });
  const projectA = createProjectGitStoreProjection(a);
  const projectB = createProjectGitStoreProjection(b);
  await Promise.all([
    projectA(useGitStore.getState()).fetchStatus(directory, createProjectGitAPI(a)),
    projectB(useGitStore.getState()).fetchStatus(directory, createProjectGitAPI(b)),
  ]);
  await projectA(useGitStore.getState()).fetchBranches(directory, createProjectGitAPI(a));
  const stateA = projectA(useGitStore.getState());
  const stateB = projectB(useGitStore.getState());
  expect(stateA.directories.get(directory)?.status?.current).toBe('branch-a');
  expect(stateB.directories.get(directory)?.status?.current).toBe('branch-b');
  expect(stateA.directories.get(directory)?.branches?.current).toBe('branch-a');
  stateA.setDiff(directory, 'file.ts', { original: '', modified: 'A' });
  expect(projectB(useGitStore.getState()).getDiff(directory, 'file.ts')).toBeNull();
  expect(useGitStore.getState().directories.has(directory)).toBe(false);
  for (const [, options] of fetch.mock.calls) expect(options?.query).toEqual(expect.objectContaining({ directory }));
  const next = projectA(useGitStore.getState());
  expect(next.fetchStatus).toBe(stateA.fetchStatus);
  expect(projectA(useGitStore.getState())).toBe(next);
});

test('hunk, stash, history, merge and worktree mutations use the Host wire, configuration writes are rejected', async () => {
  const fetch = vi.fn(async (_route: string, _options?: RuntimeFetchOptions) => json({ success: true }));
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch,
    sdk: () => opencodeClient.getSdkClient(), service: () => { throw new Error('Service not used'); } });
  const git = createProjectGitAPI(registry.resolve({ hubId: 'hub', hostId: 'a', directory: '/raw' }));
  await git.revertGitHunk!('/raw', 'file.ts', 'patch');
  await git.popGitStash('/raw', { ref: 'stash@{1}' });
  await git.cherryPick('/raw', 'abc');
  await git.merge('/raw', { branch: 'feature' });
  await git.deleteGitWorktree!('/raw', { directory: '/raw-worktree' });
  expect(fetch.mock.calls.map(([route]) => route)).toEqual([
    '/api/hosts/a/api/git/apply-hunk', '/api/hosts/a/api/git/stash/pop', '/api/hosts/a/api/git/cherry-pick',
    '/api/hosts/a/api/git/merge', '/api/hosts/a/api/git/worktrees',
  ]);
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ path: 'file.ts', patch: 'patch', action: 'discard' });
  await expect(git.createGitIdentity({ id: 'x', name: 'x', userName: 'x', userEmail: 'x@example.invalid' })).rejects.toThrow('read-only');
  expect(fetch).toHaveBeenCalledTimes(5);
});

test('captured production Files/Git adapters survive wire admission but reject bodies completed after logical scope revocation', async () => {
  const bodies: Array<() => void> = [];
  const fetch = vi.fn(async (route: string) => new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      bodies.push(() => {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(route.endsWith('/list')
          ? { path: '/raw', entries: [] } : { current: 'kept', files: [] })));
        controller.close();
      });
    },
  }), { headers: { 'Content-Type': 'application/json' } }));
  const registry = new HostRuntimeRegistry('scope-consumers', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch,
    sdk: () => opencodeClient.getSdkClient() });
  const host = { id: 'a', name: 'A', source: 'direct' as const, state: 'idle' as const, scopeGeneration: 'scope-a' };
  registry.applyCatalog({ hubId: registry.hubId, supported: true, hosts: [host], projects: [] });
  const entry = registry.resolve({ hubId: registry.hubId, hostId: host.id, directory: '/raw' });
  const git = createProjectGitAPI(entry);
  const files = createProjectFilesAPI(entry);
  try {
    const gitRead = git.getGitStatus('/raw');
    const filesRead = files.listDirectory('/raw');
    await vi.waitFor(() => expect(bodies).toHaveLength(2));
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: registry.hubId, hostId: host.id,
      host: { ...host, state: 'connecting', generation: 'wire-a', lastConnectedAt: 1 } } });
    bodies[0](); bodies[1]();
    await expect(gitRead).resolves.toMatchObject({ current: 'kept' });
    await expect(filesRead).resolves.toMatchObject({ entries: [] });
    expect(registry.resolve(entry.location)).toBe(entry);
    const lateGit = git.getGitStatus('/raw');
    const lateFiles = files.listDirectory('/raw');
    const gitRejected = expect(lateGit).rejects.toThrow('connection changed');
    const filesRejected = expect(lateFiles).rejects.toThrow('connection changed');
    await vi.waitFor(() => expect(bodies).toHaveLength(4));
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: registry.hubId, hostId: host.id,
      host: { ...host, scopeGeneration: 'scope-b', generation: 'wire-b' } } });
    bodies[2](); bodies[3]();
    await Promise.all([gitRejected, filesRejected]);
    const count = fetch.mock.calls.length;
    await expect(git.getGitStatus('/raw')).rejects.toThrow('connection changed');
    await expect(files.listDirectory('/raw')).rejects.toThrow('connection changed');
    expect(fetch).toHaveBeenCalledTimes(count);
  } finally { registry.dispose(); }
});
