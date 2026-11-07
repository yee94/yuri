type Touch = { identifier: number; pageX: number; pageY: number; touches: readonly { identifier: number }[] };
type Frame = { id: string; x: number; y: number; width: number; height: number };
export type ProjectsSessionGeometry = Map<string, { measure(): Promise<{ pagePosition: { x: number; y: number }; bounds: { size: { width: number; height: number } } } | null> }>;
export type ProjectsOrderScroll = {
  viewport(): Promise<{ top: number; height: number } | null>;
  offset(): number;
  max(): number;
  scrollTo(y: number): void;
  claim(): (() => void) | null;
};
export type ProjectsSessionDragProjection = { id: string; over: string; x: number; y: number; width: number; height: number; shifts: ReadonlyMap<string, number> };

/** Mobile Projects uses the Web TouchSensor contract: 350ms hold, 6pt tolerance. */
export function createProjectsSessionDrag(options: {
  ids(): string[];
  geometry: ProjectsSessionGeometry;
  current(): boolean;
  generation(): number;
  scroll: ProjectsOrderScroll;
  changed(value: ProjectsSessionDragProjection | null): void;
  commit(active: string, over: string): void;
}) {
  let serial = 0, disposed = false;
  let hold: ReturnType<typeof setTimeout> | undefined, tick: ReturnType<typeof setTimeout> | undefined;
  let suppressed: string | undefined;
  let active: { serial: number; generation: number; id: string; finger: number; x: number; y: number; latestY: number; ids: string[]; claimed: boolean; release?: () => void;
    frames?: Frame[]; viewport?: { top: number; height: number }; originOffset: number; over?: string; shifts: ReadonlyMap<string, number>; pendingScroll?: number; forward: boolean; backward: boolean } | undefined;
  function cancel(suppress = true) {
    if (active && suppress) suppressed = active.id;
    serial++;
    if (hold) clearTimeout(hold); if (tick) clearTimeout(tick);
    hold = undefined; tick = undefined;
    active?.release?.(); active = undefined; options.changed(null);
  }
  const valid = (value: NonNullable<typeof active>) => !disposed && value === active && value.serial === serial && value.generation === options.generation() && options.current();
  function project(value: NonNullable<typeof active>) {
    const frames = value.frames, own = frames?.find(frame => frame.id === value.id);
    if (!frames || !own) return;
    const dy = value.latestY - value.y, center = own.y + own.height / 2 + dy + options.scroll.offset() - value.originOffset;
    // Measured vertical centers are monotonic; no catalog scan on pointer frames.
    let lo = 0, hi = frames.length;
    while (lo < hi) { const mid = (lo + hi) >>> 1, frame = frames[mid]!; if (frame.y + frame.height / 2 < center) lo = mid + 1; else hi = mid; }
    const before = frames[Math.max(0, lo - 1)]!, after = frames[Math.min(frames.length - 1, lo)]!;
    const target = Math.abs(before.y + before.height / 2 - center) <= Math.abs(after.y + after.height / 2 - center) ? before : after;
    if (value.over !== target.id) {
      value.over = target.id;
      const ordered = [...frames], from = ordered.indexOf(own), to = ordered.indexOf(target);
      ordered.splice(from, 1); ordered.splice(to, 0, own);
      const shifts = new Map<string, number>(); let top = frames[0]!.y;
      ordered.forEach((frame, i) => {
        if (frame !== own && top !== frame.y) shifts.set(frame.id, top - frame.y);
        const gap = i + 1 < frames.length ? frames[i + 1]!.y - (frames[i]!.y + frames[i]!.height) : 0;
        top += frame.height + gap;
      });
      value.shifts = shifts;
    }
    options.changed({ id: value.id, over: target.id, x: own.x, y: own.y + dy, width: own.width, height: own.height, shifts: value.shifts });
  }
  function autoScroll() {
    tick = undefined;
    const value = active;
    if (!value || !valid(value)) { cancel(); return; }
    if (!value.frames || !value.viewport) return;
    project(value);
    const { top, height } = value.viewport, threshold = height * .2, bottom = top + height;
    const offset = options.scroll.offset();
    // Same pointer activation/20% edge threshold as dnd-kit; one native command
    // per frame, scaled from its 10pt/5ms speed, awaiting actual offset adoption.
    let speed = 0;
    if (value.backward && value.latestY <= top + threshold && offset > 0) speed = -32 * Math.min(1, (top + threshold - value.latestY) / threshold);
    else if (value.forward && value.latestY >= bottom - threshold && offset < options.scroll.max()) speed = 32 * Math.min(1, (value.latestY - bottom + threshold) / threshold);
    if (speed && (value.pendingScroll === undefined || Math.abs(value.pendingScroll - offset) < .5)) {
      const next = Math.max(0, Math.min(options.scroll.max(), offset + speed));
      if (next !== offset) { value.pendingScroll = next; options.scroll.scrollTo(next); }
    }
    tick = setTimeout(autoScroll, 16);
  }
  async function activate(value: NonNullable<typeof active>) {
    hold = undefined;
    if (!valid(value)) { cancel(); return; }
    const release = options.scroll.claim();
    if (!release) { cancel(); return; }
    value.release = release; value.claimed = true; suppressed = value.id;
    value.originOffset = options.scroll.offset();
    try {
      const [frames, viewport] = await Promise.all([
        Promise.all(value.ids.map(async id => {
          const frame = await options.geometry.get(id)?.measure();
          if (!frame) throw new Error('Unmeasured session row');
          return { id, x: frame.pagePosition.x, y: frame.pagePosition.y, width: frame.bounds.size.width, height: frame.bounds.size.height };
        })), options.scroll.viewport(),
      ]);
      if (!valid(value)) return;
      if (!viewport || viewport.height <= 0 || options.scroll.offset() !== value.originOffset || frames.some((frame, i) => ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || frame.width <= 0 || frame.height <= 0 || (i > 0 && frame.y < frames[i - 1]!.y + frames[i - 1]!.height))) { cancel(); return; }
      value.frames = frames; value.viewport = viewport; project(value); tick = setTimeout(autoScroll, 16);
    } catch { if (active === value) cancel(); }
  }
  return {
    start(id: string, event: Touch) {
      cancel(false); suppressed = undefined;
      const ids = options.ids();
      if (disposed || !options.current() || ids.length < 2 || !ids.includes(id) || event.touches.length !== 1) return;
      const value = { serial, generation: options.generation(), id, finger: event.identifier, x: event.pageX, y: event.pageY, latestY: event.pageY, ids, claimed: false, originOffset: options.scroll.offset(), shifts: new Map<string, number>(), forward: false, backward: false };
      active = value; hold = setTimeout(() => { void activate(value); }, 350);
    },
    move(id: string, event: Touch) {
      const value = active;
      if (!value || id !== value.id) return;
      if (!valid(value) || event.touches.length !== 1 || event.identifier !== value.finger) { cancel(); return; }
      const previousY = value.latestY;
      value.latestY = event.pageY;
      if (!value.claimed) {
        if (Math.hypot(event.pageX - value.x, event.pageY - value.y) > 6) cancel();
        return;
      }
      value.forward ||= value.latestY > previousY; value.backward ||= value.latestY < previousY;
      project(value);
    },
    finish(id: string, event?: Pick<Touch, 'identifier' | 'touches'>) {
      const value = active;
      if (!value || id !== value.id) return;
      if (event && (event.identifier !== value.finger || event.touches.length > 0)) { cancel(); return; }
      const ids = options.ids();
      const commit = valid(value) && value.frames && value.over && value.over !== value.id && ids.length === value.ids.length && ids.every((id, i) => id === value.ids[i]);
      const over = value.over;
      cancel(value.claimed);
      if (commit && over) options.commit(value.id, over);
    },
    claimed: (id: string) => !!active && active.id === id && active.claimed && valid(active),
    consumeClick(id: string) { if (suppressed !== id) return false; suppressed = undefined; return true; },
    reconcile(ids: string[]) { if (active && (!valid(active) || ids.length !== active.ids.length || ids.some((id, i) => id !== active!.ids[i]))) cancel(); },
    cancel: () => cancel(),
    dispose() { disposed = true; cancel(); },
  };
}
