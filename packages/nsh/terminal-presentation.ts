import type { TerminalChunk } from './terminal-core';

/** One acknowledged browser batch in flight. Live deltas cross the bridge once, not
 * events × entire scrollback. Reset only on renderer reload or actual tab change. */
export function createTerminalPresentation() {
  let key: string | undefined, cursor = 0, serial = 0, previousLive: boolean | undefined;
  let flight: { serial: number; cursor: number; key: string } | undefined;
  return {
    reset() { key = undefined; cursor = 0; flight = undefined; previousLive = undefined; },
    next(nextKey: string, chunks: readonly TerminalChunk[], live: boolean) {
      const changed = key !== nextKey;
      if (changed) { key = nextKey; cursor = 0; flight = undefined; }
      const controlChanged = previousLive !== live; previousLive = live;
      const pending: TerminalChunk[] = [];
      if (!flight) {
        let start = 0, end = chunks.length;
        while (start < end) { const middle = (start + end) >>> 1; if (chunks[middle].id <= cursor) start = middle + 1; else end = middle; }
        let length = 0;
        for (let i = start; i < chunks.length; i++) { pending.push(chunks[i]); length += chunks[i].data.length; if (length >= 65_536) break; }
      }
      if (!changed && !controlChanged && !pending.length) return;
      const message = { type: 'render', key: nextKey, live, chunks: pending, serial: ++serial };
      if (pending.length) flight = { key: nextKey, cursor: pending.at(-1)!.id, serial };
      return message;
    },
    acknowledge(value: { key: unknown; cursor: unknown; serial: unknown }) {
      if (!flight || value.key !== flight.key || value.serial !== flight.serial || value.cursor !== flight.cursor) return false;
      cursor = flight.cursor; flight = undefined; return true;
    },
  };
}
