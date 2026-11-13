import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import type { ChatInputSurface } from './chatInputSurface';
import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import { HostRuntimeRegistry, type HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { RemoteChatContainer } from './RemoteChatContainer';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { getRemoteInputStore, remoteSessionDraftKey } from '@/sync/remote-input-store';
import { getLocationOpencodeClient } from '@/lib/opencode/client';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { getHostRuntimeServices } from '@/lib/remote-projects/runtime';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { REMOTE_NEW_SESSION_DRAFT_ID } from '@/lib/remote-projects/location';
import { HostRuntimeProvider } from '@/contexts/HostRuntimeProvider';
import { RemoteHostIndicator } from '@/components/session/RemoteHostIndicator';

const fixture = vi.hoisted(() => ({ registry: null as unknown as HostRuntimeRegistry, surface: null as ChatInputSurface | null }));
vi.mock('@/queries/remoteProjectQueries', () => ({
  useRemoteHostCatalog: () => ({ data: { hubId: 'hub', supported: true }, error: null }),
  getHostRuntimeRegistry: () => fixture.registry,
  supportsRemoteProjects: () => true,
}));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: () => () => {} }));
vi.mock('@/sync/sync-context', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/sync/sync-context')>(),
  useDirectorySync: (select: (state: { todo: Record<string, never[]> }) => unknown) => select({ todo: {} }),
  useSessionLatestTodos: () => undefined,
}));
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/sync/transcript-durable-store-runtime', async () => {
  const { createMemoryTranscriptDurableStore } = await import('@/sync/transcript-durable-store');
  return { createRuntimeTranscriptDurableStore: () => createMemoryTranscriptDurableStore() };
});

test('wire new-draft queue initializes selection once, wait=false permits background setup, existing enqueue never switches', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const previous = getRuntimeUrlResolver(); configureRuntimeUrlResolver({ apiBaseUrl: 'https://hub.example' });
  const location = { hubId: 'hub', hostId: 'queue-wire', directory: '/raw worktree' };
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  const session = { id: 'queue-created', projectID: 'p', title: 'Queued', location: { directory: location.directory }, cost: 0, tokens: {}, time: { created: 1, updated: 1 } };
  vi.stubGlobal('fetch', vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/api/hosts/queue-wire/')) return Response.json({});
    const body = request.method === 'GET' || request.method === 'DELETE' ? null : await request.json().catch(() => null);
    requests.push({ path, method: request.method, body });
    if (path.endsWith('/session') || path.endsWith('/queue-created')) return Response.json({ data: session });
    if (path.endsWith('/model') || path.endsWith('/agent') && request.method === 'POST') return new Response(null, { status: 204 });
    if (path.endsWith('/session/active')) return Response.json({ data: {} });
    if (path.endsWith('/prompt')) return Response.json({ data: { id: body.id, sessionID: session.id, type: 'user', delivery: body.delivery, payload: { text: body.text } } });
    if (path.endsWith('/subscriptions')) return Response.json({ id: 'lease' });
    if (path.includes('permission-auto-accept')) return Response.json({ sessions: {} });
    return Response.json({ data: [] });
  }));
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true, fetch: runtimeFetch,
    sdk: (target) => getLocationOpencodeClient(target).getSdkClient(), service: (target) => getLocationOpencodeClient(target) });
  registry.applyCatalog({ hubId: 'hub', supported: true, projects: [], hosts: [{ id: location.hostId, name: 'Queue', source: 'direct', state: 'connected' }] });
  fixture.registry = registry;
  const project = { id: 'queue-project', path: location.directory, hostId: location.hostId, hubId: 'hub' };
  useProjectsStore.setState({ projects: [project], activeProjectId: project.id });
  useSessionNavigationStore.getState().openRemoteSession(project, location, null, { bootstrapWaitEnabled: false, bootstrapStatus: { status: 'pending', error: null, updatedAt: 1 } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const render = (id: string | null) => <QueryClientProvider client={client}><RemoteChatContainer location={location} sessionId={id} /></QueryClientProvider>;
  try {
    await act(async () => root.render(render(null)));
    const draft = fixture.surface!;
    await act(async () => draft.selection.change!({ providerID: 'openai', modelID: 'gpt-4.1', agent: 'build' }));
    const selected = fixture.surface!;
    await act(async () => selected.backend.send({ operation: 'send', surfaceID: selected.surfaceID, sessionID: null, draftKey: selected.draftKey!, directory: location.directory,
      deliveryTarget: selected.deliveryTarget, transportIdentity: selected.transportIdentity, runtimeGeneration: selected.runtimeGeneration,
      ...selected.selection.value, text: 'Initial queued input', options: { delivery: 'queue' } }));
    const model = requests.findIndex((request) => request.path.endsWith('/model'));
    const prompt = requests.findIndex((request) => request.path.endsWith('/prompt'));
    expect(model).toBeGreaterThanOrEqual(0); expect(prompt).toBeGreaterThan(model);
    expect(requests[model].body).toEqual({ model: { providerID: 'openai', id: 'gpt-4.1' } });
    expect(requests[prompt].body).toMatchObject({ delivery: 'queue', text: 'Initial queued input' });
    await act(async () => root.render(render(session.id)));
    const existing = fixture.surface!;
    const modelWrites = requests.filter((request) => request.path.endsWith('/model')).length;
    await act(async () => existing.backend.send({ operation: 'send', surfaceID: existing.surfaceID, sessionID: session.id, draftKey: existing.draftKey!, directory: location.directory,
      deliveryTarget: existing.deliveryTarget, transportIdentity: existing.transportIdentity, runtimeGeneration: existing.runtimeGeneration,
      providerID: 'other', modelID: 'must-not-apply', text: 'Existing queue', options: { delivery: 'queue' } }));
    expect(requests.filter((request) => request.path.endsWith('/model'))).toHaveLength(modelWrites);
    expect(requests.filter((request) => request.path.endsWith('/session') && request.method === 'POST')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount()); client.clear(); registry.dispose(); node.remove(); vi.unstubAllGlobals(); setRuntimeUrlResolver(previous);
  }
});
vi.mock('@/queries/configCatalogQueries', () => ({
  providerCatalogQueryOptions: () => ({ queryKey: ['remote-test-providers'], queryFn: async () => ({ default: { 'remote-provider': 'model' }, providers: [{ id: 'remote-provider', name: 'Remote', models: { model: { id: 'model', name: 'Model' } } }] }) }),
  rawAgentsQueryOptions: () => ({ queryKey: ['remote-test-agents'], queryFn: async () => [{ name: 'build' }] }),
}));
vi.mock('./ChatInput', () => ({ ChatInput: ({ surface }: { surface: ChatInputSurface }) => { fixture.surface = surface; return <div data-editor={surface.surfaceID} />; } }));
vi.mock('./MessageList', () => ({ default: React.forwardRef(function List({ messages }: { messages: Array<{ info: { id: string }; parts: Array<{ text?: string }> }> }, _ref) {
  return <div data-transcript>{messages.map((row) => <p key={row.info.id}>{row.parts.map((part) => part.text).join('')}</p>)}</div>;
}) }));
vi.mock('./hooks/useChatTimelineController', () => ({ useChatTimelineController: ({ messages, loadMoreMessages }: { messages: unknown[]; loadMoreMessages: () => Promise<void> }) => ({ renderedMessages: messages, handleHistoryScroll: () => {}, isLoadingOlder: false, loadEarlier: loadMoreMessages, historySignals: { canLoadEarlier: false } }) }));
vi.mock('./TimelineDialog', () => ({ TimelineDialog: () => null }));
vi.mock('@/hooks/useChatAutoFollow', () => ({ useChatAutoFollow: () => ({ scrollRef: { current: null }, notifyContentChange: () => {}, getAnimationHandlers: () => ({}), goToBottom: () => {}, scrollToBottomOnSend: () => {}, releaseAutoFollow: () => {}, beginHistoryViewportPreservation: () => {}, endHistoryViewportPreservation: () => {}, isPinned: true, showScrollButton: false }) }));
vi.mock('./PermissionCard', () => ({ PermissionCard: () => null }));
vi.mock('./QuestionCard', () => ({ QuestionCard: () => null }));
vi.mock('./FormCard', () => ({ FormCard: () => null }));

afterEach(() => { fixture.surface = null; vi.restoreAllMocks(); });

test('draft failures stay beside the machine name, retry draft storage, and disappear on recovery or departure', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const location = { hubId: 'draft-error-hub', hostId: 'draft-error-host', directory: '/repo' };
  const registry = new HostRuntimeRegistry(location.hubId, { transportIdentity: 'draft-error-test', isCurrent: () => true,
    sdk: () => ({}) as OpenCodeClient, fetch: async () => Response.json({}),
  });
  registry.applyCatalog({ hubId: location.hubId, supported: true, projects: [], hosts: ['draft-error-host', 'other'].map((id) => ({ id, name: id, source: 'direct' as const, state: 'connected' as const })) });
  const input = getRemoteInputStore(location).getState();
  const hydrate = vi.spyOn(input, 'hydrateDraftMetadata').mockResolvedValue(false);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const render = (chat = true) => <QueryClientProvider client={client}>
    <RemoteHostIndicator registry={registry} hostId={location.hostId} showName />
    <RemoteHostIndicator registry={registry} hostId="other" showName />
    {chat ? <HostRuntimeProvider registry={registry} location={location}><RemoteChatContainer location={location} sessionId={null} /></HostRuntimeProvider> : null}
  </QueryClientProvider>;
  try {
    await act(async () => root.render(render()));
    expect(node.textContent).not.toContain('Remote draft storage unavailable');
    const trigger = node.querySelector<HTMLElement>('[data-remote-host-error="draft-error-host"]');
    expect(trigger).not.toBeNull();
    expect(node.querySelector('[data-remote-host-error="other"]')).toBeNull();
    await act(async () => trigger!.click());
    expect(document.querySelector('[data-remote-host-error-popup]')?.textContent).toContain('Remote draft storage unavailable');
    const retry = document.querySelector<HTMLButtonElement>('[data-remote-host-error-popup] button');
    await act(async () => retry!.click());
    expect(hydrate).toHaveBeenCalledTimes(2);
    expect(node.querySelector('[data-remote-host-error]')).not.toBeNull();
    hydrate.mockResolvedValue(true);
    await act(async () => retry!.click());
    expect(hydrate).toHaveBeenCalledTimes(3);
    expect(node.querySelector('[data-remote-host-error]')).toBeNull();
    expect(node.querySelector('[data-editor]')).not.toBeNull();
    hydrate.mockResolvedValue(false);
    await act(async () => root.render(render(false)));
    await act(async () => root.render(render()));
    expect(node.querySelector('[data-remote-host-error]')).not.toBeNull();
    await act(async () => root.render(render(false)));
    expect(node.querySelector('[data-remote-host-error]')).toBeNull();
  } finally {
    await act(async () => root.unmount()); client.clear(); registry.dispose(); node.remove();
  }
});

test('draft model, agent and variant survive remount without crossing local, Host or directory boundaries', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const previous = useSelectionStore.getState();
  const location = { hubId: 'selection-hub', hostId: 'a', directory: '/repo' };
  const registry = new HostRuntimeRegistry(location.hubId, { transportIdentity: 'selection-test', isCurrent: () => true,
    sdk: () => ({}) as OpenCodeClient, service: () => ({}) as ReturnType<HostRuntimeEntry['service']>,
    fetch: async () => Response.json({ sessions: {} }),
  });
  registry.applyCatalog({ hubId: location.hubId, supported: true, projects: [], hosts: ['a', 'b'].map((id) => ({ id, name: id, source: 'direct' as const, state: 'connected' as const })) });
  fixture.registry = registry;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node = document.createElement('div'); const root = createRoot(node);
  const render = async (target: typeof location) => {
    await act(async () => root.render(null));
    await act(async () => root.render(<QueryClientProvider client={client}><HostRuntimeProvider registry={registry} location={target}><RemoteChatContainer location={target} sessionId={null} /></HostRuntimeProvider></QueryClientProvider>));
  };
  try {
    useSelectionStore.getState().saveSessionModelSelection(REMOTE_NEW_SESSION_DRAFT_ID, 'local', 'local-model');
    useSelectionStore.getState().saveSessionAgentSelection(REMOTE_NEW_SESSION_DRAFT_ID, 'local-agent');
    await render(location);
    const chosen = { providerID: 'remote', modelID: 'remote-model', agent: 'remote-agent', variant: 'high' };
    await act(async () => fixture.surface!.selection.change!(chosen));
    for (const target of [{ ...location, hostId: 'b' }, { ...location, directory: '/other' }]) {
      await render(target);
      expect(fixture.surface!.selection.value.providerID).toBeUndefined();
      expect(fixture.surface!.selection.value.agent).toBeUndefined();
      expect(fixture.surface!.selection.value.variant).toBeUndefined();
    }
    await render(location);
    expect(fixture.surface!.selection.value).toEqual(chosen);
    expect(useSelectionStore.getState().getSessionModelSelection(REMOTE_NEW_SESSION_DRAFT_ID)).toEqual({ providerId: 'local', modelId: 'local-model' });
    expect(useSelectionStore.getState().getSessionAgentSelection(REMOTE_NEW_SESSION_DRAFT_ID)).toBe('local-agent');
    expect(useSelectionStore.getState().lastUsedProvider).toEqual({ providerID: 'local', modelID: 'local-model' });
  } finally {
    await act(async () => root.unmount()); client.clear(); registry.dispose(); useSelectionStore.setState(previous);
  }
});

test('production remote pane observes, paints and sends to its Host, never the local queue; draft create keeps the owner alive', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const location = { hubId: 'hub', hostId: 'remote', directory: 'C:\\repo' };
  await getRemoteInputStore(location).getState().setDraftPersistenceEnabled(false);
  const requests: Array<{ path: string; body?: unknown }> = [];
  let bodyAvailable = false;
  const sdk = {
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, agent: 'build', model: { providerID: 'remote-provider', id: 'model' } })),
      form: { list: vi.fn(async () => []) },
      switchModel: vi.fn(), switchAgent: vi.fn(),
      command: vi.fn(),
    },
    permission: { request: { list: vi.fn(async () => ({ data: [] })) } },
    form: { list: vi.fn(async () => ({ data: [] })) },
  } as unknown as OpenCodeClient;
  const service = {
    getSessionActive: vi.fn(async () => ({ state: 'supported', membership: {} })),
    createSession: vi.fn(async () => ({ id: 'created', time: { created: 1, updated: 1 } })),
  } as unknown as ReturnType<HostRuntimeEntry['service']>;
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: 'test', isCurrent: () => true,
    sdk: () => sdk, service: () => service,
    fetch: async (path, init) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      requests.push({ path, body });
      if (path.endsWith('/subscriptions')) return Response.json({ id: 'lease', channelId: 'channel', readyGeneration: 'first' });
      if (path.endsWith('/prompt')) return Response.json({ id: body.id, sessionID: path.includes('/created/') ? 'created' : 'same', type: 'user', delivery: body.delivery, payload: { text: body.text } });
      if (path.endsWith('/message')) return bodyAvailable ? Response.json({ data: [{ id: 'msg_one', type: 'user', text: 'Remote authority', time: { created: 1 } }] }) : Response.json({ error: 'Not found' }, { status: 404 });
      return Response.json([]);
    } });
  registry.applyCatalog({ hubId: 'hub', supported: true, projects: [], hosts: [{ id: 'remote', name: 'Remote', source: 'direct', state: 'connected' }] });
  fixture.registry = registry;
  useProjectsStore.setState({ projects: [{ id: 'project', path: location.directory, hostId: 'remote', hubId: 'hub' }], activeProjectId: 'project' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  const previousUI = useUIStore.getState();
  const render = (sessionId: string | null) => <QueryClientProvider client={client}><RemoteHostIndicator registry={registry} hostId={location.hostId} showName /><RemoteChatContainer location={location} sessionId={sessionId} /></QueryClientProvider>;
  try {
    await act(async () => root.render(render('same')));
    await vi.waitFor(() => expect(element.querySelector('[data-remote-host-error]')?.getAttribute('aria-label')).toContain('404'));
    expect(element.querySelector('[role="alert"]')).toBeNull();
    bodyAvailable = true;
    await act(async () => getHostRuntimeServices(registry).demand.contentReady('remote', 'lease', 'same', 'channel', 'recovered'));
    await vi.waitFor(() => expect(element.textContent).toContain('Remote authority'));
    await vi.waitFor(() => expect(element.querySelector('[data-remote-host-error]')).toBeNull());
    const Viewport = React.memo(({ showPromptNavigator }: { showPromptNavigator: boolean }) => <div data-prompt-navigator={String(showPromptNavigator)} />);
    for (const [isMobile, promptNavigatorEnabled, visible] of [
      [true, true, false], [false, true, true], [false, false, false], [true, false, false],
    ]) {
      await act(async () => {
        useUIStore.setState({ isMobile, promptNavigatorEnabled });
        root.render(<QueryClientProvider client={client}><RemoteChatContainer location={location} sessionId="same" viewport={Viewport} /></QueryClientProvider>);
      });
      expect(element.querySelector('[data-prompt-navigator]')?.getAttribute('data-prompt-navigator')).toBe(String(visible));
    }
    await act(async () => {
      useUIStore.setState({ isMobile: previousUI.isMobile, promptNavigatorEnabled: previousUI.promptNavigatorEnabled });
      root.render(render('same'));
    });
    expect(fixture.surface!.selection.catalog?.providers).toEqual([]);
    await act(async () => fixture.surface!.selection.requestCatalog!(true));
    await vi.waitFor(() => expect(fixture.surface!.selection.catalog?.providers[0]?.id).toBe('remote-provider'));
    const selected = fixture.surface!;
    expect(selected.selection.catalog?.providers[0]?.id).toBe('remote-provider');
    await act(async () => { await selected.backend.send({ operation: 'send', surfaceID: selected.surfaceID, sessionID: 'same', directory: location.directory, draftKey: selected.draftKey!, deliveryTarget: selected.deliveryTarget,
      transportIdentity: selected.transportIdentity, runtimeGeneration: selected.runtimeGeneration, text: 'Remote send', parts: [{ text: 'Synthetic context', synthetic: true }], options: { delivery: 'queue', messageID: 'input_queue' } }); });
    expect(requests.find((request) => request.path.endsWith('/prompt'))).toMatchObject({ path: '/api/hosts/remote/api/session/same/prompt', body: { text: 'Remote send\n\nSynthetic context', delivery: 'queue' } });
    expect(sdk.session.switchModel).not.toHaveBeenCalled();
    await act(async () => root.render(render(null)));
    const draft = fixture.surface!;
    getRemoteInputStore(location).getState().setDraftText(draft.draftKey!, 'First remote send');
    await act(async () => { await draft.backend.send({ operation: 'send', surfaceID: draft.surfaceID, sessionID: null, directory: location.directory, draftKey: draft.draftKey!, deliveryTarget: draft.deliveryTarget,
      transportIdentity: draft.transportIdentity, runtimeGeneration: draft.runtimeGeneration, text: 'First remote send', options: { messageID: 'input_first' } }); });
    expect(useSessionNavigationStore.getState().remoteSession).toMatchObject({ sessionId: 'created', location });
    expect(requests.some((request) => request.path === '/api/hosts/remote/api/session/created/prompt')).toBe(true);
    expect(getRemoteInputStore(location).getState().getDraft(remoteSessionDraftKey(location, 'created'))?.text).toBe('');
    await act(async () => root.render(render('created')));
    expect(element.querySelector('[data-transcript]')?.textContent).toContain('First remote send');
    await act(async () => registry.ingest({ type: 'yuri:host-event', properties: { hubId: 'hub', hostId: 'remote', directory: location.directory,
      payload: { type: 'session.status', properties: { sessionID: 'created', status: { type: 'busy' } } } } }));
    expect(element.textContent).toContain('chat.assistantStatus.working');
    expect(requests.some((request) => request.path.includes('message-queue') || request.path.includes('transcript-cache'))).toBe(false);
    expect(requests.every((request) => request.path.startsWith('/api/hosts/remote/'))).toBe(true);
    const beforeTimeline = requests.length;
    await act(async () => { await fixture.surface!.backend.send({ operation: 'send', surfaceID: draft.surfaceID, sessionID: null, directory: location.directory,
      draftKey: draft.draftKey!, deliveryTarget: draft.deliveryTarget, transportIdentity: draft.transportIdentity, runtimeGeneration: draft.runtimeGeneration, text: '/timeline' }); });
    expect(sdk.session.command).not.toHaveBeenCalled();
    expect(requests).toHaveLength(beforeTimeline);
    const retryStatus = { type: 'retry' as const, attempt: 1, next: 0, message: 'Quota limit',
      action: { reason: 'quota', provider: 'remote-provider', title: 'Remote account', message: 'Add credits', label: 'Manage account', link: 'https://example.com/account' } };
    await act(async () => root.render(render('retry')));
    await vi.waitFor(() => expect(fixture.surface?.activity?.phase).toBe('idle'));
    await act(async () => registry.ingest({ type: 'yuri:host-event', properties: { hubId: 'hub', hostId: 'remote', directory: location.directory,
      payload: { type: 'session.status', properties: { sessionID: 'retry', status: retryStatus } } } }));
    await vi.waitFor(() => expect(element.querySelector('a[href="https://example.com/account"]')?.textContent).toBe('Manage account'));
    expect(element.textContent).toContain('Add credits');
    await act(async () => root.render(<QueryClientProvider client={client}><RemoteChatContainer location={location} sessionId="same" readOnly /></QueryClientProvider>));
    const readonly = fixture.surface!;
    const requestCount = requests.length;
    await expect(readonly.backend.send({ operation: 'send', surfaceID: readonly.surfaceID, sessionID: 'same', directory: location.directory,
      draftKey: readonly.draftKey!, deliveryTarget: readonly.deliveryTarget, transportIdentity: readonly.transportIdentity,
      runtimeGeneration: readonly.runtimeGeneration, text: 'Forbidden' })).rejects.toThrow('read-only');
    await expect(readonly.shortcuts!.cycle(1)).rejects.toThrow('read-only');
    expect(() => readonly.shortcuts!.abort()).toThrow('read-only');
    expect(requests).toHaveLength(requestCount);
  } finally {
    await act(async () => root.unmount()); client.clear(); registry.dispose(); element.remove();
    useUIStore.setState({ isMobile: previousUI.isMobile, promptNavigatorEnabled: previousUI.promptNavigatorEnabled });
  }
});
