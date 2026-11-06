import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, test, vi } from 'vitest';
import { fetchSessionShellSnapshot, latestShellOwnerUserQueryOptions, sessionShellSnapshotQueryOptions } from './sessionShellQueries';

const transport = vi.hoisted(() => ({ fetch: vi.fn<typeof fetch>() }));
vi.mock('@/lib/runtime-fetch', () => ({ runtimeFetch: transport.fetch }));
afterEach(() => { transport.fetch.mockReset(); });

test('the generated SDK sends explicit Location and abort signal, never shell output or cold-directory reads', async () => {
  const requests: Request[] = [];
  transport.fetch.mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return Response.json(new URL(request.url).pathname === '/api/debug/location'
      ? [{ directory: '/work tree' }] : { location: { directory: '/work tree' }, data: [] });
  });
  const options = sessionShellSnapshotQueryOptions();
  const client = new QueryClient();
  try {
    await client.fetchQuery(options);
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/api/debug/location', '/api/shell']);
    expect(new URL(requests[1].url).searchParams.get('location[directory]')).toBe('/work tree');
    transport.fetch.mockImplementation(async (input, init) => {
      requests.push(new Request(input, init));
      return new Promise<Response>(() => {});
    });
    const running = client.fetchQuery(options);
    const settled = running.catch(() => undefined);
    await vi.waitFor(() => expect(requests).toHaveLength(3));
    await client.cancelQueries({ queryKey: options.queryKey });
    await settled;
    expect(requests.at(-1)!.signal.aborted).toBe(true);
  } finally { client.clear(); }
});

test('reconnect requests share one Query flight and bound concurrency to loaded Locations', async () => {
  const client = new QueryClient();
  let inFlight = 0;
  let max = 0;
  const loaders = {
    locations: vi.fn(async () => Array.from({ length: 51 }, (_, i) => ({ directory: `/live-${i}` }))),
    shells: vi.fn(async (_directory: string, signal: AbortSignal) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      inFlight += 1;
      max = Math.max(max, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return [];
    }),
  };
  try {
    await Promise.all(Array.from({ length: 50 }, () => fetchSessionShellSnapshot(client, loaders)));
    expect(loaders.locations).toHaveBeenCalledTimes(1);
    expect(loaders.shells).toHaveBeenCalledTimes(51);
    expect(max).toBeLessThanOrEqual(2);
  } finally { client.clear(); }
});

test('shell owners read just the newest authored user, excluding synthetic notices and propagating failures', async () => {
  const requests: Request[] = [];
  transport.fetch.mockImplementation(async (input, init) => {
    requests.push(new Request(input, init));
    return Response.json({ data: [{ id: 'user-latest', type: 'user', time: { created: 200 }, text: 'next' }] });
  });
  const client = new QueryClient();
  const options = latestShellOwnerUserQueryOptions('/work tree', 'parent');
  try {
    expect(await client.fetchQuery(options)).toBe(200);
    const url = new URL(requests[0].url);
    expect(url.searchParams.get('type')).toBe('user');
    expect(url.searchParams.get('order')).toBe('desc');
    expect(url.searchParams.get('limit')).toBe('1');
    expect(requests[0].signal).toBeInstanceOf(AbortSignal);
    transport.fetch.mockImplementation(async () => Response.json({ data: [] }));
    expect(await client.fetchQuery(options)).toBeNull();
    transport.fetch.mockImplementation(async () => Response.json({ error: 'offline' }, { status: 503 }));
    await expect(client.fetchQuery(options)).rejects.toThrow();
  } finally { client.clear(); }
});
