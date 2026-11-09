import type { ResourceStat } from './resources-model';

const signature = (stat: ResourceStat) => JSON.stringify([stat.size, stat.mtimeMs, stat.isBinary]);

/** One file owner, one timeout, one serial stat/read lane. No runtime or signal imports. */
export function createResourceWatcher(input: {
  current: () => boolean;
  identity: () => string;
  available: () => boolean;
  stat: () => Promise<ResourceStat>;
  read: () => Promise<ResourceStat | undefined>;
  failed: (cause: unknown) => void;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined, flight: Promise<void> | undefined;
  let running = false, disposed = false, revision = 0, queued = false;
  let baseline: ResourceStat | undefined;
  const valid = (at: number, identity: string) => !disposed && at === revision && identity === input.identity() && input.current();
  function clear() { clearTimeout(timer); timer = undefined; }
  function schedule() {
    clear();
    if (running && !disposed && input.current()) timer = setTimeout(() => { timer = undefined; void run(false); }, 2_000);
  }
  async function read(at: number, identity: string) {
    const next = await input.read();
    // The read's pre-download stat is the baseline, not a later stat that might
    // describe bytes never displayed. A change during download is caught next tick.
    if (valid(at, identity)) baseline = next;
  }
  function run(manual: boolean): Promise<void> {
    clear();
    if (disposed || !input.current()) return Promise.resolve();
    if (flight) { if (manual) queued = true; return flight; }
    if (!input.available()) { schedule(); return Promise.resolve(); }
    const at = revision, identity = input.identity();
    flight = (async () => {
      try {
        if (manual) await read(at, identity);
        else {
          const next = await input.stat();
          if (!valid(at, identity) || !input.available()) return;
          if (!baseline || signature(next) !== signature(baseline)) await read(at, identity);
        }
      } catch (cause) { if (valid(at, identity)) input.failed(cause); }
      finally {
        flight = undefined;
        if (queued && !disposed && input.current()) { queued = false; void run(true); }
        else { queued = false; schedule(); }
      }
    })();
    return flight;
  }
  return {
    refresh: () => run(true),
    start() { if (disposed || running) return; running = true; schedule(); },
    pause() { running = false; revision++; queued = false; clear(); },
    reset() { baseline = undefined; },
    dispose() { disposed = true; running = false; revision++; queued = false; clear(); },
  };
}
