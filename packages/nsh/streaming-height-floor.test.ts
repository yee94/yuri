import { describe, expect, it } from 'vitest';
import { nextStreamingHeightFloor } from './streaming-height-floor';

describe('nextStreamingHeightFloor', () => {
  it('only rises while streaming, whatever the intermediate layouts measure', () => {
    let floor = 0;
    for (const measured of [40, 120, 90, 150, 100, 149.6]) floor = nextStreamingHeightFloor(floor, measured, true);
    expect(floor).toBe(150);
  });
  it('ignores unusable measurements', () => {
    expect(nextStreamingHeightFloor(80, 0, true)).toBe(80);
    expect(nextStreamingHeightFloor(80, Number.NaN, true)).toBe(80);
  });
  it('is released once the row settles', () => {
    expect(nextStreamingHeightFloor(150, 90, false)).toBe(0);
  });
});
