import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { expect, test, vi } from 'vitest';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import type { RuntimeAPIs } from '@/lib/api/types';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { getLocationOpencodeClient } from '@/lib/opencode/client';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { useSessionNavigationStore } from '@/stores/useSessionNavigationStore';
import { toast } from 'sonner';
import { RemoteChatContainer } from './RemoteChatContainer';
import { useUIStore } from '@/stores/useUIStore';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { getRemoteInputStore, remoteSessionDraftKey, requestRemoteComposerInput, requestRemotePresetSubmit } from '@/sync/remote-input-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import selectionArchive from '@/composer/fixtures/candidate-final-selection.json';
import { ChatInput } from './ChatInput';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { sessionDraftKey } from '@/sync/input-draft-types';
import { announceSessionSwitchIntent } from '@/lib/sessionSwitchIntent';
import './message/TextSelectionMenu';
import { nativeIosComposerSession } from '@/lib/native-ios-composer-session';
import * as autocomplete from '@/lib/composer-autocomplete';
import { useRemoteMobileSession } from '@/apps/remoteMobileSession';
import { RemoteMobileSessionBoundary } from '@/apps/remoteMobileBoundary';
import { MobileChatScreen } from '@/mobile/chat/MobileChatScreen';
import { getTranscriptRepository, transcriptScope } from '@/sync/transcript-repository-runtime';
import { queryClient } from '@/lib/queryRuntime';

const fixture = vi.hoisted(() => ({ registry: null as unknown as HostRuntimeRegistry, wire: false, providerReads: 0, agentReads: 0, modelEnumerations: 0, native: false,
  nativePresent: vi.fn(async (_state: Record<string, unknown>) => {}), nativeUpdate: vi.fn(async (_state: Record<string, unknown>) => {}), nativeHide: vi.fn(async () => {}), nativeDismiss: vi.fn(async () => {}),
  nativeListeners: new Map<string, (payload: Record<string, unknown>) => void>(), nativeListenerAdds: 0,
}));
vi.mock('@/lib/iosNativeUi', () => ({ useIosNativeUiEnabled: () => fixture.native }));
vi.mock('@/lib/native-ios-composer-leave', () => ({ attachNativeIosComposerLeaveConceal: () => () => {} }));
vi.mock('@/lib/native-ios-composer', async (original) => ({
  ...await original<typeof import('@/lib/native-ios-composer')>(),
  canUseNativeIosComposer: () => fixture.native,
  rasterizeLogoPngBase64: async () => '',
  getNativeIosComposerPlugin: () => ({ present: fixture.nativePresent, update: fixture.nativeUpdate, hide: fixture.nativeHide, dismiss: fixture.nativeDismiss,
    addListener: async (name: string, listener: (payload: Record<string, unknown>) => void) => {
      fixture.nativeListenerAdds++;
      fixture.nativeListeners.set(name, listener);
      return { remove: async () => { if (fixture.nativeListeners.get(name) === listener) fixture.nativeListeners.delete(name); } };
    },
  }),
}));
vi.mock('@/queries/remoteProjectQueries', async (original) => ({ ...await original<typeof import('@/queries/remoteProjectQueries')>(), useRemoteHostCatalog: () => ({ data: { supported: true, hubId: 'hub' } }), useRemoteProjectRuntime: () => ({ registry: fixture.registry }), getHostRuntimeRegistry: () => fixture.registry, supportsRemoteProjects: () => true }));
vi.mock('@/lib/yuriEvents', () => ({ subscribeYuriEvents: () => () => {} }));
vi.mock('@/sync/use-sync', () => ({ useSync: () => ({ ensureSessionRenderable: async () => undefined }) }));
vi.mock('@/hooks/useEffectiveDirectory', () => ({ useEffectiveDirectory: () => '/repo', useEffectiveLocationKey: () => 'remote-location' }));
vi.mock('@/sync/sync-context', async (original) => {
  const actual = await original<typeof import('@/sync/sync-context')>();
  const messages: never[] = [];
  const state = { session: messages, session_status: {}, session_execution_recovery: {}, todo: {}, message: {}, permission: {}, question: {} };
  const store = { getState: () => state, subscribe: () => () => {} };
  return { ...actual, useSyncDirectory: () => '/hub', useSessions: () => messages, useSessionMessages: () => messages, useUserMessageHistory: () => messages,
    useSessionMaterializationStatus: () => ({ renderable: true }), useSession: () => undefined, useSessionStatus: () => ({ type: 'idle' }),
    useSessionStatusObservedAt: () => 0, useSessionStatusSnapshotAt: () => 0, useSessionPermissions: () => messages, useSessionQuestions: () => messages,
    useSessionLatestTodos: () => messages, useDirectorySync: (selector: (value: typeof state) => unknown) => selector(state),
    useDirectoryStore: () => store,
  };
});
vi.mock('@/queries/configCatalogQueries', async (original) => {
  const actual = await original<typeof import('@/queries/configCatalogQueries')>();
  return { ...actual,
    providerCatalogQueryOptions: (...args: Parameters<typeof actual.providerCatalogQueryOptions>) => fixture.wire ? actual.providerCatalogQueryOptions(...args) : ({ queryKey: ['remote-real-providers'], queryFn: async () => { fixture.providerReads++; return { default: {}, providers: Array.from({ length: 300 }, (_, index) => ({ id: `provider-${index}`, name: `Provider ${index}`, get models() { fixture.modelEnumerations++; return { model: { id: 'model', name: 'Model' } }; } })) }; } }),
    rawAgentsQueryOptions: (...args: Parameters<typeof actual.rawAgentsQueryOptions>) => fixture.wire ? actual.rawAgentsQueryOptions(...args) : ({ queryKey: ['remote-real-agents'], queryFn: async () => { fixture.agentReads++; return Array.from({ length: 300 }, (_, index) => ({ name: `agent-${index}`, mode: 'primary' })); } }),
  };
});
vi.mock('@/sync/transcript-durable-store-runtime', async () => {
  const { createMemoryTranscriptDurableStore } = await import('@/sync/transcript-durable-store');
  return { createRuntimeTranscriptDurableStore: () => createMemoryTranscriptDurableStore() };
});
vi.mock('./MessageList', () => ({ default: React.forwardRef(function List() { return <div />; }) }));
vi.mock('./hooks/useChatTimelineController', () => ({ useChatTimelineController: ({ messages }: { messages: unknown[] }) => ({ renderedMessages: messages, historySignals: {} }) }));
vi.mock('@/hooks/useChatAutoFollow', () => ({ useChatAutoFollow: () => ({ scrollRef: { current: null }, getAnimationHandlers: () => ({}) }) }));

function wireHarness(createdID = 'created', mentions = false, permissionEffect?: 'allow' | 'ask' | 'deny') {
  const previous = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://hub.example' });
  const location = { hubId: 'hub', hostId: 'host', directory: '/repo' };
  const requests: Array<{ path: string; method: string; body: Record<string, unknown> | null }> = [];
  let model: { providerID: string; id: string } | undefined;
  let failModel = false;
  const permissionSessions: Record<string, boolean> = {};
  const session = (id: string) => ({ id, projectID: 'remote-project', title: 'Wire title', location: { directory: location.directory }, ...(permissionEffect ? { agent: 'build' } : {}), model, cost: 0, tokens: {}, time: { created: 1, updated: 2 } });
  vi.stubGlobal('fetch', vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (!/^\/api\/hosts\/(host|hostB)\//.test(path)) return Response.json({});
    const body = request.method === 'GET' || request.method === 'DELETE' ? null : await request.json().catch(() => null);
    requests.push({ path, method: request.method, body });
    if (path.endsWith('/config/catalog/providers')) return Response.json({ schemaVersion: 1, partial: false, default: { openai: 'gpt-4.1' }, providers: [
      { id: 'free', name: 'Free', models: { free: { id: 'free', name: 'Iceman Free' } } },
      { id: 'openai', name: 'OpenAI', models: { 'gpt-4.1': { id: 'gpt-4.1', name: 'GPT-4.1' }, 'gpt-4.1-mini': { id: 'gpt-4.1-mini', name: 'GPT-4.1 Mini' } } },
    ] });
    if (path.endsWith('/session/active')) return Response.json({ data: {} });
    const host = path.includes('/hostB/') ? 'B' : 'A';
    if (path.endsWith('/config/skills')) return Response.json({ skills: mentions ? Array.from({ length: 300 }, (_, i) => ({ name: `skill-${host}-${i}`, path: `/skills/skill-${host}-${i}`, description: host })) : [] });
    if (path.endsWith('/summaries')) return Response.json({ hubId: 'hub', hostId: host === 'B' ? 'hostB' : 'host', stale: false,
      directories: [{ directory: '/repo', sessions: Array.from({ length: 300 }, (_, i) => ({ id: `reference-${i}`, title: `Session ${host} ${i}`, time: { created: 1, updated: i + 1 } })) }] });
    if (path.includes('/session/reference-')) return Response.json({ data: { ...session(path.split('/').at(-1)!), title: `Session ${host} ${path.split('-').at(-1)}`, location: { directory: '/other-remote-cwd' } } });
    if (path.endsWith('/fs/find')) return Response.json({ data: [{ path: `src/${host}.ts`, type: 'file' }] });
    if (path.endsWith('/command') && request.method === 'POST') return new Response(null, { status: 204 });
    if (path.endsWith('/session') && request.method === 'POST') return Response.json({ data: session(createdID) });
    if (path.endsWith(`/session/${createdID}`) || path.endsWith('/session/same')) return Response.json({ data: session(path.endsWith('/same') ? 'same' : createdID) });
    if (path.endsWith('/model') && request.method === 'POST') {
      if (failModel) return Response.json({ message: 'Model unavailable' }, { status: 503 });
      model = body.model;
      return new Response(null, { status: 204 });
    }
    if (path.endsWith('/agent') && request.method === 'POST') return new Response(null, { status: 204 });
    if (path.endsWith('/prompt')) return Response.json({ data: { id: body.id, sessionID: createdID, type: 'user', delivery: body.delivery, timeCreated: 1, payload: { text: body.text } } });
    if (path.endsWith('/subscriptions')) return Response.json({ id: 'lease' });
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (path.includes('session-unread')) return Response.json({ revision: 0, sessions: {} });
    if (path.includes('permission-auto-accept')) {
      if (request.method === 'PUT') permissionSessions[path.split('/').at(-1)!] = body.enabled === true;
      return Response.json({ sessions: permissionSessions });
    }
    if (path.endsWith('/agent')) return Response.json({ data: permissionEffect ? [{ id: 'build', name: 'Build', mode: 'primary', permissions: [{ action: '*', resource: '*', effect: host === 'B' ? 'ask' : permissionEffect }], request: { settings: {}, headers: {}, body: {} } }] : mentions ? Array.from({ length: 300 }, (_, i) => ({ id: `agent-${host}-${i}`, name: `agent-${host}-${i}`, mode: 'subagent', permissions: [], request: { settings: {}, headers: {}, body: {} } })) : [] });
    return Response.json({ data: [] });
  }));
  const registry = new HostRuntimeRegistry('hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true,
    sdk: (target) => getLocationOpencodeClient(target).getSdkClient(), service: (target) => getLocationOpencodeClient(target), fetch: runtimeFetch });
  registry.applyCatalog({ hubId: 'hub', supported: true, hosts: [{ id: 'host', name: 'Host', source: 'direct', state: 'connected' }, { id: 'hostB', name: 'Host B', source: 'direct', state: 'connected' }], projects: [] });
  fixture.registry = registry;
  return { location, requests, registry, failModel: () => { failModel = true; }, restoreModel: () => { failModel = false; },
    close: () => { registry.dispose(); vi.unstubAllGlobals(); setRuntimeUrlResolver(previous); } };
}

test.each([
  { pinned: false, strict: false }, { pinned: true, strict: false },
  { pinned: false, strict: true }, { pinned: true, strict: true },
])('cold mobile connection renders synchronized messages and clears its hint without leaving the conversation ($pinned, strict=$strict)', async ({ pinned, strict }) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  queryClient.clear();
  fixture.wire = true;
  const wire = wireHarness();
  const previousProjects = useProjectsStore.getState();
  const project = { id: 'cold-remote', path: '/repo', hubId: 'hub', hostId: 'host', label: 'Remote' };
  useProjectsStore.setState({ projects: [project], activeProjectId: project.id });
  useSessionNavigationStore.getState().openRemoteSession(project, wire.location, 'same');
  useUIStore.setState({ isMobile: true });
  const host = { id: 'host', name: 'Host', source: 'ssh' as const, state: 'connecting' as const, scopeGeneration: 'cold-scope', generation: 'cold-wire', ...(pinned ? { instanceId: 'remote-instance' } : {}) };
  wire.registry.applyCatalog({ hubId: 'hub', supported: true, projects: [], hosts: [host] });
  let ready!: () => void;
  const gate = new Promise<void>((resolve) => { ready = resolve; });
  const network = vi.mocked(globalThis.fetch);
  const normal = network.getMockImplementation()!;
  let transcriptReads = 0;
  network.mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/subscriptions')) await gate;
    if (path.endsWith('/session/same/message')) {
      await gate;
      transcriptReads++;
      return Response.json({ data: [
        { id: 'msg_02_cold_assistant', sessionID: 'same', type: 'assistant', parentID: 'msg_01_cold_user', content: [{ type: 'text', text: 'Cold remote reply' }], finish: 'stop', time: { created: 2, completed: 3 } },
        { id: 'msg_01_cold_user', sessionID: 'same', type: 'user', text: 'Cold remote transcript', time: { created: 1 } },
      ] });
    }
    return normal(input, init);
  });
  function ReproViewport({ renderedMessages }: React.ComponentProps<NonNullable<Parameters<typeof RemoteChatContainer>[0]['viewport']>>) {
    return <div data-cold-transcript>{renderedMessages.map((message) => message.parts.map((part) => 'text' in part ? part.text : '').join('')).join('')}</div>;
  }
  const Viewport = React.memo<typeof ReproViewport>(ReproViewport);
  function Phone() {
    const scope = useRemoteMobileSession();
    return <RemoteMobileSessionBoundary scope={scope}><MobileChatScreen sessionId="same" directory="/repo" onBack={() => {}} onOpenMenu={() => {}}>
      <RemoteChatContainer location={wire.location} sessionId="same" composerPresentation="primary" viewport={Viewport} />
    </MobileChatScreen></RemoteMobileSessionBoundary>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  try {
    const runtime = { runtime: { isWeb: false, isDesktop: false, isVSCode: false, isMobile: true, platform: 'android' } } as unknown as RuntimeAPIs;
    const phone = <QueryClientProvider client={client}><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}><Phone /></RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></QueryClientProvider>;
    await act(async () => root.render(strict ? <React.StrictMode>{phone}</React.StrictMode> : phone));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 300)); });
    expect(node.querySelector('[data-cold-transcript]')?.textContent).not.toContain('Cold remote transcript');
    await act(async () => {
      wire.registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub', hostId: 'host', host: { ...host, state: 'connected', instanceId: 'remote-instance' } } });
      ready();
    });
    await vi.waitFor(() => expect(node.querySelector('[data-cold-transcript]')?.textContent).toContain('Cold remote transcript'), { timeout: 1500 });
    expect(node.querySelector('[data-cold-transcript]')?.textContent).toContain('Cold remote reply');
    expect(transcriptReads).toBeGreaterThan(0);
    const repository = getTranscriptRepository(wire.location);
    const transcript = transcriptScope(wire.location, 'same');
    expect(repository?.getHydrationState?.(transcript).p0Satisfied).toBe(true);
    expect(repository?.getRequestState?.(transcript).status).toBe('ready');
    await vi.waitFor(() => expect(node.querySelector('.yuri-mobile-detail-subtitle')?.textContent ?? '').not.toMatch(/syncing|同步消息/i), { timeout: 1500 });
  } finally {
    ready(); await act(async () => root.unmount()); useProjectsStore.setState(previousProjects); useUIStore.setState({ isMobile: false });
    client.clear(); queryClient.clear(); wire.close(); node.remove();
  }
}, 10_000);

test('foreground remote primary claims the real native bridge while panel and background cannot', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.native = true; fixture.wire = true;
  const wire = wireHarness();
  const key = remoteSessionDraftKey(wire.location, 'same');
  const input = getRemoteInputStore(wire.location);
  input.getState().setDraftText(key, 'remote primary');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const runtime = { runtime: { isWeb: false, isDesktop: false, isVSCode: false, isMobile: true, platform: 'ios' } } as unknown as RuntimeAPIs;
  useUIStore.setState({ isMobile: true });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const render = async (active: boolean, primary: boolean) => act(async () => root.render(
    <QueryClientProvider client={client}><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}>
      <RemoteChatContainer location={wire.location} sessionId="same" active={active}
        composerPresentation={primary ? 'primary' : 'panel'} />
    </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></QueryClientProvider>,
  ));
  try {
    await render(true, false);
    expect(fixture.nativePresent).not.toHaveBeenCalled();
    await render(false, true);
    expect(fixture.nativePresent).not.toHaveBeenCalled();
    await render(true, true);
    expect(fixture.nativePresent).toHaveBeenCalledWith(expect.objectContaining({ text: 'remote primary' }));
    expect(document.documentElement.classList.contains('yuri-native-ios-composer')).toBe(true);
    await act(async () => fixture.nativeListeners.get('textChanged')?.({ text: 'remote edit', selectionStart: 11, selectionEnd: 11 }));
    expect(input.getState().getDraft(key)?.text).toBe('remote edit');
  } finally {
    await act(async () => root.unmount()); nativeIosComposerSession.shutdown(); fixture.native = false;
    useUIStore.setState({ isMobile: false }); client.clear(); wire.close(); node.remove();
  }
}, 20_000);

test('production local → remote A → same-id Host B → local hands off one native owner with raw draft isolation', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.native = true; fixture.wire = true;
  fixture.nativePresent.mockClear(); fixture.nativeUpdate.mockClear();
  const wire = wireHarness();
  const b = { ...wire.location, hostId: 'hostB' };
  const aKey = remoteSessionDraftKey(wire.location, 'same'); const bKey = remoteSessionDraftKey(b, 'same');
  const localKey = sessionDraftKey({ transportIdentity: getRuntimeTransportIdentity() }, 'same');
  const remote = getRemoteInputStore(wire.location);
  useSessionUIStore.setState({ currentSessionId: 'same', currentSessionDirectory: '/repo' });
  useUIStore.setState({ isMobile: true, activeMainTab: 'chat' });
  useInputStore.getState().setDraftText(localKey, 'local');
  remote.getState().setDraftText(aKey, 'A'); remote.getState().setDraftText(bKey, 'B');
  for (const [key, name] of [[aKey, 'A.txt'], [bKey, 'B.txt']] as const) remote.getState().addDraftDurableAttachment(key, {
    attachmentID: name, filename: name, mimeType: 'text/plain', size: 1, source: 'server', serverPath: `/${name}`, url: `file:///${name}`,
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const runtime = { runtime: { isWeb: false, isDesktop: false, isVSCode: false, isMobile: true, platform: 'ios' } } as unknown as RuntimeAPIs;
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const render = async (foreground: 'local' | 'A' | 'B', tick = 0) => act(async () => root.render(
    <QueryClientProvider client={client}><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}>
      <div data-tick={tick}><ChatInput foregroundActive={foreground === 'local'} />
        <RemoteChatContainer key="A" location={wire.location} sessionId="same" active={foreground === 'A'} composerPresentation="primary" />
        <RemoteChatContainer key="B" location={b} sessionId="same" active={foreground === 'B'} composerPresentation="primary" />
        <RemoteChatContainer key="panel" location={b} sessionId="same" composerPresentation="panel" />
      </div>
    </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></QueryClientProvider>,
  ));
  try {
    await render('local');
    expect(fixture.nativePresent).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'local', attachmentCount: 0 }));
    const localEvent = fixture.nativeListeners.get('textChanged')!;
    await render('A');
    expect(fixture.nativePresent).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'A', attachmentCount: 1 }));
    const aEvent = fixture.nativeListeners.get('textChanged')!;
    await act(async () => aEvent({ text: 'A edited' }));
    await render('B');
    expect(fixture.nativePresent).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'B', attachmentCount: 1 }));
    await act(async () => { localEvent({ text: 'late local' }); aEvent({ text: 'late A' }); });
    expect(remote.getState().getDraft(aKey)?.text).toBe('A edited');
    expect(remote.getState().getDraft(bKey)?.text).toBe('B');
    await act(async () => fixture.nativeListeners.get('textChanged')?.({ text: 'B edited' }));
    const presentations = fixture.nativePresent.mock.calls.length;
    const updates = fixture.nativeUpdate.mock.calls.length;
    const listeners = fixture.nativeListenerAdds;
    for (let index = 0; index < 50; index++) await render('B', index);
    expect(fixture.nativePresent).toHaveBeenCalledTimes(presentations);
    expect(fixture.nativeUpdate).toHaveBeenCalledTimes(updates);
    expect(fixture.nativeListenerAdds).toBe(listeners);
    for (let index = 0; index < 50; index++) await act(async () => fixture.nativeListeners.get('textChanged')?.({ text: `B native ${index}` }));
    expect(remote.getState().getDraft(bKey)?.text).toBe('B native 49');
    expect(fixture.nativePresent).toHaveBeenCalledTimes(presentations);
    expect(fixture.nativeListenerAdds).toBe(listeners);
    expect(fixture.nativeUpdate.mock.calls.slice(updates).some(([payload]) => 'text' in payload || 'attachmentPreviews' in payload || 'modelIcon' in payload)).toBe(false);
    const beforeCas = remote.getState().getDraft(bKey)!;
    await act(async () => remote.getState().setDraftText(bKey, 'external B preset'));
    expect(remote.getState().replaceDraft(bKey, beforeCas.revision, { ...beforeCas, text: 'stale CAS' })).toBeUndefined();
    expect(fixture.nativeUpdate).toHaveBeenCalledWith(expect.objectContaining({ text: 'external B preset', forceText: true }));
    await render('local');
    expect(fixture.nativePresent).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'local', attachmentCount: 0 }));
    expect(useInputStore.getState().getDraft(localKey)?.text).toBe('local');
    expect(remote.getState().getDraft(aKey)?.text).toBe('A edited');
    expect(remote.getState().getDraft(bKey)?.text).toBe('external B preset');
    expect(remote.getState().getDraftAttachmentViews(aKey).map((file) => file.filename)).toEqual(['A.txt']);
    expect(remote.getState().getDraftAttachmentViews(bKey).map((file) => file.filename)).toEqual(['B.txt']);
  } finally {
    await act(async () => root.unmount()); nativeIosComposerSession.shutdown(); fixture.native = false;
    useUIStore.setState({ isMobile: false }); client.clear(); wire.close(); node.remove();
  }
}, 20_000);

test('archived candidate sidebar local → remote → local preserves selection across production composer unmount', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const archive = selectionArchive;
  expect([archive.before.start, archive.before.end, archive.after.start, archive.after.end]).toEqual([6, 21, 0, 0]);
  fixture.wire = true;
  const wire = wireHarness();
  const sessionID = archive.sessionID;
  const key = sessionDraftKey({ transportIdentity: getRuntimeTransportIdentity() }, sessionID);
  useSessionUIStore.setState({ currentSessionId: sessionID, currentSessionDirectory: '/repo' });
  useInputStore.getState().setDraftText(key, archive.before.value);
  getRemoteInputStore(wire.location).getState().setDraftText(remoteSessionDraftKey(wire.location, 'same'), archive.remote.value);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const runtime = { runtime: { isWeb: true, isDesktop: false, isVSCode: false, isMobile: false, platform: 'web' } } as unknown as RuntimeAPIs;
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const render = async (remote: boolean) => act(async () => root.render(<QueryClientProvider client={client}><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}>{remote ? <RemoteChatContainer location={wire.location} sessionId="same" /> : <ChatInput />}</RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></QueryClientProvider>));
  try {
    const focus = vi.spyOn(HTMLTextAreaElement.prototype, 'focus');
    await render(false);
    const local = node.querySelector('textarea')!;
    expect(local.value).toBe(archive.before.value);
    local.focus(); local.setSelectionRange(archive.before.start, archive.before.end);
    // A normal sidebar click moves focus away before it unmounts the editor.
    local.blur();
    await render(true);
    expect(node.querySelector('textarea')!.value).toBe(archive.remote.value);
    focus.mockClear();
    await render(false);
    const returned = node.querySelector('textarea')!;
    expect(returned).not.toBe(local);
    expect(returned.value).toBe(archive.after.value);
    expect([returned.selectionStart, returned.selectionEnd]).toEqual([archive.before.start, archive.before.end]);
    // Existing desktop session-entry focus is still the only focus writer.
    // Outer sidebar focus choreography is not modeled by this mounted seam.
    expect(focus).toHaveBeenCalledOnce();
    focus.mockRestore();
    expect(useInputStore.getState().getDraft(key)?.text).toBe(archive.before.value);
  } finally { await act(async () => root.unmount()); client.clear(); wire.close(); node.remove(); }
}, 20_000);

test.each([
  { intent: false, focused: true, range: [6, 21] },
  { intent: true, focused: false, range: [6, 21] },
  { intent: true, focused: true, range: [6, 21] },
  { intent: true, focused: true, range: [3, 5] },
])('restored local composer survives switch intent and second remount ($intent/$focused/$range)', async ({ intent, focused, range }) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.wire = true;
  const wire = wireHarness();
  const sessionID = selectionArchive.sessionID;
  const key = sessionDraftKey({ transportIdentity: getRuntimeTransportIdentity() }, sessionID);
  useSessionUIStore.setState({ currentSessionId: sessionID, currentSessionDirectory: '/repo' });
  useInputStore.getState().setDraftText(key, selectionArchive.before.value);
  const record = useInputStore.getState().getDraft(key);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const runtime = { runtime: { isWeb: true, isDesktop: false, isVSCode: false, isMobile: false, platform: 'web' } } as unknown as RuntimeAPIs;
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const render = async (owner: 'initial' | 'remote' | 'returned' | 'committed') => act(async () => root.render(
    <QueryClientProvider client={client}><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}>
      {owner === 'remote' ? <RemoteChatContainer location={wire.location} sessionId="same" /> : <ChatInput key={owner} />}
    </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></QueryClientProvider>,
  ));
  const selection = window.getSelection()!;
  const removeAllRanges = selection.removeAllRanges.bind(selection);
  // happy-dom lacks Chromium's focused-textarea Selection interaction. The
  // isolated browser control records 6–21 → removeAllRanges 0–0 → blur 6–21.
  const clear = vi.spyOn(selection, 'removeAllRanges').mockImplementation(() => {
    removeAllRanges();
    const active = document.activeElement;
    if (active instanceof HTMLTextAreaElement) active.setSelectionRange(0, 0);
  });
  try {
    await render('initial');
    const original = node.querySelector('textarea')!;
    original.setSelectionRange(6, 21, 'forward'); original.blur();
    await render('remote');
    await render('returned');
    const returned = node.querySelector('textarea')!;
    expect([returned.selectionStart, returned.selectionEnd]).toEqual([6, 21]);
    if (focused) returned.focus(); else returned.blur();
    returned.setSelectionRange(range[0], range[1], 'forward');
    clear.mockClear();
    if (intent) announceSessionSwitchIntent(sessionID);
    await render('committed');
    const committed = node.querySelector('textarea')!;
    expect(committed).not.toBe(returned);
    expect(committed.value).toBe(selectionArchive.before.value);
    expect(useInputStore.getState().getDraft(key)).toBe(record);
    expect([committed.selectionStart, committed.selectionEnd]).toEqual(range);
    expect(clear).toHaveBeenCalledTimes(intent && !focused ? 1 : 0);
  } finally {
    clear.mockRestore(); await act(async () => root.unmount()); client.clear(); wire.close(); node.remove();
  }
}, 20_000);

test.each([false, true].flatMap((mobile) => (['allow', 'ask', 'deny'] as const).map((effect) => ({ mobile, effect }))))('remote permission shield uses Host agent authority before opening pickers ($mobile/$effect)', async ({ mobile, effect }) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.wire = true;
  const wire = wireHarness('created', false, effect);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const runtime = { runtime: { isWeb: !mobile, isDesktop: false, isVSCode: false, isMobile: mobile, platform: mobile ? 'ios' : 'web' } } as unknown as RuntimeAPIs;
  useUIStore.setState({ isMobile: mobile, isModelSelectorOpen: false, isAgentSelectorOpen: false });
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}><RemoteChatContainer location={wire.location} sessionId="same" /></RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></QueryClientProvider>));
    await vi.waitFor(() => expect(wire.requests.filter((request) => request.path.endsWith('/agent') && request.method === 'GET')).toHaveLength(1));
    const shield = () => node.querySelector('button use[href="#yuri-shield"]')?.closest('button');
    if (effect === 'ask') {
      await vi.waitFor(() => expect(shield()).toBeDefined());
      await act(async () => shield()!.click());
      await vi.waitFor(() => expect(node.querySelector('button use[href="#yuri-shield-check"]')).not.toBeNull());
      expect(wire.requests.find((request) => request.method === 'PUT' && request.path.includes('permission-auto-accept'))).toMatchObject({
        path: '/api/hosts/host/api/permission-auto-accept/sessions/same', body: { enabled: true, directory: '/repo' },
      });
    } else {
      await vi.waitFor(() => expect(shield()).toBeUndefined());
      expect(node.querySelector('button use[href="#yuri-shield-check"]')).toBeNull();
    }
    expect(wire.requests.filter((request) => request.path.endsWith('/config/catalog/providers'))).toHaveLength(0);
    if (effect === 'allow') {
      await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}><RemoteChatContainer location={{ ...wire.location, hostId: 'hostB' }} sessionId="same" /></RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></QueryClientProvider>));
      await vi.waitFor(() => expect(shield()).toBeDefined());
      expect(wire.requests.filter((request) => request.path.startsWith('/api/hosts/hostB/') && request.path.endsWith('/agent') && request.method === 'GET')).toHaveLength(1);
    }
  } finally { await act(async () => root.unmount()); useUIStore.setState({ isMobile: false }); client.clear(); wire.close(); node.remove(); }
}, 20_000);

test('real remote pane and ChatInput keep catalogs lazy through typing and picker open/close', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.providerReads = 0; fixture.agentReads = 0; fixture.modelEnumerations = 0;
  fixture.wire = false;
  useUIStore.setState({ isMobile: false, isModelSelectorOpen: false, isAgentSelectorOpen: false });
  useProjectsStore.setState({ projects: Array.from({ length: 300 }, (_, index) => ({ id: `project-${index}`, path: `/projects/${index}` })), activeProjectId: null });
  const wire = wireHarness();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const runtime = { runtime: { isWeb: true, isDesktop: false, isVSCode: false, isMobile: false, platform: 'web' } } as unknown as RuntimeAPIs;
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}><RemoteChatContainer location={{ hubId: 'hub', hostId: 'host', directory: '/repo' }} sessionId="same" /></RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></QueryClientProvider>));
    const textarea = node.querySelector('textarea')!;
    expect(textarea).not.toBeNull();
    await vi.waitFor(() => expect(fixture.agentReads).toBe(1));
    expect(fixture.providerReads).toBe(0);
    expect(fixture.modelEnumerations).toBe(0);
    const setText = (text: string) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text); textarea.dispatchEvent(new Event('input', { bubbles: true })); };
    for (let index = 0; index < 50; index++) await act(async () => setText(`draft ${index}`));
    expect(fixture.providerReads).toBe(0); expect(fixture.agentReads).toBe(1);
    await act(async () => useUIStore.getState().setModelSelectorOpen(true));
    await vi.waitFor(() => expect(fixture.providerReads).toBe(1));
    await act(async () => useUIStore.getState().setModelSelectorOpen(false));
    const modelEnumerations = fixture.modelEnumerations;
    for (let index = 50; index < 100; index++) await act(async () => setText(`draft ${index}`));
    expect(fixture.providerReads).toBe(1); expect(fixture.agentReads).toBe(1);
    expect(fixture.modelEnumerations).toBe(modelEnumerations);
    expect(node.querySelector('textarea')).toBe(textarea);
    const location = { hubId: 'hub', hostId: 'host', directory: '/repo' };
    expect(getRemoteInputStore(location).getState().getDraft(remoteSessionDraftKey(location, 'same'))?.text).toBe('draft 99');
    expect(wire.requests.some((request) => request.path.endsWith('/session/active'))).toBe(true);
    expect(node.textContent).not.toContain('Remote session status unavailable');
  } finally { await act(async () => root.unmount()); client.clear(); wire.close(); node.remove(); }
}, 20_000);

test.each([false, true])('raw catalog default → real picker (%s) → create → applySendSelection → prompt', async (pickModel) => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.wire = true;
  const createdID = pickModel ? 'created-picker' : 'created-default';
  const wire = wireHarness(createdID);
  useProjectsStore.setState({ projects: [{ id: 'remote', path: '/repo', hubId: 'hub', hostId: 'host' }], activeProjectId: 'remote' });
  useSessionNavigationStore.getState().openRemoteSession({ id: 'remote', path: '/repo', hostId: 'host' }, wire.location, null);
  getRemoteInputStore(wire.location).getState().setDraftText(remoteSessionDraftKey(wire.location, null), '');
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const runtime = { runtime: { isWeb: true, isDesktop: false, isVSCode: false, isMobile: false, platform: 'web' } } as unknown as RuntimeAPIs;
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  function Pane() {
    const remote = useSessionNavigationStore((state) => state.remoteSession);
    return <RemoteChatContainer location={wire.location} sessionId={remote?.sessionId ?? null} />;
  }
  try {
    await act(async () => root.render(<QueryClientProvider client={client}><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}><Pane /></RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></QueryClientProvider>));
    expect(wire.requests.filter((request) => request.path.endsWith('/config/catalog/providers'))).toHaveLength(0);
    if (pickModel) {
      await act(async () => useUIStore.getState().setModelSelectorOpen(true));
      await vi.waitFor(() => expect(document.body.textContent).toContain('GPT-4.1 Mini'));
      const row = Array.from(document.body.querySelectorAll<HTMLElement>('[role="option"]')).find((element) => element.textContent?.includes('GPT-4.1 Mini'));
      expect(row).toBeDefined();
      await act(async () => row!.click());
      await act(async () => useUIStore.getState().setModelSelectorOpen(false));
    }
    const textarea = node.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Wire first message');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    if (pickModel) await act(async () => {
      const input = getRemoteInputStore(wire.location).getState();
      const key = remoteSessionDraftKey(wire.location, null);
      expect(input.addDraftDurableAttachment(key, { attachmentID: 'wire-context', filename: 'context.txt', mimeType: 'text/plain', size: 4, source: 'server', serverPath: '/context.txt', url: 'https://files.example/context.txt' })).toBeDefined();
      input.setDraftSyntheticParts(key, [{ partID: 'wire-synthetic', text: 'Synthetic wire context', synthetic: true, attachments: [] }]);
    });
    const submit = node.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(submit).not.toBeNull();
    if (pickModel) {
      wire.failModel();
      const failedDelivery = vi.spyOn(toast, 'error');
      failedDelivery.mockClear();
      await act(async () => submit!.click());
      await vi.waitFor(() => expect(failedDelivery).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ description: expect.stringMatching(/Model unavailable|503/) })));
      expect(wire.requests.some((request) => request.path.endsWith('/prompt'))).toBe(false);
      expect(getRemoteInputStore(wire.location).getState().getDraft(remoteSessionDraftKey(wire.location, createdID))?.text).toBe('Wire first message');
      expect(getRemoteInputStore(wire.location).getState().getDraftAttachmentViews(remoteSessionDraftKey(wire.location, createdID)).map((file) => file.filename)).toEqual(['context.txt']);
      expect(getRemoteInputStore(wire.location).getState().getDraft(remoteSessionDraftKey(wire.location, createdID))?.syntheticParts).toMatchObject([{ partID: 'wire-synthetic', text: 'Synthetic wire context' }]);
      wire.restoreModel();
      failedDelivery.mockRestore();
    }
    await act(async () => node.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await vi.waitFor(() => expect(wire.requests.some((request) => request.path.endsWith('/prompt'))).toBe(true));
    const create = wire.requests.findIndex((request) => request.path.endsWith('/session') && request.method === 'POST');
    const model = wire.requests.findIndex((request) => request.path.endsWith('/model') && request.method === 'POST');
    const prompt = wire.requests.findIndex((request) => request.path.endsWith('/prompt'));
    expect(create).toBeGreaterThanOrEqual(0); expect(model).toBeGreaterThan(create); expect(prompt).toBeGreaterThan(model);
    expect(wire.requests[model].body).toEqual({ model: { providerID: 'openai', id: pickModel ? 'gpt-4.1-mini' : 'gpt-4.1' } });
    expect(wire.requests[prompt].body).toMatchObject({ text: pickModel ? 'Wire first message\n\nSynthetic wire context' : 'Wire first message', delivery: 'steer' });
    if (pickModel) expect(wire.requests[prompt].body).toMatchObject({ files: [{ uri: 'file:///context.txt', name: 'context.txt' }] });
    expect(wire.requests.filter((request) => request.path.endsWith('/session') && request.method === 'POST')).toHaveLength(1);
    expect(wire.requests.some((request) => request.path.includes('remote-new-session') || request.path.endsWith('/session/status'))).toBe(false);
    expect(getRemoteInputStore(wire.location).getState().getDraft(remoteSessionDraftKey(wire.location, createdID))?.text).toBe('');
    await act(async () => requestRemoteComposerInput({ ...wire.location, hostId: 'other' }, createdID, { text: 'wrong Host', mode: 'replace' }));
    expect(node.querySelector('textarea')?.value).toBe('');
    await act(async () => requestRemoteComposerInput(wire.location, createdID, { text: 'inserted remotely', mode: 'replace' }));
    await vi.waitFor(() => expect(node.querySelector('textarea')?.value).toBe('inserted remotely'));
    const promptCount = wire.requests.filter((request) => request.path.endsWith('/prompt')).length;
    await act(async () => requestRemotePresetSubmit(wire.location, createdID, 'preset through real composer'));
    await vi.waitFor(() => expect(wire.requests.filter((request) => request.path.endsWith('/prompt'))).toHaveLength(promptCount + 1));
    expect(wire.requests.filter((request) => request.path.endsWith('/prompt')).at(-1)?.body).toMatchObject({ text: 'preset through real composer\ninserted remotely' });
  } finally {
    await act(async () => root.unmount()); client.clear(); wire.close(); node.remove(); useSessionNavigationStore.getState().clearRemoteSession();
  }
});

test('real remote @ picker isolates 300-entry Host catalogs, stays idle when closed, and delivers references on that Host', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  fixture.wire = true;
  const sessionID = 'mention-session';
  const wire = wireHarness(sessionID, true);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const runtime = { runtime: { isWeb: true, isDesktop: false, isVSCode: false, isMobile: false, platform: 'web' } } as unknown as RuntimeAPIs;
  const rows = vi.spyOn(autocomplete, 'buildMentionRows');
  const failures = vi.spyOn(toast, 'error'); failures.mockClear();
  const node = document.createElement('div'); document.body.append(node); const root = createRoot(node);
  const render = async (hostId: string) => act(async () => root.render(<QueryClientProvider client={client}><I18nProvider><ThemeSystemProvider><RuntimeAPIContext.Provider value={runtime}>
    <RemoteChatContainer location={{ ...wire.location, hostId }} sessionId={sessionID} />
  </RuntimeAPIContext.Provider></ThemeSystemProvider></I18nProvider></QueryClientProvider>));
  const type = async (value: string) => act(async () => {
    const textarea = node.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value);
    textarea.selectionStart = textarea.selectionEnd = value.length;
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const close = async () => act(async () => node.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  try {
    for (const hostId of ['host', 'hostB']) {
      const location = { ...wire.location, hostId };
      await getRemoteInputStore(location).getState().replaceDraftRootAttachments(remoteSessionDraftKey(location, sessionID), []);
    }
    getRemoteInputStore(wire.location).getState().setDraftText(remoteSessionDraftKey(wire.location, sessionID), '');
    await render('host');
    rows.mockClear();
    for (let i = 0; i < 50; i++) await type(`plain ${i}`);
    expect(rows).not.toHaveBeenCalled();
    expect(wire.requests.filter((request) => request.path.endsWith('/summaries'))).toHaveLength(0);
    await type('@agent-A-2');
    await vi.waitFor(() => expect(document.body.textContent).toContain('agent-A-2'));
    expect(document.body.textContent).not.toContain('agent-B-2');
    await close(); await type('closed');
    const reads = wire.requests.length; rows.mockClear();
    for (let i = 0; i < 50; i++) await type(`closed ${i}`);
    expect(rows).not.toHaveBeenCalled(); expect(wire.requests).toHaveLength(reads);
    await render('hostB');
    await type('@Session');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Session B 2'));
    expect(document.body.textContent).not.toContain('Session A 2');
    const sessionRow = document.body.querySelector<HTMLElement>('[data-mention-id="session:reference-2"]');
    expect(sessionRow).not.toBeNull();
    await act(async () => sessionRow!.click());
    await vi.waitFor(() => expect(node.querySelector('textarea')!.value).toContain('Session B 2'));
    expect(wire.requests.some((request) => request.path === '/api/hosts/hostB/api/session/reference-2')).toBe(true);
    await type(`${node.querySelector('textarea')!.value} @src`);
    await vi.waitFor(() => expect(document.body.querySelector('[data-mention-id="file:/repo/src/B.ts"]')).not.toBeNull());
    expect(document.body.textContent).not.toContain('src/A.ts');
    await act(async () => document.body.querySelector<HTMLElement>('[data-mention-id="file:/repo/src/B.ts"]')!.click());
    await type(`${node.querySelector('textarea')!.value} @skill-B-2`);
    await vi.waitFor(() => expect(document.body.querySelector('[data-mention-id="skill:skill-B-2-user"]')).not.toBeNull());
    await act(async () => document.body.querySelector<HTMLElement>('[data-mention-id="skill:skill-B-2-user"]')!.click());
    await type(`${node.querySelector('textarea')!.value} @agent-B-2 `);
    await act(async () => node.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(failures.mock.calls, JSON.stringify(wire.requests.slice(-8))).toEqual([]);
    await vi.waitFor(() => expect({ sent: wire.requests.some((request) => request.path === `/api/hosts/hostB/api/session/${sessionID}/prompt`), failures: failures.mock.calls }).toMatchObject({ sent: true }));
    const prompt = wire.requests.filter((request) => request.path.endsWith('/prompt')).at(-1)!;
    expect(prompt.body?.text).toContain('/other-remote-cwd');
    expect(prompt.body?.text).toContain('Session B 2');
    expect(prompt.body?.text).not.toContain('Session A');
    expect(prompt.body).toMatchObject({ agents: [{ name: 'agent-B-2' }], skills: [{ id: 'skill-B-2' }], files: [{ uri: 'file:///repo/src/B.ts', name: 'B.ts' }] });
    await type('/\u2003review args');
    await act(async () => node.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
    await vi.waitFor(() => expect(wire.requests.some((request) => request.path === `/api/hosts/hostB/api/session/${sessionID}/command`)).toBe(true));
    expect(wire.requests.filter((request) => request.path.endsWith('/command')).at(-1)?.body).toMatchObject({ name: 'review', text: 'args' });
  } finally { rows.mockRestore(); failures.mockRestore(); await act(async () => root.unmount()); client.clear(); wire.close(); node.remove(); }
}, 20_000);
