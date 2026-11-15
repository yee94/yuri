import { describe, expect, test } from 'vitest';
import { HEADER_FADE_LENGTH, headerFadeGradient, headerFadeMask, OUTER_HEADER_RANGE, outerHeaderFadeOpacity, outerHeaderMetrics, outerHeaderProgress } from './outer-header-core';

describe('outer header collapse', () => {
  test('progress is clamped, including rubber-band overscroll and bad input', () => {
    expect(outerHeaderProgress(-80)).toBe(0);
    expect(outerHeaderProgress(0)).toBe(0);
    expect(outerHeaderProgress(OUTER_HEADER_RANGE / 2)).toBe(0.5);
    expect(outerHeaderProgress(OUTER_HEADER_RANGE)).toBe(1);
    expect(outerHeaderProgress(5000)).toBe(1);
    expect(outerHeaderProgress(Number.NaN)).toBe(0);
  });

  test('metrics shrink monotonically from expanded to compact', () => {
    const expanded = outerHeaderMetrics(0), middle = outerHeaderMetrics(.5), compact = outerHeaderMetrics(1);
    expect(expanded.titleScale).toBe(1);
    expect(expanded.actionsScale).toBe(1);
    expect(middle.height).toBeLessThan(expanded.height);
    expect(compact.height).toBeLessThan(middle.height);
    expect(compact.titleScale).toBeLessThan(middle.titleScale);
    expect(compact.actionsScale).toBeLessThan(middle.actionsScale);
    expect(compact.titleScale).toBeGreaterThan(.5);
  });

  test('fade is the Web translucent 85% hold then a full transparent ramp, never opaque', () => {
    const total = 56 + HEADER_FADE_LENGTH;
    expect(headerFadeMask(total)).toBe('linear-gradient(to bottom, #000000d9 0%, #000000d9 35.00%, #00000000 100%)');
    // Web holds until safe-area-top + 35% of the whole fade height, which includes the safe area.
    const withSafeArea = 59 + total;
    expect(headerFadeMask(withSafeArea, 59)).toContain(`#000000d9 ${((59 + withSafeArea * .35) / withSafeArea * 100).toFixed(2)}%`);
    expect(headerFadeMask(total, 400)).toContain('#000000d9 100.00%');
    expect(headerFadeMask(total)).not.toContain('#000000ff');
    expect(headerFadeMask(0)).toContain(' 0.00%');
  });

  test('Android gradient has the same stops with the page color, ending fully transparent', () => {
    expect(headerFadeGradient('#101010ff', 84)).toBe('linear-gradient(to bottom, #101010d9 0%, #101010d9 35.00%, #10101000 100%)');
  });

  test('fade follows the title collapse and is absent at rest', () => {
    expect(outerHeaderFadeOpacity(0)).toBe(0);
    expect(outerHeaderFadeOpacity(.5)).toBe(.5);
    expect(outerHeaderFadeOpacity(3)).toBe(1);
    expect(outerHeaderFadeOpacity(Number.NaN)).toBe(0);
  });
});
