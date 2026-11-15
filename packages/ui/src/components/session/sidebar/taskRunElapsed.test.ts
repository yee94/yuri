import { describe, expect, test } from 'vitest';

import { formatRunElapsed, runElapsedRefreshMs } from './taskRunElapsed';

describe('task run elapsed', () => {
  test('formats seconds, minutes and hours compactly', () => {
    expect(formatRunElapsed(-5)).toBe('0s');
    expect(formatRunElapsed(2_400)).toBe('2s');
    expect(formatRunElapsed(59_999)).toBe('59s');
    expect(formatRunElapsed(180_000)).toBe('3m');
    expect(formatRunElapsed(3_600_000)).toBe('1h');
    expect(formatRunElapsed(3_900_000)).toBe('1h5m');
  });

  test('refreshes per second only inside the first minute', () => {
    expect(runElapsedRefreshMs(0)).toBe(1_000);
    expect(runElapsedRefreshMs(59_999)).toBe(1_000);
    expect(runElapsedRefreshMs(60_000)).toBe(15_000);
  });
});
