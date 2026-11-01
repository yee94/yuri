import { describe, expect, it, vi } from 'vitest';
import { clampDesktopTransform, createDesktopGestures, desktopPoint, INITIAL_DESKTOP_TRANSFORM } from './gestures';
import type { DesktopInput } from './connection';

const viewport = { width: 400, height: 600, remoteWidth: 1600, remoteHeight: 900 };
const center = { x: 200, y: 300 };
const setup = (scroll = false) => {
  const events: DesktopInput[] = [];
  const transforms: ReturnType<typeof clampDesktopTransform>[] = [];
  const gestures = createDesktopGestures({ viewport: () => viewport, scrollMode: () => scroll,
    send: event => events.push(event), apply: value => transforms.push(value) });
  return { gestures, events, transforms };
};

describe('remote desktop coordinate mapping and gestures', () => {
  it('long press opens the context menu once and pinch cancels the pending long press', () => {
    vi.useFakeTimers();
    try {
      const { gestures, events } = setup();
      gestures.down(1, center); vi.advanceTimersByTime(600); gestures.up(1, center);
      expect(events).toEqual([{ type: 'pointer', action: 'right', x: 0.5, y: 0.5 }]);
      gestures.down(1, center); gestures.down(2, { x: 250, y: 300 }); vi.advanceTimersByTime(1000);
      expect(events).toHaveLength(1); gestures.reset();
    } finally { vi.useRealTimers(); }
  });
  it('excludes letterboxing, maps the center and accounts for zoom and translation', () => {
    expect(desktopPoint({ x: 0, y: 0 }, viewport, INITIAL_DESKTOP_TRANSFORM)).toBeNull();
    expect(desktopPoint(center, viewport, INITIAL_DESKTOP_TRANSFORM)).toEqual({ x: 0.5, y: 0.5 });
    expect(desktopPoint(center, viewport, { scale: 2, x: -200, y: -300 })).toEqual({ x: 0.5, y: 0.5 });
    expect(desktopPoint(center, { ...viewport, width: 0 }, INITIAL_DESKTOP_TRANSFORM)).toBeNull();
  });
  it('sends a tap once, ignores taps in letterboxing and cancels without clicking', () => {
    const { gestures, events } = setup();
    gestures.down(1, center); gestures.up(1, center);
    expect(events).toEqual([{ type: 'pointer', action: 'click', x: 0.5, y: 0.5 }]);
    gestures.down(1, { x: 0, y: 0 }); gestures.up(1, { x: 0, y: 0 });
    gestures.down(1, center); gestures.up(1, center, true);
    expect(events).toHaveLength(1);
  });
  it('starts dragging at the original point and releases on cancellation or reset', () => {
    const { gestures, events } = setup();
    gestures.down(1, center); gestures.move(1, { x: 240, y: 300 });
    expect(events).toEqual([
      { type: 'pointer', action: 'down', x: 0.5, y: 0.5 },
      { type: 'pointer', action: 'move', x: 0.6, y: 0.5 },
    ]);
    gestures.reset();
    expect(events.at(-1)).toEqual({ type: 'release' });
    gestures.up(1, center);
    expect(events).toHaveLength(3);
  });
  it('two fingers zoom at the midpoint, pan locally, and never click after lifting one finger', () => {
    const { gestures, events, transforms } = setup();
    gestures.down(1, { x: 150, y: 300 }); gestures.down(2, { x: 250, y: 300 });
    gestures.move(1, { x: 100, y: 300 }); gestures.move(2, { x: 300, y: 300 });
    const zoom = transforms.at(-1)!;
    expect(zoom.scale).toBe(2);
    expect(desktopPoint(center, viewport, zoom)).toEqual({ x: 0.5, y: 0.5 });
    gestures.up(2, { x: 300, y: 300 }); gestures.move(1, { x: 120, y: 300 }); gestures.up(1, { x: 120, y: 300 });
    expect(events).toEqual([]);
    expect(clampDesktopTransform({ scale: 100, x: 999999, y: -999999 }, viewport).scale).toBe(5);
  });
  it('switching from drag to pinch releases the remote mouse immediately', () => {
    const { gestures, events } = setup();
    gestures.down(1, center); gestures.move(1, { x: 220, y: 300 });
    gestures.down(2, { x: 100, y: 300 });
    expect(events.at(-1)).toEqual({ type: 'release' });
  });
  it('scroll mode emits relative scroll, not mouse-down, and hundreds of pinch moves send no network input', () => {
    const { gestures, events } = setup(true);
    gestures.down(1, center); gestures.move(1, { x: 200, y: 330 }); gestures.up(1, { x: 200, y: 330 });
    expect(events).toEqual([{ type: 'scroll', dx: 0, dy: -30 }]);
    gestures.down(1, center); gestures.down(2, { x: 250, y: 300 });
    for (let i = 0; i < 500; i++) gestures.move(2, { x: 250 + i / 10, y: 300 });
    expect(events).toHaveLength(1);
  });
});
