import { executionTargetKey } from './execution-target.js';

/** Coalesce one machine's watch demand, without caching authority or message bodies. */
export function createRemoteWatchReconciler(readBatch) {
  const hosts = new Map();
  let closed = false;
  return {
    reconcile(watch, changed = false) {
      if (closed) return Promise.resolve();
      const key = executionTargetKey(watch.target);
      let host = hosts.get(key);
      if (!host) {
        host = { pending: new Map(), reading: new Set(), flight: null };
        hosts.set(key, host);
      }
      if (changed || !host.reading.has(watch.sessionID)) host.pending.set(watch.sessionID, watch);
      if (!host.flight) {
        host.flight = Promise.resolve().then(async () => {
          try {
            while (!closed && host.pending.size) {
              const batch = [...host.pending.values()];
              host.pending.clear();
              host.reading = new Set(batch.map((item) => item.sessionID));
              try { await readBatch(batch, (watch) => !closed && !host.pending.has(watch.sessionID)); }
              catch { /* Durable watches remain pending for the next event or reconciliation. */ }
              finally { host.reading.clear(); }
            }
          } finally { hosts.delete(key); }
        });
      }
      return host.flight;
    },
    invalidate(watch) {
      const host = hosts.get(executionTargetKey(watch.target));
      if (!closed && host?.reading.has(watch.sessionID)) host.pending.set(watch.sessionID, watch);
    },
    close() {
      closed = true;
      for (const host of hosts.values()) host.pending.clear();
      hosts.clear();
    },
  };
}
