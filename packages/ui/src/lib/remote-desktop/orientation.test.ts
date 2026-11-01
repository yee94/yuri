import { afterEach, expect, it, vi } from 'vitest';
import { desktopLocalPoint, desktopOrientationFromTilt, requestDesktopOrientationPermission } from './orientation';

afterEach(() => vi.unstubAllGlobals());
it('detects portrait and both landscape sides but ignores flat, invalid and ambiguous tilts', () => {
  expect(desktopOrientationFromTilt(80, 0)).toBe('portrait');
  expect(desktopOrientationFromTilt(0, 80)).toBe('landscape');
  expect(desktopOrientationFromTilt(0, -80)).toBe('landscape');
  expect(desktopOrientationFromTilt(0, 0)).toBeNull();
  expect(desktopOrientationFromTilt(null, 80)).toBeNull();
  expect(desktopOrientationFromTilt(NaN, 0)).toBeNull();
  expect(desktopOrientationFromTilt(35, 45)).toBeNull();
});
it('inverts only the local page rotation for remote touch coordinates', () => {
  const rect = { left: 10, top: 20, right: 410, bottom: 620 };
  expect(desktopLocalPoint({ x: 110, y: 220 }, rect, 0)).toEqual({ x: 100, y: 200 });
  expect(desktopLocalPoint({ x: 110, y: 220 }, rect, 90)).toEqual({ x: 200, y: 300 });
  expect(desktopLocalPoint({ x: 110, y: 220 }, rect, -90)).toEqual({ x: 400, y: 100 });
});
it('requests sensor permission only through the explicit action and handles denial or unavailable hardware', async () => {
  vi.stubGlobal('DeviceOrientationEvent', undefined);
  expect(await requestDesktopOrientationPermission()).toBe('unsupported');
  const request = vi.fn().mockResolvedValue('denied');
  vi.stubGlobal('DeviceOrientationEvent', { requestPermission: request });
  expect(await requestDesktopOrientationPermission()).toBe('denied');
  request.mockRejectedValue(new Error('not activated'));
  expect(await requestDesktopOrientationPermission()).toBe('denied');
  request.mockResolvedValue('granted');
  expect(await requestDesktopOrientationPermission()).toBe('granted');
});
