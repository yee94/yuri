import { locationSessionKey, type HostLocation } from './location';
import type { HostRuntimeRegistry } from './registry';
import { resolveRemoteProjectOwner, type RemoteWorktreeTopology } from './summaries';

type Observer = { refresh: () => void | Promise<void>; error: (error: unknown) => void };
type Demand = {
  location: HostLocation;
  sessionId: string;
  observers: Set<Observer>;
  id?: string;
  flight?: Promise<void>;
  epoch: number;
  readyIds: Map<string, { channelId?: string; readyGeneration?: string }>;
  channelId?: string;
  readyGenerations: Set<string>;
  readyRevision: number;
  refreshFlight?: Promise<void>;
  notFound?: boolean;
  topologyKey?: string;
  attemptedTopologyKey?: string;
};

/** Client demand only. The Hub owns cross-window deduplication and the global cap. */
export class HostContentDemand {
  private readonly demands = new Map<string, Demand>();
  private foreground = true;
  private disposed = false;

  constructor(private readonly registry: HostRuntimeRegistry) {}

  retain(location: HostLocation, sessionId: string, observer: Observer): () => void {
    if (this.disposed) throw new Error('Disposed remote content demand');
    if (!location.hostId) return () => {};
    if (location.hubId !== this.registry.hubId) throw new Error('Content demand belongs to another Hub');
    const key = locationSessionKey(location, sessionId);
    let demand = this.demands.get(key);
    if (!demand) {
      demand = { location: { ...location }, sessionId, observers: new Set(), epoch: 0, readyIds: new Map(), readyGenerations: new Set(), readyRevision: 0 };
      this.demands.set(key, demand);
    }
    demand.observers.add(observer);
    if (demand.id && demand.readyRevision > 0 && this.foreground) {
      const epoch = demand.epoch;
      void Promise.resolve().then(() => {
        if (!this.disposed && epoch === demand.epoch && this.foreground && demand.observers.has(observer)) return observer.refresh();
      }).catch((error: unknown) => {
        if (!this.disposed && demand.observers.has(observer)) observer.error(error);
      });
    }
    this.activate(demand);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      demand.observers.delete(observer);
      if (demand.observers.size) return;
      demand.epoch += 1;
      this.demands.delete(key);
      this.release(demand);
    };
  }

  setForeground(foreground: boolean): void {
    if (this.disposed || foreground === this.foreground) return;
    this.foreground = foreground;
    for (const demand of this.demands.values()) {
      demand.epoch += 1;
      if (foreground) { demand.notFound = false; this.activate(demand); }
      else this.release(demand);
    }
  }

  recover(hostId?: string): void {
    if (this.disposed || !this.foreground) return;
    for (const demand of this.demands.values()) {
      if (hostId && demand.location.hostId !== hostId) continue;
      demand.epoch += 1;
      demand.notFound = false;
      this.release(demand);
      this.activate(demand);
    }
  }

  /** Retry only a rejected visible lease whose directory now has a new authority mapping. */
  topologyAvailable(hostId: string, topology: RemoteWorktreeTopology | undefined): void {
    if (this.disposed || !topology) return;
    const projects = Object.keys(topology.projectDirectories).map((path) => ({ path, hubId: this.registry.hubId, hostId }));
    for (const demand of this.demands.values()) {
      if (demand.location.hostId !== hostId) continue;
      const owner = resolveRemoteProjectOwner(projects, this.registry.hubId, hostId, demand.location.directory, topology);
      if (!owner && demand.topologyKey) demand.attemptedTopologyKey = undefined;
      demand.topologyKey = owner ? JSON.stringify([owner.path, topology.projectDirectories[owner.path]]) : undefined;
      if (demand.notFound) this.activate(demand);
    }
  }

  contentReady(hostId: string, id: string, sessionId?: string, channelId?: string, readyGeneration?: string): void {
    if (this.disposed || !this.foreground) return;
    for (const demand of this.demands.values()) {
      if (demand.location.hostId !== hostId || (sessionId && demand.sessionId !== sessionId)) continue;
      if (demand.id === id) void this.refreshReady(demand, id, channelId, readyGeneration);
      else if (demand.flight && sessionId === demand.sessionId) {
        demand.readyIds.set(id, { channelId, readyGeneration });
        if (demand.readyIds.size > 8) demand.readyIds.delete(demand.readyIds.keys().next().value!);
      }
    }
  }

  private refreshReady(demand: Demand, id: string, channelId?: string, readyGeneration?: string): Promise<void> {
    if (demand.id !== id) return Promise.resolve();
    if (channelId && demand.channelId && channelId !== demand.channelId) return Promise.resolve();
    if (readyGeneration && demand.readyGenerations.has(readyGeneration)) return Promise.resolve();
    if (channelId) demand.channelId = channelId;
    if (readyGeneration) demand.readyGenerations.add(readyGeneration);
    demand.readyRevision += 1;
    demand.readyIds.clear();
    if (demand.refreshFlight) return demand.refreshFlight;
    const epoch = demand.epoch;
    const run = async () => {
      while (!this.disposed && epoch === demand.epoch && demand.id === id && this.foreground) {
        const revision = demand.readyRevision;
        const observers = Array.from(demand.observers);
        const results = await Promise.allSettled(observers.map((observer) => Promise.resolve().then(observer.refresh)));
        if (this.disposed || epoch !== demand.epoch) return;
        for (let index = 0; index < observers.length; index += 1) {
          const result = results[index];
          const observer = observers[index];
          if (result.status === 'rejected' && demand.observers.has(observer)) observer.error(result.reason);
        }
        if (revision === demand.readyRevision) return;
      }
    };
    const flight = run().finally(() => { if (demand.refreshFlight === flight) demand.refreshFlight = undefined; });
    demand.refreshFlight = flight;
    return flight;
  }

  private activate(demand: Demand): void {
    if (this.disposed || !this.foreground || !demand.observers.size || demand.id || demand.flight) return;
    if (demand.notFound && (!demand.topologyKey || demand.topologyKey === demand.attemptedTopologyKey)) return;
    const epoch = demand.epoch;
    const hostId = demand.location.hostId!;
    demand.attemptedTopologyKey = demand.topologyKey;
    demand.notFound = false;
    const flight = (async () => {
      const response = await this.registry.requestHost(hostId, 'subscriptions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: demand.location.directory, sessionId: demand.sessionId }),
      });
      if (!response.ok) {
        if (response.status === 404 && epoch === demand.epoch) demand.notFound = true;
        throw new Error(`Remote content subscription failed (${response.status})`);
      }
      const payload: unknown = await response.json();
      this.registry.assertCurrent();
      const id = payload && typeof payload === 'object' && 'id' in payload ? payload.id : undefined;
      if (typeof id !== 'string' || !id || id.length > 512) throw new Error('Invalid remote subscription identity');
      if (this.disposed || epoch !== demand.epoch || !this.foreground || !demand.observers.size) {
        await this.deleteSubscription(hostId, id);
        return;
      }
      demand.id = id;
      const ready = payload as { channelId?: unknown; readyGeneration?: unknown };
      if (typeof ready.channelId === 'string') demand.channelId = ready.channelId;
      // HTTP lease registration is not proof that the content upstream is ready.
      const pendingReady = demand.readyIds.get(id);
      if (pendingReady) await this.refreshReady(demand, id, pendingReady.channelId, pendingReady.readyGeneration);
      if (typeof ready.readyGeneration === 'string') {
        await this.refreshReady(demand, id, demand.channelId, ready.readyGeneration);
      }
    })();
    demand.flight = flight;
    void flight.catch((error: unknown) => {
      if (!this.disposed && epoch === demand.epoch && this.foreground) {
        for (const observer of demand.observers) observer.error(error);
      }
    }).finally(() => {
      if (demand.flight === flight) demand.flight = undefined;
      // A resume during an old acquisition must acquire after that old lease is released.
      if (epoch !== demand.epoch || demand.notFound) this.activate(demand);
    });
  }

  private async deleteSubscription(hostId: string, id: string): Promise<void> {
    const response = await this.registry.requestHost(hostId, `subscriptions/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!response.ok && response.status !== 404) throw new Error(`Remote content release failed (${response.status})`);
  }

  private release(demand: Demand): void {
    const id = demand.id;
    demand.id = undefined;
    demand.refreshFlight = undefined;
    demand.readyRevision = 0;
    demand.channelId = undefined;
    demand.readyGenerations.clear();
    demand.readyIds.clear();
    if (!id) return;
    void this.deleteSubscription(demand.location.hostId!, id).catch((error: unknown) => {
      if (!this.disposed) for (const observer of demand.observers) observer.error(error);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const demand of this.demands.values()) {
      demand.epoch += 1;
      demand.observers.clear();
      this.release(demand);
    }
    this.demands.clear();
  }
}
