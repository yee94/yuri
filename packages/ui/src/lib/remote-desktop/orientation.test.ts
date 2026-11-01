import { expect, it } from 'vitest';
import { desktopLocalPoint } from './orientation';
it('inverts only the local page rotation for remote touch coordinates', () => {
  const rect = { left: 10, top: 20, right: 410, bottom: 620 };
  expect(desktopLocalPoint({ x: 110, y: 220 }, rect, 0)).toEqual({ x: 100, y: 200 });
  expect(desktopLocalPoint({ x: 110, y: 220 }, rect, 90)).toEqual({ x: 200, y: 300 });
  expect(desktopLocalPoint({ x: 110, y: 220 }, rect, -90)).toEqual({ x: 400, y: 100 });
});
