import { expect, test } from 'vitest';
import { formatDuration } from './formatDuration';

test.each([[0, '0s'], [12000, '12s'], [65000, '1m5s'], [120000, '2m'], [3720000, '1h2m'], [7200000, '2h']])(
  'retains the working-placeholder duration format for %s ms', (duration, expected) => {
    expect(formatDuration(Number(duration))).toBe(expected);
  },
);
