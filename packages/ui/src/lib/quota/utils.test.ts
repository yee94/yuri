import { describe, expect, test } from 'bun:test';

import { clampPercent, formatPercent, isUnlimitedOnly } from './utils';

describe('quota utils', () => {
  test('flags a card that only says unlimited', () => {
    expect(isUnlimitedOnly([{ valueLabel: '∞', usedPercent: null, remainingPercent: null }])).toBe(true);
    expect(isUnlimitedOnly([{ valueLabel: '∞' }, { valueLabel: '5 / 10', usedPercent: 50 }])).toBe(false);
    expect(isUnlimitedOnly([{ valueLabel: '∞', usedPercent: 10 }])).toBe(false);
    expect(isUnlimitedOnly([])).toBe(false);
  });

  test('treats non-finite percentages as missing', () => {
    expect(clampPercent(Infinity)).toBeNull();
    expect(clampPercent(-Infinity)).toBeNull();

    expect(formatPercent(Infinity)).toBe('-');
    expect(formatPercent(-Infinity)).toBe('-');
  });
});
