import { describe, expect, test } from 'vitest';
import {
  ANDROID_DESIGN_PT_READABILITY_BUMP,
  ANDROID_DESIGN_PT_SCALE_MAX,
  DESIGN_PT_STORAGE_KEY,
  IOS_DESIGN_PT_SCALE,
  applyDesignPtScaleToRoot,
  clampDesignPtScale,
  computeDesignPtScale,
  readCachedDesignPtScale,
} from './designPtScale';

describe('computeDesignPtScale', () => {
  test('returns the Android 1.029 cap when metrics are missing or dirty', () => {
    expect(computeDesignPtScale(null)).toBeCloseTo(1.029, 8);
    expect(computeDesignPtScale({ xdpi: 0, ydpi: 0, density: 2.625 })).toBeCloseTo(1.029, 8);
    expect(computeDesignPtScale({ xdpi: 20, ydpi: 20, density: 2 })).toBeCloseTo(1.029, 8);
    expect(computeDesignPtScale({ xdpi: 400, ydpi: 400, density: 0 })).toBeCloseTo(1.029, 8);
  });

  test('typical ~0.9 physical scale lifts to 1.029 instead of staying put', () => {
    expect(ANDROID_DESIGN_PT_READABILITY_BUMP).toBeCloseTo(1.029 / 0.9, 8);
    // (294 / 2) / 163 ≈ 0.902 — a cap-only change would still be 0.9.
    expect(computeDesignPtScale({ xdpi: 294, ydpi: 294, density: 2 })).toBeCloseTo(1.029, 8);
    expect(computeDesignPtScale({ xdpi: 448, ydpi: 448, density: 2.625 })).toBeCloseTo(1.029, 8);
  });

  test('still allows values below the Android cap after the 0.9→1.029 lift', () => {
    // clamp(0.798) = 0.85, then × (1.029/0.9) ≈ 0.972
    expect(computeDesignPtScale({ xdpi: 260, ydpi: 260, density: 2 })).toBeCloseTo(
      0.85 * ANDROID_DESIGN_PT_READABILITY_BUMP,
      5,
    );
    expect(computeDesignPtScale({ xdpi: 800, ydpi: 800, density: 2 })).toBeCloseTo(1.029, 8);
    expect(clampDesignPtScale(0.4)).toBe(0.85);
    expect(clampDesignPtScale(Number.NaN)).toBe(1);
  });

  test('writes both the px twin and the unitless --dpt-n for scale stacking', () => {
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(0.95, root);
    expect(root.style.getPropertyValue('--dpt')).toBe('0.95px');
    expect(root.style.getPropertyValue('--dpt-n')).toBe('0.95');
  });

  test('both native scales are 5% larger without changing the shared clamp', () => {
    expect(ANDROID_DESIGN_PT_SCALE_MAX / 0.98).toBeCloseTo(1.05, 8);
    expect(IOS_DESIGN_PT_SCALE / (10 / 9)).toBeCloseTo(1.05, 8);
    expect(clampDesignPtScale(IOS_DESIGN_PT_SCALE)).toBe(IOS_DESIGN_PT_SCALE);
    expect(clampDesignPtScale(ANDROID_DESIGN_PT_SCALE_MAX)).toBe(ANDROID_DESIGN_PT_SCALE_MAX);
    expect(computeDesignPtScale({ xdpi: 260, ydpi: 260, density: 2 }) / (0.85 * 0.98 / 0.9))
      .toBeCloseTo(1.05, 8);
  });

  test('device-info resize restore never exceeds the Android cap from stale cache', () => {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, '1.04');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBeCloseTo(1.029, 8);
    window.localStorage.removeItem(DESIGN_PT_STORAGE_KEY);
    expect(readCachedDesignPtScale()).toBeCloseTo(1.029, 8);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
  });

  test('Android ignores the previous 0.98 cache key so the lift is not written back', () => {
    window.localStorage.setItem('yuri.designPtScale.v8', '0.98');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    expect(readCachedDesignPtScale()).toBeCloseTo(1.029, 8);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
    window.localStorage.removeItem('yuri.designPtScale.v8');
  });

  test.each(['', 'invalid', '0', '-1', 'Infinity'])('Android rejects invalid cached scale %j', (value) => {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, value);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    try {
      expect(readCachedDesignPtScale()).toBeCloseTo(1.029, 8);
    } finally {
      window.localStorage.removeItem(DESIGN_PT_STORAGE_KEY);
      (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
    }
  });

  test('Android retains valid calibrated cache values below the cap', () => {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, '0.972');
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'android',
    };
    try {
      expect(readCachedDesignPtScale()).toBe(0.972);
    } finally {
      window.localStorage.removeItem(DESIGN_PT_STORAGE_KEY);
      (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
    }
  });

  test('iOS cache restore always uses the lifted scale, not a stale 10/9', () => {
    window.localStorage.setItem(DESIGN_PT_STORAGE_KEY, String(10 / 9));
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = {
      getPlatform: () => 'ios',
    };
    expect(readCachedDesignPtScale()).toBe(IOS_DESIGN_PT_SCALE);
    window.localStorage.removeItem(DESIGN_PT_STORAGE_KEY);
    expect(readCachedDesignPtScale()).toBe(IOS_DESIGN_PT_SCALE);
    (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor = undefined;
  });

  test('browser default and desktop root scale stay at 1', () => {
    expect(readCachedDesignPtScale()).toBe(1);
    const root = document.createElement('html');
    applyDesignPtScaleToRoot(1, root);
    expect(root.style.getPropertyValue('--dpt')).toBe('1px');
    expect(root.style.getPropertyValue('--dpt-n')).toBe('1');
  });
});
