import { createNativeAssistantFrames } from './assistants-avatar-frame';

export type NativeAvatarFrame = { uri: string; settled: boolean };
type Frames = ReturnType<typeof createNativeAssistantFrames>;
type Clock = { now: () => number; schedule: (work: () => void, delay: number) => unknown; cancel: (handle: unknown) => void };
export type NativeAvatarLease = { release: () => void; working: (value: boolean) => void };

/** One timer for the native JS runtime; one reference player/model/URI per Host + Bot + recipe.
 * Subscribers only write their own Image source. No page/store publication occurs.
 */
export function createNativeAvatarClock(options: { clock?: Clock; frames?: (seed: string) => Frames } = {}) {
  const clock: Clock = options.clock ?? { now: () => performance.now(), schedule: (work, delay) => setTimeout(work, delay), cancel: handle => clearTimeout(handle as ReturnType<typeof setTimeout>) };
  const makeFrames = options.frames ?? createNativeAssistantFrames;
  type Listener = { paint: (frame: NativeAvatarFrame) => void; working: boolean };
  type Entry = { source: Frames; listeners: Set<Listener>; uri: string; previous: number; resting: boolean; settleDeadline: number };
  const entries = new Map<string, Entry>();
  let timer: unknown, scheduled = false;
  const interval = 1000 / 30;
  function schedule() {
    if (scheduled || !entries.size) return;
    scheduled = true;
    timer = clock.schedule(tick, interval);
  }
  function tick() {
    scheduled = false;
    const timestamp = clock.now();
    for (const [key, entry] of [...entries]) {
      if (!entries.has(key)) continue;
      entry.uri = entry.source.sample(Math.min(0.1, Math.max(0, (timestamp - entry.previous) / 1000)));
      entry.previous = timestamp;
      const settled = entry.resting && (entry.source.settled() || timestamp >= entry.settleDeadline);
      if (settled) entry.uri = entry.source.still();
      for (const listener of [...entry.listeners]) if (entry.listeners.has(listener)) listener.paint({ uri: entry.uri, settled });
      if (settled && entries.get(key) === entry) entries.delete(key);
    }
    schedule();
  }
  function subscribe(scope: string, identity: string, seed: string, paint: Listener['paint']): NativeAvatarLease {
    const key = JSON.stringify([scope, identity, seed]);
    let entry = entries.get(key);
    if (!entry) {
      const source = makeFrames(seed);
      entry = { source, listeners: new Set(), uri: source.sample(0), previous: clock.now(), resting: false, settleDeadline: 0 };
      entries.set(key, entry);
    }
    const source = entry, listener: Listener = { paint, working: true };
    source.listeners.add(listener);
    if (source.resting) { source.resting = false; source.source.setResting(false); }
    paint({ uri: source.uri, settled: false });
    schedule();
    let released = false;
    function reconcile() {
      const resting = ![...source.listeners].some(item => item.working);
      if (resting !== source.resting) { source.resting = resting; source.source.setResting(resting); source.settleDeadline = clock.now() + 1500; }
    }
    return {
      working(value) { if (released || listener.working === value || entries.get(key) !== source) return; listener.working = value; reconcile(); },
      release() {
        if (released) return;
        released = true; source.listeners.delete(listener);
        if (entries.get(key) !== source) return;
        if (!source.listeners.size) entries.delete(key); else reconcile();
        if (!entries.size && scheduled) { clock.cancel(timer); scheduled = false; }
      },
    };
  }
  return { subscribe };
}

export const nativeAssistantAvatarClock = createNativeAvatarClock();
