import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { getLocationOpencodeClient } from '@/lib/opencode/client';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { remoteSessionActiveQueryOptions, remoteSessionStatus } from './remote-session-active';

it.each([400, 404, 503])('keeps the last active snapshot when real scoped HTTP returns %s instead of inventing idle', async (failure) => {
  const previous = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://hub.example' });
  let status = 200;
  const fetch = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    expect(new URL(request.url).pathname).toBe('/api/hosts/active-host/api/session/active');
    return status === 200 ? Response.json({ data: { 'raw-session': { type: 'running' } } })
      : Response.json({ error: 'unavailable' }, { status });
  });
  vi.stubGlobal('fetch', fetch);
  const registry = new HostRuntimeRegistry('active-hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true,
    fetch: runtimeFetch, sdk: (location) => getLocationOpencodeClient(location).getSdkClient(), service: (location) => getLocationOpencodeClient(location) });
  const client = new QueryClient();
  const entry = registry.resolve({ hubId: 'active-hub', hostId: 'active-host', directory: '/remote/raw cwd' });
  const options = remoteSessionActiveQueryOptions(entry);
  try {
    const snapshot = await client.fetchQuery(options);
    expect(snapshot).toEqual({ 'raw-session': { type: 'running' } });
    status = failure;
    await expect(client.fetchQuery(options)).rejects.toThrow('Remote session active membership');
    expect(client.getQueryData(options.queryKey)).toBe(snapshot);
  } finally { client.clear(); registry.dispose(); vi.unstubAllGlobals(); setRuntimeUrlResolver(previous); }
});

it('preserves a live retry only while active, and clears it on authoritative inactive', () => {
  const retry = { type: 'retry' as const, attempt: 1, message: 'Retry', next: Date.now() + 60_000 };
  expect(remoteSessionStatus(true, retry)).toBe(retry);
  expect(remoteSessionStatus(false, retry)).toEqual({ type: 'idle' });
  expect(remoteSessionStatus(true)).toEqual({ type: 'busy' });
});
