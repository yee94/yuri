import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import type { HostRuntimeEntry } from '@/lib/remote-projects/registry';
import { openDesktopBrowserNetwork } from './desktop-browser-network';

const f = vi.hoisted(() => ({
  generation: 1, changed: () => {}, authChanged: () => {}, listeners: new Set<(event: { scope: string; data: string }) => void>(),
  start: vi.fn(), stop: vi.fn(), write: vi.fn(), dial: vi.fn(), auth: vi.fn(),
  sockets: [] as RelayTunnelWebSocket[],
}));
vi.mock('@/lib/runtime-switch', () => ({
  getRuntimeGeneration: () => f.generation, getRuntimeTransportIdentity: () => String(f.generation),
  subscribeRuntimeEndpointChanged: (fn: () => void) => { f.changed = fn; return () => {}; },
}));
vi.mock('@/lib/runtime-auth', () => ({
  getRuntimeAuthGeneration: () => 1, refreshRuntimeUrlAuthToken: () => f.auth(),
  subscribeRuntimeAuthGeneration: (fn: () => void) => { f.authChanged = fn; return () => {}; },
}));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: vi.fn() }));
vi.mock('@/lib/runtime-url', () => ({ getRuntimeUrlResolver: () => ({ websocket: (path: string) => `ws://runtime.test${path}?yuri_url_token=scoped` }) }));
vi.mock('@/lib/relay/runtime-socket', () => ({ openRuntimeWebSocket: (url: string) => f.dial(url) }));

const controllers: AbortController[] = [];
const signal = () => { const c = new AbortController(); controllers.push(c); return c.signal; };
beforeEach(() => {
  f.generation = 1; f.listeners.clear(); f.sockets = [];
  f.start.mockReset().mockResolvedValue({ scope: 'one', partition: 'yuri-browser-relay-one' });
  f.stop.mockReset().mockResolvedValue(undefined); f.write.mockReset().mockResolvedValue(undefined);
  f.auth.mockReset().mockResolvedValue(undefined);
  f.dial.mockReset().mockImplementation(() => {
    const socket: RelayTunnelWebSocket = { readyState: 1, onopen: null, onmessage: null, onerror: null, onclose: null, send: vi.fn(), close: vi.fn() };
    f.sockets.push(socket);
    queueMicrotask(() => socket.onmessage?.({ data: '{"type":"ready","version":1}' }));
    return socket;
  });
  Object.assign(window, { __YURI_DESKTOP__: { browserRelay: {
    start: f.start, stop: f.stop, write: f.write,
    subscribe: (fn: (event: { scope: string; data: string }) => void) => { f.listeners.add(fn); return () => f.listeners.delete(fn); },
  } } });
});
afterEach(() => { for (const c of controllers.splice(0)) c.abort(); vi.useRealTimers(); });

it.each([undefined, 'remote-a', 'remote-b'])('dials the captured session Host %s and forwards only its native scope', async hostId => {
  const sdk = vi.fn();
  const entry = hostId ? { location: { hubId: 'hub', hostId, directory: '/project' }, sdk } as unknown as HostRuntimeEntry : undefined;
  const lease = await openDesktopBrowserNetwork(signal(), vi.fn(), entry);
  expect(f.dial).toHaveBeenCalledWith(`ws://runtime.test${hostId ? `/api/hosts/${hostId}` : ''}/api/gui-network/ws?yuri_url_token=scoped`);
  const socket = f.sockets[0];
  for (const fn of f.listeners) { fn({ scope: 'other', data: 'ignored' }); fn({ scope: 'one', data: '{"type":"open","id":1}' }); }
  expect(socket.send).toHaveBeenCalledExactlyOnceWith('{"type":"open","id":1}');
  socket.onmessage?.({ data: '{"type":"opened","id":1}' });
  await vi.waitFor(() => expect(f.write).toHaveBeenCalledWith('one', '{"type":"opened","id":1}'));
  lease.release();
  expect(f.stop).toHaveBeenCalledExactlyOnceWith('one');
  expect(socket.close).toHaveBeenCalledOnce();
});

it('releases a late native lease after cancellation without exposing a partition', async () => {
  let finish!: (value: { scope: string; partition: string }) => void;
  f.start.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const s = signal();
  const opening = openDesktopBrowserNetwork(s, vi.fn());
  const rejected = expect(opening).rejects.toThrow();
  await vi.waitFor(() => expect(f.start).toHaveBeenCalledOnce());
  controllers[0].abort();
  await rejected;
  finish({ scope: 'late', partition: 'yuri-browser-relay-late' });
  await vi.waitFor(() => expect(f.stop).toHaveBeenCalledWith('late'));
  expect(f.listeners.size).toBe(0);
});

it.each(['disconnect', 'runtime', 'auth', 'scope'])('fails closed on %s and does not reconnect to another machine', async reason => {
  let valid = true;
  const entry = { location: { hostId: 'remote-a' }, sdk: () => { if (!valid) throw new Error('stale host'); } } as unknown as HostRuntimeEntry;
  const failed = vi.fn();
  await openDesktopBrowserNetwork(signal(), failed, entry);
  if (reason === 'disconnect') f.sockets[0].onclose?.({ code: 1006, reason: '' });
  if (reason === 'runtime') { f.generation++; f.changed(); }
  if (reason === 'auth') f.authChanged();
  if (reason === 'scope') { valid = false; f.sockets[0].onmessage?.({ data: '{"type":"pong"}' }); }
  expect(failed).toHaveBeenCalledOnce();
  expect(f.stop).toHaveBeenCalledOnce();
  expect(f.listeners.size).toBe(0);
  expect(f.dial).toHaveBeenCalledOnce();
});
