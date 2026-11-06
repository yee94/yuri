import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { openMobileGuiNetwork } from './mobile-network';

const fixture = vi.hoisted(() => ({
  native: true, supported: true, generation: 1, ready: {} as Record<string, unknown>,
  event: null as null | ((event: Record<string, unknown>) => void),
  changed: null as null | (() => void),
  scope: '', socket: null as RelayTunnelWebSocket | null,
  start: vi.fn(), stop: vi.fn(), send: vi.fn(), remove: vi.fn(), wire: vi.fn(), closeTunnel: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => fixture.native, isPluginAvailable: () => true },
  registerPlugin: () => ({
    capabilities: async () => ({ supported: fixture.supported }),
    start: (...args: unknown[]) => fixture.start(...args),
    stop: (...args: unknown[]) => fixture.stop(...args),
    send: (...args: unknown[]) => fixture.send(...args),
    addListener: async (_name: string, listener: typeof fixture.event) => { fixture.event = listener; return { remove: fixture.remove }; },
  }),
}));
vi.mock('@/lib/relay/runtime-tunnel', () => ({
  getActiveRelayDescriptor: () => ({ relayUrl: 'wss://relay.example/ws' }),
}));
vi.mock('@/lib/relay/tunnel-client', () => ({ createRelayTunnelClient: () => ({ openWebSocket: (...args: unknown[]) => fixture.wire(...args), close: fixture.closeTunnel }) }));
vi.mock('./mobile-network-wire', () => ({ createMobileGuiWireFactory: async () => ({ createWireSocket: vi.fn(), dispose: vi.fn() }) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => fixture.generation,
  subscribeRuntimeEndpointChanged: (callback: () => void) => { fixture.changed = callback; return () => { fixture.changed = null; }; },
}));
vi.mock('@/lib/runtime-auth', () => ({ refreshRuntimeUrlAuthToken: async () => 'scoped-fixture', subscribeRuntimeAuthGeneration: () => () => {} }));
vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ websocket: (path: string) => `ws://runtime.invalid${path}?yuri_url_token=scoped-fixture` }) }));

const controllers: AbortController[] = [];
const signal = () => { const controller = new AbortController(); controllers.push(controller); return controller.signal; };
const emit = (type: string, extra = {}) => fixture.event?.({ type, scope: fixture.scope, id: 1, ...extra });
const incoming = (value: unknown) => fixture.socket!.onmessage?.({ data: JSON.stringify(value) });
beforeEach(() => {
  fixture.native = true; fixture.supported = true; fixture.generation = 1;
  fixture.ready = { type: 'ready', version: 1 };
  fixture.event = null; fixture.changed = null;
  fixture.start.mockReset().mockImplementation(async ({ scope }: { scope: string }) => { fixture.scope = scope; });
  fixture.stop.mockReset().mockResolvedValue(undefined);
  fixture.send.mockReset().mockResolvedValue(undefined);
  fixture.remove.mockReset().mockResolvedValue(undefined);
  fixture.closeTunnel.mockReset();
  fixture.wire.mockReset().mockImplementation(() => {
    const socket: RelayTunnelWebSocket = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null,
      send: vi.fn(), close: vi.fn() };
    fixture.socket = socket;
    queueMicrotask(() => socket.onmessage?.({ data: JSON.stringify(fixture.ready) }));
    return socket;
  });
});

it.each(['http://localhost:4567', 'http://localhost:4567/'])('accepts the authenticated Host HTTP origin %s', async httpOrigin => {
  fixture.ready.httpOrigin = httpOrigin;
  const network = await openMobileGuiNetwork(signal(), vi.fn());
  expect(network.hostOrigin).toBe('http://localhost:4567');
  await network.release();
});

it.each([null, 4000, 'https://localhost:4000', 'http://127.0.0.1:4000', 'http://elsewhere.example',
  'http://user@localhost:4000', 'http://localhost:4000/path', 'http://localhost:4000/?token=x', 'http://localhost:4000/x/..'])('rejects an invalid Host origin %s and restores the native gateway', async httpOrigin => {
  fixture.ready.httpOrigin = httpOrigin;
  await expect(openMobileGuiNetwork(signal(), vi.fn())).rejects.toThrow('unsupported_host');
  expect(fixture.stop).toHaveBeenCalledOnce();
});
afterEach(async () => {
  for (const controller of controllers) controller.abort();
  controllers.length = 0;
  await new Promise(resolve => setTimeout(resolve, 0));
});

it('requires native proxy support and never opens a direct socket as a fallback', async () => {
  fixture.native = false;
  await expect(openMobileGuiNetwork(signal(), vi.fn())).rejects.toThrow('unsupported');
  fixture.native = true; fixture.supported = false;
  await expect(openMobileGuiNetwork(signal(), vi.fn())).rejects.toThrow('unsupported');
  expect(fixture.start).not.toHaveBeenCalled();
  expect(fixture.wire).not.toHaveBeenCalled();
});

it('carries binary bytes and returns credit only after native output has consumed them', async () => {
  const owner = await openMobileGuiNetwork(signal(), vi.fn());
  expect(fixture.wire).toHaveBeenCalledWith('/api/gui-network/ws?yuri_url_token=scoped-fixture');
  emit('open', { hostname: 'plugin.example', port: 443 });
  incoming({ type: 'opened', id: 1 });
  await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledWith(expect.objectContaining({ id: 1, type: 'opened' })));
  emit('data', { data: btoa('opaque TLS bytes') });
  const upstream = vi.mocked(fixture.socket!.send).mock.calls.find(call => call[0] instanceof Uint8Array)![0] as Uint8Array;
  expect(new DataView(upstream.buffer).getUint32(0)).toBe(1);
  expect(new TextDecoder().decode(upstream.subarray(4))).toBe('opaque TLS bytes');
  let consumed!: () => void;
  fixture.send.mockImplementationOnce(() => new Promise<void>(resolve => { consumed = resolve; }));
  const downstream = new Uint8Array([0, 0, 0, 1, 1, 2, 255]);
  fixture.socket!.onmessage?.({ data: downstream.buffer });
  await vi.waitFor(() => expect(consumed).toBeDefined());
  expect(fixture.socket!.send).not.toHaveBeenCalledWith('{"type":"credit","id":1,"bytes":3}');
  consumed();
  await vi.waitFor(() => expect(fixture.socket!.send).toHaveBeenCalledWith('{"type":"credit","id":1,"bytes":3}'));
  await owner.release();
  expect(fixture.stop).toHaveBeenCalledExactlyOnceWith({ scope: fixture.scope });
});

it('keeps a failed proxy in place until the mounted view is disposed, and rejects stale callbacks', async () => {
  const failure = vi.fn();
  const owner = await openMobileGuiNetwork(signal(), failure);
  emit('open', { hostname: 'plugin.example', port: 443 });
  fixture.generation++;
  fixture.changed?.();
  expect(failure).toHaveBeenCalledOnce();
  expect(fixture.closeTunnel).toHaveBeenCalledOnce();
  expect(fixture.stop).not.toHaveBeenCalled();
  const writes = vi.mocked(fixture.socket!.send).mock.calls.length;
  emit('data', { data: btoa('late') });
  expect(vi.mocked(fixture.socket!.send).mock.calls.length).toBe(writes);
  await owner.release();
  expect(fixture.stop).toHaveBeenCalledOnce();
});

it('waits for restoration before starting another page lease', async () => {
  const first = await openMobileGuiNetwork(signal(), vi.fn());
  let restored!: () => void;
  fixture.stop.mockImplementationOnce(() => new Promise<void>(resolve => { restored = resolve; }));
  const closing = first.release();
  const next = openMobileGuiNetwork(signal(), vi.fn());
  await vi.waitFor(() => expect(restored).toBeDefined());
  expect(fixture.start).toHaveBeenCalledOnce();
  restored(); await closing;
  const second = await next;
  expect(fixture.start).toHaveBeenCalledTimes(2);
  await second.release();
});

it('still restores the native proxy when listener removal fails, with one shared release completion', async () => {
  const owner = await openMobileGuiNetwork(signal(), vi.fn());
  fixture.remove.mockRejectedValueOnce(new Error('listener removal failed'));
  const first = owner.release();
  expect(owner.release()).toBe(first);
  await expect(first).rejects.toThrow('listener removal failed');
  expect(fixture.stop).toHaveBeenCalledOnce();
  const next = await openMobileGuiNetwork(signal(), vi.fn());
  await next.release();
});

it('drains a cancelled native start before restoring, without exposing a ready lease', async () => {
  let started!: () => void;
  fixture.start.mockImplementationOnce(() => new Promise<void>(resolve => { started = resolve; }));
  const controller = new AbortController();
  const opening = openMobileGuiNetwork(controller.signal, vi.fn());
  await vi.waitFor(() => expect(started).toBeDefined());
  controller.abort();
  expect(fixture.stop).not.toHaveBeenCalled();
  started();
  await expect(opening).rejects.toMatchObject({ name: 'AbortError' });
  expect(fixture.stop).toHaveBeenCalledOnce();
});

it('removes the startup abort listener on handshake timeout', async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  fixture.wire.mockImplementationOnce(() => {
    const socket: RelayTunnelWebSocket = { readyState: 1, onopen: null, onclose: null, onerror: null, onmessage: null, send: vi.fn(), close: vi.fn() };
    return socket;
  });
  try {
    const opening = openMobileGuiNetwork(controller.signal, vi.fn());
    const rejected = expect(opening).rejects.toThrow('relay_unavailable');
    await vi.advanceTimersByTimeAsync(20001);
    await rejected;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  } finally { vi.useRealTimers(); }
});
