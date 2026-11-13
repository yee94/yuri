import type { OpenCodeClient } from '@/lib/opencode/v2-types';
import type { LocationOpencodeService } from '@/lib/opencode/client';
import type { RuntimeFetchOptions } from '@/lib/runtime-fetch';
import { hostApiPath, locationCachePartition, locationKey, type HostLocation } from './location';
import { parseRemoteHost, type HostCatalog, type RemoteHost } from './types';

export interface HostRuntimeEntry {
  readonly location: Readonly<HostLocation>;
  readonly key: string;
  readonly cachePartition: string;
  /** Local logical scope revision; the legacy field name is not a physical wire UUID. */
  readonly connectionGeneration: number;
  readonly queryScope: readonly [string, string, string, string, number];
  sdk(): OpenCodeClient;
  service(): LocationOpencodeService;
  fetch(path: string, init?: RuntimeFetchOptions): Promise<Response>;
}

export interface HostRuntimeDependencies {
  /** Captured current-Hub transport identity, never an upstream host URL or token. */
  transportIdentity: string;
  isCurrent(): boolean;
  fetch(path: string, init?: RuntimeFetchOptions): Promise<Response>;
  sdk(location: HostLocation, fence?: HostScopeFence, scope?: HostRuntimeEntry): OpenCodeClient;
  service?(location: HostLocation, fence?: HostScopeFence, scope?: HostRuntimeEntry): LocationOpencodeService;
}

export interface HostScopeFence {
  generation: number;
  isCurrent(): boolean;
}

type Listener = () => void;
type EventListener = (event: { directory?: string; payload: unknown }) => void;

/** No IO, socket, subscription or timer is created by construction or local resolution. */
export class HostRuntimeRegistry {
  readonly hubId: string;
  private readonly entries = new Map<string, HostRuntimeEntry>();
  private readonly hosts = new Map<string, RemoteHost>();
  private readonly hostGenerations = new Map<string, number>();
  private readonly retiredWireGenerations = new Map<string, Set<string>>();
  private readonly retiredScopeGenerations = new Map<string, Set<string>>();
  private readonly scopeAwareHosts = new Set<string>();
  private readonly hostListeners = new Map<string, Set<Listener>>();
  private readonly eventListeners = new Map<string, Set<EventListener>>();
  private readonly connections = new Map<string, Promise<void>>();
  private disposed = false;

  constructor(hubId: string, private readonly dependencies: HostRuntimeDependencies) {
    if (!hubId.trim()) throw new Error('A registry requires the current Hub identity');
    this.hubId = hubId;
  }

  assertCurrent(): void {
    if (this.disposed || !this.dependencies.isCurrent()) throw new Error('Inactive Hub registry');
  }

  async requestHost(hostId: string, resource: string, init?: RuntimeFetchOptions): Promise<Response> {
    this.assertCurrent();
    if (!hostId || !/^(?:projects|subscriptions|connect|summaries)(?:\/[^?#]*)?$/.test(resource)) {
      throw new Error('Invalid Remote Host control resource');
    }
    const response = await this.dependencies.fetch(`/api/hosts/${encodeURIComponent(hostId)}/${resource}`, init);
    this.assertCurrent();
    return response;
  }

  resolve(location: HostLocation): HostRuntimeEntry {
    this.assertCurrent();
    if (location.hubId !== this.hubId) throw new Error('Location belongs to another Hub');
    if (!location.hostId && location.instanceId && location.instanceId !== this.hubId) throw new Error('Location belongs to another instance');
    const instanceId = location.hostId ? this.hosts.get(location.hostId)?.instanceId : location.instanceId;
    if (location.instanceId && instanceId && location.instanceId !== instanceId) throw new Error('Location belongs to another instance');
    const key = locationKey(location);
    const fence = this.captureHostFence(location.hostId);
    const previous = this.entries.get(key);
    if (previous && previous.connectionGeneration === (fence?.generation ?? 0)
      && previous.location.instanceId === (instanceId ?? location.instanceId)) return previous;
    const captured = Object.freeze({ ...location, ...(instanceId ? { instanceId } : {}) });
    const assertScope = () => {
      this.assertCurrent();
      if (fence && !fence.isCurrent()) throw new Error('Remote Host connection changed during request');
      if (captured.hostId && captured.instanceId && this.hosts.get(captured.hostId)?.instanceId
        && captured.instanceId !== this.hosts.get(captured.hostId)?.instanceId) throw new Error('Location belongs to another instance');
    };
    const entry: HostRuntimeEntry = Object.freeze({
      location: captured,
      key,
      cachePartition: locationCachePartition(captured),
      connectionGeneration: fence?.generation ?? 0,
      queryScope: Object.freeze([
        this.dependencies.transportIdentity, this.hubId, captured.hostId ?? '', key, fence?.generation ?? 0,
      ] as const),
      sdk: () => {
        assertScope();
        return this.dependencies.sdk(captured, fence, entry);
      },
      service: () => {
        assertScope();
        if (!this.dependencies.service) throw new Error('OpenCode service is not configured for this registry');
        return this.dependencies.service(captured, fence, entry);
      },
      fetch: async (path: string, init?: RuntimeFetchOptions) => {
        assertScope();
        let options = init;
        if (captured.hostId && captured.instanceId) {
          const headers = new Headers(init?.headers);
          headers.set('x-yuri-target-instance', captured.instanceId);
          options = { ...init, headers };
        }
        const response = await this.dependencies.fetch(hostApiPath(captured.hostId, path), options);
        assertScope();
        return response;
      },
    });
    this.entries.set(key, entry);
    return entry;
  }

  private captureHostFence(hostId: string | undefined): HostScopeFence | undefined {
    if (!hostId) return undefined;
    const generation = this.hostGenerations.get(hostId) ?? 0;
    return {
      generation,
      isCurrent: () => !this.disposed && this.dependencies.isCurrent() && (this.hostGenerations.get(hostId) ?? 0) === generation,
    };
  }

  applyCatalog(catalog: HostCatalog): void {
    this.assertCurrent();
    if (catalog.hubId !== this.hubId) throw new Error('Catalog belongs to another Hub');
    const present = new Set<string>();
    for (const host of catalog.hosts) {
      present.add(host.id);
      this.updateHost(host);
    }
    for (const id of this.hosts.keys()) {
      if (present.has(id)) continue;
      const previous = this.hosts.get(id)!;
      if (previous.scopeGeneration) this.retireScope(id, previous.scopeGeneration);
      this.hosts.delete(id);
      this.hostGenerations.set(id, (this.hostGenerations.get(id) ?? 0) + 1);
      this.notifyHost(id);
    }
  }

  getHost = (hostId: string): RemoteHost | undefined => this.hosts.get(hostId);

  /** Visible project demand wakes a Host once; concurrent panes share that request. */
  connectHost(hostId: string, { verify = false }: { verify?: boolean } = {}): Promise<void> {
    this.assertCurrent();
    const previous = this.connections.get(hostId);
    if (previous) return previous;
    const host = this.hosts.get(hostId);
    // Directory entry must await bootstrap/auth admission, not a cached status badge.
    if (!verify && (host?.state === 'connected' || host?.state === 'connecting')) return Promise.resolve();
    if ((verify && !host) || host?.available === false) return Promise.reject(new Error('Remote Host is unavailable'));
    const flight = (async () => {
      const response = await this.requestHost(hostId, 'connect', { method: 'POST' });
      const payload: unknown = await response.json();
      this.assertCurrent();
      if (!response.ok) {
        const detail = payload && typeof payload === 'object' ? payload as { error?: unknown } : undefined;
        throw new Error(typeof detail?.error === 'string' ? detail.error : `Remote Host connection failed (${response.status})`);
      }
      const value = payload && typeof payload === 'object' ? payload as { host?: unknown } : undefined;
      const connected = parseRemoteHost(value?.host);
      if (connected.id !== hostId) throw new Error('Remote Host connection response identity mismatch');
      if (!this.hosts.has(hostId) || this.hosts.get(hostId)?.available === false) throw new Error('Remote Host is unavailable');
      if (!this.updateHost(connected)) throw new Error('Stale Remote Host scope response');
    })();
    this.connections.set(hostId, flight);
    const cleanup = () => { if (this.connections.get(hostId) === flight) this.connections.delete(hostId); };
    void flight.then(cleanup, cleanup);
    return flight;
  }

  subscribeHost(hostId: string, listener: Listener): () => void {
    this.assertCurrent();
    let listeners = this.hostListeners.get(hostId);
    if (!listeners) this.hostListeners.set(hostId, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.hostListeners.delete(hostId);
    };
  }

  subscribeEvents(hostId: string, listener: EventListener): () => void {
    this.assertCurrent();
    let listeners = this.eventListeners.get(hostId);
    if (!listeners) this.eventListeners.set(hostId, listeners = new Set());
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.eventListeners.delete(hostId);
    };
  }

  /** Feed from the existing Hub realtime connection; this class never opens a socket. */
  ingest(event: { type: string; properties: unknown }): boolean {
    if (this.disposed || !this.dependencies.isCurrent()) return false;
    if (event.type !== 'yuri:host-status' && event.type !== 'yuri:host-event') return false;
    const properties = event.properties;
    if (!properties || typeof properties !== 'object') return false;
    const value = properties as Record<string, unknown>;
    if (value.hubId !== this.hubId || typeof value.hostId !== 'string') return false;
    if (event.type === 'yuri:host-status') {
      let host: RemoteHost;
      try { host = parseRemoteHost(value.host); } catch { return false; }
      if (host.id !== value.hostId) return false;
      return this.updateHost(host);
    }
    const currentHost = this.hosts.get(value.hostId);
    if (currentHost?.available === false) return false;
    if (typeof value.generation === 'string' && this.retiredWireGenerations.get(value.hostId)?.has(value.generation)) return false;
    const generation = currentHost?.generation;
    if (currentHost?.scopeGeneration && generation === undefined) return false;
    if (generation !== undefined && value.generation !== generation) return false;
    const listeners = this.eventListeners.get(value.hostId);
    if (!listeners?.size) return true;
    const envelope = {
      ...(typeof value.directory === 'string' ? { directory: value.directory } : {}),
      payload: value.payload,
    };
    for (const listener of listeners) listener(envelope);
    return true;
  }

  private retireScope(hostId: string, generation: string): void {
    let retired = this.retiredScopeGenerations.get(hostId);
    if (!retired) this.retiredScopeGenerations.set(hostId, retired = new Set());
    retired.add(generation);
  }

  private updateHost(host: RemoteHost): boolean {
    const previous = this.hosts.get(host.id);
    if (host.scopeGeneration && this.retiredScopeGenerations.get(host.id)?.has(host.scopeGeneration)) return false;
    if (!host.scopeGeneration && this.scopeAwareHosts.has(host.id) && host.available !== false) return false;
    if (host.generation && this.retiredWireGenerations.get(host.id)?.has(host.generation)) return false;
    if (previous && previous.name === host.name && previous.source === host.source && previous.state === host.state
      && previous.preparationPhase === host.preparationPhase
      && previous.lastConnectedAt === host.lastConnectedAt && previous.lastSyncedAt === host.lastSyncedAt
      && previous.version === host.version && previous.instanceId === host.instanceId && previous.available === host.available && previous.generation === host.generation && previous.scopeGeneration === host.scopeGeneration && previous.lastError?.code === host.lastError?.code
      && previous.lastError?.message === host.lastError?.message
      && previous.capabilities?.remoteProjects === host.capabilities?.remoteProjects) return true;
    if (host.scopeGeneration) this.scopeAwareHosts.add(host.id);
    if (previous?.scopeGeneration && previous.scopeGeneration !== host.scopeGeneration) this.retireScope(host.id, previous.scopeGeneration);
    if (previous?.generation && previous.generation !== host.generation) {
      let retired = this.retiredWireGenerations.get(host.id);
      if (!retired) this.retiredWireGenerations.set(host.id, retired = new Set());
      retired.add(previous.generation);
      if (retired.size > 16) retired.delete(retired.values().next().value!);
    }
    const scopeChanged = previous?.scopeGeneration !== host.scopeGeneration;
    const unavailableChanged = previous && previous.available !== host.available
      && (previous.available === false || host.available === false);
    const legacyConnectionChanged = !host.scopeGeneration && previous && (previous.state !== host.state
      || previous.available !== host.available || previous.lastConnectedAt !== host.lastConnectedAt || previous.generation !== host.generation);
    // First admission replaces the entry too; its Query work cannot reuse the unpinned owner's flight.
    const authorityChanged = previous && host.instanceId !== previous.instanceId;
    if (scopeChanged || unavailableChanged || legacyConnectionChanged || authorityChanged) {
      this.hostGenerations.set(host.id, (this.hostGenerations.get(host.id) ?? 0) + 1);
    }
    this.hosts.set(host.id, host);
    this.notifyHost(host.id);
    return true;
  }

  private notifyHost(hostId: string): void {
    const listeners = this.hostListeners.get(hostId);
    if (listeners) for (const listener of listeners) listener();
  }

  dispose(): void {
    this.disposed = true;
    this.entries.clear();
    this.hosts.clear();
    this.hostGenerations.clear();
    this.retiredWireGenerations.clear();
    this.retiredScopeGenerations.clear();
    this.scopeAwareHosts.clear();
    this.hostListeners.clear();
    this.eventListeners.clear();
    this.connections.clear();
  }
}
