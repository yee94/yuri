import { QueryClient } from '@tanstack/react-query';
import { expect, it, vi } from 'vitest';
import { getLocationOpencodeClient } from '@/lib/opencode/client';
import { HostRuntimeRegistry } from '@/lib/remote-projects/registry';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '@/lib/runtime-url';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { createRemoteSessionState } from './remote-session-state';
import { createMemoryTranscriptDurableStore } from './transcript-durable-store';

it('refreshes remote metadata through the generated SDK and real scoped service rather than the disabled legacy status stub', async () => {
  const previous = getRuntimeUrlResolver();
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://hub.example' });
  const location = { hubId: 'wire-hub', hostId: 'wire-host', directory: '/remote/raw worktree' };
  const requests: string[] = [];
  let active: unknown = {};
  const network = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    requests.push(url.pathname);
    expect(url.pathname).toContain('/api/hosts/wire-host/api/');
    if (url.pathname.endsWith('/session/raw-session')) return Response.json({ data: {
      id: 'raw-session', projectID: 'remote-project', title: 'Wire session title', location: { directory: location.directory },
      model: { providerID: 'fixture', id: 'fixture-model' }, cost: 0, tokens: {}, time: { created: 1, updated: 2 },
    } });
    if (url.pathname.endsWith('/session/active')) return Response.json({ data: active });
    return Response.json({ data: [] });
  });
  vi.stubGlobal('fetch', network);
  const registry = new HostRuntimeRegistry(location.hubId, { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true,
    fetch: runtimeFetch, sdk: (target) => getLocationOpencodeClient(target).getSdkClient(), service: (target) => getLocationOpencodeClient(target) });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const state = createRemoteSessionState(registry, location, { client, durableStore: createMemoryTranscriptDurableStore() });
  try {
    await expect(state.refreshMetadata('raw-session')).resolves.toBeUndefined();
    expect(state.getSnapshot('raw-session').session?.title).toBe('Wire session title');
    expect(state.getSnapshot('raw-session').status?.type).toBe('idle');
    expect(requests.some((path) => path.endsWith('/session/active'))).toBe(true);
    expect(requests.some((path) => path.endsWith('/session/status'))).toBe(false);
    active = { 'raw-session': { type: 'running' } };
    await state.refreshMetadata('raw-session');
    expect(state.getSnapshot('raw-session').status?.type).toBe('busy');
    active = { 'raw-session': { type: 'invalid' } };
    await expect(state.refreshMetadata('raw-session')).rejects.toThrow('membership unknown');
    expect(state.getSnapshot('raw-session').status?.type).toBe('busy');
    active = {};
    await state.refreshMetadata('raw-session');
    expect(state.getSnapshot('raw-session').status?.type).toBe('idle');
  } finally {
    state.dispose(); registry.dispose(); client.clear(); vi.unstubAllGlobals(); setRuntimeUrlResolver(previous);
  }
});
