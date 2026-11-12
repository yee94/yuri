import { QueryClient } from '@tanstack/react-query';
import React, { act, useContext } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { HostRuntimeProvider } from '@/contexts/hostRuntimeProviderView';
import { HostRuntimeContext } from '@/contexts/hostRuntimeContext';
import { getLocationOpencodeClient, opencodeClient } from '@/lib/opencode/client';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { parseYuriEventEnvelope, subscribeYuriEvents } from '@/lib/yuriEvents';
import { createEventPipeline } from './event-pipeline';
import { createRemoteSessionState } from './remote-session-state';
import { createMemoryTranscriptDurableStore } from './transcript-durable-store';
import capture from './fixtures/remote-final-native-capture.json';

type Socket = { onmessage: ((event: { data: string }) => void) | null; onopen: (() => void) | null;
  onclose: (() => void) | null; onerror: (() => void) | null; close: () => void; send: () => void; readyState: number };
const wire = vi.hoisted(() => ({ sockets: [] as Socket[], ssePaths: [] as string[] }));
vi.mock('@/lib/relay/runtime-socket', () => ({ openRuntimeWebSocket: () => {
  const socket: Socket = { onmessage: null, onopen: null, onclose: null, onerror: null, close: () => {}, send: () => {}, readyState: 1 };
  wire.sockets.push(socket); return socket;
} }));
vi.mock('@/lib/runtime-sse', () => ({ consumeRuntimeSse: (path: string, options: { signal: AbortSignal }) => {
  wire.ssePaths.push(path);
  return new Promise<void>((resolve) => { options.signal.addEventListener('abort', () => resolve(), { once: true }); });
} }));
vi.mock('@/lib/runtime-auth', async (original) => ({ ...await original<object>(), refreshRuntimeUrlAuthToken: async () => undefined }));

type Envelope = { type: string; properties: Record<string, unknown> };
const envelopes: Envelope[] = capture.envelopes;
afterEach(() => { wire.sockets.length = 0; wire.ssePaths.length = 0; });

it('does not broadcast global ready as product stream ready to local-only refresh consumers', async () => {
  const previous = getRuntimeUrlResolver(); configureRuntimeUrlResolver({ apiBaseUrl: 'https://capture-local.example' });
  const localRefresh = vi.fn();
  const observed: string[] = [];
  const stop = subscribeYuriEvents((event) => {
    observed.push(event.type);
    if (event.type === 'event-stream-ready') localRefresh();
  });
  const pipeline = createEventPipeline({ sdk: opencodeClient.getSdkClient(), transport: 'ws', onEvent: vi.fn() });
  try {
    await vi.waitFor(() => expect(wire.sockets).toHaveLength(1));
    wire.sockets[0].onmessage!({ data: JSON.stringify({ type: 'ready', scope: 'global' }) });
    expect(observed).toEqual(['global-event-stream-ready']);
    expect(localRefresh).not.toHaveBeenCalled();
    expect(wire.ssePaths).toEqual(['/api/yuri/events']);
    expect(parseYuriEventEnvelope({ type: 'yuri:global-event-stream-ready', properties: [] })).toBeNull();
  } finally {
    pipeline.cleanup(); stop(); setRuntimeUrlResolver(previous);
  }
});

it('renders the actual archived native text stream through Hub event parser, registry and production remote transcript consumer without history reload', async () => {
  const first = envelopes.find((envelope) => (envelope.properties.payload as { type?: string })?.type === 'session.text.started')!;
  const payload = first.properties.payload as { location: { directory: string }; data: { sessionID: string; assistantMessageID: string } };
  const location = { hubId: String(first.properties.hubId), hostId: String(first.properties.hostId), directory: payload.location.directory };
  const sessionID = payload.data.sessionID;
  const connection = envelopes.find((envelope) => envelope.type === 'yuri:host-status'
    && (envelope.properties.host as { generation?: string; state?: string })?.generation === first.properties.generation
    && (envelope.properties.host as { state?: string }).state === 'connected')!;
  const previous = getRuntimeUrlResolver(); configureRuntimeUrlResolver({ apiBaseUrl: 'https://capture-hub.example' });
  const requests: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname; requests.push(path);
    if (path.endsWith('/subscriptions')) return Response.json({ id: 'capture-lease' });
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (path.endsWith(`/session/${sessionID}`)) return Response.json({ data: { id: sessionID, projectID: 'captured-project', title: 'Captured session', location: { directory: location.directory }, cost: 0, tokens: {}, time: { created: 1, updated: 2 } } });
    if (path.endsWith('/session/active')) return Response.json({ data: {} });
    return Response.json({ data: [] });
  }));
  const registry = new HostRuntimeRegistry(location.hubId, { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true,
    fetch: runtimeFetch, sdk: (target, fence, scope) => getLocationOpencodeClient(target, fence, scope).getSdkClient(), service: getLocationOpencodeClient });
  registry.ingest(connection);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const state = createRemoteSessionState(registry, location, { client, durableStore: createMemoryTranscriptDurableStore() });
  const errors: unknown[] = [];
  const stop = state.observe(sessionID, (error) => errors.push(error));
  const pipeline = createEventPipeline({ sdk: state.entry.sdk(), transport: 'ws', onEvent: () => {} });
  try {
    await state.repository.refreshFromAuthority(state.scope(sessionID));
    const baselineReads = requests.filter((path) => path.endsWith('/message')).length;
    const replay = envelopes.filter((envelope) => envelope.type === 'yuri:host-event'
      && envelope.properties.generation === first.properties.generation);
    expect(replay.some((envelope) => (envelope.properties.payload as { type?: string })?.type === 'session.text.ended')).toBe(true);
    await vi.waitFor(() => expect(wire.sockets.length).toBe(1));
    const socket = wire.sockets[0];
    socket.onmessage!({ data: JSON.stringify({ type: 'ready', scope: 'global' }) });
    let firstDelta = false;
    for (const envelope of replay) {
      const event = parseYuriEventEnvelope(envelope);
      expect(event).not.toBeNull();
      socket.onmessage!({ data: JSON.stringify({ type: 'event', payload: envelope }) });
      if (!firstDelta && (envelope.properties.payload as { type?: string })?.type === 'session.text.delta') {
        firstDelta = true;
        expect(state.repository.getParts(state.scope(sessionID), payload.data.assistantMessageID).some((part) => part.type === 'text' && part.text === 'Remote fixture s')).toBe(true);
        expect(requests.filter((path) => path.endsWith('/message'))).toHaveLength(baselineReads);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    const transcript = state.repository.getTranscript(state.scope(sessionID));
    expect(transcript.messageOrder, JSON.stringify({ errors: errors.map(String), messages: transcript.messageOrder })).toContain(payload.data.assistantMessageID);
    expect(state.repository.getParts(state.scope(sessionID), payload.data.assistantMessageID).some((part) => part.type === 'text'
      && part.text === 'Remote fixture streamed reply. End-to-end real OpenCode generation complete.')).toBe(true);
    expect(firstDelta).toBe(true);
  } finally {
    pipeline.cleanup(); stop(); state.dispose(); registry.dispose(); client.clear(); vi.unstubAllGlobals(); setRuntimeUrlResolver(previous);
  }
});

it('keeps scope across archived connecting → connected and rebinds only on scope revocation while filtering stale wire frames', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const scopedStatus = (envelope: Envelope, scopeGeneration: string): Envelope => ({ ...envelope, properties: {
    ...envelope.properties, host: { ...envelope.properties.host as Record<string, unknown>, scopeGeneration },
  } });
  // The archived legacy frames retain their wire fields; project the new Host DTO scope contract separately.
  const connecting = scopedStatus(envelopes[0], 'scope-a');
  const connected = scopedStatus(envelopes[1], 'scope-a');
  const location = { hubId: String(connected.properties.hubId), hostId: String(connected.properties.hostId), directory: '/fixture/project' };
  const previous = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://capture-fence.example' });
  let finishOld!: (response: Response) => void;
  const network = vi.fn(async (path: string) => path.endsWith('/old-request')
    ? new Promise<Response>((resolve) => { finishOld = resolve; })
    : Response.json({ ok: true }));
  const registry = new HostRuntimeRegistry(location.hubId, { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true,
    fetch: network, sdk: (target, fence, scope) => getLocationOpencodeClient(target, fence, scope).getSdkClient(), service: getLocationOpencodeClient });
  registry.ingest(connecting);
  const old = registry.resolve(location);
  let current = old;
  function Pane() {
    current = useContext(HostRuntimeContext)!.entry;
    return React.createElement('span', null, String(current.connectionGeneration));
  }
  const container = document.createElement('div'); document.body.append(container);
  const root = createRoot(container);
  const localReducer = vi.fn();
  const pipeline = createEventPipeline({ sdk: old.sdk(), transport: 'ws', onEvent: localReducer });
  try {
    await act(async () => root.render(React.createElement(HostRuntimeProvider, { registry, location, children: React.createElement(Pane) })));
    await vi.waitFor(() => expect(wire.sockets).toHaveLength(1));
    const socket = wire.sockets[0];
    const pending = old.fetch('/api/old-request');
    await act(async () => {
      socket.onmessage!({ data: JSON.stringify({ type: 'ready', scope: 'global' }) });
      socket.onmessage!({ data: JSON.stringify({ type: 'event', payload: connected, directory: 'global' }) });
    });
    expect(current).toBe(old);
    expect(container.textContent).toBe(String(current.connectionGeneration));
    finishOld(Response.json({ ok: true }));
    await expect(pending).resolves.toBeInstanceOf(Response);
    expect(() => old.sdk()).not.toThrow();
    const revoked = old.fetch('/api/old-request');
    const rejected = expect(revoked).rejects.toThrow('Remote Host connection changed during request');
    const changed = scopedStatus(connected, 'scope-b');
    changed.properties.host = { ...changed.properties.host as Record<string, unknown>, generation: 'new-scope-wire' };
    await act(async () => socket.onmessage!({ data: JSON.stringify({ type: 'event', payload: changed, directory: 'global' }) }));
    expect(current).not.toBe(old);
    expect(current.connectionGeneration).toBe(old.connectionGeneration + 1);
    finishOld(Response.json({ ok: true }));
    await rejected;
    await expect(current.fetch('/api/new-request')).resolves.toBeInstanceOf(Response);
    expect(() => old.sdk()).toThrow('Remote Host connection changed during request');
    expect(() => current.sdk()).not.toThrow();
    const accepted = vi.fn(); const stop = registry.subscribeEvents(location.hostId, accepted);
    const text = envelopes.find((envelope) => (envelope.properties.payload as { type?: string })?.type === 'session.text.delta')!;
    for (const properties of [{ ...text.properties, hubId: 'other-hub', generation: 'new-scope-wire' }, text.properties, { ...text.properties, generation: 'new-scope-wire' }]) {
      socket.onmessage!({ data: JSON.stringify({ type: 'event', payload: { ...text, properties }, directory: 'global' }) });
    }
    expect(accepted).toHaveBeenCalledTimes(1);
    expect(localReducer).not.toHaveBeenCalled();
    expect(wire.sockets).toHaveLength(1);
    expect(wire.ssePaths).toEqual(['/api/yuri/events']);
    stop();
  } finally {
    pipeline.cleanup(); await act(async () => root.unmount()); container.remove(); registry.dispose(); setRuntimeUrlResolver(previous);
  }
});
