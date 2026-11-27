import React from 'react';

const EMPTY_KEYS: ReadonlySet<string> = new Set();

/**
 * Debounces membership of a key set so transient states do not flash in the UI.
 * A key joins only after it has been present for `appearMs`, and leaves only
 * after it has been absent for `hideMs`. Keys present on mount are settled at once.
 */
export const useSettledKeys = (keys: readonly string[], appearMs = 600, hideMs = 1500): ReadonlySet<string> => {
  const signature = keys.join('\n');
  const [settled, setSettled] = React.useState<ReadonlySet<string>>(() => keys.length > 0 ? new Set(keys) : EMPTY_KEYS);
  React.useEffect(() => {
    const current = new Set(signature ? signature.split('\n') : []);
    const adds = [...current].filter((key) => !settled.has(key));
    const removes = [...settled].filter((key) => !current.has(key));
    const timers: ReturnType<typeof setTimeout>[] = [];
    if (adds.length > 0) {
      timers.push(setTimeout(() => setSettled((prev) => {
        const next = new Set(prev);
        for (const key of adds) next.add(key);
        return next;
      }), appearMs));
    }
    if (removes.length > 0) {
      timers.push(setTimeout(() => setSettled((prev) => {
        const next = new Set(prev);
        for (const key of removes) next.delete(key);
        return next.size === 0 ? EMPTY_KEYS : next;
      }), hideMs));
    }
    return () => timers.forEach(clearTimeout);
  }, [appearMs, hideMs, settled, signature]);
  return settled;
};
