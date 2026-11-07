import { describe, expect, it } from 'vitest';
import { DEFAULT_FOLLOW_UP_BEHAVIOR, isFollowUpBehavior, normalizeFollowUpBehavior } from './followUpBehavior';

describe('pure follow-up behavior compatibility', () => {
  it('defaults to queue and recognizes only canonical values', () => {
    expect(DEFAULT_FOLLOW_UP_BEHAVIOR).toBe('queue');
    for (const value of ['steer', 'queue']) expect(isFollowUpBehavior(value)).toBe(true);
    for (const value of ['immediate', '', 'QUEUE', undefined, null, false, 0, {}]) expect(isFollowUpBehavior(value)).toBe(false);
  });

  it.each([undefined, null, false, true])('preserves explicit local-store migrations before legacy %s', legacy => {
    expect(normalizeFollowUpBehavior('steer', legacy)).toBe('steer');
    expect(normalizeFollowUpBehavior('queue', legacy)).toBe('queue');
    expect(normalizeFollowUpBehavior('immediate', legacy)).toBe('steer');
  });

  it.each([undefined, null, '', 'invalid', false, 0, {}])('falls back to the strict legacy boolean for %s', value => {
    expect(normalizeFollowUpBehavior(value, false)).toBe('steer');
    expect(normalizeFollowUpBehavior(value, true)).toBe('queue');
    expect(normalizeFollowUpBehavior(value, null)).toBe('queue');
    expect(normalizeFollowUpBehavior(value)).toBe('queue');
  });
});
