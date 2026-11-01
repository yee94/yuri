/**
 * One definition of tap, double tap and long press timing for every touch
 * surface. Surfaces must not invent their own thresholds: image preview,
 * remote desktop and contact bubbles all feel the same because they share these.
 */
export const TAP_MAX_MS = 450;
export const TAP_SLOP_PX = 16;
export const DOUBLE_TAP_MS = 280;
export const DOUBLE_TAP_DISTANCE_PX = 32;
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_MOVE_PX = 12;

export type TapSample = { x: number; y: number; time: number };

export const isDoubleTap = (previous: TapSample | null, current: TapSample): boolean => previous !== null
  && current.time - previous.time <= DOUBLE_TAP_MS
  && Math.hypot(current.x - previous.x, current.y - previous.y) <= DOUBLE_TAP_DISTANCE_PX;

type PointerLike = Pick<PointerEvent, 'pointerType' | 'clientX' | 'clientY' | 'timeStamp'>;

export type TapResult = 'none' | 'tap' | 'double-tap';

/**
 * Classifies pointer down/up pairs. A tap is quick and stationary: a hold or a
 * drag belongs to the platform (native selection, scrolling) and is never a tap.
 * Timestamps are always `event.timeStamp`, the clock image preview uses, so
 * taps from different handlers compare on one timeline.
 */
export function createTapRecognizer() {
  let origin: TapSample | null = null;
  let last: TapSample | null = null;
  return {
    down(event: PointerLike) {
      origin = event.pointerType === 'mouse' ? null : { x: event.clientX, y: event.clientY, time: event.timeStamp };
    },
    up(event: PointerLike): TapResult {
      const start = origin;
      origin = null;
      if (!start) return 'none';
      const sample = { x: event.clientX, y: event.clientY, time: event.timeStamp };
      if (sample.time - start.time > TAP_MAX_MS || Math.hypot(sample.x - start.x, sample.y - start.y) > TAP_SLOP_PX) {
        last = null;
        return 'none';
      }
      if (isDoubleTap(last, sample)) {
        last = null;
        return 'double-tap';
      }
      last = sample;
      return 'tap';
    },
    /** Android may pointercancel mid-tap when it starts a native pan or selection. */
    cancel() {
      origin = null;
    },
    forgetLast() {
      last = null;
    },
  };
}

/**
 * Double tap on one resolved element inside `root`.
 *
 * `resolve` maps an event target to the element the gesture belongs to, or null
 * when the target must keep its own behavior (links, buttons, media). Two taps
 * count only on the same element. The native `dblclick` is accepted as a
 * fallback because Android Chromium can cancel the pointer stream of a tap that
 * the platform starts treating as a pan or selection; it never fires twice.
 */
export function bindDoubleTap<T extends HTMLElement>(root: HTMLElement, options: {
  resolve: (target: EventTarget | null) => T | null;
  onDoubleTap: (element: T) => void;
}): () => void {
  const recognizer = createTapRecognizer();
  let lastElement: T | null = null;
  let firedAt = Number.NEGATIVE_INFINITY;
  const fire = (element: T, time: number) => {
    firedAt = time;
    lastElement = null;
    options.onDoubleTap(element);
  };
  const handleDown = (event: PointerEvent) => recognizer.down(event);
  const handleUp = (event: PointerEvent) => {
    const element = options.resolve(event.target);
    const result = recognizer.up(event);
    if (!element) {
      recognizer.forgetLast();
      lastElement = null;
      return;
    }
    if (result === 'tap') {
      lastElement = element;
    } else if (result === 'double-tap') {
      if (lastElement === element) fire(element, event.timeStamp);
      else lastElement = null;
    } else {
      lastElement = null;
    }
  };
  const handleCancel = () => recognizer.cancel();
  const handleDoubleClick = (event: MouseEvent) => {
    const element = options.resolve(event.target);
    if (!element) return;
    event.preventDefault();
    if (event.timeStamp - firedAt < DOUBLE_TAP_MS * 2) return;
    fire(element, event.timeStamp);
  };
  root.addEventListener('pointerdown', handleDown, true);
  root.addEventListener('pointerup', handleUp, true);
  root.addEventListener('pointercancel', handleCancel, true);
  root.addEventListener('dblclick', handleDoubleClick, true);
  return () => {
    root.removeEventListener('pointerdown', handleDown, true);
    root.removeEventListener('pointerup', handleUp, true);
    root.removeEventListener('pointercancel', handleCancel, true);
    root.removeEventListener('dblclick', handleDoubleClick, true);
  };
}
