import { LONG_PRESS_MS, TAP_MAX_MS, isDoubleTap } from '../touch-gestures/tap';
import type { DesktopInput } from './input';

type Point = { x: number; y: number };
export type DesktopViewport = { width: number; height: number; remoteWidth: number; remoteHeight: number };
export type DesktopTransform = { scale: number; x: number; y: number };
export type DesktopInteractionMode = 'drag' | 'cursor';
export const INITIAL_DESKTOP_TRANSFORM: DesktopTransform = { scale: 1, x: 0, y: 0 };

function fit(view: DesktopViewport) {
  const ratio = Math.min(view.width / view.remoteWidth, view.height / view.remoteHeight);
  const width = view.remoteWidth * ratio, height = view.remoteHeight * ratio;
  return { width, height, x: (view.width - width) / 2, y: (view.height - height) / 2 };
}

export function desktopPoint(point: Point, view: DesktopViewport, transform: DesktopTransform): Point | null {
  if (view.width <= 0 || view.height <= 0 || view.remoteWidth <= 0 || view.remoteHeight <= 0) return null;
  const fitted = fit(view);
  const x = ((point.x - transform.x) / transform.scale - fitted.x) / fitted.width;
  const y = ((point.y - transform.y) / transform.scale - fitted.y) / fitted.height;
  return x >= 0 && x <= 1 && y >= 0 && y <= 1 ? { x, y } : null;
}

export function clampDesktopTransform(value: DesktopTransform, view: DesktopViewport, minimumScale = 1): DesktopTransform {
  const scale = Math.max(minimumScale, Math.min(5, value.scale));
  const fitted = fit(view);
  const clamp = (offset: number, start: number, size: number, viewport: number) => size * scale <= viewport
    ? (viewport - size * scale) / 2 - start * scale
    : Math.max(viewport - (start + size) * scale, Math.min(-start * scale, offset));
  return { scale, x: clamp(value.x, fitted.x, fitted.width, view.width), y: clamp(value.y, fitted.y, fitted.height, view.height) };
}

export function createDesktopGestures(options: {
  viewport: () => DesktopViewport;
  send: (input: DesktopInput) => void;
  apply: (transform: DesktopTransform, settle?: boolean) => void;
  mode: () => DesktopInteractionMode;
}) {
  const pointers = new Map<number, Point>();
  let transform = { ...INITIAL_DESKTOP_TRANSFORM };
  let start: Point | null = null;
  let previous: Point | null = null;
  let dragging = false;
  let moved = false;
  let multi = false;
  let contextClicked = false;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let lastTap: { x: number; y: number; time: number } | null = null;
  let downAt = 0;
  let pinch: { midpoint: Point; distance: number; transform: DesktopTransform } | null = null;
  const release = () => { if (dragging) options.send({ type: 'release' }); dragging = false; };
  const snapToFit = () => {
    if (transform.scale === 1 && transform.x === 0 && transform.y === 0) return;
    transform = { ...INITIAL_DESKTOP_TRANSFORM }; options.apply(transform, true);
  };
  const cancel = () => {
    clearTimeout(hold);
    release(); pointers.clear(); pinch = null; start = previous = null; multi = false;
    lastTap = null;
    if (transform.scale <= 1) snapToFit();
  };
  const measure = () => {
    const [a, b] = [...pointers.values()];
    return { midpoint: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) };
  };
  const gestures = {
    down(id: number, point: Point) {
      if (pointers.size >= 2) return;
      pointers.set(id, point);
      if (pointers.size === 1) {
        start = previous = point; moved = false; multi = false; contextClicked = false;
        downAt = Date.now();
        if (options.mode() === 'cursor') hold = setTimeout(() => {
          const remote = desktopPoint(point, options.viewport(), transform);
          if (remote && !moved && !multi) { options.send({ type: 'pointer', action: 'right', ...remote }); contextClicked = true; }
        }, LONG_PRESS_MS + 50);
      }
      if (pointers.size === 2) {
        clearTimeout(hold);
        multi = true;
        lastTap = null;
        release();
        pinch = { ...measure(), transform: { ...transform } };
      }
    },
    move(id: number, point: Point) {
      if (!pointers.has(id)) return;
      pointers.set(id, point);
      if (pointers.size === 2 && pinch) {
        const { midpoint, distance } = measure();
        const scale = Math.max(0.5, Math.min(5, pinch.transform.scale * distance / pinch.distance));
        const ratio = scale / pinch.transform.scale;
        transform = clampDesktopTransform({ scale,
          x: midpoint.x - (pinch.midpoint.x - pinch.transform.x) * ratio,
          y: midpoint.y - (pinch.midpoint.y - pinch.transform.y) * ratio,
        }, options.viewport(), 0.5);
        options.apply(transform);
        return;
      }
      if (multi || contextClicked || !start || !previous) return;
      if (Math.hypot(point.x - start.x, point.y - start.y) > 6) { moved = true; lastTap = null; clearTimeout(hold); }
      if (!moved) return;
      if (options.mode() === 'drag') {
        transform = { ...transform, x: transform.x + point.x - previous.x, y: transform.y + point.y - previous.y };
        options.apply(transform);
      } else {
        const remote = desktopPoint(point, options.viewport(), transform);
        if (remote) {
          const initial = desktopPoint(start, options.viewport(), transform);
          if (!dragging && initial) { options.send({ type: 'pointer', action: 'down', ...initial }); dragging = true; }
          if (dragging) options.send({ type: 'pointer', action: 'move', ...remote });
        }
      }
      previous = point;
    },
    moveMany(points: ReadonlyMap<number, Point>) {
      let last: [number, Point] | undefined;
      for (const [id, point] of points) {
        if (!pointers.has(id)) continue;
        pointers.set(id, point);
        last = [id, point];
      }
      if (last) gestures.move(...last);
    },
    up(id: number, point: Point, cancelled = false) {
      if (!pointers.has(id)) return;
      clearTimeout(hold);
      pointers.delete(id);
      if (options.mode() === 'cursor' && !cancelled && !multi && !moved && !contextClicked) {
        const remote = desktopPoint(point, options.viewport(), transform);
        if (remote) options.send({ type: 'pointer', action: 'click', ...remote });
      }
      if (options.mode() === 'drag' && !cancelled && !multi && !moved && Date.now() - downAt < TAP_MAX_MS) {
        const now = Date.now();
        const tap = { x: point.x, y: point.y, time: now };
        if (isDoubleTap(lastTap, tap)) {
          if (transform.scale > 1) transform = { ...INITIAL_DESKTOP_TRANSFORM };
          else {
            const scale = 2.5, ratio = scale / transform.scale;
            transform = clampDesktopTransform({ scale, x: point.x - (point.x - transform.x) * ratio,
              y: point.y - (point.y - transform.y) * ratio }, options.viewport());
          }
          options.apply(transform, true); lastTap = null;
        } else lastTap = tap;
      } else lastTap = null;
      release();
      if (!pointers.size) {
        pinch = null; start = previous = null; multi = false;
        if (transform.scale <= 1) snapToFit();
      }
    },
    cancel,
    refit() {
      if (transform.scale <= 1) { snapToFit(); return; }
      transform = clampDesktopTransform(transform, options.viewport());
      options.apply(transform);
    },
    reset() {
      cancel();
      transform = { ...INITIAL_DESKTOP_TRANSFORM }; options.apply(transform);
    },
  };
  return gestures;
}
