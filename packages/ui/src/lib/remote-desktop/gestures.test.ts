import { describe, expect, it, vi } from 'vitest';
import { clampDesktopTransform, createDesktopGestures, desktopPoint, INITIAL_DESKTOP_TRANSFORM } from './gestures';
import type { DesktopInput } from './connection';

const viewport = { width: 400, height: 600, remoteWidth: 1600, remoteHeight: 900 };
const center = { x: 200, y: 300 };
const setup = (drag = false) => {
  const events: DesktopInput[] = [];
  const transforms: ReturnType<typeof clampDesktopTransform>[] = [];
  const gestures = createDesktopGestures({ viewport: () => viewport, mode: () => drag ? 'drag' : 'cursor',
    send: event => events.push(event), apply: value => transforms.push(value) });
  return { gestures, events, transforms };
};

describe('remote desktop coordinate mapping and gestures', () => {
  it('batches both fingers before computing one anchored pinch transform and ignores stale pointers', () => {
    const { gestures, transforms, events } = setup(true);
    gestures.down(1, { x: 150, y: 300 }); gestures.down(2, { x: 250, y: 300 });
    gestures.moveMany(new Map([[1, { x: 100, y: 300 }], [2, { x: 300, y: 300 }], [99, center]]));
    expect(transforms).toEqual([{ scale: 2, x: -200, y: -300 }]);
    gestures.up(2, { x: 300, y: 300 }); gestures.up(1, { x: 100, y: 300 });
    gestures.moveMany(new Map([[1, center], [2, center]]));
    expect(transforms).toHaveLength(1);
    expect(events).toEqual([]);
  });
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
  it('Drag pans freely without clicking or native input, including hundreds of pinch moves', () => {
    const { gestures, events, transforms } = setup(true);
    gestures.down(1, center); gestures.move(1, { x: 200, y: 330 });
    expect(transforms.at(-1)).toEqual({ scale: 1, x: 0, y: 30 });
    gestures.up(1, { x: 200, y: 330 });
    expect(transforms.at(-1)).toEqual(INITIAL_DESKTOP_TRANSFORM);
    expect(events).toEqual([]);
    gestures.down(1, center); gestures.down(2, { x: 250, y: 300 });
    for (let i = 0; i < 500; i++) gestures.move(2, { x: 250 + i / 10, y: 300 });
    expect(events).toHaveLength(0);
  });
  it('allows a pinch below fit and snaps to fit only after the final finger lifts', () => {
    const { gestures, events, transforms } = setup(true);
    gestures.down(1, { x: 100, y: 300 }); gestures.down(2, { x: 300, y: 300 });
    gestures.move(1, { x: 150, y: 300 }); gestures.move(2, { x: 250, y: 300 });
    expect(transforms.at(-1)!.scale).toBe(0.5);
    gestures.up(2, { x: 250, y: 300 });
    expect(transforms.at(-1)!.scale).toBe(0.5);
    gestures.up(1, { x: 150, y: 300 });
    expect(transforms.at(-1)).toEqual(INITIAL_DESKTOP_TRANSFORM);
    expect(events).toEqual([]);
  });
  it('cancels pending input on mode changes without resetting zoom or panning', () => {
    let mode: 'drag' | 'cursor' = 'drag';
    const events: DesktopInput[] = [], transforms: { scale: number; x: number; y: number }[] = [];
    const gestures = createDesktopGestures({ viewport: () => viewport, mode: () => mode,
      send: value => events.push(value), apply: value => transforms.push(value) });
    gestures.down(1, { x: 150, y: 300 }); gestures.down(2, { x: 250, y: 300 });
    gestures.move(1, { x: 100, y: 300 }); gestures.move(2, { x: 300, y: 300 });
    gestures.up(2, { x: 300, y: 300 }); gestures.up(1, { x: 100, y: 300 });
    gestures.down(1, center); gestures.move(1, { x: 220, y: 320 }); gestures.up(1, { x: 220, y: 320 });
    expect(transforms.at(-1)).toEqual({ scale: 2, x: -180, y: -280 });
    const count = transforms.length;
    gestures.cancel(); mode = 'cursor';
    expect(transforms).toHaveLength(count);
    gestures.down(1, { x: 220, y: 320 }); gestures.up(1, { x: 220, y: 320 });
    expect(events).toEqual([{ type: 'pointer', action: 'click', x: 0.5, y: 0.5 }]);
  });
  it('Drag double-taps zoom locally around the tap and the next double-tap restores Fit', () => {
    const { gestures, events, transforms } = setup(true);
    const point = { x: 100, y: 300 };
    const tap = () => { gestures.down(1, point); gestures.up(1, point); };
    tap(); tap();
    const zoomed = transforms.at(-1)!;
    expect(zoomed.scale).toBe(2.5);
    expect(desktopPoint(point, viewport, zoomed)).toEqual(desktopPoint(point, viewport, INITIAL_DESKTOP_TRANSFORM));
    tap(); tap();
    expect(transforms.at(-1)).toEqual(INITIAL_DESKTOP_TRANSFORM);
    expect(events).toEqual([]);
  });
  it('Cursor double-taps remain native clicks without local zoom', () => {
    const { gestures, events, transforms } = setup();
    for (let index = 0; index < 2; index++) { gestures.down(1, center); gestures.up(1, center); }
    expect(events).toHaveLength(2);
    expect(events.every(event => event.type === 'pointer' && event.action === 'click')).toBe(true);
    expect(transforms.every(value => value.scale === 1)).toBe(true);
  });
});
