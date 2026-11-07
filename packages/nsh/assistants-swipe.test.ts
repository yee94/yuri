import { expect, it, vi } from 'vitest';
import { createAssistantSwipe } from './assistants-swipe-core';

function setup(initial = 0) {
  let offset = initial, enabled = true;
  const reveal = vi.fn();
  const swipe = createAssistantSwipe({ read: () => offset, write: value => { offset = value; }, enabled: () => enabled, reveal });
  return { swipe, read: () => offset, disable: () => { enabled = false; }, reveal };
}
it('leaves taps, diagonals and vertical movement with the native scroll owner', () => {
  const { swipe, read, reveal } = setup(); swipe.begin();
  expect(swipe.claim(-10, 0)).toBe(false);
  expect(swipe.claim(-15, 15)).toBe(false);
  expect(swipe.claim(-4, 20)).toBe(false);
  expect(swipe.claim(-80, 21)).toBe(false);
  expect(read()).toBe(0); expect(reveal).not.toHaveBeenCalled();
});
it('does not capture a closed row right swipe or multi-touch gesture', () => {
  const { swipe } = setup(); swipe.begin();
  expect(swipe.claim(20, 0)).toBe(false);
  expect(swipe.claim(-20, 0, 2)).toBe(false);
});
it('reveals one rail, clamps drag bounds and settles using the Web 35% threshold', () => {
  const { swipe, read, reveal } = setup(); swipe.begin();
  expect(swipe.claim(-20, 2)).toBe(true); swipe.grant(); swipe.move(-600);
  expect(read()).toBe(-128); expect(reveal).toHaveBeenCalledTimes(1);
  swipe.release(); expect(read()).toBe(-128);
  swipe.begin(); swipe.grant(); swipe.move(1000); swipe.release(); expect(read()).toBe(0);
  swipe.begin(); swipe.grant(); swipe.move(-44); swipe.release(); expect(read()).toBe(0);
  swipe.begin(); swipe.grant(); swipe.move(-45); swipe.release(); expect(read()).toBe(-128);
});
it.each([0, -128])('cancel/termination restores the pre-gesture offset %i and never opens chat', initial => {
  const { swipe, read } = setup(initial); swipe.begin(); swipe.grant(); swipe.move(initial ? 45 : -65); swipe.cancel();
  expect(read()).toBe(initial); expect(swipe.select()).toBe(false);
});
it('consumes the synthetic release press but not the next deliberate tap', () => {
  const { swipe, read } = setup(); swipe.begin(); swipe.grant(); swipe.move(-70); swipe.release();
  expect(swipe.select()).toBe(false); expect(read()).toBe(-128);
  swipe.begin(); expect(swipe.select()).toBe(false); expect(read()).toBe(0);
  swipe.begin(); expect(swipe.select()).toBe(true);
});
it('a new touch resets long-press suppression; disabling blocks all mutation/navigation', () => {
  const { swipe, read, disable } = setup(); swipe.begin(); swipe.suppress(); expect(swipe.select()).toBe(false);
  swipe.begin(); expect(swipe.select()).toBe(true);
  disable(); swipe.begin(); expect(swipe.claim(-40, 1)).toBe(false); swipe.grant(); swipe.move(-100);
  expect(read()).toBe(0); expect(swipe.select()).toBe(false);
});
