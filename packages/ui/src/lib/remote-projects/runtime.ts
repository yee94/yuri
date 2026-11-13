import { subscribeYuriEvents } from '@/lib/yuriEvents';
import { isCapacitorApp } from '@/lib/platform';
import { HostContentDemand } from './content-demand';
import type { HostRuntimeRegistry } from './registry';
import { queryClient } from '@/lib/queryRuntime';
import { getRuntimeTransportIdentity } from '@/lib/runtime-switch';
import { remoteHostSummariesKey } from './summaries';

type RuntimeServices = {
  demand: HostContentDemand;
  retain(): () => void;
};
const services = new WeakMap<HostRuntimeRegistry, RuntimeServices>();

/** Exactly one event consumer and demand owner per Hub registry, shared by visible panes. */
export const getHostRuntimeServices = (registry: HostRuntimeRegistry): RuntimeServices => {
  const existing = services.get(registry);
  if (existing) return existing;
  const demand = new HostContentDemand(registry);
  let count = 0;
  let unsubscribe: (() => void) | undefined;
  let lifecycleCleanup: (() => void) | undefined;
  const result: RuntimeServices = {
    demand,
    retain: () => {
      count += 1;
      if (count === 1 && !unsubscribe) {
        unsubscribe = subscribeYuriEvents((event) => {
          if (event.type === 'event-stream-ready' || event.type === 'global-event-stream-ready') {
            demand.recover();
            void queryClient.invalidateQueries({ queryKey: [getRuntimeTransportIdentity(), 'remote-projects', 'summaries', registry.hubId] });
            void queryClient.invalidateQueries({ queryKey: [getRuntimeTransportIdentity(), 'remote-projects', 'catalog'] });
            return;
          }
          if (event.type === 'remote-host-status' || event.type === 'remote-host-event') {
            const properties = event.envelope.properties as { hostId?: unknown };
            const hostId = typeof properties.hostId === 'string' ? properties.hostId : undefined;
            const previous = hostId ? registry.getHost(hostId) : undefined;
            if (!registry.ingest(event.envelope)) return;
            if (event.type === 'remote-host-event' && hostId) {
              const value = event.envelope.properties as { payload?: unknown };
              const payload = value.payload && typeof value.payload === 'object' ? value.payload as Record<string, unknown> : undefined;
              if (payload?.type === 'yuri:content-ready' && payload.properties && typeof payload.properties === 'object') {
                const ready = payload.properties as { id?: unknown; sessionId?: unknown; channelId?: unknown; readyGeneration?: unknown };
                if (typeof ready.id === 'string' && typeof ready.channelId === 'string' && typeof ready.readyGeneration === 'string') {
                  demand.contentReady(hostId, ready.id, typeof ready.sessionId === 'string' ? ready.sessionId : undefined, ready.channelId, ready.readyGeneration);
                }
              }
              if (typeof payload?.type === 'string' && (payload.type === 'yuri:worktree-topology-changed' || /^yuri:session-(?:index-changed|unread-changed|order-changed|folders-changed|metadata)$/.test(payload.type))) {
                void queryClient.invalidateQueries({ queryKey: remoteHostSummariesKey(getRuntimeTransportIdentity(), registry.hubId, hostId) });
              }
              if (typeof payload?.type === 'string' && /^yuri:projects?-/.test(payload.type)) {
                void queryClient.invalidateQueries({ queryKey: [getRuntimeTransportIdentity(), 'remote-projects', 'catalog'] });
              }
            }
            if (event.type === 'remote-host-status' && hostId) {
              void queryClient.invalidateQueries({ queryKey: remoteHostSummariesKey(getRuntimeTransportIdentity(), registry.hubId, hostId) });
              const current = registry.getHost(hostId);
              if (current?.state === 'connected' && (previous?.state !== 'connected' || previous.lastConnectedAt !== current.lastConnectedAt)) {
                demand.recover(hostId);
              }
            }
          }
        });
        let disposed = false;
        let nativeActive = true;
        let wasForeground = true;
        let nativeRevision = 0;
        let removeNative: (() => void) | undefined;
        const update = () => {
          const foreground = nativeActive && document.visibilityState !== 'hidden';
          if (foreground && !wasForeground) {
            void queryClient.invalidateQueries({ queryKey: [getRuntimeTransportIdentity(), 'remote-projects', 'summaries', registry.hubId] });
          }
          wasForeground = foreground;
          demand.setForeground(foreground);
        };
        document.addEventListener('visibilitychange', update);
        update();
        if (isCapacitorApp()) {
          void import('@capacitor/app').then(async ({ App }) => {
            if (disposed) return;
            const handle = await App.addListener('appStateChange', ({ isActive }) => {
              nativeRevision += 1;
              nativeActive = isActive;
              update();
            });
            if (disposed) { void handle.remove(); return; }
            removeNative = () => { void handle.remove(); };
            const revision = nativeRevision;
            const state = await App.getState().catch(() => null);
            if (!disposed && state && nativeRevision === revision) {
              nativeActive = state.isActive;
              update();
            }
          }).catch(() => undefined);
        }
        lifecycleCleanup = () => {
          disposed = true;
          document.removeEventListener('visibilitychange', update);
          removeNative?.();
        };
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        count -= 1;
        // React StrictMode can release and reacquire a mounted pane in one turn.
        queueMicrotask(() => {
          if (count !== 0) return;
          unsubscribe?.();
          unsubscribe = undefined;
          lifecycleCleanup?.();
          lifecycleCleanup = undefined;
          demand.dispose();
          services.delete(registry);
        });
      };
    },
  };
  services.set(registry, result);
  return result;
};
