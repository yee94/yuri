import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RelayTunnelStatus } from './relay/tunnel-client';

const f = vi.hoisted(() => ({
  fetch: vi.fn(), key: 'host:a', generation: 0, auth: 0,
  tunnel: null as null | { getStatus: () => RelayTunnelStatus; subscribeStatus: (listener: () => void) => () => void },
  endpoint: undefined as undefined | (() => void),
}));
vi.mock('./runtime-fetch', () => ({ runtimeFetch: f.fetch }));
vi.mock('./runtime-auth', () => ({ getRuntimeAuthGeneration: () => f.auth }));
vi.mock('./relay/runtime-tunnel', () => ({ getActiveRelayTunnel: () => f.tunnel }));
vi.mock('./runtime-switch', () => ({
  getRuntimeKey: () => f.key, getRuntimeGeneration: () => f.generation,
  subscribeRuntimeEndpointChanged: (listener: () => void) => {
    f.endpoint = listener;
    return () => { f.endpoint = undefined; };
  },
}));
import { observeRuntimeSession } from './runtime-session-recovery';

const observeDesktopSession = (onRejected: Parameters<typeof observeRuntimeSession>[0]) =>
  observeRuntimeSession(onRejected, { desktop: true });

const flush = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); };
let dispose: (() => void) | undefined;
beforeEach(() => {
  f.fetch.mockReset(); f.key = 'host:a'; f.generation = 0; f.auth = 0; f.tunnel = null;
});
afterEach(() => { dispose?.(); dispose = undefined; vi.useRealTimers(); });

describe('active runtime session recovery', () => {
  it('does not install desktop focus or Relay recovery in other runtimes', async () => {
    f.tunnel = {
      getStatus: () => ({ state: 'error', failureCode: 'relay_authentication_rejected' }),
      subscribeStatus: vi.fn(() => () => {}),
    };
    const rejected = vi.fn(); dispose = observeRuntimeSession(rejected);
    window.dispatchEvent(new Event('focus')); await flush();
    expect(f.fetch).not.toHaveBeenCalled();
    expect(f.tunnel.subscribeStatus).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();
  });
  it('rechecks a rejected API, but leaves an authorized SSH/client session alone', async () => {
    f.fetch.mockResolvedValue(new Response('{"authenticated":true,"scope":"client"}'));
    const rejected = vi.fn(); dispose = observeDesktopSession(rejected);
    window.dispatchEvent(new Event('yuri:runtime-auth-rejected'));
    await flush();
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(rejected).not.toHaveBeenCalled();
  });

  it('passes the confirmed password-session rejection without a second auth probe', async () => {
    const response = new Response('', { status: 401 });
    f.fetch.mockResolvedValue(response);
    const rejected = vi.fn(); dispose = observeDesktopSession(rejected);
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect(rejected).toHaveBeenCalledWith({ kind: 'session', response, relay: false });
    expect(f.fetch).toHaveBeenCalledTimes(1);
  });

  it('distinguishes relay pairing rejection from layer-1 relay authentication failure', async () => {
    let status: RelayTunnelStatus = { state: 'connected' };
    let update: (() => void) | undefined;
    f.tunnel = { getStatus: () => status, subscribeStatus: (listener) => { update = listener; return () => { update = undefined; }; } };
    const response = new Response('', { status: 403 }); f.fetch.mockResolvedValue(response);
    const rejected = vi.fn(); dispose = observeDesktopSession(rejected);
    window.dispatchEvent(new Event('yuri:runtime-auth-rejected'));
    await flush();
    expect(rejected).toHaveBeenCalledWith({ kind: 'session', response, relay: true });
    status = { state: 'error', failureCode: 'relay_authentication_rejected' }; update?.();
    expect(rejected).toHaveBeenLastCalledWith({ kind: 'relay-authentication' });
  });

  it('never interprets ordinary 403, network failure, timeout, or 5xx as password expiry', async () => {
    const rejected = vi.fn(); dispose = observeDesktopSession(rejected);
    for (const status of [200, 403, 429, 502]) {
      f.fetch.mockResolvedValue(new Response('', { status }));
      window.dispatchEvent(new Event('focus')); await flush();
    }
    f.fetch.mockRejectedValue(new Error('offline'));
    window.dispatchEvent(new Event('focus')); await flush();
    expect(rejected).not.toHaveBeenCalled();
  });

  it.each(['key', 'generation', 'auth', 'tunnel', 'dispose'] as const)('ignores late rejection after %s changes', async (change) => {
    let resolve!: (response: Response) => void;
    f.fetch.mockImplementation(() => new Promise<Response>((done) => { resolve = done; }));
    const rejected = vi.fn(); dispose = observeDesktopSession(rejected);
    window.dispatchEvent(new Event('focus'));
    if (change === 'key') f.key = 'host:b';
    if (change === 'generation') f.generation += 1;
    if (change === 'auth') f.auth += 1;
    if (change === 'tunnel') f.tunnel = { getStatus: () => ({ state: 'connected' }), subscribeStatus: () => () => {} };
    if (change === 'dispose') dispose();
    resolve(new Response('', { status: 401 })); await flush();
    expect(rejected).not.toHaveBeenCalled();
  });

  it('coalesces focus/API bursts and releases a timed-out check', async () => {
    vi.useFakeTimers();
    f.fetch.mockImplementation((_path: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const rejected = vi.fn(); dispose = observeDesktopSession(rejected);
    for (let i = 0; i < 50; i += 1) window.dispatchEvent(new Event('focus'));
    expect(f.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    f.fetch.mockResolvedValue(new Response(''));
    window.dispatchEvent(new Event('focus')); await flush();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(rejected).not.toHaveBeenCalled();
  });
});
