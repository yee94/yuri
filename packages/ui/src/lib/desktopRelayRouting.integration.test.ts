import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const mocks = vi.hoisted(() => ({ createTunnel: vi.fn() }));
vi.mock('./relay/tunnel-client', () => ({ createRelayTunnelClient: mocks.createTunnel }));

import { restoreDesktopRelayRuntime, refreshDesktopHostCandidates } from './desktopRelayRestore';
import { switchDesktopHost } from './desktopHostSwitch';
import { getRuntimeKey, switchRuntimeEndpoint } from './runtime-switch';
import { getActiveRelayTunnel, deactivateRelayTunnel } from './relay/runtime-tunnel';
import { runtimeFetch } from './runtime-fetch';
import { opencodeClient } from './opencode/client';
import { getDesktopGuiPluginBridge, getDesktopViewExportBridge, isDesktopLocalOriginActive } from './desktop';
import { readRuntimeScopedItem } from './runtimeScopedStorage';
import { resolveTranscriptDurableRuntimeKind } from '../sync/transcript-durable-store-runtime';
import type { DesktopHost } from './desktopHosts';
import type { RelayTunnelClient } from './relay/tunnel-client';

const localOrigin = 'http://127.0.0.1:57123';
const directory = '/remote/worktrees/project/feature';
const host: DesktopHost = {
  id: 'remote-computer', label: 'Remote computer', url: localOrigin, apiUrl: localOrigin,
  clientToken: 'test-remote-token',
  relay: { relayUrl: 'wss://relay.example', serverId: 'remote-identity', hostEncPubJwk: {} },
};
const nativeFetch = vi.fn<typeof fetch>();
const tunnelFetch = vi.fn<RelayTunnelClient['fetch']>();
const invoke = vi.fn();
const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../electron/main.mjs'), 'utf8');
const authProbeSource = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../electron/host-auth-probe.mjs'), 'utf8')
  .replace('export const probeHostAuthentication', 'const probeHostAuthentication');
const probeSource = source.slice(source.indexOf('const buildHealthUrl ='), source.indexOf('const resolveStoredClientTokenForUrl ='));
const nativeContext = vm.createContext({
  URL, AbortSignal, setTimeout,
  fetch: nativeFetch,
  electronNet: { fetch: nativeFetch },
  sanitizeRuntimeRequestHeaders: (headers: HeadersInit) => headers,
});
vm.runInContext(`${authProbeSource}\n${probeSource}\nglobalThis.probe = probeHostWithTimeout;`, nativeContext);

const inputUrl = (input: string | URL | Request) => new URL(input instanceof Request ? input.url : String(input), localOrigin);
let healthIdentity: string | undefined;
let defaultHostId: string;

beforeEach(() => {
  vi.useFakeTimers();
  healthIdentity = undefined;
  defaultHostId = host.id;
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    location: { origin: 'null', href: 'yuri-ui://app/index.html' },
    __YURI_ELECTRON__: { runtime: 'electron', packaged: true },
    __YURI_LOCAL_ORIGIN__: localOrigin,
    __YURI_DESKTOP__: { invoke },
    setTimeout,
  }));
  nativeFetch.mockImplementation(async (input) => {
    const url = inputUrl(input);
    if (url.pathname === '/health') return Response.json({ status: 'ok', ...(healthIdentity ? { serverId: healthIdentity } : {}) });
    if (url.pathname === '/api/version') return Response.json({ status: 'ok', compatibility: { apiVersion: 1, minClientApiVersion: 1, capabilities: ['api.runtime-url.v1'] } });
    if (url.pathname === '/auth/session') return Response.json({ authenticated: true });
    if (url.pathname === '/auth/url-token') return Response.json({ token: 'test-local-url-token', expiresAt: Date.now() + 60000 });
    if (url.pathname === '/api/config/catalog/providers') return Response.json({ error: 'Directory does not exist on this computer' }, { status: 400 });
    return Response.json({ _tag: 'LocationNotFoundError', location: { directory }, message: `Location not found: ${directory}` }, { status: 404 });
  });
  vi.stubGlobal('fetch', nativeFetch);
  tunnelFetch.mockImplementation(async (input, init) => {
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-remote-token');
    const url = inputUrl(input);
    if (url.pathname === '/auth/session') return Response.json({ authenticated: true });
    if (url.pathname === '/auth/url-token') return Response.json({ token: 'test-remote-url-token', expiresAt: Date.now() + 60000 });
    if (url.pathname === '/api/client-auth/connection/candidates') return Response.json({ serverId: host.relay!.serverId, candidates: [{ type: 'lan', url: localOrigin }] });
    if (url.pathname === '/api/agent') {
      expect(url.searchParams.get('location[directory]')).toBe(directory);
      return Response.json({ location: { directory }, data: [{ id: 'build', name: 'Remote Build', mode: 'primary' }] });
    }
    if (url.pathname === '/api/config/catalog/providers') {
      expect(new Headers(init?.headers).get('x-opencode-directory')).toBe(directory);
      return Response.json({ schemaVersion: 1, providers: [{ id: 'remote-provider', name: 'Remote', models: {} }], default: {}, partial: false });
    }
    throw new Error(`Unexpected tunnel route: ${url.pathname}`);
  });
  mocks.createTunnel.mockImplementation(() => ({
    fetch: tunnelFetch, close: vi.fn(), getStatus: () => ({ state: 'connected' }), subscribeStatus: () => () => {},
    openWebSocket: () => { throw new Error('unused'); },
  } satisfies RelayTunnelClient));
  invoke.mockImplementation(async (command, args) => {
    if (command === 'desktop_host_prepare') return host;
    if (command === 'desktop_hosts_get') return { hosts: [host], defaultHostId, initialHostChoiceCompleted: true, localOrigin };
    if (command === 'desktop_hosts_set') return;
    if (command === 'desktop_host_probe') return nativeContext.probe(args.url, 1000, args.clientToken, args.requestHeaders, args.expectedServerId);
    throw new Error(`Unexpected IPC: ${command}`);
  });
  switchRuntimeEndpoint({ apiBaseUrl: localOrigin, runtimeKey: 'local', clientToken: 'test-local-token' });
  opencodeClient.reconnectToRuntimeBaseUrl();
});

afterEach(() => {
  deactivateRelayTunnel();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const expectRemoteWorktreeCatalog = async () => {
  expect(getRuntimeKey()).toBe(`host:${host.id}`);
  expect(getActiveRelayTunnel()).not.toBeNull();
  const agents = await opencodeClient.listAgents(directory);
  expect(agents[0].displayName).toBe('Remote Build');
  const providers = await runtimeFetch('/api/config/catalog/providers', { headers: { 'x-opencode-directory': directory } });
  expect(providers.status).toBe(200);
  expect((await providers.json()).providers[0].id).toBe('remote-provider');
  const localBusinessRequests = nativeFetch.mock.calls.filter(([input]) => ['/api/agent', '/api/config/catalog/providers'].includes(inputUrl(input).pathname));
  expect(localBusinessRequests).toHaveLength(0);
};

describe.each(['packaged', 'HMR'])('remote-computer worktree routing in %s UI', (mode) => {
  beforeEach(() => {
    if (mode === 'HMR') Object.assign(window.location, { origin: 'http://localhost:5180', href: 'http://localhost:5180/' });
  });
  it('restores this window remote instance instead of the configured local default', async () => {
    defaultHostId = 'local';
    Object.assign(window, { __YURI_DESKTOP_BOOT_OUTCOME__: { target: 'remote', status: 'ok', hostId: host.id, url: host.url } });
    await restoreDesktopRelayRuntime();
    await expectRemoteWorktreeCatalog();
  });

  it('keeps a restored local window local when another instance is the default', async () => {
    Object.assign(window, { __YURI_DESKTOP_BOOT_OUTCOME__: { target: 'local', status: 'ok' } });
    await restoreDesktopRelayRuntime();
    expect(getRuntimeKey()).toBe('local');
    expect(getActiveRelayTunnel()).toBeNull();
    expect(mocks.createTunnel).not.toHaveBeenCalled();
  });

  it('restores the stable saved Host key for a direct-only window', async () => {
    const directHost = { ...host, relay: undefined, url: 'http://remote.example:3000', apiUrl: 'http://remote.example:3000' };
    defaultHostId = 'local';
    invoke.mockImplementation(async (command) => command === 'desktop_hosts_get' ? { hosts: [directHost], defaultHostId } : undefined);
    Object.assign(window, { __YURI_DESKTOP_BOOT_OUTCOME__: { target: 'remote', status: 'ok', hostId: host.id, url: directHost.url } });
    switchRuntimeEndpoint({ apiBaseUrl: directHost.url, runtimeKey: `url:${directHost.url}` });
    await restoreDesktopRelayRuntime();
    expect(getRuntimeKey()).toBe(`host:${host.id}`);
    expect(getActiveRelayTunnel()).toBeNull();
    expect(mocks.createTunnel).not.toHaveBeenCalled();
  });
  it.each(['restore', 'new-window', 'switch', 'refresh'].flatMap((entrypoint) => [
    { entrypoint, identity: undefined }, { entrypoint, identity: 'local-computer-identity' },
  ]))('$entrypoint keeps Agent and Provider reads on Relay with local identity $identity', async ({ entrypoint, identity }) => {
    healthIdentity = identity;
    if (entrypoint === 'switch') {
      expect(await switchDesktopHost(host)).toMatchObject({ ok: true, via: 'relay' });
    } else {
      if (entrypoint === 'new-window') defaultHostId = 'local';
      await restoreDesktopRelayRuntime(entrypoint === 'new-window' ? host.id : undefined);
      if (entrypoint === 'refresh') await refreshDesktopHostCandidates(host.id);
    }
    await expectRemoteWorktreeCatalog();
  });

  it('still allows an authenticated direct connection to the exact paired computer', async () => {
    healthIdentity = host.relay!.serverId;
    expect(await switchDesktopHost(host)).toMatchObject({ ok: true, via: 'direct' });
    expect(getRuntimeKey()).toBe(`host:${host.id}`);
    expect(getActiveRelayTunnel()).toBeNull();
    expect(nativeFetch.mock.calls.some(([input]) => inputUrl(input).pathname === '/auth/session')).toBe(true);
  });

  it('restores a healthy paired transport without SSH preparation', async () => {
    await restoreDesktopRelayRuntime(host.id);
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_host_prepare')).toHaveLength(0);
    expect(tunnelFetch.mock.calls.some(([input]) => inputUrl(input).pathname === '/auth/session')).toBe(true);
  });

  it('initializes once after both restored transports fail and retries with refreshed SSH credentials', async () => {
    tunnelFetch.mockRejectedValue(new Error('Host process stopped'));
    const refreshedHost = { ...host, apiUrl: 'http://refreshed.example:3000', clientToken: 'refreshed-token' };
    const invokeOther = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'desktop_host_prepare') {
        healthIdentity = host.relay!.serverId;
        return refreshedHost;
      }
      return invokeOther(command, args);
    });
    await restoreDesktopRelayRuntime(host.id);
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_host_prepare')).toEqual([['desktop_host_prepare', { hostId: host.id }]]);
    expect(getRuntimeKey()).toBe(`host:${host.id}`);
    expect(getActiveRelayTunnel()).toBeNull();
    const authenticated = nativeFetch.mock.calls.find(([input]) => inputUrl(input).origin === refreshedHost.apiUrl && inputUrl(input).pathname === '/auth/session');
    expect(authenticated).toBeDefined();
    expect(new Headers(authenticated![1]?.headers).get('authorization')).toBe('Bearer refreshed-token');
    expect(mocks.createTunnel.mock.results[0].value.close).toHaveBeenCalledOnce();
  });

  it('shows remote recovery after initialization fails instead of committing a dead Relay', async () => {
    tunnelFetch.mockRejectedValue(new Error('Remote process stopped'));
    const invokeOther = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (command, args) => {
      if (command === 'desktop_host_prepare') throw new Error('SSH initialization failed');
      return invokeOther(command, args);
    });
    await expect(restoreDesktopRelayRuntime(host.id)).rejects.toThrow('SSH initialization failed');
    expect(window.__YURI_DESKTOP_BOOT_OUTCOME__).toMatchObject({ target: 'remote', status: 'unreachable', hostId: host.id });
    expect(getRuntimeKey()).toBe('local');
    expect(getActiveRelayTunnel()).toBeNull();
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_host_prepare')).toHaveLength(1);
  });

  it('retries and adopts an authenticated Relay after SSH initialization starts the Host', async () => {
    tunnelFetch.mockRejectedValueOnce(new Error('Host not running'));
    await restoreDesktopRelayRuntime(host.id);
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_host_prepare')).toHaveLength(1);
    expect(mocks.createTunnel).toHaveBeenCalledTimes(2);
    expect(mocks.createTunnel.mock.results[0].value.close).toHaveBeenCalledOnce();
    expect(getActiveRelayTunnel()).toBe(mocks.createTunnel.mock.results[1].value);
    await expectRemoteWorktreeCatalog();
  });

  it('closes a successful but stale Relay probe without starting SSH recovery', async () => {
    let finish!: (response: Response) => void;
    tunnelFetch.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const restoring = restoreDesktopRelayRuntime(host.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://other.example', runtimeKey: 'host:other' });
    finish(Response.json({ authenticated: true }));
    await restoring;
    expect(getRuntimeKey()).toBe('host:other');
    expect(mocks.createTunnel.mock.results[0].value.close).toHaveBeenCalledOnce();
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_host_prepare')).toHaveLength(0);
  });

  it('bounds recovery to one initialization attempt if the refreshed transports also fail', async () => {
    tunnelFetch.mockRejectedValue(new Error('Offline'));
    await expect(restoreDesktopRelayRuntime(host.id)).rejects.toThrow('unreachable after initialization');
    expect(invoke.mock.calls.filter(([command]) => command === 'desktop_host_prepare')).toHaveLength(1);
    expect(mocks.createTunnel).toHaveBeenCalledTimes(2);
    for (const result of mocks.createTunnel.mock.results) expect(result.value.close).toHaveBeenCalledOnce();
    expect(getRuntimeKey()).toBe('local');
    expect(window.__YURI_DESKTOP_BOOT_OUTCOME__).toMatchObject({ target: 'remote', status: 'unreachable' });
  });

  it('discards SSH recovery completion after the user selects another runtime', async () => {
    tunnelFetch.mockRejectedValue(new Error('Offline'));
    let finish!: (value: DesktopHost) => void;
    const invokeOther = invoke.getMockImplementation()!;
    invoke.mockImplementation((command, args) => command === 'desktop_host_prepare'
      ? new Promise<DesktopHost>((resolve) => { finish = resolve; }) : invokeOther(command, args));
    const restoring = restoreDesktopRelayRuntime(host.id);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    switchRuntimeEndpoint({ apiBaseUrl: 'http://other.example', runtimeKey: 'host:other' });
    healthIdentity = host.relay!.serverId;
    finish(host);
    await restoring;
    expect(getRuntimeKey()).toBe('host:other');
    expect(getActiveRelayTunnel()).toBeNull();
    expect(window.__YURI_DESKTOP_BOOT_OUTCOME__).toBeUndefined();
  });

  it('does not classify a Relay virtual loopback URL as the local computer or inherit local storage', async () => {
    Object.defineProperty(window, '__YURI_API_BASE_URL__', { value: localOrigin, writable: false, configurable: true });
    const storage = { getItem: (key: string) => key === 'lastDirectory' ? '/client-only/project' : null };
    expect(isDesktopLocalOriginActive()).toBe(true);
    expect(readRuntimeScopedItem('lastDirectory', { storage })).toBe('/client-only/project');
    await restoreDesktopRelayRuntime(host.id);
    expect(isDesktopLocalOriginActive()).toBe(false);
    expect(resolveTranscriptDurableRuntimeKind()).toBe('indexeddb');
    expect(readRuntimeScopedItem('lastDirectory', { storage })).toBeNull();
  });

  it('retains device export across Relay while withdrawing plugin main access', async () => {
    const guiPlugins = { request: vi.fn(), subscribe: vi.fn() };
    const viewExport = { request: vi.fn(), subscribe: vi.fn() };
    Object.assign(Reflect.get(window, '__YURI_DESKTOP__'), { guiPlugins, viewExport });
    expect(getDesktopGuiPluginBridge()).toBe(guiPlugins);
    expect(getDesktopViewExportBridge()).toBe(viewExport);
    await restoreDesktopRelayRuntime(host.id);
    expect(getDesktopGuiPluginBridge()).toBeUndefined();
    expect(getDesktopViewExportBridge()).toBe(viewExport);
  });

  it('does not let an earlier startup probe overwrite a later explicit remote selection', async () => {
    let finishProbe!: (response: Response) => void;
    const fetchOther = nativeFetch.getMockImplementation()!;
    nativeFetch.mockImplementation((input, init) => inputUrl(input).pathname === '/health'
      ? new Promise<Response>((resolve) => { finishProbe = resolve; }) : fetchOther(input, init));
    const restoring = restoreDesktopRelayRuntime(host.id);
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf('function'));
    switchRuntimeEndpoint({ apiBaseUrl: localOrigin, runtimeKey: 'host:other-remote', clientToken: 'test-remote-token', relay: { ...host.relay!, serverId: 'other-remote-identity' } });
    finishProbe(Response.json({ status: 'ok' }));
    await restoring;
    expect(getRuntimeKey()).toBe('host:other-remote');
  });

  it('does not let a late direct probe replace a newly selected Relay after switching away and back', async () => {
    let finishProbe!: (response: Response) => void;
    const fetchOther = nativeFetch.getMockImplementation()!;
    nativeFetch.mockImplementation((input, init) => inputUrl(input).pathname === '/health'
      ? new Promise<Response>((resolve) => { finishProbe = resolve; }) : fetchOther(input, init));
    const restoring = restoreDesktopRelayRuntime(host.id);
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf('function'));
    await vi.advanceTimersByTimeAsync(1500);
    await restoring;
    switchRuntimeEndpoint({ apiBaseUrl: localOrigin, runtimeKey: 'host:other-remote', clientToken: 'test-remote-token', relay: { ...host.relay!, serverId: 'other-remote-identity' } });
    switchRuntimeEndpoint({ apiBaseUrl: localOrigin, runtimeKey: `host:${host.id}`, clientToken: host.clientToken, relay: host.relay });
    finishProbe(Response.json({ serverId: host.relay!.serverId }));
    await vi.advanceTimersByTimeAsync(0);
    await expectRemoteWorktreeCatalog();
  });

  it('keeps the selected Relay when the losing startup direct probe later succeeds, like mobile', async () => {
    let finishProbe!: (response: Response) => void;
    const fetchOther = nativeFetch.getMockImplementation()!;
    nativeFetch.mockImplementation((input, init) => inputUrl(input).pathname === '/health'
      ? new Promise<Response>((resolve) => { finishProbe = resolve; }) : fetchOther(input, init));
    const restoring = restoreDesktopRelayRuntime(host.id);
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf('function'));
    await vi.advanceTimersByTimeAsync(1500);
    await restoring;
    const selectedTunnel = getActiveRelayTunnel();
    finishProbe(Response.json({ serverId: host.relay!.serverId }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getActiveRelayTunnel()).toBe(selectedTunnel);
    await expectRemoteWorktreeCatalog();
  });

  it('discards a background candidate probe after switching away and back', async () => {
    await restoreDesktopRelayRuntime(host.id);
    let finishProbe!: (response: Response) => void;
    const fetchOther = nativeFetch.getMockImplementation()!;
    nativeFetch.mockImplementation((input, init) => inputUrl(input).pathname === '/health'
      ? new Promise<Response>((resolve) => { finishProbe = resolve; }) : fetchOther(input, init));
    const refreshing = refreshDesktopHostCandidates(host.id);
    await vi.waitFor(() => expect(finishProbe).toBeTypeOf('function'));
    switchRuntimeEndpoint({ apiBaseUrl: localOrigin, runtimeKey: 'host:other-remote', clientToken: 'test-remote-token', relay: { ...host.relay!, serverId: 'other-remote-identity' } });
    switchRuntimeEndpoint({ apiBaseUrl: localOrigin, runtimeKey: `host:${host.id}`, clientToken: host.clientToken, relay: host.relay });
    finishProbe(Response.json({ serverId: host.relay!.serverId }));
    await refreshing;
    await expectRemoteWorktreeCatalog();
  });
});
