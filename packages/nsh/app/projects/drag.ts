import type { GestureResponderEvent, ViewRef } from 'nsh';

/** Where the dragged row floats, and how far the rows around it move to make room. */
export type DragProjection = {
  id: string;
  over: string;
  x: number;
  y: number;
  width: number;
  height: number;
  shifts: ReadonlyMap<string, number>;
};

type Frame = { id: string; x: number; y: number; width: number; height: number };

type Active = {
  serial: number;
  id: string;
  finger: number;
  x: number;
  y: number;
  latestY: number;
  ids: string[];
  claimed: boolean;
  frames?: Frame[];
  own?: Frame;
  over?: string;
  shifts: ReadonlyMap<string, number>;
};

const HOLD_MS = 350; // Web's TouchSensor activation delay
const TOLERANCE = 6; // Web's TouchSensor tolerance

/**
 * Long-press drag ordering over a measured session list (Web `SessionFolderDndScope`
 * behavior): hold a row, drag it, the rows it passes move aside, release to commit.
 */
export function createSessionDrag(options: {
  ids: () => string[];
  geometry: Map<string, ViewRef>;
  canDrag: () => boolean;
  onChange: (value: DragProjection | null) => void;
  onCommit: (active: string, over: string, ids: string[]) => void;
}) {
  let serial = 0;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let suppressed: string | undefined;
  let shown: DragProjection | null = null;
  let active: Active | undefined;

  const cancel = (suppress = true) => {
    if (active && suppress) suppressed = active.id;
    serial += 1;
    if (hold) clearTimeout(hold);
    hold = undefined;
    active = undefined;
    if (shown) {
      shown = null;
      options.onChange(null);
    }
  };

  const valid = (value: Active) => value === active && value.serial === serial;

  function project(value: Active) {
    if (!value.frames || !value.own) return;
    const own = value.own;
    const dy = value.latestY - value.y;
    const center = own.y + own.height / 2 + dy;
    const frames = value.frames;
    let low = 0;
    let high = frames.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const frame = frames[middle]!;
      if (frame.y + frame.height / 2 < center) low = middle + 1;
      else high = middle;
    }
    const before = frames[Math.max(0, low - 1)]!;
    const after = frames[Math.min(frames.length - 1, low)]!;
    const target =
      Math.abs(before.y + before.height / 2 - center) <= Math.abs(after.y + after.height / 2 - center) ? before : after;
    if (value.over !== target.id) {
      value.over = target.id;
      const ordered = [...frames];
      const from = ordered.indexOf(own);
      const to = ordered.indexOf(target);
      ordered.splice(from, 1);
      ordered.splice(to, 0, own);
      const shifts = new Map<string, number>();
      let top = frames[0]!.y;
      ordered.forEach((frame, index) => {
        if (frame !== own && top !== frame.y) shifts.set(frame.id, top - frame.y);
        const gap = index + 1 < frames.length ? frames[index + 1]!.y - (frames[index]!.y + frames[index]!.height) : 0;
        top += frame.height + gap;
      });
      value.shifts = shifts;
    }
    if (shown && shown.id === value.id && shown.over === target.id && shown.y === own.y + dy) return;
    shown = { id: value.id, over: target.id, x: own.x, y: own.y + dy, width: own.width, height: own.height, shifts: value.shifts };
    options.onChange(shown);
  }

  async function activate(value: Active) {
    hold = undefined;
    if (!valid(value) || !options.canDrag()) {
      cancel();
      return;
    }
    value.claimed = true;
    suppressed = value.id;
    try {
      const frames = await Promise.all(
        value.ids.map(async (id) => {
          const frame = await options.geometry.get(id)?.measure();
          if (!frame) throw new Error('Unmeasured session row');
          return {
            id,
            x: frame.pagePosition.x,
            y: frame.pagePosition.y,
            width: frame.bounds.size.width,
            height: frame.bounds.size.height,
          };
        }),
      );
      if (!valid(value)) return;
      const usable = frames.every(
        (frame, index) =>
          [frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) &&
          frame.width > 0 &&
          frame.height > 0 &&
          (index === 0 || frame.y >= frames[index - 1]!.y + frames[index - 1]!.height),
      );
      if (!usable) {
        cancel();
        return;
      }
      value.frames = frames;
      value.own = frames.find((frame) => frame.id === value.id);
      project(value);
    } catch {
      if (active === value) cancel();
    }
  }

  return {
    start(id: string, event: GestureResponderEvent) {
      cancel(false);
      suppressed = undefined;
      const ids = options.ids();
      if (!options.canDrag() || ids.length < 2 || !ids.includes(id) || event.touches.length !== 1) return;
      const value: Active = {
        serial,
        id,
        finger: event.identifier,
        x: event.pageX,
        y: event.pageY,
        latestY: event.pageY,
        ids,
        claimed: false,
        shifts: new Map<string, number>(),
      };
      active = value;
      hold = setTimeout(() => void activate(value), HOLD_MS);
    },
    move(id: string, event: GestureResponderEvent) {
      const value = active;
      if (!value || value.id !== id) return;
      if (!valid(value) || event.touches.length !== 1 || event.identifier !== value.finger) {
        cancel();
        return;
      }
      value.latestY = event.pageY;
      if (!value.claimed) {
        if (Math.hypot(event.pageX - value.x, event.pageY - value.y) > TOLERANCE) cancel();
        return;
      }
      project(value);
    },
    finish(id: string, event?: GestureResponderEvent) {
      const value = active;
      if (!value || value.id !== id) return;
      if (event && (event.identifier !== value.finger || event.touches.length > 0)) {
        cancel();
        return;
      }
      if (valid(value)) {
        if (event && Number.isFinite(event.pageY)) value.latestY = event.pageY;
        project(value);
      }
      const ids = options.ids();
      const commit =
        valid(value) &&
        !!value.frames &&
        !!value.over &&
        value.over !== value.id &&
        ids.length === value.ids.length &&
        ids.every((entry, index) => entry === value.ids[index]);
      const over = value.over;
      cancel(value.claimed);
      if (commit && over) options.onCommit(value.id, over, value.ids);
    },
    claimed: (id: string) => !!active && active.id === id && active.claimed && valid(active),
    consumeClick(id: string) {
      if (suppressed !== id) return false;
      suppressed = undefined;
      return true;
    },
    cancel: () => cancel(),
    reconcile(ids: string[]) {
      if (active && (!valid(active) || ids.length !== active.ids.length || ids.some((entry, index) => entry !== active!.ids[index]))) {
        cancel();
      }
    },
  };
}

export type SessionDrag = ReturnType<typeof createSessionDrag>;
