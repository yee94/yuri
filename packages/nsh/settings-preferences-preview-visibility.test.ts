import { expect, test, vi } from 'vitest';
import { createPreferencePreviewVisibility } from './settings-preferences-preview-visibility';

const layout = (y: number, height: number) => ({ bounds: { origin: { x: 0, y }, size: { width: 402, height } } });
const scroll = (y: number, height: number) => ({ offset: { x: 0, y }, size: { width: 402, height } });

test('unknown geometry stops; actual bounds, scrolling, resize and reflow publish only visibility transitions', () => {
  const changed = vi.fn(), owner = createPreferencePreviewVisibility(changed);
  expect(changed).not.toHaveBeenCalled();
  owner.onViewportLayout(layout(100, 600)); expect(changed).not.toHaveBeenCalled();
  owner.onFieldLayout(layout(20, 280)); expect(changed.mock.calls).toEqual([[true]]);
  for (let y = 0; y < 300; y++) owner.onScroll(scroll(y, 600));
  expect(changed.mock.calls).toEqual([[true]]);
  owner.onScroll(scroll(300, 600)); expect(changed.mock.calls).toEqual([[true], [false]]);
  for (let y = 301; y < 1000; y++) owner.onScroll(scroll(y, 600));
  expect(changed).toHaveBeenCalledTimes(2);
  owner.onScroll(scroll(0, 600)); expect(changed.mock.calls.at(-1)).toEqual([true]);
  owner.onFieldLayout(layout(700, 280)); expect(changed.mock.calls.at(-1)).toEqual([false]);
  owner.onViewportLayout(layout(100, 701)); expect(changed.mock.calls.at(-1)).toEqual([true]);
  owner.onViewportLayout(layout(100, 700)); expect(changed.mock.calls.at(-1)).toEqual([false]);
});

test('strict intersections cover partial top/bottom, negative bounce, zero-size and invalid geometry', () => {
  const changed = vi.fn(), owner = createPreferencePreviewVisibility(changed);
  owner.onFieldLayout(layout(600, 100)); owner.onScroll(scroll(0, 600)); expect(changed).not.toHaveBeenCalled();
  owner.onScroll(scroll(1, 600)); expect(changed.mock.calls.at(-1)).toEqual([true]);
  owner.onScroll(scroll(700, 600)); expect(changed.mock.calls.at(-1)).toEqual([false]);
  owner.onScroll(scroll(699, 600)); expect(changed.mock.calls.at(-1)).toEqual([true]);
  owner.onScroll(scroll(-20, 600)); expect(changed.mock.calls.at(-1)).toEqual([false]);
  owner.onFieldLayout(layout(0, 100)); expect(changed.mock.calls.at(-1)).toEqual([true]);
  for (const invalid of [0, -1, NaN, Infinity]) {
    owner.onViewportLayout(layout(0, invalid)); expect(changed.mock.calls.at(-1)).toEqual([false]);
    owner.onViewportLayout(layout(0, 600)); expect(changed.mock.calls.at(-1)).toEqual([true]);
    owner.onFieldLayout(layout(0, invalid)); expect(changed.mock.calls.at(-1)).toEqual([false]);
    owner.onFieldLayout(layout(0, 100)); expect(changed.mock.calls.at(-1)).toEqual([true]);
  }
  owner.onScroll(scroll(NaN, 600)); expect(changed.mock.calls.at(-1)).toEqual([false]);
  owner.onScroll(scroll(0, 600)); expect(changed.mock.calls.at(-1)).toEqual([true]);
});
