import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver, focusManager } from '@tanstack/react-query';
import { remoteDesktopQueryOptions } from './remoteDesktopQueries';

const mock = vi.hoisted(() => ({ fetch: vi.fn(), transport: 'host-a', generation: 1 }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: mock.fetch }));
vi.mock('@/lib/runtime-switch', () => ({ getRuntimeTransportIdentity: () => mock.transport, getRuntimeGeneration: () => mock.generation }));
beforeEach(() => { mock.transport = 'host-a'; mock.generation = 1; mock.fetch.mockReset(); });
afterEach(() => vi.useRealTimers());
const call = () => remoteDesktopQueryOptions('host-a', 1).queryFn({ signal: new AbortController().signal });
it('keys by runtime/generation, forwards cancellation, and distinguishes unsupported from failed requests', async () => {
  expect(remoteDesktopQueryOptions('host-a', 1).queryKey).not.toEqual(remoteDesktopQueryOptions('host-b', 1).queryKey);
  expect(remoteDesktopQueryOptions('host-a', 1).queryKey).not.toEqual(remoteDesktopQueryOptions('host-a', 2).queryKey);
  mock.fetch.mockResolvedValue(Response.json({ supported: false }));
  await expect(call()).resolves.toEqual({ supported: false, enabled: false });
  expect(mock.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  mock.fetch.mockResolvedValue(new Response('<html>Old host</html>', { headers: { 'content-type': 'text/html' } }));
  await expect(call()).rejects.toThrow('unsupported');
  mock.fetch.mockResolvedValue(Response.json({ error: 'offline' }, { status: 503 }));
  await expect(call()).rejects.toThrow('connection_failed');
  mock.fetch.mockResolvedValue(new Response('Restarting', { status: 503 }));
  await expect(call()).rejects.toThrow('connection_failed');
  mock.fetch.mockResolvedValue(new Response('Unauthorized', { status: 401 }));
  await expect(call()).rejects.toThrow('authentication_required');
});

it('paces cold-start recovery and stops polling once supported state or a permanent failure is authoritative', () => {
  const options = remoteDesktopQueryOptions('host-a', 1);
  const interval = (message: string | null, errorUpdateCount: number) => options.refetchInterval({ state: {
    error: message ? new Error(message) : null, errorUpdateCount,
  } });
  expect(interval('connection_failed', 1)).toBe(1000);
  expect(interval('connection_failed', 2)).toBe(2000);
  expect(interval('connection_failed', 100)).toBe(30000);
  for (const message of [null, 'authentication_required', 'runtime_changed', 'unsupported']) expect(interval(message, 3)).toBe(false);
  expect(options.refetchIntervalInBackground).toBe(false);
});

it('recovers a mounted capability observer after a Host restart without a manual refetch', async () => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  const client = new QueryClient();
  mock.fetch.mockResolvedValueOnce(new Response('Restarting', { status: 503 }))
    .mockResolvedValue(Response.json({ supported: true, enabled: true }));
  const observer = new QueryObserver(client, remoteDesktopQueryOptions('host-a', 1));
  const unsubscribe = observer.subscribe(() => {});
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(observer.getCurrentResult().error?.message).toBe('connection_failed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(observer.getCurrentResult().data).toEqual({ supported: true, enabled: true });
    await vi.advanceTimersByTimeAsync(60000);
    expect(mock.fetch).toHaveBeenCalledTimes(2);
  } finally { unsubscribe(); client.clear(); focusManager.setFocused(undefined); }
});
it('rejects stale runtime before a request or after async completion', async () => {
  mock.generation = 2; await expect(call()).rejects.toThrow('runtime_changed'); expect(mock.fetch).not.toHaveBeenCalled();
  mock.generation = 1;
  mock.fetch.mockImplementation(async () => { mock.transport = 'host-b'; return Response.json({ supported: true }); });
  await expect(call()).rejects.toThrow('runtime_changed');
});
it('ends a stranded host request without inventing unsupported or successful empty state', async () => {
  vi.useFakeTimers(); mock.fetch.mockImplementation(() => new Promise(() => {}));
  const assertion = expect(call()).rejects.toThrow('connection_failed');
  await vi.advanceTimersByTimeAsync(10001); await assertion;
  expect(mock.fetch.mock.calls[0][1].signal.aborted).toBe(true);
});
