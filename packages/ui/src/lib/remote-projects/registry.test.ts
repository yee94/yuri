import { describe, expect, it, vi } from 'vitest';
import { HostRuntimeRegistry, type HostRuntimeDependencies } from './registry';
import { locationCachePartition, locationKey, locationSessionKey, parseLocationKey } from './location';
import { parseHostCatalog, parseRemoteHost, type RemoteHost } from './types';

const host = (id: string, state: RemoteHost['state'] = 'connected'): RemoteHost => ({ id, name: id, source: 'direct', state });
const makeRegistry = () => {
  let current = true;
  const fetch = vi.fn<HostRuntimeDependencies['fetch']>(async () => new Response('{}'));
  const sdk = vi.fn<HostRuntimeDependencies['sdk']>(() => { throw new Error('SDK was not demanded'); });
  const service = vi.fn<NonNullable<HostRuntimeDependencies['service']>>(() => { throw new Error('Service was not demanded'); });
  const registry = new HostRuntimeRegistry('hub-a', { transportIdentity: 'transport-a', isCurrent: () => current, fetch, sdk, service });
  return { registry, fetch, sdk, service, switchHub: () => { current = false; } };
};

describe('Host Runtime Registry production boundary', () => {
  it('keeps a scoped entry and pending filesystem result across its own cold transport admission', async () => {
    const { registry, fetch, sdk, service } = makeRegistry();
    sdk.mockReturnValue({} as ReturnType<HostRuntimeDependencies['sdk']>);
    service.mockReturnValue({} as ReturnType<NonNullable<HostRuntimeDependencies['service']>>);
    const scoped = { ...host('a', 'idle'), scopeGeneration: 'scope-a', generation: 'wire-0' };
    registry.applyCatalog({ hubId: 'hub-a', supported: true, hosts: [scoped], projects: [] });
    const entry = registry.resolve({ hubId: 'hub-a', hostId: 'a', directory: '/' });
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = entry.fetch('/api/fs/home');
    for (let index = 1; index <= 20; index += 1) {
      registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'a', host: {
        ...scoped, state: index % 2 ? 'connecting' : 'idle', generation: `wire-${index}`, lastConnectedAt: index,
      } } });
      expect(registry.resolve(entry.location)).toBe(entry);
    }
    finish(Response.json({ home: '/fixture/home' }));
    await expect(pending).resolves.toBeInstanceOf(Response);
    entry.sdk();
    entry.service();
    expect(sdk.mock.calls[0][1]?.isCurrent()).toBe(true);
    expect(service.mock.calls[0][1]?.isCurrent()).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects old fetch/SDK/service closures on real scope revocation, including removal and same-ID readdition', async () => {
    const { registry, fetch, sdk, service } = makeRegistry();
    sdk.mockReturnValue({} as ReturnType<HostRuntimeDependencies['sdk']>);
    service.mockReturnValue({} as ReturnType<NonNullable<HostRuntimeDependencies['service']>>);
    const scoped = { ...host('a'), scopeGeneration: 'scope-a', generation: 'wire-a' };
    registry.applyCatalog({ hubId: 'hub-a', supported: true, hosts: [scoped], projects: [] });
    const entry = registry.resolve({ hubId: 'hub-a', hostId: 'a', directory: '/same' });
    entry.sdk(); entry.service();
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = entry.fetch('/api/fs/home');
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'a', host: { ...scoped, scopeGeneration: 'scope-b' } } });
    finish(Response.json({ home: '/old-target' }));
    await expect(pending).rejects.toThrow('connection changed');
    expect(() => entry.sdk()).toThrow('connection changed');
    expect(() => entry.service()).toThrow('connection changed');
    expect(sdk.mock.calls[0][1]?.isCurrent()).toBe(false);
    expect(service.mock.calls[0][1]?.isCurrent()).toBe(false);
    const replacement = registry.resolve(entry.location);
    expect(replacement).not.toBe(entry);
    expect(registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'a', host: scoped } })).toBe(false);
    registry.applyCatalog({ hubId: 'hub-a', supported: true, hosts: [scoped], projects: [] });
    expect(registry.getHost('a')?.scopeGeneration).toBe('scope-b');
    registry.applyCatalog({ hubId: 'hub-a', supported: true, hosts: [], projects: [] });
    expect(() => replacement.sdk()).toThrow('connection changed');
    registry.applyCatalog({ hubId: 'hub-a', supported: true, hosts: [{ ...scoped, scopeGeneration: 'scope-c', generation: 'wire-c' }], projects: [] });
    expect(registry.resolve(entry.location)).not.toBe(replacement);
    expect(registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'a', host: { ...scoped, scopeGeneration: 'scope-b' } } })).toBe(false);
  });

  it('retires a closed wire independently of a stable scope and does not revive it after a short-request idle gap', () => {
    const { registry } = makeRegistry();
    const scoped = { ...host('a', 'connecting'), scopeGeneration: 'scope-a', generation: 'wire-a', available: true };
    registry.applyCatalog({ hubId: 'hub-a', supported: true, projects: [], hosts: [scoped] });
    const entry = registry.resolve({ hubId: 'hub-a', hostId: 'a', directory: '/' });
    const idle = { ...host('a', 'idle'), scopeGeneration: 'scope-a' };
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'a', host: idle } });
    expect(registry.resolve(entry.location)).toBe(entry);
    const event = (generation: string) => ({ type: 'yuri:host-event', properties: { hubId: 'hub-a', hostId: 'a', generation, payload: { type: 'session.text.delta' } } });
    expect(registry.ingest(event('wire-a'))).toBe(false);
    expect(registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'a', host: { ...scoped, generation: 'wire-b' } } })).toBe(true);
    expect(registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'a', host: scoped } })).toBe(false);
    expect(registry.ingest(event('wire-b'))).toBe(true);
    expect(registry.resolve(entry.location)).toBe(entry);
  });

  it('validates scope tokens and refuses a legacy downgrade after a scoped Host has been observed', () => {
    expect(parseRemoteHost({ ...host('a'), scopeGeneration: 'opaque-scope' }).scopeGeneration).toBe('opaque-scope');
    expect(parseRemoteHost(host('a')).scopeGeneration).toBeUndefined();
    for (const scopeGeneration of ['', 1, null, ['scope'], 'bad\nvalue']) {
      expect(() => parseRemoteHost({ ...host('a'), scopeGeneration })).toThrow();
    }
    const { registry } = makeRegistry();
    registry.applyCatalog({ hubId: 'hub-a', supported: true, projects: [], hosts: [{ ...host('a'), scopeGeneration: 'scope-a' }] });
    expect(registry.ingest({ type: 'yuri:host-event', properties: { hubId: 'hub-a', hostId: 'a', generation: 'old-wire', payload: { type: 'session.text.delta' } } })).toBe(false);
    expect(registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'a', host: host('a', 'offline') } })).toBe(false);
    expect(registry.getHost('a')?.scopeGeneration).toBe('scope-a');
  });

  it('revokes a known scope when an unavailable Host omits scopeGeneration and cannot revive its retired authority', async () => {
    const { registry, fetch } = makeRegistry();
    const scoped = { ...host('a'), scopeGeneration: 'scope-a' };
    registry.applyCatalog({ hubId: 'hub-a', supported: true, projects: [], hosts: [scoped] });
    const entry = registry.resolve({ hubId: 'hub-a', hostId: 'a', directory: '/' });
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = entry.fetch('/api/fs/home');
    expect(registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'a', host: { ...host('a', 'offline'), available: false } } })).toBe(true);
    finish(Response.json({ home: '/old-target' }));
    await expect(pending).rejects.toThrow('connection changed');
    registry.applyCatalog({ hubId: 'hub-a', supported: true, projects: [], hosts: [scoped] });
    expect(registry.getHost('a')?.available).toBe(false);
    expect(registry.getHost('a')?.scopeGeneration).toBeUndefined();
    registry.applyCatalog({ hubId: 'hub-a', supported: true, projects: [], hosts: [{ ...scoped, scopeGeneration: 'scope-b' }] });
    expect(registry.getHost('a')?.scopeGeneration).toBe('scope-b');
  });
  it('keeps local persisted keys while separating Hub, host, path and session', () => {
    const local = { hubId: 'hub-a', directory: '/project' };
    expect(locationKey(local)).toBe('/project');
    expect(locationSessionKey(local, 'session-1')).toBe('session-1');
    expect(locationCachePartition(local)).toBe('hub-a');
    const a = { ...local, hostId: 'host-a' };
    const variants = [a, { ...a, hubId: 'hub-b' }, { ...a, hostId: 'host-b' }, { ...a, directory: '/other' }];
    expect(new Set(variants.map(locationKey)).size).toBe(4);
    expect(new Set(variants.map((location) => locationSessionKey(location, 'same-id'))).size).toBe(4);
    expect(parseLocationKey(locationKey(a), 'other-hub')).toEqual(a);
    expect(parseLocationKey('/project', 'hub-a')).toEqual(local);
    expect(() => parseLocationKey('yuri-remote-location:["hub-a"]', 'hub-a')).toThrow();
  });

  it('does zero network, SDK, service, timer or realtime work for local-only resolution', () => {
    vi.useFakeTimers();
    try {
      const { registry, fetch, sdk, service } = makeRegistry();
      for (let i = 0; i < 300; i += 1) registry.resolve({ hubId: 'hub-a', directory: `/p/${i}` });
      expect(fetch).not.toHaveBeenCalled();
      expect(sdk).not.toHaveBeenCalled();
      expect(service).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('routes real paths and request fidelity through the Hub without changing local scope', async () => {
    const { registry, fetch } = makeRegistry();
    const remote = registry.resolve({ hubId: 'hub-a', hostId: 'host/a', directory: '/机器/project' });
    const signal = new AbortController().signal;
    const body = JSON.stringify({ path: '/机器/project/a.txt' });
    await remote.fetch('/api/fs/write', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, signal });
    expect(fetch).toHaveBeenCalledWith('/api/hosts/host%2Fa/api/fs/write', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, signal,
    });
    expect(remote.location.directory).toBe('/机器/project');
    await registry.resolve({ hubId: 'hub-a', directory: '/机器/project' }).fetch('/api/fs/list');
    expect(fetch).toHaveBeenLastCalledWith('/api/fs/list', undefined);
    expect(() => registry.resolve({ hubId: 'hub-b', directory: '/project' })).toThrow('another Hub');
    await expect(remote.fetch('/api/hosts/other/api/fs/list')).rejects.toThrow('Nested');
    await expect(remote.fetch('https://external.invalid/api/fs/list')).rejects.toThrow('Only runtime');
  });

  it('shares foreground connection requests and keeps unavailable or failed Hosts isolated', async () => {
    const { registry, fetch } = makeRegistry();
    registry.applyCatalog({ supported: true, hubId: 'hub-a', projects: [], hosts: [host('a', 'offline'), host('b'), { ...host('removed', 'offline'), available: false }] });
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const first = registry.connectHost('a');
    const second = registry.connectHost('a');
    expect(second).toBe(first);
    await registry.connectHost('b');
    await expect(registry.connectHost('removed')).rejects.toThrow('unavailable');
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(Response.json({ host: host('a') }));
    await first;
    expect(registry.getHost('a')?.state).toBe('connected');
    expect(registry.getHost('b')?.state).toBe('connected');
    expect(fetch.mock.calls[0]).toEqual(['/api/hosts/a/connect', { method: 'POST' }]);
  });

  it('rejects late requests when an already offline Host becomes unavailable without another state transition', async () => {
    const { registry, fetch } = makeRegistry();
    const offline = { ...host('a', 'offline'), available: true };
    registry.applyCatalog({ supported: true, hubId: 'hub-a', projects: [], hosts: [offline] });
    const entry = registry.resolve({ hubId: 'hub-a', hostId: 'a', directory: '/raw/path' });
    let finish!: (response: Response) => void;
    fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const request = entry.fetch('/api/session');
    registry.applyCatalog({ supported: true, hubId: 'hub-a', projects: [], hosts: [{ ...offline, available: false }] });
    finish(Response.json({ id: 'old-result' }));
    await expect(request).rejects.toThrow('connection changed');
    expect(registry.resolve(entry.location)).not.toBe(entry);
    expect(registry.ingest({ type: 'yuri:host-event', properties: { hubId: 'hub-a', hostId: 'a', payload: { type: 'message.part.delta' } } })).toBe(false);
  });

  it('fences both new dispatch and late responses when the root Hub changes', async () => {
    const harness = makeRegistry();
    let finish!: (response: Response) => void;
    harness.fetch.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const entry = harness.registry.resolve({ hubId: 'hub-a', hostId: 'host-a', directory: '/project' });
    const pending = entry.fetch('/api/session/s1');
    harness.switchHub();
    finish(new Response('{}'));
    await expect(pending).rejects.toThrow('Inactive Hub');
    await expect(entry.fetch('/api/session/s1')).rejects.toThrow('Inactive Hub');
    expect(harness.fetch).toHaveBeenCalledTimes(1);
  });

  it('isolates status subscribers, preserves unrelated references and ignores token-frequency events', () => {
    const { registry } = makeRegistry();
    const hosts = Array.from({ length: 5 }, (_, index) => host(`host-${index}`));
    registry.applyCatalog({ hubId: 'hub-a', supported: true, hosts, projects: [] });
    const listeners = hosts.map((value) => {
      const listener = vi.fn();
      registry.subscribeHost(value.id, listener);
      return listener;
    });
    const eventListeners = hosts.map((value) => {
      const listener = vi.fn();
      registry.subscribeEvents(value.id, listener);
      return listener;
    });
    const unchanged = registry.getHost('host-4');
    for (let i = 0; i < 1_000; i += 1) registry.ingest({ type: 'yuri:host-event', properties: {
      hubId: 'hub-a', hostId: 'host-1', directory: '/project', payload: { type: 'session.step.streamed', delta: 'a' },
    } });
    expect(listeners.every((listener) => listener.mock.calls.length === 0)).toBe(true);
    expect(eventListeners[1]).toHaveBeenCalledTimes(1_000);
    expect(eventListeners.filter((_, index) => index !== 1).every((listener) => listener.mock.calls.length === 0)).toBe(true);
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'host-1', host: host('host-1', 'offline') } });
    expect(listeners[1]).toHaveBeenCalledTimes(1);
    expect(listeners.filter((_, index) => index !== 1).every((listener) => listener.mock.calls.length === 0)).toBe(true);
    expect(registry.getHost('host-4')).toBe(unchanged);
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'host-1', host: host('host-1', 'offline') } });
    expect(listeners[1]).toHaveBeenCalledTimes(1);
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-b', hostId: 'host-1', host: host('host-1') } });
    expect(listeners[1]).toHaveBeenCalledTimes(1);
  });

  it('conservatively fences legacy Hosts without scopeGeneration on reconnect without invalidating a sibling', async () => {
    const { registry, fetch } = makeRegistry();
    registry.applyCatalog({ hubId: 'hub-a', supported: true, hosts: [host('host-a'), host('host-b')], projects: [] });
    const finishes: Array<(response: Response) => void> = [];
    fetch.mockImplementation(() => new Promise((resolve) => { finishes.push(resolve); }));
    const a = registry.resolve({ hubId: 'hub-a', hostId: 'host-a', directory: '/same' });
    const b = registry.resolve({ hubId: 'hub-a', hostId: 'host-b', directory: '/same' });
    const oldA = a.fetch('/api/session/same');
    const healthyB = b.fetch('/api/session/same');
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'host-a', host: host('host-a', 'connecting') } });
    finishes[0](new Response('{}'));
    finishes[1](new Response('{}'));
    await expect(oldA).rejects.toThrow('connection changed');
    await expect(healthyB).resolves.toBeInstanceOf(Response);
  });

  it('rejects old wire generations after a host connection has been replaced', () => {
    const { registry } = makeRegistry();
    registry.applyCatalog({ hubId: 'hub-a', supported: true, hosts: [{ ...host('host-a'), generation: 'old-connection' }], projects: [] });
    const listener = vi.fn();
    registry.subscribeEvents('host-a', listener);
    const envelope = (generation: string) => ({ type: 'yuri:host-event', properties: { hubId: 'hub-a', hostId: 'host-a', generation, payload: { type: 'session.step.streamed' } } });
    registry.ingest(envelope('old-connection'));
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'host-a', host: { ...host('host-a'), generation: 'new-connection' } } });
    registry.ingest(envelope('old-connection'));
    registry.ingest(envelope('new-connection'));
    expect(listener).toHaveBeenCalledTimes(2);
    registry.ingest({ type: 'yuri:host-status', properties: { hubId: 'hub-a', hostId: 'host-a', host: { ...host('host-a'), generation: 'old-connection' } } });
    expect(registry.getHost('host-a')?.generation).toBe('new-connection');
  });

  it('constructs credential-free DTOs and preserves same-path projects from distinct hosts', () => {
    const value = parseHostCatalog({
      hubId: 'hub-a', supported: true,
      hosts: [{ ...host('host-a'), clientToken: 'must-not-retain', apiUrl: 'https://private.invalid' }],
      projects: ['host-a', 'host-b'].map((hostId) => ({
        id: `${hostId}-project`, path: '/project', hostId, remoteProjectId: 'same-id', remoteState: 'ok', clientToken: 'must-not-retain',
      })),
    });
    expect(value.hosts[0]).not.toHaveProperty('clientToken');
    expect(value.hosts[0]).not.toHaveProperty('apiUrl');
    expect(value.projects).toHaveLength(2);
    expect(value.projects[0]).not.toHaveProperty('clientToken');
  });
});
