import { describe, expect, it } from 'vitest';
import { formatCompactRunDuration, resolveRunDurationMs } from './scheduledTaskRunDuration';

describe('shared scheduled history duration', () => {
  it('keeps the longer converged wall span instead of the early dispatch sample', () => {
    expect(resolveRunDurationMs({ status: 'success', startedAt: 1000, finishedAt: 61000, durationMs: 1000 }, 0)).toBe(60000);
    expect(formatCompactRunDuration(60000)).toBe('1m');
    expect(resolveRunDurationMs({ status: 'error', startedAt: 1000, finishedAt: 2000, durationMs: 61000 }, 0)).toBe(61000);
  });
  it('uses live elapsed only while running and preserves unknown completed durations', () => {
    expect(resolveRunDurationMs({ status: 'running', startedAt: 1000, finishedAt: 2000, durationMs: 1 }, 5000)).toBe(4000);
    expect(resolveRunDurationMs({ status: 'running', startedAt: 5000 }, 1000)).toBe(0);
    expect(resolveRunDurationMs({ status: 'success', startedAt: 1000, finishedAt: null, durationMs: null }, 9000)).toBeNull();
    expect(resolveRunDurationMs({ status: 'error', startedAt: 1000, durationMs: -1 }, 9000)).toBeNull();
  });
  it.each([[null, null], [Number.NaN, null], [-1, null], [0, '<1s'], [999, '<1s'], [1000, '1s'], [179000, '2m 59s'], [3600000, '1h'], [3720000, '1h 2m']] as const)('formats %s identically on Web and Native', (value, expected) => {
    expect(formatCompactRunDuration(value)).toBe(expected);
  });
});
