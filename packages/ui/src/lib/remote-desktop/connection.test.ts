import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { connectRemoteDesktop } from './connection';

const mock = vi.hoisted(() => ({
  auth: vi.fn(async () => {}), transport: 'host-a', generation: 1,
  changed: null as null | (() => void), socket: null as RelayTunnelWebSocket | null,
  open: vi.fn(),
}));
vi.mock('@/lib/runtime-auth', () => ({ refreshRuntimeUrlAuthToken: mock.auth }));
vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ websocket: () => 'ws://example.test/api/remote-desktop/ws?scoped=true' }) }));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeTransportIdentity: () => mock.transport, getRuntimeGeneration: () => mock.generation,
  subscribeRuntimeEndpointChanged: (callback: () => void) => { mock.changed = callback; return () => { mock.changed = null; }; },
}));
vi.mock('@/lib/relay/runtime-socket', () => ({ openRuntimeWebSocket: mock.open }));
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
beforeEach(() => {
  vi.useFakeTimers(); mock.transport = 'host-a'; mock.generation = 1;
  mock.auth.mockReset().mockResolvedValue(); mock.open.mockReset();
  mock.socket = { readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null, send: vi.fn(), close: vi.fn() };
  mock.open.mockReturnValue(mock.socket);
});
const connections: ReturnType<typeof connectRemoteDesktop>[] = [];
afterEach(() => { connections.splice(0).forEach(connection => connection.close()); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function setup() {
  const state = vi.fn();
  const video = document.createElement('video');
  const image = document.createElement('img');
  const connection = connectRemoteDesktop({ transport: 'host-a', generation: 1, video, image, onSize: vi.fn(), onState: state });
  connections.push(connection);
  return { connection, state, video, image };
}
it('waits for scoped auth, uses the runtime socket, and stops old-host input immediately on switching', async () => {
  const { connection, state } = setup();
  expect(mock.open).not.toHaveBeenCalled();
  await tick();
  expect(mock.open).toHaveBeenCalledWith('ws://example.test/api/remote-desktop/ws?scoped=true');
  mock.socket!.onopen!();
  connection.send({ type: 'key', key: 'Enter' });
  expect(mock.socket!.send).toHaveBeenCalledWith('{"type":"key","key":"Enter"}');
  mock.transport = 'host-b'; mock.generation++; mock.changed?.();
  expect(state).toHaveBeenLastCalledWith('closed', 'runtime_changed');
  const count = vi.mocked(mock.socket!.send).mock.calls.length;
  connection.send({ type: 'text', text: 'never send to host-b' });
  await vi.advanceTimersByTimeAsync(60000);
  expect(mock.socket!.send).toHaveBeenCalledTimes(count);
  expect(mock.socket!.close).toHaveBeenCalledTimes(1);
});
it('never opens a socket when auth resolves after unmount or an instance change', async () => {
  let resolve!: () => void;
  mock.auth.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  const { connection } = setup();
  connection.close(); resolve(); await tick();
  expect(mock.open).not.toHaveBeenCalled();
});
it('falls back once when WebRTC is unavailable, and only acknowledges decoded tunnel images', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:test-frame'; } static revokeObjectURL = vi.fn(); });
  const { connection, image } = setup();
  await tick();
  mock.socket!.onmessage!({ data: JSON.stringify({ type: 'offer', sdp: 'test' }) }); await tick();
  expect(mock.socket!.send).toHaveBeenCalledWith('{"type":"fallback"}');
  mock.socket!.onmessage!({ data: new ArrayBuffer(10) }); await tick();
  expect(mock.socket!.send).not.toHaveBeenCalledWith('{"type":"ack"}');
  image.dispatchEvent(new Event('load')); await tick();
  expect(mock.socket!.send).toHaveBeenCalledWith('{"type":"ack"}');
  connection.close();
});
it('limits the initial connection wait and surfaces server permission errors without retry storms', async () => {
  const { connection, state } = setup(); await tick();
  mock.socket!.onmessage!({ data: JSON.stringify({ type: 'error', code: 'permission_required' }) }); await tick();
  expect(state).toHaveBeenLastCalledWith('closed', 'permission_required');
  await vi.advanceTimersByTimeAsync(59999);
  expect(mock.open).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mock.open).toHaveBeenCalledTimes(2);
  connection.close();
});

it('reconnects after a Host restart with fresh scoped auth and never replays input or old socket callbacks', async () => {
  const { connection, state } = setup(); await tick();
  const old = mock.socket!;
  const lateMessage = old.onmessage!;
  connection.send({ type: 'text', text: 'one shot' });
  old.onclose!({ code: 1006, reason: '' }); await tick();
  const next = { ...old, send: vi.fn(), close: vi.fn() };
  mock.open.mockReturnValue(next);
  await vi.advanceTimersByTimeAsync(1000);
  expect(mock.auth).toHaveBeenCalledTimes(2);
  expect(mock.open).toHaveBeenCalledTimes(2);
  expect(next.send).not.toHaveBeenCalled();
  next.onmessage!({ data: JSON.stringify({ type: 'ready', width: 1920, height: 1080 }) }); await tick();
  lateMessage({ data: JSON.stringify({ type: 'error', code: 'permission_required' }) }); await tick();
  expect(state).toHaveBeenLastCalledWith('connecting', undefined);
  connection.send({ type: 'key', key: 'Enter' });
  expect(next.send).toHaveBeenCalledWith('{"type":"key","key":"Enter"}');
  connection.close();
  await vi.advanceTimersByTimeAsync(120000);
  expect(mock.open).toHaveBeenCalledTimes(2);
});

it('backs off repeated startup failures, interrupts the wait on online, and cancels retry on runtime switch', async () => {
  const { connection } = setup(); await tick();
  mock.socket!.onerror!(); await tick();
  await vi.advanceTimersByTimeAsync(1000);
  expect(mock.open).toHaveBeenCalledTimes(2);
  mock.socket!.onerror!(); await tick();
  await vi.advanceTimersByTimeAsync(1000);
  expect(mock.open).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event('online')); await tick();
  expect(mock.open).toHaveBeenCalledTimes(3);
  mock.socket!.onerror!(); await tick();
  mock.transport = 'host-b'; mock.generation++; mock.changed?.();
  await vi.advanceTimersByTimeAsync(120000);
  expect(mock.open).toHaveBeenCalledTimes(3);
  connection.close();
  expect(vi.getTimerCount()).toBe(0);
});

it('releases capture while hidden and reconnects once on foreground, without background retry traffic', async () => {
  const { connection } = setup(); await tick();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  document.dispatchEvent(new Event('visibilitychange'));
  expect(mock.socket!.close).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(120000);
  expect(mock.open).toHaveBeenCalledTimes(1);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  document.dispatchEvent(new Event('visibilitychange')); await tick();
  expect(mock.open).toHaveBeenCalledTimes(2);
  window.dispatchEvent(new Event('online')); await tick();
  expect(mock.open).toHaveBeenCalledTimes(2);
  connection.close();
});

it('recovers after a broken send and a stalled compatibility stream, then stops retrying on a decoded frame', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  vi.stubGlobal('URL', class extends URL { static createObjectURL() { return 'blob:recovered-frame'; } static revokeObjectURL = vi.fn(); });
  const { connection, image, state } = setup(); await tick();
  vi.mocked(mock.socket!.send).mockImplementationOnce(() => { throw Error('transport closed'); });
  expect(() => connection.send({ type: 'key', key: 'Enter' })).not.toThrow();
  await vi.advanceTimersByTimeAsync(1000);
  expect(mock.open).toHaveBeenCalledTimes(2);
  mock.socket!.onmessage!({ data: JSON.stringify({ type: 'offer', sdp: 'test' }) }); await tick();
  await vi.advanceTimersByTimeAsync(15000);
  expect(state).toHaveBeenLastCalledWith('closed', 'connection_failed');
  await vi.advanceTimersByTimeAsync(2000);
  expect(mock.open).toHaveBeenCalledTimes(3);
  mock.socket!.onmessage!({ data: new ArrayBuffer(10) }); await tick();
  image.dispatchEvent(new Event('load')); await tick();
  expect(state).toHaveBeenLastCalledWith('tunnel', undefined);
  await vi.advanceTimersByTimeAsync(120000);
  expect(mock.open).toHaveBeenCalledTimes(3);
  connection.close();
});

it('does not leave a media timeout behind when requesting compatibility streaming fails', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  const { connection } = setup(); await tick();
  vi.mocked(mock.socket!.send).mockImplementationOnce(() => { throw Error('transport closed'); });
  mock.socket!.onmessage!({ data: JSON.stringify({ type: 'offer', sdp: 'test' }) }); await tick();
  connection.close();
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['disabled', 'unsupported', 'helper_unavailable', 'authentication_required'])('does not reconnect a terminal %s rejection', async code => {
  const { connection, state } = setup(); await tick();
  mock.socket!.onmessage!({ data: JSON.stringify({ type: 'error', code }) }); await tick();
  expect(state).toHaveBeenLastCalledWith('closed', code);
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(120000);
  expect(mock.open).toHaveBeenCalledTimes(1);
  connection.close();
});

it('sends only zoom state transitions after advertised support, including a zoom that preceded readiness', async () => {
  const { connection } = setup();
  connection.setZoomed(true);
  await tick();
  expect(mock.socket!.send).not.toHaveBeenCalled();
  mock.socket!.onmessage!({ data: JSON.stringify({ type: 'ready', width: 1920, height: 1080, zoomQuality: true }) });
  await tick();
  expect(mock.socket!.send).toHaveBeenLastCalledWith('{"type":"view","zoomed":true}');
  const sent = vi.mocked(mock.socket!.send).mock.calls.length;
  for (let i = 0; i < 1000; i++) connection.setZoomed(true);
  expect(mock.socket!.send).toHaveBeenCalledTimes(sent);
  connection.setZoomed(false);
  expect(mock.socket!.send).toHaveBeenLastCalledWith('{"type":"view","zoomed":false}');
  mock.transport = 'host-b'; mock.generation++; mock.changed?.();
  const closedSent = vi.mocked(mock.socket!.send).mock.calls.length;
  connection.setZoomed(true);
  expect(mock.socket!.send).toHaveBeenCalledTimes(closedSent);
});

it.each([undefined, false, 'true'])('never sends unknown view commands to an old or non-advertising Host (%s)', async zoomQuality => {
  const { connection } = setup();
  await tick();
  mock.socket!.onmessage!({ data: JSON.stringify({ type: 'ready', width: 1920, height: 1080, zoomQuality }) });
  await tick();
  connection.setZoomed(true); connection.setZoomed(false);
  expect(mock.socket!.send).not.toHaveBeenCalled();
  connection.close();
});
