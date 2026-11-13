import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { MobileContextProgressButton } from './MobileContextProgressButton';
import { MobileChatScreen } from './MobileChatScreen';
import { HostRuntimeContext } from '@/contexts/hostRuntimeContext';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import { queryClient } from '@/lib/queryRuntime';
import { remoteMobileGitOptions } from './remoteMobileMetadataQueries';

const fixture = vi.hoisted(() => ({
  local: vi.fn(() => { throw new Error('Local state must not be read'); }),
  modelOptions: vi.fn(), modelSelection: vi.fn(), sessionId: 'same-id' as string | null, t: (key: string) => key,
  location: { hubId: 'hub', hostId: 'a', directory: 'C:\\raw path\\' },
  transcript: { messageOrder: ['message'], messagesByID: { message: { id: 'message', role: 'assistant', providerID: 'provider', modelID: 'model', tokens: { input: 120, output: 30 } } }, partsByMessageID: { message: [] } },
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.t }) }));
vi.mock('@/hooks/useRuntimeAPIs', () => ({ useRuntimeAPIs: fixture.local }));
vi.mock('@/stores/useDirectoryStore', () => ({ useDirectoryStore: fixture.local }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: fixture.local }));
vi.mock('@/sync/sync-context', () => ({ useCurrentSessionEntity: fixture.local, useSessionMessages: fixture.local, useSessionContextUsage: fixture.local, useSessionMessageLoadState: fixture.local, useSessionMaterializationStatus: fixture.local }));
vi.mock('@/components/gui-plugins/GuiPluginTitlebarItems', () => ({ GuiPluginTitlebarItems: () => null }));
vi.mock('@/stores/useGitStore', () => ({ useGitStore: fixture.local, useGitStatus: fixture.local, useIsGitRepo: fixture.local }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: fixture.local }));
vi.mock('@/stores/useQuotaStore', () => ({ useQuotaStore: fixture.local, useQuotaAutoRefresh: fixture.local }));
vi.mock('@/stores/useUIStore', () => ({ useUIStore: (select: (state: unknown) => unknown) => select({ timeFormatPreference: '24h' }) }));
vi.mock('@/sync/selection-store', () => ({ useSelectionStore: (select: (state: unknown) => unknown) => select({ getSessionModelSelection: (id: string) => { if (!id) throw new Error('Empty session identity'); fixture.modelSelection(id); return null; } }) }));
vi.mock('@/stores/useSessionNavigationStore', () => ({ useSessionNavigationStore: (select: (state: unknown) => unknown) => select({ remoteSession: { location: fixture.location, sessionId: fixture.sessionId } }) }));
vi.mock('@/sync/transcript-repository-runtime', () => ({
  subscribeTranscriptRepositoryBinding: () => () => {}, getTranscriptRepositoryBindingRevision: () => 0,
  getTranscriptRepository: () => ({ subscribe: () => () => {}, getTranscript: () => fixture.transcript }),
  transcriptScope: (location: unknown, sessionID: string) => ({ location, sessionID }),
}));
vi.mock('@/queries/configCatalogQueries', () => ({ providerCatalogQueryOptions: (directory: string, _transport: string, entry: { key: string }) => {
  fixture.modelOptions(directory, entry);
  return { queryKey: ['models', entry.key], staleTime: Infinity, queryFn: async () => ({ providers: [{ id: 'provider', models: { model: { limit: { context: 1000 } } } }] }) };
} }));
vi.mock('@/components/ui/ProviderLogo', () => ({ ProviderLogo: () => null }));
vi.mock('@/hooks/useProviderLogo', () => ({ preloadProviderLogos: () => {} }));
vi.mock('@/components/icon/Icon', () => ({ Icon: () => null }));
vi.mock('./ContextProgressIcon', () => ({ ContextProgressIcon: ({ percentage }: { percentage: number }) => <span data-percentage={percentage} /> }));

let root: Root, node: HTMLDivElement;
const flush = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); };
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient.clear(); vi.clearAllMocks(); fixture.location.hostId = 'a'; fixture.sessionId = 'same-id';
  node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); queryClient.clear(); node.remove(); });

function setup(fetch: (path: string) => Promise<Response>) {
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'transport', isCurrent: () => true, fetch, sdk: () => ({}) as OpenCodeClient });
  const entry = registry.resolve(fixture.location);
  const context = { entry, registry, demand: null, host: undefined, connectionError: null, reconnect: async () => {} } as unknown as NonNullable<React.ContextType<typeof HostRuntimeContext>>;
  return { entry, context, render: (open?: boolean) => <HostRuntimeContext.Provider value={context}><MobileContextProgressButton sessionId="" open={open} /></HostRuntimeContext.Provider> };
}

test('a remote new-session ring uses the scoped shared draft identity rather than an invalid empty session ID', async () => {
  fixture.sessionId = null;
  const fetch = vi.fn(async () => json({})); const view = setup(fetch);
  await act(async () => root.render(view.render(false)));
  expect(fixture.modelSelection).toHaveBeenCalledWith('remote-new-session');
  expect(fetch).not.toHaveBeenCalled(); expect(fixture.local).not.toHaveBeenCalled();
});

test('the real phone chat screen never mounts local entity, transcript-load or connection readers for a remote target', async () => {
  const fetch = vi.fn(async (_path: string) => json({})); const view = setup(fetch);
  await act(async () => root.render(<HostRuntimeContext.Provider value={view.context}><MobileChatScreen sessionId="same-id" directory={fixture.location.directory} onBack={() => {}} onOpenMenu={() => {}}><div>remote content</div></MobileChatScreen></HostRuntimeContext.Provider>));
  await flush();
  expect(node.textContent).toContain('remote content');
  expect(fixture.local).not.toHaveBeenCalled();
  expect(fetch.mock.calls.every(([path]) => path.endsWith('/summaries'))).toBe(true);
});

test('closed remote metadata does zero fetch or transcript recomputation over 50 parent updates', async () => {
  const fetch = vi.fn(async () => json({}));
  const view = setup(fetch);
  await act(async () => root.render(view.render(false)));
  await flush(); const calls = fixture.modelOptions.mock.calls.length;
  for (let index = 0; index < 50; index++) await act(async () => root.render(view.render(false)));
  expect(fetch).not.toHaveBeenCalled();
  expect(fixture.modelOptions).toHaveBeenCalledTimes(calls);
  expect(fixture.local).not.toHaveBeenCalled();
});

test('phone deep-link title observes authoritative scoped metadata with empty summaries, without fetching or borrowing another Host title', async () => {
  const fetch = vi.fn(async (_path: string) => json({ hostId: fixture.location.hostId, stale: false, directories: [], pinnedSessionIds: [] }));
  const a = setup(fetch);
  const render = (context: typeof a.context) => <HostRuntimeContext.Provider value={context}><MobileChatScreen sessionId="same-id" directory={fixture.location.directory} onBack={() => {}} onOpenMenu={() => {}}>content</MobileChatScreen></HostRuntimeContext.Provider>;
  await act(async () => root.render(render(a.context))); await flush();
  expect(node.textContent).toContain('mobile.sessions.untitled');
  const aKey = [...a.entry.queryScope, 'chat', 'same-id', 'session'];
  await act(async () => { queryClient.setQueryData(aKey, { id: 'same-id', title: 'Authoritative Host A' }); }); await flush();
  expect(node.textContent).toContain('Authoritative Host A');
  const calls = fetch.mock.calls.length;
  for (let index = 0; index < 50; index++) await act(async () => root.render(render(a.context)));
  expect(fetch).toHaveBeenCalledTimes(calls);
  expect(fetch.mock.calls.every(([path]) => path.endsWith('/summaries'))).toBe(true);
  fixture.location.hostId = 'b';
  const b = setup(fetch);
  await act(async () => root.render(render(b.context))); await flush();
  expect(node.textContent).not.toContain('Authoritative Host A');
  await act(async () => { queryClient.setQueryData([...b.entry.queryScope, 'chat', 'same-id', 'session'], { id: 'same-id', title: 'Authoritative Host B' }); }); await flush();
  expect(node.textContent).toContain('Authoritative Host B');
  await act(async () => { queryClient.setQueryData(aKey, { id: 'same-id', title: 'Late Host A' }); }); await flush();
  expect(node.textContent).not.toContain('Late Host A');
  expect(fixture.local).not.toHaveBeenCalled();
});

test('real metadata panel uses Host Git, quota settings and usage, while context observes remote transcript', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/api/git/check')) return json({ isGitRepository: true });
    if (path.endsWith('/api/git/status')) return json({ current: 'remote-branch' });
    if (path.endsWith('/api/config/settings')) return json({ usageDropdownProviders: ['codex'], usageDisplayMode: 'remaining' });
    if (path.endsWith('/api/quota/codex')) return json({ providerId: 'codex', providerName: 'Codex', configured: true, ok: true, usage: { windows: {} } });
    throw new Error(`Unexpected request ${path}`);
  });
  const view = setup(fetch);
  await act(async () => root.render(view.render(true))); await flush(); await flush();
  expect(node.textContent).toContain('remote-branch');
  expect(node.textContent).toContain('150/1.0K');
  expect(node.textContent).toContain('header.services.remaining');
  expect(fetch.mock.calls.map(([path]) => path)).toEqual(expect.arrayContaining(['/api/hosts/a/api/git/check', '/api/hosts/a/api/git/status', '/api/hosts/a/api/config/settings', '/api/hosts/a/api/quota/codex']));
  expect(fixture.local).not.toHaveBeenCalled();
  expect(fixture.modelOptions).toHaveBeenCalledWith(fixture.location.directory, view.entry);
  expect(fetch).toHaveBeenCalledWith('/api/hosts/a/api/git/check', expect.objectContaining({ query: { directory: fixture.location.directory }, signal: expect.any(AbortSignal) }));
});

test('Magpie quotas are discovered on the selected Host rather than falling back to Hub quotas', async () => {
  const fetch = vi.fn(async (path: string) => {
    if (path.endsWith('/api/git/check')) return json({ isGitRepository: false });
    if (path.endsWith('/api/config/settings')) return json({ usageDropdownProviders: ['magpie:source:codex'] });
    if (path.endsWith('/api/quota/magpie')) return json({ sources: [{ id: 'source', name: 'Remote source', results: [{ providerId: 'magpie:source:codex', providerName: 'Remote Codex', source: 'magpie', sourceId: 'source', configured: true, ok: true, usage: { windows: {} } }] }] });
    throw new Error(`Unexpected request ${path}`);
  });
  const view = setup(fetch);
  await act(async () => root.render(view.render(true))); await flush(); await flush();
  expect(node.textContent).toContain('Remote Codex');
  expect(fetch).toHaveBeenCalledWith('/api/hosts/a/api/quota/magpie', expect.objectContaining({ query: { directory: fixture.location.directory } }));
  expect(fixture.local).not.toHaveBeenCalled();
});

test('failed refresh preserves remote branch and shows a retry; same-path other Host does not inherit it', async () => {
  let fail = false;
  const fetch = vi.fn(async (path: string) => {
    if (fail) return json({ error: 'Host disconnected' }, 503);
    if (path.endsWith('/check')) return json({ isGitRepository: true });
    if (path.endsWith('/status')) return json({ current: 'branch-a' });
    return json({ usageDropdownProviders: [] });
  });
  const a = setup(fetch);
  await act(async () => root.render(a.render(true))); await flush();
  fail = true;
  await act(async () => { await queryClient.fetchQuery({ ...remoteMobileGitOptions(a.entry), staleTime: 0 }).catch(() => {}); }); await flush();
  expect(node.textContent).toContain('branch-a'); expect(node.querySelector('[role="alert"]')?.textContent).toContain('Host disconnected');
  fixture.location.hostId = 'b'; const b = setup(fetch);
  await act(async () => root.render(b.render(true))); await flush();
  expect(node.textContent).not.toContain('branch-a'); expect(fetch.mock.calls.some(([path]) => path.startsWith('/api/hosts/b/'))).toBe(true);
  expect(fixture.local).not.toHaveBeenCalled();
});
