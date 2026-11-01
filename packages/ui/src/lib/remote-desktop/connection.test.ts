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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function setup() {
  const state = vi.fn();
  const video = document.createElement('video');
  const image = document.createElement('img');
  const connection = connectRemoteDesktop({ transport: 'host-a', generation: 1, video, image, onSize: vi.fn(), onState: state });
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
  const { state } = setup(); await tick();
  mock.socket!.onmessage!({ data: JSON.stringify({ type: 'error', code: 'permission_required' }) }); await tick();
  expect(state).toHaveBeenLastCalledWith('closed', 'permission_required');
  await vi.advanceTimersByTimeAsync(120000);
  expect(mock.open).toHaveBeenCalledTimes(1);
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
