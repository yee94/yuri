import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { useRemoteMobileSession, type RemoteMobileSession } from './remoteMobileSession';
import { RemoteMobileHeader } from './remoteMobileHeader';
import { getRemoteChatOwner } from '@/sync/remote-chat-context';

const fixture = vi.hoisted(() => ({
  project: { id: 'project', hubId: 'hub', hostId: 'a' as string | undefined, path: 'C:\\raw\\workspace', label: 'Remote project' },
  registry: undefined as unknown, localRead: vi.fn(), summaries: [] as unknown[],
  supported: true,
}));
vi.mock('@/stores/useProjectsStore', () => ({ useProjectsStore: (select: (state: unknown) => unknown) => select({ projects: [fixture.project], activeProjectId: 'project' }) }));
vi.mock('@/queries/remoteProjectQueries', () => ({
  useRemoteProjectRuntime: (enabled: boolean) => ({ registry: enabled ? fixture.registry : undefined }),
  getHostRuntimeRegistry: () => fixture.registry,
  supportsRemoteProjects: () => fixture.supported,
  useRemoteHostSummaries: () => ({ data: { directories: fixture.summaries } }),
}));
vi.mock('@/sync/sync-context', () => ({
  useSessionMessages: () => { fixture.localRead(); throw new Error('Hub messages read'); },
  useSessionContextUsage: () => { fixture.localRead(); throw new Error('Hub usage read'); },
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('@/hooks/useProviderLogo', () => ({ preloadProviderLogos: () => {} }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: Object.assign((select: (state: unknown) => unknown) => select({ currentDirectory: '/retained-hub' }), { getState: () => ({ currentDirectory: '/retained-hub' }), subscribe: () => () => {} }) }));

let root: Root, node: HTMLDivElement, client: QueryClient, scope: RemoteMobileSession;
let registry: HostRuntimeRegistry;
const fetch = vi.fn(async (_path: string) => new Response(JSON.stringify([{ name: 'Remote MCP' }]), { headers: { 'content-type': 'application/json' } }));
const listMcp = vi.fn(async () => ({ data: [{ name: 'Remote MCP', status: { status: 'connected' } }] }));
function Surface({ tick = 0 }: { tick?: number }) {
  scope = useRemoteMobileSession();
  return <div data-tick={tick}>
    {scope.enabled ? <RemoteMobileHeader scope={scope} menuOpen={false} onOpenSessions={() => {}} onToggleMenu={() => {}} /> : 'Local'}
    <button data-refresh onClick={() => void scope.refresh()}>Refresh</button>
    <button data-new onClick={() => scope.openSession(null)}>New</button>
    <button data-parent onClick={() => scope.openSession(scope.session?.parentID ?? '')}>Parent</button>
  </div>;
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.clearAllMocks(); fixture.project.hostId = 'a'; fixture.supported = true;
  registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch,
    sdk: () => ({ mcp: { list: listMcp } }) as unknown as OpenCodeClient });
  for (const id of ['a', 'b']) registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: id, host: { id, name: id, source: 'direct', state: 'connected' } } });
  fixture.registry = registry;
  fixture.summaries = [{ directory: fixture.project.path, sessions: [{ id: 'same', title: 'REMOTE TITLE', parentID: 'parent', directory: fixture.project.path }] }];
  useSessionNavigationStore.getState().openRemoteSession({ ...fixture.project, hostId: 'a' }, { hubId: 'hub', hostId: 'a', directory: fixture.project.path }, 'same');
  client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); client.clear(); registry.dispose(); node.remove(); vi.restoreAllMocks(); });
const render = async (tick = 0) => { await act(async () => root.render(<QueryClientProvider client={client}><Surface tick={tick} /></QueryClientProvider>)); };

it('mounts the real mobile metadata boundary with the same remote owner, raw cwd and no Hub reads', async () => {
  await render();
  expect(node.textContent).toContain('REMOTE TITLE');
  expect(scope.owner).toBe(getRemoteChatOwner(registry, registry.resolve(scope.entry!.location)));
  expect(scope.entry!.location.directory).toBe(fixture.project.path);
  expect(fixture.localRead).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
  for (let tick = 0; tick < 50; tick++) await render(tick);
  expect(fetch).not.toHaveBeenCalled();
  expect(fixture.localRead).not.toHaveBeenCalled();
});

it('refresh, parent return and new draft use the explicit remote owner without replacing the Hub selection', async () => {
  await render();
  const refresh = vi.spyOn(scope.owner!.state.repository, 'refreshFromAuthority').mockResolvedValue(scope.owner!.state.repository.getTranscript(scope.owner!.state.scope('same')));
  await act(async () => node.querySelector<HTMLButtonElement>('[data-refresh]')!.click());
  expect(refresh).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'same', directory: fixture.project.path, location: { hubId: 'hub', hostId: 'a', directory: fixture.project.path } }));
  await act(async () => node.querySelector<HTMLButtonElement>('[data-parent]')!.click());
  expect(useSessionNavigationStore.getState().remoteSession?.sessionId).toBe('parent');
  await act(async () => node.querySelector<HTMLButtonElement>('[data-new]')!.click());
  expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ sessionId: null, location: { hostId: 'a', directory: fixture.project.path } });
  expect(fixture.localRead).not.toHaveBeenCalled();
});

it('same raw ID/path on another Host cannot reuse the old owner or accept the old summary title', async () => {
  await render(); const previous = scope.owner;
  fixture.project.hostId = 'b'; fixture.summaries = [];
  await act(async () => useSessionNavigationStore.getState().openRemoteSession({ ...fixture.project, hostId: 'b' }, { hubId: 'hub', hostId: 'b', directory: fixture.project.path }, 'same'));
  await render();
  expect(scope.owner).not.toBe(previous);
  expect(scope.entry?.location.hostId).toBe('b');
  expect(node.textContent).not.toContain('REMOTE TITLE');
  expect(fetch).not.toHaveBeenCalled();
});

it('local-only mounted shell creates no registry/state/request work across 50 parent updates', async () => {
  fixture.project.hostId = undefined;
  const resolve = vi.spyOn(registry, 'resolve');
  for (let tick = 0; tick < 50; tick++) await render(tick);
  expect(scope.owner).toBeUndefined(); expect(resolve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

it('unsupported mobile web does not connect a cached remote reference through the fallback registry', async () => {
  fixture.supported = false; const resolve = vi.spyOn(registry, 'resolve');
  await render();
  expect(node.textContent).toContain('remoteProjects.unsupported');
  expect(scope.owner).toBeUndefined(); expect(resolve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});
