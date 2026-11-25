import React from 'react';

/** Rows added per frame across every list on screen (a heavy file row costs ~0.3ms). */
export const ROWS_PER_FRAME = 30;
/** Rows a list mounts synchronously: enough to fill a sidebar viewport. */
export const INITIAL_ROWS = 30;
/** Initial rows when many directories open at once (expand-all, restored state). */
export const BULK_INITIAL_ROWS = 8;

type Grow = () => void;

const queue: Grow[] = [];
let frame: number | null = null;

const drain = (): void => {
  frame = null;
  // One list grows per frame so a burst of opened directories cannot stack their chunks.
  queue.shift()?.();
  if (queue.length > 0) frame = requestAnimationFrame(drain);
};

/** Queue one growth step for a list; the returned function cancels it. */
// eslint-disable-next-line react-refresh/only-export-components -- Frame scheduler shared with the component.
export const scheduleRowChunk = (grow: Grow): (() => void) => {
  queue.push(grow);
  if (frame === null) frame = requestAnimationFrame(drain);
  return () => {
    const index = queue.indexOf(grow);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0 && frame !== null) {
      cancelAnimationFrame(frame);
      frame = null;
    }
  };
};

/**
 * How many of `total` entries may be mounted now: `initialRows` at first, then
 * `rowsPerFrame` more per frame (shared queue). Only grows while mounted, so a
 * view switch remounts from the small first chunk and a refresh never unmounts.
 */
// eslint-disable-next-line react-refresh/only-export-components -- Hook form of the same chunking for virtualized lists.
export function useProgressiveCount(total: number, initialRows: number, rowsPerFrame: number = ROWS_PER_FRAME, resetKey?: unknown): number {
  const [state, setState] = React.useState({ resetKey, count: initialRows });
  // A component instance shared by two views restarts from the small chunk when the view changes.
  if (state.resetKey !== resetKey) setState({ resetKey, count: initialRows });
  const count = state.resetKey === resetKey ? state.count : initialRows;
  React.useEffect(() => {
    if (count >= total) return;
    return scheduleRowChunk(() => setState((current) => ({ ...current, count: current.count + rowsPerFrame })));
  }, [count, total, rowsPerFrame, resetKey]);
  return Math.min(count, total);
}

type ProgressiveRowsProps<T> = {
  items: readonly T[];
  initialRows: number;
  renderItem: (item: T, index: number) => React.ReactNode;
};

/**
 * Mounts a long list in frame-sized chunks so opening a large directory never
 * blocks one frame on mounting every row. The mounted count only grows, so a
 * refresh that reorders or adds entries never unmounts rows already shown.
 */
export function ProgressiveRows<T>({ items, initialRows, renderItem }: ProgressiveRowsProps<T>): React.ReactNode {
  const count = useProgressiveCount(items.length, initialRows);
  const visible = count >= items.length ? items : items.slice(0, count);
  return visible.map((item, index) => renderItem(item, index));
}
