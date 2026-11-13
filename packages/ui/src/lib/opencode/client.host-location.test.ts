import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { getLocationOpencodeClient, opencodeClient } from './client';
import { configureRuntimeUrlResolver, getRuntimeUrlResolver, setRuntimeUrlResolver } from '../runtime-url';
import { setRuntimeBearerToken } from '../runtime-auth';
import { adoptRelayTunnel, deactivateRelayTunnel } from '../relay/runtime-tunnel';
import { HostRuntimeRegistry } from '../remote-projects/registry';
import { getRuntimeTransportIdentity } from '../runtime-switch';
import { runtimeFetch } from '../runtime-fetch';

const directory = '/same/path/中文';
const previousResolver = getRuntimeUrlResolver();
const network = vi.fn();

beforeEach(() => {
  configureRuntimeUrlResolver({ apiBaseUrl: 'https://hub.example' });
  setRuntimeBearerToken('hub-test-token');
  vi.stubGlobal('fetch', network);
  network.mockReset();
});

afterEach(() => {
  deactivateRelayTunnel();
  setRuntimeBearerToken(null);
  setRuntimeUrlResolver(previousResolver);
  vi.unstubAllGlobals();
});

test('two host services use independent clients with identical raw directories and never switch the root directory', async () => {
  const before = opencodeClient.getDirectory();
  network.mockImplementation(async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    expect(url.origin).toBe('https://hub.example');
    expect(url.searchParams.get('location[directory]')).toBe(directory);
    expect(request.headers.get('authorization')).toBe('Bearer hub-test-token');
    const host = url.pathname.includes('/machine-a/') ? 'a' : 'b';
    return Response.json({ location: { directory }, data: [{ id: 'build', name: `Build ${host}`, mode: 'primary' }] });
  });
  const a = getLocationOpencodeClient({ hubId: 'hub-test', hostId: 'machine-a', directory });
  const b = getLocationOpencodeClient({ hubId: 'hub-test', hostId: 'machine-b', directory });
  const [agentsA, agentsB] = await Promise.all([a.listAgents(directory), b.listAgents(directory)]);
  expect(agentsA[0].displayName).toBe('Build a');
  expect(agentsB[0].displayName).toBe('Build b');
  expect(a).not.toBe(b);
  expect(a.getDirectory()).toBe(directory);
  expect(b.getDirectory()).toBe(directory);
  expect(opencodeClient.getDirectory()).toBe(before);
  expect(network).toHaveBeenCalledTimes(2);
});

test.each(['direct', 'relay'])('scoped SDK mutation preserves body, headers and cancellation over the %s Hub transport', async (transport) => {
  const controller = new AbortController();
  const respond = vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(new URL(input.toString(), 'https://hub.example'), init);
    expect(new URL(request.url).pathname).toBe('/api/hosts/mutation-host/api/session');
    expect(request.method).toBe('POST');
    expect(request.headers.get('authorization') ?? new Headers(init?.headers).get('authorization')).toBe('Bearer hub-test-token');
    expect(request.headers.get('x-test-scope')).toBe('retained');
    expect(request.headers.get('x-yuri-target-instance')).toBe('mutation-instance');
    expect(await request.json()).toEqual({ title: 'Scoped create', location: { directory } });
    controller.abort();
    expect((init?.signal ?? request.signal).aborted).toBe(true);
    return Response.json({ data: { id: 'same-session', title: 'Scoped create', location: { directory } } });
  });
  network.mockImplementation(respond);
  if (transport === 'relay') adoptRelayTunnel({ relayUrl: 'wss://relay.example', serverId: 'hub-test', hostEncPubJwk: {} }, {
    fetch: respond,
    close: () => {}, getStatus: () => ({ state: 'connected' }), subscribeStatus: () => () => {},
    openWebSocket: () => { throw new Error('No per-host socket is allowed'); },
  });
  const service = getLocationOpencodeClient({ hubId: 'hub-test', hostId: 'mutation-host', instanceId: 'mutation-instance', directory });
  const created = await service.getSdkClient().session.create({ title: 'Scoped create', location: { directory } }, {
    signal: controller.signal, headers: { 'x-test-scope': 'retained' },
  });
  expect(created.id).toBe('same-session');
  expect(respond).toHaveBeenCalledTimes(1);
  expect(network).toHaveBeenCalledTimes(transport === 'direct' ? 1 : 0);
});

test('Yuri filesystem methods on a host service route to that machine and keep raw paths', async () => {
  network.mockImplementation(async (input: Request | URL | string, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === '/api/hosts/fs-host/api/fs/home') return Response.json({ home: '/remote/home' });
    expect(url.pathname).toBe('/api/hosts/fs-host/api/fs/mkdir');
    expect(await request.json()).toEqual({ path: `${directory}/new` });
    return Response.json({ success: true, path: `${directory}/new` });
  });
  const service = getLocationOpencodeClient({ hubId: 'hub-test', hostId: 'fs-host', directory });
  expect(await service.getFilesystemHome()).toBe('/remote/home');
  expect(await service.createDirectory(`${directory}/new`)).toEqual({ success: true, path: `${directory}/new` });
});

test('host reconnection fences retained services independently of root runtime generation', async () => {
  let current = true;
  const service = getLocationOpencodeClient({ hubId: 'hub-test', hostId: 'fenced-host', directory }, { generation: 7, isCurrent: () => current });
  current = false;
  await expect(service.createDirectory(`${directory}/new`)).rejects.toThrow('inactive Hub');
  await expect(service.getSdkClient().session.get({ sessionID: 'same-session' })).rejects.toThrow();
  expect(network).not.toHaveBeenCalled();
});

test('real scoped catalog SDK closures survive their admission wire but reject a late result from a revoked authorization scope', async () => {
  const finishes: Array<(response: Response) => void> = [];
  network.mockImplementation(() => new Promise<Response>((resolve) => { finishes.push(resolve); }));
  const registry = new HostRuntimeRegistry('scope-sdk-hub', { transportIdentity: getRuntimeTransportIdentity(), isCurrent: () => true,
    fetch: runtimeFetch, sdk: (target, fence, scope) => getLocationOpencodeClient(target, fence, scope).getSdkClient(), service: getLocationOpencodeClient });
  const host = { id: 'scope-sdk-host', name: 'Scope SDK', source: 'direct' as const, state: 'idle' as const, scopeGeneration: 'scope-a' };
  registry.applyCatalog({ hubId: registry.hubId, supported: true, hosts: [host], projects: [] });
  const entry = registry.resolve({ hubId: registry.hubId, hostId: host.id, directory });
  const service = entry.service();
  const response = () => Response.json({ location: { directory }, data: [{ id: 'build', name: 'Build', mode: 'primary' }] });
  try {
    const first = service.listAgents(directory);
    await vi.waitFor(() => expect(finishes).toHaveLength(1));
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: registry.hubId, hostId: host.id,
      host: { ...host, state: 'connecting', generation: 'wire-a', lastConnectedAt: 1 } } });
    finishes[0](response());
    await expect(first).resolves.toMatchObject([{ name: 'build' }]);
    expect(registry.resolve(entry.location)).toBe(entry);
    expect(entry.service()).toBe(service);
    const second = service.listAgents(directory);
    const rejected = expect(second).rejects.toThrow('connection changed during SDK request');
    await vi.waitFor(() => expect(finishes).toHaveLength(2));
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: registry.hubId, hostId: host.id,
      host: { ...host, scopeGeneration: 'scope-b', generation: 'wire-b' } } });
    finishes[1](response());
    await rejected;
    const next = registry.resolve(entry.location);
    expect(next).not.toBe(entry);
    expect(next.service()).not.toBe(service);
    await expect(service.listAgents(directory)).rejects.toThrow('inactive Hub transport');
    expect(network).toHaveBeenCalledTimes(2);
  } finally { registry.dispose(); }
});
