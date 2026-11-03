import { setTimeout as delay } from 'node:timers/promises';

const REFRESH_MS = 8000;
const TICKET_TTL_MS = 24 * 60 * 60 * 1000;

/** Optional, live-only presence. Never gate contact admission or message delivery. */
export function createWeixinTyping({ api, getBinding, isCurrent, canCancel, clock = Date.now }) {
  const entries = new Map();
  let closed = false;
  const pause = (ms, signal) => delay(ms, undefined, { signal }).catch(() => {});
  const launch = (entry) => {
    if (entry.running || entry.disposed || closed) return;
    const controller = new AbortController();
    entry.controller = controller;
    entry.running = (async () => {
      let lastTicket = '';
      let retryMs = 2000;
      try {
        while (!controller.signal.aborted && entry.turns.size && isCurrent(entry.binding)) {
          const binding = getBinding(entry.binding.assistant_id);
          try {
            if (!entry.ticket || clock() >= entry.ticketExpiresAt) {
              const config = await api.getConfig(binding, controller.signal);
              if (config.ret !== 0 || typeof config.typing_ticket !== 'string'
                || !config.typing_ticket || config.typing_ticket.length > 65_536) throw new Error('typing_unavailable');
              entry.ticket = config.typing_ticket;
              entry.ticketExpiresAt = clock() + TICKET_TTL_MS;
            }
            if (controller.signal.aborted || !entry.turns.size || !isCurrent(entry.binding)) break;
            // Record attempts too: a failed HTTP response may still have set presence.
            lastTicket = entry.ticket;
            await api.sendTyping(binding, entry.ticket, 1, controller.signal);
            retryMs = 2000;
            await pause(REFRESH_MS, controller.signal);
          } catch {
            if (controller.signal.aborted) break;
            entry.ticket = '';
            await pause(retryMs, controller.signal);
            retryMs = Math.min(60_000, retryMs * 2);
          }
        }
      } finally {
        if (lastTicket && canCancel(entry.binding)) {
          // Do not reuse the aborted start signal. Serialize cancellation before a
          // newer turn can publish typing, including during disconnect/shutdown.
          try { await api.sendTyping(entry.binding, lastTicket, 2); } catch { /* Presence is best-effort. */ }
        }
      }
    })().finally(() => {
      entry.running = null;
      if (!entry.disposed && !closed && entry.turns.size && isCurrent(entry.binding)) launch(entry);
    });
  };
  const forget = async (assistantID) => {
    const entry = entries.get(assistantID);
    if (!entry) return;
    entry.disposed = true;
    entry.turns.clear();
    entry.controller?.abort();
    await entry.running;
    if (entries.get(assistantID) === entry) entries.delete(assistantID);
  };
  const clear = () => Promise.allSettled([...entries.keys()].map(forget));
  return {
    onTurnEvent: (event) => {
      if (closed || !['yuri:contact-turn-start', 'yuri:contact-turn-end'].includes(event.type)) return;
      const { assistantID, turnID } = event.properties ?? {};
      if (typeof assistantID !== 'string' || typeof turnID !== 'string' || !turnID) return;
      const binding = getBinding(assistantID);
      if (!binding || binding.status === 'expired' || !isCurrent(binding)) return;
      let entry = entries.get(assistantID);
      if (event.type === 'yuri:contact-turn-start') {
        if (!entry) {
          entry = { binding, turns: new Set(), ticket: '', ticketExpiresAt: 0, running: null, disposed: false };
          entries.set(assistantID, entry);
        }
        if (entry.disposed || entry.binding.epoch !== binding.epoch) return;
        entry.turns.add(turnID);
        launch(entry);
      } else if (entry?.binding.epoch === binding.epoch) {
        entry.turns.delete(turnID);
        if (!entry.turns.size) entry.controller?.abort();
      }
    },
    forget, clear,
    close: () => { closed = true; return clear(); },
  };
}
