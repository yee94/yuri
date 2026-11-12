import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ContextPanelContent } from './ContextSidebarTab';
import { HostRuntimeContext, type HostRuntimeContextValue } from '@/contexts/hostRuntimeContext';
import { locationKey } from '@/lib/remote-projects/location';
import { useUIStore } from '@/stores/useUIStore';

const fixture = vi.hoisted(() => ({
  hostId: 'host-a', t: (key: string) => key, local: vi.fn(), config: vi.fn(), summary: vi.fn(), demand: vi.fn(), refresh: vi.fn(),
  subscribe: vi.fn(),
  onError: null as null | ((error: unknown) => void),
  data: { messageOrder: ['user', 'assistant'], messagesByID: {
    user: { id: 'user', sessionID: 'same-session', role: 'user', time: { created: 1000 } },
    assistant: { id: 'assistant', sessionID: 'same-session', role: 'assistant', providerID: 'remote-provider', modelID: 'remote-model', time: { created: 2000 }, tokens: { input: 120, output: 30, reasoning: 0, cache: { read: 50, write: 0 } } },
  }, partsByMessageID: { user: [{ id: 'user-part', type: 'text', text: 'Remote user prompt' }], assistant: [{ id: 'assistant-part', type: 'text', text: 'Remote answer bytes' }] } },
}));
vi.mock('@/contexts/HostRuntimeProvider', async () => {
  const { useHostRuntime } = await import('@/contexts/hostRuntimeHooks');
  return { useHostRuntime, useRemoteSessionDemand: (id: string | null, _refresh: () => Promise<void>, error: (error: unknown) => void) => { fixture.demand(id); fixture.onError = error; } };
});
vi.mock('@/sync/transcript-repository-runtime', () => ({
  subscribeTranscriptRepositoryBinding: () => () => {}, getTranscriptRepositoryBindingRevision: () => 0,
  getTranscriptRepository: () => ({ subscribe: () => { fixture.subscribe(); return () => {}; }, getTranscript: () => fixture.data, refreshFromAuthority: fixture.refresh }),
  transcriptScope: (location: unknown, sessionID: string) => ({ location, sessionID }),
  refreshTranscriptFromAuthority: (...args: unknown[]) => fixture.refresh(...args),
}));
vi.mock('@/stores/useSessionNavigationStore', () => ({ useSessionNavigationStore: (select: (state: unknown) => unknown) => select({ remoteSession: { projectId: 'project', sessionId: 'same-session', location: { hubId: 'https://hub.example', hostId: fixture.hostId, directory: '/workspace' } } }) }));
vi.mock('@/queries/remoteProjectQueries', () => ({ useRemoteHostSummaries: (_registry: unknown, id: string) => { fixture.summary(id); return { data: { directories: [{ directory: '/workspace', sessions: [{ id: 'same-session', title: `REMOTE ${id}`, time: { created: 1000 } }] }] }, refetch: async () => {} }; } }));
vi.mock('@/queries/configCatalogQueries', () => ({ providerCatalogQueryOptions: (directory: string, _transport: string, entry: unknown) => { fixture.config(directory, entry); return { queryKey: ['remote-context'] }; } }));
vi.mock('@tanstack/react-query', async (original) => ({ ...await original<typeof import('@tanstack/react-query')>(), useQuery: () => ({ data: { providers: [{ id: 'remote-provider', name: 'Remote Provider', models: { 'remote-model': { id: 'remote-model', name: 'Remote Model', limit: { context: 1000 } } } }] }, error: null, refetch: async () => {} }) }));
vi.mock('@/sync/session-ui-store', () => ({ useSessionUIStore: () => { fixture.local(); throw new Error('Remote overview must not read the local session'); } }));
vi.mock('@/sync/sync-context', () => ({ useSessions: () => { fixture.local(); return []; }, useSessionMessageRecords: () => { fixture.local(); return []; } }));
vi.mock('@/stores/useConfigStore', () => ({ useConfigStore: () => { fixture.local(); return []; } }));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: fixture.t }), getCurrentIntlLocale: () => 'en-US' }));
vi.mock('@/components/code/WorkerHighlightedCode', () => ({ WorkerHighlightedCode: ({ code }: { code: string }) => <pre>{code}</pre> }));

let root: Root, node: HTMLDivElement;
const makeScope = (hostId: string): HostRuntimeContextValue => {
  const location = { hubId: 'https://hub.example', hostId, directory: '/workspace' };
  return { entry: { location, key: locationKey(location), sdk: () => ({}) }, registry: {} } as unknown as HostRuntimeContextValue;
};
const render = async (scope: HostRuntimeContextValue) => { await act(async () => root.render(<HostRuntimeContext.Provider value={scope}><ContextPanelContent /></HostRuntimeContext.Provider>)); };
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); vi.clearAllMocks(); fixture.hostId = 'host-a'; fixture.refresh.mockResolvedValue(undefined);
  useUIStore.setState({ showAssistantTps: false }); node = document.createElement('div'); document.body.append(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); });

it('keeps the complete real context statistics and expandable raw messages on explicit Host data', async () => {
  const scope = makeScope('host-a'); await render(scope);
  expect(node.textContent).toContain('REMOTE host-a');
  expect(node.textContent).toContain('Remote Provider / Remote Model');
  expect(node.textContent).toContain('Remote user prompt');
  expect(fixture.config).toHaveBeenCalledWith('/workspace', scope.entry);
  expect(fixture.demand).toHaveBeenCalledWith('same-session');
  const raw = node.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
  await act(async () => raw.click());
  expect(node.querySelector('pre')?.textContent).toContain('Remote answer bytes');
  expect(node.querySelector('[aria-label="contextSidebar.actions.copyJson"]')).not.toBeNull();
  expect(fixture.local).not.toHaveBeenCalled();
});

it('retains visible remote context through failure/retry and isolates expanded state on same-ID cross-Host navigation', async () => {
  await render(makeScope('host-a'));
  await act(async () => fixture.onError?.(new Error('remote offline')));
  expect(node.querySelector('[role="alert"]')?.textContent).toContain('remote offline');
  expect(node.textContent).toContain('REMOTE host-a');
  await act(async () => node.querySelector<HTMLButtonElement>('[role="alert"] button')!.click());
  expect(fixture.refresh).toHaveBeenCalled();
  expect(node.querySelector('[role="alert"]')).toBeNull();
  await act(async () => node.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!.click());
  fixture.hostId = 'host-b'; await render(makeScope('host-b'));
  expect(node.textContent).toContain('REMOTE host-b');
  expect(node.textContent).not.toContain('REMOTE host-a');
  expect(node.querySelector('pre')).toBeNull();
  expect(fixture.local).not.toHaveBeenCalled();
});

it('releases hidden overview demand and performs no transcript subscription while the panel is closed', async () => {
  const scope = makeScope('host-a');
  await act(async () => root.render(<HostRuntimeContext.Provider value={scope}><ContextPanelContent active={false} /></HostRuntimeContext.Provider>));
  expect(fixture.demand).toHaveBeenLastCalledWith(null);
  expect(fixture.subscribe).not.toHaveBeenCalled();
  expect(node.textContent).not.toContain('Remote user prompt');
  await render(scope);
  expect(fixture.demand).toHaveBeenLastCalledWith('same-session');
  expect(fixture.subscribe).toHaveBeenCalled();
  expect(node.textContent).toContain('Remote user prompt');
});
