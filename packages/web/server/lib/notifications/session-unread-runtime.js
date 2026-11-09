import express from 'express';
import { isVisibleSession } from '../session-index/service.js';

/** Only lifecycle boundaries do work; token, part and message deltas never read or write. */
export function createSessionUnreadRuntime({ store, loadSession, hub, resolveDirectory = value => value, retryMs = 1000 }) {
  const flights = new Map();
  const queues = new Map();
  let disposed = false;
  const directoryOf = session => resolveDirectory(session.location?.directory ?? session.directory ?? '');
  const visible = session => session && !session.parentID && isVisibleSession(session);
  const apply = async ({ payload, id, kind }) => {
    if (kind === 'deleted') { store.remove(id); return; }
    const session = await loadSession(id);
    if (disposed || !visible(session)) return;
    store.observe({ id, directory: directoryOf(session), kind, eventAt: payload.created, sequence: payload.durable?.seq });
  };
  const drain = (id, queue) => {
    if (disposed || flights.has(id) || queue.timer) return;
    const flight = (async () => {
      while (!disposed && queue.items.length) {
        try {
          await apply(queue.items[0]);
          queue.items.shift().resolve();
          queue.attempt = 0;
        } catch {
          // Preserve the failed boundary and its following run boundaries in order.
          // Other sessions have independent queues and can continue normally.
          const delay = Math.min(retryMs * 2 ** Math.min(queue.attempt++, 5), 30000);
          queue.timer = setTimeout(() => { queue.timer = null; drain(id, queue); }, delay);
          queue.timer.unref?.();
          console.warn('[session-unread] lifecycle update deferred; retrying');
          return;
        }
      }
      if (!queue.items.length) queues.delete(id);
    })();
    flights.set(id, flight);
    void flight.finally(() => {
      if (flights.get(id) === flight) flights.delete(id);
      const pending = queues.get(id);
      if (pending) drain(id, pending);
    });
  };
  const processEvent = (envelope) => {
    const raw = envelope?.payload ?? envelope;
    const payload = raw?.payload ?? raw;
    const type = payload?.type?.replace(/\.\d+$/, '');
    const body = payload?.data ?? payload?.properties ?? {};
    const id = body.sessionID ?? body.sessionId ?? body.info?.id ?? body.id;
    if (typeof id !== 'string' || !id) return Promise.resolve();
    const kind = type === 'session.execution.started' || (type === 'session.status' && body.status?.type === 'busy') ? 'running'
      : type === 'session.execution.succeeded' || type === 'session.idle' ? 'complete'
        : type === 'session.execution.failed' || type === 'session.error' ? 'error'
          : type === 'session.deleted' ? 'deleted' : null;
    if (!kind || disposed) return Promise.resolve();
    const queue = queues.get(id) ?? { items: [], timer: null, attempt: 0 };
    queues.set(id, queue);
    const completion = new Promise(resolve => {
      queue.items.push({ payload, id, kind, resolve });
    });
    drain(id, queue);
    return completion;
  };
  const unsubscribe = hub?.subscribeEvent(event => {
    void processEvent(event).catch(() => console.warn('[session-unread] lifecycle update failed'));
  });
  return {
    processEvent,
    registerRoutes(app) {
      app.get('/api/yuri/session-unread', (_req, res) => {
        try { res.json(store.snapshot()); }
        catch { res.status(503).json({ error: 'Session unread state unavailable' }); }
      });
      app.put('/api/yuri/session-unread/:id', express.json({ limit: '8kb' }), async (req, res) => {
        const { unread, expectedRevision } = req.body ?? {};
        const id = req.params.id;
        if (!id || id.length > 512 || typeof unread !== 'boolean'
          || (!unread && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0))) {
          return res.status(400).json({ error: 'Invalid session unread mutation' });
        }
        try {
          const session = await loadSession(id);
          if (!session) return res.status(404).json({ error: 'Session not found' });
          if (!visible(session)) return res.status(400).json({ error: 'Session is not a visible root conversation' });
          res.json(store.mark({ id, directory: directoryOf(session), unread, expectedRevision }));
        } catch { res.status(503).json({ error: 'Session unread state unavailable' }); }
      });
    },
    async close() {
      disposed = true;
      unsubscribe?.();
      for (const queue of queues.values()) {
        clearTimeout(queue.timer);
        for (const item of queue.items) item.resolve();
      }
      await Promise.allSettled(flights.values());
      queues.clear();
      store.close();
    },
  };
}
